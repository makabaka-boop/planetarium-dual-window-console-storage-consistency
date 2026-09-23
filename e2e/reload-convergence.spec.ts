import { chromium, expect, test } from '@playwright/test';
import { addImages, hudText, openConsole, pngImage, startShowWithPopup } from './helpers';

test.describe.configure({ mode: 'serial' });

test.describe('观众窗刷新/重开：权威快照收敛', () => {
  test('刷新观众窗：经历恢复态后回到最后已确认页，不跳回旧星图', async () => {
    const browser = await chromium.launch();
    const { context, page: consolePage } = await openConsole(browser);
    await addImages(consolePage, [
      pngImage('p1.png'),
      pngImage('p2.png'),
      pngImage('p3.png'),
      pngImage('p4.png')
    ]);
    const viewer = await startShowWithPopup(context, consolePage);

    // 走到第 3 页
    await consolePage.getByTestId('goto-input').fill('3');
    await consolePage.getByTestId('goto-go').click();
    await expect.poll(() => hudText(viewer), { timeout: 5000 }).toContain('第 3 / 4 页');
    await expect(consolePage.getByTestId('current-page')).toHaveText('3');

    // 遮黑后刷新：快照必须带回完整画面（页 + 遮黑状态）
    await consolePage.getByTestId('blackout').click();
    await expect.poll(() => hudText(viewer), { timeout: 5000 }).toContain('遮黑');

    await viewer.reload();
    // 恢复期间可见提示
    await expect(viewer.getByTestId('viewer-recovering')).toBeVisible({ timeout: 3000 });
    // 恢复后：仍是第 3 页且仍遮黑，而不是跳回第 1 页
    await expect
      .poll(() => hudText(viewer), { timeout: 10_000 })
      .toMatch(/遮黑/);
    await expect(consolePage.getByTestId('current-page')).toHaveText('3');

    // 解除遮黑，画面回到第 3 页，证明 seq 之后命令链路仍连续
    await consolePage.getByTestId('blackout').click();
    await expect.poll(() => hudText(viewer), { timeout: 5000 }).toContain('第 3 / 4 页');

    // 刷新期间控制台的已呈现标记与穹顶实际画面收敛到同一权威
    await expect(consolePage.getByTestId('presented-2')).toBeVisible();

    await viewer.close();
    await context.close();
    await browser.close();
  });

  test('关闭后重开观众窗：新窗口主动取快照，与控制台权威标记一致', async () => {
    const browser = await chromium.launch();
    const { context, page: consolePage } = await openConsole(browser);
    await addImages(consolePage, [pngImage('a.png'), pngImage('b.png'), pngImage('c.png')]);
    let viewer = await startShowWithPopup(context, consolePage);

    await consolePage.getByTestId('next').click();
    await expect.poll(() => hudText(viewer), { timeout: 5000 }).toContain('第 2 / 3 页');
    await consolePage.getByTestId('next').click();
    await expect.poll(() => hudText(viewer), { timeout: 5000 }).toContain('第 3 / 3 页');

    // 关闭旧观众窗（模拟迟到/丢失），再以新标签打开 /viewer。
    // 新窗口刷新式启动后主动向控制台请求最后已确认快照。
    await viewer.close();
    const newViewer = await context.newPage();
    await newViewer.goto('/viewer');
    viewer = newViewer;

    // 恢复态可能转瞬即逝；直接验证最终收敛到最后已确认的第 3 页，而不是第 1 页
    await expect(viewer.getByTestId('viewer-hud')).toBeVisible({ timeout: 10_000 });
    expect(await hudText(viewer)).toContain('第 3 / 3 页');
    await expect(consolePage.getByTestId('presented-2')).toBeVisible();
    await expect(consolePage.getByTestId('current-page')).toHaveText('3');

    // 收敛后新窗口继续接受后续命令
    await consolePage.getByTestId('prev').click();
    await expect.poll(() => hudText(viewer), { timeout: 5000 }).toContain('第 2 / 3 页');
    await expect(consolePage.getByTestId('current-page')).toHaveText('2');

    await viewer.close();
    await context.close();
    await browser.close();
  });

  test('控制台自身刷新：会话从 IndexedDB 恢复，观众窗不回退', async () => {
    const browser = await chromium.launch();
    const { context, page: consolePage } = await openConsole(browser);
    await addImages(consolePage, [pngImage('a.png'), pngImage('b.png')]);
    const viewer = await startShowWithPopup(context, consolePage);

    await consolePage.getByTestId('next').click();
    await expect.poll(() => hudText(viewer), { timeout: 5000 }).toContain('第 2 / 2 页');

    await consolePage.reload();
    await expect(consolePage.getByTestId('live-controls')).toBeVisible({ timeout: 5000 });
    await expect(consolePage.getByTestId('current-page')).toHaveText('2');
    await expect(consolePage.getByTestId('presented-1')).toBeVisible();
    // 观众窗画面保持
    expect(await hudText(viewer)).toContain('第 2 / 2 页');

    await viewer.close();
    await context.close();
    await browser.close();
  });
});
