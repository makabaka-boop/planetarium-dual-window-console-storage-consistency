// @vitest-environment jsdom
/**
 * 真实（fake-indexeddb 实现的）IndexedDB 上的存储失败集成测试：
 * 重点验证“写请求 onsuccess 已触发、事务随后 abort”不会被误报为成功，
 * 以及多对象库原子写入在中止时整体不可见。
 */
import { beforeEach, describe, expect, it } from 'vitest';
// auto 在导入时即把 indexedDB/IDB* 安装到全局（node 与 jsdom 环境均生效）
import 'fake-indexeddb/auto';
import * as fake from 'fake-indexeddb';
import type { Program, SessionRecord } from '../src/protocol/types';
import { makeSessionId } from '../src/protocol/types';

// jsdom 下裸标识符 indexedDB 解析到 window；确保两套全局都指向 fake 实现。
Object.defineProperty(window, 'indexedDB', {
  configurable: true,
  writable: true,
  value: fake.indexedDB
});

const db = await import('../src/db');

declare global {
  interface Window {
    __domeDbFaults?: { rules: Array<{ scope: string; mode: string }>; hits: string[] };
  }
}

function faultRules(rules: Array<{ scope: string; mode: string }>) {
  (window as unknown as { __domeDbFaults: unknown }).__domeDbFaults = { rules, hits: [] };
}

function clearFaults() {
  delete (window as unknown as { __domeDbFaults?: unknown }).__domeDbFaults;
}

function sessionFixture(id = makeSessionId(1)): SessionRecord {
  return {
    sessionId: id,
    startedAt: 1,
    running: true,
    frozenProgram: { items: [] },
    lastConfirmed: { seq: 0, page: 0, blackout: false },
    pending: null
  };
}

const program: Program = {
  items: [
    { id: 'a', blobId: 'a', name: 'a.png', type: 'image/png', size: 1 },
    { id: 'b', blobId: 'b', name: 'b.png', type: 'image/png', size: 1 }
  ]
};

beforeEach(async () => {
  clearFaults();
  await db._resetDatabase();
});

describe('事务级成功判定', () => {
  it('无故障时草稿正常写入', async () => {
    await db.saveDraft(program);
    const loaded = await db.loadDraft();
    expect(loaded?.items).toHaveLength(2);
  });

  it('abort-request：请求成功后事务中止 → reject，且磁盘没有草稿', async () => {
    faultRules([{ scope: 'draft:save', mode: 'abort-request' }]);
    await expect(db.saveDraft(program)).rejects.toBeTruthy();
    clearFaults();
    expect(await db.loadDraft()).toBeNull();
  });

  it('abort-now：事务立即中止 → reject，草稿不可见', async () => {
    faultRules([{ scope: 'draft:save', mode: 'abort-now' }]);
    await expect(db.saveDraft(program)).rejects.toBeTruthy();
    clearFaults();
    expect(await db.loadDraft()).toBeNull();
  });

  it('quota：未开始事务即 reject', async () => {
    faultRules([{ scope: 'draft:save', mode: 'quota' }]);
    await expect(db.saveDraft(program)).rejects.toMatchObject({
      name: 'QuotaExceededError'
    });
    clearFaults();
    expect(await db.loadDraft()).toBeNull();
  });

  it('前缀匹配：session:command 命中并整体中止，旧会话不被覆盖', async () => {
    const s = sessionFixture();
    await db.saveSession(s);
    faultRules([{ scope: 'session:command', mode: 'abort-request' }]);
    await expect(
      db.saveSession(
        {
          ...s,
          pending: {
            seq: 1,
            action: { type: 'next' },
            target: { page: 1, blackout: false },
            status: 'pending',
            issuedAt: 1,
            attempts: 1
          }
        },
        'session:command'
      )
    ).rejects.toBeTruthy();
    clearFaults();
    const after = await db.loadSession();
    // 中止后磁盘仍是最初无 pending 的会话：未持久化的命令不可见
    expect(after?.pending).toBeNull();
  });
});

describe('开始放映原子写入', () => {
  it('正常：会话 + 会话冻结键 + latest 键同时可见', async () => {
    const s = sessionFixture();
    await db.saveShowStart(s, program.items);
    expect((await db.loadSession())?.sessionId).toBe(s.sessionId);
    expect((await db.loadFrozen(s.sessionId))?.items).toHaveLength(2);
    expect((await db.loadFrozen('latest'))?.items).toHaveLength(2);
  });

  it('中止：三行全部回滚，旧会话保留（失败不覆盖最后可恢复记录）', async () => {
    const old = sessionFixture();
    await db.saveShowStart(old, [{ ...program.items[0] }]);

    const next = sessionFixture(makeSessionId(2));
    faultRules([{ scope: 'show:start', mode: 'abort-request' }]);
    await expect(db.saveShowStart(next, program.items)).rejects.toBeTruthy();
    clearFaults();

    const persisted = await db.loadSession();
    expect(persisted?.sessionId).toBe(old.sessionId);
    expect(await db.loadFrozen(next.sessionId)).toBeNull();
    // latest 仍指向旧的单页节目单（同事务回滚，未被新数据覆盖）
    expect((await db.loadFrozen('latest'))?.items).toHaveLength(1);
  });

  it('abort-now 同样整体回滚', async () => {
    faultRules([{ scope: 'show:start', mode: 'abort-now' }]);
    const s = sessionFixture();
    await expect(db.saveShowStart(s, program.items)).rejects.toBeTruthy();
    clearFaults();
    expect(await db.loadSession()).toBeNull();
    expect(await db.loadFrozen(s.sessionId)).toBeNull();
    expect(await db.loadFrozen('latest')).toBeNull();
  });
});

describe('停映清理', () => {
  it('清理事务中止：会话记录保留；重试成功后删除', async () => {
    const s = sessionFixture();
    await db.saveShowStart(s, program.items);
    faultRules([{ scope: 'show:end', mode: 'abort-request' }]);
    await expect(db.clearSession()).rejects.toBeTruthy();
    clearFaults();
    expect((await db.loadSession())?.sessionId).toBe(s.sessionId);

    await db.clearSession();
    expect(await db.loadSession()).toBeNull();
  });
});
