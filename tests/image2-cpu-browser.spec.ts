import { expect, test, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import type { ImageAsset, ImageDocument, ImageJob } from '../lib/image2/types';
const require = createRequire(import.meta.url);
const sharp = require('../services/image2/node_modules/sharp');
const { Resvg } = require('../services/image2/node_modules/@resvg/resvg-js');
const output = fileURLToPath(new URL('../../output/image2-browser-nonai-20261012/', import.meta.url));
const W = 96, H = 64;
type Evidence = { title: string; jobs: ImageJob[]; requests: Array<Record<string, unknown>>; external: string[]; publicStaticRequests: string[]; pageErrors: string[]; assertions: string[]; [key: string]: unknown };
const evidence = new WeakMap<Page, Evidence>();
test.beforeEach(async ({ page }, info) => {
  const entry: Evidence = { title: info.title, jobs: [], requests: [], external: [], publicStaticRequests: [], pageErrors: [], assertions: [], browserVersion: page.context().browser()?.version() }; evidence.set(page, entry);
  page.on('pageerror', err => entry.pageErrors.push(err.message));
  page.on('request', req => { const url = req.url(); if (/^https?:/.test(url) && new URL(url).hostname !== '127.0.0.1') { if (new URL(url).hostname === 'cdn.tldraw.com') entry.publicStaticRequests.push(url); else entry.external.push(url); } });
  page.on('response', response => { if (response.url().includes('/api/v3/image2')) entry.requests.push({ path: new URL(response.url()).pathname, method: response.request().method(), status: response.status() }); });
});
test.afterEach(async ({ page }, info) => {
  const entry = evidence.get(page)!; await mkdir(output, { recursive: true });
  const auditResponse = await page.request.get('http://127.0.0.1:18108/__test-audit'); if (auditResponse.ok()) { const audit = await auditResponse.json(); entry.providerExternalAttempts = audit.externalAttempts.length; }
  await expect.poll(async () => (await page.locator('.i2-jobs article > span').allTextContents()).every(text => !['等待中', '处理中'].includes(text)), { timeout: 5000 }).toBe(true).catch(() => {});
  const safe = info.title.replace(/[^a-z0-9_-]+/gi, '-').toLowerCase();
  await page.screenshot({ path: `${output}/${safe}.png`, fullPage: true }).catch(() => {});
  const verificationErrors: string[] = [];
  for (const job of entry.jobs) for (const field of ['generationCalls', 'llmCalls', 'visionCalls'] as const) if (job.metrics?.[field] !== 0) verificationErrors.push(`${job.id}:${field}=${job.metrics?.[field]}`);
  if (entry.external.length) verificationErrors.push('Unexpected external browser requests'); if (entry.pageErrors.length) verificationErrors.push('Uncaught browser errors'); if (entry.providerExternalAttempts !== 0) verificationErrors.push('Provider fetch attempt');
  const row = { ...entry, status: verificationErrors.length ? 'failed' : info.status, durationMs: info.duration, errors: [...info.errors.map(error => error.message), ...verificationErrors], screenshot: `${safe}.png` };
  let rows: Array<Record<string, unknown>> = []; try { rows = JSON.parse(await readFile(`${output}/matrix.json`, 'utf8')); } catch {}
  rows = [...rows.filter(item => item.title !== row.title), row]; await writeFile(`${output}/matrix.json`, JSON.stringify(rows, null, 2));
  await writeFile(`${output}/matrix.csv`, 'case,status,durationMs,jobs,generationCalls,llmCalls,visionCalls,externalRequests\n' + rows.map(item => {
    const jobs = item.jobs as ImageJob[]; return [JSON.stringify(item.title), item.status, item.durationMs, jobs.length, ...['generationCalls', 'llmCalls', 'visionCalls'].map(key => jobs.reduce((n, job) => n + Number(job.metrics?.[key as keyof NonNullable<ImageJob['metrics']>] || 0), 0)), (item.external as string[]).length].join(',');
  }).join('\n') + '\n');
  expect(verificationErrors).toEqual([]);
});
async function get<T>(page: Page, path: string): Promise<T> { const response = await page.request.get(`/api/v3/image2${path}`); expect(response.ok(), await response.text()).toBeTruthy(); return (await response.json()).data; }
async function doc(page: Page, id: string) { return get<ImageDocument>(page, `/documents/${id}`); }
function pattern(kind = 'gradient') { const raw = Buffer.alloc(W * H * 4); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const at = (y * W + x) * 4; const rgb = kind === 'dots' ? ((x % 12 >= 4 && x % 12 <= 6 && y % 12 >= 4 && y % 12 <= 6) ? [0, 0, 0] : [255, 255, 255]) : kind === 'key' ? (x < W / 2 ? [255, 255, 255] : [20, 30, 40]) : kind === 'repair' ? ((Math.abs(x - 72) <= 2 && Math.abs(y - 32) <= 2) ? [20, 20, 20] : [230, 214, 180]) : [20 + x * 2, 40 + y * 2, (x + y) % 180];
  raw[at] = rgb[0]; raw[at + 1] = rgb[1]; raw[at + 2] = rgb[2]; raw[at + 3] = 255;
} return raw; }
async function fresh(page: Page, kind = 'gradient') {
  await page.goto('/image2'); await expect(page.getByRole('status')).not.toContainText('正在打开工作台', { timeout: 30000 });
  await page.getByRole('button', { name: '新设计', exact: true }).click(); await expect(page.getByTestId('image2-canvas')).toBeVisible();
  const raw = pattern(kind), source = await sharp(raw, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
  await page.locator('input[accept="image/*,.svg"]').setInputFiles({ name: `source-${kind}.png`, mimeType: 'image/png', buffer: source });
  await expect(page.getByRole('button', { name: `图 · source-${kind}.png`, exact: true })).toBeVisible();
  const documentId = await page.getByLabel('选择设计').inputValue(); await expect.poll(async () => (await doc(page, documentId)).layers.length).toBe(1);
  const current = await doc(page, documentId); const caps = await get<{ operations: Array<{ name: string; available: boolean }>; agent: { available: boolean } }>(page, '/capabilities');
  expect(caps.agent.available).toBe(false); for (const op of ['generate', 'inpaint', 'matting', 'segment', 'super_resolution']) expect(caps.operations.find(item => item.name === op)?.available).toBe(false);
  Object.assign(evidence.get(page)!, { documentId, sourceAssetId: current.layers[0].assetId, sourceHash: (await get<Array<{ id: string; hash: string }>>(page, `/documents/${documentId}/assets`)).find(a => a.id === current.layers[0].assetId)?.hash, capabilities: caps });
  await expect(page.locator(`.tl-shape[data-shape-id="shape:${current.layers[0].id}"]`)).toBeAttached();
  await page.getByRole('button', { name: `图 · source-${kind}.png`, exact: true }).click(); await expect(page.getByLabel('图片处理')).toBeVisible();
  return { documentId, layerId: current.layers[0].id, raw, source };
}
async function number(page: Page, label: string, value: number, exact = true) { const input = page.getByRole('spinbutton', { name: label, exact }); await input.fill(String(value)); await input.blur(); }
async function color(page: Page, label: string, value: string) { await page.getByLabel(label, { exact: true }).evaluate((element: HTMLInputElement, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, v); element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true })); }, value); }
async function run(page: Page, id: string, operation: string, button: string) {
  const before = new Set((await get<ImageJob[]>(page, `/documents/${id}/jobs`)).map(j => j.id));
  await page.getByRole('button', { name: button, exact: true }).click(); let job: ImageJob | undefined;
  await expect.poll(async () => { job = (await get<ImageJob[]>(page, `/documents/${id}/jobs`)).find(j => j.operation === operation && !before.has(j.id)); return job && ['complete', 'failed', 'uncertain', 'cancelled', 'awaiting_user'].includes(job.state) ? job.state : 'waiting'; }, { timeout: 40000 }).toBe('complete');
  evidence.get(page)!.jobs.push(job!); expect(job!.metrics?.generationCalls).toBe(0); expect(job!.metrics?.llmCalls).toBe(0); expect(job!.metrics?.visionCalls).toBe(0);
  await expect.poll(async () => (await doc(page, id)).layers.some(l => l.assetId === job!.output?.assetId)).toBe(true); return job!;
}
async function assetRaw(page: Page, assetId: string) { const response = await page.request.get(`/api/v3/image2/assets/${assetId}/content`); expect(response.ok()).toBeTruthy(); return sharp(await response.body()).ensureAlpha().raw().toBuffer({ resolveWithObject: true }); }
function pixel(raw: Buffer, width: number, x: number, y: number) { return [...raw.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)]; }
async function masks(page: Page, protect = true) {
  await page.getByRole('button', { name: /选择修改 \/ 保护范围/ }).click(); await expect(page.getByRole('button', { name: '保存范围', exact: true })).toBeEnabled();
  await page.getByLabel('遮罩画笔尺寸').evaluate((e: HTMLInputElement) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(e, '14'); e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); });
  const box = (await page.locator('.i2-mask-canvas').boundingBox())!; const click = (x: number, y: number) => page.mouse.click(box.x + x * box.width / W, box.y + y * box.height / H);
  await click(24, 32); await click(72, 32); if (protect) { await page.getByRole('button', { name: '保护范围', exact: true }).click(); await click(24, 32); }
  await page.getByRole('button', { name: '保存范围', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0);
}
const cases = [
  { op: 'crop', button: '裁切', params: { '像素宽': 40, '像素高': 30, x: 11, y: 7 }, width: 40, height: 30 },
  { op: 'pad', button: '扩展画布', params: { '像素宽': 120, '像素高': 90 }, width: 120, height: 90 },
  { op: 'rotate', button: '旋转像素', params: { '角度': 90 }, width: H, height: W },
  { op: 'flip', name: 'flip-horizontal', button: '翻转', width: W, height: H },
  { op: 'flip', name: 'flip-vertical', button: '翻转', width: W, height: H },
  { op: 'resize', button: '调整像素尺寸', params: { '像素宽': 192, '像素高': 128 }, width: 192, height: 128 },
  { op: 'color_key', button: '纯色去底', kind: 'key', width: W, height: H },
  { op: 'recolor', button: '换色并保留明暗', mask: true, width: W, height: H },
  { op: 'erase', button: '清除为透明', mask: true, width: W, height: H },
  { op: 'fill', button: '局部填色', mask: true, width: W, height: H },
  { op: 'repair', button: '传统修补', kind: 'repair', mask: true, width: W, height: H },
];
for (const scenario of cases) test(`CPU ${scenario.name || scenario.op}: real click, asset and pixels`, async ({ page }) => {
  const { documentId, layerId, raw } = await fresh(page, scenario.kind); if (scenario.mask) await masks(page);
  await page.getByLabel('图片处理').selectOption(scenario.op);
  for (const [label, value] of Object.entries(scenario.params || {})) {
    const input = ['x', 'y'].includes(label) ? page.locator('.i2-operation-panel').getByRole('spinbutton', { name: label, exact: true }) : page.getByRole('spinbutton', { name: label, exact: true }); await input.fill(String(value));
  }
  if (scenario.name === 'flip-vertical') await page.locator('.i2-operation-panel select').last().selectOption('vertical');
  if (['pad', 'fill', 'recolor'].includes(scenario.op)) await color(page, '处理颜色', '#168a55');
  if (scenario.op === 'color_key') { await color(page, '处理颜色', '#ffffff'); await number(page, '颜色容差', 0); }
  const job = await run(page, documentId, scenario.op, scenario.button); const result = await assetRaw(page, String(job.output!.assetId));
  expect([result.info.width, result.info.height]).toEqual([scenario.width, scenario.height]); expect([job.output!.width, job.output!.height]).toEqual([scenario.width, scenario.height]);
  const layer = (await doc(page, documentId)).layers.find(l => l.id === layerId)!; expect(layer.assetId).toBe(job.output!.assetId);
  if (scenario.op === 'resize') expect([layer.width, layer.height]).toEqual([W, H]);
  if (scenario.op === 'crop') { for (let y = 0; y < 30; y++) for (let x = 0; x < 40; x++) expect(pixel(result.data, 40, x, y)).toEqual(pixel(raw, W, x + 11, y + 7)); }
  if (scenario.op === 'pad') { expect(pixel(result.data, 120, 0, 0)).toEqual([22, 138, 85, 255]); expect(pixel(result.data, 120, 12, 13)).toEqual(pixel(raw, W, 0, 0)); }
  if (scenario.op === 'rotate') expect(pixel(result.data, H, H - 1, 0)).toEqual(pixel(raw, W, 0, 0));
  if (scenario.op === 'flip') { for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) expect(pixel(result.data, W, x, y)).toEqual(pixel(raw, W, scenario.name === 'flip-horizontal' ? W - 1 - x : x, scenario.name === 'flip-vertical' ? H - 1 - y : y)); }
  if (scenario.op === 'color_key') { expect(pixel(result.data, W, 10, 10)[3]).toBe(0); expect(pixel(result.data, W, 80, 10)).toEqual([20, 30, 40, 255]); }
  if (scenario.mask) {
    expect(pixel(result.data, W, 24, 32)).toEqual(pixel(raw, W, 24, 32)); expect(pixel(result.data, W, 0, 0)).toEqual(pixel(raw, W, 0, 0));
    const edit = await assetRaw(page, String(layer.metadata!.editMaskAssetId)); const protect = await assetRaw(page, String(layer.metadata!.protectMaskAssetId)); let protectedDiff = 0, edited = 0;
    for (let i = 0; i < W * H; i++) { const off = i * 4; if (!edit.data[off + 3] || protect.data[off + 3]) { if (!result.data.subarray(off, off + 4).equals(raw.subarray(off, off + 4))) protectedDiff++; } else if (!result.data.subarray(off, off + 4).equals(raw.subarray(off, off + 4))) edited++; }
    expect(protectedDiff).toBe(0); expect(edited).toBeGreaterThan(0); Object.assign(evidence.get(page)!, { protectedDiff, editedPixels: edited });
    if (scenario.op === 'erase') expect(pixel(result.data, W, 72, 32)[3]).toBe(0);
    if (scenario.op === 'fill') expect(pixel(result.data, W, 72, 32)).toEqual([22, 138, 85, 255]);
    if (scenario.op === 'repair') expect(pixel(result.data, W, 72, 32)).toEqual([230, 214, 180, 255]);
  }
  evidence.get(page)!.assertions.push('Actual decoded dimensions and expected pixel mapping verified; generation/LLM/vision counters all zero.'); expect(evidence.get(page)!.pageErrors).toEqual([]); expect(evidence.get(page)!.external).toEqual([]);
});
for (const preset of ['monochrome', 'color']) test(`CPU trace-${preset}: retain small dots as editable SVG`, async ({ page }) => {
  const { documentId, layerId } = await fresh(page, 'dots'); await page.getByLabel('图片处理').selectOption('trace'); await page.locator('.i2-operation-panel select').last().selectOption(preset);
  const job = await run(page, documentId, 'trace', '转为矢量'); const layer = (await doc(page, documentId)).layers.find(l => l.id === layerId)!;
  expect(layer.type).toBe('vector'); const response = await page.request.get(`/api/v3/image2/assets/${job.output!.assetId}/content`); const svg = await response.text(); expect(svg).toContain('<path'); expect(svg).not.toContain('<image');
  const png = new Resvg(svg, { font: { loadSystemFonts: false } }).render().asPng(); const result = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let retained = 0, total = 0; for (let y = 5; y < H; y += 12) for (let x = 5; x < W; x += 12) { total++; if (Math.max(...pixel(result.data, W, x, y).slice(0, 3)) < 80) retained++; }
  expect(retained).toBe(total); await expect(page.locator('.i2-svg path')).toHaveCount((svg.match(/<path\b/g) || []).length); evidence.get(page)!.assertions.push(`${retained}/${total} three-pixel dots preserved; true SVG paths, no bitmap wrapper.`); Object.assign(evidence.get(page)!, { dots: { total, retained }, paths: (svg.match(/<path\b/g) || []).length });
});
test('CPU mask reopen and clear: saved protection survives a second edit', async ({ page }) => {
  const { documentId, layerId } = await fresh(page); await masks(page); let current = await doc(page, documentId); const layer = current.layers.find(l => l.id === layerId)!;
  const oldEdit = await assetRaw(page, String(layer.metadata!.editMaskAssetId)), oldProtect = await assetRaw(page, String(layer.metadata!.protectMaskAssetId));
  await page.getByRole('button', { name: /选择修改 \/ 保护范围/ }).click(); await expect(page.getByRole('button', { name: '保存范围', exact: true })).toBeEnabled();
  const displayed = await page.locator('.i2-mask-canvas').evaluate((e: HTMLCanvasElement) => [...e.getContext('2d')!.getImageData(24, 32, 1, 1).data]); expect(displayed[2]).toBeGreaterThan(pattern()[(32 * W + 24) * 4 + 2] + 20);
  await page.getByRole('button', { name: '保存范围', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0);
  current = await doc(page, documentId); const reopened = current.layers.find(l => l.id === layerId)!;
  expect((await assetRaw(page, String(reopened.metadata!.editMaskAssetId))).data).toEqual(oldEdit.data); expect((await assetRaw(page, String(reopened.metadata!.protectMaskAssetId))).data).toEqual(oldProtect.data);
  await page.getByRole('button', { name: /选择修改 \/ 保护范围/ }).click(); await expect(page.getByRole('button', { name: '保存范围', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '取消局部范围', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(async () => !!(await doc(page, documentId)).layers.find(l => l.id === layerId)?.metadata?.editMaskAssetId).toBe(false);
  await page.getByLabel('图片处理').selectOption('trace'); await run(page, documentId, 'trace', '转为矢量'); evidence.get(page)!.assertions.push('Reopening and saving preserves both masks; explicitly cancelling the local range restores global tracing.');
});
for (const op of ['crop', 'rotate', 'resize', 'trace']) test(`CPU chain mask-recolor then ${op}: no stale mask geometry`, async ({ page }) => {
  const { documentId } = await fresh(page); await masks(page); await page.getByLabel('图片处理').selectOption('recolor'); await color(page, '处理颜色', '#168a55'); await run(page, documentId, 'recolor', '换色并保留明暗');
  await page.getByLabel('图片处理').selectOption(op);
  if (['crop', 'resize'].includes(op)) { await number(page, '像素宽', 48); await number(page, '像素高', 32); }
  const names: Record<string, string> = { crop: '裁切', rotate: '旋转像素', resize: '调整像素尺寸', trace: '转为矢量' }; const job = await run(page, documentId, op, names[op]);
  if (op !== 'trace') { const r = await assetRaw(page, String(job.output!.assetId)); expect([r.info.width, r.info.height]).toEqual(op === 'rotate' ? [H, W] : [48, 32]); }
  evidence.get(page)!.assertions.push('Local-edit mask followed by a global geometry/tracing command completes using the current source.');
});
for (const first of ['crop', 'recolor', 'rotate', 'flip']) test(`CPU ${first} then refine_mask: retain current pixels and reversible visibility`, async ({ page }) => {
  const { documentId, layerId } = await fresh(page); await page.getByLabel('图片处理').selectOption(first);
  if (first === 'crop') { await number(page, '像素宽', 40); await number(page, '像素高', 30); const panel = page.locator('.i2-operation-panel'); await panel.getByRole('spinbutton', { name: 'x', exact: true }).fill('11'); await panel.getByRole('spinbutton', { name: 'y', exact: true }).fill('7'); }
  if (first === 'recolor') await color(page, '处理颜色', '#168a55');
  const names: Record<string, string> = { crop: '裁切', recolor: '换色并保留明暗', rotate: '旋转像素', flip: '翻转' }; const firstJob = await run(page, documentId, first, names[first]); const before = await assetRaw(page, String(firstJob.output!.assetId));
  for (const action of ['隐藏像素', '补回像素']) {
    await page.getByRole('button', { name: '修正图层轮廓', exact: true }).click(); await expect(page.getByRole('button', { name: '保存范围', exact: true })).toBeEnabled(); await page.getByRole('button', { name: action, exact: true }).click();
    // Cover the antialiased edge when revealing: source-over is not the mathematical
    // inverse of destination-out when the exact same fractional edge is painted twice.
    await page.getByLabel('遮罩画笔尺寸').evaluate((e: HTMLInputElement, brush) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(e, brush); e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); }, action === '隐藏像素' ? '4' : '14');
    const box = (await page.locator('.i2-mask-canvas').boundingBox())!; await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2); const oldIds = new Set((await get<ImageJob[]>(page, `/documents/${documentId}/jobs`)).map(j => j.id));
    await page.getByRole('button', { name: '保存范围', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0); let job: ImageJob | undefined;
    await expect.poll(async () => { job = (await get<ImageJob[]>(page, `/documents/${documentId}/jobs`)).find(j => j.operation === 'refine_mask' && !oldIds.has(j.id)); return job?.state; }).toBe('complete'); evidence.get(page)!.jobs.push(job!);
    const layer = (await doc(page, documentId)).layers.find(l => l.id === layerId)!; const after = await assetRaw(page, layer.assetId!); expect([after.info.width, after.info.height]).toEqual([before.info.width, before.info.height]);
    let outsideDiff = 0; for (let y = 0; y < before.info.height; y++) for (let x = 0; x < before.info.width; x++) if (Math.abs(x - before.info.width / 2) > 5 || Math.abs(y - before.info.height / 2) > 5) if (pixel(after.data, after.info.width, x, y).join() !== pixel(before.data, before.info.width, x, y).join()) outsideDiff++;
    expect(outsideDiff).toBe(0); const centerAlpha = pixel(after.data, after.info.width, Math.floor(after.info.width / 2), Math.floor(after.info.height / 2))[3]; expect(centerAlpha).toBe(action === '隐藏像素' ? 0 : 255);
    if (action === '补回像素') expect(after.data).toEqual(before.data); evidence.get(page)!.assertions.push(`${first} -> ${action}: outside decoded RGBA diff ${outsideDiff}.`);
  }
});

async function exportJob(page: Page, documentId: string, format: string) {
  const old = new Set((await get<ImageJob[]>(page, `/documents/${documentId}/jobs`)).map(j => j.id));
  await page.getByRole('button', { name: format === 'project' ? '可编辑工程 ZIP' : format.toUpperCase(), exact: true }).click(); let job: ImageJob | undefined;
  await expect.poll(async () => { job = (await get<ImageJob[]>(page, `/documents/${documentId}/jobs`)).find(j => j.kind === 'export' && !old.has(j.id)); return job?.state; }, { timeout: 45000 }).toBe('complete');
  evidence.get(page)!.jobs.push(job!); const r = await page.request.get(`/api/v3/image2/assets/${job!.output!.assetId}/content`); expect(r.ok()).toBeTruthy(); return { job: job!, bytes: await r.body() };
}
function assertFontAliases(svg: string, document: ImageDocument) {
  const fonts = new Set(document.layers.filter(layer => layer.type === 'text' && layer.metadata?.fontConfirmed && layer.visible).map(layer => layer.fontAssetId!));
  const aliases = [...fonts].map(id => `i2-font-${createHash('sha256').update(id).digest('hex').slice(0, 24)}`);
  for (const alias of aliases) { expect(svg).toContain(`font-family="${alias}"`); expect(svg).toContain(`font-family:'${alias}'`); }
  expect(new Set(aliases).size).toBe(fonts.size); return aliases;
}
test('CPU Chinese Logo layers: direct edits, grouping, stack, visibility, history, exports and native roundtrip', async ({ page }) => {
  const { documentId, layerId } = await fresh(page); await number(page, '画布宽', 600); await number(page, '画布高', 300);
  await page.getByRole('button', { name: '＋ 文字', exact: true }).click(); await page.getByRole('button', { name: '文 · 中文文字', exact: true }).click();
  await expect(page.getByLabel('文字内容')).toBeVisible(); await page.getByLabel('文字内容').fill('中文直接编辑\n保留 Logo'); await page.getByLabel('文字内容').blur();
  await number(page, '字号', 20); await number(page, '字距', 2); await number(page, '行距倍数', 1.4); await number(page, 'x', 5); await number(page, 'y', 5); await color(page, '填色', '#123456');
  await expect.poll(async () => (await doc(page, documentId)).layers.find(l => l.type === 'text')?.fill).toBe('#123456');
  const text = (await doc(page, documentId)).layers.find(l => l.type === 'text')!; expect(text.fontAssetId).toBeTruthy(); expect(text.metadata?.fontConfirmed).toBe(true);
  await expect(page.getByRole('spinbutton', { name: '字重', exact: true })).toHaveCount(0); expect(text.fontWeight).toBe(400);
  const beforeCount = (await get<ImageJob[]>(page, `/documents/${documentId}/jobs`)).length;
  for (const content of ['第二次改中文', '第三次改字保留品牌\n代码排版']) { await page.getByLabel('文字内容').fill(content); await page.getByLabel('文字内容').blur(); await expect.poll(async () => (await doc(page, documentId)).layers.find(l => l.id === text.id)?.text).toBe(content); }
  expect((await get<ImageJob[]>(page, `/documents/${documentId}/jobs`)).length).toBe(beforeCount);
  const logo = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40"><path id="mark" fill="#263645" d="M2 2H18V38H2Z"/><path id="secondary" fill="#d0aa33" d="M22 2H38V38H22Z"/></svg>');
  await page.locator('input[accept="image/*,.svg"]').setInputFiles({ name: 'two-path-logo.svg', mimeType: 'image/svg+xml', buffer: logo }); await page.getByRole('button', { name: '形 · two-path-logo.svg', exact: true }).click(); await expect(page.getByLabel('Logo 路径')).toBeVisible();
  await page.getByLabel('Logo 路径').selectOption('mark'); await color(page, 'Logo 填色', '#ee2222'); await color(page, 'Logo 描边', '#00aa44'); await number(page, '描边宽度', 2); await number(page, 'x', 230); await number(page, 'y', 30);
  await expect.poll(() => page.locator('.i2-svg path').first().evaluate(el => getComputedStyle(el).fill)).toBe('rgb(238, 34, 34)');
  await expect.poll(() => page.locator('.i2-svg path').last().evaluate(el => getComputedStyle(el).fill)).toBe('rgb(208, 170, 51)');
  let current = await doc(page, documentId); const vector = current.layers.find(l => l.name === 'two-path-logo.svg')!; const rawLogo = await page.request.get(`/api/v3/image2/assets/${vector.assetId}/content`); expect(await rawLogo.body()).toEqual(logo);
  await page.getByRole('button', { name: 'two-path-logo.svg隐藏', exact: true }).click(); await expect.poll(async () => (await doc(page, documentId)).layers.find(l => l.id === vector.id)?.visible).toBe(false);
  await page.getByRole('button', { name: 'two-path-logo.svg显示', exact: true }).click(); await expect.poll(async () => (await doc(page, documentId)).layers.find(l => l.id === vector.id)?.visible).toBe(true);
  await page.getByRole('button', { name: 'two-path-logo.svg锁定', exact: true }).click(); await expect.poll(async () => (await doc(page, documentId)).layers.find(l => l.id === vector.id)?.locked).toBe(true); await expect(page.getByRole('checkbox', { name: '选入组合 two-path-logo.svg', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'two-path-logo.svg解锁', exact: true }).click(); await expect.poll(async () => (await doc(page, documentId)).layers.find(l => l.id === vector.id)?.locked).toBe(false);
  await page.getByRole('button', { name: '下移一层', exact: true }).click(); await expect.poll(async () => (await doc(page, documentId)).layers.find(l => l.id === vector.id)!.z < (await doc(page, documentId)).layers.find(l => l.id === text.id)!.z).toBe(true);
  await page.getByRole('button', { name: '上移一层', exact: true }).click(); await expect.poll(async () => (await doc(page, documentId)).layers.find(l => l.id === vector.id)!.z > (await doc(page, documentId)).layers.find(l => l.id === text.id)!.z).toBe(true);
  await page.getByRole('checkbox', { name: '选入组合 中文文字', exact: true }).check(); await page.getByRole('checkbox', { name: '选入组合 two-path-logo.svg', exact: true }).check(); await page.getByRole('button', { name: '编组所选图层', exact: true }).click();
  await expect.poll(async () => (await doc(page, documentId)).layers.some(l => l.type === 'group')).toBe(true); await number(page, 'rotation', 20);
  await expect.poll(async () => (await doc(page, documentId)).layers.find(l => l.type === 'group')?.rotation).toBe(20); const groupedPng = await exportJob(page, documentId, 'png');
  await page.getByRole('button', { name: '拆开组合', exact: true }).click(); await expect.poll(async () => (await doc(page, documentId)).layers.some(l => l.type === 'group')).toBe(false); const ungroupedPng = await exportJob(page, documentId, 'png');
  expect((await sharp(ungroupedPng.bytes).ensureAlpha().raw().toBuffer())).toEqual(await sharp(groupedPng.bytes).ensureAlpha().raw().toBuffer());
  await page.getByRole('button', { name: '形 · two-path-logo.svg', exact: true }).click(); await page.getByLabel('图层名称').fill('Logo 保留'); await page.getByLabel('图层名称').blur(); await expect.poll(async () => (await doc(page, documentId)).layers.find(l => l.id === vector.id)?.name).toBe('Logo 保留');
  await page.getByRole('button', { name: '撤销', exact: true }).click(); await expect.poll(async () => (await doc(page, documentId)).layers.find(l => l.id === vector.id)?.name).toBe('two-path-logo.svg'); await page.getByRole('button', { name: '重做', exact: true }).click(); await expect.poll(async () => (await doc(page, documentId)).layers.find(l => l.id === vector.id)?.name).toBe('Logo 保留');
  const localFaces = [{ path: process.env.IMAGE2_BROWSER_REGULAR_FONT || '/System/Library/Fonts/Supplemental/Arial.ttf', weight: 400, name: 'ASCII Regular', y: 180 }, { path: process.env.IMAGE2_BROWSER_BOLD_FONT || '/System/Library/Fonts/Supplemental/Arial Bold.ttf', weight: 700, name: 'ASCII Bold', y: 220 }];
  const haveLocalFaces = await Promise.all(localFaces.map(face => access(face.path).then(() => true).catch(() => false))).then(values => values.every(Boolean));
  if (haveLocalFaces) {
    const actualFaces: Array<Record<string, unknown>> = [];
    for (const face of localFaces) {
      await page.locator('input[accept=".ttf,.otf,.woff,.woff2"]').setInputFiles(face.path); await page.getByRole('button', { name: '＋ 文字', exact: true }).click();
      await expect.poll(async () => (await doc(page, documentId)).layers.filter(layer => layer.name === '中文文字').length).toBe(2);
      // Select the new second "中文文字" row by its current stable layer ID from the API.
      let added = (await doc(page, documentId)).layers.filter(layer => layer.name === '中文文字').find(layer => layer.id !== text.id)!;
      await page.getByRole('button', { name: '文 · 中文文字', exact: true }).first().click();
      await page.getByLabel('图层名称').fill(face.name); await page.getByLabel('图层名称').blur(); await expect.poll(async () => (await doc(page, documentId)).layers.find(layer => layer.id === added.id)?.name).toBe(face.name);
      await page.getByLabel('文字内容').fill('Same Family Actual Font'); await page.getByLabel('文字内容').blur(); await expect.poll(async () => (await doc(page, documentId)).layers.find(layer => layer.id === added.id)?.text).toBe('Same Family Actual Font');
      const fonts = await get<ImageAsset[]>(page, `/documents/${documentId}/assets`), font = fonts.find(asset => asset.name === face.path.split('/').pop())!; expect(font.metadata?.weight).toBe(face.weight);
      await page.getByLabel('确认字体').selectOption(font.id); await expect.poll(async () => (await doc(page, documentId)).layers.find(layer => layer.id === added.id)?.fontAssetId).toBe(font.id);
      await number(page, '字号', 18); await number(page, 'x', 130); await number(page, 'y', face.y); added = (await doc(page, documentId)).layers.find(layer => layer.id === added.id)!; expect(added.fontWeight).toBe(face.weight);
      await expect.poll(async () => page.evaluate(({ id, weight }) => Array.from(document.fonts).some(face => face.family === `i2-${id}` && face.status === 'loaded' && face.weight === String(weight)), { id: font.id, weight: face.weight })).toBe(true);
      actualFaces.push({ assetId: font.id, family: font.metadata?.family, weight: added.fontWeight, hash: font.hash, layerId: added.id });
    }
    expect(actualFaces[0].family).toBe(actualFaces[1].family); expect(actualFaces[0].assetId).not.toBe(actualFaces[1].assetId); evidence.get(page)!.actualFontFaces = actualFaces;
  }
  const finalPng = haveLocalFaces ? await exportJob(page, documentId, 'png') : ungroupedPng;
  const svg = await exportJob(page, documentId, 'svg'), pdf = await exportJob(page, documentId, 'pdf'), zip = await exportJob(page, documentId, 'project');
  evidence.get(page)!.fontAliases = assertFontAliases(svg.bytes.toString(), await doc(page, documentId));
  await writeFile(`${output}/cpu-chinese-logo-export.svg`, svg.bytes); await writeFile(`${output}/cpu-chinese-logo-export.pdf`, pdf.bytes); await writeFile(`${output}/cpu-chinese-logo-export.png`, finalPng.bytes); await writeFile(`${output}/cpu-chinese-logo-export.zip`, zip.bytes);
  expect(svg.bytes.toString()).toContain('<path'); expect(svg.bytes.toString()).toContain('第三次改字保留品牌'); expect(pdf.bytes.subarray(0, 5).toString()).toBe('%PDF-'); expect(zip.bytes.subarray(0, 2).toString()).toBe('PK');
  current = await doc(page, documentId); await page.reload(); await expect(page.getByTestId('image2-canvas')).toBeVisible(); await expect(page.getByRole('button', { name: '形 · Logo 保留', exact: true })).toBeVisible();
  await page.locator('input[accept=".zip"]').setInputFiles({ name: 'real-cpu-roundtrip.zip', mimeType: 'application/zip', buffer: zip.bytes }); await expect.poll(async () => (await page.getByLabel('选择设计').inputValue()) !== documentId).toBe(true);
  const importedId = await page.getByLabel('选择设计').inputValue(); const imported = await doc(page, importedId); expect(imported.layers.length).toBe(current.layers.length); expect(imported.layers.find(l => l.type === 'text')?.text).toBe(current.layers.find(l => l.type === 'text')?.text); expect(imported.layers.find(l => l.type === 'vector')?.metadata?.pathStyles).toEqual(current.layers.find(l => l.type === 'vector')?.metadata?.pathStyles);
  const roundPng = await exportJob(page, importedId, 'png'); expect(await sharp(roundPng.bytes).ensureAlpha().raw().toBuffer()).toEqual(await sharp(finalPng.bytes).ensureAlpha().raw().toBuffer());
  expect(imported.layers.find(l => l.name === 'source-gradient.png')?.assetId).not.toBe(current.layers.find(l => l.id === layerId)?.assetId); evidence.get(page)!.assertions.push('Repeated Chinese text edits created zero jobs; actual uploaded SVG retained. Group rotation/ungroup and ZIP import preserve exact PNG pixels; SVG/PDF/ZIP have real format headers.');
});
for (const kind of ['poster', 'logo', 'print']) test(`CPU ${kind} template: code layout retains original and real fonts`, async ({ page }) => {
  const { documentId } = await fresh(page); const before = await doc(page, documentId); await page.getByLabel('模板版式').selectOption(kind); await page.getByRole('button', { name: '添加可编辑模板', exact: true }).click();
  await expect.poll(async () => (await doc(page, documentId)).layers.some(l => l.metadata?.template === kind)).toBe(true); const after = await doc(page, documentId);
  expect(after.layers.find(l => l.id === before.layers[0].id)).toEqual(before.layers[0]); expect(after.layers.filter(l => l.type === 'text' && l.metadata?.template === kind).every(l => l.fontAssetId && l.metadata?.fontConfirmed)).toBe(true);
  expect(await get<ImageJob[]>(page, `/documents/${documentId}/jobs`)).toHaveLength(0); const svg = await exportJob(page, documentId, 'svg'); evidence.get(page)!.fontAliases = assertFontAliases(svg.bytes.toString(), after); evidence.get(page)!.assertions.push('Template uses commands, existing image and immutable real font; zero image/LLM/vision tasks. SVG semantic text refers to its immutable font asset alias.');
});
test('CPU invalid crop and resize: explain failure and preserve original pixels', async ({ page }) => {
  const { documentId, layerId, raw } = await fresh(page); const original = await doc(page, documentId);
  for (const op of ['crop', 'resize']) {
    await page.getByLabel('图片处理').selectOption(op); await number(page, '像素宽', op === 'crop' ? 200 : 0); await number(page, '像素高', 30);
    const old = new Set((await get<ImageJob[]>(page, `/documents/${documentId}/jobs`)).map(j => j.id)); await page.getByRole('button', { name: op === 'crop' ? '裁切' : '调整像素尺寸', exact: true }).click(); let failed: ImageJob | undefined;
    await expect.poll(async () => { failed = (await get<ImageJob[]>(page, `/documents/${documentId}/jobs`)).find(j => j.operation === op && !old.has(j.id)); return failed?.state; }).toBe('failed');
    expect(failed!.error).toBeTruthy(); evidence.get(page)!.jobs.push(failed!); const current = await doc(page, documentId); expect(current.layers).toEqual(original.layers); expect(current.revision).toBe(original.revision);
    expect((await assetRaw(page, current.layers.find(l => l.id === layerId)!.assetId!)).data).toEqual(raw);
  }
  evidence.get(page)!.assertions.push('Invalid bounds/zero size create explicit failed jobs; no document revision or original decoded pixel change.');
});
test('CPU flattened text: simple background cleanup then editable Chinese without generation', async ({ page }) => {
  const { documentId, layerId, raw } = await fresh(page, 'repair'); await page.getByLabel('图层类型').selectOption('text');
  await page.getByLabel('文字内容').fill('新文字'); await page.getByLabel('文字内容').blur(); await expect.poll(async () => (await doc(page, documentId)).layers.find(l => l.id === layerId)?.metadata?.desiredText).toBe('新文字');
  const unknown = (await doc(page, documentId)).layers.find(l => l.id === layerId)!; expect(unknown.metadata?.fontConfirmed).toBe(false); expect((await assetRaw(page, unknown.assetId!)).data).toEqual(raw);
  await page.getByRole('button', { name: '使用内置中文字体', exact: true }).click(); await expect.poll(async () => (await doc(page, documentId)).layers.find(l => l.id === layerId)?.metadata?.fontConfirmed, { timeout: 30000 }).toBe(true);
  let current = await doc(page, documentId); const confirmed = current.layers.find(l => l.id === layerId)!, bg = current.layers.find(l => l.id === confirmed.metadata?.backgroundLayerId)!;
  expect(confirmed.text).toBe('新文字'); expect(confirmed.metadata?.backgroundDetached).toBe(true); expect(bg.metadata?.role).toBe('text_background');
  const clean = await assetRaw(page, bg.assetId!); expect(pixel(clean.data, W, 72, 32)).toEqual([230, 214, 180, 255]);
  await number(page, 'x', 20); await number(page, '字号', 18); await color(page, '填色', '#b03030'); await page.getByLabel('文字内容').fill('继续改字'); await page.getByLabel('文字内容').blur();
  await expect.poll(async () => (await doc(page, documentId)).layers.find(l => l.id === layerId)?.text).toBe('继续改字'); current = await doc(page, documentId); expect(current.layers.find(l => l.id === bg.id)).toEqual(bg);
  const jobs = await get<ImageJob[]>(page, `/documents/${documentId}/jobs`); expect(jobs.map(job => job.operation)).toEqual(['prepare_text']); evidence.get(page)!.jobs.push(...jobs); expect(jobs[0].metrics?.generationCalls).toBe(0);
  const svg = await exportJob(page, documentId, 'svg'); evidence.get(page)!.fontAliases = assertFontAliases(svg.bytes.toString(), current);
  evidence.get(page)!.assertions.push('Unknown lettering remains raw pixels until real font confirmation; simple old-glyph cleanup is CPU, and detached background stays stationary through later direct text edits.');
});
