/**
 * 控制台控制器：把纯协议状态机与 BroadcastChannel / IndexedDB / 定时器粘合。
 * 这是全系统的权威状态持有者（authoritative state holder）。
 *
 * 存储失败纪律（authoritative state on failure）：
 *  1. 未持久化的会话/命令绝不被宣布成功 —— 所有状态变更遵循“先落库、后宣布”：
 *     内存权威状态只在对应 IndexedDB 事务完整 oncomplete 后才推进；
 *     落库失败时内存状态原样回退到“磁盘上最后可恢复记录”，并给出可重试标记。
 *  2. 失败期间不得覆盖最后可恢复记录 —— 会话写入经单一串行队列提交，
 *     每条变更携带其“磁盘前置状态”，队列执行时前置不符即拒绝写入
 *     （失败后的旧变更不会在重试之后晚到并覆盖更新的权威记录）。
 *  3. 已结束会话不得复活 —— 停映先删除会话记录并以事务完成作为成功信号，
 *     删除失败时会话仍在运行（刷新恢复的仍是该运行会话），讲解员可重试停映。
 *  4. 确认消息到达但持久化失败：页面不得显示“已确认”，磁盘仍保留未确认命令；
 *     讲解员可经“重试”（沿用原序号）重新收敛，刷新后控制台与观众窗一致。
 */
import { MessageBus } from '../bus';
import {
  clearSession,
  deleteBlob,
  loadDraft,
  loadSession,
  putBlobsAndDraft,
  saveDraft,
  saveFrozenAndSession,
  saveSession
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

/** 存储失败的可重试上下文：operation 决定重试按钮重放哪个动作。 */
export type StorageOperation =
  | { kind: 'startShow' }
  | { kind: 'command'; action: CommandAction }
  | { kind: 'retry' }
  | { kind: 'ack' }
  | { kind: 'expire' }
  | { kind: 'endShow' }
  | { kind: 'draft' }
  | { kind: 'addFiles' }
  | { kind: 'init' };

export interface StorageError {
  operation: StorageOperation;
  message: string;
  at: number;
}

export interface ConsoleState {
  draft: Program;
  session: SessionRecord | null;
  /** 冻结后对草稿的编辑只影响下一会话。 */
  frozen: boolean;
  popup: PopupStatus;
  /** 恢复中的观众窗数量（收到 SNAPSHOT_REQ 即计数，用于展示“观众窗同步中”）。 */
  recoveringViewers: number;
  /** 最近一次存储失败（null 表示存储健康）；存在时 UI 给出可重试状态。 */
  storageError: StorageError | null;
  /**
   * 尚未落库、刷新后仍需用户决定重发的操作（仅存 sessionStorage，绝不写入
   * 权威会话记录）：命令写入失败时内存/磁盘权威都停在旧页，但观众窗可能已经
   * 收到过该操作；刷新后用它恢复“可重试”入口，避免用户失去收敛手段。
   */
  unsynced: UnsyncedOperation | null;
}

/** 未持久化操作的可重放描述（sessionStorage 中按会话 id 关联）。 */
interface UnsyncedOperation {
  sessionId: string;
  action: CommandAction;
  kind: 'command' | 'retry' | 'ack';
  at: number;
}

const UNSYNCED_KEY = 'dome-unsynced-op';

function readUnsynced(): UnsyncedOperation | null {
  try {
    const raw = window.sessionStorage.getItem(UNSYNCED_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as UnsyncedOperation;
    if (!parsed || typeof parsed !== 'object' || !parsed.action) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeUnsynced(op: UnsyncedOperation | null): void {
  try {
    if (op) window.sessionStorage.setItem(UNSYNCED_KEY, JSON.stringify(op));
    else window.sessionStorage.removeItem(UNSYNCED_KEY);
  } catch {
    // sessionStorage 自身不可用（极端隐私模式）：退化为仅当次内存可重试。
  }
}

export class ConsoleController {
  private bus: MessageBus;
  private state: ConsoleState = {
    draft: { items: [] },
    session: null,
    frozen: false,
    popup: 'none',
    recoveringViewers: 0,
    storageError: null,
    unsynced: null
  };
  private listeners = new Set<() => void>();
  private unsubscribe: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** 恢复中的观众窗（按 viewerId 去重；轮询快照不会重复计数）。 */
  private recovering = new Set<string>();
  /**
   * 会话持久化串行队列。每个排队项携带它所基于的“磁盘前置会话”：
   * 真正落库时若内存会话已不是该前置（说明它已被一次失败/后续操作取代），
   * 该项作废，绝不把陈旧状态写到当前记录之上。
   */
  private sessionQueue: Promise<void> = Promise.resolve();
  /**
   * 已在处理（含排队/落库中）的确认指纹。StrictMode 双订阅或多通道投递等
   * 情况下同一条 ACK 可能进入两次：第二条直接忽略，保证一条确认至多触发
   * 一次落库（不会出现“首个提交失败、重复提交随后成功”导致的内存/磁盘分裂）。
   */
  private acksInFlight = new Set<string>();

  constructor(bus?: MessageBus) {
    this.bus = bus ?? new MessageBus();
  }

  async init(): Promise<void> {
    // React StrictMode 开发双挂载 / 上次 init 中途失败：保证总线与定时器只挂一份。
    if (this.bus.closed) this.bus = new MessageBus();
    this.unsubscribe?.();
    if (this.timer) clearInterval(this.timer);
    try {
      const [draft, session] = await Promise.all([loadDraft(), loadSession()]);
      if (draft) this.state = { ...this.state, draft };
      if (session) {
        // 刷新恢复：会话仍是权威来源；未决命令在恢复后一律视为未确认（不自动重试，
        // 由讲解员决定，序号沿用原序号）。
        const restored = session.pending
          ? { ...session, pending: { ...session.pending, status: 'unconfirmed' as const } }
          : session;
        // 恢复“已尝试但未持久化”的操作提示：仅当它属于当前磁盘会话
        // （旧会话/已结束会话的残留一律丢弃，不复活任何状态）。
        const unsynced = readUnsynced();
        const validUnsynced = unsynced && unsynced.sessionId === restored.sessionId ? unsynced : null;
        if (unsynced && !validUnsynced) writeUnsynced(null);
        this.state = {
          ...this.state,
          session: restored,
          frozen: restored.running,
          unsynced: validUnsynced
        };
      } else {
        // 磁盘上没有会话：任何未同步操作都失去意义（会话可能已停映），清除。
        writeUnsynced(null);
      }
      this.clearStorageError();
    } catch (err) {
      // 存储打不开（权限收回等）：不卡死 UI，以空内存进入可操作但带可重试标记的状态。
      this.failStorage({ kind: 'init' }, err);
    }
    this.unsubscribe = this.bus.subscribe((m) => this.onMessage(m));
    this.timer = setInterval(() => this.tick(), 200);
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

  // ---- 存储失败与串行持久化 ----------------------------------------------

  private failStorage(operation: StorageOperation, err: unknown): StorageError {
    const storageError: StorageError = {
      operation,
      message: err instanceof Error ? err.message : String(err),
      at: Date.now()
    };
    this.state = { ...this.state, storageError };
    this.emit();
    return storageError;
  }

  private clearStorageError() {
    if (this.state.storageError) {
      this.state = { ...this.state, storageError: null };
    }
  }

  /** 登记一个“已尝试但未持久化”的命令类操作（刷新后仍给出重试入口）。 */
  private rememberUnsynced(
    sessionId: string,
    action: CommandAction,
    kind: UnsyncedOperation['kind']
  ): void {
    const op: UnsyncedOperation = { sessionId, action, kind, at: Date.now() };
    writeUnsynced(op);
    this.state = { ...this.state, unsynced: op };
  }

  /** 操作已确认持久化（或会话结束/切换）：清除未同步标记。 */
  private forgetUnsynced(): void {
    if (this.state.unsynced || readUnsynced()) {
      writeUnsynced(null);
      this.state = { ...this.state, unsynced: null };
    }
  }

  /**
   * 串行提交一次会话变更（唯一的会话状态提交口）。
   * - expectPrev：该变更所基于的磁盘前置（null=磁盘无会话）。落库前若
   *   内存会话已不再是 expectPrev，则该变更作废（典型：落库失败后讲解员重试，
   *   旧 ACK/旧超时回调晚到，不得再把旧状态覆盖到新记录上）；
   * - 落库成功后才把 next 提交进内存并广播 emit；
   * - 落库失败：内存保持磁盘现状（= expectPrev），登记可重试存储错误，
   *   绝不自动重放（重放由用户显式触发，避免在存储持续故障时形成写入风暴/误提交）。
   */
  private commitSession(
    next: SessionRecord | null,
    expectPrev: SessionRecord | null,
    operation: StorageOperation,
    persist: (s: SessionRecord | null) => Promise<void>
  ): Promise<boolean> {
    const task = async (): Promise<boolean> => {
      if (this.state.session !== expectPrev) {
        // 前置已被取代：陈旧变更作废，不触碰磁盘上的当前记录。
        return false;
      }
      try {
        await persist(next);
      } catch (err) {
        if (this.state.session === expectPrev) this.failStorage(operation, err);
        return false;
      }
      // 落库与提交内存之间不允许插入其它会话变更（本队列串行 + 同步状态段）。
      if (this.state.session !== expectPrev) return false;
      this.state = {
        ...this.state,
        session: next,
        frozen: next ? next.running : this.state.frozen,
        storageError: null
      };
      this.emit();
      return true;
    };
    // 串行链：前一项（成功或失败）落定后才执行下一项；链本身永不 reject。
    const run: Promise<boolean> = this.sessionQueue.then(() => task());
    this.sessionQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /** 重放最近一次失败的存储操作；返回是否重试成功。 */
  async retryStorage(): Promise<boolean> {
    const op = this.state.storageError?.operation;
    // 刷新后横幅可能已不在，但未同步操作仍需可重放。
    if (!op) {
      if (this.state.unsynced) {
        await this.retryUnsynced();
        return this.state.storageError === null;
      }
      return true;
    }
    switch (op.kind) {
      case 'init':
        await this.init();
        return this.state.storageError === null;
      case 'startShow':
        await this.justStartShow();
        return this.state.storageError === null;
      case 'command':
        await this.command(op.action);
        return this.state.storageError === null;
      case 'retry':
        await this.retry();
        return this.state.storageError === null;
      case 'ack':
        // ACK 对应的观众窗画面可能已呈现：以“重放未同步操作”收敛。
        // 内存/磁盘权威仍是未确认状态，观众窗对重复命令只重放 ACK 或重新呈现。
        if (this.state.unsynced) await this.retryUnsynced();
        else await this.retry();
        return this.state.storageError === null;
      case 'expire':
        this.tick(true);
        return this.state.storageError === null;
      case 'endShow':
        await this.endShow();
        return this.state.storageError === null;
      case 'draft':
        await this.saveDraftNow();
        return this.state.storageError === null;
      case 'addFiles':
        // 已导入文件的 File 句柄无法跨交互重建：讲解员直接重新选择图片即可，
        // 横幅在此仅作告知，点击即清除（节目单与 Blob 均已随事务回滚）。
        this.state = { ...this.state, storageError: null };
        this.emit();
        return true;
      default:
        return false;
    }
  }

  // ---- 节目单编排（草稿） -------------------------------------------------

  async addFiles(files: File[]): Promise<void> {
    const prepared: SlideItem[] = [];
    const blobs: Array<{ blobId: string; blob: Blob; name: string }> = [];
    // 先逐张探测解码（只读操作，不落任何数据）；单张失败只标记该项。
    for (const file of files) {
      const blobId = `blob_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      let decodeFailed = false;
      try {
        decodeFailed = await probeDecode(file).then(
          () => false,
          () => true
        );
      } catch {
        decodeFailed = true;
      }
      blobs.push({ blobId, blob: file, name: file.name });
      prepared.push({
        id: blobId,
        blobId,
        name: file.name,
        type: file.type || 'image/*',
        size: file.size,
        decodeFailed
      });
    }
    if (prepared.length === 0) return;
    const nextItems = [...this.state.draft.items, ...prepared];
    // Blob 与草稿在同一事务内原子提交：事务中止则两者都不可见，
    // 内存节目单保持磁盘现状（不出现半份导入）。
    try {
      await putBlobsAndDraft({ items: nextItems, blobs });
    } catch (err) {
      this.failStorage({ kind: 'addFiles' }, err);
      return;
    }
    this.state = { ...this.state, draft: { items: nextItems }, storageError: null };
    this.emit();
  }

  async reorder(from: number, to: number): Promise<void> {
    if (this.state.frozen) return; // 放映中冻结，编辑仅供下一会话
    const items = [...this.state.draft.items];
    if (from < 0 || from >= items.length || to < 0 || to >= items.length) return;
    const [moved] = items.splice(from, 1);
    items.splice(to, 0, moved);
    await this.persistDraft(items);
  }

  async move(id: string, delta: number): Promise<void> {
    const idx = this.state.draft.items.findIndex((i) => i.id === id);
    if (idx < 0) return;
    await this.reorder(idx, idx + delta);
  }

  async removeItem(id: string): Promise<void> {
    if (this.state.frozen) return;
    const exists = this.state.draft.items.some((i) => i.id === id);
    if (!exists) return;
    const items = this.state.draft.items.filter((i) => i.id !== id);
    const ok = await this.persistDraft(items);
    if (!ok) return;
    // 草稿已提交后再回收 Blob（best-effort；失败不影响权威状态）。
    deleteBlob(id).catch(() => undefined);
  }

  /** 先落库后改内存；失败保留磁盘最后草稿并登记可重试。 */
  private async persistDraft(items: SlideItem[]): Promise<boolean> {
    try {
      await saveDraft({ items });
    } catch (err) {
      this.failStorage({ kind: 'draft' }, err);
      return false;
    }
    this.state = { ...this.state, draft: { items }, storageError: null };
    this.emit();
    return true;
  }

  private async saveDraftNow(): Promise<boolean> {
    return this.persistDraft(this.state.draft.items);
  }

  // ---- 放映会话 ----------------------------------------------------------

  /**
   * 开始放映：冻结节目单 + 会话记录在同一 IDB 事务内原子落库。
   * 只有事务完整成功后，控制台才进入“运行/冻结”状态并打开观众窗；
   * 落库失败（配额不足/权限收回/事务中止）时控制台仍是编辑模式，
   * 磁盘上的上一场会话与冻结节目单原封不动（最后可恢复记录不被覆盖），
   * 讲解员可在修复存储后重试。
   * 弹窗受阻时：会话已建立并持久化（保留会话），popup = 'blocked'，
   * 讲解员可稍后“重试打开观众窗”，观众窗打开后通过快照收敛。
   */
  async startShow(): Promise<PopupStatus> {
    return this.justStartShow();
  }

  private async justStartShow(): Promise<PopupStatus> {
    if (this.state.session?.running) return this.state.popup;
    const usable = this.state.draft.items;
    if (usable.length === 0) return this.state.popup;

    const sessionId = makeSessionId();
    let session = startSession(sessionId, usable.length);
    session = { ...session, frozenProgram: { items: usable } };
    this.recovering.clear();
    try {
      // 冻结节目单（frozen:<sid>、frozen:latest）与 current 会话同一事务：
      // 任一写入最终中止则全部回滚，绝不会只冻结没会话、或有会话没节目单。
      await saveFrozenAndSession(session);
    } catch (err) {
      this.failStorage({ kind: 'startShow' }, err);
      return this.state.popup;
    }
    // 落库已确定成功：现在才宣布运行与冻结。新会话不携带任何旧的未同步操作。
    this.forgetUnsynced();
    this.state = {
      ...this.state,
      session,
      frozen: true,
      recoveringViewers: 0,
      storageError: null,
      unsynced: null
    };
    const status = this.openViewer();
    this.state = { ...this.state, popup: status };
    this.emit();
    return status;
  }

  /** 尝试（重新）打开观众窗；返回弹窗状态。 */
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

  private tick(manual = false) {
    const s = this.state.session;
    if (!s?.running || !s.pending || s.pending.status !== 'pending') return;
    const next = expirePending(s);
    if (next === s) return;
    void this.commitSession(next, s, { kind: 'expire' }, (v) =>
      saveSession(v!, 'expire')
    ).then((ok) => {
      if (!ok && manual) this.emit();
    });
  }

  /**
   * 讲解员发出一条命令：先持久化（待确认命令随会话落库），落库成功后才把
   * 命令发往观众窗并宣布“待确认”。持久化失败则不发命令、内存权威不变
   * （观众窗不会收到一个刷新后无法解释的新画面），给出可重试状态。
   */
  async command(action: CommandAction): Promise<void> {
    const s = this.state.session;
    if (!s?.running) return;
    const { session: next, command } = issue(s, action);
    if (!command || next === s) return; // 叠加拒绝 / 空操作
    const ok = await this.commitSession(next, s, { kind: 'command', action }, (v) =>
      saveSession(v!)
    );
    if (!ok) {
      // 命令未持久化：内存/磁盘权威不变，命令也未发出；登记可重试操作，
      // 即使刷新控制台，讲解员仍有明确的重试入口收敛画面。
      if (this.state.session === s) this.rememberUnsynced(s.sessionId, action, 'command');
      return;
    }
    this.forgetUnsynced();
    this.post(command);
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

  /** 重试沿用原序号（retryPending 不改 seq）；同样先落库后发送。 */
  async retry(): Promise<void> {
    const s = this.state.session;
    if (!s?.running || !s.pending) return;
    const { session: next, command } = retryPending(s);
    if (!command) return;
    const ok = await this.commitSession(next, s, { kind: 'retry' }, (v) => saveSession(v!));
    if (!ok) {
      this.rememberUnsynced(s.sessionId, s.pending.action, 'retry');
      return;
    }
    this.forgetUnsynced();
    this.post(command);
  }

  /**
   * 重放“已尝试但未持久化”的操作（刷新后通过横幅重试入口调用）。
   * 刷新恢复后磁盘上的该命令处于 unconfirmed：优先按“同序号重试”重发
   * （观众窗已呈现则只重放 ACK，未呈现则按原目标画面呈现）；
   * 仅在没有未决命令（失败写入发生在 issue 之前的命令路径）时才重新 issue。
   */
  private async retryUnsynced(): Promise<void> {
    const op = this.state.unsynced;
    if (!op) return;
    if (this.state.session?.pending) {
      await this.retry();
    } else {
      await this.command(op.action);
    }
  }

  /**
   * 停映：先把会话记录删除落到磁盘（事务完成才算数），再通知观众窗结束。
   * 删除失败时会话仍在运行 —— 内存不宣布结束、SESSION_ENDED 不发出，
   * 刷新后恢复的仍是同一场运行会话（已结束会话绝不复活，运行会话也绝不假死），
   * UI 给出可重试的存储错误。
   */
  async endShow(): Promise<void> {
    const s = this.state.session;
    if (!s) return;
    const ok = await this.commitSession(null, s, { kind: 'endShow' }, async () => {
      await clearSession();
    });
    if (!ok) return;
    this.bus.post({ kind: 'SESSION_ENDED', sessionId: s.sessionId });
    this.recovering.clear();
    this.forgetUnsynced();
    this.state = {
      ...this.state,
      session: null,
      frozen: false,
      recoveringViewers: 0,
      popup: 'none',
      storageError: null,
      unsynced: null
    };
    this.emit();
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
    const s = this.state.session;
    if (!s) return;
    // receiveAck 内部严格校验会话与序号：旧确认、其它会话确认都不会改动权威状态。
    const next = receiveAck(s, ack);
    if (next === s) return;
    // 同一确认（会话+序号+画面）去重：它对应的提交可能仍在队列中，
    // 重复 ACK 不得再产生一次独立落库（两次落库之间穿插故障会造成分裂）。
    const fingerprint = `${s.sessionId}:${ack.seq}:${next.lastConfirmed.page}:${next.lastConfirmed.blackout}`;
    if (this.acksInFlight.has(fingerprint)) return;
    this.acksInFlight.add(fingerprint);
    // 确认只在落库成功后才允许把页面显示为“已确认”。落库失败时：
    // 内存与磁盘都停留在未确认命令（观众窗可能已显示新画面），讲解员用“重试”
    // （沿用同序号）重新收敛；刷新后控制台与观众窗都会回到磁盘上的同一权威。
    const pendingAction = s.pending?.action;
    void this.commitSession(next, s, { kind: 'ack' }, (v) => saveSession(v!)).then((ok) => {
      this.acksInFlight.delete(fingerprint);
      if (!ok && pendingAction && this.state.session === s) {
        this.rememberUnsynced(s.sessionId, pendingAction, 'ack');
      }
    });
  }

  dispose() {
    this.unsubscribe?.();
    if (this.timer) clearInterval(this.timer);
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
