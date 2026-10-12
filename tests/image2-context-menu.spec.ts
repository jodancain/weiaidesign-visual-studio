import { expect, test, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { ImageDocument, ImageJob } from '../lib/image2/types';

const require = createRequire(import.meta.url), sharp = require('../services/image2/node_modules/sharp');
const output = fileURLToPath(new URL('../../output/image2-context-menu-20261012/', import.meta.url));
type Entry = { title: string; pageErrors: string[]; external: string[]; modelRoutes: string[]; historyRequests: Array<Record<string, unknown>>; requests: Array<{ path: string; method: string; status: number }>; [key: string]: unknown };
const entries = new WeakMap<Page, Entry>();
test.beforeEach(async ({ page }, info) => {
  const entry: Entry = { title: info.title, pageErrors: [], external: [], modelRoutes: [], historyRequests: [], requests: [] }; entries.set(page, entry);
  page.on('pageerror', error => entry.pageErrors.push(error.message));
  page.on('response', response => { if (response.url().includes('/api/')) entry.requests.push({ path: new URL(response.url()).pathname, method: response.request().method(), status: response.status() }); });
  page.on('request', request => {
    const url = new URL(request.url());
    if (request.method() === 'POST' && /\/api\/v3\/image2\/documents\/[^/]+\/history$/.test(url.pathname)) entry.historyRequests.push(request.postDataJSON());
    if (request.method() === 'POST' && (/\/api\/(agent-chat|v1\/(images|image-edit|font-restyle|material-transfer|mask-inpaint))$/.test(url.pathname) || /\/api\/v3\/image2\/(runs|operations)$/.test(url.pathname))) entry.modelRoutes.push(url.pathname);
    if (/^https?:/.test(url.protocol) && !['127.0.0.1', 'localhost', 'cdn.tldraw.com'].includes(url.hostname)) entry.external.push(`${url.origin}${url.pathname}`);
  });
  await page.goto('/'); await expect(page.locator('.toolDock')).toBeVisible({ timeout: 30000 });
  const got = page.getByRole('button', { name: 'Got it', exact: true }); if (await got.isVisible()) await got.click();
  await expect(page).toHaveURL('http://127.0.0.1:18109/'); await expect(page.locator('.i2-workspace')).toHaveCount(0);
});
test.afterEach(async ({ page }, info) => {
  await mkdir(output, { recursive: true }); const entry = entries.get(page)!, response = await page.request.get('http://127.0.0.1:18108/__test-audit'); expect(response.ok()).toBeTruthy(); const audit = await response.json();
  const documentsResponse = await page.request.get('/api/v3/image2/documents'); expect(documentsResponse.ok()).toBeTruthy(); const documents = (await documentsResponse.json()).data as ImageDocument[], jobs: ImageJob[] = [];
  for (const document of documents) { const result = await page.request.get(`/api/v3/image2/documents/${document.id}/jobs`); expect(result.ok()).toBeTruthy(); jobs.push(...(await result.json()).data); }
  const screenshot = `${info.title.replace(/[^a-z0-9_-]+/gi, '-').toLowerCase()}.png`; await page.screenshot({ path: `${output}/${screenshot}`, fullPage: true }).catch(() => {});
  const row = { ...entry, status: info.status, durationMs: info.duration, errors: info.errors.map(error => error.message), screenshot, audit, jobs };
  let rows: Array<Record<string, unknown>> = []; try { rows = JSON.parse(await readFile(`${output}/matrix.json`, 'utf8')); } catch {}
  await writeFile(`${output}/matrix.json`, JSON.stringify([...rows.filter(item => item.title !== row.title), row], null, 2));
  expect(entry.pageErrors).toEqual([]); expect(entry.external).toEqual([]); expect(entry.modelRoutes).toEqual([]); expect(audit.externalAttempts).toEqual([]);
  for (const job of jobs) for (const field of ['generationCalls', 'llmCalls', 'visionCalls'] as const) expect(job.metrics?.[field], `${job.kind}:${field}`).toBe(0);
});
const menu = (page: Page) => page.locator('.contextMenu');
async function open(page: Page, x = 450, y = 220) { await page.mouse.click(x, y, { button: 'right' }); await expect(menu(page)).toHaveCount(1); await expect(menu(page)).toBeVisible(); }
async function uploaded(page: Page) {
  const png = await sharp({ create: { width: 96, height: 64, channels: 4, background: '#3477a2' } }).png().toBuffer();
  const choosing = page.waitForEvent('filechooser'); await page.locator('.toolDock').getByRole('button', { name: '上传图片', exact: true }).click(); await (await choosing).setFiles({ name: 'context-menu-source.png', mimeType: 'image/png', buffer: png });
  const shape = page.locator('.tl-shape[data-shape-type="image"]'); await expect(shape).toHaveCount(1); const image = shape.locator('img'); await expect.poll(() => image.evaluate((node: HTMLImageElement) => node.complete ? node.naturalWidth : 0)).toBe(96);
  await expect(page.locator('.selectionBar')).toHaveCount(0); return shape;
}

test('original canvas blank left click dismisses the context menu in one click', async ({ page }) => {
  await open(page); await page.mouse.click(850, 650); await expect(menu(page)).toHaveCount(0);
  await open(page, 420, 300); await page.mouse.click(800, 620); await expect(menu(page)).toHaveCount(0); entries.get(page)!.singleClickDismissal = true;
});

test('one original image left click dismisses the menu and selects the image', async ({ page }) => {
  const shape = await uploaded(page), box = (await shape.boundingBox())!; await open(page, 700, 220);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2); await expect(menu(page)).toHaveCount(0); await expect(page.locator('.selectionBar')).toBeVisible();
  const bar = page.locator('.selectionBar'); expect(Math.abs(Number.parseFloat(await bar.evaluate(node => (node as HTMLElement).style.left)) - (box.x + box.width / 2))).toBeLessThanOrEqual(1);
  entries.get(page)!.selectedAfterOneClick = true;
});

test('clicking original chat and project title dismisses the menu while controls still respond', async ({ page }) => {
  await open(page); const composer = page.getByRole('textbox', { name: 'Start with an idea, or type "@" to mention', exact: true }); await composer.click(); await expect(menu(page)).toHaveCount(0); await expect(composer).toBeFocused(); await composer.fill('只输入，不发送'); await expect(composer).toHaveValue('只输入，不发送');
  await open(page); const title = page.getByLabel('project title', { exact: true }); await title.click(); await expect(menu(page)).toHaveCount(0); await expect(title).toBeFocused(); await title.fill('菜单关闭后可改项目名'); await title.press('Enter'); await expect(title).toHaveValue('菜单关闭后可改项目名');
  entries.get(page)!.outsideControlsRemainOperable = ['chat', 'project title'];
});

test('Escape dismisses the original context menu', async ({ page }) => {
  await open(page); await page.keyboard.press('Escape'); await expect(menu(page)).toHaveCount(0); await expect(page.locator('.toolDock')).toBeVisible(); entries.get(page)!.escapeDismissal = true;
});

test('switching the original drawing tool dismisses the menu and enables the brush bar', async ({ page }) => {
  await open(page); const draw = page.locator('.toolDock').getByRole('button', { name: '画笔', exact: true }); await draw.click(); await expect(menu(page)).toHaveCount(0); await expect(draw).toHaveClass(/active/); await expect(page.locator('.brushBar')).toBeVisible();
  await page.locator('.brushBar').getByRole('button', { name: 'red', exact: true }).click(); await expect(page.locator('.brushBar').getByRole('button', { name: 'red', exact: true })).toHaveClass(/on/);
  await page.mouse.move(250, 250); await page.mouse.down(); await page.mouse.move(340, 290, { steps: 5 }); await page.mouse.up(); await expect(page.locator('.tl-shape[data-shape-type="draw"]')).toHaveCount(1); entries.get(page)!.brushStillDraws = true;
});

test('wheel over the original canvas dismisses the context menu', async ({ page }) => {
  await open(page); await page.mouse.move(850, 650); await page.mouse.wheel(0, 150); await expect(menu(page)).toHaveCount(0); entries.get(page)!.wheelDismissal = true;
});

test('the original menu copy item runs exactly once and closes the menu', async ({ page }) => {
  const shape = await uploaded(page), box = (await shape.boundingBox())!; await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2); await expect(page.locator('.selectionBar')).toBeVisible();
  // tldraw deselects on a blank-space right pointerdown. Open over the selected
  // image, so this case exercises an enabled copy action rather than no selection.
  const originalId = await shape.getAttribute('data-shape-id'); await open(page, box.x + box.width / 2, box.y + box.height / 2); await menu(page).getByRole('button', { name: '复制所选', exact: true }).click(); await expect(menu(page)).toHaveCount(0); await expect(page.locator('.tl-shape[data-shape-type="image"]')).toHaveCount(2);
  // Check after a subsequent real pointer action as well as the immediate event,
  // so a duplicate pointer/click handler cannot produce a late third object.
  await page.mouse.click(850, 650); const ids = await page.locator('.tl-shape[data-shape-type="image"]').evaluateAll(shapes => shapes.map(item => item.getAttribute('data-shape-id'))); expect(ids).toHaveLength(2); expect(new Set(ids).size).toBe(2); expect(ids).toContain(originalId); entries.get(page)!.copyExecutions = 1; entries.get(page)!.imageShapeIds = ids;
});

test('repeated original right clicks reopen one correctly positioned menu and resize dismisses it', async ({ page }) => {
  await open(page, 450, 220); let box = (await menu(page).boundingBox())!; expect([box.x, box.y]).toEqual([450, 220]);
  await open(page, 650, 320); box = (await menu(page).boundingBox())!; expect([box.x, box.y]).toEqual([650, 320]); await expect(menu(page)).toHaveCount(1);
  await page.mouse.click(850, 150); await expect(menu(page)).toHaveCount(0); await open(page, 400, 600); box = (await menu(page).boundingBox())!; expect([box.x, box.y]).toEqual([400, 600]);
  await page.setViewportSize({ width: 1280, height: 900 }); await expect(menu(page)).toHaveCount(0); entries.get(page)!.repeatedPositions = [[450, 220], [650, 320], [400, 600]]; entries.get(page)!.resizeDismissal = true;
});

test('original imported project Command Z and Shift Command Z each dismiss the menu and execute history once', async ({ page }) => {
  const shape = await uploaded(page), shapeId = await shape.getAttribute('data-shape-id'); await page.getByRole('button', { name: 'layers', exact: true }).click(); await page.getByRole('button', { name: '确认导入当前画布', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 30000 });
  const readDocuments = async () => { const response = await page.request.get('/api/v3/image2/documents'); expect(response.ok()).toBeTruthy(); return (await response.json()).data as ImageDocument[]; };
  let document: ImageDocument | undefined; await expect.poll(async () => { document = (await readDocuments()).find(item => !item.parentDocumentId && item.metadata?.legacyImportComplete === true && item.layers.some(layer => layer.metadata?.legacyShapeId === shapeId)); return !!document; }).toBe(true);
  const layer = document!.layers.find(item => item.metadata?.legacyShapeId === shapeId)!, initialX = layer.x, movedX = initialX + 10;
  const layerX = async () => { const response = await page.request.get(`/api/v3/image2/documents/${document!.id}`); expect(response.ok()).toBeTruthy(); return ((await response.json()).data as ImageDocument).layers.find(item => item.id === layer.id)?.x; };
  await page.getByRole('button', { name: 'layers', exact: true }).click(); await page.getByRole('button', { name: `图片 · ${layer.name}`, exact: true }).click(); await page.getByLabel('横向位置', { exact: true }).fill(String(movedX)); await page.getByLabel('横向位置', { exact: true }).blur(); await expect.poll(layerX).toBe(movedX); await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  await open(page, 700, 220); await page.keyboard.press('Meta+z'); await expect(menu(page)).toHaveCount(0); await expect.poll(layerX).toBe(initialX); await expect.poll(() => entries.get(page)!.historyRequests.length).toBe(1);
  await open(page, 700, 220); await page.keyboard.press('Meta+Shift+z'); await expect(menu(page)).toHaveCount(0); await expect.poll(layerX).toBe(movedX); await expect.poll(() => entries.get(page)!.historyRequests.length).toBe(2);
  const history = entries.get(page)!.historyRequests; expect(history.map(request => request.direction)).toEqual(['undo', 'redo']); expect(new Set(history.map(request => request.commandId)).size).toBe(2); entries.get(page)!.historyOnceEach = true; entries.get(page)!.historyCoordinates = [movedX, initialX, movedX]; entries.get(page)!.documentId = document!.id;
});
