import { chromium, expect, test } from '@playwright/test';
import { addImages, hudText, openConsole, pngImage, startShowWithPopup } from './helpers';

test.describe.configure({ mode: 'serial' });

test.describe('多窗口放映：翻页、跳页、遮黑与权威收敛', () => {
  test('开始放映后上下页/跳页/遮黑，控制台标记与穹顶画面一致', async () => {
    const browser = await chromium.launch();
    const { context, page: consolePage } = await openConsole(browser);

    await addImages(consolePage, [pngImage('a.png'), pngImage('b.png'), pngImage('c.png')]);

    const viewer = await startShowWithPopup(context, consolePage);

    // 初始：第 1/3 页
    expect(await hudText(viewer)).toContain('第 1 / 3 页');
    await expect(consolePage.getByTestId('presented-0')).toBeVisible();
    await expect(consolePage.getByTestId('current-page')).toHaveText('1');

    // 下一页
    await consolePage.getByTestId('next').click();
    await expect
      .poll(() => hudText(viewer), { timeout: 5000 })
      .toContain('第 2 / 3 页');
    await expect(consolePage.getByTestId('presented-1')).toBeVisible();
    await expect(consolePage.getByTestId('presented-0')).toHaveCount(0);
    await expect(consolePage.getByTestId('current-page')).toHaveText('2');

    // 上一页
    await consolePage.getByTestId('prev').click();
    await expect.poll(() => hudText(viewer), { timeout: 5000 }).toContain('第 1 / 3 页');
    await expect(consolePage.getByTestId('current-page')).toHaveText('1');

    // 跳页到第 3 页
    await consolePage.getByTestId('goto-input').fill('3');
    await consolePage.getByTestId('goto-go').click();
    await expect.poll(() => hudText(viewer), { timeout: 5000 }).toContain('第 3 / 3 页');
    await expect(consolePage.getByTestId('presented-2')).toBeVisible();

    // 遮黑：HUD 显示“遮黑”，控制台出现遮黑徽章；解除后恢复同一页
    await consolePage.getByTestId('blackout').click();
    await expect.poll(() => hudText(viewer), { timeout: 5000 }).toContain('遮黑');
    await expect(consolePage.locator('.badge-dark')).toBeVisible();

    await consolePage.getByTestId('blackout').click();
    await expect.poll(() => hudText(viewer), { timeout: 5000 }).toContain('第 3 / 3 页');

    await viewer.close();
    await context.close();
    await browser.close();
  });

  test('等待确认期间控制台显示“待确认”，不误报已呈现', async () => {
    const browser = await chromium.launch();
    const { context, page: consolePage } = await openConsole(browser);
    await addImages(consolePage, [pngImage('a.png'), pngImage('b.png')]);
    const viewer = await startShowWithPopup(context, consolePage);

    await consolePage.getByTestId('next').click();
    // 收敛前绝不能已经把第 2 页标成“已呈现”（权威标记只随确认前进）
    await expect(consolePage.getByTestId('presented-1')).toHaveCount(0);
    await expect
      .poll(() => hudText(viewer), { timeout: 5000 })
      .toContain('第 2 / 2 页');
    await expect(consolePage.getByTestId('presented-1')).toBeVisible();

    await viewer.close();
    await context.close();
    await browser.close();
  });
});
