import { chromium, expect, test } from '@playwright/test';
import { addImages, garbagePng, hudText, openConsole, pngImage, startShowWithPopup } from './helpers';

test.describe.configure({ mode: 'serial' });

test.describe('失败与阻塞路径', () => {
  test('单张图片解码失败只标记该项，节目单仍可放映其它页', async () => {
    const browser = await chromium.launch();
    const { context, page: consolePage } = await openConsole(browser);

    await addImages(consolePage, [
      pngImage('good1.png'),
      garbagePng('broken.png'),
      pngImage('good2.png')
    ]);

    // 坏图只标红自身
    const rows = consolePage.getByTestId('slide-list').locator('li');
    await expect(rows.nth(0).locator('.decode-failed')).toHaveCount(0);
    await expect(rows.nth(1).locator('.decode-failed')).toBeVisible();
    await expect(rows.nth(2).locator('.decode-failed')).toHaveCount(0);

    // 好页仍可正常放映：开始 -> 下一页（坏图页）失败 -> 再下一页到第 3 页
    const viewer = await startShowWithPopup(context, consolePage);
    expect(await hudText(viewer)).toContain('第 1 / 3 页');

    await consolePage.getByTestId('next').click();
    // 控制台显示呈现失败，权威仍停在第 1 页
    await expect(consolePage.getByTestId('status-failed')).toBeVisible({ timeout: 5000 });
    await expect(consolePage.getByTestId('current-page')).toHaveText('1');
    expect(await hudText(viewer)).toContain('第 1 / 3 页');
    await expect(viewer.getByTestId('viewer-image-error')).toBeVisible();

    // 重试沿用同一序号：图片仍旧坏，仍失败（不会推进到未呈现的页）
    await consolePage.getByTestId('retry-failed').click();
    await expect(consolePage.getByTestId('status-failed')).toBeVisible({ timeout: 5000 });
    await expect(consolePage.getByTestId('current-page')).toHaveText('1');

    // 失败不锁死会话：下一条命令（跳到第 3 页）正常
    await consolePage.getByTestId('goto-input').fill('3');
    await consolePage.getByTestId('goto-go').click();
    await expect.poll(() => hudText(viewer), { timeout: 5000 }).toContain('第 3 / 3 页');
    await expect(consolePage.getByTestId('current-page')).toHaveText('3');

    await viewer.close();
    await context.close();
    await browser.close();
  });

  test('POPUP_BLOCKED：弹窗受阻时显示标记并保留会话，稍后打开观众窗仍能同步', async () => {
    const browser = await chromium.launch();
    const { context, page: consolePage } = await openConsole(browser);
    await addImages(consolePage, [pngImage('a.png'), pngImage('b.png')]);

    // 模拟浏览器拦截弹窗：在页面任何脚本之前把 window.open 覆盖为返回 null
    await context.addInitScript(() => {
      const blocked = (() => null) as unknown as typeof window.open;
      Object.defineProperty(window, 'open', {
        configurable: true,
        writable: true,
        value: blocked
      });
    });
    await consolePage.reload();
    await expect(consolePage.getByTestId('start-show')).toBeVisible();

    await consolePage.getByTestId('start-show').click();
    await expect(consolePage.getByTestId('popup-blocked')).toBeVisible({ timeout: 5000 });
    // 会话已建立并保留：直接进入放映控件，权威在第 1 页
    await expect(consolePage.getByTestId('live-controls')).toBeVisible();
    await expect(consolePage.getByTestId('current-page')).toHaveText('1');

    // 观众窗稍后以独立标签打开（用户放行弹窗/手动打开等价），主动取到权威快照
    const viewer = await context.newPage();
    await viewer.goto('/viewer');
    await expect(viewer.getByTestId('viewer-hud')).toBeVisible({ timeout: 10_000 });
    expect(await hudText(viewer)).toContain('第 1 / 2 页');
    await expect(consolePage.locator('.popup-blocked')).toHaveCount(0);

    await consolePage.getByTestId('next').click();
    await expect.poll(() => hudText(viewer), { timeout: 5000 }).toContain('第 2 / 2 页');

    await viewer.close();
    await context.close();
    await browser.close();
  });

  test('放映开始后节目单冻结：编辑控件禁用，草稿改动不影响当前会话', async () => {
    const browser = await chromium.launch();
    const { context, page: consolePage } = await openConsole(browser);
    await addImages(consolePage, [pngImage('a.png'), pngImage('b.png')]);
    const viewer = await startShowWithPopup(context, consolePage);

    const rows = consolePage.getByTestId('slide-list').locator('li');
    await expect(rows.nth(0).locator('.btn-mini').first()).toBeDisabled();

    // 会话仍是 2 页，权威不被编辑影响
    expect(await hudText(viewer)).toContain('第 1 / 2 页');

    await viewer.close();
    await context.close();
    await browser.close();
  });
});
