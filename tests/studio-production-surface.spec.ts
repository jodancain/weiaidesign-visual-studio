import { test, expect } from './studio-test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { StudioProject } from '../lib/studio/types';
const out = () => resolve(process.cwd(), process.env.STUDIO_EVIDENCE_DIR || '../output/studio-code-mode-20261002/web/production-final/screenshots');

test('deployed public build hydrates the studio and retains the original image and legacy video entries', async ({ page }) => {
  const expectedBuild = process.env.STUDIO_EXPECTED_BUILD_ID; expect(expectedBuild).toBeTruthy(); await mkdir(out(), { recursive: true });
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message)); const routes = [];
  for (const path of ['/video', '/', '/video/legacy']) {
    const response = await page.goto(path, { waitUntil: 'domcontentloaded' }); expect(response?.status()).toBe(200);
    if (path === '/video') { await expect(page.locator('main.studio-root')).toBeVisible(); await expect(page.getByRole('button', { name: /^代码场景(?:动画)?$/ }).first()).toBeVisible(); }
    else if (path === '/') { await expect(page.locator('.tl-container').first()).toBeVisible({ timeout: 30_000 }); await expect(page.getByPlaceholder('Start with an idea, or type "@" to mention')).toBeVisible(); }
    else { await expect(page.getByRole('heading', { name: '图生视频', exact: true })).toBeVisible(); await expect(page.getByRole('tablist', { name: '视频模式' })).toBeVisible(); }
    const marker = await page.evaluate(async () => { const response = await fetch(location.pathname, { cache: 'no-store' }), html = await response.text(); return { status: response.status, buildId: html.match(/\\"b\\":\\"([^"\\]+)\\"/)?.[1] || html.match(/"b":"([^"]+)"/)?.[1] || null, htmlBytes: new TextEncoder().encode(html).byteLength, secureContext: isSecureContext }; });
    expect(marker.status).toBe(200); expect(marker.buildId).toBe(expectedBuild); expect(marker.secureContext).toBe(true); routes.push({ path, url: page.url(), ...marker, hydrated: true });
    await page.screenshot({ path: resolve(out(), path === '/' ? 'production-image-entry.png' : path === '/video' ? 'production-studio-entry.png' : 'production-legacy-entry.png') });
  }
  await writeFile(resolve(out(), 'production-public-build.json'), JSON.stringify({ expectedBuild, routes, pageErrors: errors, modelCalls: 0, renderCalls: 0 }, null, 2)); expect(errors).toEqual([]);
});

test('public code demo copies to an owned editable scene and the real UI sends exact same-scene exporter parameters without starting workers', async ({ page, request }) => {
  const demoId = process.env.STUDIO_CODE_DEMO_ID; expect(demoId, 'An explicitly public compiled code demo is required').toBeTruthy(); await mkdir(out(), { recursive: true });
  const sourceResponse = await request.get(`/api/v3/projects/${demoId}`); expect(sourceResponse.ok()).toBe(true); const original = (await sourceResponse.json()).data as StudioProject;
  expect(original.access?.readOnly).toBe(true); expect(original.scenes.some(s => s.codeProgram)).toBe(true);
  await page.goto(`/video/studio?project=${demoId}`); await page.getByRole('button', { name: '复制为我的工程', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('project'), { timeout: 30000 }).not.toBe(demoId); const copyId = new URL(page.url()).searchParams.get('project')!;
  const get = async (): Promise<StudioProject> => (await (await request.get(`/api/v3/projects/${copyId}`)).json()).data;
  const copied = await get(), code = copied.scenes.find(s => s.codeProgram)!; expect(copied.access?.readOnly).not.toBe(true); expect(code.codeProgram).toEqual(original.scenes.find(s => s.codeProgram)?.codeProgram);
  const intercepted: Array<{ path: string; body: Record<string, unknown>; blocked: true }> = []; const unexpected: string[] = [];
  await page.route('**/api/v3/**', async route => { const req = route.request(), path = new URL(req.url()).pathname; if (req.method() !== 'GET' && /\/(?:scene-generations|renders|enhancements|ai|approve|generate|previews|exports)(?:\/|$)/.test(path)) { if (path === `/api/v3/projects/${copyId}/renders`) intercepted.push({ path, body: req.postDataJSON(), blocked: true }); else unexpected.push(path); return route.abort('blockedbyclient'); } return route.continue(); });
  await page.getByRole('button', { name: '导演台', exact: true }).click(); const panel = page.getByRole('dialog', { name: '三维导演台' }); await expect(panel.locator('canvas')).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByRole('button', { name: '烘焙并预演', exact: true })).toHaveCount(0); await expect(panel.getByLabel('添加动作片段', { exact: true })).toHaveCount(0); await expect(panel.getByText('分镜程序动作，可用骨骼/关键帧覆盖', { exact: true })).toBeVisible();
  await panel.locator('.sd-camera-row').first().click(); const lens = code.cameras[0].focalLength + 1;
  const editStarted = Date.now(), cameraSave = page.waitForResponse(response => response.url().endsWith(`/api/v3/projects/${copyId}/commands`) && response.request().method() === 'POST', { timeout: 30000 });
  await panel.getByLabel('焦距 mm', { exact: true }).fill(String(lens)); await panel.getByLabel('焦距 mm', { exact: true }).press('Enter');
  const cameraSaveResponse = await cameraSave; expect(cameraSaveResponse.status()).toBe(200);
  await expect.poll(async () => (await get()).scenes.find(s => s.id === code.id)!.cameras[0].focalLength, { timeout: 30000 }).toBe(lens);
  const cameraPersistMs = Date.now() - editStarted;
  const edited = await get(), scene = edited.scenes.find(s => s.id === code.id)!; expect(scene.codeProgramHash).toBe(code.codeProgramHash); expect(scene.codeProgram).toEqual(code.codeProgram);
  await expect(panel.getByLabel('场景导出工具')).toHaveValue('three');
  for (const [choice, backends] of [['three', ['three-webgl']], ['remotion', ['remotion']], ['both', ['three-webgl', 'remotion']]] as const) {
    const count = intercepted.length; await panel.getByLabel('场景导出工具').selectOption(choice); await expect(panel.getByRole('button', { name: '渲染成片', exact: true })).toBeEnabled({ timeout: 30_000 }); await panel.getByRole('button', { name: '渲染成片', exact: true }).click(); await expect.poll(() => intercepted.length).toBe(count + 1);
    const body = intercepted[count].body; expect(body.backends).toEqual(backends); expect(body.sceneId).toBe(scene.id); expect(body.sceneRevision).toBe(scene.revision); expect(body.baseRevision).toBe(edited.revision); expect(body.sceneGenerationJobId).toBe(scene.codeGenerationJobId); expect(typeof body.idempotencyKey).toBe('string'); expect(body).not.toHaveProperty('exporter');
  }
  const jobs = await request.get(`/api/v3/projects/${copyId}/jobs`); expect(jobs.ok()).toBe(true); expect((await jobs.json()).data).toHaveLength(0);
  await page.reload(); await page.getByRole('button', { name: '导演台', exact: true }).click(); await panel.locator('.sd-camera-row').first().click(); await expect(panel.getByLabel('焦距 mm', { exact: true })).toHaveValue(String(lens));
  const unchanged = (await (await request.get(`/api/v3/projects/${demoId}`)).json()).data; expect(unchanged.name).toBe(original.name); expect(unchanged.scenes).toEqual(original.scenes); expect(unchanged.shots).toEqual(original.shots); expect(unexpected).toEqual([]);
  await page.screenshot({ path: resolve(out(), 'production-owned-code-director.png') }); await writeFile(resolve(out(), 'production-code-parameters.json'), JSON.stringify({ demoId, copyId, sourceAuthoringUnchanged: true, cameraEditPersisted: true, cameraPersistMs, cameraSaveStatus: cameraSaveResponse.status(), sceneId: scene.id, sceneRevision: scene.revision, codeProgramHash: scene.codeProgramHash, intercepted, unexpected, actualQueuedJobs: 0, modelCalls: 0, renderCalls: 0, note: 'Actual production UI, BFF, SQLite and demo copy. Render POST aborted before backend; no mock success and no worker execution.' }, null, 2));
});
