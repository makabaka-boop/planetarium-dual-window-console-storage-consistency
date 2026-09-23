/**
 * 观众窗侧协议状态机（纯函数）。
 *
 * 不变量：
 *  - appliedSeq 单调不减；重复或更旧命令（seq <= appliedSeq）一律忽略；
 *  - 其它会话的消息（sessionId 不符）一律忽略；
 *  - 刷新/重开后处于 RECOVERING，恢复完成前不接受任何命令或确认相关消息；
 *  - 恢复完成后以控制台快照（最后已确认页 + 遮黑状态）为唯一权威画面；
 *  - 图片呈现失败回传 IMAGE_FAILED，最后成功页不变。
 */
import {
  Ack,
  CommandMessage,
  ConfirmedFrame,
  SnapshotResponse,
  WireMessage
} from './types';

export type ViewerPhase = 'standby' | 'recovering' | 'live' | 'ended';

export interface RenderTarget {
  seq: number;
  page: number;
  blackout: boolean;
}

export interface ViewerState {
  viewerId: string;
  phase: ViewerPhase;
  sessionId: string | null;
  /** 已成功呈现的最高序号；初始快照记为快照中的 confirmed.seq。 */
  appliedSeq: number;
  /** 穹顶实际画面 = 权威画面。 */
  frame: ConfirmedFrame | null;
  /**
   * 已接受、但渲染结果尚未回调的目标帧。异步解码期间又收到同序号/其它消息时，
   * 靠它判定是不是当前真正等待的呈现；resolveRender 只接受与它一致的结果。
   */
  inFlight: RenderTarget | null;
  /** 恢复期间收到但必须丢弃的旧命令计数（观测/测试用）。 */
  ignoredStale: number;
}

export function initViewer(viewerId: string): ViewerState {
  return {
    viewerId,
    phase: 'standby',
    sessionId: null,
    appliedSeq: -1,
    frame: null,
    inFlight: null,
    ignoredStale: 0
  };
}

/** 刷新/重开：进入恢复态，等待控制台快照。 */
export function beginRecovery(state: ViewerState): ViewerState {
  return {
    ...state,
    phase: 'recovering',
    sessionId: null,
    appliedSeq: -1,
    frame: null,
    inFlight: null
  };
}

/**
 * 应用控制台快照：仅接受定向给本窗口、且本窗口正处于恢复态的应答。
 * 这是“重开观众窗后收敛到同一权威状态”的关键：直接采用 lastConfirmed，
 * 期间缓存/迟到的任何旧命令都不会让画面跳回旧星图。
 */
export function applySnapshot(state: ViewerState, res: SnapshotResponse): ViewerState {
  if (res.viewerId !== state.viewerId) return state;
  if (state.phase !== 'recovering') {
    // 已在线的窗口也可能收到（不应发生），忽略以免覆盖更新画面。
    return state;
  }
  return {
    ...state,
    phase: res.running ? 'live' : 'standby',
    sessionId: res.sessionId,
    appliedSeq: res.confirmed.seq,
    frame: { ...res.confirmed },
    inFlight: null,
    ignoredStale: 0
  };
}

export interface CommandAccept {
  state: ViewerState;
  /** 需要渲染层去呈现的画面；null 表示消息被忽略，画面不动。 */
  render: RenderTarget | null;
  /**
   * 完全重复（seq === appliedSeq 且无未决呈现）：画面不动，但重放当前帧的 ACK，
   * 用于修复“观众窗已呈现、ACK 丢失、控制台超时后重发同序号”的情形。
   * 更旧消息（seq < appliedSeq）、以及针对正在呈现中的同序号重发则彻底忽略
   * （未决呈现本身会回报，不能重放出可能指向旧画面的 ACK）。
   */
  resendAck: Ack | null;
}

/**
 * 处理一条命令。恢复期间忽略；会话不符忽略；更旧（seq < appliedSeq）忽略；
 * 完全重复（seq === appliedSeq 且无未决呈现）画面不动、仅重发 ACK。
 */
export function receiveCommand(state: ViewerState, msg: CommandMessage): CommandAccept {
  if (state.phase !== 'live') return { state, render: null, resendAck: null };
  if (!state.sessionId || msg.sessionId !== state.sessionId) {
    return { state, render: null, resendAck: null };
  }
  if (msg.seq < state.appliedSeq) {
    return { state: { ...state, ignoredStale: state.ignoredStale + 1 }, render: null, resendAck: null };
  }
  if (msg.seq === state.appliedSeq) {
    // 该序号正处于异步呈现中：其结果尚未回调，此重发不产生 ACK，
    // 否则迟到的重放确认可能携带与当前目标不同的画面。
    if (state.inFlight) return { state, render: null, resendAck: null };
    if (!state.frame) return { state, render: null, resendAck: null };
    return {
      state,
      render: null,
      resendAck: {
        kind: 'ACK',
        sessionId: state.sessionId,
        seq: state.frame.seq,
        viewerId: state.viewerId,
        ok: true,
        page: state.frame.page,
        blackout: state.frame.blackout
      }
    };
  }
  // 乱序保护：只接受 appliedSeq+1（单未决窗口下严格相邻）。
  if (msg.seq !== state.appliedSeq + 1) {
    return { state: { ...state, ignoredStale: state.ignoredStale + 1 }, render: null, resendAck: null };
  }
  const target: RenderTarget = { seq: msg.seq, page: msg.page, blackout: msg.blackout };
  return {
    state: { ...state, appliedSeq: msg.seq, inFlight: target },
    render: target,
    resendAck: null
  };
}

/**
 * 渲染结果回调。只接受与当前未决呈现（inFlight）完全一致的结果：
 * 旧命令、旧快照、旧失败回退的迟到结果一律丢弃，不改状态、不发确认。
 * 成功则把画面固化为该帧并生成 ACK；
 * 失败则回退 appliedSeq 与画面（最后成功页不变），生成携带尝试目标的失败 ACK。
 */
export function resolveRender(
  state: ViewerState,
  render: RenderTarget,
  ok: boolean
): { state: ViewerState; ack: Ack } | null {
  const sessionId = state.sessionId;
  const inFlight = state.inFlight;
  if (!sessionId || !inFlight) return null;
  if (
    inFlight.seq !== render.seq ||
    inFlight.page !== render.page ||
    inFlight.blackout !== render.blackout
  ) {
    return null;
  }
  if (ok) {
    const frame: ConfirmedFrame = { seq: render.seq, page: render.page, blackout: render.blackout };
    return {
      state: { ...state, frame, appliedSeq: render.seq, inFlight: null },
      ack: {
        kind: 'ACK',
        sessionId,
        seq: render.seq,
        viewerId: state.viewerId,
        ok: true,
        page: render.page,
        blackout: render.blackout
      }
    };
  }
  // 失败：appliedSeq 回退到上一成功序号，画面保持 frame（最后成功页），
  // 未决清空使同序号重试可再次被接受。
  const fallbackSeq = state.frame ? state.frame.seq : 0;
  return {
    state: { ...state, appliedSeq: Math.max(0, fallbackSeq), inFlight: null },
    ack: {
      kind: 'ACK',
      sessionId,
      seq: render.seq,
      viewerId: state.viewerId,
      ok: false,
      reason: 'IMAGE_FAILED',
      target: { page: render.page, blackout: render.blackout },
      page: state.frame ? state.frame.page : 0,
      blackout: state.frame ? state.frame.blackout : false
    }
  };
}

/** 其它会话消息在入口统一过滤；这里做防御性处理。 */
export function receiveWire(state: ViewerState, msg: WireMessage): ViewerState {
  switch (msg.kind) {
    case 'SESSION_ENDED':
      if (state.sessionId === msg.sessionId) {
        // 停映：任何尚在异步解码中的未决呈现即刻作废，其迟到结果不得再提交。
        return { ...state, phase: 'ended', frame: null, appliedSeq: -1, inFlight: null, sessionId: null };
      }
      return state;
    default:
      return state;
  }
}
