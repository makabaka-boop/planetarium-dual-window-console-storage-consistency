import { chromium, expect, test } from '@playwright/test';
import {
  addImages,
  clearDbFaults,
  dbFaultHits,
  hudText,
  installDbFaultControls,
  openConsole,
  pngImage,
  readPersistedDraft,
  readPersistedSession,
  setDbFaults,
  startShowWithPopup,
  type DbFaultMode
} from './helpers';

test.describe.configure({ mode: 'serial' });

/**
 * 存储失败权威语义验收。每个用例都在具体提交边界强制拒绝/中止事务，
 * 随后刷新控制台与观众窗，核对画面、会话、待确认状态和持久记录完全一致：
 *  - abort-request：单条写请求成功但事务随后中止（最隐蔽的误报来源）
 *  - abort-now：事务立即中止
 *  - quota：事务/打开阶段直接拒绝（空间不足、权限收回）
 */
test.describe('IndexedDB 存储失败：确定的权威状态', () => {
  test('开始放映：请求成功但事务中止 → 不留会话、不进运行态、不开窗；重试收敛', async () => {
    const browser = await chromium.launch();
    const { context, page: consolePage } = await openConsole(browser);
    await installDbFaultControls(context);
    await addImages(consolePage, [pngImage('a.png'), pngImage('b.png')]);

    await setDbFaults(consolePage, [{ scope: 'show:start', mode: 'abort-request' }]);
    // 弹窗仍会被浏览器接住，但权威规则下开始失败绝不允许打开观众窗
    const popupAttempt = context.waitForEvent('page', { timeout: 1500 }).catch(() => null);
    await consolePage.getByTestId('start-show').click();

    // 控制台停留在编辑态，出现可重试告警
    await expect(consolePage.getByTestId('start-show')).toBeVisible({ timeout: 5000 });
    await expect(consolePage.getByTestId('storage-error-show:start')).toBeVisible();
    await expect(consolePage.getByTestId('live-controls')).toHaveCount(0);
    // 没有观众窗被打开
    expect(await popupAttempt).toBeNull();
    // 磁盘没有任何 current 会话，也没有 frozen 记录
    expect(await readPersistedSession(consolePage)).toBeNull();
    expect(await dbFaultHits(consolePage)).toContain('show:start');

    // 解除故障并重试：会话原子落库、观众窗打开、一切正常
    await clearDbFaults(consolePage);
    const viewerPromise = context.waitForEvent('page');
    await consolePage.getByTestId('retry-storage-show:start').click();
    const viewer = await viewerPromise;
    await viewer.waitForLoadState('load');
    await expect(viewer.getByTestId('viewer-hud')).toBeVisible({ timeout: 10_000 });
    expect(await hudText(viewer)).toContain('第 1 / 2 页');
    await expect(consolePage.getByTestId('live-controls')).toBeVisible();
    expect(await consolePage.getByTestId('session-id').innerText()).toBeTruthy();

    // 刷新控制台：会话真实恢复，不回编辑态
    await consolePage.reload();
    await expect(consolePage.getByTestId('live-controls')).toBeVisible({ timeout: 5000 });
    expect(await consolePage.getByTestId('current-page').innerText()).toBe('1');

    await viewer.close();
    await context.close();
    await browser.close();
  });

  test('开始放映：quota 拒绝（权限收回/空间不足）→ 不宣布成功，恢复后可正常开始', async () => {
    const browser = await chromium.launch();
    const { context, page: consolePage } = await openConsole(browser);
    await installDbFaultControls(context);
    await addImages(consolePage, [pngImage('a.png')]);

    await setDbFaults(consolePage, [{ scope: 'show:start', mode: 'quota' }]);
    await consolePage.getByTestId('start-show').click();
    await expect(consolePage.getByTestId('storage-error-show:start')).toBeVisible({ timeout: 5000 });
    expect(await readPersistedSession(consolePage)).toBeNull();
    await expect(consolePage.getByTestId('live-controls')).toHaveCount(0);

    // 解除故障后刷新：不应凭空恢复一个从未落盘的会话
    await clearDbFaults(consolePage);
    await consolePage.reload();
    await expect(consolePage.getByTestId('start-show')).toBeVisible({ timeout: 5000 });
    expect(await readPersistedSession(consolePage)).toBeNull();

    // 再次开始完全正常
    const viewer = await startShowWithPopup(context, consolePage);
    expect(await hudText(viewer)).toContain('第 1 / 1 页');

    await viewer.close();
    await context.close();
    await browser.close();
  });

  test('切页时事务中止：命令不外发、画面不动；刷新后控制台与观众窗同处旧页', async () => {
    const browser = await chromium.launch();
    const { context, page: consolePage } = await openConsole(browser);
    await installDbFaultControls(context);
    await addImages(consolePage, [
      pngImage('p1.png'),
      pngImage('p2.png'),
      pngImage('p3.png')
    ]);
    const viewer = await startShowWithPopup(context, consolePage);
    expect(await hudText(viewer)).toContain('第 1 / 3 页');

    await setDbFaults(consolePage, [{ scope: 'session:command', mode: 'abort-request' }]);
    await consolePage.getByTestId('next').click();

    // 可重试告警；控制台权威仍在第 1 页、无未决命令（未持久化即未宣布）
    await expect(consolePage.getByTestId('storage-error-command')).toBeVisible({ timeout: 5000 });
    expect(await consolePage.getByTestId('current-page').innerText()).toBe('1');
    await expect(consolePage.getByTestId('status-pending')).toHaveCount(0);
    // 观众窗从未收到命令，画面仍是第 1 页
    await expect
      .poll(() => hudText(viewer), { timeout: 1000 })
      .toContain('第 1 / 3 页');
    // 磁盘仍停留在会话初始权威
    const row = await readPersistedSession(consolePage);
    expect((row as { session?: { lastConfirmed?: { page: number } } }).session?.lastConfirmed?.page).toBe(0);

    // 刷新双方：控制台不回跳、观众窗经快照恢复，仍一致在第 1 页；
    // 存储告警也跨刷新存在（失败的命令从未落盘，刷新回到干净的第 1 页会话）。
    await clearDbFaults(consolePage);
    await consolePage.reload();
    await viewer.reload();
    await expect(consolePage.getByTestId('live-controls')).toBeVisible({ timeout: 5000 });
    expect(await consolePage.getByTestId('current-page').innerText()).toBe('1');
    await expect(viewer.getByTestId('viewer-hud')).toBeVisible({ timeout: 10_000 });
    expect(await hudText(viewer)).toContain('第 1 / 3 页');

    // 故障解除后正常切页：命令落盘后发出并确认，画面、控制台、磁盘一致
    await consolePage.getByTestId('next').click();
    await expect.poll(() => hudText(viewer), { timeout: 5000 }).toContain('第 2 / 3 页');
    expect(await consolePage.getByTestId('current-page').innerText()).toBe('2');
    await expect(consolePage.getByTestId('presented-1')).toBeVisible();
    const row2 = await readPersistedSession(consolePage);
    expect((row2 as { session: Record<string, unknown> }).session.lastConfirmed).toMatchObject({
      seq: 1,
      page: 1
    });

    await viewer.close();
    await context.close();
    await browser.close();
  });

  test('确认到达但持久化中止：页面不显示已确认，磁盘保留未确认命令；重试后收敛', async () => {
    const browser = await chromium.launch();
    const { context, page: consolePage } = await openConsole(browser);
    await installDbFaultControls(context);
    // 在控制台侧挂起所有入站 ACK，可精确控制“确认到达”的时刻
    await context.addInitScript(() => {
      const W = window as unknown as {
        __ackGate?: { held: unknown[]; release: () => number };
        __domeDeliverAck?: (m: unknown) => void;
      };
      if (W.__ackGate) return;
      const held: unknown[] = [];
      W.__ackGate = {
        held,
        release: () => {
          const queue = held.splice(0, held.length);
          queue.forEach((m) => W.__domeDeliverAck?.(m));
          return queue.length;
        }
      };
      const proto = BroadcastChannel.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'onmessage')!;
      // 缓存应用真正的消息分发入口：拦截 onmessage setter 拿到回调
      Object.defineProperty(proto, 'onmessage', {
        configurable: true,
        enumerable: desc.enumerable,
        get(this: BroadcastChannel) {
          return (this as unknown as { __gateHandler?: ((e: MessageEvent) => void) | null }).__gateHandler ?? null;
        },
        set(this: BroadcastChannel, handler: ((e: MessageEvent) => void) | null) {
          (this as unknown as { __gateHandler: typeof handler }).__gateHandler = handler;
          const self = this;
          W.__domeDeliverAck = (m) => handler?.call(self, { data: m } as MessageEvent);
          desc.set!.call(this, (ev: MessageEvent) => {
            if ((ev.data as { kind?: string })?.kind === 'ACK') held.push(ev.data);
            else handler?.call(self, ev);
          });
        }
      });
    });
    await addImages(consolePage, [pngImage('a.png'), pngImage('b.png')]);
    await consolePage.reload();
    await expect(consolePage.getByTestId('start-show')).toBeVisible();

    const viewer = await startShowWithPopup(context, consolePage);

    // 命令正常落盘发出；ACK 被挂起：观众窗已呈现第 2 页，控制台停在待确认
    await consolePage.getByTestId('next').click();
    await expect.poll(() => hudText(viewer), { timeout: 5000 }).toContain('第 2 / 2 页');
    await expect(consolePage.getByTestId('status-pending')).toBeVisible();
    expect(await consolePage.getByTestId('current-page').innerText()).toBe('1');

    // 磁盘上确实是未决命令
    let row = await readPersistedSession(consolePage);
    expect((row as { session: Record<string, unknown> }).session.pending).toMatchObject({
      seq: 1,
      status: 'pending'
    });

    // 安装 ACK 落盘故障，再放行被挂起的确认
    await setDbFaults(consolePage, [{ scope: 'session:ack', mode: 'abort-request' }]);
    const released = await consolePage.evaluate(
      () => (window as unknown as { __ackGate: { release: () => number } }).__ackGate.release()
    );
    expect(released).toBeGreaterThan(0);

    await expect(consolePage.getByTestId('storage-error-command')).toBeVisible({ timeout: 5000 });
    // UI 未宣布确认：权威仍第 1 页
    expect(await consolePage.getByTestId('current-page').innerText()).toBe('1');
    await expect(consolePage.getByTestId('presented-1')).toHaveCount(0);
    // 磁盘保留未确认命令（lastConfirmed 不前进）
    row = await readPersistedSession(consolePage);
    const sess = (row as { session: Record<string, unknown> }).session;
    expect(sess.lastConfirmed).toMatchObject({ seq: 0, page: 0 });
    expect(sess.pending).toMatchObject({ seq: 1 });

    // 重试持久化：ACK 的推进原子落盘，权威才前进到第 2 页
    await clearDbFaults(consolePage);
    await consolePage.getByTestId('retry-storage-command').click();
    await expect.poll(async () => consolePage.getByTestId('current-page').innerText(), {
      timeout: 5000
    }).toBe('2');
    await expect(consolePage.getByTestId('presented-1')).toBeVisible();
    row = await readPersistedSession(consolePage);
    expect((row as { session: Record<string, unknown> }).session.lastConfirmed).toMatchObject({
      seq: 1,
      page: 1
    });
    expect((row as { session: Record<string, unknown> }).session.pending).toBeNull();

    // 刷新双方：穹顶与控制台一致在第 2 页，没有“已确认显示 vs 磁盘未确认”的分裂
    await consolePage.reload();
    await viewer.reload();
    await expect(viewer.getByTestId('viewer-hud')).toBeVisible({ timeout: 10_000 });
    expect(await hudText(viewer)).toContain('第 2 / 2 页');
    expect(await consolePage.getByTestId('current-page').innerText()).toBe('2');

    await viewer.close();
    await context.close();
    await browser.close();
  });

  test('停映清理中止：会话不结束、观众窗不黑屏；刷新不复活旧放映矛盾，重试后干净结束', async () => {
    const browser = await chromium.launch();
    const { context, page: consolePage } = await openConsole(browser);
    await installDbFaultControls(context);
    await addImages(consolePage, [pngImage('a.png'), pngImage('b.png')]);
    const viewer = await startShowWithPopup(context, consolePage);
    await consolePage.getByTestId('next').click();
    await expect.poll(() => hudText(viewer), { timeout: 5000 }).toContain('第 2 / 2 页');

    await setDbFaults(consolePage, [{ scope: 'show:end', mode: 'abort-request' }]);
    await consolePage.getByTestId('end-show').click();

    // 清理失败：控制台仍在运行态，会话记录保留，观众窗未收到结束通知
    await expect(consolePage.getByTestId('storage-error-show:end')).toBeVisible({ timeout: 5000 });
    await expect(consolePage.getByTestId('live-controls')).toBeVisible();
    expect(await consolePage.getByTestId('current-page').innerText()).toBe('2');
    expect(await hudText(viewer)).toContain('第 2 / 2 页');
    expect(await readPersistedSession(consolePage)).not.toBeNull();

    // 刷新：运行会话照旧恢复（不是“已结束却复活”——结束从未持久化）
    await consolePage.reload();
    await expect(consolePage.getByTestId('live-controls')).toBeVisible({ timeout: 5000 });
    expect(await consolePage.getByTestId('current-page').innerText()).toBe('2');

    // 重试停映：清理成功后才发结束通知、解冻
    await clearDbFaults(consolePage);
    await consolePage.getByTestId('retry-storage-show:end').click();
    await expect.poll(() => hudText(viewer), { timeout: 5000 }).not.toContain('/ 2 页');
    await expect(consolePage.getByTestId('start-show')).toBeVisible({ timeout: 5000 });
    expect(await readPersistedSession(consolePage)).toBeNull();

    // 最终刷新：控制台在编辑态，观众窗待命，旧放映不复活
    await consolePage.reload();
    await viewer.reload();
    await expect(consolePage.getByTestId('start-show')).toBeVisible({ timeout: 5000 });
    await expect(viewer.getByTestId('viewer-standby')).toBeVisible({ timeout: 10_000 });

    await viewer.close();
    await context.close();
    await browser.close();
  });

  test('草稿写入中止：请求成功但事务回滚，不宣布已保存；磁盘与重试后一致', async () => {
    const browser = await chromium.launch();
    const { context, page: consolePage } = await openConsole(browser);
    await installDbFaultControls(context);
    await addImages(consolePage, [pngImage('a.png'), pngImage('b.png')]);
    const before = await readPersistedDraft(consolePage);
    expect(before).toHaveLength(2);

    // 删除操作触发草稿保存，事务在请求成功后中止
    await setDbFaults(consolePage, [{ scope: 'draft:save', mode: 'abort-request' }]);
    await consolePage.locator('[data-testid=slide-list] li').first().locator('button.btn-danger-mini').click();

    await expect(consolePage.getByTestId('storage-error-draft')).toBeVisible({ timeout: 5000 });
    // 行仍在（失败的删除不得宣布生效）
    await expect(consolePage.locator('[data-testid=slide-list] li')).toHaveCount(2);
    // 磁盘仍是删除前的两张
    expect(await readPersistedDraft(consolePage)).toHaveLength(2);

    await clearDbFaults(consolePage);
    await consolePage.getByTestId('retry-storage-draft').click();
    await expect(consolePage.getByTestId('storage-error-draft')).toHaveCount(0);
    // 重试只是把当前草稿重新写稳；刷新后行集合一致（两张仍在）
    await consolePage.reload();
    await expect(consolePage.locator('[data-testid=slide-list] li')).toHaveCount(2);
    expect(await readPersistedDraft(consolePage)).toHaveLength(2);

    // 故障解除后删除正常
    await consolePage.locator('[data-testid=slide-list] li').first().locator('button.btn-danger-mini').click();
    await expect(consolePage.locator('[data-testid=slide-list] li')).toHaveCount(1);
    expect(await readPersistedDraft(consolePage)).toHaveLength(1);

    await context.close();
    await browser.close();
  });

  test('abort-now（事务立即中止）下开始与切页同样给出可重试权威状态', async () => {
    const browser = await chromium.launch();
    const { context, page: consolePage } = await openConsole(browser);
    await installDbFaultControls(context);
    await addImages(consolePage, [pngImage('a.png'), pngImage('b.png')]);

    await setDbFaults(consolePage, [{ scope: 'show:start', mode: 'abort-now' as DbFaultMode }]);
    await consolePage.getByTestId('start-show').click();
    await expect(consolePage.getByTestId('storage-error-show:start')).toBeVisible({ timeout: 5000 });
    expect(await readPersistedSession(consolePage)).toBeNull();

    await clearDbFaults(consolePage);
    const viewer = await startShowWithPopup(context, consolePage);
    expect(await hudText(viewer)).toContain('第 1 / 2 页');

    await setDbFaults(consolePage, [{ scope: 'session:command', mode: 'abort-now' as DbFaultMode }]);
    await consolePage.getByTestId('next').click();
    await expect(consolePage.getByTestId('storage-error-command')).toBeVisible({ timeout: 5000 });
    expect(await consolePage.getByTestId('current-page').innerText()).toBe('1');
    expect(await hudText(viewer)).toContain('第 1 / 2 页');

    await clearDbFaults(consolePage);
    await consolePage.getByTestId('retry-storage-command').click();
    await expect.poll(() => hudText(viewer), { timeout: 5000 }).toContain('第 2 / 2 页');
    expect(await consolePage.getByTestId('current-page').innerText()).toBe('2');

    await viewer.close();
    await context.close();
    await browser.close();
  });
});
