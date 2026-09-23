/**
 * IndexedDB 持久化：
 *  - blobs: 图片 Blob（keyPath = blobId），不经消息通道传递
 *  - program: 节目单草稿与顺序（单行 key='draft' / key='frozen:<sessionId>'）
 *  - session: 当前/最近放映会话（刷新可恢复权威状态）
 *
 * 持久化正确性约定：
 *  - 单条 IDBRequest 的 onsuccess 只表示该请求成功；事务在 commit 阶段仍可能
 *    因配额不足/权限收回而 abort（request 成功、tx abort 是真实存在的失败形态）。
 *    因此所有写操作只在整个事务 oncomplete 后才 resolve，事务 onerror/onabort
 *    一律 reject —— 调用方绝不能在“请求成功但事务最终中止”时误报已保存。
 *  - 跨 store 的关联写入（开始放映 = 冻结节目单 + 会话；导入图片 = blobs + 草稿）
 *    使用同一个 readwrite 事务，要么全部可见，要么全部不可见，不产生半份状态。
 *  - 失败不覆盖最后可恢复记录：写失败时本模块不触碰任何已提交记录
 *    （abort 天然回滚本次事务），由调用方保持内存权威状态回退到磁盘现状。
 */
import { Program, SessionRecord, SlideItem } from './protocol/types';

const DB_NAME = 'dome-presenter';
const DB_VERSION = 1;
const STORE_BLOBS = 'blobs';
const STORE_PROGRAM = 'program';
const STORE_SESSION = 'session';

let dbPromise: Promise<IDBDatabase> | null = null;

/** IndexedDB 层面的失败（区别于图片解码失败等业务错误），调用方可据此安全重试。 */
export class StorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageError';
  }
}

/**
 * 测试故障注入（生产环境 window.__domeDbFaults 不存在，零开销）。
 * phase:
 *   'before'  —— run 执行前强制中止（等价于配额不足时写入被拒）
 *   'afterRequest' —— 每条请求 onsuccess 后立即 abort（复现“请求成功、事务随后中止”）
 * open: 'fail' 时 openDb 直接失败（权限被收回等）。
 * 规则按 reason 前缀匹配，once 命中一次后自动失效。
 */
export interface DbFaultRule {
  stores?: string[];
  reason?: string;
  phase: 'before' | 'afterRequest';
  once?: boolean;
  /** 跳过前 N 次匹配（用于在同一 reason 的连续提交中精确选中第 N+1 个边界）。 */
  skip?: number;
}
export interface DbFaultOpenRule {
  fail: boolean;
  once?: boolean;
}
interface DbFaultHooks {
  rules: DbFaultRule[];
  openRule: DbFaultOpenRule | null;
  lastFailure: { reason: string; stores: string[]; phase: string } | null;
  failureCount: number;
  /** 观测：写事务关键节点日志（仅测试钩子存在时记录）。 */
  txLog?: Array<{ reason: string; phase: string; t: number }>;
  arm: (rule: DbFaultRule) => void;
  armOpen: (rule: DbFaultOpenRule) => void;
  disarm: () => void;
}

function getFaultHooks(): DbFaultHooks | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { __domeDbFaults?: DbFaultHooks }).__domeDbFaults ?? null;
}

function matchesRule(rule: DbFaultRule, stores: string[], reason: string | undefined): boolean {
  if (rule.reason) {
    if (rule.reason.endsWith('*')) {
      if (!reason?.startsWith(rule.reason.slice(0, -1))) return false;
    } else if (reason !== rule.reason) {
      return false;
    }
  }
  if (rule.stores) {
    for (const s of rule.stores) {
      if (!stores.includes(s)) return false;
    }
  }
  return true;
}

/** 观测用：记录所有写事务的 reason（测试可经 __domeDbFaults.txLog 读取）。 */
function recordTx(reason: string | undefined, phase: 'start' | 'fault' | 'complete' | 'abort') {
  const hooks = getFaultHooks();
  if (!hooks) return;
  type WithLog = DbFaultHooks & { txLog?: Array<{ reason: string; phase: string; t: number }> };
  const h = hooks as WithLog;
  if (!h.txLog) h.txLog = [];
  h.txLog.push({ reason: reason ?? '', phase, t: Date.now() });
}

/** 命中即强制中止事务；once 规则命中后移除。返回命中的规则。 */
const faultSkips = new WeakMap<DbFaultRule, number>();

function faultFor(stores: string[], reason: string | undefined, phase: DbFaultRule['phase']) {
  const hooks = getFaultHooks();
  if (!hooks) return null;
  for (let idx = 0; idx < hooks.rules.length; idx += 1) {
    const rule = hooks.rules[idx];
    if (rule.phase !== phase || !matchesRule(rule, stores, reason)) continue;
    const seen = faultSkips.get(rule) ?? 0;
    if (seen < (rule.skip ?? 0)) {
      faultSkips.set(rule, seen + 1);
      continue;
    }
    if (rule.once) hooks.rules.splice(idx, 1);
    hooks.lastFailure = { reason: reason ?? '', stores, phase };
    hooks.failureCount += 1;
    return rule;
  }
  return null;
}

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const hooks = getFaultHooks();
    if (hooks?.openRule?.fail) {
      if (hooks.openRule.once) hooks.openRule = null;
      hooks.lastFailure = { reason: 'open', stores: [], phase: 'open' };
      hooks.failureCount += 1;
      reject(new StorageError('forced db open failure'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_BLOBS)) {
        db.createObjectStore(STORE_BLOBS, { keyPath: 'blobId' });
      }
      if (!db.objectStoreNames.contains(STORE_PROGRAM)) {
        db.createObjectStore(STORE_PROGRAM, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(STORE_SESSION)) {
        db.createObjectStore(STORE_SESSION, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // 权限/数据库被外部收回或删除：关闭旧连接的版本切换通知到达时，
      // 丢弃缓存的连接承诺，让下一次操作重新 open（可重试状态）。
      db.onversionchange = () => {
        db.close();
        if (dbPromise) {
          dbPromise.catch(() => undefined);
          dbPromise = null;
        }
      };
      resolve(db);
    };
    req.onerror = () => reject(asStorageError(req.error, 'indexedDB open failed'));
    req.onblocked = () => reject(new StorageError('database upgrade blocked'));
  });
  // open 失败不缓存失败承诺：允许修复后直接重试。
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

/**
 * 单 store 事务。
 * 关键：以事务 oncomplete（而非请求 onsuccess）作为成功信号；
 * 事务 abort/error 时 reject，杜绝“单请求成功、事务最终中止”被误报为已保存。
 */
function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest<T>,
  reason?: string
): Promise<T> {
  return multiStoreTx([store], mode, (stores) => run(stores[store]!), reason);
}

/**
 * 跨 store 事务（同一事务内多 store 写入，原子可见）。
 * 每个写请求完成后都可触发 afterRequest 故障（在事务 commit 前 abort），
 * 用于确定性复现“一条请求已成功、所属事务随后中止”的场景。
 */
function asStorageError(err: unknown, fallback: string): StorageError {
  if (err instanceof StorageError) return err;
  if (err instanceof DOMException && err.name) return new StorageError(`${err.name}: ${err.message}`);
  if (err instanceof Error) return new StorageError(err.message);
  return new StorageError(fallback);
}

function multiStoreTx<T>(
  stores: string[],
  mode: IDBTransactionMode,
  run: (byName: Record<string, IDBObjectStore>) => IDBRequest<T>,
  reason?: string
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const fail = (err: unknown) =>
          reject(asStorageError(err, `transaction failed (${reason ?? stores.join(',')})`));
        recordTx(reason, 'start');
        // 打开事务前的强制失败：写请求根本不会执行（配额不足/被拒形态）。
        if (faultFor(stores, reason, 'before')) {
          recordTx(reason, 'fault');
          reject(new StorageError(`transaction aborted before run (${reason ?? stores.join(',')})`));
          return;
        }
        const t = db.transaction(stores, mode);
        const byName: Record<string, IDBObjectStore> = {};
        for (const name of stores) byName[name] = t.objectStore(name);

        let result: T;
        let req: IDBRequest<T>;
        try {
          req = run(byName);
        } catch (err) {
          // 同步异常（如对已中止事务取 store）：尝试 abort 并按失败处理。
          try {
            t.abort();
          } catch {
            /* noop */
          }
          fail(err);
          return;
        }
        req.onsuccess = () => {
          result = req.result;
          // 请求已成功但事务尚未 commit：此处 abort 精确模拟
          // “单条写请求成功但所属事务随后中止”。
          if (faultFor(stores, reason, 'afterRequest')) {
            try {
              t.abort();
            } catch {
              /* noop */
            }
            return;
          }
        };
        req.onerror = () => {
          // 阻止冒泡到事务级错误，统一在此 reject。
          try {
            t.abort();
          } catch {
            /* noop */
          }
          fail(req.error ?? new Error('idb request error'));
        };
        t.oncomplete = () => {
          recordTx(reason, 'complete');
          resolve(result);
        };
        t.onabort = () => {
          recordTx(reason, 'abort');
          fail(
            req.error ??
              req.transaction?.error ??
              new Error(`transaction aborted (${reason ?? stores.join(',')})`)
          );
        };
        t.onerror = () => {
          recordTx(reason, 'abort');
          fail(
            t.error ??
              req.error ??
              new Error(`transaction error (${reason ?? stores.join(',')})`)
          );
        };
      })
  );
}

// ---- blobs ---------------------------------------------------------------

export interface BlobDraftWrite {
  items: SlideItem[];
  blobs: Array<{ blobId: string; blob: Blob; name: string }>;
}

/**
 * 导入图片：新增 Blob 与草稿节目单在同一事务内原子落库。
 * 事务中止时 Blob 与草稿都不可见，绝不会出现“磁盘多了图、节目单没存上”或反之。
 * readwrite 事务严格按请求入队顺序执行：全部 put 同步发出，事务要么整体提交、
 * 要么整体回滚。信号请求取首个 Blob 写入 —— afterRequest 故障在它成功后、
 * 事务提交前中止，精确复现“单条请求成功、所属事务随后中止”。
 */
export async function putBlobsAndDraft(write: BlobDraftWrite): Promise<void> {
  await multiStoreTx(
    [STORE_BLOBS, STORE_PROGRAM],
    'readwrite',
    (stores) => {
      const blobStore = stores[STORE_BLOBS]!;
      const programStore = stores[STORE_PROGRAM]!;
      let signal: IDBRequest<IDBValidKey> | null = null;
      for (const b of write.blobs) {
        const req = blobStore.put({ blobId: b.blobId, blob: b.blob, name: b.name });
        if (!signal) signal = req; // 第一个请求：其成功后、commit 前可被故障中止
      }
      const draftReq = programStore.put({
        key: 'draft',
        items: write.items,
        updatedAt: Date.now()
      });
      return (signal ?? draftReq) as unknown as IDBRequest<void>;
    },
    'addFiles'
  );
}

export async function getBlob(blobId: string): Promise<Blob | null> {
  const row = await tx<{ blobId: string; blob: Blob; name: string } | undefined>(
    STORE_BLOBS,
    'readonly',
    (s) => s.get(blobId)
  );
  return row?.blob ?? null;
}

export async function deleteBlob(blobId: string): Promise<void> {
  await tx(STORE_BLOBS, 'readwrite', (s) => s.delete(blobId), 'deleteBlob');
}

// ---- program -------------------------------------------------------------

export async function saveDraft(program: Program): Promise<void> {
  await tx(
    STORE_PROGRAM,
    'readwrite',
    (s) => s.put({ key: 'draft', items: program.items, updatedAt: Date.now() }),
    'saveDraft'
  );
}

export async function loadDraft(): Promise<Program | null> {
  const row = await tx<{ items: Program['items'] } | undefined>(
    STORE_PROGRAM,
    'readonly',
    (s) => s.get('draft')
  );
  return row ? { items: row.items } : null;
}

/** 开始放映：冻结节目单 + 会话在同一事务内原子写入（任一中止则两者都不可见）。 */
export async function saveFrozenAndSession(session: SessionRecord): Promise<void> {  await multiStoreTx(
    [STORE_PROGRAM, STORE_SESSION],
    'readwrite',
    (stores) => {
      const programStore = stores[STORE_PROGRAM]!;
      const sessionStore = stores[STORE_SESSION]!;
      const frozenAt = Date.now();
      // 顺序：frozen:<sid> -> frozen:latest -> current 会话。
      // 信号请求是第一个冻结写入：它成功后、事务提交前被 abort 时，
      // 冻结与会话都不可见（精确覆盖“冻结成功但保存会话失败”的假象）。
      const signal = programStore.put({
        key: `frozen:${session.sessionId}`,
        items: session.frozenProgram.items,
        frozenAt
      });
      programStore.put({
        key: 'frozen:latest',
        items: session.frozenProgram.items,
        frozenAt
      });
      sessionStore.put({ key: 'current', session, savedAt: Date.now() });
      return signal as unknown as IDBRequest<void>;
    },
    'startShow'
  );
}

export async function loadFrozen(sessionId = 'latest'): Promise<Program | null> {
  const row = await tx<{ items: Program['items'] } | undefined>(
    STORE_PROGRAM,
    'readonly',
    (s) => s.get(`frozen:${sessionId}`)
  );
  return row ? { items: row.items } : null;
}

// ---- session -------------------------------------------------------------

export async function saveSession(
  session: SessionRecord,
  reason: 'saveSession' | 'expire' = 'saveSession'
): Promise<void> {
  // 权威会话状态落库：只有事务完整提交后调用方才可宣布“已持久化”。
  await tx(
    STORE_SESSION,
    'readwrite',
    (s) => s.put({ key: 'current', session, savedAt: Date.now() }),
    reason
  );
}

export async function loadSession(): Promise<SessionRecord | null> {
  const row = await tx<{ session: SessionRecord } | undefined>(
    STORE_SESSION,
    'readonly',
    (s) => s.get('current')
  );
  return row?.session ?? null;
}

export async function clearSession(): Promise<void> {
  // 停映删除同样以事务完成为准：删除失败时旧会话仍是磁盘上的权威记录，
  // 调用方不得宣布已结束（刷新不得复活一个“内存已停映”的会话，反之亦然）。
  await tx(STORE_SESSION, 'readwrite', (s) => s.delete('current'), 'endShow');
}

/** 仅供测试/重置使用。 */
export async function _resetDatabase(): Promise<void> {
  dbPromise = null;
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}
