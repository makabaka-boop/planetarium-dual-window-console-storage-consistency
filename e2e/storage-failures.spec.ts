import { chromium, expect, test } from '@playwright/test';
import {
  addImages,
  armDbFault,
  dbFaultStatus,
  disarmDbFaults,
  hudText,
  installDbFaultsInit,
  openConsole,
  pngImage,
  readPersistedState,
  solidPng,
  startShowWithPopup,
  storageErrorOp
} from './helpers';

test.describe.configure({ mode: 'serial' });

/**
 * 存储失败权威状态验收：
 * 在各“提交边界”强制拒绝/中止 IndexedDB 事务（含“单请求成功后事务中止”），
 * 随后刷新控制台与观众窗，核对画面、会话、待确认状态与磁盘持久记录完全一致：
 *  - 未持久化的会话/命令绝不被宣布成功；
 *  - 确认落库失败时页面不显示已确认，磁盘保留未确认命令；
 *  - 停映清理失败时旧会话不复活为“已结束”，刷新恢复原运行会话；
 *  - 失败期间最后可恢复记录不被覆盖；
 *  - 修复存储后用户可重试收敛；正常存储/弹窗受阻恢复/节目单格式保持兼容。
 */
test.describe('存储失败：确定的权威状态与可重试', () => {
  test('开始放映：冻结节目单写入成功但事务随后中止 —— 不进入运行态，旧记录不被覆盖，重试可收敛', async () => {
    const browser = await chromium.launch();
    const { context, page: consolePage } = await openConsole(browser);
    await installDbFaultsInit(context);
    await consolePage.reload(); // 让 init 脚本生效
    await addImages(consolePage, [pngImage('a.png'), pngImage('b.png')]);

    // 制造“磁盘上最后可恢复记录”：先正常开始并停映一场（留下冻结节目单）。
    await consolePage.getByTestId('start-show').click();
    await expect(consolePage.getByTestId('live-controls')).toBeVisible();
    await consolePage.getByTestId('end-show').click();
    await expect(consolePage.getByTestId('start-show')).toBeVisible();

    // 故障：开始放映事务中首个冻结请求成功后、commit 前中止 ——
    // 精确复现“冻结已成功、保存会话失败”，整事务回滚。
    await armDbFault(consolePage, { reason: 'startShow', phase: 'afterRequest', once: true });
    await consolePage.getByTestId('start-show').click();

    await expect(consolePage.getByTestId('storage-error')).toBeVisible({ timeout: 5000 });
    expect(await storageErrorOp(consolePage)).toBe('startShow');
    // 未持久化的会话绝不被宣布：控制台仍是编辑模式，没有运行徽章。
    await expect(consolePage.getByTestId('start-show')).toBeVisible();
    await expect(consolePage.getByTestId('live-controls')).toHaveCount(0);

    // 磁盘：无 current 会话（旧的已停映删除记录未被新会话覆盖）；
    // 冻结节目单事务已整体回滚，last 记录数量仍属于旧场（2 页，内容不变即可）。
    const afterFail = await readPersistedState(consolePage);
    expect(afterFail.hasSession).toBe(false);
    expect(afterFail.running).toBeNull();

    // 刷新控制台：仍是编辑模式，绝不复活出一个“运行中”的幽灵会话。
    await consolePage.reload();
    await expect(consolePage.getByTestId('start-show')).toBeVisible();
    await expect(consolePage.getByTestId('live-controls')).toHaveCount(0);

    // 修复存储（一次性故障已耗尽）后重试：正常开始并打开观众窗。
    let popupPage = context.pages().find((p) => p.url().includes('/viewer')) ?? null;
    const popupRetry = popupPage
      ? Promise.resolve(null)
      : context.waitForEvent('page').catch(() => null);
    await consolePage.getByTestId('start-show').click();
    await expect(consolePage.getByTestId('live-controls')).toBeVisible({ timeout: 5000 });
    await expect(consolePage.getByTestId('current-page')).toHaveText('1');
    popupPage = (await popupRetry) ?? popupPage;
    if (popupPage) {
      await popupPage.waitForLoadState('load');
      await expect(popupPage.getByTestId('viewer-hud')).toBeVisible({ timeout: 10_000 });
    }
    const disk = await readPersistedState(consolePage);
    expect(disk.hasSession).toBe(true);
    expect(disk.running).toBe(true);
    expect(disk.confirmed).toEqual({ seq: 0, page: 0, blackout: false });

    await context.close();
    await browser.close();
  });

  test('开始放映：事务在写入前被拒 —— 保持编辑模式，弹窗未打开；释放后重试成功', async () => {
    const browser = await chromium.launch();
    const { context, page: consolePage } = await openConsole(browser);
    await installDbFaultsInit(context);
    await consolePage.reload();
    await addImages(consolePage, [pngImage('a.png')]);

    const pagesBefore = context.pages().length;
    await armDbFault(consolePage, { reason: 'startShow', phase: 'before', once: true });
    await consolePage.getByTestId('start-show').click();

    await expect(consolePage.getByTestId('storage-error')).toBeVisible({ timeout: 5000 });
    await expect(consolePage.getByTestId('start-show')).toBeVisible();
    // 会话未持久化前不得打开观众窗（否则会出现“穹顶在演、控制台无会话”的矛盾）。
    expect(context.pages().length).toBe(pagesBefore);
    expect((await readPersistedState(consolePage)).hasSession).toBe(false);

    // 重试（模拟用户清出配额后点击横幅按钮）。
    const retryPopup = context.waitForEvent('page').catch(() => null);
    await consolePage.getByTestId('storage-retry').click();
    await expect(consolePage.getByTestId('live-controls')).toBeVisible({ timeout: 5000 });
    const viewer = (await retryPopup) ?? context.pages().find((p) => p.url().includes('/viewer'));
    expect(viewer).toBeTruthy();
    if (viewer) {
      await viewer.waitForLoadState('load');
      await expect(viewer.getByTestId('viewer-hud')).toBeVisible({ timeout: 10_000 });
      expect(await hudText(viewer)).toContain('第 1 / 1 页');
    }

    await context.close();
    await browser.close();
  });

  test('切页：命令事务在提交前中止（请求成功假象）—— 命令未发出、UI 不标待确认；刷新不回跳错误页', async () => {
    const browser = await chromium.launch();
    const { context, page: consolePage } = await openConsole(browser);
    await installDbFaultsInit(context);
    await consolePage.reload();
    await addImages(consolePage, [pngImage('p1.png'), pngImage('p2.png'), pngImage('p3.png')]);
    const viewer = await startShowWithPopup(context, consolePage);
    expect(await hudText(viewer)).toContain('第 1 / 3 页');

    // 故障落在“保存会话（切页命令）”这一提交边界，且在请求成功后中止。
    await armDbFault(consolePage, { reason: 'saveSession', phase: 'afterRequest', once: true });
    await consolePage.getByTestId('next').click();

    await expect(consolePage.getByTestId('storage-error')).toBeVisible({ timeout: 5000 });
    expect(await storageErrorOp(consolePage)).toBe('command');
    // 未持久化的命令不被宣布：无待确认标记、权威仍第 1 页、按钮仍可操作。
    await expect(consolePage.getByTestId('status-pending')).toHaveCount(0);
    await expect(consolePage.getByTestId('current-page')).toHaveText('1');
    // 命令未发往观众窗：穹顶仍是第 1 页。
    await viewer.waitForTimeout(600);
    expect(await hudText(viewer)).toContain('第 1 / 3 页');

    // 磁盘：没有未决命令，权威仍是 seq=0 首页（失败期间最后可恢复记录未被覆盖）。
    const disk = await readPersistedState(consolePage);
    expect(disk.pending).toBeNull();
    expect(disk.confirmed).toEqual({ seq: 0, page: 0, blackout: false });

    // 刷新控制台与观众窗：二者都收敛到磁盘权威（第 1 页），绝不出现
    // “穹顶新页 / 控制台旧页”的分裂。刷新前解除故障注入（模拟存储已恢复）。
    await disarmDbFaults(consolePage);
    await consolePage.reload();
    await viewer.reload();
    await expect(consolePage.getByTestId('live-controls')).toBeVisible({ timeout: 5000 });
    await expect(consolePage.getByTestId('current-page')).toHaveText('1');
    await expect.poll(() => hudText(viewer), { timeout: 10_000 }).toContain('第 1 / 3 页');
    // 刷新后横幅（原内存错误）已被磁盘权威取代，但“未持久化操作”的可重试入口仍在。
    await expect(consolePage.getByTestId('unsynced-banner')).toBeVisible();

    // 重试（存储已恢复）：命令正常发出并收敛。
    await consolePage.getByTestId('unsynced-retry').click();
    await expect.poll(() => hudText(viewer), { timeout: 5000 }).toContain('第 2 / 3 页');
    await expect(consolePage.getByTestId('current-page')).toHaveText('2');

    await context.close();
    await browser.close();
  });

  test('确认消息到达但持久化失败：页面不显示已确认，磁盘保留未确认命令；重试沿用原序号收敛', async () => {
    const browser = await chromium.launch();
    const { context, page: consolePage } = await openConsole(browser);
    await installDbFaultsInit(context);
    await consolePage.reload();
    await addImages(consolePage, [pngImage('p1.png'), pngImage('p2.png')]);
    const viewer = await startShowWithPopup(context, consolePage);

    // 先发一条健康命令：观众窗呈现第 2 页并 ACK，控制台权威推进（seq=1）。
    await consolePage.getByTestId('next').click();
    await expect.poll(() => hudText(viewer), { timeout: 5000 }).toContain('第 2 / 2 页');
    await expect(consolePage.getByTestId('current-page')).toHaveText('2');

    // 回到第 1 页也健康，随后故障武装在“下一条 ACK 落库”（saveSession）边界。
    await consolePage.getByTestId('prev').click();
    await expect(consolePage.getByTestId('current-page')).toHaveText('1');
    // 武装在 saveSession 边界：跳过下一次匹配（命令自身的落库必须成功，
    // 观众窗才会呈现并 ACK），命中再下一次（ACK 到达后的权威推进落库）。
    await armDbFault(consolePage, {
      reason: 'saveSession',
      phase: 'before',
      once: true,
      skip: 1
    });

    await consolePage.getByTestId('next').click();
    // 观众窗已呈现第 2 页（画面可能已前进）……
    await expect.poll(() => hudText(viewer), { timeout: 5000 }).toContain('第 2 / 2 页');
    // ……但控制台持久化失败：不得标记“已呈现”，显示存储错误。
    await expect(consolePage.getByTestId('storage-error')).toBeVisible({ timeout: 5000 });
    expect(await storageErrorOp(consolePage)).toBe('ack');
    await expect(consolePage.getByTestId('presented-1')).toHaveCount(0);

    // 磁盘保留未确认命令（seq=3，目标第 2 页），权威仍是第 1 页。
    const disk = await readPersistedState(consolePage);
    expect(disk.confirmed).toMatchObject({ page: 0 });
    expect(disk.pending).not.toBeNull();
    expect(disk.pending?.target).toEqual({ page: 1, blackout: false });

    // 刷新控制台：恢复成“未确认”（不是已确认）；观众窗刷新按磁盘权威回到第 1 页。
    // 同时“未持久化确认”的可重试入口仍保留（sessionStorage，不进入权威记录）。
    await disarmDbFaults(consolePage);
    await consolePage.reload();
    await viewer.reload();
    await expect(consolePage.getByTestId('status-unconfirmed')).toBeVisible({ timeout: 8000 });
    await expect(consolePage.getByTestId('current-page')).toHaveText('1');
    await expect.poll(() => hudText(viewer), { timeout: 10_000 }).toContain('第 1 / 2 页');
    await expect(consolePage.getByTestId('unsynced-banner')).toBeVisible();

    // 重试：以未同步操作重发（观众窗此前已呈现则按同序号重放 ACK），
    // 画面与权威重新收敛到第 2 页并持久化。
    await consolePage.getByTestId('unsynced-retry').click();
    await expect.poll(() => hudText(viewer), { timeout: 5000 }).toContain('第 2 / 2 页');
    await expect(consolePage.getByTestId('current-page')).toHaveText('2');
    const disk2 = await readPersistedState(consolePage);
    expect(disk2.confirmed).toMatchObject({ seq: disk.pending!.seq, page: 1 });
    expect(disk2.pending).toBeNull();

    await context.close();
    await browser.close();
  });

  test('停映：清理事务最终中止 —— 不宣布结束、不发 SESSION_ENDED，刷新恢复同一场运行会话；重试停映成功', async () => {
    const browser = await chromium.launch();
    const { context, page: consolePage } = await openConsole(browser);
    await installDbFaultsInit(context);
    await consolePage.reload();
    await addImages(consolePage, [pngImage('p1.png'), pngImage('p2.png')]);
    const viewer = await startShowWithPopup(context, consolePage);
    const sessionId = (await consolePage.getByTestId('session-id').innerText()).trim();

    await consolePage.getByTestId('next').click();
    await expect.poll(() => hudText(viewer), { timeout: 5000 }).toContain('第 2 / 2 页');
    const diskBefore = await readPersistedState(consolePage);
    expect(diskBefore.running).toBe(true);

    // 故障：停映删除事务在请求成功后中止（删除未生效）。
    await armDbFault(consolePage, { reason: 'endShow', phase: 'afterRequest', once: true });
    await consolePage.getByTestId('end-show').click();

    await expect(consolePage.getByTestId('storage-error')).toBeVisible({ timeout: 5000 });
    expect(await storageErrorOp(consolePage)).toBe('endShow');
    // 控制台仍在运行（不宣布结束）……
    await expect(consolePage.getByTestId('live-controls')).toBeVisible();
    // ……观众窗没有收到 SESSION_ENDED，仍是第 2 页画面（不会黑屏“假结束”）。
    await viewer.waitForTimeout(500);
    expect(await hudText(viewer)).toContain('第 2 / 2 页');
    await expect(viewer.getByTestId('viewer-ended')).toHaveCount(0);
    // 磁盘会话仍是运行中（已结束会话绝不复活，运行会话也绝不假死）。
    const diskAfter = await readPersistedState(consolePage);
    expect(diskAfter.hasSession).toBe(true);
    expect(diskAfter.running).toBe(true);
    expect(diskAfter.sessionId).toBe(sessionId);
    expect(diskAfter.confirmed).toMatchObject({ page: 1 });

    // 刷新控制台与观众窗：恢复同一场运行会话与第 2 页，而非编辑模式或黑屏。
    // （横幅是当次内存提示；刷新后磁盘会话仍是运行中，讲解员可正常再次结束。）
    await consolePage.reload();
    await expect(consolePage.getByTestId('live-controls')).toBeVisible({ timeout: 5000 });
    await expect(consolePage.getByTestId('current-page')).toHaveText('2');
    await viewer.reload();
    await expect.poll(() => hudText(viewer), { timeout: 10_000 }).toContain('第 2 / 2 页');

    // 再次停映（存储已恢复）：删除落库成功，控制台回到编辑模式、观众窗收到结束黑屏。
    await consolePage.getByTestId('end-show').click();
    await expect(consolePage.getByTestId('start-show')).toBeVisible({ timeout: 5000 });
    await expect(viewer.getByTestId('viewer-ended')).toBeVisible({ timeout: 5000 });
    expect((await readPersistedState(consolePage)).hasSession).toBe(false);

    // 再次刷新：已结束会话绝不复活。
    await consolePage.reload();
    await viewer.reload();
    await expect(consolePage.getByTestId('start-show')).toBeVisible();
    await viewer.waitForTimeout(1200);
    expect(await hudText(viewer)).toBe(''); // 待命/结束覆盖，不出现运行 HUD

    await context.close();
    await browser.close();
  });

  test('导入图片：Blob 请求成功但事务中止 —— Blob 与草稿同时回滚，节目单不出现半份导入', async () => {
    const browser = await chromium.launch();
    const { context, page: consolePage } = await openConsole(browser);
    await installDbFaultsInit(context);
    await consolePage.reload();
    await addImages(consolePage, [pngImage('first.png')]);
    expect((await readPersistedState(consolePage)).draftCount).toBe(1);

    await armDbFault(consolePage, { reason: 'addFiles', phase: 'afterRequest', once: true });
    // 直接通过 input 导入，走控制器 addFiles 的原子事务（helpers.addImages 会等行数）。
    await consolePage
      .locator('input[type=file]')
      .first()
      .setInputFiles([{ name: 'second.png', mimeType: 'image/png', buffer: solidPng('second.png', [30, 200, 40]).buffer }]);

    await expect(consolePage.getByTestId('storage-error')).toBeVisible({ timeout: 5000 });
    expect(await storageErrorOp(consolePage)).toBe('addFiles');
    // 内存节目单不增加（落库失败不宣布导入成功）。
    await expect(consolePage.getByTestId('slide-list').locator('li')).toHaveCount(1);

    // 磁盘：草稿仍 1 项；第二个 Blob 随事务回滚，不存在残留。
    const disk = await readPersistedState(consolePage);
    expect(disk.draftCount).toBe(1);
    expect(disk.blobCount).toBe(1);

    // 刷新后节目单仍是 1 项（无幽灵图片）。
    await consolePage.reload();
    await expect(consolePage.getByTestId('slide-list').locator('li')).toHaveCount(1);

    await context.close();
    await browser.close();
  });

  test('草稿编辑（删除项）写入失败：节目单保留磁盘版本，刷新后不丢失该项', async () => {
    const browser = await chromium.launch();
    const { context, page: consolePage } = await openConsole(browser);
    await installDbFaultsInit(context);
    await consolePage.reload();
    await addImages(consolePage, [pngImage('a.png'), pngImage('b.png')]);

    await armDbFault(consolePage, { reason: 'saveDraft', phase: 'before', once: true });
    await consolePage.getByTestId('slide-list').locator('li').nth(1).locator('.btn-danger-mini').click();

    await expect(consolePage.getByTestId('storage-error')).toBeVisible({ timeout: 5000 });
    expect(await storageErrorOp(consolePage)).toBe('draft');
    // 内存不宣布删除：仍是两行。
    await expect(consolePage.getByTestId('slide-list').locator('li')).toHaveCount(2);
    expect((await readPersistedState(consolePage)).draftCount).toBe(2);

    // 刷新：磁盘草稿恢复，两项都在。
    await disarmDbFaults(consolePage);
    await consolePage.reload();
    await expect(consolePage.getByTestId('slide-list').locator('li')).toHaveCount(2);

    await context.close();
    await browser.close();
  });

  test('数据库打开失败（权限收回）：控制台给出可重试状态，恢复后重试继续放映且观众窗收敛', async () => {
    const browser = await chromium.launch();
    const { context, page: consolePage } = await openConsole(browser);
    await installDbFaultsInit(context);
    // 标记“下一次页面加载时 open 失败一次”：init 脚本在应用代码前读取该标记。
    await context.addInitScript(() => {
      const W = window as unknown as {
        __domeDbFaults?: { armOpen: (r: { fail: boolean; once?: boolean }) => void };
      };
      if (W.__domeDbFaults && sessionStorage.getItem('arm-open-fail-once') === '1') {
        sessionStorage.removeItem('arm-open-fail-once');
        W.__domeDbFaults.armOpen({ fail: true, once: true });
      }
    });
    await consolePage.evaluate(() => sessionStorage.setItem('arm-open-fail-once', '1'));
    await consolePage.reload();

    await expect(consolePage.getByTestId('storage-error')).toBeVisible({ timeout: 5000 });
    expect(await storageErrorOp(consolePage)).toBe('init');
    const before = await dbFaultStatus(consolePage);
    expect(before.failureCount).toBeGreaterThan(0);

    // 一次性 open 故障已解除：点重试初始化，随后正常开始放映并打开观众窗。
    await consolePage.getByTestId('storage-retry').click();
    await addImages(consolePage, [pngImage('a.png'), pngImage('b.png')]);
    const viewerPromise = context.waitForEvent('page');
    await consolePage.getByTestId('start-show').click();
    const viewer = await viewerPromise;
    await viewer.waitForLoadState('load');
    await expect(viewer.getByTestId('viewer-hud')).toBeVisible({ timeout: 10_000 });
    expect(await hudText(viewer)).toContain('第 1 / 2 页');

    await context.close();
    await browser.close();
  });

  test('兼容性：存储健康时全流程无横幅；POPUP_BLOCKED 恢复路径与节目单/消息协议不受影响', async () => {
    const browser = await chromium.launch();
    const { context, page: consolePage } = await openConsole(browser);
    await installDbFaultsInit(context);
    await consolePage.reload();
    // 武装一条永不应命中的规则：正常流程必须零失败。
    await armDbFault(consolePage, { reason: 'never-matches-*', phase: 'before', once: false });
    await addImages(consolePage, [solidPng('a.png', [200, 30, 30]), pngImage('b.png')]);

    await context.addInitScript(() => {
      Object.defineProperty(window, 'open', {
        configurable: true,
        writable: true,
        value: () => null
      });
    });
    await consolePage.reload();
    await consolePage.getByTestId('start-show').click();
    await expect(consolePage.getByTestId('popup-blocked')).toBeVisible({ timeout: 5000 });
    await expect(consolePage.getByTestId('storage-error')).toHaveCount(0);

    // 手动打开观众窗：快照恢复路径不变。
    const viewer = await context.newPage();
    await viewer.goto('/viewer');
    await expect(viewer.getByTestId('viewer-hud')).toBeVisible({ timeout: 10_000 });
    expect(await hudText(viewer)).toContain('第 1 / 2 页');

    await consolePage.getByTestId('next').click();
    await expect.poll(() => hudText(viewer), { timeout: 5000 }).toContain('第 2 / 2 页');
    await expect(consolePage.getByTestId('storage-error')).toHaveCount(0);
    // 故障计数保持 0：正常存储路径没有被误伤。
    expect((await dbFaultStatus(consolePage)).failureCount).toBe(0);

    await viewer.close();
    await context.close();
    await browser.close();
  });
});
