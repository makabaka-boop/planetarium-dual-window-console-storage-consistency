import { Browser, BrowserContext, Page, expect } from '@playwright/test';
import zlib from 'node:zlib';

/** 1x1 红点 PNG，最小合法 PNG，供“正常图片”用。 */
export const RED_DOT_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

export const GREEN_DOT_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** 一个声称自己是 PNG 但无法解码的文件：用于“单张解码失败只标记该项”。 */
export const GARBAGE_PNG_BYTES = Buffer.from('this is definitely not a png', 'utf8');

export interface AddedImage {
  name: string;
  buffer: Buffer;
  mime: string;
}

export function pngImage(name: string, dataBase64 = RED_DOT_PNG): AddedImage {
  return { name, buffer: Buffer.from(dataBase64, 'base64'), mime: 'image/png' };
}

export function garbagePng(name: string): AddedImage {
  return { name, buffer: GARBAGE_PNG_BYTES, mime: 'image/png' };
}

// --- 纯色 PNG 程序化生成（中心像素即可区分画面） ---------------------------

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** 生成 size×size 的纯 RGB 色 PNG（默认 4x4，采样中心像素即可区分）。 */
export function solidPng(
  name: string,
  rgb: [number, number, number],
  size = 4
): AddedImage {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  // 每行：filter byte 0 + RGB*size
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 3 + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < size; x++) {
      raw[rowStart + 1 + x * 3] = rgb[0];
      raw[rowStart + 2 + x * 3] = rgb[1];
      raw[rowStart + 3 + x * 3] = rgb[2];
    }
  }
  const idat = zlib.deflateSync(raw);
  const buffer = Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
  return { name, buffer, mime: 'image/png' };
}

/** 通过隐藏 input 选择文件，等待节目单行渲染。 */
export async function addImages(consolePage: Page, images: AddedImage[]) {
  const dataTransfers = images.map((img) => ({
    name: img.name,
    mimeType: img.mime,
    buffer: img.buffer
  }));
  await consolePage.locator('input[type=file]').first().setInputFiles(dataTransfers);
  // 缩略图（或失败标记）出现即说明该项落库完成
  await expect(consolePage.getByTestId('slide-list').locator('li')).toHaveCount(
    images.length
  );
}

/** 打开控制台并确认就绪。 */
export async function openConsole(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/console');
  await expect(page.getByTestId('start-show')).toBeVisible();
  return { context, page };
}

/**
 * 开始放映并接住观众窗弹窗。
 * 页面基址由 playwright.config 的 baseURL 决定。
 * waitHud=false 时只接住弹窗（首帧解码被测试挂起、HUD 不会出现的场景）。
 */
export async function startShowWithPopup(
  context: BrowserContext,
  consolePage: Page,
  waitHud = true
): Promise<Page> {
  const popupPromise = context.waitForEvent('page');
  await consolePage.getByTestId('start-show').click();
  const viewer = await popupPromise;
  await viewer.waitForLoadState('load');
  if (waitHud) {
    await expect(viewer.getByTestId('viewer-hud')).toBeVisible({ timeout: 10_000 });
  }
  return viewer;
}

/** 读取观众窗 HUD 文本（如“第 2 / 3 页”或“遮黑”）；恢复期间无 HUD 时返回空串。 */
export async function hudText(viewer: Page): Promise<string> {
  const hud = viewer.getByTestId('viewer-hud');
  if ((await hud.count()) === 0) return '';
  return (await hud.innerText()).replace(/\s+/g, ' ').trim();
}

/**
 * 解码闸：必须在应用脚本之前注入（addInitScript）。拦截 new Image() 的 src 赋值，
 * 使每张图片真正开始“解码”的时机完全由测试控制：
 *
 *   gate()           开启拦截（之后的 src 赋值全部挂起）
 *   pendingCount()   当前挂起的解码请求数（按创建顺序编号 0..n-1）
 *   releaseNth(n)    放行第 n 个挂起请求（赋真实 src，浏览器自然 load/error）
 *   releaseAll()     按创建顺序全部放行
 *   ungate()         关闭拦截（后续请求立即解码；已挂起的不动）
 *
 * 坏图无需特殊处理：放行后浏览器对垃圾字节自然派发 error。
 */
export async function installSeqDecodeGate(
  context: BrowserContext,
  autoEnable = false
): Promise<void> {
  await context.addInitScript(
    (auto) => {
      interface Held {
        url: string;
        fire: () => void;
      }
      const G = window as unknown as {
        __domeGate?: {
          gate: () => void;
          ungate: () => void;
          releaseNth: (n: number) => boolean;
          releaseAll: () => number;
          inflight: () => number[];
          pendingCount: () => number;
        };
      };
      if (G.__domeGate) return;
      let enabled = Boolean(auto);
      // 挂起队列（按 src 赋值顺序）；WeakMap 关联实例，防止同一元素重入。
      const heldByImg = new WeakMap<HTMLImageElement, Held>();
      const queue: Held[] = [];

      const proto = HTMLImageElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'src')!;
      Object.defineProperty(proto, 'src', {
        configurable: true,
        enumerable: desc.enumerable,
        get(this: HTMLImageElement) {
          return desc.get!.call(this);
        },
        set(this: HTMLImageElement, v: string) {
          const url = String(v);
          if (!enabled) {
            desc.set!.call(this, url);
            return;
          }
          // 挂起：不赋真实 src；放行时再赋，浏览器随后自然派发 load/error。
          const held: Held = {
            url,
            fire: () => {
              if (heldByImg.get(this) !== held) return;
              heldByImg.delete(this);
              desc.set!.call(this, held.url);
            }
          };
          heldByImg.set(this, held);
          queue.push(held);
        }
      });

      G.__domeGate = {
        gate() {
          enabled = true;
        },
        ungate() {
          enabled = false;
        },
        releaseNth(n: number) {
          const held = queue[n];
          if (!held) return false;
          queue.splice(n, 1);
          held.fire();
          return true;
        },
        releaseAll() {
          const all = queue.splice(0, queue.length);
          all.forEach((h) => h.fire());
          return all.length;
        },
        inflight() {
          return queue.map((_, i) => i);
        },
        pendingCount() {
          return queue.length;
        }
      };
    },
    autoEnable
  );
}

export interface GateHandle {
  gate: () => Promise<void>;
  ungate: () => Promise<void>;
  pendingCount: () => Promise<number>;
  releaseNth: (n: number) => Promise<boolean>;
  releaseAll: () => Promise<number>;
}

/**
 * 安装观众窗测试钩子（init 阶段）。配合 ViewerRuntime 的 __domeTestHooks：
 *   holdGate(point)  在该点挂起（快照已 live 未绘制 / 命令已接受未呈现）
 *   openGate(point)  放行该点
 */
export async function installTestHooks(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const W = window as unknown as {
      __domeTestHooks?: {
        gates: Record<string, { promise: Promise<void>; open: () => void } | undefined>;
        hold: (point: string) => void;
        open: (point: string) => void;
      };
    };
    if (W.__domeTestHooks) return;
    const make = () => {
      let resolveFn: () => void = () => undefined;
      const promise = new Promise<void>((r) => {
        resolveFn = r;
      });
      return { promise, open: resolveFn };
    };
    const gates: Record<string, { promise: Promise<void>; open: () => void } | undefined> = {};
    W.__domeTestHooks = {
      gates,
      hold(point: string) {
        if (!gates[point]) gates[point] = make();
      },
      open(point: string) {
        gates[point]?.open();
        gates[point] = undefined;
      }
    };
  });
}

export type TestHookPoint = 'snapshotLive' | 'beforePresent' | 'afterError';

export async function holdHook(viewer: Page, point: TestHookPoint): Promise<void> {
  await viewer.evaluate((p) => {
    (window as unknown as { __domeTestHooks: { hold: (s: string) => void } }).__domeTestHooks.hold(p);
  }, point);
}

export async function openHook(viewer: Page, point: TestHookPoint): Promise<void> {
  await viewer.evaluate((p) => {
    (window as unknown as { __domeTestHooks: { open: (s: string) => void } }).__domeTestHooks.open(p);
  }, point);
}

export function gateOn(viewer: Page): GateHandle {
  const call =
    (method: string) =>
    (...args: unknown[]) =>
      viewer.evaluate(
        ({ m, a }) => {
          const g = (
            window as unknown as {
              __domeGate: Record<string, (...x: unknown[]) => unknown>;
            }
          ).__domeGate;
          return g[m](...a) as never;
        },
        { m: method, a: args }
      );
  return {
    gate: call('gate') as () => Promise<void>,
    ungate: call('ungate') as () => Promise<void>,
    pendingCount: call('pendingCount') as () => Promise<number>,
    releaseNth: call('releaseNth') as (n: number) => Promise<boolean>,
    releaseAll: call('releaseAll') as () => Promise<number>
  };
}

/** 在页面内安装 BroadcastChannel 观察器：记录本页发出的 ACK（只观察，不影响发送）。 */
export async function installAckSpy(viewer: Page): Promise<void> {
  await viewer.evaluate(() => {
    const W = window as unknown as {
      __domeAcks?: Array<Record<string, unknown>>;
    };
    W.__domeAcks = [];
    const Orig = BroadcastChannel;
    function PatchedBC(this: unknown, name: string): BroadcastChannel {
      const ch: BroadcastChannel = new Orig(name);
      const post = ch.postMessage.bind(ch);
      ch.postMessage = (msg: unknown) => {
        const m = msg as { kind?: string };
        if (m && m.kind === 'ACK') W.__domeAcks!.push({ ...(m as Record<string, unknown>) });
        return post(msg);
      };
      return ch;
    }
    PatchedBC.prototype = Orig.prototype;
    window.BroadcastChannel = PatchedBC as unknown as typeof BroadcastChannel;
  });
}

/** init 阶段版本：在应用任何脚本之前 patch BroadcastChannel（适用于弹窗/刷新后的页面）。 */
export async function installAckSpyInit(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const W = window as unknown as { __domeAcks?: Array<Record<string, unknown>> };
    W.__domeAcks = [];
    const Orig = BroadcastChannel;
    function PatchedBC(this: unknown, name: string): BroadcastChannel {
      const ch: BroadcastChannel = new Orig(name);
      const post = ch.postMessage.bind(ch);
      ch.postMessage = (msg: unknown) => {
        const m = msg as { kind?: string };
        if (m && m.kind === 'ACK') W.__domeAcks!.push({ ...(m as Record<string, unknown>) });
        return post(msg);
      };
      return ch;
    }
    PatchedBC.prototype = Orig.prototype;
    window.BroadcastChannel = PatchedBC as unknown as typeof BroadcastChannel;
  });
}

export interface AckRecord {
  seq: number;
  ok: boolean;
  page: number;
  blackout: boolean;
  target?: { page: number; blackout: boolean };
}

/** 读取观众窗已发出的 ACK 记录快照。 */
export async function readAcks(viewer: Page): Promise<AckRecord[]> {
  return viewer.evaluate(() => {
    const W = window as unknown as { __domeAcks?: AckRecord[] };
    return (W.__domeAcks ?? []).map((a) => ({ ...a }));
  });
}

/** 采样观众窗 canvas 中心像素，返回 [r,g,b]；黑屏为 [0,0,0]，红/绿点可区分。 */
export async function canvasCenterPixel(viewer: Page): Promise<[number, number, number]> {
  return viewer.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="dome-canvas"]')!;
    const ctx = canvas.getContext('2d')!;
    const d = ctx.getImageData(
      Math.floor(canvas.width / 2),
      Math.floor(canvas.height / 2),
      1,
      1
    ).data;
    return [d[0], d[1], d[2]] as [number, number, number];
  });
}

// ---- IndexedDB 存储故障注入 ----------------------------------------------

export type DbFaultPhase = 'before' | 'afterRequest';
export interface DbFaultArmRule {
  /** 精确 reason 或前缀（以 * 结尾，如 'save*'）；缺省匹配全部写事务。 */
  reason?: string;
  /** 涉及的 store（AND 匹配，多 store 事务需全部包含）。 */
  stores?: string[];
  phase: DbFaultPhase;
  /** 命中一次后自动解除（默认一次性，精确卡住某一个提交边界）。 */
  once?: boolean;
  /** 跳过前 N 次匹配（同一 reason 的连续提交中精确命中第 N+1 个边界）。 */
  skip?: number;
}

/**
 * 在任何应用脚本之前安装 IndexedDB 故障注入钩子（src/db.ts 读取 window.__domeDbFaults）。
 * 钩子状态在页面生命周期内保留；同一 context 下刷新页面会重建对象，
 * 因此需要“跨越刷新继续生效”的规则时，在刷新后重新 arm（见 armDbFault）。
 */
export async function installDbFaultsInit(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const W = window as unknown as {
      __domeDbFaults?: {
        rules: Array<Record<string, unknown>>;
        openRule: { fail: boolean; once?: boolean } | null;
        lastFailure: Record<string, unknown> | null;
        failureCount: number;
        arm: (rule: Record<string, unknown>) => void;
        armOpen: (rule: { fail: boolean; once?: boolean }) => void;
        disarm: () => void;
      };
    };
    if (W.__domeDbFaults) return;
    W.__domeDbFaults = {
      rules: [],
      openRule: null,
      lastFailure: null,
      failureCount: 0,
      arm(rule) {
        W.__domeDbFaults!.rules.push({ once: true, ...rule });
      },
      armOpen(rule) {
        W.__domeDbFaults!.openRule = rule;
      },
      disarm() {
        W.__domeDbFaults!.rules = [];
        W.__domeDbFaults!.openRule = null;
      }
    };
  });
}

export async function armDbFault(page: Page, rule: DbFaultArmRule): Promise<void> {
  await page.evaluate((r) => {
    (
      window as unknown as {
        __domeDbFaults: { arm: (rule: Record<string, unknown>) => void };
      }
    ).__domeDbFaults.arm(r);
  }, rule);
}

export async function armDbOpenFault(page: Page, once = true): Promise<void> {
  await page.evaluate(
    (o) => {
      (
        window as unknown as {
          __domeDbFaults: { armOpen: (rule: { fail: boolean; once?: boolean }) => void };
        }
      ).__domeDbFaults.armOpen(o);
    },
    { fail: true, once }
  );
}

export async function disarmDbFaults(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __domeDbFaults: { disarm: () => void } }).__domeDbFaults.disarm();
  });
}

export interface DbFaultStatus {
  failureCount: number;
  lastFailure: { reason: string; stores: string[]; phase: string } | null;
}

export async function dbFaultStatus(page: Page): Promise<DbFaultStatus> {
  return page.evaluate(() => {
    const h = (window as unknown as { __domeDbFaults?: DbFaultStatus }).__domeDbFaults;
    return {
      failureCount: h?.failureCount ?? 0,
      lastFailure: h?.lastFailure ?? null
    };
  });
}

// ---- 直接读取磁盘持久记录（绕过应用内存，核对“最后可恢复记录”） ----------

export interface PersistedState {
  hasSession: boolean;
  running: boolean | null;
  sessionId: string | null;
  confirmed: { seq: number; page: number; blackout: boolean } | null;
  pending: { seq: number; status: string; target: { page: number; blackout: boolean } } | null;
  draftCount: number;
  blobCount: number;
  frozenLatestCount: number | null;
}

const DB_NAME = 'dome-presenter';

/** 直接打开同源 IndexedDB 读取磁盘上的会话/草稿/Blob/冻结节目单（与应用库结构一致）。 */
export async function readPersistedState(page: Page): Promise<PersistedState> {
  return page.evaluate((dbName) => {
    return new Promise<PersistedState>((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const out: PersistedState = {
          hasSession: false,
          running: null,
          sessionId: null,
          confirmed: null,
          pending: null,
          draftCount: 0,
          blobCount: 0,
          frozenLatestCount: null
        };
        const tx = db.transaction(['session', 'program', 'blobs'], 'readonly');
        const sessionReq = tx.objectStore('session').get('current');
        const draftReq = tx.objectStore('program').get('draft');
        const frozenReq = tx.objectStore('program').get('frozen:latest');
        const countReq = tx.objectStore('blobs').count();
        tx.oncomplete = () => {
          interface DurableSession {
            sessionId: string;
            running: boolean;
            lastConfirmed: { seq: number; page: number; blackout: boolean };
            pending: {
              seq: number;
              status: string;
              target: { page: number; blackout: boolean };
            } | null;
          }
          const row = sessionReq.result as { session: DurableSession } | undefined;
          if (row?.session) {
            const s = row.session;
            out.hasSession = true;
            out.running = s.running;
            out.sessionId = s.sessionId;
            out.confirmed = s.lastConfirmed;
            out.pending = s.pending
              ? {
                  seq: s.pending.seq,
                  status: s.pending.status,
                  target: s.pending.target
                }
              : null;
          }
          const draft = draftReq.result as { items?: unknown[] } | undefined;
          out.draftCount = draft?.items?.length ?? 0;
          const frozen = frozenReq.result as { items?: unknown[] } | undefined;
          out.frozenLatestCount = frozen?.items?.length ?? null;
          out.blobCount = countReq.result;
          db.close();
          resolve(out);
        };
        tx.onerror = () => reject(tx.error);
      };
    });
  }, DB_NAME);
}

/** 控制台横幅的可重试操作类型（data-op 属性）。 */
export async function storageErrorOp(consolePage: Page): Promise<string | null> {
  const banner = consolePage.getByTestId('storage-error');
  if ((await banner.count()) === 0) return null;
  return banner.getAttribute('data-op');
}
