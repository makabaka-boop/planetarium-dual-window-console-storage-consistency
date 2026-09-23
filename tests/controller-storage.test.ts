/**
 * ConsoleController 持久化失败语义测试。
 * db 层完全 mock：在任意提交边界强制 reject，核验“磁盘是权威、失败可重试、
 * 失败不覆盖最后可恢复记录、结束会话不复活”。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Ack, SessionRecord, WireMessage } from '../src/protocol/types';

const dbMocks = vi.hoisted(() => ({
  loadDraft: vi.fn(),
  loadSession: vi.fn(),
  saveDraft: vi.fn(),
  saveShowStart: vi.fn(),
  saveSession: vi.fn(),
  clearSession: vi.fn(),
  putBlob: vi.fn(),
  deleteBlob: vi.fn()
}));

vi.mock('../src/db', () => ({
  loadDraft: (...a: unknown[]) => dbMocks.loadDraft(...a),
  loadSession: (...a: unknown[]) => dbMocks.loadSession(...a),
  saveDraft: (...a: unknown[]) => dbMocks.saveDraft(...a),
  saveShowStart: (...a: unknown[]) => dbMocks.saveShowStart(...a),
  saveSession: (...a: unknown[]) => dbMocks.saveSession(...a),
  clearSession: (...a: unknown[]) => dbMocks.clearSession(...a),
  putBlob: (...a: unknown[]) => dbMocks.putBlob(...a),
  deleteBlob: (...a: unknown[]) => dbMocks.deleteBlob(...a),
  StorageError: class StorageError extends Error {
    scope: string;
    constructor(message: string, scope: string) {
      super(message);
      this.name = 'StorageError';
      this.scope = scope;
    }
  }
}));

import { ConsoleController } from '../src/console/ConsoleController';
import { MessageBus } from '../src/bus';

class FakeBus extends MessageBus {
  sent: WireMessage[] = [];
  constructor() {
    super();
  }
  override post(msg: WireMessage) {
    this.sent.push(msg);
    super.post(msg);
  }
}

function twoItems(): SessionRecord['frozenProgram'] {
  return {
    items: [
      { id: 'a', blobId: 'a', name: 'a.png', type: 'image/png', size: 1 },
      { id: 'b', blobId: 'b', name: 'b.png', type: 'image/png', size: 1 }
    ]
  };
}

function flush(ticks = 20): Promise<void> {
  return new Promise((r) => setTimeout(r, ticks));
}

async function makeController() {
  const bus = new FakeBus();
  const c = new ConsoleController(bus);
  await c.init();
  await flush();
  // 直接给出一份草稿（绕过 addFiles 的 Blob 写入）
  const priv = c as unknown as { state: ReturnType<ConsoleController['getState']> };
  priv.state = { ...c.getState(), draft: twoItems() };
  return { c, bus };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.loadDraft.mockResolvedValue(null);
  dbMocks.loadSession.mockResolvedValue(null);
  dbMocks.saveDraft.mockResolvedValue(undefined);
  dbMocks.saveShowStart.mockResolvedValue(undefined);
  dbMocks.saveSession.mockResolvedValue(undefined);
  dbMocks.clearSession.mockResolvedValue(undefined);
  dbMocks.putBlob.mockResolvedValue(undefined);
  dbMocks.deleteBlob.mockResolvedValue(undefined);
  // node 环境没有 window：给 openViewer 一个最小桩（返回 null 等价弹窗受阻）
  (globalThis as unknown as { window?: unknown }).window = {
    location: { origin: 'http://test' },
    open: () => null
  };
});

describe('开始放映：冻结节目单/会话落库失败', () => {
  it('saveShowStart 失败：不进入运行/冻结态，无会话、报错可重试；重试成功后正常', async () => {
    const { c, bus } = await makeController();
    // 无真实弹窗环境时 window.open 抛错也无妨：落库失败时根本不会打开
    dbMocks.saveShowStart.mockRejectedValueOnce(new Error('QuotaExceededError'));

    const status = await c.startShow();
    await flush();

    expect(c.getState().session).toBeNull();
    expect(c.getState().frozen).toBe(false);
    expect(c.getState().storageErrors.some((e) => e.scope === 'show:start')).toBe(true);
    // 失败期间没有任何对外命令/窗口动作
    expect(bus.sent.some((m) => m.kind !== 'SNAPSHOT_RES')).toBe(false);
    expect(status).toBe('none');

    dbMocks.saveShowStart.mockResolvedValueOnce(undefined);
    await c.retryStorage('show:start');
    await flush();

    expect(c.getState().session?.running).toBe(true);
    expect(c.getState().frozen).toBe(true);
    expect(dbMocks.saveShowStart).toHaveBeenCalledTimes(2);
    expect(c.getState().storageErrors).toEqual([]);
  });
});

describe('切页命令：先持久化后外发', () => {
  it('命令持久化失败：命令不发出、权威不前进、可重试；重试重提交同序号后发出一次', async () => {
    const { c, bus } = await makeController();
    await c.startShow();
    await flush();
    expect(c.getState().session?.running).toBe(true);
    bus.sent.length = 0;

    dbMocks.saveSession.mockRejectedValueOnce(new Error('abort'));
    await c.next();
    await flush();

    expect(bus.sent.some((m) => m.kind === 'CMD')).toBe(false);
    expect(c.getState().session?.pending).toBeNull();
    expect(c.getState().session?.lastConfirmed.seq).toBe(0);
    expect(c.getState().storageErrors.some((e) => e.scope === 'command')).toBe(true);

    dbMocks.saveSession.mockResolvedValueOnce(undefined);
    await c.retryStorage('command');
    await flush();

    // 重试是“把未持久化的同序号命令补落盘”：落盘后补发一次该 CMD
    expect(bus.sent.filter((m) => m.kind === 'CMD')).toHaveLength(1);
    expect(bus.sent.find((m) => m.kind === 'CMD')).toMatchObject({ seq: 1, page: 1 });
    expect(c.getState().session?.pending?.seq).toBe(1);
    expect(c.getState().storageErrors).toEqual([]);
  });
});

describe('确认到达但持久化失败', () => {
  it('ACK 不宣布成功：内存保持未决；重试落盘成功后才推进权威', async () => {
    const { c } = await makeController();
    await c.startShow();
    await flush();
    await c.next();
    await flush();
    expect(c.getState().session?.pending?.status).toBe('pending');

    const ack: Ack = {
      kind: 'ACK',
      sessionId: c.getState().session!.sessionId,
      seq: 1,
      viewerId: 'v1',
      ok: true,
      page: 1,
      blackout: false
    };

    dbMocks.saveSession.mockRejectedValueOnce(new Error('abort after request'));
    // 直接调用私有消息入口（等价订阅回调）
    (c as unknown as { handleAck: (a: Ack) => void }).handleAck(ack);
    await flush();

    expect(c.getState().session?.lastConfirmed).toEqual({ seq: 0, page: 0, blackout: false });
    expect(c.getState().session?.pending?.seq).toBe(1);
    expect(c.getState().storageErrors.some((e) => e.scope === 'command')).toBe(true);

    dbMocks.saveSession.mockResolvedValueOnce(undefined);
    await c.retryStorage('command');
    await flush();
    expect(c.getState().session?.lastConfirmed).toEqual({ seq: 1, page: 1, blackout: false });
    expect(c.getState().session?.pending).toBeNull();
    expect(c.getState().storageErrors).toEqual([]);
  });
});

describe('停映清理失败', () => {
  it('clearSession 失败：会话保持运行、不发结束通知、不复活；重试成功后结束', async () => {
    const { c, bus } = await makeController();
    await c.startShow();
    await flush();
    const sessionId = c.getState().session!.sessionId;
    bus.sent.length = 0;

    dbMocks.clearSession.mockRejectedValueOnce(new Error('abort'));
    await c.endShow();
    await flush();

    expect(c.getState().session?.running).toBe(true);
    expect(c.getState().session?.sessionId).toBe(sessionId);
    expect(bus.sent.some((m) => m.kind === 'SESSION_ENDED')).toBe(false);
    expect(c.getState().storageErrors.some((e) => e.scope === 'show:end')).toBe(true);

    dbMocks.clearSession.mockResolvedValueOnce(undefined);
    await c.retryStorage('show:end');
    await flush();
    expect(c.getState().session).toBeNull();
    expect(c.getState().frozen).toBe(false);
    expect(bus.sent.some((m) => m.kind === 'SESSION_ENDED')).toBe(true);
    expect(c.getState().storageErrors).toEqual([]);
  });
});

describe('草稿写入失败', () => {
  it('saveDraft 失败：内存不新增页面、提示可重试，重试写入当前草稿', async () => {
    const { c } = await makeController();
    expect(c.getState().draft.items).toHaveLength(2);

    dbMocks.saveDraft.mockRejectedValueOnce(new Error('quota'));
    await c.reorder(0, 1);
    await flush();
    expect(c.getState().draft.items.map((i) => i.id)).toEqual(['a', 'b']);
    expect(c.getState().storageErrors.some((e) => e.scope === 'draft')).toBe(true);

    dbMocks.saveDraft.mockResolvedValueOnce(undefined);
    await c.retryStorage('draft');
    await flush();
    // 重排仍未落内存（操作发生在失败的作业里），重试只保证当前草稿重新可写
    expect(dbMocks.saveDraft).toHaveBeenCalledTimes(2);
    expect(c.getState().storageErrors).toEqual([]);
  });
});

describe('刷新恢复：磁盘是权威', () => {
  it('存在带未决命令的会话时恢复为未确认，且不自动重试', async () => {
    const persisted: SessionRecord = {
      sessionId: 'sess_x',
      startedAt: 1,
      running: true,
      frozenProgram: twoItems(),
      lastConfirmed: { seq: 1, page: 1, blackout: false },
      pending: {
        seq: 2,
        action: { type: 'next' },
        target: { page: 1, blackout: false },
        status: 'pending',
        issuedAt: 0,
        attempts: 1
      }
    };
    dbMocks.loadSession.mockResolvedValueOnce(persisted);
    const bus = new FakeBus();
    const c = new ConsoleController(bus);
    await c.init();
    await flush();
    expect(c.getState().session?.pending?.status).toBe('unconfirmed');
    expect(c.getState().frozen).toBe(true);
    expect(bus.sent.some((m) => m.kind === 'CMD')).toBe(false);
  });

  it('存储读取失败：进入可重试 boot 告警，不伪造会话', async () => {
    dbMocks.loadSession.mockRejectedValueOnce(new Error('open failed'));
    dbMocks.loadDraft.mockRejectedValueOnce(new Error('open failed'));
    const bus = new FakeBus();
    const c = new ConsoleController(bus);
    await c.init();
    await flush();
    expect(c.getState().session).toBeNull();
    expect(c.getState().storageErrors.some((e) => e.scope === 'boot')).toBe(true);
  });
});
