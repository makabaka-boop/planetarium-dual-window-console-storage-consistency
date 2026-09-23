/**
 * IndexedDB 持久化：
 *  - blobs: 图片 Blob（keyPath = blobId），不经消息通道传递
 *  - program: 节目单草稿与顺序（单行 key='draft' / key='frozen:<sessionId>'）
 *  - session: 当前/最近放映会话（刷新可恢复权威状态）
 *
 * 持久化权威规则：
 *  - Promise 只在事务 `complete` 之后才 resolve。单个请求 onsuccess 但事务随后
 *    abort（空间不足、权限收回）一律按失败处理，绝不把未落盘的数据宣布为已保存。
 *  - 同一逻辑写入（如开始放映时的 冻结节目单 + 会话）使用单个多对象库事务，
 *    要么全部可见，要么全部回滚——失败期间不会留下半条记录覆盖最后可恢复状态。
 *  - 打开/事务失败后不缓存失效的连接 Promise，下一次调用可以重新打开。
 */
import { Program, SessionRecord } from './protocol/types';

const DB_NAME = 'dome-presenter';
const DB_VERSION = 1;
export const STORE_BLOBS = 'blobs';
export const STORE_PROGRAM = 'program';
export const STORE_SESSION = 'session';

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      dbPromise = null;
      reject(err instanceof Error ? err : new StorageError(String(err), 'open'));
      return;
    }
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
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error ?? new StorageError('打开数据库失败', 'open'));
    };
    req.onblocked = () => {
      // 旧标签持有连接导致升级被阻塞：视为失败，不缓存任何连接。
      dbPromise = null;
      reject(req.error ?? new StorageError('数据库升级被其它标签阻塞', 'open'));
    };
  });
  // 连接自身后续触发 fatal error（如底层存储被移除）时丢弃缓存，允许重新打开。
  dbPromise.then(
    (db) => {
      db.onclose = () => {
        if (dbPromise) void dbPromise.then((d) => d === db && (dbPromise = null));
      };
      db.onerror = () => undefined;
    },
    () => undefined
  );
  return dbPromise;
}

/** 所有存储层抛出的错误都带描述与作用范围（提交边界标签）。 */
export class StorageError extends Error {
  scope: string;
  constructor(message: string, scope: string) {
    super(message);
    this.name = 'StorageError';
    this.scope = scope;
  }
}

function quotaError(scope: string): StorageError {
  // 真实 QuotaExceededError 无法可靠构造（构造器在各浏览器不一致），
  // 用 StorageError 承载同样的语义即可，消费方只读 name/message/scope。
  const err = new StorageError('存储空间不足或写入被拒绝（QuotaExceededError）', scope);
  err.name = 'QuotaExceededError';
  return err;
}

// ---- 测试故障注入 --------------------------------------------------------
// 自动化验收需要在“各提交边界”强制拒绝或中止事务。生产环境页面上不存在
// __domeDbFaults 这个全局对象，读取始终为 null，零开销、无任何行为变化。
export type DbFaultMode = 'abort-request' | 'abort-now' | 'quota';

export interface DbFaultRule {
  /** 精确等于标签，或标签以 `${scope}:` 开头时命中。 */
  scope: string;
  mode: DbFaultMode;
}

interface DbFaultControls {
  rules: DbFaultRule[];
  hits: string[];
}

function faultControls(): DbFaultControls | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { __domeDbFaults?: DbFaultControls }).__domeDbFaults ?? null;
}

function matchFault(label: string): DbFaultRule | null {
  const controls = faultControls();
  if (!controls) return null;
  const rule = controls.rules.find(
    (r) => r.scope === label || label.startsWith(`${r.scope}:`)
  );
  if (rule) controls.hits.push(label);
  return rule ?? null;
}

/**
 * 在一个事务内执行多个写入；以事务 complete 为成功依据。
 * run 内即便请求已经 onsuccess，只要事务随后 abort，整体仍 reject。
 */
async function txn<T>(
  stores: string[],
  mode: IDBTransactionMode,
  label: string,
  run: (storesByName: Map<string, IDBObjectStore>, t: IDBTransaction) => IDBRequest<T> | void
): Promise<T> {
  const fault = matchFault(label);
  if (fault?.mode === 'quota') {
    // 模拟“打开/权限/空间”层面的失败：事务根本未能开始。
    throw quotaError(label);
  }
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    let t: IDBTransaction;
    try {
      t = db.transaction(stores, mode);
    } catch (err) {
      dbPromise = null;
      reject(err instanceof Error ? err : new StorageError(String(err), label));
      return;
    }
    if (fault?.mode === 'abort-now') {
      try {
        t.abort();
      } catch {
        // abort 本身失败时继续依赖 onabort/onerror 收敛
      }
    }
    let request: IDBRequest<T> | null = null;
    try {
      const r = run(
        new Map(stores.map((name) => [name, t.objectStore(name)])),
        t
      );
      if (r) request = r;
    } catch (err) {
      try {
        t.abort();
      } catch {
        // ignore
      }
      reject(err instanceof Error ? err : new StorageError(String(err), label));
      return;
    }
    t.oncomplete = () => resolve(request?.result as T);
    t.onerror = () => {
      // 请求错误会冒泡到事务；以事务错误为权威，阻止默认 abort 报错噪音。
      if (t.error?.name === 'QuotaExceededError') reject(quotaError(label));
      else reject(t.error ?? request?.error ?? new StorageError('事务失败', label));
    };
    t.onabort = () => {
      if (t.error?.name === 'QuotaExceededError') reject(quotaError(label));
      else reject(t.error ?? request?.error ?? new StorageError('事务被中止', label));
    };
    if (request && fault?.mode === 'abort-request') {
      // 精确复现“单条写请求成功，但所属事务随后中止”：在请求 success 事件中
      // （此刻事务仍处于 active，尚未 complete）同步 abort。请求结果已经产生，
      // 但整个事务不会提交——这是 IDB 保证会触发 onabort 的标准时机，避免在
      // 后续宏任务里 abort 时事务可能已经自动提交。
      request.addEventListener('success', () => {
        try {
          t.abort();
        } catch {
          // 事务已结束时无需再处理，oncomplete/onabort 自会收敛
        }
      });
    }
  });
}

/** 单对象库事务（只读或单写入）。 */
function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  label: string,
  run: (s: IDBObjectStore) => IDBRequest<T> | void
): Promise<T> {
  return txn([store], mode, label, (m) => run(m.get(store)!));
}

export async function putBlob(blobId: string, blob: Blob, name: string): Promise<void> {
  await tx(STORE_BLOBS, 'readwrite', 'blob:put', (s) =>
    s.put({ blobId, blob, name })
  );
}

export async function getBlob(blobId: string): Promise<Blob | null> {
  const row = await tx<{ blobId: string; blob: Blob; name: string } | undefined>(
    STORE_BLOBS,
    'readonly',
    'blob:get',
    (s) => s.get(blobId)
  );
  return row?.blob ?? null;
}

export async function deleteBlob(blobId: string): Promise<void> {
  await tx(STORE_BLOBS, 'readwrite', 'blob:delete', (s) => s.delete(blobId));
}

export async function saveDraft(program: Program): Promise<void> {
  await tx(STORE_PROGRAM, 'readwrite', 'draft:save', (s) =>
    s.put({ key: 'draft', items: program.items, updatedAt: Date.now() })
  );
}

export async function loadDraft(): Promise<Program | null> {
  const row = await tx<{ items: Program['items'] } | undefined>(
    STORE_PROGRAM,
    'readonly',
    'draft:load',
    (s) => s.get('draft')
  );
  return row ? { items: row.items } : null;
}

/**
 * 开始放映的权威落库：冻结节目单（会话键 + latest 兼容键）与当前会话写入
 * 同一事务，原子可见。失败时磁盘保持上一会话/无会话，绝不留下“冻结已存、
 * 会话缺失”的半成品。
 */
export async function saveShowStart(
  session: SessionRecord,
  items: Program['items']
): Promise<void> {
  const now = Date.now();
  await txn(
    [STORE_PROGRAM, STORE_SESSION],
    'readwrite',
    'show:start',
    (m) => {
      const program = m.get(STORE_PROGRAM)!;
      program.put({ key: `frozen:${session.sessionId}`, items, frozenAt: now });
      // 同时保留一个 latest 键，供无会话信息的场景读取（观众窗兜底）。
      program.put({ key: 'frozen:latest', items, frozenAt: now });
      return m.get(STORE_SESSION)!.put({ key: 'current', session, savedAt: now });
    }
  );
}

/** 兼容保留：单独保存冻结节目单（旧格式两键，各自独立事务）。 */
export async function saveFrozen(program: Program, sessionId = 'latest'): Promise<void> {
  await tx(STORE_PROGRAM, 'readwrite', 'frozen:save', (s) =>
    s.put({ key: `frozen:${sessionId}`, items: program.items, frozenAt: Date.now() })
  );
  if (sessionId !== 'latest') {
    await tx(STORE_PROGRAM, 'readwrite', 'frozen:save-latest', (s) =>
      s.put({ key: 'frozen:latest', items: program.items, frozenAt: Date.now() })
    );
  }
}

export async function loadFrozen(sessionId = 'latest'): Promise<Program | null> {
  const row = await tx<{ items: Program['items'] } | undefined>(
    STORE_PROGRAM,
    'readonly',
    'frozen:load',
    (s) => s.get(`frozen:${sessionId}`)
  );
  return row ? { items: row.items } : null;
}

/**
 * 持久化当前会话权威状态。label 区分提交边界（命令发出 / ACK 推进 / 超时标记
 * /重试），供故障注入精确拦截；数据格式完全一致。
 */
export async function saveSession(session: SessionRecord, label = 'session:save'): Promise<void> {
  await tx(STORE_SESSION, 'readwrite', label, (s) =>
    s.put({ key: 'current', session, savedAt: Date.now() })
  );
}

export async function loadSession(): Promise<SessionRecord | null> {
  const row = await tx<{ session: SessionRecord } | undefined>(
    STORE_SESSION,
    'readonly',
    'session:load',
    (s) => s.get('current')
  );
  return row?.session ?? null;
}

/**
 * 停映清理：删除当前会话记录。只有事务 complete 才视为结束已持久化；
 * 失败时旧记录原样保留，由调用方决定保持运行态并提示重试——
 * 已结束的会话绝不能因为清理失败而在刷新后复活。
 */
export async function clearSession(): Promise<void> {
  await tx(STORE_SESSION, 'readwrite', 'show:end', (s) => s.delete('current'));
}

/** 仅供测试/重置使用。 */
export async function _resetDatabase(): Promise<void> {
  // 先关闭缓存连接，否则 deleteDatabase 在仍有打开连接时会被阻塞（onblocked）。
  if (dbPromise) {
    const open = dbPromise;
    dbPromise = null;
    open.then(
      (db) => db.close(),
      () => undefined
    );
  }
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}
