import { expect, test, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { ImageDocument, ImageJob } from '../lib/image2/types';
const require = createRequire(import.meta.url), sharp = require('../services/image2/node_modules/sharp');
const output = resolve(process.env.IMAGE2_BROWSER_EVIDENCE_DIR || fileURLToPath(new URL('../../output/image2-original-ui-20261012/', import.meta.url)));
type Evidence = { title: string; requests: Array<{ path: string; method: string; status: number }>; jobs: ImageJob[]; pageErrors: string[]; modelRoutes: string[]; external: string[]; [key: string]: unknown };
const evidence = new WeakMap<Page, Evidence>();
const activePages = new WeakMap<Page, Page>();
function observe(page: Page, entry: Evidence) {
  page.on('pageerror', error => entry.pageErrors.push(error.message));
  page.on('response', response => { if (response.url().includes('/api/')) entry.requests.push({ path: new URL(response.url()).pathname, method: response.request().method(), status: response.status() }); });
  page.on('request', request => {
    const url = new URL(request.url());
    if (request.method() === 'POST' && /\/api\/(agent-chat|v1\/(images|image-edit|font-restyle|material-transfer|mask-inpaint))$/.test(url.pathname)) entry.modelRoutes.push(url.pathname);
    if (/^https?:/.test(url.protocol) && !['127.0.0.1', 'cdn.tldraw.com'].includes(url.hostname)) entry.external.push(`${url.origin}${url.pathname}`);
  });
}
test.beforeEach(async ({ page }, info) => {
  const entry: Evidence = { title: info.title, requests: [], jobs: [], pageErrors: [], modelRoutes: [], external: [] }; evidence.set(page, entry); observe(page, entry);
});
test.afterEach(async ({ page }, info) => {
  const active = activePages.get(page) || page;
  const entry = evidence.get(page)!; await mkdir(output, { recursive: true });
  const response = await active.request.get('http://127.0.0.1:18108/__test-audit'); expect(response.ok(), 'CPU-only audit harness is required').toBeTruthy(); const audit = await response.json();
  entry.providerExternalAttempts = audit.externalAttempts; entry.providerAudit = audit;
  const title = info.title.replace(/[^a-z0-9_-]+/gi, '-').toLowerCase(), screenshot = `${title}.png`;
  await active.screenshot({ path: `${output}/${screenshot}`, fullPage: true }).catch(() => {});
  let rows: Array<Record<string, unknown>> = []; try { rows = JSON.parse(await readFile(`${output}/matrix.json`, 'utf8')); } catch {}
  const row = { ...entry, status: info.status, durationMs: info.duration, errors: info.errors.map(error => error.message), screenshot };
  rows = [...rows.filter(item => item.title !== row.title), row]; await writeFile(`${output}/matrix.json`, JSON.stringify(rows, null, 2));
  await writeFile(`${output}/provider-audit.json`, JSON.stringify(audit, null, 2));
  expect(entry.pageErrors).toEqual([]); expect(entry.modelRoutes).toEqual([]); expect(entry.external).toEqual([]); expect(audit.externalAttempts).toEqual([]);
  for (const job of entry.jobs) for (const field of ['generationCalls', 'llmCalls', 'visionCalls'] as const) expect(job.metrics?.[field], `${job.operation || job.kind}: ${field}`).toBe(0);
});
async function get<T>(page: Page, path: string): Promise<T> { const response = await page.request.get(`/api/v3/image2${path}`); expect(response.ok(), await response.text()).toBeTruthy(); return (await response.json()).data; }
async function home(page: Page) {
  await page.goto('/'); await expect(page.locator('.toolDock')).toBeVisible({ timeout: 30000 });
  const gotIt = page.getByRole('button', { name: 'Got it', exact: true }); if (await gotIt.isVisible()) await gotIt.click();
  await expect(page).toHaveURL('http://127.0.0.1:18109/'); await expect(page.locator('.i2-workspace')).toHaveCount(0);
}
async function decoded(page: Page, assetId: string) { const response = await page.request.get(`/api/v3/image2/assets/${assetId}/content`); expect(response.ok()).toBeTruthy(); return sharp(await response.body()).ensureAlpha().raw().toBuffer({ resolveWithObject: true }); }
async function completed(page: Page, documentId: string, operation: string, before: Set<string>) {
  let job: ImageJob | undefined;
  await expect.poll(async () => { job = (await get<ImageJob[]>(page, `/documents/${documentId}/jobs`)).find(item => item.operation === operation && !before.has(item.id)); return job?.state; }, { timeout: 40000 }).toBe('complete');
  evidence.get(page)!.jobs.push(job!); return job!;
}
function fixture(kind = 'gradient') { const w = 96, h = 64, raw = Buffer.alloc(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const at = (y * w + x) * 4, c = kind === 'dots' ? (x % 12 >= 4 && x % 12 <= 6 && y % 12 >= 4 && y % 12 <= 6 ? [0, 0, 0] : [255, 255, 255]) : kind === 'repair' ? (Math.abs(x - 72) <= 2 && Math.abs(y - 32) <= 2 ? [20, 20, 20] : [230, 214, 180]) : kind === 'key' ? (x < w / 2 ? [255, 255, 255] : [20, 30, 40]) : [20 + x * 2, 40 + y * 2, (x + y) % 180]; raw[at] = c[0]; raw[at + 1] = c[1]; raw[at + 2] = c[2]; raw[at + 3] = 255; } return { w, h, raw }; }
async function seed(page: Page, kind = 'gradient') {
  await home(page); const source = fixture(kind), png = await sharp(source.raw, { raw: { width: source.w, height: source.h, channels: 4 } }).png().toBuffer();
  // Use the original canvas upload implementation; no page or API route is mocked.
  const shapeId = await page.evaluate(async ({ data, name }) => {
    const place = (window as unknown as { __studioPlaceImage?: (src: string, name: string) => Promise<string> }).__studioPlaceImage;
    if (!place) throw new Error('development canvas upload hook unavailable'); return place(data, name);
  }, { data: `data:image/png;base64,${png.toString('base64')}`, name: `original-${kind}.png` });
  await expect(page.locator(`.tl-shape[data-shape-id="${shapeId}"]`)).toBeAttached(); await expect(page.locator('.selectionBar')).toBeVisible();
  return { ...source, shapeId, png };
}

test('original homepage retains canvas, top bar, dock and right chat geometry', async ({ page }) => {
  await home(page);
  const baseline = JSON.parse(await readFile(`${output}/baseline-layout.json`, 'utf8')) as { layout: Record<string, { x: number; y: number; width: number; height: number }> };
  const layout = await page.evaluate(selectors => Object.fromEntries(selectors.map(selector => { const rect = document.querySelector(selector)?.getBoundingClientRect(); return [selector, rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null]; })), Object.keys(baseline.layout));
  for (const [selector, expected] of Object.entries(baseline.layout)) for (const field of ['x', 'y', 'width', 'height'] as const) expect(Math.abs((layout[selector]?.[field] || 0) - expected[field]), `${selector}.${field}`).toBeLessThanOrEqual(2);
  evidence.get(page)!.layout = layout;
  await page.getByRole('button', { name: 'layers', exact: true }).click(); await expect(page.locator('.taskDialog')).toBeVisible();
  await expect(page.locator('.taskDialog')).toContainText('图层'); await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
});

async function imported(page: Page, shapeId: string | undefined) {
  const confirmation = page.getByRole('button', { name: '确认导入当前画布', exact: true });
  if (!await confirmation.isVisible()) await page.getByRole('button', { name: 'layers', exact: true }).click();
  const confirming = await confirmation.isVisible();
  if (confirming) {
    await confirmation.click();
    // Asset creation precedes the import's final refresh. Wait for its own close,
    // so a late import completion cannot close the next operation's dialog.
    await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 30000 });
  }
  await expect.poll(async () => (await get<ImageDocument[]>(page, '/documents')).some(doc => !doc.parentDocumentId && doc.metadata?.legacyImportComplete === true && doc.layers.some(layer => layer.metadata?.legacyShapeId === shapeId || layer.type === 'raster')), { timeout: 30000 }).toBe(true);
  const documents = await get<ImageDocument[]>(page, '/documents'), document = documents.find(doc => !doc.parentDocumentId)!;
  // An already imported document can leave its read-only layer popup open.
  const close = page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true });
  if (await close.isVisible()) await close.click({ timeout: 2000 }).catch(() => {});
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const layer = document.layers.find(layer => layer.metadata?.legacyShapeId === shapeId) || document.layers.find(layer => layer.type === 'raster');
  expect(layer, 'The uploaded original shape must have a persistent typed layer').toBeTruthy();
  evidence.get(page)!.documentId = document.id; evidence.get(page)!.sourceLayerId = layer!.id; evidence.get(page)!.sourceAssetId = layer!.assetId;
  return { document, layer: layer! };
}
async function jobsBefore(page: Page, id: string) { return new Set((await get<ImageJob[]>(page, `/documents/${id}/jobs`)).map(job => job.id)); }
async function inputColor(page: Page, label: string, value: string) { await page.getByLabel(label, { exact: true }).evaluate((element: HTMLInputElement, text) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, text); element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true })); }, value); }
const rgba = (data: Buffer, width: number, x: number, y: number) => [...data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)];

test('original upscale button performs interpolation and persists unchanged canvas geometry after reload', async ({ page }) => {
  const source = await seed(page), { document, layer } = await imported(page, source.shapeId); const before = await jobsBefore(page, document.id);
  await page.locator('.selectionBar').getByRole('button', { name: '高清', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '高清', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '尺寸放大', exact: true }).click(); await page.getByLabel('放大倍率').selectOption('2'); await page.getByRole('dialog').getByRole('button', { name: '执行', exact: true }).click();
  const job = await completed(page, document.id, 'resize', before), result = await decoded(page, String(job.output!.assetId)); expect([result.info.width, result.info.height]).toEqual([192, 128]);
  const current = await get<ImageDocument>(page, `/documents/${document.id}`), changed = current.layers.find(item => item.id === layer.id)!;
  expect([changed.x, changed.y, changed.width, changed.height, changed.rotation]).toEqual([layer.x, layer.y, layer.width, layer.height, layer.rotation]);
  await page.reload(); const got = page.getByRole('button', { name: 'Got it', exact: true }); if (await got.isVisible()) await got.click(); await expect(page.locator('.toolDock')).toBeVisible();
  await expect.poll(async () => (await get<ImageDocument>(page, `/documents/${document.id}`)).layers.find(item => item.id === layer.id)?.assetId).toBe(job.output!.assetId);
  await page.getByRole('button', { name: 'versions', exact: true }).click(); await expect(page.getByRole('dialog', { name: '版本与候选', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText('当前版本'); await expect(page).toHaveURL('http://127.0.0.1:18109/');
  evidence.get(page)!.pixelDimensions = [result.info.width, result.info.height]; evidence.get(page)!.layoutPreserved = true;
});

test('original layer popup edits Chinese text, visibility and locks with native font assets and zero model jobs', async ({ page }) => {
  const source = await seed(page), { document } = await imported(page, source.shapeId);
  await page.getByRole('button', { name: 'layers', exact: true }).click(); await page.getByRole('button', { name: '＋ 文字', exact: true }).click();
  await expect(page.getByLabel('文字内容')).toBeVisible(); await page.getByLabel('文字内容').fill('中文直接编辑'); await page.getByLabel('文字内容').blur();
  await expect.poll(async () => (await get<ImageDocument>(page, `/documents/${document.id}`)).layers.find(layer => layer.type === 'text')?.text).toBe('中文直接编辑');
  let current = await get<ImageDocument>(page, `/documents/${document.id}`), text = current.layers.find(layer => layer.type === 'text')!; expect(text.fontAssetId).toBeTruthy(); expect(text.metadata?.fontConfirmed).toBe(true);
  const originalFont = await page.request.get(`/api/v3/image2/assets/${text.fontAssetId}/content`); expect(originalFont.ok()).toBeTruthy(); expect((await originalFont.body()).length).toBeGreaterThan(10000);
  for (const content of ['第二次改中文', '第三次中文修改']) { await page.getByLabel('文字内容').fill(content); await page.getByLabel('文字内容').blur(); await expect.poll(async () => (await get<ImageDocument>(page, `/documents/${document.id}`)).layers.find(layer => layer.id === text.id)?.text).toBe(content); }
  await page.getByLabel('图层名称').fill('中文标题'); await page.getByLabel('图层名称').blur();
  await expect(page.getByRole('button', { name: '中文标题隐藏', exact: true })).toBeVisible(); await page.getByRole('button', { name: '中文标题隐藏', exact: true }).click();
  await expect.poll(async () => (await get<ImageDocument>(page, `/documents/${document.id}`)).layers.find(layer => layer.id === text.id)?.visible).toBe(false);
  await expect(page.locator(`.tl-shape[data-shape-id="shape:image2-${text.id}"]`)).toBeHidden();
  await page.getByRole('button', { name: '中文标题显示', exact: true }).click(); await expect(page.locator(`.tl-shape[data-shape-id="shape:image2-${text.id}"]`)).toBeVisible(); await page.getByRole('button', { name: '中文标题锁定', exact: true }).click();
  await expect.poll(async () => (await get<ImageDocument>(page, `/documents/${document.id}`)).layers.find(layer => layer.id === text.id)?.locked).toBe(true); await expect(page.getByRole('checkbox', { name: '组合 中文标题', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '中文标题解锁', exact: true }).click(); current = await get<ImageDocument>(page, `/documents/${document.id}`); text = current.layers.find(layer => layer.id === text.id)!;
  expect((await get<ImageJob[]>(page, `/documents/${document.id}/jobs`))).toHaveLength(0); evidence.get(page)!.fontAssetId = text.fontAssetId; evidence.get(page)!.finalText = text.text;
});

for (const operation of ['erase', 'repair', 'recolor', 'fill']) test(`original eraser ${operation}: edited pixels change and protection wins`, async ({ page }) => {
  const source = await seed(page, operation === 'repair' ? 'repair' : 'gradient'), { document, layer } = await imported(page, source.shapeId), before = await jobsBefore(page, document.id);
  await page.locator('.selectionBar').getByRole('button', { name: '消除', exact: true }).click();
  await expect.poll(() => page.locator('.maskCanvas').evaluate((canvas: HTMLCanvasElement) => canvas.width)).toBe(source.w);
  await page.locator('.maskSlider input').evaluate((element: HTMLInputElement) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, '14'); element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true })); });
  const box = (await page.locator('.maskCanvas').boundingBox())!, click = (x: number, y: number) => page.mouse.click(box.x + x * box.width / source.w, box.y + y * box.height / source.h);
  await click(24, 32); await click(72, 32); await page.getByRole('button', { name: '保护范围', exact: true }).click(); await click(24, 32);
  await page.getByLabel('局部处理方式').selectOption(operation); if (['recolor', 'fill'].includes(operation)) await inputColor(page, '局部处理颜色', '#168a55');
  await page.locator('.maskDialog').getByRole('button', { name: '执行', exact: true }).click();
  const job = await completed(page, document.id, operation, before), result = await decoded(page, String(job.output!.assetId));
  expect(rgba(result.data, source.w, 24, 32)).toEqual(rgba(source.raw, source.w, 24, 32)); expect(rgba(result.data, source.w, 0, 0)).toEqual(rgba(source.raw, source.w, 0, 0));
  const current = await get<ImageDocument>(page, `/documents/${document.id}`), updated = current.layers.find(item => item.id === layer.id)!, edit = await decoded(page, String(updated.metadata!.editMaskAssetId)), protect = await decoded(page, String(updated.metadata!.protectMaskAssetId));
  let protectedDiff = 0, editedPixels = 0;
  for (let i = 0; i < source.w * source.h; i++) { const at = i * 4, original = source.raw.subarray(at, at + 4), outputPixel = result.data.subarray(at, at + 4); if (!edit.data[at + 3] || protect.data[at + 3]) { if (!outputPixel.equals(original)) protectedDiff++; } else if (!outputPixel.equals(original)) editedPixels++; }
  expect(protectedDiff).toBe(0); expect(editedPixels).toBeGreaterThan(0);
  if (operation === 'erase') expect(rgba(result.data, source.w, 72, 32)[3]).toBe(0);
  if (operation === 'fill') expect(rgba(result.data, source.w, 72, 32)).toEqual([22, 138, 85, 255]);
  if (operation === 'repair') expect(rgba(result.data, source.w, 72, 32)).toEqual([230, 214, 180, 255]);
  Object.assign(evidence.get(page)!, { protectedDiff, editedPixels, pixelDimensions: [result.info.width, result.info.height] });
});

test('original Elements recolor opens explicit edit/protect masks and calls CPU recolor', async ({ page }) => {
  const source = await seed(page), { document } = await imported(page, source.shapeId), before = await jobsBefore(page, document.id);
  await page.locator('.selectionBar').getByRole('button', { name: '元素', exact: true }).click(); await page.getByLabel('目标颜色', { exact: true }).fill('#168a55');
  await page.getByRole('button', { name: '涂抹修改 / 保护范围', exact: true }).click(); await expect.poll(() => page.locator('.maskCanvas').evaluate((canvas: HTMLCanvasElement) => canvas.width)).toBe(source.w);
  expect(await page.getByLabel('局部处理方式').inputValue()).toBe('recolor'); const box = (await page.locator('.maskCanvas').boundingBox())!; await page.mouse.click(box.x + box.width * .75, box.y + box.height * .5);
  await page.locator('.maskDialog').getByRole('button', { name: '执行', exact: true }).click(); const job = await completed(page, document.id, 'recolor', before), result = await decoded(page, String(job.output!.assetId));
  expect(rgba(result.data, source.w, 0, 0)).toEqual(rgba(source.raw, source.w, 0, 0)); expect(rgba(result.data, source.w, 72, 32)).not.toEqual(rgba(source.raw, source.w, 72, 32));
});

test('original vector button keeps halftone dots as SVG paths without preliminary generation', async ({ page }) => {
  const source = await seed(page, 'dots'), { document, layer } = await imported(page, source.shapeId), before = await jobsBefore(page, document.id);
  await page.locator('.selectionBar').getByRole('button', { name: '矢量', exact: true }).click(); await page.getByRole('button', { name: '保网点 / 线稿', exact: true }).click();
  await page.getByRole('dialog', { name: '矢量化', exact: true }).getByRole('button', { name: '执行', exact: true }).click(); const job = await completed(page, document.id, 'trace', before);
  const current = await get<ImageDocument>(page, `/documents/${document.id}`); expect(current.layers.find(item => item.id === layer.id)?.type).toBe('vector');
  const response = await page.request.get(`/api/v3/image2/assets/${job.output!.assetId}/content`), svg = await response.text(); expect(response.headers()['content-type']).toContain('image/svg+xml'); expect((svg.match(/<path/g) || []).length).toBeGreaterThan(20);
  const rendered = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true }); let survivedDots = 0;
  for (let y = 5; y < source.h; y += 12) for (let x = 5; x < source.w; x += 12) if (rgba(rendered.data, rendered.info.width, x, y).slice(0, 3).every(value => value < 100)) survivedDots++;
  expect(survivedDots).toBeGreaterThan(25); Object.assign(evidence.get(page)!, { paths: (svg.match(/<path/g) || []).length, survivedDots });
});

test('original Elements layer restoration produces a reviewable candidate and accepts it through Versions', async ({ page }) => {
  const source = await seed(page), { document, layer } = await imported(page, source.shapeId), before = await jobsBefore(page, document.id);
  await page.locator('.selectionBar').getByRole('button', { name: '元素', exact: true }).click(); await page.getByRole('button', { name: '拆分图层', exact: true }).click();
  await page.locator('.taskDialog').getByRole('button', { name: '执行', exact: true }).click(); const job = await completed(page, document.id, 'restore_layers', before);
  let current = await get<ImageDocument>(page, `/documents/${document.id}`); expect(current.revision).toBe(document.revision); expect(current.layers).toEqual(document.layers); expect(job.output?.branchDocumentId).toBeTruthy();
  await page.getByRole('button', { name: 'versions', exact: true }).click(); await expect(page.getByRole('dialog').getByRole('button', { name: '接受候选', exact: true })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: '接受候选', exact: true }).click();
  await expect.poll(async () => (await get<ImageDocument>(page, `/documents/${document.id}`)).revision).toBeGreaterThan(document.revision);
  current = await get<ImageDocument>(page, `/documents/${document.id}`); expect(current.layers.find(item => item.id === layer.id)?.type).toBe('group'); expect(current.layers.length).toBeGreaterThan(1);
  Object.assign(evidence.get(page)!, { branchDocumentId: job.output?.branchDocumentId, acceptedRevision: current.revision, acceptedLayers: current.layers.length });
});

test('original Change Text first clears the flattened glyph and later edits typed Chinese without generation', async ({ page }) => {
  const source = await seed(page, 'repair'), { document, layer } = await imported(page, source.shapeId), before = await jobsBefore(page, document.id);
  await page.locator('.selectionBar').getByRole('button', { name: '改字', exact: true }).click(); await page.getByLabel('原文字内容', { exact: true }).fill('旧字');
  for (const [field, value] of Object.entries({ x: 60, y: 20, width: 24, height: 24 })) await page.getByLabel(`文字区域 ${field}`, { exact: true }).fill(String(value));
  await page.getByLabel('新文字内容', { exact: true }).fill('新字'); await page.getByLabel('精确字号', { exact: true }).fill('14'); await page.getByRole('button', { name: '清底并应用文字', exact: true }).click();
  await expect.poll(async () => (await get<ImageDocument>(page, `/documents/${document.id}`)).layers.some(item => item.type === 'text' && item.metadata?.fontConfirmed === true && item.text === '新字'), { timeout: 40000 }).toBe(true);
  let current = await get<ImageDocument>(page, `/documents/${document.id}`), text = current.layers.find(item => item.type === 'text' && item.text === '新字')!;
  expect(text.fontAssetId).toBeTruthy(); expect(text.metadata?.backgroundDetached).toBe(true);
  const background = current.layers.find(item => item.id === text.metadata?.backgroundLayerId)!; expect(background.type).toBe('raster'); expect([background.x, background.y, background.rotation]).toEqual([text.x, text.y, text.rotation]);
  const clean = await decoded(page, background.assetId!); expect(rgba(clean.data, clean.info.width, 12, 12)).toEqual([230, 214, 180, 255]);
  const old = current.layers.find(item => item.id === layer.id)!; expect(old.assetId).toBe(layer.assetId); expect(await (await page.request.get(`/api/v3/image2/assets/${old.assetId}/content`)).body()).toEqual(source.png);
  const initialJobs = (await get<ImageJob[]>(page, `/documents/${document.id}/jobs`)).filter(job => !before.has(job.id)); evidence.get(page)!.jobs.push(...initialJobs); expect(initialJobs.some(job => job.operation === 'prepare_text')).toBe(true);
  await page.getByRole('button', { name: 'layers', exact: true }).click(); await page.getByRole('button', { name: `文字 · ${text.name}`, exact: true }).click();
  const jobsAfter = await jobsBefore(page, document.id); await page.getByLabel('文字内容', { exact: true }).fill('连续改中文'); await page.getByLabel('文字内容', { exact: true }).blur();
  await expect.poll(async () => (await get<ImageDocument>(page, `/documents/${document.id}`)).layers.find(item => item.id === text.id)?.text).toBe('连续改中文');
  const x = page.getByLabel('横向位置', { exact: true }); await x.fill(String(text.x + 20)); await x.blur();
  await expect.poll(async () => (await get<ImageDocument>(page, `/documents/${document.id}`)).layers.find(item => item.id === text.id)?.x).toBe(text.x + 20);
  current = await get<ImageDocument>(page, `/documents/${document.id}`); expect(current.layers.find(item => item.id === background.id)?.x).toBe(background.x); expect(await jobsBefore(page, document.id)).toEqual(jobsAfter);
  text = current.layers.find(item => item.id === text.id)!; Object.assign(evidence.get(page)!, { fontAssetId: text.fontAssetId, textBackgroundAssetId: background.assetId, finalText: text.text, originalAssetPreserved: true });
});

test('original export menu downloads actual PNG SVG PDF and native project; original Versions imports the ZIP', async ({ page }) => {
  const source = await seed(page), { document } = await imported(page, source.shapeId); const exports: Array<Record<string, unknown>> = [];
  for (const [format, label, mime] of [['png', '导出 PNG（画布/选中）', 'image/png'], ['svg', '导出 SVG', 'image/svg+xml'], ['pdf', '导出 PDF（画布/选中）', 'application/pdf']] as const) {
    const before = await jobsBefore(page, document.id); await page.getByRole('button', { name: 'projects and export', exact: true }).click();
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 45000 }), page.getByRole('button', { name: label, exact: true }).click()]); await download.saveAs(`${output}/original-menu-${format}.${format}`);
    const job = (await get<ImageJob[]>(page, `/documents/${document.id}/jobs`)).find(job => job.kind === 'export' && !before.has(job.id))!; evidence.get(page)!.jobs.push(job); expect(job.state).toBe('complete'); expect(job.output?.mime).toBe(mime);
    const response = await page.request.get(`/api/v3/image2/assets/${job.output!.assetId}/content`), bytes = await response.body();
    if (format === 'png') expect(bytes.subarray(1, 4).toString()).toBe('PNG'); if (format === 'svg') expect(bytes.toString()).toContain('<svg'); if (format === 'pdf') expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    exports.push({ format, jobId: job.id, assetId: job.output?.assetId, bytes: bytes.length, filename: download.suggestedFilename() });
  }
  await page.getByRole('button', { name: 'versions', exact: true }).click(); const before = await jobsBefore(page, document.id), downloading = page.waitForEvent('download', { timeout: 45000 });
  await page.getByRole('button', { name: '导出原生工程', exact: true }).click(); const archive = await downloading, archivePath = `${output}/original-native-project.zip`; await archive.saveAs(archivePath);
  const zipJob = (await get<ImageJob[]>(page, `/documents/${document.id}/jobs`)).find(job => job.kind === 'export' && !before.has(job.id))!; evidence.get(page)!.jobs.push(zipJob); expect(zipJob.state).toBe('complete'); expect(zipJob.output?.mime).toBe('application/zip');
  const bytes = await readFile(archivePath); expect(bytes.subarray(0, 2).toString()).toBe('PK'); await page.getByLabel('导入原生工程', { exact: true }).setInputFiles(archivePath);
  await expect.poll(async () => (await get<ImageDocument[]>(page, '/documents')).filter(doc => !doc.parentDocumentId).length).toBe(2);
  await expect(page).toHaveURL('http://127.0.0.1:18109/'); Object.assign(evidence.get(page)!, { exports, zipJobId: zipJob.id, importedDocuments: (await get<ImageDocument[]>(page, '/documents')).map(doc => doc.id) });
});

for (const operation of ['crop', 'pad', 'rotate', 'flip', 'color_key']) test(`original Layers pixel controls ${operation} execute actual CPU pixels`, async ({ page }) => {
  const source = await seed(page, operation === 'color_key' ? 'key' : 'gradient'), { document, layer } = await imported(page, source.shapeId), before = await jobsBefore(page, document.id);
  await page.getByRole('button', { name: 'layers', exact: true }).click(); await page.getByRole('button', { name: `图片 · ${layer.name}`, exact: true }).click(); await page.getByLabel('像素处理', { exact: true }).selectOption(operation);
  if (['crop', 'pad'].includes(operation)) {
    await page.getByLabel('处理 width', { exact: true }).fill(operation === 'crop' ? '40' : '120'); await page.getByLabel('处理 height', { exact: true }).fill(operation === 'crop' ? '30' : '90');
    if (operation === 'crop') { await page.getByLabel('处理 x', { exact: true }).fill('11'); await page.getByLabel('处理 y', { exact: true }).fill('7'); }
    else await inputColor(page, '像素处理颜色', '#168a55');
  }
  if (operation === 'rotate') await page.getByLabel('像素旋转角度', { exact: true }).fill('90');
  if (operation === 'flip') await page.getByLabel('翻转方向', { exact: true }).selectOption('horizontal');
  if (operation === 'color_key') { await inputColor(page, '像素处理颜色', '#ffffff'); await page.getByLabel('颜色容差', { exact: true }).fill('0'); }
  await page.getByRole('button', { name: '执行像素处理', exact: true }).click(); const job = await completed(page, document.id, operation, before), result = await decoded(page, String(job.output!.assetId));
  const expected = operation === 'crop' ? [40, 30] : operation === 'pad' ? [120, 90] : operation === 'rotate' ? [64, 96] : [96, 64]; expect([result.info.width, result.info.height]).toEqual(expected);
  if (operation === 'crop') for (let y = 0; y < 30; y++) for (let x = 0; x < 40; x++) expect(rgba(result.data, 40, x, y)).toEqual(rgba(source.raw, 96, x + 11, y + 7));
  if (operation === 'pad') { expect(rgba(result.data, 120, 0, 0)).toEqual([22, 138, 85, 255]); expect(rgba(result.data, 120, 12, 13)).toEqual(rgba(source.raw, 96, 0, 0)); }
  if (operation === 'rotate') expect(rgba(result.data, 64, 63, 0)).toEqual(rgba(source.raw, 96, 0, 0));
  if (operation === 'flip') for (let y = 0; y < 64; y++) for (let x = 0; x < 96; x++) expect(rgba(result.data, 96, x, y)).toEqual(rgba(source.raw, 96, 95 - x, y));
  if (operation === 'color_key') { expect(rgba(result.data, 96, 10, 10)[3]).toBe(0); expect(rgba(result.data, 96, 80, 10)).toEqual([20, 30, 40, 255]); }
  evidence.get(page)!.pixelDimensions = expected;
});

test('original Layers edits an individual SVG Logo path and preserves its original immutable bytes', async ({ page }) => {
  const source = await seed(page), { document } = await imported(page, source.shapeId);
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40"><style>.mark{fill:#263645}</style><path id="primary" class="mark" d="M2 2H18V38H2Z"/><path id="secondary" fill="#d0aa33" d="M22 2H38V38H22Z"/></svg>');
  await page.getByRole('button', { name: 'layers', exact: true }).click(); await page.getByLabel('上传 SVG / 图片', { exact: true }).setInputFiles({ name: 'original-logo.svg', mimeType: 'image/svg+xml', buffer: svg });
  await expect(page.getByLabel('Logo 路径', { exact: true })).toBeVisible(); await page.getByLabel('Logo 路径', { exact: true }).selectOption('primary'); await inputColor(page, 'Logo 填色', '#ee2222');
  await expect.poll(() => page.locator('.i2-svg path').first().evaluate(path => getComputedStyle(path).fill)).toBe('rgb(238, 34, 34)'); await expect.poll(() => page.locator('.i2-svg path').last().evaluate(path => getComputedStyle(path).fill)).toBe('rgb(208, 170, 51)');
  const current = await get<ImageDocument>(page, `/documents/${document.id}`), logo = current.layers.find(layer => layer.name === 'original-logo.svg')!; expect(logo.metadata?.pathStyles).toEqual({ primary: { fill: '#ee2222' } });
  expect(await (await page.request.get(`/api/v3/image2/assets/${logo.assetId}/content`)).body()).toEqual(svg); expect(await get<ImageJob[]>(page, `/documents/${document.id}/jobs`)).toHaveLength(0);
  Object.assign(evidence.get(page)!, { logoLayerId: logo.id, originalSvgPreserved: true, nativePathStyles: logo.metadata?.pathStyles });
});

test('original unavailable SR redraw and inpaint remain explicit and never fall back to generation', async ({ page }) => {
  const source = await seed(page), { document } = await imported(page, source.shapeId), before = await jobsBefore(page, document.id);
  await page.locator('.selectionBar').getByRole('button', { name: '高清', exact: true }).click(); const dialog = page.getByRole('dialog', { name: '高清', exact: true });
  for (const name of ['细节超分', 'AI 高清重绘']) { await dialog.getByRole('button', { name, exact: true }).click(); await expect(dialog.getByRole('button', { name: '执行', exact: true })).toBeDisabled(); }
  await dialog.getByRole('button', { name: '尺寸放大', exact: true }).click(); await expect(dialog.getByRole('button', { name: '执行', exact: true })).toBeEnabled(); await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.locator('.selectionBar').getByRole('button', { name: '消除', exact: true }).click(); await expect.poll(() => page.locator('.maskCanvas').evaluate((canvas: HTMLCanvasElement) => canvas.width)).toBe(96);
  const box = (await page.locator('.maskCanvas').boundingBox())!; await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2); await page.getByLabel('局部处理方式', { exact: true }).selectOption('inpaint');
  await expect(page.locator('.maskDialog').getByRole('button', { name: '执行', exact: true })).toBeDisabled(); expect(await jobsBefore(page, document.id)).toEqual(before);
  evidence.get(page)!.unavailableModelsDisabled = ['super_resolution', 'generate', 'inpaint'];
});

test('original Layers deterministic template preserves original layers and creates independently editable copies', async ({ page }) => {
  const source = await seed(page), { document, layer } = await imported(page, source.shapeId), before = await jobsBefore(page, document.id);
  await page.getByRole('button', { name: 'layers', exact: true }).click(); await page.getByLabel('模板版式', { exact: true }).selectOption('poster'); await page.getByRole('button', { name: '添加可编辑模板', exact: true }).click();
  await expect.poll(async () => (await get<ImageDocument>(page, `/documents/${document.id}`)).layers.some(layer => layer.metadata?.template === 'poster')).toBe(true);
  const current = await get<ImageDocument>(page, `/documents/${document.id}`), template = current.layers.find(item => item.type === 'group' && item.metadata?.template === 'poster')!;
  expect(current.layers.find(item => item.id === layer.id)).toEqual(layer); expect(current.width).toBe(2 * document.width + 64);
  const copies = current.layers.filter(item => item.parentId === template.id); expect(copies.some(item => item.assetId === layer.assetId)).toBe(true); expect(copies.filter(item => item.type === 'text').every(item => item.fontAssetId && item.metadata?.fontConfirmed === true)).toBe(true);
  expect(copies.every(item => item.metadata?.legacyShapeId !== source.shapeId)).toBe(true); expect(await jobsBefore(page, document.id)).toEqual(before);
  Object.assign(evidence.get(page)!, { templateGroupId: template.id, independentCopies: copies.map(item => item.id), typedTemplateFonts: copies.filter(item => item.type === 'text').map(item => item.fontAssetId) });
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  await page.locator('.canvasPane').click({ button: 'right', position: { x: 850, y: 160 } }); await page.getByRole('button', { name: '缩放至适配', exact: true }).click();
  await expect(page.locator('.zoomLabel')).not.toHaveText('100%'); await page.evaluate(() => globalThis.document.fonts.ready); await page.screenshot({ path: `${output}/original-workspace-template.png`, fullPage: true });
});

test('original canvas Text tool and font toolbar persist their real native records and font bytes', async ({ page }) => {
  const source = await seed(page), { document } = await imported(page, source.shapeId);
  await page.locator('.toolDock').getByRole('button', { name: '文字', exact: true }).click(); await page.mouse.click(350, 220);
  await expect(page.locator('[contenteditable="true"]')).toBeVisible(); await page.keyboard.insertText('中文 MAI'); await page.keyboard.press('Escape');
  await expect.poll(async () => (await get<ImageDocument>(page, `/documents/${document.id}`)).layers.some(layer => layer.type === 'text' && layer.text === '中文 MAI'), { timeout: 15000 }).toBe(true);
  await page.locator('.toolDock').getByRole('button', { name: '文字', exact: true }).click();
  const fonts: Array<{ label: string; slot: string; assetId: string; bytes: number }> = [];
  for (const [label, slot, path] of [['文楷', 'draw', 'lxgw-wenkai'], ['黑体', 'sans', 'source-han-sans'], ['宋体', 'serif', 'source-han-serif'], ['得意', 'mono', 'smiley-sans']] as const) {
    await page.locator('.textBar').getByRole('button', { name: label, exact: true }).click();
    await expect.poll(async () => (await get<ImageDocument>(page, `/documents/${document.id}`)).layers.find(layer => layer.type === 'text')?.metadata?.legacyFontSlot, { timeout: 30000 }).toBe(slot);
    const current = await get<ImageDocument>(page, `/documents/${document.id}`), layer = current.layers.find(layer => layer.type === 'text')!;
    expect(layer.metadata?.nativeText).toBe(true); expect(layer.metadata?.fontConfirmed).toBe(true); expect(layer.fontAssetId).toBeTruthy(); expect(layer.text).toBe('中文 MAI');
    const stored = await page.request.get(`/api/v3/image2/assets/${layer.fontAssetId}/content`), original = await page.request.get(`/fonts/${path}.woff2`), bytes = await stored.body(); expect(bytes).toEqual(await original.body());
    fonts.push({ label, slot, assetId: layer.fontAssetId!, bytes: bytes.length });
  }
  await expect(page.locator('.tl-shape[data-shape-type="text"]')).toHaveCount(1); expect(await get<ImageJob[]>(page, `/documents/${document.id}/jobs`)).toHaveLength(0);
  Object.assign(evidence.get(page)!, { nativeText: true, fonts, fontBytesExact: true });
});

test('original Layers grouping at negative coordinates preserves the selected PNG pixels after ungrouping', async ({ page }) => {
  const source = await seed(page), { document, layer } = await imported(page, source.shapeId);
  await page.getByRole('button', { name: 'layers', exact: true }).click(); await page.getByRole('button', { name: `图片 · ${layer.name}`, exact: true }).click();
  for (const [label, value] of [['横向位置', -80], ['纵向位置', -40]] as const) { await page.getByLabel(label, { exact: true }).fill(String(value)); await page.getByLabel(label, { exact: true }).blur(); }
  await page.getByRole('button', { name: '＋ 文字', exact: true }).click(); await expect(page.getByLabel('文字内容', { exact: true })).toBeVisible(); await page.getByLabel('文字内容', { exact: true }).fill('中文'); await page.getByLabel('文字内容', { exact: true }).blur();
  for (const [label, value] of [['横向位置', 20], ['纵向位置', 30], ['宽度', 120], ['高度', 50], ['字号', 24]] as const) { await page.getByLabel(label, { exact: true }).fill(String(value)); await page.getByLabel(label, { exact: true }).blur(); }
  await page.getByRole('checkbox', { name: `组合 ${layer.name}`, exact: true }).check(); await page.getByRole('checkbox', { name: '组合 文字', exact: true }).check(); await page.getByRole('button', { name: '编组所选', exact: true }).click();
  await expect(page.getByRole('button', { name: '组 · 组合', exact: true })).toBeVisible(); await page.getByRole('button', { name: '组 · 组合', exact: true }).click(); await expect(page.getByLabel('不透明度', { exact: true })).toBeDisabled();
  const groupedDoc = await get<ImageDocument>(page, `/documents/${document.id}`); expect(groupedDoc.layers.find(item => item.type === 'group')?.x).toBe(-80);
  const downloadPng = async () => { await page.getByRole('button', { name: 'projects and export', exact: true }).click(); const [download] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.getByRole('button', { name: '导出 PNG（画布/选中）', exact: true }).click()]); const path = `${output}/group-${crypto.randomUUID()}.png`; await download.saveAs(path); return readFile(path); };
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click(); const grouped = await downloadPng();
  await page.getByRole('button', { name: 'layers', exact: true }).click(); await page.getByRole('button', { name: '组 · 组合', exact: true }).click(); await page.getByRole('button', { name: '拆开组合', exact: true }).click();
  await expect.poll(async () => (await get<ImageDocument>(page, `/documents/${document.id}`)).layers.some(item => item.type === 'group')).toBe(false); await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click(); await page.mouse.click(900, 150);
  const ungrouped = await downloadPng(); expect(await sharp(ungrouped).ensureAlpha().raw().toBuffer()).toEqual(await sharp(grouped).ensureAlpha().raw().toBuffer());
  const jobs = await get<ImageJob[]>(page, `/documents/${document.id}/jobs`); evidence.get(page)!.jobs.push(...jobs); Object.assign(evidence.get(page)!, { groupedPixelsEqual: true, negativeCoordinates: [-80, -40] });
});
