import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const projectId = 'binding-browser-project', originalId = '11111111-1111-4111-8111-111111111111', duplicateId = '22222222-2222-4222-8222-222222222222', fontId = '33333333-3333-4333-8333-333333333333';
const original = { id: originalId, name: '绑定回归验收', schemaVersion: 2, revision: 4, width: 1024, height: 1024, createdAt: '2026-10-15T00:00:00.000Z', updatedAt: '2026-10-15T00:00:04.000Z', metadata: { legacyProjectId: projectId, legacyImportComplete: true }, assetIds: [fontId], layers: [{ id: '44444444-4444-4444-8444-444444444444', type: 'text', name: '文字', x: 20, y: 20, width: 300, height: 80, rotation: 0, opacity: 1, visible: true, locked: false, z: 0, text: '中文生产验收 MAI 123', fontSize: 44, fontAssetId: fontId, fontFamily: 'Noto Sans CJK SC', fontWeight: 400, fill: '#222222', lineHeight: 1.35, tracking: 0, metadata: { fontConfirmed: true } }] };
const duplicate = { ...original, id: duplicateId, revision: 0, layers: [], assetIds: [] };
const held = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
async function fixture(page: Page, mapped: string, delay?: ReturnType<typeof held>, failRead = false) {
  const font = await readFile(resolve('services/image2/fonts/NotoSansCJKsc-Regular.otf'));
  const mutations: string[] = [], errors: string[] = [], getStarted = held(); let intercepted = false;
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ projectId, mapped }) => {
    if (localStorage.getItem('binding-fixture')) return;
    localStorage.setItem('binding-fixture', '1'); localStorage.setItem('lovartVoiceTipSeen', '1');
    localStorage.setItem('lovartProjects', JSON.stringify([{ id: 'default', name: 'Untitled', ts: 1 }, { id: projectId, name: '绑定回归验收', ts: 2 }]));
    localStorage.setItem('lovartActiveProjectId', projectId); localStorage.setItem(`image2-original-project:${projectId}`, mapped);
  }, { projectId, mapped });
  await page.route('**/api/**', async route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    if (req.method() !== 'GET') { mutations.push(`${req.method()} ${path}`); return route.fulfill({ status: 500, json: { detail: 'Unexpected mutating request in read-only binding fixture' } }); }
    if (path === `/api/v3/image2/documents/${mapped}` && !intercepted) { intercepted = true; getStarted.release(); if (delay) await delay.promise; if (failRead) return route.fulfill({ status: 502, json: { detail: 'Synthetic lookup failure' } }); }
    if (path === `/api/v3/image2/assets/${fontId}/content`) return route.fulfill({ status: 200, contentType: 'font/otf', body: font });
    if (path === '/api/v3/session') return route.fulfill({ status: 200, json: { data: {} } });
    if (path === '/api/v3/image2/capabilities') return route.fulfill({ status: 200, json: { data: { operations: [] } } });
    if (path === '/api/v3/image2/documents') return route.fulfill({ status: 200, json: { data: [duplicate, original] } });
    if (path === `/api/v3/image2/documents/${originalId}`) return route.fulfill({ status: 200, json: { data: original } });
    if (path === `/api/v3/image2/documents/${duplicateId}`) return route.fulfill({ status: 200, json: { data: duplicate } });
    if (path === `/api/v3/image2/documents/${originalId}/assets`) return route.fulfill({ status: 200, json: { data: [{ id: fontId, documentId: originalId, name: 'NotoSansCJKsc-Regular.otf', mime: 'font/otf', bytes: font.length, hash: '2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b' }] } });
    if (path.endsWith('/revisions')) return route.fulfill({ status: 200, json: { data: [path.includes(originalId) ? original : duplicate] } });
    return route.fulfill({ status: 200, json: { data: [] } });
  });
  await page.goto('/'); await expect(page.locator('.toolDock')).toBeVisible(); await getStarted.promise;
  return { mutations, errors };
}

test('early Layers click during a delayed mapped-document GET keeps the saved Chinese revision through reload', async ({ page }) => {
  const delay = held(), evidence = await fixture(page, originalId, delay);
  await page.getByRole('button', { name: 'layers', exact: true }).click();
  expect(evidence.mutations).toEqual([]); delay.release();
  await page.getByRole('button', { name: '文字 · 文字', exact: true }).click();
  await expect(page.getByLabel('文字内容', { exact: true })).toHaveValue('中文生产验收 MAI 123');
  await expect(page.getByLabel('字号', { exact: true })).toHaveValue('44');
  expect(await page.evaluate(key => localStorage.getItem(key), `image2-original-project:${projectId}`)).toBe(originalId);
  await page.reload(); await page.getByRole('button', { name: 'layers', exact: true }).click();
  await page.getByRole('button', { name: '文字 · 文字', exact: true }).click();
  await expect(page.getByLabel('文字内容', { exact: true })).toHaveValue('中文生产验收 MAI 123');
  expect(evidence.mutations).toEqual([]); expect(evidence.errors).toEqual([]);
});

test('lookup 502 plus an early Layers click never creates a replacement document', async ({ page }) => {
  const delay = held(), evidence = await fixture(page, originalId, delay, true);
  await page.getByRole('button', { name: 'layers', exact: true }).click(); delay.release();
  await expect(page.getByText('Synthetic lookup failure', { exact: false }).first()).toBeVisible();
  expect(evidence.mutations).toEqual([]);
  expect(await page.evaluate(key => localStorage.getItem(key), `image2-original-project:${projectId}`)).toBe(originalId);
});

test('explicit versions-dialog recovery opens the preserved document and leaves both server records untouched', async ({ page }) => {
  const evidence = await fixture(page, duplicateId);
  await page.getByRole('button', { name: 'versions', exact: true }).click();
  await page.getByRole('button', { name: '查找同项目保存的文档', exact: true }).click();
  await expect(page.getByRole('button', { name: '打开版本 4 的文档', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '打开版本 4 的文档', exact: true }).click();
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), `image2-original-project:${projectId}`)).toBe(originalId);
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  await page.reload(); await page.getByRole('button', { name: 'layers', exact: true }).click();
  await page.getByRole('button', { name: '文字 · 文字', exact: true }).click();
  await expect(page.getByLabel('文字内容', { exact: true })).toHaveValue('中文生产验收 MAI 123');
  expect(evidence.mutations).toEqual([]); expect(original.revision).toBe(4); expect(duplicate.revision).toBe(0); expect(evidence.errors).toEqual([]);
});

test('explicit recovery refuses a preserved local draft without changing its bytes or the current binding', async ({ page }) => {
  const evidence = await fixture(page, duplicateId);
  await page.getByRole('button', { name: 'versions', exact: true }).click();
  await page.getByRole('button', { name: '查找同项目保存的文档', exact: true }).click();
  const draft = { projectId, documentId: originalId, baseRevision: 4, savedAt: 1234, snapshot: { store: { 'native-shape': { text: '保留未提交草稿' } } } };
  await page.evaluate(draft => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('image-studio-original-drafts', 1);
    request.onsuccess = () => { const db = request.result, tx = db.transaction('drafts', 'readwrite'); tx.objectStore('drafts').put(draft); tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error); };
    request.onerror = () => reject(request.error);
  }), draft);
  await page.getByRole('button', { name: '打开版本 4 的文档', exact: true }).click();
  await expect(page.getByText('文档有保留草稿或待确认请求，未切换或清除任何记录', { exact: false }).first()).toBeVisible();
  const retained = await page.evaluate(project => new Promise((resolve, reject) => {
    const request = indexedDB.open('image-studio-original-drafts', 1);
    request.onsuccess = () => { const db = request.result, tx = db.transaction('drafts', 'readonly'), read = tx.objectStore('drafts').get(project); read.onsuccess = () => resolve(read.result); tx.oncomplete = () => db.close(); };
    request.onerror = () => reject(request.error);
  }), projectId);
  expect(retained).toEqual(draft);
  expect(await page.evaluate(key => localStorage.getItem(key), `image2-original-project:${projectId}`)).toBe(duplicateId);
  expect(evidence.mutations).toEqual([]);
});
