/**
 * IndexedDB 持久化：
 *  - blobs: 图片 Blob（keyPath = blobId），不经消息通道传递
 *  - program: 节目单草稿与顺序（单行 key='draft' / key='frozen'）
 *  - session: 当前/最近放映会话（刷新可恢复权威状态）
 */
import { Program, SessionRecord } from './protocol/types';

const DB_NAME = 'dome-presenter';
const DB_VERSION = 1;
const STORE_BLOBS = 'blobs';
const STORE_PROGRAM = 'program';
const STORE_SESSION = 'session';

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
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
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = run(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      })
  );
}

export async function putBlob(blobId: string, blob: Blob, name: string): Promise<void> {
  await tx(STORE_BLOBS, 'readwrite', (s) => s.put({ blobId, blob, name }));
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
  await tx(STORE_BLOBS, 'readwrite', (s) => s.delete(blobId));
}

export async function saveDraft(program: Program): Promise<void> {
  await tx(STORE_PROGRAM, 'readwrite', (s) =>
    s.put({ key: 'draft', items: program.items, updatedAt: Date.now() })
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

export async function saveFrozen(program: Program, sessionId = 'latest'): Promise<void> {
  await tx(STORE_PROGRAM, 'readwrite', (s) =>
    s.put({ key: `frozen:${sessionId}`, items: program.items, frozenAt: Date.now() })
  );
  // 同时保留一个 latest 键，供无会话信息的场景读取。
  if (sessionId !== 'latest') {
    await tx(STORE_PROGRAM, 'readwrite', (s) =>
      s.put({ key: 'frozen:latest', items: program.items, frozenAt: Date.now() })
    );
  }
}

export async function loadFrozen(sessionId = 'latest'): Promise<Program | null> {
  const row = await tx<{ items: Program['items'] } | undefined>(
    STORE_PROGRAM,
    'readonly',
    (s) => s.get(`frozen:${sessionId}`)
  );
  return row ? { items: row.items } : null;
}

export async function saveSession(session: SessionRecord): Promise<void> {
  // 冻结节目单随会话一起存，恢复时带回。
  await tx(STORE_SESSION, 'readwrite', (s) =>
    s.put({ key: 'current', session, savedAt: Date.now() })
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
  await tx(STORE_SESSION, 'readwrite', (s) => s.delete('current'));
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
