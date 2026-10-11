import test from 'node:test';
import assert from 'node:assert/strict';
import { projectBundle } from '../exports.mjs';

const document = assetIds => ({ id: 'budget', name: 'budget', width: 1, height: 1, layers: [], assetIds });
test('project export rejects too many files before producing an archive that cannot be imported', async () => {
  const ids = Array.from({ length: 2000 }, (_, i) => `asset-${i}`);
  await assert.rejects(projectBundle(document(ids), [], async id => ({ asset: { id, mime: 'image/png', metadata: {} }, bytes: Buffer.from('fixture') })), error => error.code === 'bundle_too_large');
});
test('project export rejects a source asset beyond the importer per-file limit', async () => {
  await assert.rejects(projectBundle(document(['large']), [], async id => ({ asset: { id, mime: 'image/png', metadata: {} }, bytes: Buffer.alloc(64 * 1024 * 1024 + 1) })), error => error.code === 'bundle_too_large');
});
