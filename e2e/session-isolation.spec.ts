import { chromium, expect, test } from '@playwright/test';
import { addImages, hudText, openConsole, pngImage, startShowWithPopup } from './helpers';

test.describe.configure({ mode: 'serial' });

/**
 * 会话隔离：观众窗只接受当前会话的命令与快照。
 * 通过“结束会话 -> 开始新会话”验证旧会话的 SESSION_ENDED / 命令不会影响新会话，
 * 且协议层对 sessionId 不符的消息一律丢弃（该点亦由 Vitest 覆盖）。
 */
test.describe('会话边界', () => {
  test('旧会话结束后的新会话不受历史命令影响，权威从第一页重新开始', async () => {
    const browser = await chromium.launch();
    const { context, page: consolePage } = await openConsole(browser);
    await addImages(consolePage, [pngImage('a.png'), pngImage('b.png'), pngImage('c.png')]);
    let viewer = await startShowWithPopup(context, consolePage);

    await consolePage.getByTestId('goto-input').fill('3');
    await consolePage.getByTestId('goto-go').click();
    await expect.poll(() => hudText(viewer), { timeout: 5000 }).toContain('第 3 / 3 页');
    const oldSession = (await consolePage.getByTestId('session-id').innerText()).trim();

    await consolePage.getByTestId('end-show').click();
    await expect(viewer.getByTestId('viewer-ended')).toBeVisible({ timeout: 5000 });
    await viewer.close();

    // 新会话（同一控制台、同一 IndexedDB 草稿）
    viewer = await startShowWithPopup(context, consolePage);
    const newSession = (await consolePage.getByTestId('session-id').innerText()).trim();
    expect(newSession).not.toBe(oldSession);

    // 必须从第 1 页起步，绝不能残留旧会话的第 3 页
    expect(await hudText(viewer)).toContain('第 1 / 3 页');
    await expect(consolePage.getByTestId('current-page')).toHaveText('1');
    await expect(consolePage.getByTestId('presented-0')).toBeVisible();

    await consolePage.getByTestId('next').click();
    await expect.poll(() => hudText(viewer), { timeout: 5000 }).toContain('第 2 / 3 页');

    await viewer.close();
    await context.close();
    await browser.close();
  });

  test('外部注入伪造的其它会话命令不会改动穹顶画面', async () => {
    const browser = await chromium.launch();
    const { context, page: consolePage } = await openConsole(browser);
    await addImages(consolePage, [pngImage('a.png'), pngImage('b.png')]);
    const viewer = await startShowWithPopup(context, consolePage);
    expect(await hudText(viewer)).toContain('第 1 / 2 页');

    // 从观众窗内部向通道注入“别的会话”的跳转命令：必须被忽略
    const injected = await viewer.evaluate(() => {
      const ch = new BroadcastChannel('dome-presenter-v1');
      ch.postMessage({
        kind: 'CMD',
        sessionId: 'totally-other-session',
        seq: 99,
        action: { type: 'goto', page: 1 },
        page: 1,
        blackout: false
      });
      ch.close();
      return true;
    });
    expect(injected).toBe(true);
    // 等待超过一个确认周期，画面仍是第 1 页
    await viewer.waitForTimeout(1800);
    expect(await hudText(viewer)).toContain('第 1 / 2 页');
    await expect(consolePage.getByTestId('current-page')).toHaveText('1');

    // 当前会话自身的命令仍然正常生效
    await consolePage.getByTestId('next').click();
    await expect.poll(() => hudText(viewer), { timeout: 5000 }).toContain('第 2 / 2 页');

    await viewer.close();
    await context.close();
    await browser.close();
  });
});
