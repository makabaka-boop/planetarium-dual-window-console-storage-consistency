import { chromium, expect, test } from '@playwright/test';
import { addImages, hudText, openConsole, pngImage, startShowWithPopup } from './helpers';

test.describe.configure({ mode: 'serial' });

test.describe('未确认与重试（序号不变）', () => {
  test('观众窗离线导致超时未确认；重开后重试沿用原序号并收敛', async () => {
    const browser = await chromium.launch();
    const { context, page: consolePage } = await openConsole(browser);
    await addImages(consolePage, [pngImage('a.png'), pngImage('b.png'), pngImage('c.png')]);
    let viewer = await startShowWithPopup(context, consolePage);

    // 在观众窗里静默 ACK：让它仍正常渲染，但控制台永远收不到确认（模拟确认丢失）
    await viewer.evaluate(() => {
      const proto = BroadcastChannel.prototype;
      (proto as unknown as { __origPost?: typeof proto.postMessage }).__origPost =
        proto.postMessage;
      proto.postMessage = function (this: BroadcastChannel, msg: unknown) {
        const kind = (msg as { kind?: string })?.kind;
        // 仅吞掉 ACK，SNAPSHOT_REQ 等保留（恢复路径仍可工作）
        if (kind === 'ACK') return;
        return (this as unknown as { __origPost: typeof proto.postMessage }).__origPost.call(
          this,
          msg
        );
      };
    });

    await consolePage.getByTestId('next').click();

    // 默认 2s 超时 + 200ms 巡检：权威仍停在第 1 页，标记为未确认
    await expect(consolePage.getByTestId('status-unconfirmed')).toBeVisible({ timeout: 8000 });
    await expect(consolePage.getByTestId('current-page')).toHaveText('1');
    const seqText = await consolePage.locator('.status-unconfirmed').innerText();
    expect(seqText).toContain('seq=1');

    // 重开观众窗：它先恢复到最后已确认的第 1 页（控制台权威未前进）
    viewer = await context.newPage();
    await viewer.goto('/viewer');
    await expect(viewer.getByTestId('viewer-hud')).toBeVisible({ timeout: 10_000 });
    expect(await hudText(viewer)).toContain('第 1 / 3 页');

    // 点重试：沿用 seq=1（不是新的 seq=2），观众窗呈现第 2 页并收敛
    await consolePage.getByTestId('retry').click();
    await expect.poll(() => hudText(viewer), { timeout: 5000 }).toContain('第 2 / 3 页');
    await expect(consolePage.getByTestId('current-page')).toHaveText('2');
    await expect(consolePage.getByTestId('presented-1')).toBeVisible();
    expect(await consolePage.locator('.seq-line').innerText()).toContain('seq=1');

    await viewer.close();
    await context.close();
    await browser.close();
  });
});
