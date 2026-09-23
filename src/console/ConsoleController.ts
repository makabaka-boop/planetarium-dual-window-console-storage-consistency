/**
 * 控制台控制器：把纯协议状态机与 BroadcastChannel / IndexedDB / 定时器粘合。
 * 这是全系统的权威状态持有者（authoritative state holder）。
 */
import { MessageBus } from '../bus';
import {
  clearSession,
  loadDraft,
  loadSession,
  putBlob,
  saveDraft,
  saveFrozen,
  saveSession,
  deleteBlob
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

export interface ConsoleState {
  draft: Program;
  session: SessionRecord | null;
  /** 冻结后对草稿的编辑只影响下一会话。 */
  frozen: boolean;
  popup: PopupStatus;
  /** 恢复中的观众窗数量（收到 SNAPSHOT_REQ 即计数，用于展示“观众窗同步中”）。 */
  recoveringViewers: number;
}

export class ConsoleController {
  private bus: MessageBus;
  private state: ConsoleState = {
    draft: { items: [] },
    session: null,
    frozen: false,
    popup: 'none',
    recoveringViewers: 0
  };
  private listeners = new Set<() => void>();
  private unsubscribe: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** 恢复中的观众窗（按 viewerId 去重；轮询快照不会重复计数）。 */
  private recovering = new Set<string>();

  constructor(bus?: MessageBus) {
    this.bus = bus ?? new MessageBus();
  }

  async init(): Promise<void> {
    // React StrictMode 开发双挂载：dispose 关闭了总线，第二次挂载需重建。
    if (this.bus.closed) this.bus = new MessageBus();
    if (this.timer) clearInterval(this.timer);
    const [draft, session] = await Promise.all([loadDraft(), loadSession()]);
    if (draft) this.state.draft = draft;
    if (session) {
  // 刷新恢复：会话仍是权威来源；未决命令在恢复后一律视为未确认（不自动重试，
  // 由讲解员决定，序号沿用原序号）。
      this.state.session = session.pending
        ? { ...session, pending: { ...session.pending, status: 'unconfirmed' } }
        : session;
      this.state.frozen = session.running;
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

  private async persistSession() {
    const s = this.state.session;
    if (s) await saveSession(s);
  }

  private async updateSession(next: SessionRecord | null, persist = true) {
    this.state = { ...this.state, session: next, frozen: next ? next.running : this.state.frozen };
    if (persist) await this.persistSession();
    this.emit();
  }

  // ---- 节目单编排（草稿） -------------------------------------------------

  async addFiles(files: File[]): Promise<void> {
    const items: SlideItem[] = [];
    for (const file of files) {
      const blobId = `blob_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      // Blob 与顺序存入 IndexedDB；解码校验单张失败只标记该项。
      let decodeFailed = false;
      try {
        await putBlob(blobId, file, file.name);
        decodeFailed = await probeDecode(file).then(
          () => false,
          () => true
        );
      } catch {
        decodeFailed = true;
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
    this.state = { ...this.state, draft: { items: [...this.state.draft.items, ...items] } };
    await saveDraft(this.state.draft);
    this.emit();
  }

  async reorder(from: number, to: number): Promise<void> {
    if (this.state.frozen) return; // 放映中冻结，编辑仅供下一会话
    const items = [...this.state.draft.items];
    if (from < 0 || from >= items.length || to < 0 || to >= items.length) return;
    const [moved] = items.splice(from, 1);
    items.splice(to, 0, moved);
    this.state = { ...this.state, draft: { items } };
    await saveDraft(this.state.draft);
    this.emit();
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
    this.state = { ...this.state, draft: { items } };
    await saveDraft(this.state.draft);
    // 没有其它引用时回收 Blob（best-effort）
    deleteBlob(id).catch(() => undefined);
    this.emit();
  }

  // ---- 放映会话 ----------------------------------------------------------

  /**
   * 开始放映：冻结节目单修订并打开观众窗。
   * 弹窗受阻时：会话已建立并持久化（保留会话），popup = 'blocked'，
   * 讲解员可稍后“重试打开观众窗”，观众窗打开后通过快照收敛。
   */
  async startShow(): Promise<PopupStatus> {
    if (this.state.session?.running) return this.state.popup;
    const usable = this.state.draft.items;
    if (usable.length === 0) return this.state.popup;

    const sessionId = makeSessionId();
    let session = startSession(sessionId, usable.length);
    session = { ...session, frozenProgram: { items: usable } };
    await saveFrozen({ items: usable }, sessionId);
    this.recovering.clear();
    this.state = { ...this.state, session, frozen: true, recoveringViewers: 0 };
    await saveSession(session);
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

  private tick() {
    const s = this.state.session;
    if (!s?.running || !s.pending || s.pending.status !== 'pending') return;
    const next = expirePending(s);
    if (next !== s) {
      this.updateSession(next).catch(() => undefined);
    }
  }

  async command(action: CommandAction): Promise<void> {
    const s = this.state.session;
    if (!s?.running) return;
    const { session, command } = issue(s, action);
    this.state = { ...this.state, session };
    this.emit();
    if (command) {
      this.post(command);
      await this.persistSession();
    }
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

  /** 重试沿用原序号（retryPending 不改 seq）。 */
  async retry(): Promise<void> {
    const s = this.state.session;
    if (!s?.running || !s.pending) return;
    const { session, command } = retryPending(s);
    this.state = { ...this.state, session };
    this.emit();
    if (command) {
      this.post(command);
      await this.persistSession();
    }
  }

  async endShow(): Promise<void> {
    const s = this.state.session;
    if (!s) return;
    this.bus.post({ kind: 'SESSION_ENDED', sessionId: s.sessionId });
    this.recovering.clear();
    this.state = { ...this.state, session: null, frozen: false, recoveringViewers: 0 };
    await clearSession();
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
    this.updateSession(next).catch(() => undefined);
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
