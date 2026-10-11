import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTemplate } from '../lib/image2/templates';
import type { ImageAsset, ImageDocument } from '../lib/image2/types';

const font: ImageAsset = { id: 'font', documentId: 'doc', name: '实际字体.otf', mime: 'font/otf', hash: 'font-hash', bytes: 20, createdAt: 1, metadata: { family: 'Noto Sans CJK SC' } };
const document: ImageDocument = { id: 'doc', name: '作品', schemaVersion: 2, revision: 3, width: 800, height: 1000, createdAt: 1, updatedAt: 1, assetIds: ['font','source','logo','paper'], layers: [
  { id: 'photo', type: 'raster', name: '原图', assetId: 'source', x: 0, y: 0, width: 400, height: 600, rotation: 24, visible: true, locked: true, opacity: .8, z: 0 },
  { id: 'logo-layer', type: 'vector', name: 'Logo', assetId: 'logo', x: 600, y: 800, width: 160, height: 80, rotation: 0, visible: true, locked: false, opacity: 1, z: 1 },
] };

for (const kind of ['poster','logo','print'] as const) test(`${kind} layout reuses actual assets and fonts without altering the source layers`, () => {
  const before = structuredClone(document); let next = 0;
  const commands = buildTemplate({ document, selected: document.layers[0], font, kind, idFactory: () => `new-${next++}`, paperAsset: { ...font, id: 'paper', mime: 'image/svg+xml' } });
  assert.deepEqual(document, before);
  assert.deepEqual(commands[0], { type: 'document.update', patch: { width: 1664 } });
  const layers = commands.filter(c => c.type === 'layer.add').map(c => c.layer);
  assert.equal(layers[0].type, 'group'); assert.equal(layers[0].x, 864);
  assert.ok(layers.every(l => !document.layers.some(old => old.id === l.id)));
  const text = layers.filter(l => l.type === 'text'); assert.ok(text.length >= 2);
  assert.ok(text.every(l => l.fontAssetId === font.id && l.metadata?.fontConfirmed && l.text));
  assert.ok(layers.some(l => l.assetId === (kind === 'logo' ? 'logo' : 'source')));
  for (const layer of layers.filter(l => l.type !== 'group')) { assert.equal(layer.parentId, layers[0].id); assert.ok(layer.x >= 0 && layer.y >= 0 && layer.y + layer.height <= 1000); }
});

test('templates reject missing actual font and excessive export canvas', () => {
  assert.throws(() => buildTemplate({ document: { ...document, assetIds: [] }, font, kind: 'poster' }), /实际字体/);
  assert.throws(() => buildTemplate({ document: { ...document, width: 25000 }, font, kind: 'poster' }), /画布过大/);
});
