import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AssetRevision, StudioJob, StudioProject } from '../lib/studio/types';
import { makeTemplateProgram } from '../lib/studio/code-scene/defaults';

const output = resolve(process.env.STUDIO_PIPELINE_OUTPUT || '../output/studio-code-mode-20261002/web');
const fixtureProject = (id = 'existing'): StudioProject => ({ schemaVersion: 3, id, name: '保留当前工程', revision: 0, createdAt: '', updatedAt: '', fps: 24, aspect: '16:9', totalFrames: 240, nodes: [], edges: [], assets: [], scenes: [], shots: [], sequence: { id: `${id}-seq`, name: '10秒时间线', fps: 24, totalFrames: 240, clips: [] } });
async function fixtureAPI(page: Page, state: { projects: StudioProject[]; jobs: StudioJob[]; writes: Array<{ path: string; body: Record<string, unknown> }> }) {
  await page.route('**/api/v3/**', async route => {
    const req = route.request(), path = new URL(req.url()).pathname.slice('/api/v3'.length), method = req.method();
    const data = method === 'GET' ? null : req.postDataJSON();
    if (method !== 'GET') state.writes.push({ path, body: data });
    const send = (value: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: value }) });
    if (path === '/session') return send({ anonymous: true });
    if (path === '/capabilities') return send({ sceneGeneration: { available: true }, dlss: { available: true }, renderers: { 'three-webgl': { available: true }, remotion: { available: true } } });
    if (path === '/projects' && method === 'GET') return send(state.projects);
    if (path === '/projects' && method === 'POST') { const p = fixtureProject('new-code'); p.name = data.name; state.projects.push(p); return send(p); }
    if (path.startsWith('/jobs/')) {
      const job = state.jobs.find(job => job.id === path.split('/')[2]); if (!job) return route.fulfill({ status: 404 });
      if (path.endsWith('/retry')) { expect(typeof data.idempotencyKey).toBe('string'); Object.assign(job, { state: 'queued', stage: 'queued', retryable: false, cancellable: true }); }
      else if (path.endsWith('/cancel')) Object.assign(job, { state: 'cancelled', cancellable: false });
      return send(job);
    }
    const id = path.split('/')[2], p = state.projects.find(p => p.id === id);
    if (!p) return route.fulfill({ status: 404, body: '{"detail":"not found"}' });
    if (path === `/projects/${id}` && method === 'GET') return send(p);
    if (path === `/projects/${id}` && method === 'PUT') { expect(data.baseRevision).toBe(p.revision); const next = { ...data.project, revision: p.revision + 1 }; state.projects[state.projects.indexOf(p)] = next; return send(next); }
    if (path.endsWith('/jobs')) return send(state.jobs);
    if (path.endsWith('/scene-generations')) { expect(p.totalFrames).toBe(1440); expect(p.sequence.totalFrames).toBe(1440); expect(data.film).toBe('borrow-sunshine'); expect(data).not.toHaveProperty('backends'); const job: StudioJob = { id: 'scene-job', projectId: id, kind: 'scene-generation', state: 'complete', progress: 1, createdAt: '', updatedAt: '', output: { sceneProgram: makeTemplateProgram('borrow-sunshine') } }; state.jobs.push(job); return send(job); }
    if (path.endsWith('/scene-generations/scene-job/apply')) { expect(data.baseRevision).toBe(p.revision); expect(data.scene.codeProgram.film).toBe('borrow-sunshine'); expect(data.scene.objects.length).toBeGreaterThan(2); const scene = { ...data.scene, id: 'applied-scene', revision: 0, codeGenerationJobId: 'scene-job' }; p.scenes.push(scene); p.nodes.push({ id: 'director', type: 'director', label: scene.name, sceneId: scene.id, x: 0, y: 0 }); p.revision++; return send({ project: p, sceneId: scene.id }); }
    if (path.endsWith('/renders')) { expect(data.backends).toEqual(['three-webgl', 'remotion']); expect(data.sceneId).toBe('applied-scene'); expect(data.sceneRevision).toBe(0); expect(data.sceneGenerationJobId).toBe('scene-job'); expect(data).not.toHaveProperty('exporter'); const jobs = data.backends.map((backend: string): StudioJob => ({ id: `render-${backend}`, projectId: id, kind: 'render', state: 'queued', progress: 0, createdAt: '', updatedAt: '', stage: 'queued', renderGroupId: 'group' })); state.jobs.push(...jobs); return send({ jobs, renderGroupId: 'group' }); }
    return route.fulfill({ status: 400, body: JSON.stringify({ detail: `Unexpected fixture route: ${method} ${path}` }) });
  });
}

test('code scene explicitly creates 60s template, applies a completed program, then sends same-scene two-backend render contract', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  const original = fixtureProject(), state = { projects: [original], jobs: [] as StudioJob[], writes: [] as Array<{ path: string; body: Record<string, unknown> }> };
  await fixtureAPI(page, state); await page.goto('/video/studio?project=existing');
  await page.getByRole('button', { name: '模式 3 · 代码动画', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '代码场景动画' }); await dialog.getByLabel('代码故事模板').selectOption('borrow-sunshine');
  await dialog.getByRole('button', { name: '生成可编辑场景', exact: true }).click();
  await expect(dialog).not.toBeVisible(); await page.locator('.studio-jobs summary').click();
  await expect(page.getByRole('button', { name: '应用到导演台', exact: true })).toBeVisible();
  expect(state.projects[0]).toEqual(original); expect(state.projects[1].scenes).toHaveLength(0);
  await page.getByRole('button', { name: '应用到导演台', exact: true }).click();
  const director = page.getByRole('dialog', { name: '三维导演台' }); await expect(director).toBeVisible(); await expect(director.locator('canvas')).toBeVisible({ timeout: 45_000 });
  await expect(director.getByRole('button', { name: '跟随分镜', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await director.getByLabel('场景导出工具').selectOption('both'); await director.getByRole('button', { name: '渲染成片', exact: true }).click();
  await expect.poll(() => state.writes.filter(w => w.path.endsWith('/renders')).length).toBe(1);
  expect(state.writes.filter(w => w.path.endsWith('/scene-generations'))).toHaveLength(1);
  await page.screenshot({ path: resolve(output, 'code-scene-director.png') }); expect(errors).toEqual([]);
});

test('single-video version switching preserves paused/playing time, download and nondestructive use at mobile width', async ({ page }, testInfo) => {
  mkdirSync(output, { recursive: true }); const path = resolve(output, 'interaction-fixture.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path]); const bytes = readFileSync(path);
  await page.route('**/fixture-media/*.mp4', route => {
    const match = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range || '');
    if (!match) return route.fulfill({ contentType: 'video/mp4', headers: { 'accept-ranges': 'bytes' }, body: bytes });
    const start = Number(match[1]), end = Math.min(match[2] ? Number(match[2]) : bytes.length - 1, bytes.length - 1);
    return route.fulfill({ status: 206, contentType: 'video/mp4', headers: { 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${bytes.length}`, 'content-length': String(end - start + 1) }, body: bytes.subarray(start, end + 1) });
  });
  const p = fixtureProject(), media = (id: string, role: string, parentId?: string): AssetRevision => ({ id, kind: 'video', name: id, parentId, mime: 'video/mp4', url: `/fixture-media/${id}.mp4`, hash: id, bytes: bytes.length, createdAt: '', metadata: { role, frames: 72, duration: 3 } });
  p.assets = [media('original', 'base'), media('enhanced', 'enhanced', 'original'), media('compare', 'comparison', 'original')]; p.nodes.push({ id: 'video', type: 'video', label: '版本测试原片', assetId: 'original', x: 0, y: 0 }); p.sequence.clips.push({ id: 'clip', kind: 'video', track: 0, assetId: 'original', startFrame: 0, endFrame: 48, sourceIn: 12, volume: .15, fadeIn: 2, fadeOut: 3 });
  const state = { projects: [p], jobs: [] as StudioJob[], writes: [] as Array<{ path: string; body: Record<string, unknown> }> }; await fixtureAPI(page, state); await page.goto('/video/studio?project=existing');
  await page.locator('.studio-card-label').filter({ hasText: '版本测试原片' }).click(); await page.getByRole('button', { name: '查看版本 / 同步对比', exact: true }).click();
  const modal = page.getByRole('dialog', { name: '视频版本对比' }), video = modal.locator('video'); await expect(video).toHaveAttribute('aria-busy', 'false');
  await video.evaluate((v: HTMLVideoElement) => { const events: unknown[] = []; Object.assign(v, { qaEvents: events }); for (const event of ['loadstart','loadedmetadata','loadeddata','seeking','seeked','canplay','play','pause','error','emptied']) v.addEventListener(event, () => events.push({ event, src: v.currentSrc, time: v.currentTime, readyState: v.readyState, seeking: v.seeking, paused: v.paused })); });
  await video.evaluate(async (v: HTMLVideoElement) => { v.currentTime = .6; await v.play(); }); await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(.7);
  await modal.getByRole('button', { name: 'DLSS 5 实验版', exact: true }).click(); await expect(video).toHaveAttribute('aria-busy', 'false').catch(async error => { await testInfo.attach('playback-events', { body: JSON.stringify(await video.evaluate((v: HTMLVideoElement & { qaEvents?: unknown[] }) => ({ events: v.qaEvents, currentTime: v.currentTime, readyState: v.readyState, duration: v.duration, paused: v.paused, src: v.currentSrc }))), contentType: 'application/json' }); throw error; }); await expect.poll(() => video.evaluate((v: HTMLVideoElement) => !v.paused)).toBe(true);
  await video.evaluate((v: HTMLVideoElement) => { v.pause(); v.currentTime = 1.5; }); await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.seeking)).toBe(false);
  await modal.getByRole('button', { name: '同步并排对比', exact: true }).click(); await expect(video).toHaveAttribute('aria-busy', 'false'); expect(await video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true); expect(await video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(1.5, 1);
  await expect(modal.getByRole('link', { name: '下载当前版本' })).toHaveAttribute('href', '/fixture-media/compare.mp4'); await expect(modal.getByRole('button', { name: '使用此版本' })).toHaveCount(0); await expect(modal.locator('video')).toHaveCount(1);
  await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: resolve(output, 'versions-mobile.png') });
  await modal.getByRole('button', { name: 'DLSS 5 实验版', exact: true }).click(); await expect(video).toHaveAttribute('aria-busy', 'false'); await modal.getByRole('button', { name: '使用此版本', exact: true }).click();
  await expect.poll(() => state.projects[0].nodes[0].assetId).toBe('enhanced'); expect(state.projects[0].assets).toHaveLength(3); expect(state.projects[0].sequence.clips[0]).toEqual({ ...p.sequence.clips[0], assetId: 'enhanced' });
});

 test('failed stage publishes retained partial outputs, and explicit retry/cancel use persistent job routes', async ({ page }) => {
  const p = fixtureProject(), job: StudioJob = { id: 'partial-job', projectId: p.id, kind: 'render', backend: 'three-webgl', state: 'running', stage: 'render', progress: .2, createdAt: '', updatedAt: '1', cancellable: true };
  const state = { projects: [p], jobs: [job], writes: [] as Array<{ path: string; body: Record<string, unknown> }> }; await fixtureAPI(page, state); await page.goto('/video/studio?project=existing');
  await page.locator('.studio-jobs summary').click(); await expect(page.locator('.studio-job')).toContainText('场景成片 · Three');
  const asset: AssetRevision = { id: 'retained', kind: 'video', name: '保留的渲染原版', url: '/fixture-media/retained.mp4', mime: 'video/mp4', hash: 'retained', bytes: 100, createdAt: '', metadata: { role: 'base', frames: 1440 } };
  p.assets.push(asset); p.revision++; Object.assign(job, { state: 'failed', stage: 'encode', error: 'Fixture later-stage failure', retryable: true, cancellable: false, outputAssetIds: [asset.id], partialAssets: [asset], outputRevision: p.revision });
  await expect(page.locator('.studio-job')).toContainText('已完成阶段的素材已保留', { timeout: 10_000 }); await expect(page.locator('.studio-job-output')).toContainText(asset.name);
  await page.getByRole('button', { name: '恢复失败阶段', exact: true }).click(); await expect.poll(() => state.writes.filter(w => w.path === '/jobs/partial-job/retry').length).toBe(1);
  await expect(page.locator('.studio-job-output')).toContainText(asset.name); await page.getByRole('button', { name: '取消任务', exact: true }).click();
  await expect.poll(() => state.writes.filter(w => w.path === '/jobs/partial-job/cancel').length).toBe(1); await expect(page.locator('.studio-job')).toContainText('已取消'); expect(p.assets[0].id).toBe('retained');
});
