/**
 * 控制台控制器：把纯协议状态机与 BroadcastChannel / IndexedDB / 定时器粘合。
 * 这是全系统的权威状态持有者（authoritative state holder）。
 *
 * 存储失败的权威语义（磁盘是唯一可恢复真相）：
 *  - 一切写操作经过同一条 FIFO 持久化队列：内存状态推进、消息外发、结束通知
 *    都发生在对应事务成功之后；事务失败则内存回滚/保持原状，绝不把未落盘的
 *    会话或命令宣布为成功。
 *  - 失败期间不覆盖最后一条可恢复记录：开始放映失败不写半成品、会话推进失败
 *    保留旧会话、停映失败保留运行会话。
 *  - 每次失败都留下确定的“可重试”状态（storageErrors + 重试闭包），由讲解员
 *    显式重试；重试成功后内存、观众窗与刷新结果重新收敛到同一权威。
 */
import { MessageBus } from '../bus';
import {
  clearSession,
  loadDraft,
  loadSession,
  putBlob,
  saveDraft,
  saveSession,
  saveShowStart,
  deleteBlob,
  StorageError
} from '../db';
import {
  Ack,
  CommandAction,
  CommandMessage,
  PendingCommand,
  Program,
  SessionRecord,
  SlideItem,
  SnapshotRequest,
  SnapshotResponse,
  WireMessage,
  makeSessionId
} from '../protocol/types';
import {
  expirePending,
  issue,
  receiveAck,
  retryPending,
  startSession
} from '../protocol/console';

export type PopupStatus = 'none' | 'open' | 'blocked';

export type StorageScope = 'boot' | 'draft' | 'show:start' | 'command' | 'show:end';

export interface StorageIssue {
  scope: string;
  message: string;
}

export interface ConsoleState {
  draft: Program;
  session: SessionRecord | null;
  /** 冻结后对草稿的编辑只影响下一会话。 */
  frozen: boolean;
  popup: PopupStatus;
  /** 恢复中的观众窗数量（收到 SNAPSHOT_REQ 即计数，用于展示“观众窗同步中”）。 */
  recoveringViewers: number;
  /** 当前仍未恢复（可重试）的存储失败；非空时控制台显示持久化告警条。 */
  storageErrors: StorageIssue[];
}

export class ConsoleController {
  private bus: MessageBus;
  private state: ConsoleState = {
    draft: { items: [] },
    session: null,
    frozen: false,
    popup: 'none',
    recoveringViewers: 0,
    storageErrors: []
  };
  private listeners = new Set<() => void>();
  private unsubscribe: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** 恢复中的观众窗（按 viewerId 去重；轮询快照不会重复计数）。 */
  private recovering = new Set<string>();
  /** 持久化串行队列：保证内存状态的推进顺序与磁盘提交顺序严格一致。 */
  private chain: Promise<void> = Promise.resolve();
  /** 每个存储作用范围最近一次失败的重试闭包（用户点“重试”时重放）。 */
  private retriers = new Map<string, () => Promise<void>>();

  constructor(bus?: MessageBus) {
    this.bus = bus ?? new MessageBus();
  }

  async init(): Promise<void> {
    // React StrictMode 开发双挂载：dispose 关闭了总线，第二次挂载需重建。
    if (this.bus.closed) this.bus = new MessageBus();
    if (this.timer) clearInterval(this.timer);
    if (!this.unsubscribe) this.unsubscribe = this.bus.subscribe((m) => this.onMessage(m));
    this.timer = setInterval(() => this.tick(), 200);
    try {
      const [draft, session] = await Promise.all([loadDraft(), loadSession()]);
      if (draft) this.state = { ...this.state, draft };
      if (session) {
        // 刷新恢复：会话仍是权威来源；未决命令在恢复后一律视为未确认（不自动重试，
        // 由讲解员决定，序号沿用原序号）。
        this.state = {
          ...this.state,
          session: session.pending
            ? { ...session, pending: { ...session.pending, status: 'unconfirmed' } }
            : session,
          frozen: session.running
        };
      }
      this.clearError('boot');
    } catch (err) {
      // 存储不可用时仍进入可用的编辑界面：消息通道可工作，但一切写操作会
      // 持续提示并允许重试；绝不伪造会话。
      this.reportError('boot', err);
    }
    this.emit();
  }

  getState(): ConsoleState {
    return this.state;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    this.listeners.forEach((fn) => fn());
  }

  // ---- 存储失败状态 ------------------------------------------------------

  private errorMessage(err: unknown, fallback: string): string {
    if (err instanceof StorageError) return err.message;
    if (err instanceof Error && err.message) return err.message;
    return fallback;
  }

  /**
   * 登记一次存储失败并记录重试闭包。mutator 自身闭包了全部输入与“基于最新状态
   * 重放”的逻辑，因此稍后重试无需讲解员重复操作。
   */
  private reportError(scope: StorageScope | string, err: unknown, retry?: () => Promise<void>) {
    const message = this.errorMessage(err, '浏览器存储写入失败，请重试');
    this.retriers.set(scope, retry ?? (() => this.retryScope(scope)));
    if (!this.state.storageErrors.some((e) => e.scope === scope)) {
      this.state = {
        ...this.state,
        storageErrors: [...this.state.storageErrors, { scope, message }]
      };
    } else {
      this.state = {
        ...this.state,
        storageErrors: this.state.storageErrors.map((e) =>
          e.scope === scope ? { ...e, message } : e
        )
      };
    }
  }

  private clearError(scope: string) {
    if (!this.retriers.has(scope) && !this.state.storageErrors.some((e) => e.scope === scope)) {
      return;
    }
    this.retriers.delete(scope);
    this.state = {
      ...this.state,
      storageErrors: this.state.storageErrors.filter((e) => e.scope !== scope)
    };
  }

  /** 默认重试：交给作用范围自定义闭包；没有闭包时无操作。 */
  private async retryScope(scope: string): Promise<void> {
    const fn = this.retriers.get(scope);
    if (fn) await fn();
  }

  /** UI“重试持久化”按钮入口：重放该作用范围最近一次失败的写入。 */
  async retryStorage(scope: string): Promise<void> {
    const fn = this.retriers.get(scope);
    if (!fn) return;
    await fn();
  }

  /**
   * 串行化一个变更作业：前一个落库作业结束后才执行。作业在成功时自行推进
   * 内存状态并 emit；失败时通过 onError 回滚/登记，绝不提前宣布成功。
   */
  private enqueue(job: () => Promise<void>): Promise<void> {
    const run = this.chain.then(() => job());
    // 链路上单个作业失败不应终止后续作业（失败已在作业内被登记为可重试状态）。
    this.chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  // ---- 节目单编排（草稿） -------------------------------------------------

  async addFiles(files: File[]): Promise<void> {
    await this.enqueue(async () => {
      const items: SlideItem[] = [];
      for (const file of files) {
        const blobId = `blob_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
        // Blob 与顺序存入 IndexedDB；存储失败与解码失败分开处理。
        let decodeFailed = false;
        try {
          await putBlob(blobId, file, file.name);
          decodeFailed = await probeDecode(file).then(
            () => false,
            () => true
          );
        } catch (err) {
          // Blob 落库失败（空间不足/权限收回）：本张不得进入节目单，整体保持
          // 可重试；解码失败只标记该项。
          this.failDraft(err);
          return;
        }
        items.push({
          id: blobId,
          blobId,
          name: file.name,
          type: file.type || 'image/*',
          size: file.size,
          decodeFailed
        });
      }
      const next: Program = { items: [...this.state.draft.items, ...items] };
      try {
        await saveDraft(next);
      } catch (err) {
        this.failDraft(err);
        return;
      }
      // 仅当全部 Blob 与草稿事务成功后才把图片宣布为已加入。
      this.clearError('draft');
      this.state = { ...this.state, draft: next };
      this.emit();
    });
  }

  private failDraft(err: unknown) {
    this.reportError('draft', err, async () => {
      await this.enqueue(async () => {
        try {
          await saveDraft(this.state.draft);
          this.clearError('draft');
          this.emit();
        } catch (retryErr) {
          this.failDraft(retryErr);
          this.emit();
        }
      });
    });
    this.emit();
  }

  async reorder(from: number, to: number): Promise<void> {
    if (this.state.frozen) return; // 放映中冻结，编辑仅供下一会话
    const current = this.state.draft.items;
    if (from < 0 || from >= current.length || to < 0 || to >= current.length) return;
    await this.enqueue(async () => {
      const items = [...this.state.draft.items];
      const [moved] = items.splice(from, 1);
      items.splice(to, 0, moved);
      const next = { items };
      try {
        await saveDraft(next);
      } catch (err) {
        this.failDraft(err);
        return;
      }
      this.clearError('draft');
      this.state = { ...this.state, draft: next };
      this.emit();
    });
  }

  async move(id: string, delta: number): Promise<void> {
    const idx = this.state.draft.items.findIndex((i) => i.id === id);
    if (idx < 0) return;
    await this.reorder(idx, idx + delta);
  }

  async removeItem(id: string): Promise<void> {
    if (this.state.frozen) return;
    if (!this.state.draft.items.some((i) => i.id === id)) return;
    await this.enqueue(async () => {
      const next: Program = { items: this.state.draft.items.filter((i) => i.id !== id) };
      try {
        await saveDraft(next);
      } catch (err) {
        this.failDraft(err);
        return;
      }
      this.clearError('draft');
      this.state = { ...this.state, draft: next };
      this.emit();
      // 没有其它引用时回收 Blob（best-effort：失败不影响已成功的草稿删除）
      deleteBlob(id).catch(() => undefined);
    });
  }

  // ---- 放映会话 ----------------------------------------------------------

  /**
   * 开始放映：冻结节目单 + 会话在同一事务原子落库，成功后才进入运行/冻结态
   * 并打开观众窗。落库失败时：磁盘保留旧会话（或无会话）、控制台留在编辑态、
   * 给出可重试提示；弹窗绝不在无可靠会话记录时打开。
   */
  async startShow(): Promise<PopupStatus> {
    if (this.state.session?.running) return this.state.popup;
    const usable = this.state.draft.items;
    if (usable.length === 0) return this.state.popup;

    const sessionId = makeSessionId();
    const session: SessionRecord = {
      ...startSession(sessionId, usable.length),
      frozenProgram: { items: usable }
    };

    let result: PopupStatus = this.state.popup;
    await this.enqueue(async () => {
      this.recovering.clear();
      try {
        await saveShowStart(session, usable);
      } catch (err) {
        // 原子事务失败：冻结节目单与会话均未落盘，最后可恢复记录未被覆盖。
        this.reportError('show:start', err, async () => {
          await this.startShow();
        });
        this.emit();
        return;
      }
      this.clearError('show:start');
      this.state = { ...this.state, session, frozen: true, recoveringViewers: 0 };
      // 会话已可靠持久化后才打开观众窗（与 POPUP_BLOCKED 恢复路径兼容）。
      result = this.openViewer();
      this.emit();
    });
    return result;
  }

  /** 尝试（重新）打开观众窗；返回弹窗状态。不触碰持久化。 */
  openViewer(): PopupStatus {
    const url = `${window.location.origin}/viewer`;
    let win: Window | null = null;
    try {
      win = window.open(url, 'dome-viewer');
    } catch {
      win = null;
    }
    if (!win) {
      this.state = { ...this.state, popup: 'blocked' };
      this.emit();
      return 'blocked';
    }
    this.state = { ...this.state, popup: 'open' };
    this.emit();
    return 'open';
  }

  private post(msg: WireMessage) {
    this.bus.post(msg);
  }

  private tick() {
    // 过期标记也是一次状态推进：在串行作业内基于最新状态计算，避免与
    // 命令/ACK 提交互相覆盖。
    void this.enqueue(async () => {
      const s = this.state.session;
      if (!s?.running || !s.pending || s.pending.status !== 'pending') return;
      const next = expirePending(s);
      if (next === s) return;
      await this.persistCommitted(next, 'session:expire');
    });
  }

  /**
   * 已在串行作业内完成状态机计算后的统一落库/提交：
   * 先持久化，事务成功后才提交内存状态；失败保留旧状态并登记可重试。
   * postAfterCommit 非空时（命令/重试）仅在落盘成功后外发该命令一次。
   */
  private async persistCommitted(
    next: SessionRecord,
    label: string,
    postAfterCommit?: CommandMessage
  ): Promise<boolean> {
    try {
      await saveSession(next, label);
    } catch (err) {
      // 重试 = 把失败时的目标快照重新落盘（同序号、同目标）；失败期间命令
      // 从未外发，因此重试成功后还要补发一次（postAfterCommit 已闭包）。
      this.reportError('command', err, () =>
        this.recommitFromLatest(next, label, postAfterCommit)
      );
      this.emit();
      return false;
    }
    this.clearError('command');
    this.state = {
      ...this.state,
      session: next,
      frozen: next.running ? true : this.state.frozen
    };
    if (postAfterCommit) this.post(postAfterCommit);
    return true;
  }

  /**
   * 会话推进的失败重试：仍处于同一运行会话时重放该推进（含补发命令）；
   * 会话已结束则丢弃，绝不复活已结束会话或用过期快照覆盖更新的权威。
   */
  private recommitFromLatest(
    attempted: SessionRecord,
    label: string,
    postAfterCommit?: CommandMessage
  ): Promise<void> {
    return this.enqueue(async () => {
      const base = this.state.session;
      if (!base || base.sessionId !== attempted.sessionId) return;
      // 在同一会话、同范围告警未被清除期间，attempted 仍是安全的最新目标。
      await this.persistCommitted(attempted, label, postAfterCommit);
    });
  }

  async command(action: CommandAction): Promise<void> {
    await this.enqueue(async () => {
      const s = this.state.session;
      if (!s?.running) return;
      // 状态机计算在串行作业内、基于最新已落盘状态：等待中的未决命令会自然
      // 拒绝叠加，快速双击也不会产生重复命令。
      const { session, command: cmd } = issue(s, action);
      if (!cmd) return;
      // 落库成功后 persistCommitted 才把命令送往观众窗：未持久化的命令绝不外发。
      await this.persistCommitted(session, 'session:command', cmd);
      this.emit();
    });
  }

  next() {
    return this.command({ type: 'next' });
  }
  prev() {
    return this.command({ type: 'prev' });
  }
  goto(page: number) {
    return this.command({ type: 'goto', page });
  }
  setBlackout(blackout: boolean) {
    return this.command({ type: 'setBlackout', blackout });
  }

  /** 重试沿用原序号（retryPending 不改 seq）；同样先落库后重发。 */
  async retry(): Promise<void> {
    await this.enqueue(async () => {
      const s = this.state.session;
      if (!s?.running || !s.pending) return;
      const { session, command: cmd } = retryPending(s);
      if (!cmd) return;
      await this.persistCommitted(session, 'session:retry', cmd);
      this.emit();
    });
  }

  /**
   * 停映：先持久化“会话已结束”（删除 current 记录的事务成功），再通知观众窗、
   * 清空内存并解冻。清理失败时当前会话原样保留并继续运行，给出可重试提示；
   * 已结束的会话不会因清理失败在刷新后复活，也不会提前黑屏/提前通知结束。
   */
  async endShow(): Promise<void> {
    const s = this.state.session;
    if (!s) return;
    const sessionId = s.sessionId;
    await this.enqueue(async () => {
      // 守卫：重试被双击入队时，若同一会话已在第一个作业里结束，第二个作业
      // 不得再删除新会话或重复广播 SESSION_ENDED。
      const current = this.state.session;
      if (!current || current.sessionId !== sessionId) return;
      try {
        await clearSession();
      } catch (err) {
        this.reportError('show:end', err, () => this.endShow());
        this.emit();
        return;
      }
      this.clearError('show:end');
      this.post({ kind: 'SESSION_ENDED', sessionId });
      this.recovering.clear();
      this.state = {
        ...this.state,
        session: null,
        frozen: false,
        recoveringViewers: 0
      };
      this.emit();
    });
  }

  pending(): PendingCommand | null {
    return this.state.session?.pending ?? null;
  }

  // ---- 消息入口 ----------------------------------------------------------

  private onMessage(msg: WireMessage) {
    switch (msg.kind) {
      case 'SNAPSHOT_REQ':
        this.handleSnapshotReq(msg);
        break;
      case 'ACK':
        this.handleAck(msg);
        break;
      default:
        break;
    }
  }

  private handleSnapshotReq(req: SnapshotRequest) {
    const s = this.state.session;
    if (!s) {
      // 无会话时应答空快照，让观众窗保持待命（轮询），不报错。
      const empty: SnapshotResponse = {
        kind: 'SNAPSHOT_RES',
        sessionId: req.sessionId ?? '',
        running: false,
        confirmed: { seq: 0, page: 0, blackout: false },
        pending: null,
        viewerId: req.viewerId
      };
      this.post(empty);
      return;
    }
    const res: SnapshotResponse = {
      kind: 'SNAPSHOT_RES',
      sessionId: s.sessionId,
      running: s.running,
      confirmed: s.lastConfirmed,
      pending: s.pending,
      viewerId: req.viewerId
    };
    this.post(res);
    // 恢复后若有未决命令（pending/unconfirmed/failed 不自动补发，避免对 failed
    // 命令在图片仍坏时形成风暴）；仅当未决仍是 pending（正在等待该新窗口确认）
    // 时立刻重放一次，便于新窗口快速同步。
    if (s.pending && s.pending.status === 'pending') {
      const cmd: CommandMessage = {
        kind: 'CMD',
        sessionId: s.sessionId,
        seq: s.pending.seq,
        action: s.pending.action,
        page: s.pending.target.page,
        blackout: s.pending.target.blackout
      };
      this.post(cmd);
    }
    if (s.running && !this.recovering.has(req.viewerId)) {
      this.recovering.add(req.viewerId);
      // 观众窗成功取得快照即证明窗口通路存在，解除 POPUP_BLOCKED 提示（会话不变）。
      this.state = { ...this.state, recoveringViewers: this.recovering.size, popup: 'open' };
      this.emit();
    }
  }

  private handleAck(ack: Ack) {
    // 确认推进与命令共用同一条串行队列：入队时不预计算，作业内基于最新已
    // 落盘状态严格校验并落库——ACK 早到/晚到、与命令提交交叠都不会丢确认或
    // 覆盖更新的权威。
    void this.enqueue(async () => {
      const s = this.state.session;
      if (!s) return;
      // receiveAck 内部严格校验会话与序号：旧确认、其它会话确认都不会改动权威状态。
      const next = receiveAck(s, ack);
      if (next === s) return;
      // 确认到达也必须先落盘：磁盘保留未确认命令期间，UI 不得显示已确认。
      await this.persistCommitted(next, 'session:ack');
    });
  }

  dispose() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.bus.close();
  }
}

/** 用 createImageBitmap / Image 做一次解码探测；失败即视为该张不可呈现。 */
function probeDecode(blob: Blob): Promise<void> {
  if (typeof createImageBitmap === 'function') {
    return createImageBitmap(blob).then((bmp) => {
      if (!bmp.width || !bmp.height) throw new Error('zero size');
      bmp.close?.();
    });
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      if (!img.naturalWidth) reject(new Error('zero size'));
      else resolve();
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('decode failed'));
    };
    img.src = url;
  });
}
