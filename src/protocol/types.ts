/**
 * 穹顶讲解协议 (Dome Protocol)
 *
 * 权威状态 (authoritative state) 永远保存在讲解员控制台：
 *   - lastConfirmed: 观众窗最近一次成功呈现并确认的完整画面（页 + 遮黑）
 *   - pending:       已发出、等待确认的命令（待确认 -> 已确认 / 未确认 / 呈现失败）
 *
 * 消息经 BroadcastChannel 传递；图片本体不经消息传递，观众窗直接从同源
 * IndexedDB 按 blobId 读取。
 */

export type BlackoutState = boolean;

/** 节目单中的一个图片项。decodeFailed 仅标记该项，不影响其它项。 */
export interface SlideItem {
  id: string;
  blobId: string;
  name: string;
  type: string;
  size: number;
  decodeFailed?: boolean;
}

export interface Program {
  items: SlideItem[];
}

/** 已冻结的放映会话（放映开始后节目单不可再修订，编辑只写入草稿供下一会话）。 */
export interface SessionRecord {
  sessionId: string;
  startedAt: number;
  running: boolean;
  frozenProgram: Program;
  /** 权威画面：最近一次被观众窗确认呈现的完整快照。 */
  lastConfirmed: ConfirmedFrame;
  pending: PendingCommand | null;
}

export interface ConfirmedFrame {
  /** 产生该画面的命令序号；0 表示会话初始快照（尚未发出任何命令）。 */
  seq: number;
  page: number;
  blackout: boolean;
}

export type PendingStatus = 'pending' | 'unconfirmed' | 'failed';

export interface PendingCommand {
  seq: number;
  action: CommandAction;
  /** 命令所指向的完整画面（绝对状态，观众窗即使漏掉中间命令也能直接呈现）。 */
  target: { page: number; blackout: boolean };
  status: PendingStatus;
  issuedAt: number;
  attempts: number;
}

export type CommandAction =
  | { type: 'next' }
  | { type: 'prev' }
  | { type: 'goto'; page: number }
  | { type: 'setBlackout'; blackout: boolean };

/** 控制台 -> 观众窗。viewerId 存在时为定向补发（重试/晚到观众窗快照后补发）。 */
export interface CommandMessage {
  kind: 'CMD';
  sessionId: string;
  seq: number;
  action: CommandAction;
  page: number;
  blackout: boolean;
  viewerId?: string;
}

export interface AckMessage {
  kind: 'ACK';
  sessionId: string;
  seq: number;
  viewerId: string;
  ok: true;
  page: number;
  blackout: boolean;
}

export interface FailAckMessage {
  kind: 'ACK';
  sessionId: string;
  seq: number;
  viewerId: string;
  ok: false;
  reason: 'IMAGE_FAILED';
  /** 该失败确认所尝试呈现的目标画面；控制台必须与当前 pending.target 完全一致才接受。 */
  target: { page: number; blackout: boolean };
  /** 呈现失败时观众窗实际仍停留的画面（最后成功页）。 */
  page: number;
  blackout: boolean;
}

export type Ack = AckMessage | FailAckMessage;

export interface SnapshotRequest {
  kind: 'SNAPSHOT_REQ';
  sessionId?: string;
  viewerId: string;
}

export interface SnapshotResponse {
  kind: 'SNAPSHOT_RES';
  sessionId: string;
  running: boolean;
  confirmed: ConfirmedFrame;
  pending: PendingCommand | null;
  /** 应答的目标观众窗；其它窗口忽略，避免多控制台抢答时串台。 */
  viewerId: string;
}

/** 控制台通知所有观众窗会话结束（停映）。 */
export interface SessionEnded {
  kind: 'SESSION_ENDED';
  sessionId: string;
}

export type WireMessage =
  | CommandMessage
  | Ack
  | SnapshotRequest
  | SnapshotResponse
  | SessionEnded;

export const INITIAL_SEQ = 0;
export const DEFAULT_ACK_TIMEOUT_MS = 2000;

export function initialConfirmed(pageCount: number): ConfirmedFrame {
  // 空节目单不允许开始放映；page 固定 0（首页），不遮黑。
  void pageCount;
  return { seq: INITIAL_SEQ, page: 0, blackout: false };
}

export function makeSessionId(now = Date.now()): string {
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `sess_${now.toString(36)}_${rand}`;
}
