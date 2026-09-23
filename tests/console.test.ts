import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ACK_TIMEOUT_MS,
  FailAckMessage,
  makeSessionId
} from '../src/protocol/types';
import {
  endSession,
  expirePending,
  issue,
  receiveAck,
  retryPending,
  startSession
} from '../src/protocol/console';

function fresh(pages = 5) {
  return startSession(makeSessionId(), pages, 1000);
}

describe('控制台状态机：序号与权威画面', () => {
  it('开始放映时权威画面为首页、无未决命令', () => {
    const s = fresh();
    expect(s.running).toBe(true);
    expect(s.lastConfirmed).toEqual({ seq: 0, page: 0, blackout: false });
    expect(s.pending).toBeNull();
  });

  it('空节目单不允许开始放映', () => {
    expect(() => startSession(makeSessionId(), 0)).toThrow();
  });

  it('下一页命令序号从 1 递增，进入待确认；确认前权威画面不变', () => {
    const s0 = fresh();
    const r1 = issue(s0, { type: 'next' }, 1000);
    expect(r1.command?.seq).toBe(1);
    expect(r1.command?.page).toBe(1);
    expect(r1.session.pending?.status).toBe('pending');
    // 尚未确认：控制台不得误报已呈现
    expect(r1.session.lastConfirmed.page).toBe(0);
  });

  it('等待确认期间拒绝叠加新命令（不跳号）', () => {
    const s0 = fresh();
    const r1 = issue(s0, { type: 'next' }, 1000);
    const r2 = issue(r1.session, { type: 'next' }, 1001);
    expect(r2.command).toBeNull();
    expect(r2.session.pending?.seq).toBe(1);
  });

  it('ACK 匹配序号后权威画面前进，未决清空', () => {
    let s = fresh();
    s = issue(s, { type: 'next' }, 1000).session;
    s = receiveAck(s, {
      kind: 'ACK',
      sessionId: s.sessionId,
      seq: 1,
      viewerId: 'v1',
      ok: true,
      page: 1,
      blackout: false
    });
    expect(s.lastConfirmed).toEqual({ seq: 1, page: 1, blackout: false });
    expect(s.pending).toBeNull();
  });

  it('旧确认（更小序号 / 不匹配序号）被忽略，画面不回跳', () => {
    let s = fresh();
    s = issue(s, { type: 'goto', page: 3 }, 1000).session;
    s = receiveAck(s, {
      kind: 'ACK',
      sessionId: s.sessionId,
      seq: 1,
      viewerId: 'v1',
      ok: true,
      page: 3,
      blackout: false
    });
    // 权威在 seq=1/page=3；当前未决为 goto 4（seq=2）
    s = issue(s, { type: 'goto', page: 4 }, 1010).session;
    // 迟到的 seq=1 旧确认不得产生任何影响
    const stale = receiveAck(s, {
      kind: 'ACK',
      sessionId: s.sessionId,
      seq: 1,
      viewerId: 'v1',
      ok: true,
      page: 3,
      blackout: false
    });
    expect(stale).toBe(s);
    expect(stale.lastConfirmed.page).toBe(3);
    expect(stale.pending?.seq).toBe(2);
  });

  it('其它会话的 ACK 一律无效', () => {
    let s = fresh();
    s = issue(s, { type: 'next' }, 1000).session;
    const other = receiveAck(s, {
      kind: 'ACK',
      sessionId: 'another-session',
      seq: 1,
      viewerId: 'v2',
      ok: true,
      page: 1,
      blackout: false
    });
    expect(other).toBe(s);
    expect(other.lastConfirmed.seq).toBe(0);
  });

  it('超时标记未确认，权威画面不变；重试沿用原序号', () => {
    let s = fresh();
    s = issue(s, { type: 'next' }, 1000).session;
    const timed = expirePending(s, 1000 + DEFAULT_ACK_TIMEOUT_MS + 1);
    expect(timed.pending?.status).toBe('unconfirmed');
    expect(timed.lastConfirmed.page).toBe(0);

    const retried = retryPending(timed, 2000);
    expect(retried.command?.seq).toBe(1); // 沿用原序号
    expect(retried.session.pending?.attempts).toBe(2);
    expect(retried.session.pending?.status).toBe('pending');
  });

  it('未超时仍保持待确认', () => {
    let s = fresh();
    s = issue(s, { type: 'next' }, 1000).session;
    const notYet = expirePending(s, 1000 + DEFAULT_ACK_TIMEOUT_MS - 50);
    expect(notYet).toBe(s);
  });

  it('重试后收到 ACK 正常确认', () => {
    let s = fresh();
    s = issue(s, { type: 'goto', page: 2 }, 1000).session;
    s = expirePending(s, 1000 + DEFAULT_ACK_TIMEOUT_MS + 1);
    s = retryPending(s, 2000).session;
    s = receiveAck(s, {
      kind: 'ACK',
      sessionId: s.sessionId,
      seq: 1,
      viewerId: 'v1',
      ok: true,
      page: 2,
      blackout: false
    });
    expect(s.lastConfirmed).toEqual({ seq: 1, page: 2, blackout: false });
  });

  it('图片呈现失败：未决标记 failed，最后成功页不变', () => {
    let s = fresh();
    s = issue(s, { type: 'next' }, 1000).session;
    const failAck: FailAckMessage = {
      kind: 'ACK',
      sessionId: s.sessionId,
      seq: 1,
      viewerId: 'v1',
      ok: false,
      reason: 'IMAGE_FAILED',
      target: { page: 1, blackout: false },
      page: 0,
      blackout: false
    };
    s = receiveAck(s, failAck);
    expect(s.pending?.status).toBe('failed');
    expect(s.lastConfirmed).toEqual({ seq: 0, page: 0, blackout: false });

    // 失败重试沿用原序号
    const retry = retryPending(s, 2000);
    expect(retry.command?.seq).toBe(1);
  });

  it('遮黑是独立画面：不翻页，只切 blackout', () => {
    let s = fresh();
    const r = issue(s, { type: 'setBlackout', blackout: true }, 1000);
    expect(r.command?.page).toBe(0);
    expect(r.command?.blackout).toBe(true);
    s = receiveAck(r.session, {
      kind: 'ACK',
      sessionId: s.sessionId,
      seq: 1,
      viewerId: 'v1',
      ok: true,
      page: 0,
      blackout: true
    });
    expect(s.lastConfirmed.blackout).toBe(true);
    expect(s.lastConfirmed.page).toBe(0);
  });

  it('与当前画面相同的操作是空操作，不产生命令', () => {
    const s = fresh();
    const r = issue(s, { type: 'prev' }, 1000); // 已在首页
    expect(r.noop).toBe(true);
    expect(r.command).toBeNull();
  });

  it('跳页越界会被夹紧到有效页范围', () => {
    const s = fresh(3);
    const r = issue(s, { type: 'goto', page: 99 }, 1000);
    expect(r.command?.page).toBe(2);
  });

  it('序号严格单调：连续多轮命令 seq 1,2,3…', () => {
    let s = fresh();
    const seen: number[] = [];
    for (let i = 0; i < 3; i++) {
      const r = issue(s, { type: 'next' }, 1000 + i * 10);
      if (!r.command) throw new Error('should issue');
      seen.push(r.command.seq);
      s = receiveAck(r.session, {
        kind: 'ACK',
        sessionId: s.sessionId,
        seq: r.command.seq,
        viewerId: 'v1',
        ok: true,
        page: r.command.page,
        blackout: r.command.blackout
      });
    }
    expect(seen).toEqual([1, 2, 3]);
    expect(s.lastConfirmed.seq).toBe(3);
  });

  it('失败后允许新命令取代未决（不锁死放映）；观众窗回退后该序号可接受', () => {
    let s = fresh();
    s = issue(s, { type: 'next' }, 1000).session;
    s = receiveAck(s, {
      kind: 'ACK',
      sessionId: s.sessionId,
      seq: 1,
      viewerId: 'v1',
      ok: false,
      reason: 'IMAGE_FAILED',
      target: { page: 1, blackout: false },
      page: 0,
      blackout: false
    });
    expect(s.pending?.status).toBe('failed');
    // 新命令接管同序号 1（权威仍在 seq=0），目标是第 3 页
    const r = issue(s, { type: 'goto', page: 2 }, 2000);
    expect(r.command?.seq).toBe(1);
    expect(r.command?.page).toBe(2);
    expect(r.session.pending?.status).toBe('pending');
  });

  it('同序号但画面不匹配的成功确认不推进权威状态（多观众窗交错）', () => {
    let s = fresh();
    s = issue(s, { type: 'goto', page: 3 }, 1000).session;
    // 另一观众窗迟到回报同序号、但画面是第 2 页（或遮黑状态不符）
    const mismatched = receiveAck(s, {
      kind: 'ACK',
      sessionId: s.sessionId,
      seq: 1,
      viewerId: 'v-other',
      ok: true,
      page: 2,
      blackout: false
    });
    expect(mismatched).toBe(s);
    expect(mismatched.lastConfirmed).toEqual({ seq: 0, page: 0, blackout: false });
    expect(mismatched.pending?.status).toBe('pending');

    const blackoutMismatch = receiveAck(s, {
      kind: 'ACK',
      sessionId: s.sessionId,
      seq: 1,
      viewerId: 'v-other',
      ok: true,
      page: 3,
      blackout: true
    });
    expect(blackoutMismatch).toBe(s);

    // 画面完全匹配的确认仍正常推进
    const matched = receiveAck(s, {
      kind: 'ACK',
      sessionId: s.sessionId,
      seq: 1,
      viewerId: 'v1',
      ok: true,
      page: 3,
      blackout: false
    });
    expect(matched.lastConfirmed).toEqual({ seq: 1, page: 3, blackout: false });
    expect(matched.pending).toBeNull();
  });

  it('失败后同序号被替代命令接管时，旧目标的迟到失败确认无效', () => {
    let s = fresh();
    s = issue(s, { type: 'next' }, 1000).session; // seq=1 -> 第 2 页
    s = receiveAck(s, {
      kind: 'ACK',
      sessionId: s.sessionId,
      seq: 1,
      viewerId: 'v1',
      ok: false,
      reason: 'IMAGE_FAILED',
      target: { page: 1, blackout: false },
      page: 0,
      blackout: false
    });
    // 替代命令复用 seq=1，目标改为第 3 页
    s = issue(s, { type: 'goto', page: 2 }, 2000).session;
    // 旧失败回退路径迟到、仍指向第 2 页的失败确认：不得把新未决标成 failed
    const staleFail = receiveAck(s, {
      kind: 'ACK',
      sessionId: s.sessionId,
      seq: 1,
      viewerId: 'v1',
      ok: false,
      reason: 'IMAGE_FAILED',
      target: { page: 1, blackout: false },
      page: 0,
      blackout: false
    });
    expect(staleFail).toBe(s);
    expect(staleFail.pending?.status).toBe('pending');
    expect(staleFail.pending?.target).toEqual({ page: 2, blackout: false });

    // 旧目标迟到的“成功”确认同样无效
    const staleOk = receiveAck(s, {
      kind: 'ACK',
      sessionId: s.sessionId,
      seq: 1,
      viewerId: 'v1',
      ok: true,
      page: 1,
      blackout: false
    });
    expect(staleOk).toBe(s);
    expect(staleOk.lastConfirmed.seq).toBe(0);
  });

  it('未确认（非失败）期间仍拒绝叠加新命令，必须显式重试同序号', () => {
    let s = fresh();
    s = issue(s, { type: 'next' }, 1000).session;
    s = expirePending(s, 1000 + DEFAULT_ACK_TIMEOUT_MS + 1);
    const blocked = issue(s, { type: 'next' }, 2000);
    expect(blocked.command).toBeNull();
    expect(blocked.session.pending?.seq).toBe(1);
  });

  it('结束放映后不可再发命令', () => {
    let s = fresh();
    s = endSession(s);
    expect(() => issue(s, { type: 'next' }, 2000)).toThrow();
  });
});
