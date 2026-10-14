import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImageStore } from '../store.mjs';
import { ImageRunner } from '../jobs.mjs';
import { canonical, digest } from '../domain.mjs';
import { encodePNG, decodeRGBA } from '../processors.mjs';
import { documentPng } from '../exports.mjs';
import { exportV3Document } from '../exports-v3.mjs';

const OWNER = '11111111-1111-4111-8111-111111111111';
const TERMINAL = new Set(['complete', 'failed', 'uncertain', 'cancelled']);

test('original UI v2 adjust/filter/undo/exact-trace copy migrates actual provenance and every historical appearance without legacy UI asset IDs', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'image2-migration-processed-'));
  const store = new ImageStore(directory); let fetches = 0;
  const runner = new ImageRunner({ store, fetchImpl: async () => { fetches++; throw Error('External models are forbidden'); } });
  t.after(async () => { await runner.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const width = 16, height = 12, data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set([(x * 31) % 256, (y * 47) % 256, (x + y) % 2 ? 90 : 230, 255], (y * width + x) * 4);
  const bytes = await encodePNG({ width, height, data });
  const document = store.createDocument(OWNER, { width: 24, height: 20, metadata: { legacySnapshot: { records: [{ props: { assetId: 'asset:old-ui-only' } }] } } });
  const source = store.addAsset(document.id, OWNER, { name: 'source.png', mime: 'image/png' }, bytes);
  store.command(document.id, OWNER, { baseRevision: 0, commandId: 'original-ui', commands: [{ type: 'layer.add', layer: {
    id: 'photo', type: 'raster', assetId: source.id, sourceAssetId: source.id, x: 2, y: 3, width, height,
    metadata: { legacyShapeId: 'shape:original-ui', legacyRecord: { id: 'shape:original-ui', type: 'image', props: { assetId: 'asset:old-ui-only', w: width, h: height } }, sourceAssetIds: [source.id], nested: { sourceAssetId: source.id } },
  } }] });
  runner.start();
  async function operation(operation, params) {
    const current = store.getDocument(document.id, OWNER);
    const job = await runner.submit(OWNER, { documentId: current.id, baseRevision: current.revision, targetLayerId: 'photo', operation, params, inputs: [], idempotencyKey: `migration-${operation}` });
    const until = Date.now() + 60000;
    while (Date.now() < until) {
      const done = store.getJob(job.id, OWNER);
      if (TERMINAL.has(done.state)) { assert.equal(done.state, 'complete', `${operation}: ${done.error}`); return done; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw Error(`Migration fixture timed out: ${operation}, ${JSON.stringify(store.getJob(job.id, OWNER))}`);
  }
  const inverted = await operation('adjust', { kind: 'invert' });
  const filtered = await operation('filter', { kind: 'median', size: 3 });
  store.history(document.id, OWNER, { baseRevision: 3, commandId: 'undo-filter', direction: 'undo' });
  const traced = await operation('trace', { preset: 'exact' });
  const original = store.getDocument(document.id, OWNER), history = store.listRevisions(document.id, OWNER), jobs = store.listJobs(document.id, OWNER);
  const sourceAssets = new Map(store.listAssets(document.id, OWNER).map(asset => [asset.id, store.getAsset(asset.id, OWNER)]));
  assert.equal(original.revision, 5); assert.equal(original.layers[0].metadata.preset, 'exact');
  assert.equal(original.layers[0].metadata.legacyRecord.props.assetId, 'asset:old-ui-only');
  const migrated = store.migrateV3(document.id, OWNER, { sourceRevision: original.revision, idempotencyKey: 'processed-copy' });
  assert.deepEqual(migrated.originalSnapshot, store.getRevision(document.id, OWNER, original.revision));
  assert.equal(migrated.originalSnapshot.layers[0].metadata.legacyRecord.props.assetId, 'asset:old-ui-only');
  assert.equal(migrated.document.schemaVersion, 3);
  assert.equal(migrated.document.layers[0].metadata.legacyRecord, undefined);
  assert.equal(migrated.document.metadata.legacySnapshot, undefined);
  assert.equal(migrated.document.layers[0].metadata.legacyShapeId, 'shape:original-ui');
  assert.deepEqual(migrated.document.metadata.professionalSource, { documentId: original.id, revision: original.revision, hash: digest(original) });
  const notes = migrated.document.layers[0].metadata;
  for (const key of ['sourceAssetId', 'processingSourceAssetId', 'visibilitySourceAssetId']) {
    const old = key === 'sourceAssetId' ? original.layers[0].sourceAssetId : original.layers[0].metadata[key];
    assert.equal(notes[key], migrated.mappings.assets[old], key);
    assert.ok(migrated.document.assetIds.includes(notes[key]), key);
  }
  assert.deepEqual(notes.sourceAssetIds, [migrated.mappings.assets[source.id]]);
  assert.equal(notes.nested.sourceAssetId, migrated.mappings.assets[source.id]);
  for (const [oldId, record] of sourceAssets) {
    const copied = store.getAsset(migrated.mappings.assets[oldId], OWNER);
    assert.ok(copied.bytes.equals(record.bytes));
    assert.equal(copied.asset.hash, record.asset.hash);
    for (const [index, input] of (record.asset.inputs || []).entries()) {
      assert.equal(copied.asset.inputs[index].assetId, migrated.mappings.assets[input.assetId]);
      assert.equal(copied.asset.inputs[index].hash, input.hash);
    }
  }
  const copiedHistory = store.listRevisions(migrated.document.id, OWNER);
  assert.equal(copiedHistory.length, history.length);
  for (const [index, before] of history.entries()) {
    const originalPixels = await decodeRGBA(await documentPng(before, id => store.getAsset(id, OWNER)), 'image/png');
    const after = copiedHistory[index], result = await exportV3Document('png', after, { getAsset: id => store.getAsset(id, OWNER), bounds: { x: 0, y: 0, width: before.width, height: before.height } });
    const copiedPixels = await decodeRGBA(result.bytes, 'image/png');
    assert.deepEqual([copiedPixels.width, copiedPixels.height], [originalPixels.width, originalPixels.height]);
    assert.ok(copiedPixels.data.equals(originalPixels.data), `decoded RGBA differs at original revision ${before.revision}`);
  }
  assert.equal(canonical(store.getDocument(document.id, OWNER)), canonical(original));
  assert.equal(canonical(store.listRevisions(document.id, OWNER)), canonical(history));
  assert.equal(canonical(store.listJobs(document.id, OWNER)), canonical(jobs));
  assert.ok(store.getAsset(source.id, OWNER).bytes.equals(bytes));
  for (const job of [inverted, filtered, traced]) assert.deepEqual([job.metrics.llmCalls, job.metrics.visionCalls, job.metrics.generationCalls], [0, 0, 0]);
  assert.equal(fetches, 0);
});
