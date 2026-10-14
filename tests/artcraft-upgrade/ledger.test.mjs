import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync, cpSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ImageStore } from '../../services/image2/store.mjs';
import { CraftService } from '../../services/image2/craft-service.mjs';
import { audit, assertPreserved, readWithStore, treeDigest, witness, legacyAudit } from '../../services/image2/ops/upgrade-ledger.mjs';
const bytes = Buffer.from('<svg width="10" height="10" xmlns="http://www.w3.org/2000/svg"><path d="M0 0 L10 10"/></svg>');
const owner = '11111111-1111-4111-8111-111111111111';
function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'upgrade-audit-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new ImageStore(dir); new CraftService({ store });
  const doc = store.createDocument(owner, { name: 'private content must not appear in receipt' });
  const asset = store.addAsset(doc.id, owner, { name: 'asset.svg', mime: 'image/svg+xml' }, bytes);
  const job = store.createJob(doc.id, owner, { kind: 'operation', idempotencyKey: 'uncertain-kept', input: { operation: 'crop', prompt: 'do-not-emit' } });
  store.updateJob(job.id, { state: 'uncertain' });
  const project = { id: 'native-fixture', documentId: doc.id, engineId: 'vectorcraft', revision: 1, nativeAssetId: asset.id, assetIds: [asset.id] };
  store.db.prepare('INSERT INTO craft_projects VALUES(?,?,?,?)').run(project.id, doc.id, project.engineId, JSON.stringify(project));
  store.db.prepare('INSERT INTO craft_revisions VALUES(?,?,?)').run(project.id, 1, JSON.stringify(project));
  store.db.prepare('INSERT INTO craft_receipts VALUES(?,?,?,?,?)').run(doc.id, 'accept', 'fixture', 'fixture', JSON.stringify(project));
  store.close(); return { dir, doc, asset, job };
}
test('audit retains uncertain receipts and fingerprints every table without private content', t => {
  const f = fixture(t), result = audit(f.dir, { requireCraft: true });
  assert.equal(result.active, 0); assert.equal(result.states.jobs.uncertain, 1);
  assert.equal(result.uncertain, 1); // Preserved terminal baseline, not active work.
  assert.equal(result.fingerprints.craft_revisions.count, 1); assert.equal(result.verifiedAssets, 1);
  assert.doesNotMatch(JSON.stringify(result), /private content|do-not-emit|11111111-1111/);
});

test('legacy audit covers in-process image and ontology work and never mutates receipts', t => {
  const root = mkdtempSync(join(tmpdir(), 'legacy-ledger-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const kind of ['_jobs', '_ontology']) mkdirSync(join(root, 'generated_images', kind), { recursive: true });
  const image = join(root, 'generated_images/_jobs/job.json'), ontology = join(root, 'generated_images/_ontology/item.json');
  writeFileSync(image, JSON.stringify({ state: 'done', prompt: 'never emit private content' }));
  writeFileSync(ontology, JSON.stringify({ state: 'review', anchors: [], shots: [] }));
  assert.equal(legacyAudit(root).active, 0);
  for (const item of [{ state: 'anchoring', anchors: [], shots: [] }, { state: 'review', anchors: [{ status: 'generating' }], shots: [] }]) {
    writeFileSync(ontology, JSON.stringify(item));
    const before = readFileSync(ontology); assert.equal(legacyAudit(root).active, 1);
    assert.deepEqual(readFileSync(ontology), before);
  }
  writeFileSync(ontology, JSON.stringify({ state: 'generating', anchors: [], shots: [{ status: 'running', video_job_id: 'gateway-durable-id' }] }));
  assert.equal(legacyAudit(root).active, 0); assert.equal(legacyAudit(root).externalVideoJobs, 1);
  writeFileSync(ontology, JSON.stringify({ state: 'generating', anchors: [{ status: 'generating' }], shots: [{ status: 'queued', video_job_id: 'gateway-durable-id' }] }));
  assert.equal(legacyAudit(root).active, 1); // Durable gateway work cannot hide an anchor Promise.
  writeFileSync(image, JSON.stringify({ state: 'running' })); assert.equal(legacyAudit(root).active, 2);
  assert.doesNotMatch(JSON.stringify(legacyAudit(root)), /never emit|job\.json|item\.json/);
  writeFileSync(ontology, '{partial'); assert.throws(() => legacyAudit(root));
});
test('queued work prevents a drain gate, unknown states fail closed', t => {
  const f = fixture(t), db = new DatabaseSync(join(f.dir, 'image2.sqlite'));
  for (const state of ['queued', 'running', 'new-unknown-state']) {
    db.prepare("UPDATE jobs SET json=json_set(json,'$.state',?)").run(state);
    assert.equal(audit(f.dir).active, 1);
  }
  db.close();
});
test('store-only readback and new CraftService reopen preserve native history, assets and receipts', async t => {
  const f = fixture(t), before = audit(f.dir);
  const module = resolve('services/image2/store.mjs');
  const oldShape = await readWithStore(f.dir, { storeModule: module });
  const reopened = await readWithStore(f.dir, { storeModule: module, craftModule: resolve('services/image2/craft-service.mjs') });
  assertPreserved(before, oldShape); assertPreserved(before, reopened); assert.equal(oldShape.workerStarted, false);
  // Local validation uses current Store only. Actual old digest is a target gate.
  assert.equal(oldShape.fullOldFeatureCompatibility, false);
});
test('audit rejects asset corruption, symlink escape and destructive old-reader mutation', t => {
  const f = fixture(t), before = audit(f.dir), assetPath = join(f.dir, 'assets', f.asset.hash);
  writeFileSync(assetPath, 'corrupted'); assert.throws(() => audit(f.dir), /hash mismatch/);
  writeFileSync(assetPath, bytes);
  const db = new DatabaseSync(join(f.dir, 'image2.sqlite')); db.exec('DELETE FROM craft_receipts'); db.close();
  assert.throws(() => assertPreserved(before, audit(f.dir)), /changed table craft_receipts/);
  symlinkSync('/etc/hosts', join(f.dir, 'assets', 'escape')); assert.throws(() => treeDigest(f.dir), /symlink/);
});
test('copied WAL is necessary: audit sees uncheckpointed accepted native changes', t => {
  const f = fixture(t), copy = realpathSync(mkdtempSync(join(tmpdir(), 'upgrade-wal-copy-')));
  t.after(() => rmSync(copy, { recursive: true, force: true }));
  const db = new DatabaseSync(join(f.dir, 'image2.sqlite')); db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');
  db.prepare('INSERT INTO craft_receipts VALUES(?,?,?,?,?)').run(f.doc.id, 'accept', 'wal-record', 'wal-hash', '{}');
  cpSync(f.dir, copy, { recursive: true });
  // Paths in a real restore remain /data/image2. This fixture maps copied paths.
  const clone = new DatabaseSync(join(copy, 'image2.sqlite'));
  clone.prepare('UPDATE assets SET path=replace(path,?,?)').run(f.dir, copy); clone.close();
  assert.equal(audit(copy).fingerprints.craft_receipts.count, 2); db.close();
});

test('uploaded off-canvas witness supplies a verified association, not JSON assetIds', t => {
  const f = fixture(t), w = witness(f.dir);
  assert.deepEqual(f.doc.assetIds, []); assert.equal(w.id, f.doc.id);
  assert.equal(w.assets[0].id, f.asset.id); assert.equal(w.assets[0].bytes, bytes.length);
  assert.equal(w.assets[0].sha256, f.asset.hash);
});
test('witness refuses missing, empty, malformed and corrupt assets during preflight', t => {
  const f = fixture(t), file = join(f.dir, 'assets', f.asset.hash);
  for (const value of ['', 'corrupt']) { writeFileSync(file, value); assert.throws(() => witness(f.dir), /no valid/); }
  rmSync(file); assert.throws(() => witness(f.dir), /no valid/);
  writeFileSync(file, bytes);
  const db = new DatabaseSync(join(f.dir, 'image2.sqlite'));
  db.prepare('UPDATE assets SET json=?').run('{malformed'); db.close();
  assert.throws(() => witness(f.dir), /no valid/);
});

test('historical uncertainty fingerprint remains stable while new uncertain transitions are detectable', t => {
  const f = fixture(t), baseline = audit(f.dir);
  assert.equal(baseline.active, 0); assert.equal(baseline.uncertainRecords.length, 1);
  assert.deepEqual(audit(f.dir).uncertainRecords, baseline.uncertainRecords);
  const store = new ImageStore(f.dir);
  const job = store.createJob(f.doc.id, owner, { kind: 'operation', idempotencyKey: 'new-uncertain', input: {} });
  store.updateJob(job.id, { state: 'uncertain' }); store.close();
  const after = audit(f.dir); assert.equal(after.active, 0); assert.equal(after.uncertainRecords.length, 2);
  assert.notDeepEqual(after.uncertainRecords, baseline.uncertainRecords);
  assert.ok(after.uncertainRecords.includes(baseline.uncertainRecords[0]));
});
