import test from 'node:test';
import assert from 'node:assert/strict';
import { maskPixelsForCanvas, savedMaskReferences, visibilityBackdrop } from '../lib/image2/masks';
import type { ImageLayer } from '../lib/image2/types';
const layer = (metadata: Record<string, unknown> = {}): ImageLayer => ({ id: 'layer', type: 'raster', name: '原图', x: 0, y: 0, width: 100, height: 80, rotation: 0, opacity: 1, visible: true, locked: false, z: 0, assetId: 'processed', sourceAssetId: 'original', sourceRect: [0, 0, 100, 80], metadata });

test('saved edit/protect masks remain separate from visibility masks and explicit cleared refs', () => {
  const current = layer({ editMaskAssetId: 'edit', protectMaskAssetId: 'protect', visibilityMaskAssetId: 'visible', visibilityProtectMaskAssetId: 'visible-protect' });
  assert.deepEqual(savedMaskReferences(current, 'edit'), { edit: 'edit', protect: 'protect' });
  assert.deepEqual(savedMaskReferences(current, 'visibility'), { edit: 'visible', protect: 'visible-protect' });
  current.metadata = { ...current.metadata, editMaskAssetId: null, protectMaskAssetId: null };
  assert.deepEqual(savedMaskReferences(current, 'edit'), { edit: undefined, protect: undefined });
});
test('loaded mask displays exact processor luminance-alpha including dark opaque and partially protected pixels', () => {
  const pixels = Uint8ClampedArray.from([0, 0, 0, 255, 255, 255, 255, 1, 255, 255, 255, 128, 255, 0, 0, 255]);
  assert.deepEqual([...maskPixelsForCanvas(pixels, 4, 1, 4, 1)].filter((_, index) => index % 4 === 3), [0, 1, 128, 54]);
  assert.throws(() => maskPixelsForCanvas(pixels, 4, 1, 2, 2), /尺寸不一致/);
});
test('visibility preview uses the processed baseline and never recovers a stale original after geometry or color edits', () => {
  const current = layer({ operation: 'crop', visibilitySourceAssetId: 'cropped-full', visibilitySourceRect: [0, 0, 40, 30] });
  assert.deepEqual(visibilityBackdrop(current), { assetId: 'cropped-full', rect: [0, 0, 40, 30] });
  for (const operation of ['crop', 'rotate', 'flip', 'recolor', 'refine_mask']) assert.equal(visibilityBackdrop(layer({ operation })), undefined);
  assert.deepEqual(visibilityBackdrop(layer()), { assetId: 'original', rect: [0, 0, 100, 80] });
});
