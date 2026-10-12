import { expect, test, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { ImageDocument, ImageJob, ImageLayer } from '../lib/image2/types';

const require = createRequire(import.meta.url), sharp = require('../services/image2/node_modules/sharp');
const output = fileURLToPath(new URL('../../output/image2-original-extended-20261012/', import.meta.url));
type Entry = { title: string; documentIds: Set<string>; requests: Array<{ path: string; method: string; status: number }>; pageErrors: string[]; modelRoutes: string[]; external: string[]; [key: string]: unknown };
const entries = new WeakMap<Page, Entry>();
test.beforeEach(async ({ page }, info) => {
  const entry: Entry = { title: info.title, documentIds: new Set(), requests: [], pageErrors: [], modelRoutes: [], external: [] }; entries.set(page, entry);
  page.on('pageerror', error => entry.pageErrors.push(error.message));
  page.on('response', response => { if (response.url().includes('/api/')) entry.requests.push({ path: new URL(response.url()).pathname, method: response.request().method(), status: response.status() }); });
  page.on('request', request => {
    const url = new URL(request.url());
    if (request.method() === 'POST' && /\/api\/(agent-chat|v1\/(images|image-edit|font-restyle|material-transfer|mask-inpaint))$/.test(url.pathname)) entry.modelRoutes.push(url.pathname);
    if (/^https?:/.test(url.protocol) && !['127.0.0.1', 'localhost', 'cdn.tldraw.com'].includes(url.hostname)) entry.external.push(`${url.origin}${url.pathname}`);
  });
});
test.afterEach(async ({ page }, info) => {
  await mkdir(output, { recursive: true }); const entry = entries.get(page)!, jobs: ImageJob[] = [];
  for (const id of entry.documentIds) jobs.push(...await get<ImageJob[]>(page, `/documents/${id}/jobs`));
  const response = await page.request.get('http://127.0.0.1:18108/__test-audit'); expect(response.ok()).toBeTruthy(); const audit = await response.json();
  const screenshot = `${info.title.replace(/[^a-z0-9_-]+/gi, '-').toLowerCase()}.png`; await page.screenshot({ path: `${output}/${screenshot}`, fullPage: true }).catch(() => {});
  const { documentIds, ...data } = entry; const row = { ...data, documentIds: [...documentIds], jobs, audit, status: info.status, durationMs: info.duration, errors: info.errors.map(error => error.message), screenshot };
  let rows: Array<Record<string, unknown>> = []; try { rows = JSON.parse(await readFile(`${output}/matrix.json`, 'utf8')); } catch {}
  await writeFile(`${output}/matrix.json`, JSON.stringify([...rows.filter(item => item.title !== row.title), row], null, 2));
  expect(entry.pageErrors).toEqual([]); expect(entry.modelRoutes).toEqual([]); expect(entry.external).toEqual([]); expect(audit.externalAttempts).toEqual([]);
  for (const job of jobs) for (const field of ['generationCalls', 'llmCalls', 'visionCalls'] as const) expect(job.metrics?.[field], `${job.operation || job.kind}:${field}`).toBe(0);
});
async function get<T>(page: Page, path: string): Promise<T> { const response = await page.request.get(`/api/v3/image2${path}`); expect(response.ok(), await response.text()).toBeTruthy(); return (await response.json()).data; }
const current = (page: Page, id: string) => get<ImageDocument>(page, `/documents/${id}`);
const rgba = (bytes: Buffer, width: number, x: number, y: number) => [...bytes.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)];
async function bytes(page: Page, id: string) { const response = await page.request.get(`/api/v3/image2/assets/${id}/content`); expect(response.ok()).toBeTruthy(); return response.body(); }
async function pixels(buffer: Buffer) { return sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true }); }
async function home(page: Page) { await page.goto('/'); await expect(page.locator('.toolDock')).toBeVisible({ timeout: 30000 }); const got = page.getByRole('button', { name: 'Got it', exact: true }); if (await got.isVisible()) await got.click(); await expect(page).toHaveURL('http://127.0.0.1:18109/'); await expect(page.locator('.i2-workspace')).toHaveCount(0); }
async function upload(page: Page, name = 'chooser-original.png') {
  const raw = Buffer.alloc(96 * 64 * 4); for (let y = 0; y < 64; y++) for (let x = 0; x < 96; x++) { const at = (y * 96 + x) * 4; raw[at] = 20 + x * 2; raw[at + 1] = 40 + y * 2; raw[at + 2] = (x + y) % 180; raw[at + 3] = 255; }
  const png = await sharp(raw, { raw: { width: 96, height: 64, channels: 4 } }).png().toBuffer();
  const before = new Set(await page.locator('.tl-shape').evaluateAll(shapes => shapes.map(shape => shape.getAttribute('data-shape-id'))));
  const choosing = page.waitForEvent('filechooser'); await page.locator('.toolDock').getByRole('button', { name: '上传图片', exact: true }).click(); await (await choosing).setFiles({ name, mimeType: 'image/png', buffer: png });
  let shapeId = ''; await expect.poll(async () => { shapeId = (await page.locator('.tl-shape').evaluateAll(shapes => shapes.map(shape => shape.getAttribute('data-shape-id')))).find(id => !!id && !before.has(id)) || ''; return !!shapeId; }).toBe(true);
  const image = page.locator(`.tl-shape[data-shape-id="${shapeId}"] img`); await expect.poll(() => image.evaluate((node: HTMLImageElement) => node.complete ? node.naturalWidth : 0)).toBe(96);
  return { shapeId, png, raw, name };
}
async function importCanvas(page: Page, shapeId: string) {
  await page.getByRole('button', { name: 'layers', exact: true }).click(); await page.getByRole('button', { name: '确认导入当前画布', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 30000 });
  let doc: ImageDocument | undefined; await expect.poll(async () => { doc = (await get<ImageDocument[]>(page, '/documents')).find(item => !item.parentDocumentId && item.metadata?.legacyImportComplete === true && item.layers.some(layer => layer.metadata?.legacyShapeId === shapeId)); return !!doc; }).toBe(true);
  entries.get(page)!.documentIds.add(doc!.id); return { document: doc!, layer: doc!.layers.find(layer => layer.metadata?.legacyShapeId === shapeId)! };
}
async function fixture(page: Page) { await home(page); const source = await upload(page); return { ...source, ...await importCanvas(page, source.shapeId) }; }
async function openLayers(page: Page, layer?: ImageLayer) { await page.getByRole('button', { name: 'layers', exact: true }).click(); if (layer) await page.getByRole('button', { name: `${layer.type === 'group' ? '组' : layer.type === 'vector' ? 'SVG' : '图片'} · ${layer.name}`, exact: true }).click(); }
async function close(page: Page) { const button = page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }); if (await button.isVisible()) await button.click(); await expect(page.getByRole('dialog')).toHaveCount(0); }
async function property(page: Page, id: string, layerId: string, label: string, key: keyof ImageLayer, value: number | string) { const input = page.getByLabel(label, { exact: true }); await input.fill(String(value)); await input.blur(); await expect.poll(async () => (await current(page, id)).layers.find(layer => layer.id === layerId)?.[key]).toBe(value); }
async function completed(page: Page, id: string, before: Set<string>, operation: string) { let job: ImageJob | undefined; await expect.poll(async () => { job = (await get<ImageJob[]>(page, `/documents/${id}/jobs`)).find(item => !before.has(item.id) && item.operation === operation); return job?.state; }, { timeout: 40000 }).toBe('complete'); return job!; }
async function download(page: Page, id: string, format: 'png' | 'svg' | 'pdf', label = '') {
  const previous = new Set((await get<ImageJob[]>(page, `/documents/${id}/jobs`)).map(job => job.id)); await page.getByRole('button', { name: 'projects and export', exact: true }).click();
  const names = { png: '导出 PNG（画布/选中）', svg: '导出 SVG', pdf: '导出 PDF（画布/选中）' }; const [result] = await Promise.all([page.waitForEvent('download', { timeout: 40000 }), page.getByRole('button', { name: names[format], exact: true }).click()]);
  const path = `${output}/${label || crypto.randomUUID()}.${format}`; await result.saveAs(path);
  const job = (await get<ImageJob[]>(page, `/documents/${id}/jobs`)).find(item => item.kind === 'export' && !previous.has(item.id))!; expect(job.state).toBe('complete'); return { path, buffer: await readFile(path), job };
}

for (const operation of ['crop', 'pad', 'rotate'] as const) test(`real original upload then ${operation} retains scaled native display density and source pixels`, async ({ page }) => {
  const source = await fixture(page); let before = new Set((await get<ImageJob[]>(page, `/documents/${source.document.id}/jobs`)).map(job => job.id));
  expect(await bytes(page, source.layer.assetId!)).toEqual(source.png); expect([source.layer.width, source.layer.height]).toEqual([360, 240]);
  await openLayers(page, source.layer);
  await property(page, source.document.id, source.layer.id, '宽度', 'width', 300); await property(page, source.document.id, source.layer.id, '高度', 'height', 160); await property(page, source.document.id, source.layer.id, '角度', 'rotation', 30);
  const original = (await current(page, source.document.id)).layers.find(layer => layer.id === source.layer.id)!;
  await page.getByLabel('像素处理', { exact: true }).selectOption(operation);
  if (operation !== 'rotate') { await page.getByLabel('处理 width', { exact: true }).fill(operation === 'crop' ? '40' : '120'); await page.getByLabel('处理 height', { exact: true }).fill(operation === 'crop' ? '30' : '90'); }
  if (operation === 'crop') { await page.getByLabel('处理 x', { exact: true }).fill('11'); await page.getByLabel('处理 y', { exact: true }).fill('7'); }
  if (operation === 'rotate') {
    await page.getByLabel('像素旋转角度', { exact: true }).fill('45'); await page.getByRole('button', { name: '执行像素处理', exact: true }).click();
    let refused: ImageJob | undefined; await expect.poll(async () => { refused = (await get<ImageJob[]>(page, `/documents/${source.document.id}/jobs`)).find(job => !before.has(job.id) && job.operation === 'rotate'); return refused?.state; }).toBe('failed');
    expect(refused!.error).toMatch(/非等比|非等比例|non.?uniform|shear/i); expect((await current(page, source.document.id)).layers.find(layer => layer.id === source.layer.id)).toEqual(original);
    await expect(page.locator('.errorToast')).toBeVisible(); await page.getByRole('button', { name: 'dismiss', exact: true }).click();
    before = new Set((await get<ImageJob[]>(page, `/documents/${source.document.id}/jobs`)).map(job => job.id)); entries.get(page)!.anisometric45RefusedWithoutModification = true;
    await page.getByLabel('像素旋转角度', { exact: true }).fill('90');
  }
  await page.getByRole('button', { name: '执行像素处理', exact: true }).click(); const job = await completed(page, source.document.id, before, operation), decoded = await pixels(await bytes(page, String(job.output!.assetId)));
  const dimensions = operation === 'crop' ? [40, 30] : operation === 'pad' ? [120, 90] : [64, 96]; expect([decoded.info.width, decoded.info.height]).toEqual(dimensions);
  if (operation === 'crop') for (let y = 0; y < 30; y++) for (let x = 0; x < 40; x++) expect(rgba(decoded.data, 40, x, y)).toEqual(rgba(source.raw, 96, x + 11, y + 7));
  if (operation === 'pad') { expect(rgba(decoded.data, 120, 12, 13)).toEqual(rgba(source.raw, 96, 0, 0)); expect(rgba(decoded.data, 120, 0, 0)).toEqual([255, 255, 255, 255]); }
  if (operation === 'rotate') expect(rgba(decoded.data, 64, 63, 0)).toEqual(rgba(source.raw, 96, 0, 0));
  const updated = (await current(page, source.document.id)).layers.find(layer => layer.id === source.layer.id)!;
  const scaleX = original.width / 96, scaleY = original.height / 64;
  const display = operation === 'rotate' ? [64 * scaleY, 96 * scaleX] : [dimensions[0] * scaleX, dimensions[1] * scaleY];
  const shift = operation === 'crop' ? [11 * scaleX, 7 * scaleY] : operation === 'pad' ? [-12 * scaleX, -13 * scaleY] : [(original.width - display[0]) / 2, (original.height - display[1]) / 2];
  const angle = original.rotation * Math.PI / 180, position = [original.x + shift[0] * Math.cos(angle) - shift[1] * Math.sin(angle), original.y + shift[0] * Math.sin(angle) + shift[1] * Math.cos(angle)];
  Object.assign(entries.get(page)!, { sourcePixelDimensions: [96, 64], sourceDisplay: [original.width, original.height], sourcePosition: [original.x, original.y], sourceRotation: original.rotation, outputPixelDimensions: dimensions, outputDisplay: [updated.width, updated.height], outputPosition: [updated.x, updated.y], expectedPosition: position });
  expect([updated.width, updated.height], 'Pixel geometry must retain the scaled object density, not shrink the canvas object to source pixel units').toEqual(display);
  expect(updated.x).toBeCloseTo(position[0], 8); expect(updated.y).toBeCloseTo(position[1], 8); expect(updated.rotation).toBe(original.rotation);
  await close(page); await page.reload(); await expect(page.locator('.toolDock')).toBeVisible(); const image = page.locator(`.tl-shape[data-shape-id="${source.shapeId}"] img`); await expect.poll(() => image.evaluate((node: HTMLImageElement) => node.complete ? node.naturalWidth : 0)).toBe(dimensions[0]);
  const rendered = await image.evaluate((node: HTMLImageElement) => [node.clientWidth, node.clientHeight]); expect(rendered).toEqual(display);
});

test('native duplicate shares immutable source but original pixel buttons edit only the selected layer', async ({ page }) => {
  const source = await fixture(page); await openLayers(page, source.layer); await close(page);
  const shape = page.locator(`.tl-shape[data-shape-id="${source.shapeId}"]`), box = (await shape.boundingBox())!; await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' }); await page.getByRole('button', { name: '复制所选', exact: true }).click();
  await expect.poll(async () => (await current(page, source.document.id)).layers.length).toBe(2); const duplicated = (await current(page, source.document.id)).layers.find(layer => layer.id !== source.layer.id)!;
  expect(duplicated.assetId).toBe(source.layer.assetId); expect(duplicated.metadata?.legacyShapeId).not.toBe(source.shapeId); expect([duplicated.x, duplicated.y]).toEqual([source.layer.x + 32, source.layer.y + 32]);
  await page.getByRole('button', { name: 'layers', exact: true }).click(); await page.getByRole('button', { name: `图片 · ${duplicated.name}`, exact: true }).first().click(); await property(page, source.document.id, duplicated.id, '图层名称', 'name', '仅修改副本');
  const before = new Set((await get<ImageJob[]>(page, `/documents/${source.document.id}/jobs`)).map(job => job.id)); await page.getByLabel('像素处理', { exact: true }).selectOption('flip'); await page.getByLabel('翻转方向', { exact: true }).selectOption('vertical'); await page.getByRole('button', { name: '执行像素处理', exact: true }).click();
  const job = await completed(page, source.document.id, before, 'flip'), result = await pixels(await bytes(page, String(job.output!.assetId))); for (let y = 0; y < 64; y++) for (let x = 0; x < 96; x++) expect(rgba(result.data, 96, x, y)).toEqual(rgba(source.raw, 96, x, 63 - y));
  const doc = await current(page, source.document.id); expect(doc.layers.find(layer => layer.id === source.layer.id)).toEqual(source.layer); expect(doc.layers.find(layer => layer.id === duplicated.id)?.assetId).toBe(job.output!.assetId); expect(await bytes(page, source.layer.assetId!)).toEqual(source.png); Object.assign(entries.get(page)!, { selectedCopyId: duplicated.id, originalLayerUnchanged: true, sharedImmutableSource: source.layer.assetId });
});

test('original group hide lock undo redo retain negative coordinates and export transparent pixels', async ({ page }) => {
  const source = await fixture(page); await openLayers(page, source.layer); await property(page, source.document.id, source.layer.id, '横向位置', 'x', -100); await property(page, source.document.id, source.layer.id, '纵向位置', 'y', -60);
  await page.getByLabel('上传 SVG / 图片', { exact: true }).setInputFiles({ name: 'group-second.png', mimeType: 'image/png', buffer: source.png }); await expect(page.getByRole('button', { name: '图片 · group-second.png', exact: true })).toBeVisible();
  let doc = await current(page, source.document.id); const second = doc.layers.find(layer => layer.name === 'group-second.png')!; await property(page, doc.id, second.id, '横向位置', 'x', 300); await property(page, doc.id, second.id, '纵向位置', 'y', -20);
  await page.getByRole('checkbox', { name: `组合 ${source.layer.name}`, exact: true }).check(); await page.getByRole('checkbox', { name: `组合 ${second.name}`, exact: true }).check(); await page.getByRole('button', { name: '编组所选', exact: true }).click(); await expect(page.getByRole('button', { name: '组 · 组合', exact: true })).toBeVisible(); await page.getByRole('button', { name: '组 · 组合', exact: true }).click();
  doc = await current(page, source.document.id); const group = doc.layers.find(layer => layer.type === 'group')!; expect([group.x, group.y]).toEqual([-100, -60]); await close(page); const shown = await download(page, doc.id, 'png', 'group-shown');
  await openLayers(page, group); await page.getByRole('button', { name: '组合隐藏', exact: true }).click(); await expect.poll(async () => (await current(page, doc.id)).layers.find(layer => layer.id === group.id)?.visible).toBe(false); await close(page); await expect(page.locator(`.tl-shape[data-shape-id="${source.shapeId}"]`)).toBeHidden(); const hidden = await download(page, doc.id, 'png', 'group-hidden');
  const blank = await pixels(hidden.buffer); expect([...blank.data].filter((_: number, index: number) => index % 4 === 3).every(value => value === 0)).toBe(true);
  await page.getByRole('button', { name: 'versions', exact: true }).click(); await page.getByRole('dialog').getByRole('button', { name: '撤销', exact: true }).click(); await expect.poll(async () => (await current(page, doc.id)).layers.find(layer => layer.id === group.id)?.visible).toBe(true); await page.getByRole('dialog').getByRole('button', { name: '重做', exact: true }).click(); await expect.poll(async () => (await current(page, doc.id)).layers.find(layer => layer.id === group.id)?.visible).toBe(false); await page.getByRole('dialog').getByRole('button', { name: '撤销', exact: true }).click(); await close(page);
  await openLayers(page, group); await page.getByRole('button', { name: '组合锁定', exact: true }).click(); await expect(page.getByRole('checkbox', { name: '组合 组合', exact: true })).toBeDisabled(); await page.getByRole('button', { name: '组合解锁', exact: true }).click(); await close(page); const restored = await download(page, doc.id, 'png', 'group-restored'); expect((await pixels(restored.buffer)).data).toEqual((await pixels(shown.buffer)).data); Object.assign(entries.get(page)!, { hideExportsTransparent: true, shownRestoredPixelsExact: true, groupWorldOrigin: [-100, -60] });
});

test('original selected and full-page SVG PDF exports retain Logo path font and negative bounds after ZIP import', async ({ page }) => {
  const source = await fixture(page); await openLayers(page, source.layer); await property(page, source.document.id, source.layer.id, '横向位置', 'x', -300); await property(page, source.document.id, source.layer.id, '纵向位置', 'y', -100);
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30" viewBox="0 0 40 30"><path id="brand" fill="#168a55" d="M2 2H38V28H2Z"/></svg>'); await page.getByLabel('上传 SVG / 图片', { exact: true }).setInputFiles({ name: 'edge-logo.svg', mimeType: 'image/svg+xml', buffer: svg }); await expect(page.getByLabel('Logo 路径', { exact: true })).toBeVisible();
  let doc = await current(page, source.document.id); const logo = doc.layers.find(layer => layer.name === 'edge-logo.svg')!; await property(page, doc.id, logo.id, '横向位置', 'x', 160); await property(page, doc.id, logo.id, '纵向位置', 'y', 80); await close(page);
  const selectedSvg = await download(page, doc.id, 'svg', 'selected-logo'), selectedPdf = await download(page, doc.id, 'pdf', 'selected-logo'); expect(selectedSvg.buffer.toString()).toContain('d="M2 2H38V28H2Z"'); expect(selectedSvg.buffer.toString()).toContain('width="40" height="30"'); expect(selectedSvg.buffer.toString()).not.toContain('data:image/png'); expect(selectedPdf.buffer.subarray(0, 5).toString()).toBe('%PDF-'); expect(selectedPdf.buffer.toString('latin1')).toContain('/MediaBox [0 0 40 30]');
  await openLayers(page, logo); await page.getByRole('button', { name: '＋ 文字', exact: true }).click(); await page.getByLabel('文字内容', { exact: true }).fill('中文工程回迁'); await page.getByLabel('文字内容', { exact: true }).blur(); await expect.poll(async () => (await current(page, doc.id)).layers.find(layer => layer.type === 'text')?.text).toBe('中文工程回迁');
  const textId = (await current(page, doc.id)).layers.find(layer => layer.type === 'text')!.id;
  for (const [label, key, value] of [['横向位置', 'x', 0], ['纵向位置', 'y', -60], ['字号', 'fontSize', 18], ['宽度', 'width', 140], ['高度', 'height', 40]] as const) await property(page, doc.id, textId, label, key, value);
  await close(page); await page.mouse.click(900, 140); const fullSvg = await download(page, doc.id, 'svg', 'full-page'), fullPdf = await download(page, doc.id, 'pdf', 'full-page');
  expect(fullSvg.buffer.toString()).toContain('width="500" height="240"'); expect(fullSvg.buffer.toString()).toContain('data:image/png'); expect(fullSvg.buffer.toString()).toContain('@font-face'); expect(fullSvg.buffer.toString()).toContain('中文工程回迁'); expect(fullSvg.buffer.toString()).toContain('d="M2 2H38V28H2Z"'); expect(fullPdf.buffer.subarray(0, 5).toString()).toBe('%PDF-'); expect(fullPdf.buffer.toString('latin1')).toContain('/MediaBox [0 0 500 240]'); expect(fullPdf.buffer.toString('latin1')).toMatch(/\/Type \/Font\b/);
  doc = await current(page, doc.id); const text = doc.layers.find(layer => layer.type === 'text')!; expect(text.fontAssetId).toBeTruthy(); const originalFont = await bytes(page, text.fontAssetId!); await page.getByRole('button', { name: 'versions', exact: true }).click(); const taking = page.waitForEvent('download', { timeout: 40000 }); await page.getByRole('button', { name: '导出原生工程', exact: true }).click(); const archive = await taking, archivePath = `${output}/scoped-roundtrip.zip`; await archive.saveAs(archivePath); await page.getByLabel('导入原生工程', { exact: true }).setInputFiles(archivePath);
  let imported: ImageDocument | undefined; await expect.poll(async () => { imported = (await get<ImageDocument[]>(page, '/documents')).find(item => !item.parentDocumentId && item.id !== doc.id); return !!imported; }).toBe(true); entries.get(page)!.documentIds.add(imported!.id); expect(imported!.layers.map(layer => ({ type: layer.type, x: layer.x, y: layer.y, width: layer.width, height: layer.height, text: layer.text }))).toEqual(doc.layers.map(layer => ({ type: layer.type, x: layer.x, y: layer.y, width: layer.width, height: layer.height, text: layer.text })));
  const newLogo = imported!.layers.find(layer => layer.name === logo.name)!, newText = imported!.layers.find(layer => layer.type === 'text')!; expect(await bytes(page, newLogo.assetId!)).toEqual(svg); expect(await bytes(page, newText.fontAssetId!)).toEqual(originalFont);
  await close(page); await openLayers(page); await page.getByRole('button', { name: `文字 · ${newText.name}`, exact: true }).click(); await page.getByLabel('文字内容', { exact: true }).fill('回迁后继续改字'); await page.getByLabel('文字内容', { exact: true }).blur(); await expect.poll(async () => (await current(page, imported!.id)).layers.find(layer => layer.id === newText.id)?.text).toBe('回迁后继续改字'); expect((await current(page, doc.id)).layers.find(layer => layer.id === text.id)?.text).toBe('中文工程回迁');
  Object.assign(entries.get(page)!, { selectedBounds: [40, 30], pageBounds: [500, 240], importedDocument: imported!.id, fontBytesPreserved: true, svgBytesPreserved: true, mixedChineseExport: true, importedTextIndependentlyEditable: true });
});
