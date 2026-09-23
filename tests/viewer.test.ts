import { describe, expect, it } from 'vitest';
import {
  CommandMessage,
  ConfirmedFrame,
  SnapshotResponse,
  WireMessage
} from '../src/protocol/types';
import {
  ViewerState,
  applySnapshot,
  beginRecovery,
  initViewer,
  receiveCommand,
  receiveWire,
  resolveRender
} from '../src/protocol/viewer';

const SESSION = 'sess_x';

function snapshot(viewerId: string, frame: ConfirmedFrame, running = true): SnapshotResponse {
  return {
    kind: 'SNAPSHOT_RES',
    sessionId: SESSION,
    running,
    confirmed: frame,
    pending: null,
    viewerId
  };
}

function cmd(seq: number, page: number, blackout = false, sessionId = SESSION): CommandMessage {
  return {
    kind: 'CMD',
    sessionId,
    seq,
    action: { type: 'goto', page },
    page,
    blackout
  };
}

function recovered(frame: ConfirmedFrame = { seq: 3, page: 3, blackout: false }): ViewerState {
  let v = initViewer('v1');
  v = beginRecovery(v);
  v = applySnapshot(v, snapshot('v1', frame));
  return v;
}

describe('观众窗：恢复与快照权威', () => {
  it('启动进入恢复态，不显示任何旧画面', () => {
    const v = beginRecovery(initViewer('v1'));
    expect(v.phase).toBe('recovering');
    expect(v.frame).toBeNull();
  });

  it('定向给其它窗口的快照被忽略', () => {
    let v = beginRecovery(initViewer('v1'));
    v = applySnapshot(v, snapshot('v2', { seq: 9, page: 9, blackout: false }));
    expect(v.phase).toBe('recovering');
    expect(v.frame).toBeNull();
  });

  it('快照恢复后穹顶画面 = 控制台最后已确认页和遮黑状态', () => {
    const v = recovered({ seq: 3, page: 3, blackout: true });
    expect(v.phase).toBe('live');
    expect(v.sessionId).toBe(SESSION);
    expect(v.appliedSeq).toBe(3);
    expect(v.frame).toEqual({ seq: 3, page: 3, blackout: true });
  });

  it('恢复期间收到的旧命令一律无效', () => {
    let v = beginRecovery(initViewer('v1'));
    const a = receiveCommand(v, cmd(5, 5));
    expect(a.render).toBeNull();
    expect(a.state.phase).toBe('recovering');
    v = a.state;
    v = applySnapshot(v, snapshot('v1', { seq: 3, page: 3, blackout: false }));
    // 恢复完成后，迟到的、比权威更旧的命令也不能让画面跳回旧星图
    const old = receiveCommand(v, cmd(2, 2));
    expect(old.render).toBeNull();
    expect(old.state.frame?.page).toBe(3);
    expect(old.state.ignoredStale).toBe(1);
  });

  it('其它会话的消息无效', () => {
    const v = recovered();
    const a = receiveCommand(v, cmd(4, 4, false, 'other-session'));
    expect(a.render).toBeNull();
    expect(a.state.frame?.page).toBe(3);
  });

  it('乱序（跳号）命令被忽略', () => {
    const v = recovered();
    const a = receiveCommand(v, cmd(6, 6));
    expect(a.render).toBeNull();
    expect(a.state.frame?.page).toBe(3);
  });
});

describe('观众窗：重复/重发消息', () => {
  it('重复命令（seq === appliedSeq）画面不动，仅重放 ACK', () => {
    const v = recovered({ seq: 3, page: 3, blackout: false });
    const a = receiveCommand(v, cmd(3, 3));
    expect(a.render).toBeNull(); // 画面不动
    expect(a.resendAck).not.toBeNull();
    expect(a.resendAck?.seq).toBe(3);
    expect(a.state.frame?.page).toBe(3);
  });

  it('更旧命令（seq < appliedSeq）连 ACK 都不重放', () => {
    const v = recovered();
    const a = receiveCommand(v, cmd(1, 1));
    expect(a.render).toBeNull();
    expect(a.resendAck).toBeNull();
    expect(a.state.ignoredStale).toBe(1);
  });

  it('严格相邻的新命令被接受并需渲染', () => {
    const v = recovered();
    const a = receiveCommand(v, cmd(4, 4));
    expect(a.render).toEqual({ seq: 4, page: 4, blackout: false });
    expect(a.state.appliedSeq).toBe(4);
  });

  it('超时重试同序号 → 成功 ACK 使控制台收敛（端到端状态机推演）', () => {
    // 控制台视角：seq=1 发出未确认 -> 观众窗其实已收到并渲染，ACK 丢失 ->
    // 控制台重发 seq=1 -> 观众窗重放 ACK（画面不动）。
    let v = recovered({ seq: 0, page: 0, blackout: false });
    let a = receiveCommand(v, cmd(1, 1));
    expect(a.render?.seq).toBe(1);
    const rendered = resolveRender(a.state, a.render!, true);
    expect(rendered).not.toBeNull();
    v = rendered!.state;
    expect(v.frame).toEqual({ seq: 1, page: 1, blackout: false });
    // 控制台重发同一条
    const dup = receiveCommand(v, cmd(1, 1));
    expect(dup.render).toBeNull();
    expect(dup.resendAck?.ok).toBe(true);
    expect(dup.resendAck?.seq).toBe(1);
  });
});

describe('观众窗：呈现失败不改变最后成功页', () => {
  it('渲染失败回传 IMAGE_FAILED，序号与画面回退到最后成功帧', () => {
    let v = recovered({ seq: 2, page: 2, blackout: false });
    const a = receiveCommand(v, cmd(3, 3));
    const failed = resolveRender(a.state, a.render!, false);
    expect(failed).not.toBeNull();
    expect(failed!.ack.ok).toBe(false);
    if (!failed!.ack.ok) {
      expect(failed!.ack.reason).toBe('IMAGE_FAILED');
      // 失败确认同时携带“尝试目标”和“实际停留画面”
      expect(failed!.ack.target).toEqual({ page: 3, blackout: false });
      expect(failed!.ack.page).toBe(2);
    }
    // 穹顶仍是第 2 页
    expect(failed!.state.frame).toEqual({ seq: 2, page: 2, blackout: false });
    // appliedSeq 回退，使同序号重试仍可被接受（appliedSeq+1）
    expect(failed!.state.appliedSeq).toBe(2);
    expect(failed!.state.inFlight).toBeNull();
  });

  it('失败后同序号重试可再次呈现并成功', () => {
    let v = recovered({ seq: 2, page: 2, blackout: false });
    let a = receiveCommand(v, cmd(3, 3));
    a = { ...a, state: resolveRender(a.state, a.render!, false)!.state };
    const retry = receiveCommand(a.state, cmd(3, 3));
    expect(retry.render?.seq).toBe(3);
    const ok = resolveRender(retry.state, retry.render!, true)!;
    expect(ok.ack.ok).toBe(true);
    expect(ok.state.frame?.page).toBe(3);
  });
});

describe('观众窗：异步呈现的代次/未决保护', () => {
  it('命令被接受后记入 inFlight，成功回调后清空', () => {
    const v = recovered({ seq: 1, page: 1, blackout: false });
    const a = receiveCommand(v, cmd(2, 2));
    expect(a.state.inFlight).toEqual({ seq: 2, page: 2, blackout: false });
    const done = resolveRender(a.state, a.render!, true)!;
    expect(done.state.inFlight).toBeNull();
    expect(done.state.frame).toEqual({ seq: 2, page: 2, blackout: false });
  });

  it('旧呈现的迟到成功结果（seq/目标与当前 inFlight 不符）被丢弃', () => {
    let v = recovered({ seq: 0, page: 0, blackout: false });
    // seq=1 去第 2 页，解码迟迟未完成
    let a = receiveCommand(v, cmd(1, 1));
    const stale = a.render!;
    // 该呈现失败回退，替代命令复用 seq=1 改去第 3 页
    const failed = resolveRender(a.state, stale, false)!;
    v = failed.state;
    a = receiveCommand(v, cmd(1, 2));
    v = a.state;
    // 旧解码晚于替代命令完成并回报旧目标：必须无效
    const late = resolveRender(v, stale, true);
    expect(late).toBeNull();
    expect(v.frame).toEqual({ seq: 0, page: 0, blackout: false });
    expect(v.inFlight).toEqual({ seq: 1, page: 2, blackout: false });
    // 当前目标正常完成
    const ok = resolveRender(v, v.inFlight!, true)!;
    expect(ok.state.frame).toEqual({ seq: 1, page: 2, blackout: false });
  });

  it('旧呈现的迟到失败结果同样被丢弃，不产生失败确认', () => {
    let v = recovered({ seq: 0, page: 0, blackout: false });
    let a = receiveCommand(v, cmd(1, 1));
    const stale = a.render!;
    v = resolveRender(a.state, stale, false)!.state;
    a = receiveCommand(v, cmd(1, 2));
    v = a.state;
    // 旧路径又迟到一个失败（针对第 2 页）
    expect(resolveRender(v, stale, false)).toBeNull();
    expect(v.inFlight).toEqual({ seq: 1, page: 2, blackout: false });
  });

  it('呈现进行中收到同序号重发不重放 ACK（由未决呈现自身回报）', () => {
    const v = recovered({ seq: 1, page: 1, blackout: false });
    const a = receiveCommand(v, cmd(2, 2));
    expect(a.state.inFlight).not.toBeNull();
    const dup = receiveCommand(a.state, cmd(2, 2));
    expect(dup.render).toBeNull();
    expect(dup.resendAck).toBeNull();
  });

  it('无未决呈现时同序号重复命令仍重放当前帧 ACK', () => {
    let v = recovered({ seq: 2, page: 2, blackout: true });
    v = { ...v, inFlight: null };
    const dup = receiveCommand(v, { ...cmd(2, 2), blackout: true });
    expect(dup.resendAck?.ok).toBe(true);
    expect(dup.resendAck?.seq).toBe(2);
    expect(dup.resendAck?.blackout).toBe(true);
  });

  it('SESSION_ENDED 清空 inFlight：停映前的迟到结果无法再提交', () => {
    let v = recovered({ seq: 1, page: 1, blackout: false });
    const a = receiveCommand(v, cmd(2, 2));
    expect(a.state.inFlight).not.toBeNull();
    v = receiveWire(a.state, { kind: 'SESSION_ENDED', sessionId: SESSION });
    expect(v.phase).toBe('ended');
    expect(v.inFlight).toBeNull();
    expect(resolveRender(v, { seq: 2, page: 2, blackout: false }, true)).toBeNull();
  });
});

describe('观众窗：会话边界', () => {
  it('SESSION_ENDED 仅结束对应会话', () => {
    const v = recovered();
    const other: WireMessage = { kind: 'SESSION_ENDED', sessionId: 'other' };
    expect(receiveWire(v, other)).toBe(v);
    const ended = receiveWire(v, { kind: 'SESSION_ENDED', sessionId: SESSION });
    expect(ended.phase).toBe('ended');
    expect(ended.frame).toBeNull();
  });

  it('已 live 的窗口拒绝后来的快照（不被覆盖）', () => {
    const v = recovered({ seq: 5, page: 5, blackout: false });
    const attacked = applySnapshot(
      v,
      snapshot('v1', { seq: 1, page: 1, blackout: false })
    );
    expect(attacked.frame?.page).toBe(5);
  });
});
