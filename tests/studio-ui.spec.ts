import { test, expect } from './studio-test';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const out = resolve(process.cwd(), process.env.STUDIO_EVIDENCE_DIR || '../output/studio-v3-validation-20261001');

test('video canvas saves a real project and opens the live director', async ({ page, request }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  const response = await request.post('/api/v3/projects', { data: { name: 'UI 验收 · 三人五镜', demo: true } });
  expect(response.ok()).toBeTruthy();
  const { data: project } = await response.json();
  await page.goto(`/video/studio?project=${project.id}`);
  await expect(page.getByRole('button', { name: 'UI 验收 · 三人五镜' })).toBeVisible();
  await expect(page.locator('.react-flow__node')).toHaveCount(project.nodes.length);
  await page.getByRole('button', { name: '文本', exact: true }).click();
  await expect(page.locator('.studio-inspector')).toBeVisible();
  await page.locator('.studio-inspector textarea').fill('镜头描述：两位角色在屋顶相遇。');
  await expect(page.locator('.studio-save-status')).toContainText('已保存', { timeout: 15_000 });
  await page.reload();
  await expect(page.locator('.studio-card-text').filter({ hasText: '两位角色在屋顶相遇' })).toBeVisible();
  await page.screenshot({ path: `${out}/canvas.png` });
  await page.getByRole('button', { name: '导演台', exact: true }).click();
  await expect(page.locator('.studio-director-modal canvas')).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(2500);
  await expect(page.locator('.studio-director-modal canvas')).toBeVisible();
  await page.screenshot({ path: `${out}/director.png` });
  expect(errors).toEqual([]);
});

test('the actual Blender sequence plays video and audio in the product preview', async ({ page, request }) => {
  const projectId = process.env.STUDIO_MEDIA_PROJECT;
  test.skip(!projectId, 'Requires the real Blender/FFmpeg acceptance project, never a stub media URL.');
  const response = await request.get(`/api/v3/projects/${projectId}`);
  expect(response.ok()).toBeTruthy(); const { data: project } = await response.json();
  expect(project.sequence.clips.some((c: any) => c.kind === 'video')).toBe(true);
  expect(project.sequence.clips.some((c: any) => c.kind === 'audio')).toBe(true);
  await page.goto(`/video/studio?project=${projectId}`);
  await page.getByRole('button', { name: '预览', exact: true }).click();
  const player = page.locator('.studio-player-modal');
  await expect(player.locator('video')).toBeVisible();
  await expect.poll(() => player.locator('video').evaluate((video: HTMLVideoElement) => video.readyState)).toBeGreaterThanOrEqual(2);
  await player.getByRole('button', { name: '播放', exact: true }).click();
  await expect.poll(() => player.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(1.5);
  await expect.poll(() => player.locator('video, audio').evaluateAll(elements => elements.every(node => {
    const media = node as HTMLMediaElement; return media.readyState >= 3 && !media.seeking && !media.paused && media.currentTime > 1;
  }))).toBe(true);
  const media = await player.locator('video, audio').evaluateAll(elements => elements.map(node => {
    const media = node as HTMLMediaElement;
    return { tag: media.tagName, readyState: media.readyState, currentTime: media.currentTime, paused: media.paused, seeking: media.seeking, error: media.error?.message || null };
  }));
  expect(media.length).toBeGreaterThanOrEqual(2);
  expect(media.every(item => !item.paused && !item.error && item.currentTime > 1)).toBe(true);
  await page.screenshot({ path: `${out}/product-previs-playback.png` });
  await writeFile(`${out}/product-previs-playback.json`, JSON.stringify({ projectId, media, note: 'Actual 3D previs and local test tone; not an AI film.' }, null, 2));
});

test('review precedes generation, timeline and mobile preview remain available', async ({ page, request }) => {
  const response = await request.post('/api/v3/projects', { data: { name: '审核与时间线验收', demo: true } });
  const { data: project } = await response.json();
  const rejected = await request.post(`/api/v3/projects/${project.id}/shots/${project.shots[0].id}/generate`, { data: { idempotencyKey: 'without-approval' } });
  expect(rejected.status()).toBe(409);
  await page.goto(`/video/studio?project=${project.id}`);
  await page.getByRole('button', { name: '审核脚本', exact: true }).click();
  await expect(page.getByTitle('待确认脚本')).toBeVisible();
  const text = await page.frameLocator('iframe[title="待确认脚本"]').locator('body').innerText();
  expect(text).toContain(project.name);
  await page.screenshot({ path: `${out}/script-review.png` });
  await page.locator('.studio-review-modal header button').click();
  await page.locator('.studio-topbar').getByRole('button', { name: '时间线', exact: true }).click();
  await page.getByRole('button', { name: '文字', exact: true }).click();
  await page.getByLabel('画面文字').fill('沈月\n巳蛇\n能力：银色异能光环');
  await expect(page.locator('.studio-save-status')).toContainText('已保存', { timeout: 15_000 });
  await page.getByRole('button', { name: '预览', exact: true }).click();
  await expect(page.locator('.studio-text-overlay')).toContainText('巳蛇');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.studio-player-modal')).toBeVisible();
  await page.screenshot({ path: `${out}/mobile-preview.png` });
});

test('main video entry restores viewport and imports browser history without changing the original records', async ({ page, request }) => {
  const response = await request.post('/api/v3/projects', { data: { name: '入口与旧记录恢复验收', demo: false } });
  const { data: project } = await response.json();
  await page.goto(`/video?project=${project.id}`);
  if (process.env.STUDIO_TEST_MAIN_ENABLED === '1') await expect(page.locator('.studio-root')).toBeVisible();
  else { await expect(page.locator('.videoJobs')).toBeVisible(); await page.goto(`/video/studio?project=${project.id}`); }
  const pane = page.locator('.react-flow__pane'); const box = (await pane.boundingBox())!;
  await page.mouse.move(box.x + box.width * .6, box.y + box.height * .5);
  await page.mouse.wheel(0, -240);
  await expect.poll(async () => (await (await request.get(`/api/v3/projects/${project.id}`)).json()).data.viewport?.zoom).toBeGreaterThan(1);
  await expect(page.locator('.studio-save-status')).toContainText('已保存');
  const savedViewport = (await (await request.get(`/api/v3/projects/${project.id}`)).json()).data.viewport;
  await page.reload();
  await expect.poll(async () => page.locator('.react-flow__viewport').evaluate((element, expected) => {
    const matrix = new DOMMatrix(getComputedStyle(element).transform);
    return Math.max(Math.abs(matrix.e - expected.x), Math.abs(matrix.f - expected.y), Math.abs(matrix.a - expected.zoom));
  }, savedViewport)).toBeLessThan(.001);
  const old = JSON.stringify([{ id: 'historic-record-no-output', subject: '原始历史记录', status: 'failed' }]);
  await page.evaluate(value => localStorage.setItem('videoJobs', value), old);
  await page.locator('.studio-project-trigger').click();
  await page.locator('[data-action=import-browser-history]').click();
  await expect(page.locator('.studio-project-trigger')).toContainText('导入本机旧视频记录');
  expect(await page.evaluate(() => localStorage.getItem('videoJobs'))).toBe(old);
  await expect(page.locator('.studio-card-text').filter({ hasText: '没有可复制的成品 URL' })).toBeVisible();
  await page.goto('/video/legacy');
  await expect(page.locator('.videoJobs')).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('videoJobs') || '[]')[0]?.id)).toBe('historic-record-no-output');
  await page.goto('/');
  await expect(page.locator('.studio-root')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('Application error');
});
