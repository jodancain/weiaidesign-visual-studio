import { expect, test } from '@playwright/test';
import type { ImageDocument } from '../lib/image2/types';
import { readFile } from 'node:fs/promises';
test('real client requests persist typed edits, keep source patches until font confirmation, and disable unavailable models', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && /Maximum update depth/.test(message.text())) errors.push(message.text()); });
  let document: ImageDocument = { id: 'test-doc', name: '中文 Logo 测试', schemaVersion: 2, revision: 1, width: 200, height: 100, assetIds: ['patch'], createdAt: 0, updatedAt: 0,
    layers: [{ id: 'text-1', type: 'text', name: '原字形', text: '原中文字', x: 0, y: 0, width: 200, height: 100, rotation: 0, opacity: 1, visible: true, locked: false, z: 0, assetId: 'patch', metadata: { fontConfirmed: false, fontCandidates: [{ family: '候选中文字体', estimatedFontSize: 24.5, originalFont: 'unknown', geometryFit: { score: .98 } }] } }] };
  const commands: Array<{ baseRevision: number; commands: Array<{ patch: Record<string, unknown> }> }> = [];
  await page.route('**/api/v3/session', route => route.fulfill({ json: { data: { anonymous: true } } }));
  await page.route('**/api/v3/image2/**', async route => {
    const url = new URL(route.request().url()), path = url.pathname.replace('/api/v3/image2', '');
    let data: unknown = [];
    if (path === '/documents') data = [document];
    else if (path === '/capabilities') data = { operations: [{ name: 'resize', available: true }, { name: 'prepare_text', available: true }, { name: 'inpaint', available: false, reason: '生成模型未配置' }], agent: { available: false } };
    else if (path === '/documents/test-doc') data = document;
    else if (path === '/documents/test-doc/assets') data = [{ id: 'patch', mime: 'image/svg+xml', name: 'source.svg' }, ...(document.layers[0].fontAssetId ? [{ id: 'test-font', mime: 'font/woff2', name: 'test.woff2' }] : [])];
    else if (path === '/assets/default-font') data = { id: 'test-font', mime: 'font/woff2', name: 'test.woff2', metadata: { family: 'Source Han Sans' } };
    else if (path === '/operations') { document.layers[0].metadata = { ...document.layers[0].metadata, cleanBackgroundAssetId: 'clean-patch' }; document = { ...document, revision: document.revision + 1 }; data = { job: { id: '804046b5-e6b7-4d50-93ad-6f6f0d2c4486', documentId: document.id, kind: 'operation', operation: 'prepare_text', state: 'complete' } }; }
    else if (path === '/jobs/804046b5-e6b7-4d50-93ad-6f6f0d2c4486') data = { id: '804046b5-e6b7-4d50-93ad-6f6f0d2c4486', documentId: document.id, kind: 'operation', operation: 'prepare_text', state: 'complete' };
    else if (path === '/documents/test-doc/commands') {
      const body = route.request().postDataJSON(); commands.push(body);
      expect(body.baseRevision).toBe(document.revision);
      for (const command of body.commands) { if (command.type === 'layer.update') Object.assign(document.layers[0], command.patch); if (command.type === 'layer.add') document.layers.push(command.layer); }
      document = { ...document, revision: document.revision + 1 }; data = document;
    } else if (path === '/assets/patch/content' || path === '/assets/clean-patch/content') { await route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="#ded5ba"/></svg>' }); return; }
    else if (path === '/assets/test-font/content') { await route.fulfill({ contentType: 'font/woff2', body: await readFile(new URL('../public/fonts/source-han-sans.woff2', import.meta.url)) }); return; }
    await route.fulfill({ json: { data } });
  });
  await page.goto('/image2'); await expect(page.getByTestId('image2-canvas')).toBeVisible();
  await page.getByRole('button', { name: '文 · 原字形', exact: true }).click();
  await expect(page.getByText('目前保留原字形。确认字体后，改字才会使用真实字体渲染。')).toBeVisible();
  await expect(page.getByLabel('字体候选')).toContainText('按字形尺寸拟合，原字体仍待确认');
  await expect(page.getByLabel('字体候选')).toContainText('候选中文字体 · 建议字号 24.5');
  expect(document.layers[0].metadata?.fontConfirmed).toBe(false); expect(commands).toHaveLength(0);
  const input = page.getByLabel('文字内容'); await input.fill('新中文 Logo'); await input.blur();
  await expect.poll(() => commands.length).toBe(1);
  expect(document.layers[0].text).toBe('原中文字'); expect(document.layers[0].metadata?.desiredText).toBe('新中文 Logo');
  await page.getByLabel('图片处理').selectOption('inpaint');
  await expect(page.getByRole('button', { name: '局部补画', exact: true })).toBeDisabled();
  await expect(page.getByText('生成模型未配置')).toBeVisible();
  await page.getByRole('button', { name: '使用内置中文字体' }).click();
  await expect.poll(() => commands.length).toBe(2); expect(document.layers[0].text).toBe('新中文 Logo'); expect(document.layers[0].metadata?.fontConfirmed).toBe(true);
  expect(document.layers[0].metadata?.cleanBackgroundAssetId).toBe('clean-patch');
  expect(document.layers[0].metadata?.backgroundDetached).toBe(true);
  expect(document.layers.find(layer => layer.metadata?.role === 'text_background')?.assetId).toBe('clean-patch');
  await expect(page.getByLabel('图片处理')).toHaveCount(0);
  expect(errors).toEqual([]);
});
test('an offline edit survives reload and resends the same idempotent command', async ({ page }) => {
  let document: ImageDocument = { id: 'offline-doc', name: '本地恢复测试', schemaVersion: 2, revision: 2, width: 300, height: 200, assetIds: [], createdAt: 0, updatedAt: 0,
    layers: [{ id: 'raster-1', type: 'raster', name: '原图片层', x: 0, y: 0, width: 300, height: 200, rotation: 0, opacity: 1, visible: true, locked: false, z: 0 }] };
  const submissions: Array<{ commandId: string; baseRevision: number; commands: Array<{ patch: Record<string, unknown> }> }> = [];
  await page.route('**/api/v3/session', route => route.fulfill({ json: { data: { anonymous: true } } }));
  await page.route('**/api/v3/image2/**', async route => {
    const path = new URL(route.request().url()).pathname.replace('/api/v3/image2', ''); let data: unknown = [];
    if (path === '/documents') data = [document];
    else if (path === '/capabilities') data = { operations: [], agent: { available: false } };
    else if (path === '/documents/offline-doc') data = document;
    else if (path === '/documents/offline-doc/commands') {
      const body = route.request().postDataJSON(); submissions.push(body);
      if (submissions.length === 1) { await route.abort('connectionreset'); return; }
      for (const command of body.commands) Object.assign(document.layers[0], command.patch);
      document = { ...document, revision: 3 }; data = document;
    }
    await route.fulfill({ json: { data } });
  });
  await page.goto('/image2'); await page.getByRole('button', { name: '图 · 原图片层', exact: true }).click();
  const name = page.getByLabel('图层名称'); await name.fill('离线中文修改'); await name.blur();
  await expect.poll(() => submissions.length).toBe(1);
  await expect(page.getByRole('status')).toContainText('本地修改已保留');
  await page.reload(); await expect.poll(() => submissions.length).toBe(2);
  expect(submissions[0].commandId).toBe(submissions[1].commandId); expect(submissions[1].baseRevision).toBe(2);
  await expect(page.getByRole('button', { name: '图 · 离线中文修改', exact: true })).toBeVisible();
});
test('Logo path paint edits affect actual SVG pixels and persist export-compatible path styles', async ({ page }) => {
  let document: ImageDocument = { id: 'logo-doc', name: 'Logo 测试', schemaVersion: 2, revision: 1, width: 100, height: 100, assetIds: ['logo'], createdAt: 0, updatedAt: 0,
    layers: [{ id: 'logo-1', type: 'vector', name: 'Logo', x: 0, y: 0, width: 100, height: 100, rotation: 0, opacity: 1, visible: true, locked: false, z: 0, assetId: 'logo' }] };
  await page.route('**/api/v3/session', route => route.fulfill({ json: { data: {} } }));
  await page.route('**/api/v3/image2/**', async route => {
    const path = new URL(route.request().url()).pathname.replace('/api/v3/image2', ''); let data: unknown = [];
    if (path === '/documents') data = [document];
    else if (path === '/capabilities') data = { operations: [], agent: { available: false } };
    else if (path === '/documents/logo-doc') data = document;
    else if (path === '/assets/logo/content') { await route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><style>.st0{fill:#333333}</style><path id="symbol" class="st0" d="M 5 5 L 95 5 L 95 95 L 5 95 Z"/></svg>' }); return; }
    else if (path === '/documents/logo-doc/commands') { const body = route.request().postDataJSON(); for (const command of body.commands) Object.assign(document.layers[0], command.patch); document = { ...document, revision: document.revision + 1 }; data = document; }
    await route.fulfill({ json: { data } });
  });
  await page.goto('/image2'); await page.getByRole('button', { name: '形 · Logo', exact: true }).click();
  await expect.poll(() => page.locator('.i2-svg path').evaluate(element => getComputedStyle(element).fill)).toBe('rgb(51, 51, 51)');
  await page.getByLabel('Logo 路径').selectOption('symbol');
  await page.getByLabel('Logo 填色').evaluate((element: HTMLInputElement) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, '#e03131');
    element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(page.locator('.i2-svg path')).toHaveAttribute('fill', '#e03131');
  await expect.poll(() => page.locator('.i2-svg path').evaluate(element => getComputedStyle(element).fill)).toBe('rgb(224, 49, 49)');
  await expect.poll(() => document.revision).toBe(2);
  expect(document.layers[0].metadata?.pathStyles).toEqual({ symbol: { fill: '#e03131' } });
});
test('two Logos with the same gradient id keep their own resources and original class paint', async ({ page }) => {
  const document: ImageDocument = { id: 'gradients', name: '双色 Logo', schemaVersion: 2, revision: 1, width: 220, height: 100, assetIds: ['red', 'blue'], createdAt: 0, updatedAt: 0,
    layers: ['red', 'blue'].map((id, z) => ({ id, type: 'vector', name: id, x: z * 110, y: 0, width: 100, height: 100, rotation: 0, opacity: 1, visible: true, locked: false, z, assetId: id })) };
  await page.route('**/api/v3/session', route => route.fulfill({ json: { data: {} } }));
  await page.route('**/api/v3/image2/**', async route => {
    const path = new URL(route.request().url()).pathname.replace('/api/v3/image2', ''); let data: unknown = [];
    if (path === '/documents') data = [document]; else if (path === '/documents/gradients') data = document; else if (path === '/capabilities') data = { operations: [], agent: { available: false } };
    else if (/\/assets\/(red|blue)\/content/.test(path)) {
      const red = path.includes('/red/'), color = red ? '#ff0000' : '#0000ff';
      await route.fulfill({ contentType: 'image/svg+xml', body: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="paint0"><stop stop-color="${color}"/><stop offset="1" stop-color="#ffffff"/></linearGradient></defs><style>.mark{fill:url('#paint0')}</style><path id="mark" class="mark" d="M0 0H100V100H0Z"/></svg>` }); return;
    }
    await route.fulfill({ json: { data } });
  });
  await page.goto('/image2'); await expect(page.locator('.i2-svg linearGradient')).toHaveCount(2);
  const ids = await page.locator('.i2-svg linearGradient').evaluateAll(elements => elements.map(element => element.id));
  expect(new Set(ids).size).toBe(2);
  const paints = await page.locator('.i2-svg path').evaluateAll(elements => elements.map(element => getComputedStyle(element).fill));
  expect(paints[0]).toContain(ids[0]); expect(paints[1]).toContain(ids[1]);
  const palettes = await page.locator('.i2-svg').evaluateAll(elements => elements.map(element => ({ scope: element.querySelector('svg')!.id, colors: Array.from(element.querySelectorAll('stop')).map(stop => stop.getAttribute('stop-color')) })));
  expect(palettes.find(item => item.scope.includes('vector-red'))?.colors).toEqual(['#ff0000', '#ffffff']);
  expect(palettes.find(item => item.scope.includes('vector-blue'))?.colors).toEqual(['#0000ff', '#ffffff']);
});
