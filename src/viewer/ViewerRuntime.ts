/**
 * 观众窗运行时：协议状态机 + BroadcastChannel + IndexedDB 取图 + Canvas 呈现。
 * 画面只允许从两个来源产生：
 *   1. 恢复完成时控制台快照里的 confirmed；
 *   2. live 期间被接受（严格相邻序号）的命令。
 *
 * 所有取 Blob / 解码都是异步的。为保证“任一时刻只有当前有效画面能够提交”，
 * 运行时维护单调递增的代次 epoch：
 *   - 新快照、新命令、SESSION_ENDED 都会让旧代次作废；
 *   - 任何异步绘制在真正落到 Canvas 前必须仍是当前代次，否则一律丢弃
 *     （旧快照、窗口缩放触发的旧帧重绘、失败后的旧回退绘制、停映前的迟到
 *     结果都不得再改动画布）。
 * 状态机内的 inFlight 再提供一层同序号/同目标校验，双重防线。
 */
import { MessageBus } from '../bus';
import { getBlob, loadFrozen } from '../db';
import { decodeBlob, drawCover } from '../image';
import {
  CommandMessage,
  SnapshotResponse,
  WireMessage
} from '../protocol/types';
import {
  RenderTarget,
  ViewerState,
  applySnapshot,
  beginRecovery,
  initViewer,
  receiveCommand,
  receiveWire,
  resolveRender
} from '../protocol/viewer';

function makeViewerId(): string {
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `viewer_${rand}`;
}

export type PresentStatus =
  | { phase: 'standby' }
  | { phase: 'recovering' }
  | { phase: 'live'; page: number; total: number; blackout: boolean; seq: number; imageError: boolean }
  | { phase: 'ended' };

export class ViewerRuntime {
  private bus: MessageBus;
  private state: ViewerState;
  private ctx: CanvasRenderingContext2D;
  private cache = new Map<number, HTMLImageElement>();
  private blobIdByPage: string[] = [];
  private listeners = new Set<() => void>();
  private unsubscribe: (() => void) | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private resizeHandler: (() => void) | null = null;
  private total = 0;
  /** 当前呈现失败标记（imageError），用于 UI 提示，画面仍停留在最后成功页。 */
  private imageError = false;
  /**
   * 画面代次：每次“有效画面来源切换”（快照恢复、接受新命令、停映）递增。
   * 异步绘制提交时比对，代次不符的迟到结果既不画 Canvas，也不推进状态/确认。
   */
  private epoch = 0;

  constructor(canvas: HTMLCanvasElement, bus?: MessageBus) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d context unavailable');
    this.ctx = ctx;
    this.bus = bus ?? new MessageBus();
    this.state = initViewer(makeViewerId());
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    this.listeners.forEach((fn) => fn());
  }

  getStatus(): PresentStatus {
    switch (this.state.phase) {
      case 'standby':
        return { phase: 'standby' };
      case 'recovering':
        return { phase: 'recovering' };
      case 'ended':
        return { phase: 'ended' };
      case 'live':
        return {
          phase: 'live',
          page: this.state.frame?.page ?? 0,
          total: this.total,
          blackout: this.state.frame?.blackout ?? false,
          seq: this.state.frame?.seq ?? 0,
          imageError: this.imageError
        };
    }
  }

  start() {
    // React StrictMode 开发双挂载：dispose 关闭了总线，第二次挂载需重建。
    if (this.bus.closed) this.bus = new MessageBus();
    this.unsubscribe = this.bus.subscribe((m) => this.onMessage(m));
    this.state = beginRecovery(this.state);
    // 恢复即新代次：上一代残留的异步绘制（若有）一律作废。
    this.epoch++;
    this.emit();
    this.requestSnapshot();
    // 重开后主动取得快照；控制台缺席时持续轮询，直到拿到运行中会话的快照。
    this.poll = setInterval(() => {
      if (this.state.phase === 'recovering' || this.state.phase === 'standby') {
        this.requestSnapshot();
      }
    }, 1000);
    // 缩放只重绘“当前有效帧”；重绘本身携带代次，过期窗口/停映后的迟到重绘无效。
    this.resizeHandler = () => this.repaintCurrent(this.epoch);
    window.addEventListener('resize', this.resizeHandler);
  }

  dispose() {
    this.unsubscribe?.();
    if (this.poll) clearInterval(this.poll);
    if (this.resizeHandler) window.removeEventListener('resize', this.resizeHandler);
    this.bus.close();
  }

  private requestSnapshot() {
    this.bus.post({ kind: 'SNAPSHOT_REQ', viewerId: this.state.viewerId });
  }

  private onMessage(msg: WireMessage) {
    switch (msg.kind) {
      case 'SNAPSHOT_RES':
        void this.handleSnapshot(msg);
        break;
      case 'CMD':
        void this.handleCommand(msg);
        break;
      case 'SESSION_ENDED': {
        const prev = this.state.phase;
        this.state = receiveWire(this.state, msg);
        if (prev !== this.state.phase) {
          // 旧代次的一切异步绘制立即作废；持续黑屏，迟到图片不得再出现。
          this.epoch++;
          this.cache.clear();
          this.blobIdByPage = [];
          this.imageError = false;
          this.paintBlack();
          this.emit();
        }
        break;
      }
      default:
        break;
    }
  }

  private async handleSnapshot(res: SnapshotResponse) {
    if (res.viewerId !== this.state.viewerId) return;
    if (this.state.phase !== 'recovering') return;
    if (!res.running) return; // 保持待命，继续轮询

    // 节目单顺序在冻结时已随会话写入 IndexedDB；消息通道只传权威画面。
    const program =
      (await loadFrozen(res.sessionId).catch(() => null)) ??
      (await loadFrozen('latest').catch(() => null));
    const ids = program?.items.map((i) => i.blobId) ?? [];
    if (ids.length === 0) {
      // 本地存储缺失（如用户清了站点数据）：无法恢复，继续保持恢复态并重试。
      return;
    }
    // 快照可能晚到：await 期间若已被别的快照/停映取代，旧快照整个作废。
    // start()/beginRecovery 已为本代次预留了 epoch；快照沿用它，之后的命令才 +1。
    const gen = this.epoch;
    if (this.state.phase !== 'recovering') return;
    this.total = ids.length;
    this.blobIdByPage = ids;
    this.state = applySnapshot(this.state, res);
    this.epoch = gen; // 占用本代次；之后第一条命令 ++epoch 进入下一代
    this.imageError = false;
    // 测试钩子：在“快照已切 live、首帧绘制提交前”插入一个可控异步门，
    // 用于确定性地复现“恢复刚完成、图片仍在解码时连续切页/遮黑/停映”。
    await this.testGate('snapshotLive');
    await this.paintConfirmed(gen);
    this.emit();
  }

  /**
   * 仅测试用钩子：window.__domeTestHooks.gates[point] 存在时，在此处等待其 promise。
   * 生产环境不存在该对象，零开销。用于把“状态已切换、绘制尚未提交”的瞬间显式撑开。
   */
  private async testGate(
    point: 'snapshotLive' | 'beforePresent' | 'afterError'
  ): Promise<void> {
    type Hooks = { gates?: Record<string, { promise: Promise<void> } | undefined> };
    const hooks = (window as unknown as { __domeTestHooks?: Hooks }).__domeTestHooks;
    const gate = hooks?.gates?.[point];
    if (gate) await gate.promise;
  }

  private async handleCommand(msg: CommandMessage) {
    // 恢复期间旧命令、其它会话消息在状态机内统一无效；这里再加一道保险。
    if (this.state.phase === 'recovering') return;
    const accept = receiveCommand(this.state, msg);
    this.state = accept.state;
    if (accept.resendAck) {
      // 重复命令：画面不动，只重放 ACK（控制台超时重试的常见收敛路径）。
      this.bus.post(accept.resendAck);
      return;
    }
    if (!accept.render) return;
    const gen = ++this.epoch;
    await this.testGate('beforePresent');
    // 门等待期间可能已被新快照/停映取代：过期呈现直接丢弃。
    if (gen !== this.epoch || this.state.inFlight?.seq !== accept.render.seq) return;
    await this.present(accept.render, gen);
  }

  /** 呈现一帧：取 Blob -> 解码 -> 绘制；任何一步后都校验代次，过期结果直接丢弃。 */
  private async present(target: RenderTarget, gen: number) {
    try {
      if (target.blackout) {
        if (!this.commitAllowed(gen, target)) return;
        this.paintBlack();
      } else {
        const img = await this.loadImage(target.page);
        if (!this.commitAllowed(gen, target)) return; // 解码期间已切页/遮黑/停映
        this.drawImage(img);
      }
      if (!this.commitAllowed(gen, target)) return;
      const resolved = resolveRender(this.state, target, true);
      if (!resolved) return;
      this.state = resolved.state;
      this.imageError = false;
      this.bus.post(resolved.ack);
      this.emit();
    } catch (err) {
      console.error('present failed', err);
      if (!this.commitAllowed(gen, target)) return; // 失败结果本身也可能已过期
      // 测试钩子：坏图 error 之后、回退绘制之前撑开（复现“回退异步绘制晚于
      // 下一条同序号替代命令/停映”的真实解码窗口）。生产无钩子、零开销。
      await this.testGate('afterError');
      if (!this.commitAllowed(gen, target)) return;
      // 回退画面：重绘最后成功帧（可能本身是遮黑），同样受代次保护。
      await this.repaintLastSuccess(gen);
      if (!this.commitAllowed(gen, target)) return;
      const resolved = resolveRender(this.state, target, false);
      if (!resolved) return;
      this.state = resolved.state;
      this.imageError = true;
      this.bus.post(resolved.ack);
      this.emit();
    }
  }

  /**
   * 一次绘制提交是否仍有效：代次未推进、仍在 live、且该呈现仍是当前未决目标
   * （序号 + 页码 + 遮黑完全一致）。保证旧快照、旧缩放、旧失败回退、停映前的
   * 迟到结果都不能提交。
   */
  private commitAllowed(gen: number, target?: RenderTarget): boolean {
    if (gen !== this.epoch) return false;
    if (this.state.phase !== 'live') return false;
    if (target) {
      const inFlight = this.state.inFlight;
      if (
        !inFlight ||
        inFlight.seq !== target.seq ||
        inFlight.page !== target.page ||
        inFlight.blackout !== target.blackout
      ) {
        return false;
      }
    }
    return true;
  }

  private async loadImage(page: number): Promise<HTMLImageElement> {
    const cached = this.cache.get(page);
    if (cached) return cached;
    const blobId = this.blobIdByPage[page];
    if (!blobId) throw new Error('blob missing for page');
    const blob = await getBlob(blobId);
    if (!blob) throw new Error('blob not found in IndexedDB');
    const img = await decodeBlob(blob);
    this.cache.set(page, img);
    return img;
  }

  /** 恢复完成时绘制快照确认帧；仅当代次仍有效时提交。 */
  private async paintConfirmed(gen: number) {
    if (gen !== this.epoch || this.state.phase !== 'live' || !this.state.frame) return;
    const frame = this.state.frame;
    if (frame.blackout) {
      this.paintBlack();
      return;
    }
    try {
      const img = await this.loadImage(frame.page);
      if (gen !== this.epoch || this.state.phase !== 'live') return;
      if (this.state.frame !== frame) return;
      this.drawImage(img);
    } catch {
      if (gen !== this.epoch || this.state.phase !== 'live') return;
      // 快照页自身解码异常（理论上导入时已探测）：保持黑屏等待新命令，不改权威。
      this.paintBlack();
    }
  }

  /** 缩放触发：只重绘当前有效帧；捕获调用时代次，过期窗口的迟到重绘丢弃。 */
  private async repaintCurrent(gen: number) {
    if (gen !== this.epoch || this.state.phase !== 'live' || !this.state.frame) return;
    const frame = this.state.frame;
    if (frame.blackout) {
      this.paintBlack();
      return;
    }
    try {
      const img = await this.loadImage(frame.page);
      if (gen !== this.epoch || this.state.phase !== 'live') return;
      if (this.state.frame !== frame) return;
      this.drawImage(img);
    } catch {
      if (gen !== this.epoch || this.state.phase !== 'live') return;
      this.paintBlack();
    }
  }

  /** 呈现失败后的回退绘制：重绘最后成功帧，且不得越过更新的代次/未决呈现。 */
  private async repaintLastSuccess(gen: number) {
    if (gen !== this.epoch || this.state.phase !== 'live' || !this.state.frame) return;
    const frame = this.state.frame;
    if (frame.blackout) {
      this.paintBlack();
      return;
    }
    try {
      const img = await this.loadImage(frame.page);
      if (gen !== this.epoch || this.state.phase !== 'live') return;
      if (this.state.frame !== frame) return;
      this.drawImage(img);
    } catch {
      if (gen !== this.epoch || this.state.phase !== 'live') return;
      this.paintBlack();
    }
  }

  private paintBlack() {
    const { width, height } = this.canvasSize();
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, width, height);
  }

  private drawImage(img: HTMLImageElement) {
    const { width, height } = this.canvasSize();
    drawCover(this.ctx, img, width, height);
  }

  private canvasSize() {
    const canvas = this.ctx.canvas;
    const ratio = window.devicePixelRatio || 1;
    const width = window.innerWidth;
    const height = window.innerHeight;
    if (canvas.width !== Math.floor(width * ratio)) {
      canvas.width = Math.floor(width * ratio);
      canvas.height = Math.floor(height * ratio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    }
    return { width, height };
  }
}
