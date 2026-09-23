// @vitest-environment jsdom
/**
 * ConsoleController × 真实 IndexedDB（fake-indexeddb）集成：
 * 验证命令在事务成功后才外发、ACK 落盘失败不宣布确认、停映失败不发结束通知，
 * 以及刷新式恢复后内存与磁盘一致。
 */
import 'fake-indexeddb/auto';
import * as fake from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';

Object.defineProperty(window, 'indexedDB', {
  configurable: true,
  writable: true,
  value: fake.indexedDB
});
(globalThis as unknown as { window: unknown }).window = window;

import { ConsoleController } from '../src/console/ConsoleController';
import { MessageBus } from '../src/bus';
import { _resetDatabase, loadSession, saveDraft } from '../src/db';
import type { SlideItem, WireMessage } from '../src/protocol/types';

class FakeBus extends MessageBus {
  sent: WireMessage[] = [];
  override post(msg: WireMessage) {
    this.sent.push(msg);
    super.post(msg);
  }
}

const items: SlideItem[] = [
  { id: 'a', blobId: 'a', name: 'a.png', type: 'image/png', size: 1 },
  { id: 'b', blobId: 'b', name: 'b.png', type: 'image/png', size: 1 }
];

function flush(ms = 20) {
  return new Promise((r) => setTimeout(r, ms));
}

function setFaults(rules: Array<{ scope: string; mode: string }>, hits: string[] = []) {
  (window as unknown as { __domeDbFaults: unknown }).__domeDbFaults = { rules, hits };
}
function clearFaults() {
  delete (window as unknown as { __domeDbFaults?: unknown }).__domeDbFaults;
}

let bus: FakeBus;
let c: ConsoleController;

beforeEach(async () => {
  clearFaults();
  await _resetDatabase();
  await saveDraft({ items });
  bus = new FakeBus();
  c = new ConsoleController(bus);
  await c.init();
  await flush();
});

describe('控制器 × 真实存储', () => {
  it('开始成功后切页：命令在事务提交后才出现在总线；刷新恢复为未确认', async () => {
    // openViewer 在 jsdom 中 window.open 缺失：桩为 null（等价弹窗受阻，不影响会话）
    (window as unknown as { open: () => null }).open = () => null;
    await c.startShow();
    await flush();
    expect(c.getState().session?.running).toBe(true);
    bus.sent.length = 0;

    await c.next();
    await flush();
    const cmd = bus.sent.find((m) => m.kind === 'CMD');
    expect(cmd).toMatchObject({ seq: 1, page: 1 });
    // 磁盘同步可见该未决命令
    expect((await loadSession())?.pending?.seq).toBe(1);

    // 模拟控制台刷新：新控制器从磁盘恢复，pending 变 unconfirmed
    const bus2 = new FakeBus();
    const c2 = new ConsoleController(bus2);
    await c2.init();
    await flush();
    expect(c2.getState().session?.pending?.status).toBe('unconfirmed');
    expect(c2.getState().session?.lastConfirmed.page).toBe(0);
    expect(bus2.sent.some((m) => m.kind === 'CMD')).toBe(false);
  });

  it('命令事务中止：总线上永远没有该 CMD，磁盘保留初始会话，可重试后发出', async () => {
    (window as unknown as { open: () => null }).open = () => null;
    await c.startShow();
    await flush();
    bus.sent.length = 0;

    const hits: string[] = [];
    setFaults([{ scope: 'session:command', mode: 'abort-request' }], hits);
    await c.next();
    await flush();

    expect(hits).toContain('session:command');
    expect(bus.sent.some((m) => m.kind === 'CMD')).toBe(false);
    expect(c.getState().session?.pending).toBeNull();
    expect((await loadSession())?.pending).toBeNull();
    expect(c.getState().storageErrors.some((e) => e.scope === 'command')).toBe(true);

    clearFaults();
    await c.retryStorage('command');
    await flush();
    expect(bus.sent.some((m) => m.kind === 'CMD')).toBe(true);
    expect(c.getState().session?.pending?.seq).toBe(1);
    expect(c.getState().storageErrors).toEqual([]);
  });

  it('ACK 落盘中止：权威停留旧页，磁盘 pending 仍在；重试后权威与磁盘同时前进', async () => {
    (window as unknown as { open: () => null }).open = () => null;
    await c.startShow();
    await flush();
    await c.next();
    await flush();

    setFaults([{ scope: 'session:ack', mode: 'abort-request' }]);
    (c as unknown as { handleAck: (a: unknown) => void }).handleAck({
      kind: 'ACK',
      sessionId: c.getState().session!.sessionId,
      seq: 1,
      viewerId: 'v1',
      ok: true,
      page: 1,
      blackout: false
    });
    await flush();

    expect(c.getState().session?.lastConfirmed.seq).toBe(0);
    expect((await loadSession())?.lastConfirmed.seq).toBe(0);
    expect((await loadSession())?.pending?.seq).toBe(1);

    clearFaults();
    await c.retryStorage('command');
    await flush();
    expect(c.getState().session?.lastConfirmed).toMatchObject({ seq: 1, page: 1 });
    expect(c.getState().session?.pending).toBeNull();
    expect((await loadSession())?.lastConfirmed).toMatchObject({ seq: 1, page: 1 });
    expect((await loadSession())?.pending).toBeNull();
  });

  it('停映清理中止：不发 SESSION_ENDED、会话仍在运行；重试成功后结束并删记录', async () => {
    (window as unknown as { open: () => null }).open = () => null;
    await c.startShow();
    await flush();
    bus.sent.length = 0;

    setFaults([{ scope: 'show:end', mode: 'abort-request' }]);
    await c.endShow();
    await flush();
    expect(bus.sent.some((m) => m.kind === 'SESSION_ENDED')).toBe(false);
    expect(c.getState().session?.running).toBe(true);
    expect(await loadSession()).not.toBeNull();

    clearFaults();
    await c.retryStorage('show:end');
    await flush();
    expect(bus.sent.some((m) => m.kind === 'SESSION_ENDED')).toBe(true);
    expect(c.getState().session).toBeNull();
    expect(await loadSession()).toBeNull();
  });
});
