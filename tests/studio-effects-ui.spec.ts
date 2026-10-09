import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AssetRevision, StudioJob, StudioProject } from '../lib/studio/types';

const output = resolve(process.env.STUDIO_EFFECTS_OUTPUT || '../output/studio-effects-20261008/web');
const asset = (id: string, source: string, parentId?: string, role = 'base'): AssetRevision => {
  const hash = id.padEnd(64, 'a');
  return { id, source, parentId, name: `${id}.mp4`, kind: 'video', hash, bytes: 100, mime: 'video/mp4', url: `/fixture-media/${id}.mp4`, createdAt: '', metadata: { role, frames: 72, duration: 3 },
    ...(['three-webgl', 'remotion', 'dlss-nr', 'effects-compositor'].includes(source) ? { effectsSource: { kind: parentId ? 'derived' : 'code-animation', sourceHash: hash, rootKind: 'code-animation' } as const } : {}) };
};
const aiOriginal = (): AssetRevision => {
  const a = asset('ai-original', 'provider'); a.effectsSource = { kind: 'ai-original', rootKind: 'ai-original', sourceHash: a.hash }; return a;
};
const original = asset('original', 'remotion'), derived = asset('derived', 'dlss-nr', original.id, 'enhanced');
const planHash = 'f'.repeat(64);
const program = { schemaVersion: 1, fps: 24, totalFrames: 72, width: 320, height: 180, seed: 42, subtitleProtection: { enabled: true, bottomFraction: .16, paddingPx: 8 }, layers: [{ id: 'glow', type: 'glow', description: '动作重点处柔光', startFrame: 0, endFrame: 72, color: '#ffcc88', opacity: .2, keyframes: [{ frame: 0, x: .5, y: .3, scale: 1, opacity: 1 }], parameters: { radius: .1, softness: .8, pulseHz: 0 } }] };
const project = (): StudioProject => ({ schemaVersion: 3, id: 'effects-project', name: '模式4隔离交互验收', revision: 1, fps: 24, aspect: '16:9', totalFrames: 72, createdAt: '', updatedAt: '', scenes: [], shots: [], edges: [], nodes: [{ id: 'video-node', type: 'video', label: '精确派生版', assetId: derived.id, x: 0, y: 0 }], assets: [structuredClone(original), structuredClone(derived), asset('uploaded', 'upload'), asset('old-comparison', 'dlss-nr', original.id, 'comparison')], sequence: { id: 'seq', name: '3秒时间线', fps: 24, totalFrames: 72, clips: [{ id: 'clip', kind: 'video', assetId: derived.id, track: 0, startFrame: 4, endFrame: 52, sourceIn: 12, volume: .15, fadeIn: 2, fadeOut: 3 }] } });
const plan = (state: StudioJob['state'] = 'complete'): StudioJob => ({ id: 'plan-1', projectId: 'effects-project', kind: 'effects-plan', state, progress: state === 'complete' ? 1 : 0, createdAt: '', updatedAt: '1', sourceAssetId: derived.id, sourceHash: derived.hash, output: state === 'complete' ? { effectsProgram: program, effectsProgramHash: planHash } : undefined });
type Fixture = { project: StudioProject; jobs: StudioJob[]; writes: { path: string; data: Record<string, unknown> }[]; loseRenderReceipt?: boolean; hideRender?: boolean; submitted?: StudioJob; effectsAvailable?: boolean; loseCancelReceipt?: boolean };
let media: Buffer;
test.beforeAll(() => {
  mkdirSync(output, { recursive: true }); const path = resolve(output, 'effects-ui-fixture.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path]); media = readFileSync(path);
});
async function api(page: Page, state: Fixture) {
  await page.route('**/fixture-media/*.mp4', route => {
    const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range || '');
    if (!range) return route.fulfill({ contentType: 'video/mp4', headers: { 'accept-ranges': 'bytes' }, body: media });
    const start = Number(range[1]), end = Math.min(range[2] ? Number(range[2]) : media.length - 1, media.length - 1);
    return route.fulfill({ status: 206, contentType: 'video/mp4', headers: { 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${media.length}` }, body: media.subarray(start, end + 1) });
  });
  await page.route('**/api/v3/**', async route => {
    const req = route.request(), path = new URL(req.url()).pathname.slice('/api/v3'.length), data = req.method() === 'GET' ? null : req.postDataJSON();
    if (data) state.writes.push({ path, data });
    const send = (data: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data }) });
    if (path === '/session') return send({ anonymous: true });
    if (path === '/capabilities') return send({ effects: { available: state.effectsAvailable ?? true, model: 'claude-opus-5-5' }, dlss: { available: true } });
    if (path === '/projects') return send([state.project]);
    if (path === '/projects/effects-project') {
      if (data) { expect(data.baseRevision).toBe(state.project.revision); state.project = { ...data.project, assets: state.project.assets, revision: state.project.revision + 1 }; }
      return send(state.project);
    }
    if (path.endsWith('/jobs')) return send(state.jobs.filter(j => !state.hideRender || j.kind !== 'effects-render'));
    if (path.endsWith('/effects-plans')) { const job = { ...plan('queued'), sourceAssetId: data.sourceAssetId, sourceHash: data.sourceHash }; state.jobs.push(job); return send(job); }
    if (path.endsWith('/effects-renders')) {
      expect(data).toMatchObject({ sourceAssetId: derived.id, sourceHash: derived.hash, planJobId: 'plan-1', planHash });
      expect(data.baseRevision).toBe(state.project.revision);
      if (!state.submitted) { state.submitted = { ...plan(), id: 'render-1', kind: 'effects-render', state: 'queued', progress: 0, planJobId: 'plan-1', planHash, output: undefined }; state.jobs.unshift(state.submitted); }
      if (state.loseRenderReceipt) { state.loseRenderReceipt = false; state.hideRender = true; return route.abort('failed'); }
      state.hideRender = false; return send(state.submitted);
    }
    if (path === '/jobs/render-1/retry') { const j = state.jobs.find(j => j.id === 'render-1')!; j.state = 'queued'; j.retryable = false; return send(j); }
    if (path === '/jobs/plan-1/cancel') {
      if (state.loseCancelReceipt) { state.loseCancelReceipt = false; return route.abort('failed'); }
      const j = state.jobs.find(j => j.id === 'plan-1')!; Object.assign(j, { state: 'cancelled', stage: 'cancelled', cancellable: false, retryable: true, updatedAt: 'cancelled' }); return send(j);
    }
    if (path === '/jobs/plan-1/retry') {
      const j = state.jobs.find(j => j.id === 'plan-1')!;
      expect(j.state).toBe('cancelled'); Object.assign(j, { state: 'complete', stage: 'waiting_for_effects_render', retryable: false, cancellable: true });
      state.jobs.unshift({ ...plan(), id: 'render-1', kind: 'effects-render', planJobId: j.id, planHash, state: 'queued', output: undefined }); return send(j);
    }
    return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ detail: `Unexpected fixture request ${path}` }) });
  });
}
async function open(page: Page, state: Fixture) { await api(page, state); await page.goto('/video/studio?project=effects-project'); await expect(page.getByRole('button', { name: state.project.name, exact: true })).toBeVisible(); }

test('exact derived source → automatic plan/render → explicit effects version keeps original cuts and refreshes', async ({ page }) => {
  const state: Fixture = { project: project(), jobs: [], writes: [] }, before = structuredClone(state.project), errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message)); await open(page, state);
  await expect(page.getByRole('button', { name: '模式 3 · 代码动画', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '资产库', exact: true }).click();
  const tile = page.locator('.studio-asset-tile').filter({ has: page.locator('b', { hasText: 'derived.mp4' }) });
  await tile.getByRole('button', { name: 'Opus 特效员', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '模式 4 · Opus 特效员' });
  await expect(dialog.getByLabel('特效源视频', { exact: true })).toHaveValue('derived');
  await expect(dialog.getByLabel('特效源视频', { exact: true }).locator('option')).toHaveCount(3);
  await dialog.getByRole('button', { name: '柔光氛围' }).click(); await dialog.getByRole('button', { name: '制作特效版', exact: true }).click();
  await expect(dialog).not.toBeVisible(); expect(state.writes.filter(w => w.path.endsWith('/effects-plans'))[0].data).toMatchObject({ sourceAssetId: derived.id, sourceHash: derived.hash });
  expect(state.writes.filter(w => w.path.endsWith('/effects-renders'))).toHaveLength(0);
  Object.assign(state.jobs.find(j => j.id === 'plan-1')!, plan());
  await expect.poll(() => state.writes.filter(w => w.path.endsWith('/effects-renders')).length, { timeout: 15_000 }).toBe(1);
  await page.locator('.studio-jobs > details > summary').click();
  Object.assign(state.submitted!, { state: 'running', stage: 'effects-frames', progress: .4 });
  await expect(page.locator('.studio-jobs')).toContainText('阶段：绘制特效帧', { timeout: 15_000 });
  await page.getByText('结构化特效计划 · 1 层', { exact: true }).click(); await expect(page.locator('.studio-effects-plan')).toContainText('动作重点处柔光');
  const rendered = asset('effects', 'effects-compositor', 'derived', 'effects'), comparison = asset('effects-comparison', 'effects-compositor', 'derived', 'comparison');
  state.project.assets.push(rendered, comparison); state.project.revision++;
  Object.assign(state.submitted!, { state: 'complete', outputAssetId: rendered.id, outputAssetIds: [rendered.id, comparison.id], outputRevision: state.project.revision });
  await expect(page.locator('.studio-asset-tile').filter({ has: page.locator('b', { hasText: 'effects.mp4' }) })).toBeVisible({ timeout: 15_000 });
  expect(state.project.nodes).toEqual(before.nodes); expect(state.project.sequence).toEqual(before.sequence);
  await tile.getByRole('button', { name: '版本对比', exact: true }).click();
  const versions = page.getByRole('dialog', { name: '视频版本对比' }), video = versions.locator('video');
  await expect(video).toHaveAttribute('aria-busy', 'false'); await video.evaluate((v: HTMLVideoElement) => { v.currentTime = 1; }); await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.seeking)).toBe(false);
  await versions.getByRole('button', { name: 'Opus 特效版', exact: true }).click(); await expect(video).toHaveAttribute('aria-busy', 'false'); expect(await video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(1, 1);
  await expect(versions.getByRole('link', { name: '下载当前版本' })).toHaveAttribute('href', rendered.url);
  await versions.getByRole('button', { name: '特效前后同步对比' }).click(); await expect(video).toHaveAttribute('aria-busy', 'false'); await expect(versions.getByRole('button', { name: '使用此版本' })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: resolve(output, 'effects-versions-mobile.png') });
  await versions.getByRole('button', { name: 'Opus 特效版', exact: true }).click(); await expect(video).toHaveAttribute('aria-busy', 'false'); await versions.getByRole('button', { name: '使用此版本' }).click();
  await expect.poll(() => state.project.nodes[0].assetId).toBe(rendered.id); expect(state.project.sequence.clips[0]).toEqual({ ...before.sequence.clips[0], assetId: rendered.id }); expect(state.project.assets.find(a => a.id === derived.id)).toEqual(before.assets[1]);
  await page.reload(); await expect(page.locator('.studio-card video')).toHaveAttribute('src', rendered.url);
  expect(state.writes.filter(w => w.path.endsWith('/effects-plans'))).toHaveLength(1); expect(state.writes.filter(w => w.path.endsWith('/effects-renders'))).toHaveLength(1); expect(errors).toEqual([]);
});

test('refresh recovers a lost render receipt with the same key and never requests another plan', async ({ page }) => {
  const state: Fixture = { project: project(), jobs: [plan()], writes: [], loseRenderReceipt: true }; await open(page, state);
  await expect(page.locator('.studio-error[role=alert]')).toContainText('Failed to fetch');
  const first = state.writes.filter(w => w.path.endsWith('/effects-renders')); expect(first).toHaveLength(1);
  await page.reload(); await expect.poll(() => state.writes.filter(w => w.path.endsWith('/effects-renders')).length).toBe(2);
  expect(state.writes.filter(w => w.path.endsWith('/effects-renders'))[1].data.idempotencyKey).toBe(first[0].data.idempotencyKey);
  expect(state.jobs.filter(j => j.kind === 'effects-render')).toHaveLength(1); expect(state.writes.filter(w => w.path.endsWith('/effects-plans'))).toHaveLength(0);
  await page.reload(); await expect(page.getByRole('button', { name: state.project.name, exact: true })).toBeVisible(); await expect.poll(() => state.writes.filter(w => w.path.endsWith('/effects-renders')).length).toBe(2);
});

for (const status of ['failed', 'uncertain', 'cancelled'] as const) test(`existing ${status} effects render is not automatically resubmitted`, async ({ page }) => {
  const render: StudioJob = { ...plan(), id: 'render-1', kind: 'effects-render', planJobId: 'plan-1', planHash, state: status, retryable: status === 'failed' };
  const state: Fixture = { project: project(), jobs: [plan(), render], writes: [] }; await open(page, state);
  await page.locator('.studio-jobs > details > summary').click(); await expect(page.locator('.studio-jobs')).toContainText('特效合成');
  await expect(page.getByRole('button', { name: '继续制作特效版' })).toHaveCount(0);
  if (status === 'failed') { await page.getByRole('button', { name: '恢复失败阶段' }).click(); expect(state.writes.map(w => w.path)).toEqual(['/jobs/render-1/retry']); }
  expect(state.writes.filter(w => w.path.endsWith('/effects-renders') || w.path.endsWith('/effects-plans'))).toHaveLength(0);
});

test('stale plan source hash blocks composition and readonly demos cannot plan', async ({ page }) => {
  const state: Fixture = { project: project(), jobs: [{ ...plan(), sourceHash: 'changed' }], writes: [] }; await open(page, state);
  await expect(page.locator('.studio-error[role=alert]')).toContainText('源视频已变更'); expect(state.writes).toHaveLength(0);
  state.project.access = { readOnly: true, canCopy: true }; await page.reload();
  await page.getByRole('button', { name: '模式 4 · Opus 特效员', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '模式 4 · Opus 特效员' }); await dialog.getByRole('button', { name: '柔光氛围' }).click();
  await expect(dialog.getByRole('button', { name: '制作特效版' })).toBeDisabled(); await expect(dialog).toContainText('此示例只读'); expect(state.writes).toHaveLength(0);
});

test('same-name exporter siblings remain distinguishable and preview the exact chosen asset', async ({ page }) => {
  const state: Fixture = { project: project(), jobs: [], writes: [] };
  const sibling = asset('three-original', 'three-webgl'); sibling.name = 'base.mp4';
  state.project.assets[0].name = 'base.mp4'; state.project.assets.push(sibling);
  await open(page, state);
  await page.getByRole('button', { name: '模式 4 · Opus 特效员', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '模式 4 · Opus 特效员' }), source = dialog.getByLabel('特效源视频', { exact: true });
  await expect(source.locator(`option[value="${original.id}"]`)).toHaveText('Remotion 原版 · base.mp4');
  await expect(source.locator(`option[value="${sibling.id}"]`)).toHaveText('Three 原版 · base.mp4');
  await source.selectOption(sibling.id);
  await expect(dialog.getByLabel('特效源视频预览')).toHaveAttribute('src', sibling.url);
  await expect(dialog.locator('.studio-effects-source')).toContainText('使用此版本：Three 原版 · base.mp4');
  await source.selectOption(derived.id);
  await expect(dialog.getByLabel('特效源视频预览')).toHaveAttribute('src', derived.url);
  await expect(dialog.locator('.studio-effects-source')).toContainText('使用此版本：DLSS 5 版（Remotion） · derived.mp4');
  expect(state.writes).toHaveLength(0);
  await page.screenshot({ path: resolve(output, 'same-name-source-selection.png') });
});

test('Mode 4 defaults to verified AI original over earlier code assets and submits that exact source', async ({ page }) => {
  const state: Fixture = { project: project(), jobs: [], writes: [] }, ai = aiOriginal();
  const oldShot = { ...aiOriginal(), id: 'old-ai-shot', name: '旧分镜.mp4', createdAt: '2026-10-02T01:00:00Z' }; ai.createdAt = '2026-10-08T10:00:00Z';
  const forged = asset('pretend-ai', 'provider'); forged.metadata = { ...forged.metadata, model: 'seedance', effectsSource: ai.effectsSource, jobId: 'forged' };
  state.project.assets.unshift(oldShot); state.project.assets.push(forged, ai); await open(page, state);
  await page.getByRole('button', { name: '模式 4 · Opus 特效员', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '模式 4 · Opus 特效员' }), source = dialog.getByLabel('特效源视频', { exact: true });
  await expect(source).toHaveValue(ai.id);
  expect(await source.locator('optgroup').evaluateAll(groups => groups.map(group => group.getAttribute('label')))).toEqual(['AI 原版', '代码动画', '派生版本']);
  await expect(source.locator(`option[value="${forged.id}"]`)).toHaveCount(0);
  await expect(source.locator(`option[value="${ai.id}"]`)).toHaveText('AI 原版 · ai-original.mp4');
  await expect(dialog.getByLabel('特效源视频预览')).toHaveAttribute('src', ai.url);
  await expect(dialog).toContainText('AI 视频模型生成的成片');
  await dialog.getByRole('button', { name: '柔光氛围' }).click();
  await page.screenshot({ path: resolve(output, 'ai-original-default-selection.png') });
  await dialog.getByRole('button', { name: '制作特效版', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(state.writes.map(w => w.path)).toEqual(['/projects/effects-project/effects-plans']);
  expect(state.writes[0].data).toMatchObject({ sourceAssetId: ai.id, sourceHash: ai.hash });
});

test('explicit code or derived selection wins over AI default and unverified uploads remain unavailable', async ({ page }) => {
  const state: Fixture = { project: project(), jobs: [], writes: [] }; state.project.assets.push(aiOriginal()); await open(page, state);
  await page.getByRole('button', { name: '资产库', exact: true }).click();
  const tile = page.locator('.studio-asset-tile').filter({ has: page.locator('b', { hasText: /^derived\.mp4$/ }) });
  await tile.getByRole('button', { name: 'Opus 特效员', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '模式 4 · Opus 特效员' }), source = dialog.getByLabel('特效源视频', { exact: true });
  await expect(source).toHaveValue(derived.id); await expect(dialog.getByLabel('特效源视频预览')).toHaveAttribute('src', derived.url);
  await source.selectOption(original.id); await expect(source).toHaveValue(original.id);
  await expect(dialog.getByLabel('特效源视频预览')).toHaveAttribute('src', original.url);
  await expect(source.locator('option[value="uploaded"]')).toHaveCount(0);
  expect(state.writes).toHaveLength(0);
  await dialog.getByRole('button', { name: '关闭特效员' }).click();
  await page.locator('.react-flow__node[data-id="video-node"] .studio-card-label').click();
  await expect(page.locator('.react-flow__node[data-id="video-node"] .studio-card')).toHaveClass(/is-selected/);
  await page.locator('.studio-top-actions').getByRole('button', { name: '模式 4 · Opus 特效员', exact: true }).click();
  await expect(source).toHaveValue(derived.id);
  expect(state.writes).toHaveLength(0);
});

test('an explicitly selected unverified video never silently switches to the AI default', async ({ page }) => {
  const state: Fixture = { project: project(), jobs: [], writes: [] }; state.project.assets.push(aiOriginal()); state.project.nodes[0].assetId = 'uploaded';
  await open(page, state); await page.locator('.react-flow__node[data-id="video-node"] .studio-card-label').click();
  await expect(page.locator('.react-flow__node[data-id="video-node"] .studio-card')).toHaveClass(/is-selected/);
  await page.locator('.studio-top-actions').getByRole('button', { name: '模式 4 · Opus 特效员', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '模式 4 · Opus 特效员' });
  await expect(dialog.getByLabel('特效源视频', { exact: true })).toHaveValue('');
  await expect(dialog.getByRole('alert')).toContainText('指定的视频来源不可用');
  await dialog.getByRole('button', { name: '柔光氛围' }).click(); await expect(dialog.getByRole('button', { name: '制作特效版' })).toBeDisabled();
  expect(state.writes).toHaveLength(0);
});

test('AI effects return to the exact no-narration original instead of its older narrated export', async ({ page }) => {
  const state: Fixture = { project: project(), jobs: [], writes: [] }, narrated = aiOriginal(), silent = asset('no-narration', 'verified-media-import', narrated.id), effect = asset('ai-effects', 'effects-compositor', silent.id, 'effects');
  narrated.name = '旧含旁白导出.mp4'; silent.name = '无旁白AI原版.mp4';
  silent.effectsSource = { kind: 'ai-original', rootKind: 'ai-original', sourceHash: silent.hash };
  effect.effectsSource = { kind: 'derived', rootKind: 'ai-original', sourceHash: effect.hash };
  state.project.assets.push(narrated, silent, effect); await open(page, state);
  await page.getByRole('button', { name: '资产库', exact: true }).click();
  const tile = (name: string) => page.locator('.studio-asset-tile').filter({ has: page.locator('b', { hasText: name }) });
  for (const entry of [silent, effect]) {
    await tile(entry.name).getByRole('button', { name: '版本对比', exact: true }).click();
    const versions = page.getByRole('dialog', { name: '视频版本对比' }), video = versions.locator('video');
    await expect(video).toHaveAttribute('src', entry.url); await expect(video).toHaveAttribute('aria-busy', 'false');
    await video.evaluate((v: HTMLVideoElement) => { v.currentTime = 1; }); await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.seeking)).toBe(false);
    await expect(versions.getByRole('button', { name: narrated.name, exact: true })).toBeVisible();
    await expect(versions.getByRole('button', { name: '原版', exact: true })).toHaveCount(1);
    await versions.getByRole('button', { name: '原版', exact: true }).click();
    await expect(video).toHaveAttribute('src', silent.url); await expect(video).toHaveAttribute('aria-busy', 'false');
    expect(await video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(1, 1);
    await expect(versions.getByRole('link', { name: '下载当前版本' })).toHaveAttribute('href', silent.url);
    await versions.getByRole('button', { name: '关闭版本对比' }).click();
  }
  expect(state.writes).toHaveLength(0);
});

test('cancel a completed waiting plan, refresh, and explicitly resume only its free handoff', async ({ page }) => {
  const state: Fixture = { project: project(), jobs: [{ ...plan(), stage: 'waiting_for_effects_render', cancellable: true }], writes: [], effectsAvailable: false };
  await open(page, state); await page.locator('.studio-jobs > details > summary').click();
  await expect(page.locator('.studio-jobs')).toContainText('等待特效合成服务');
  await page.getByRole('button', { name: '取消后续合成', exact: true }).click();
  await expect(page.getByRole('button', { name: '恢复后续合成', exact: true })).toBeVisible();
  state.effectsAvailable = true; await page.reload(); await page.locator('.studio-jobs > details > summary').click();
  await expect(page.getByRole('button', { name: '恢复后续合成', exact: true })).toBeVisible();
  expect(state.writes.map(w => w.path)).toEqual(['/jobs/plan-1/cancel']);
  await page.getByRole('button', { name: '恢复后续合成', exact: true }).click();
  await expect(page.locator('.studio-toast[role=status]')).toContainText('不会重新请求模型');
  await expect(page.locator('.studio-jobs')).toContainText('合成任务：排队中', { timeout: 15_000 });
  expect(state.writes.map(w => w.path)).toEqual(['/jobs/plan-1/cancel', '/jobs/plan-1/retry']);
  expect(state.jobs.filter(j => j.kind === 'effects-render')).toHaveLength(1);
  expect(await page.evaluate(() => localStorage.getItem('studio-v3-effects-cancel:effects-project:plan-1'))).toBeNull();
});

test('lost cancellation response keeps local intent across refresh and never auto-starts composition', async ({ page }) => {
  const state: Fixture = { project: project(), jobs: [{ ...plan(), stage: 'waiting_for_effects_render', cancellable: true }], writes: [], effectsAvailable: false, loseCancelReceipt: true };
  await open(page, state); await page.locator('.studio-jobs > details > summary').click(); await page.getByRole('button', { name: '取消后续合成', exact: true }).click();
  await expect(page.locator('.studio-error[role=alert]')).toContainText('Failed to fetch');
  state.effectsAvailable = true; await page.reload(); await page.locator('.studio-jobs > details > summary').click();
  // Even a stale server snapshot reporting complete must not override local cancellation intent.
  await expect(page.getByRole('button', { name: '取消后续合成', exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('studio-v3-effects-cancel:effects-project:plan-1'))).toBe('1');
  await page.getByRole('button', { name: '取消后续合成', exact: true }).click();
  await expect(page.getByRole('button', { name: '恢复后续合成', exact: true })).toBeVisible();
  expect(state.writes.map(w => w.path)).toEqual(['/jobs/plan-1/cancel', '/jobs/plan-1/cancel']);
});
