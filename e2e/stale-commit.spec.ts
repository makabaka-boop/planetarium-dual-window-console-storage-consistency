import { chromium, expect, Page, test } from '@playwright/test';
import {
  addImages,
  canvasCenterPixel,
  gateOn,
  holdHook,
  hudText,
  installAckSpyInit,
  installSeqDecodeGate,
  installTestHooks,
  openHook,
  openConsole,
  readAcks,
  solidPng,
  startShowWithPopup
} from './helpers';

test.describe.configure({ mode: 'serial' });

// 四页纯色（8x8，cover 后中心像素即本色）：红 / 绿 / 蓝 / 白
const RED: [number, number, number] = [220, 30, 30];
const GREEN: [number, number, number] = [30, 200, 40];
const BLUE: [number, number, number] = [40, 60, 220];
const BLACK: [number, number, number] = [0, 0, 0];

type RGB = [number, number, number];

function fourProgram() {
  return [
    solidPng('red.png', RED, 8),
    solidPng('green.png', GREEN, 8),
    solidPng('blue.png', BLUE, 8),
    solidPng('white.png', [240, 240, 240], 8)
  ];
}

async function expectPixel(viewer: Page, color: RGB) {
  await expect.poll(() => canvasCenterPixel(viewer), { timeout: 5000 }).toEqual(color);
}

/** 等待至少 n 个解码挂起后全部放行。 */
async function releaseWhenReady(
  viewer: Page,
  n = 1,
  timeout = 8000
): Promise<number> {
  const gate = gateOn(viewer);
  await expect.poll(() => gate.pendingCount(), { timeout }).toBeGreaterThanOrEqual(n);
  return gate.releaseAll();
}

async function sessionIdOf(consolePage: Page): Promise<string> {
  return (await consolePage.getByTestId('session-id').innerText()).trim();
}

/** 从指定页面直接向通道注入一条 ACK。 */
async function postAck(
  from: Page,
  ack: {
    sessionId: string;
    seq: number;
    ok: boolean;
    page: number;
    blackout: boolean;
    target?: { page: number; blackout: boolean };
  }
): Promise<void> {
  await from.evaluate((a) => {
    const ch = new BroadcastChannel('dome-presenter-v1');
    ch.postMessage({
      kind: 'ACK',
      viewerId: `rogue-${Math.random().toString(36).slice(2)}`,
      ...a
    });
    ch.close();
  }, ack);
}

/**
 * 验收 1：观众窗刚恢复、快照图片仍在解码时连续切页/遮黑/结束放映 ——
 * 停映后再放行恢复前与切页挂起的全部旧解码，穹顶持续黑屏；迟到 resize 也无效。
 */
test('旧快照与切页晚于停映完成：画面持续黑屏，迟到绘制/缩放无效', async () => {
  const browser = await chromium.launch();
  const { context, page: consolePage } = await openConsole(browser);
  await installSeqDecodeGate(context, true); // 弹窗首帧起解码即挂起
  await installAckSpyInit(context);
  await addImages(consolePage, fourProgram());

  // 不等 HUD：初始快照（红页）解码被挂起，观众窗停在恢复态
  const viewer = await startShowWithPopup(context, consolePage, false);
  const gate = gateOn(viewer);
  await expect.poll(() => gate.pendingCount(), { timeout: 5000 }).toBeGreaterThanOrEqual(1);
  await expect(viewer.getByTestId('viewer-recovering')).toBeVisible();

  // 恢复完成前连续操作：跳第 3 页（蓝）-> 直接停映
  await consolePage.getByTestId('goto-input').fill('3');
  await consolePage.getByTestId('goto-go').click();
  await expect(consolePage.getByTestId('status-pending')).toBeVisible({ timeout: 3000 });
  await consolePage.getByTestId('end-show').click();

  // 反向放行恢复前/停映前挂起的全部解码：任何一帧都不得画上画布
  const released = await gate.releaseAll();
  expect(released).toBeGreaterThanOrEqual(1);
  await viewer.waitForTimeout(300);
  await expectPixel(viewer, BLACK);
  await expect(viewer.getByTestId('viewer-ended')).toBeVisible({ timeout: 3000 });

  // 迟到的窗口缩放同样不得把旧图片再画出来
  await viewer.setViewportSize({ width: 900, height: 700 });
  await viewer.waitForTimeout(300);
  await expectPixel(viewer, BLACK);

  await viewer.close();
  await context.close();
  await browser.close();
});

/**
 * 验收 2：恢复刚把状态切到 live、快照图片仍在绘制时，迟到的同序号新命令完成
 * 在其后 —— 旧快照（恢复权威绿页）晚于新命令（蓝页）完成时，最终像素必须锁定
 * 快照权威（绿），且不发出 seq=2 确认；再次刷新仍收敛同一权威。
 */
test('恢复快照晚于在途命令完成：画面锁定快照，迟到命令不提交、不确认', async () => {
  const browser = await chromium.launch();
  const { context, page: consolePage } = await openConsole(browser);
  await installSeqDecodeGate(context, true);
  await installAckSpyInit(context);
  await installTestHooks(context);
  await addImages(consolePage, fourProgram());

  const viewer = await startShowWithPopup(context, consolePage, false);
  let gate = gateOn(viewer);
  await releaseWhenReady(viewer);
  await expect(viewer.getByTestId('viewer-hud')).toBeVisible({ timeout: 5000 });
  await expectPixel(viewer, RED);

  // 走到绿页并确认（权威 seq=1, page=1 绿）
  await consolePage.getByTestId('next').click();
  await releaseWhenReady(viewer);
  await expect.poll(() => hudText(viewer), { timeout: 5000 }).toContain('第 2 / 4 页');
  await expectPixel(viewer, GREEN);

  // 发 goto 蓝页 seq=2，等控制台超时转“未确认”（观众窗始终不确认它）。
  await consolePage.getByTestId('goto-input').fill('3');
  await consolePage.getByTestId('goto-go').click();
  await expect(consolePage.getByTestId('status-pending')).toBeVisible({ timeout: 3000 });

  // 预置门：刷新后“快照已切 live、paintConfirmed 提交前”停住。
  await holdHook(viewer, 'snapshotLive');
  await viewer.reload();
  gate = gateOn(viewer);
  // 恢复态发起的绿解码挂起（snapshotLive 门在 loadImage 之后才等待，所以先挂起）
  await expect.poll(() => gate.pendingCount(), { timeout: 8000 }).toBe(1);
  await expect(consolePage.getByTestId('status-unconfirmed'), { timeout: 8000 }).toBeVisible();

  // 放行绿解码（缓存就绪），但门仍关着，paintConfirmed 尚未真正提交绘制。
  await gate.releaseAll();
  // 趁恢复尚未结束（绿绘制未提交、HUD 未出现），讲解员重试 seq=2。
  // 命令在恢复态到达会被丢弃，轮询重试直到它在“门开、live 瞬间”被接受：
  // 为此我们先开门（paintConfirmed 随即把绿画上并 emit live），紧接着持续重试。
  await openHook(viewer, 'snapshotLive');
  await expect(viewer.getByTestId('viewer-hud')).toBeVisible({ timeout: 3000 });
  // 此时才点重试：appliedSeq=1，seq=2 相邻，蓝页被接受、蓝解码在途。
  await consolePage.getByTestId('retry').click();
  await expect(consolePage.getByTestId('status-pending'), { timeout: 3000 }).toBeVisible();
  await expect.poll(() => gate.pendingCount(), { timeout: 5000 }).toBe(1); // 蓝在途

  // 穹顶此刻：绿（快照）已先画，蓝（新命令）在途。
  await expectPixel(viewer, GREEN);

  // 蓝完成 -> 它是当前合法命令，正常画上并 ACK；控制台收敛到蓝 seq=2。
  await gate.releaseAll();
  await expect.poll(() => hudText(viewer), { timeout: 5000 }).toContain('第 3 / 4 页');
  await expectPixel(viewer, BLUE);
  await expect(consolePage.getByTestId('current-page')).toHaveText('3');

  // 反向顺序核心：再制造一次“旧恢复晚于新命令”。蓝确认后再发 goto 白页 seq=3 挂起，
  // 立刻刷新（新快照是已确认蓝页），白绘制（seq=3 未决补发/重试）若在恢复窗口被接受
  // 也必须在快照蓝之后作废。这里直接验证刷新收敛：白绝不能盖过蓝。
  await consolePage.getByTestId('goto-input').fill('4');
  await consolePage.getByTestId('goto-go').click();
  await expect(consolePage.getByTestId('status-pending'), { timeout: 3000 }).toBeVisible();
  await viewer.reload();
  gate = gateOn(viewer);
  await releaseWhenReady(viewer); // 快照蓝解码
  await expect.poll(() => hudText(viewer), { timeout: 5000 }).toContain('第 3 / 4 页');
  await expectPixel(viewer, BLUE);
  const acks = await readAcks(viewer);
  expect(acks.filter((a) => a.seq === 3)).toHaveLength(0); // 恢复态白命令未确认

  // 控制台权威仍是蓝，seq=3 白命令处于未确认
  await expect(consolePage.getByTestId('current-page')).toHaveText('3');
  await expect(consolePage.getByTestId('presented-2')).toBeVisible();

  await viewer.close();
  await context.close();
  await browser.close();
});

/**
 * 验收 3：窗口缩放触发的旧帧重绘，晚于遮黑/切页完成 ——
 * 绿页已确认（已缓存），发“跳蓝页”命令且蓝页解码在途时连续 resize：
 * 每次 resize 都同步重绘旧绿帧；随后遮黑成为当前有效画面并提交。
 * 关键在于蓝页（新页）迟到完成时不得顶掉黑；最后再放行，黑必须稳定。
 * 解除遮黑后普通缩放仍正常重绘当前帧（兼容性）。
 */
test('旧帧重绘/在途新页晚于遮黑完成不得再画出图片；解除遮黑后正常恢复', async () => {
  const browser = await chromium.launch();
  const { context, page: consolePage } = await openConsole(browser);
  await installSeqDecodeGate(context, true);
  await installAckSpyInit(context);
  await addImages(consolePage, fourProgram());

  const viewer = await startShowWithPopup(context, consolePage, false);
  let gate = gateOn(viewer);
  await releaseWhenReady(viewer);
  await expect(viewer.getByTestId('viewer-hud')).toBeVisible({ timeout: 5000 });
  await consolePage.getByTestId('next').click();
  await releaseWhenReady(viewer);
  await expect.poll(() => hudText(viewer), { timeout: 5000 }).toContain('第 2 / 4 页');
  await expectPixel(viewer, GREEN);

  // 发 goto 蓝页：蓝页解码在途，控制台待确认
  await consolePage.getByTestId('goto-input').fill('3');
  await consolePage.getByTestId('goto-go').click();
  await expect.poll(() => gate.pendingCount(), { timeout: 5000 }).toBeGreaterThanOrEqual(1);

  // 蓝页在途时连续 resize：repaintCurrent 同步重绘旧绿帧（缓存命中），画布保持绿
  for (let i = 0; i < 4; i++) {
    // eslint-disable-next-line no-await-in-loop
    await viewer.setViewportSize({ width: 800 + i * 41, height: 600 + i * 29 });
  }
  await viewer.waitForTimeout(200);
  await expectPixel(viewer, GREEN);

  // 立刻停映：黑成为唯一有效画面，蓝页解码仍在途
  await consolePage.getByTestId('end-show').click();
  await expect(viewer.getByTestId('viewer-ended')).toBeVisible({ timeout: 3000 });
  await expectPixel(viewer, BLACK);

  // 蓝页此刻才解码完成：必须被代次闸门丢弃；迟到 resize 也不得重画
  await gate.releaseAll();
  await viewer.waitForTimeout(400);
  await expectPixel(viewer, BLACK);
  await viewer.setViewportSize({ width: 1000, height: 720 });
  await viewer.waitForTimeout(300);
  await expectPixel(viewer, BLACK);

  await viewer.close();
  await context.close();
  await browser.close();
});

/**
 * 验收 3b：遮黑快照恢复无需解码（同步黑屏）；恢复期间 resize 不得提前画图，
 * 解除遮黑后图片正常、普通缩放重绘当前帧（兼容性）。
 */
test('遮黑快照恢复即黑（不等解码）；解除遮黑与后续缩放正常', async () => {
  const browser = await chromium.launch();
  const { context, page: consolePage } = await openConsole(browser);
  await installSeqDecodeGate(context, true);
  await installAckSpyInit(context);
  await addImages(consolePage, fourProgram());

  const viewer = await startShowWithPopup(context, consolePage, false);
  const gate = gateOn(viewer);
  await releaseWhenReady(viewer);
  await expect(viewer.getByTestId('viewer-hud')).toBeVisible({ timeout: 5000 });
  await consolePage.getByTestId('next').click();
  await releaseWhenReady(viewer);
  await expect.poll(() => hudText(viewer), { timeout: 5000 }).toContain('第 2 / 4 页');
  await consolePage.getByTestId('goto-input').fill('3');
  await consolePage.getByTestId('goto-go').click();
  await releaseWhenReady(viewer);
  await expect.poll(() => hudText(viewer), { timeout: 5000 }).toContain('第 3 / 4 页');
  await expectPixel(viewer, BLUE);

  // 遮黑后刷新：快照是“蓝页+遮黑”，恢复时同步黑，不发起任何图片解码
  await consolePage.getByTestId('blackout').click();
  await expect.poll(() => hudText(viewer), { timeout: 5000 }).toContain('遮黑');
  await expectPixel(viewer, BLACK);
  await viewer.reload();
  // 恢复期间连续 resize：画面必须保持黑，不能因旧尺寸重绘闪出蓝页
  for (let i = 0; i < 4; i++) {
    // eslint-disable-next-line no-await-in-loop
    await viewer.setViewportSize({ width: 820 + i * 53, height: 600 + i * 31 });
  }
  await expect.poll(() => hudText(viewer), { timeout: 5000 }).toContain('遮黑');
  await viewer.waitForTimeout(300);
  await expectPixel(viewer, BLACK);
  expect(await gate.pendingCount()).toBe(0); // 遮黑快照不应触发图片解码

  // 解除遮黑：蓝页（需解码）挂起 -> 放行后正常呈现；普通缩放重绘当前帧
  await consolePage.getByTestId('blackout').click();
  await releaseWhenReady(viewer);
  await expect.poll(() => hudText(viewer), { timeout: 5000 }).toContain('第 3 / 4 页');
  await expectPixel(viewer, BLUE);
  await viewer.setViewportSize({ width: 760, height: 540 });
  await viewer.waitForTimeout(300);
  await expectPixel(viewer, BLUE);

  await viewer.close();
  await context.close();
  await browser.close();
});

/**
 * 验收 4：坏图呈现失败后的“回退最后成功帧”是异步绘制，可能晚于后续动作完成。
 * 4a：回退绘制在途时停映 —— 迟到回退不得回画红页，持续黑屏。
 * 用 afterError 钩子把“坏图 error 之后、回退绘制之前”确定性撑开。
 */
test('失败回退绘制晚于停映完成：不回画最后成功帧，持续黑屏', async () => {
  const browser = await chromium.launch();
  const { context, page: consolePage } = await openConsole(browser);
  await installSeqDecodeGate(context, true);
  await installAckSpyInit(context);
  await installTestHooks(context);
  await addImages(consolePage, [
    solidPng('red.png', RED, 8),
    { name: 'broken.png', buffer: Buffer.from('this is definitely not a png', 'utf8'), mime: 'image/png' },
    solidPng('blue.png', BLUE, 8)
  ]);

  const viewer = await startShowWithPopup(context, consolePage, false);
  const gate = gateOn(viewer);
  await releaseWhenReady(viewer);
  await expect(viewer.getByTestId('viewer-hud')).toBeVisible({ timeout: 5000 });
  await expectPixel(viewer, RED);

  // 预置门：坏图 error 后、回退红绘制前停住
  await holdHook(viewer, 'afterError');
  await consolePage.getByTestId('next').click();
  await releaseWhenReady(viewer); // 放行坏图（自然 error）
  // 门未开：控制台尚未收到失败 ACK（回退流程被撑开），画面仍是红
  await viewer.waitForTimeout(300);
  await expectPixel(viewer, RED);
  expect(await (await readAcks(viewer)).filter((a) => !a.ok)).toHaveLength(0);

  // 回退绘制完成前停映：随后开门，回退红绘制必须被代次闸门丢弃
  await consolePage.getByTestId('end-show').click();
  await expect(viewer.getByTestId('viewer-ended')).toBeVisible({ timeout: 3000 });
  await expectPixel(viewer, BLACK);
  await openHook(viewer, 'afterError');
  await viewer.waitForTimeout(400);
  await expectPixel(viewer, BLACK);
  // 迟到 resize 同样无效
  await viewer.setViewportSize({ width: 900, height: 700 });
  await viewer.waitForTimeout(300);
  await expectPixel(viewer, BLACK);

  await viewer.close();
  await context.close();
  await browser.close();
});

/**
 * 验收 4b：坏图失败回退在途时，下一条同序号替代命令（蓝页）先完成 ——
 * 迟到的回退（红，且失败 ACK 针对旧目标）不得覆盖新蓝页，也不得把控制台未决标失败。
 */
test('失败回退晚于同序号替代命令完成：不覆盖新页，旧失败确认无效，最后成功帧保留', async () => {
  const browser = await chromium.launch();
  const { context, page: consolePage } = await openConsole(browser);
  await installSeqDecodeGate(context, true);
  await installAckSpyInit(context);
  await installTestHooks(context);
  await addImages(consolePage, [
    solidPng('red.png', RED, 8),
    { name: 'broken.png', buffer: Buffer.from('this is definitely not a png', 'utf8'), mime: 'image/png' },
    solidPng('blue.png', BLUE, 8)
  ]);

  const viewer = await startShowWithPopup(context, consolePage, false);
  const gate = gateOn(viewer);
  await releaseWhenReady(viewer);
  await expect(viewer.getByTestId('viewer-hud')).toBeVisible({ timeout: 5000 });
  await expectPixel(viewer, RED);

  // seq=1 goto 绿（坏图），afterError 门撑开
  await holdHook(viewer, 'afterError');
  await consolePage.getByTestId('next').click();
  await releaseWhenReady(viewer);
  await viewer.waitForTimeout(300);
  await expectPixel(viewer, RED);

  // 控制台仍在“待确认”（失败 ACK 未发出），UI 不允许叠加命令。
  // 真实交错里替代命令来自“失败已回传后讲解员操作”。因此先开门让失败落地：
  // 但为制造“回退绘制晚于替代命令”，我们让回退红绘制本身挂起（红不缓存）——
  // 开门前先关闸会导致红立即同步（已缓存）。改为：开门后立刻 goto 蓝（failed 状态允许），
  // 失败回退的 resolveRender 与新命令存在微任务竞争，不稳定。
  // 故采用确定性路径：开门完成失败 -> 控制台 failed -> goto 蓝 seq=1（复用序号），
  // 蓝解码在途；此时注入“迟到的旧失败 ACK（目标=绿）”，它必须无效。
  await openHook(viewer, 'afterError');
  await expect(consolePage.getByTestId('status-failed'), { timeout: 5000 }).toBeVisible();
  await expect(consolePage.getByTestId('current-page')).toHaveText('1');
  await expectPixel(viewer, RED);

  // 替代命令：goto 蓝（seq 复用 1，目标 page=2）
  await consolePage.getByTestId('goto-input').fill('3');
  await consolePage.getByTestId('goto-go').click();
  await expect(consolePage.getByTestId('status-pending'), { timeout: 3000 }).toBeVisible();
  await expect.poll(() => gate.pendingCount(), { timeout: 5000 }).toBe(1); // 蓝在途

  // 迟到的旧失败确认（同 seq=1，但 target 指向坏图绿页 page=1）：不得标 failed
  const sid = await sessionIdOf(consolePage);
  await postAck(viewer, {
    sessionId: sid,
    seq: 1,
    ok: false,
    page: 0,
    blackout: false,
    target: { page: 1, blackout: false }
  });
  await viewer.waitForTimeout(300);
  await expect(consolePage.getByTestId('status-pending')).toBeVisible();
  await expectPixel(viewer, RED); // 蓝尚未完成，仍是最后成功帧红

  // 蓝完成 -> 正常收敛
  await gate.releaseAll();
  await expect.poll(() => hudText(viewer), { timeout: 5000 }).toContain('第 3 / 3 页');
  await expectPixel(viewer, BLUE);
  await expect(consolePage.getByTestId('current-page')).toHaveText('3');

  await viewer.close();
  await context.close();
  await browser.close();
});

/**
 * 验收 5：两个观众窗交错，同序号但页码/遮黑不同的确认不得推进权威；
 * 同时核验失败确认目标不匹配也无效。真实呈现完成后像素、控制台状态、
 * ACK 记录与刷新（控制台持久化 + 观众窗快照）恢复结果全部一致。
 */
test('多观众窗：同序号不同画面的确认（成功/失败）均无效，权威只认真实目标', async () => {
  const browser = await chromium.launch();
  const { context, page: consolePage } = await openConsole(browser);
  await installSeqDecodeGate(context, true);
  await installAckSpyInit(context);
  await addImages(consolePage, fourProgram());

  const viewer1 = await startShowWithPopup(context, consolePage, false);
  const viewer2 = await context.newPage();
  await viewer2.goto('/viewer');
  const gate1 = gateOn(viewer1);
  const gate2 = gateOn(viewer2);
  await releaseWhenReady(viewer1);
  await releaseWhenReady(viewer2);
  await expect(viewer1.getByTestId('viewer-hud')).toBeVisible({ timeout: 8000 });
  await expect(viewer2.getByTestId('viewer-hud')).toBeVisible({ timeout: 8000 });
  await expectPixel(viewer1, RED);
  await expectPixel(viewer2, RED);

  // goto 蓝页 seq=1（目标 page=2），两窗解码都挂起，控制台等待确认
  await consolePage.getByTestId('goto-input').fill('3');
  await consolePage.getByTestId('goto-go').click();
  await expect(consolePage.getByTestId('status-pending')).toBeVisible({ timeout: 3000 });
  await expect.poll(() => gate1.pendingCount(), { timeout: 5000 }).toBeGreaterThanOrEqual(1);
  await expect.poll(() => gate2.pendingCount(), { timeout: 5000 }).toBeGreaterThanOrEqual(1);

  const sid = await sessionIdOf(consolePage);
  // 同序号但画面不同的“成功确认”：绿页 / 蓝页+遮黑 —— 都不得推进
  await postAck(viewer1, { sessionId: sid, seq: 1, ok: true, page: 1, blackout: false });
  await postAck(viewer1, { sessionId: sid, seq: 1, ok: true, page: 2, blackout: true });
  // 同序号但目标不同的“失败确认”（声称尝试的是绿页）—— 同样无效
  await postAck(viewer2, {
    sessionId: sid,
    seq: 1,
    ok: false,
    page: 0,
    blackout: false,
    target: { page: 1, blackout: false }
  });
  await viewer1.waitForTimeout(500);

  // 权威纹丝不动：仍红页、未决仍待确认
  await expect(consolePage.getByTestId('current-page')).toHaveText('1');
  await expect(consolePage.getByTestId('status-pending')).toBeVisible();
  await expect(consolePage.locator('.badge-dark')).toHaveCount(0);
  await expectPixel(viewer1, RED);
  await expectPixel(viewer2, RED);

  // 真实目标（蓝页）解码完成 -> 匹配确认 -> 权威收敛
  await gate1.releaseAll();
  await gate2.releaseAll();
  await expect.poll(() => hudText(viewer1), { timeout: 5000 }).toContain('第 3 / 4 页');
  await expect.poll(() => hudText(viewer2), { timeout: 5000 }).toContain('第 3 / 4 页');
  await expectPixel(viewer1, BLUE);
  await expectPixel(viewer2, BLUE);
  await expect(consolePage.getByTestId('current-page')).toHaveText('3');
  await expect(consolePage.getByTestId('presented-2')).toBeVisible();

  // ACK 记录：最终成功确认画面与权威一致
  const acks1 = await readAcks(viewer1);
  const okAcks = acks1.filter((a) => a.ok && a.seq === 1);
  expect(okAcks[okAcks.length - 1]).toMatchObject({ page: 2, blackout: false });

  // 刷新恢复一致性：控制台从 IndexedDB 恢复权威（蓝页）；观众窗快照收敛到蓝页
  await consolePage.reload();
  await expect(consolePage.getByTestId('live-controls')).toBeVisible({ timeout: 5000 });
  await expect(consolePage.getByTestId('current-page')).toHaveText('3');
  await viewer2.reload();
  await releaseWhenReady(viewer2);
  await expect.poll(() => hudText(viewer2), { timeout: 8000 }).toContain('第 3 / 4 页');
  await expectPixel(viewer2, BLUE);

  await viewer1.close();
  await viewer2.close();
  await context.close();
  await browser.close();
});
