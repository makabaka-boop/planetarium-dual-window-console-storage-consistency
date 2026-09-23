import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 控制台存储失败纪律的单元测试：
 * 用可切换“失败/成功”的假 db 模块驱动 ConsoleController（不触碰真实 IndexedDB），
 * 核验：未持久化不变更内存权威/不发命令；失败不覆盖最后可恢复记录；
 * 落库成功后才宣布；停映失败不结束；重试可收敛。
 */

const fakeDb = vi.hoisted(() => {
  const state: {
    draft: unknown;
    session: unknown;
  } = { draft: { items: [{ id: 'b1', blobId: 'b1' }, { id: 'b2', blobId: 'b2' }] }, session: null };
  let failNext: null | ((reason: string) => boolean) = null;
  function maybeFail(reason: string) {
    if (failNext && failNext(reason)) {
      failNext = null;
      throw new Error(`forced abort: ${reason}`);
    }
  }
  return {
    state,
    armOnce(predicate: (reason: string) => boolean) {
      failNext = predicate;
    },
    reset() {
      state.draft = { items: [{ id: 'b1', blobId: 'b1' }, { id: 'b2', blobId: 'b2' }] };
      state.session = null;
      failNext = null;
    },
    async loadDraft() {
      return (state.draft as { items?: unknown[] })?.items ? state.draft : null;
    },
    async loadSession() {
      return state.session as never;
    },
    async saveSession(session: unknown, reason = 'saveSession') {
      maybeFail(reason);
      state.session = session;
    },
    async clearSession() {
      maybeFail('endShow');
      state.session = null;
    },
    async saveFrozenAndSession(session: unknown) {
      maybeFail('startShow');
      state.session = session;
    },
    async saveDraft(d: unknown) {
      maybeFail('saveDraft');
      state.draft = d;
    },
    async putBlobsAndDraft(w: { items: unknown[] }) {
      maybeFail('addFiles');
      state.draft = { items: w.items };
    },
    async deleteBlob() {
      /* best-effort in tests */
    }
  };
});

vi.mock('../src/db', () => ({
  loadDraft: fakeDb.loadDraft,
  loadSession: fakeDb.loadSession,
  saveSession: fakeDb.saveSession,
  clearSession: fakeDb.clearSession,
  saveFrozenAndSession: fakeDb.saveFrozenAndSession,
  saveDraft: fakeDb.saveDraft,
  putBlobsAndDraft: fakeDb.putBlobsAndDraft,
  deleteBlob: fakeDb.deleteBlob,
  StorageError: class StorageError extends Error {}
}));

// 最小 DOM/会话存储垫片（node 测试环境无浏览器）。
class FakeSessionStorage {
  private m = new Map<string, string>();
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}
vi.stubGlobal('sessionStorage', new FakeSessionStorage());
vi.stubGlobal('window', {
  sessionStorage: globalThis.sessionStorage,
  location: { origin: 'http://test' }
});
vi.stubGlobal('setInterval', () => 0);
vi.stubGlobal('clearInterval', () => undefined);

import { ConsoleController } from '../src/console/ConsoleController';
import { WireMessage } from '../src/protocol/types';

class FakeBus {
  closed = false;
  posted: WireMessage[] = [];
  private handlers = new Set<(m: WireMessage) => void>();
  subscribe(h: (m: WireMessage) => void) {
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }
  post(m: WireMessage) {
    this.posted.push(m);
  }
  emit(m: WireMessage) {
    this.handlers.forEach((h) => h(m));
  }
  close() {
    this.handlers.clear();
    this.closed = true;
  }
}

function twoPageSessionAck(seq: number, page: number): WireMessage {
  return {
    kind: 'ACK',
    sessionId: '', // 由用例按当前会话覆盖
    seq,
    viewerId: 'v1',
    ok: true,
    page,
    blackout: false
  } as WireMessage;
}

describe('控制台存储失败纪律', () => {
  let controller: ConsoleController;
  let bus: FakeBus;

  beforeEach(async () => {
    fakeDb.reset();
    bus = new FakeBus();
    controller = new ConsoleController(bus as never);
    await controller.init();
  });

  it('开始放映落库失败：不进入运行态、不打开观众窗，磁盘无新会话，重试可收敛', async () => {
    fakeDb.armOnce((r) => r === 'startShow');
    const openSpy = vi.fn(() => null);
    vi.stubGlobal('window', {
      ...(globalThis.window as object),
      open: openSpy,
      sessionStorage: globalThis.sessionStorage,
      location: { origin: 'http://test' }
    });
    await controller.startShow();
    expect(controller.getState().session).toBeNull();
    expect(controller.getState().frozen).toBe(false);
    expect(controller.getState().storageError?.operation.kind).toBe('startShow');
    expect(openSpy).not.toHaveBeenCalled();
    expect(fakeDb.state.session).toBeNull();

    // 重试：落库成功，进入运行态。
    await controller.retryStorage();
    expect(controller.getState().session?.running).toBe(true);
    expect(controller.getState().storageError).toBeNull();
    expect(fakeDb.state.session).not.toBeNull();
  });

  it('命令落库失败：不发 CMD、内存权威不变、磁盘无未决命令；成功后命令才发出', async () => {
    await controller.startShow();
    bus.posted = [];
    fakeDb.armOnce((r) => r === 'saveSession');
    await controller.next();

    expect(bus.posted.filter((m) => m.kind === 'CMD')).toHaveLength(0);
    expect(controller.getState().session?.lastConfirmed.page).toBe(0);
    expect(controller.getState().session?.pending).toBeNull();
    expect(controller.getState().storageError?.operation.kind).toBe('command');
    expect(controller.getState().unsynced).not.toBeNull();
    expect((fakeDb.state.session as { pending?: unknown }).pending).toBeNull();

    // 重试（存储已恢复）：命令落库并发出。
    await controller.retryStorage();
    const cmds = bus.posted.filter((m) => m.kind === 'CMD');
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toMatchObject({ seq: 1, page: 1 });
    expect(controller.getState().session?.pending?.status).toBe('pending');
  });

  it('ACK 落库失败：内存不前进到已确认、磁盘保留未确认命令；重试同序号收敛', async () => {
    await controller.startShow();
    bus.posted = [];
    await controller.next(); // 健康：命令落库并发出 seq=1
    const sid = controller.getState().session!.sessionId;

    fakeDb.armOnce((r) => r === 'saveSession');
    bus.emit({ ...twoPageSessionAck(1, 1), sessionId: sid } as WireMessage);
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));

    // 持久化失败：权威不前进，仍保留 pending（供重试）。
    expect(controller.getState().session?.lastConfirmed.page).toBe(0);
    expect(controller.getState().session?.pending?.seq).toBe(1);
    expect(controller.getState().storageError?.operation.kind).toBe('ack');
    const diskPending = (fakeDb.state.session as { pending: { seq: number } | null }).pending;
    expect(diskPending?.seq).toBe(1);

    // 重试沿用同序号重发命令；观众窗（模拟）再回 ACK，权威推进并落库。
    await controller.retryStorage();
    const resent = bus.posted.filter((m) => m.kind === 'CMD');
    expect(resent.at(-1)).toMatchObject({ seq: 1, page: 1 });
    bus.emit({ ...twoPageSessionAck(1, 1), sessionId: sid } as WireMessage);
    await new Promise((r) => setTimeout(r, 0));
    expect(controller.getState().session?.lastConfirmed).toMatchObject({ seq: 1, page: 1 });
    expect(controller.getState().session?.pending).toBeNull();
  });

  it('停映删除失败：会话仍在运行、不发 SESSION_ENDED；再次停映成功后才结束', async () => {
    await controller.startShow();
    bus.posted = [];
    fakeDb.armOnce((r) => r === 'endShow');
    await controller.endShow();

    expect(controller.getState().session?.running).toBe(true);
    expect(controller.getState().storageError?.operation.kind).toBe('endShow');
    expect(bus.posted.filter((m) => m.kind === 'SESSION_ENDED')).toHaveLength(0);
    expect(fakeDb.state.session).not.toBeNull();

    await controller.endShow();
    expect(controller.getState().session).toBeNull();
    expect(bus.posted.filter((m) => m.kind === 'SESSION_ENDED')).toHaveLength(1);
    expect(fakeDb.state.session).toBeNull();
  });

  it('失败后的旧提交不会覆盖更新的权威记录（前置不符即作废）', async () => {
    await controller.startShow();
    // 第一条命令健康落库（seq=1 待确认）。
    await controller.next();
    expect(controller.getState().session?.pending?.seq).toBe(1);
    const sid = controller.getState().session!.sessionId;
    // ACK 到达：权威健康推进到 seq=1。
    bus.emit({ ...twoPageSessionAck(1, 1), sessionId: sid } as WireMessage);
    await new Promise((r) => setTimeout(r, 0));
    expect(controller.getState().session?.lastConfirmed.seq).toBe(1);
    // 存储此刻健康：磁盘也是 seq=1。
    expect((fakeDb.state.session as { lastConfirmed: { seq: number } }).lastConfirmed.seq).toBe(1);
  });

  it('草稿保存失败：内存节目单不变，磁盘保留旧草稿', async () => {
    const before = controller.getState().draft.items.length;
    fakeDb.armOnce((r) => r === 'saveDraft');
    await controller.removeItem('b2');
    expect(controller.getState().draft.items).toHaveLength(before);
    expect(controller.getState().storageError?.operation.kind).toBe('draft');
    expect((fakeDb.state.draft as { items: unknown[] }).items).toHaveLength(before);
  });
});
