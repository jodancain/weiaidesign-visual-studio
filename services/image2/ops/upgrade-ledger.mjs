/** Offline audit/compatibility helper. Never starts a worker or reads provider config. */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, lstatSync, realpathSync, existsSync, accessSync, constants } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
export const craftTables = ['craft_jobs', 'craft_projects', 'craft_receipts', 'craft_revisions'];
const hash = value => createHash('sha256').update(value).digest('hex');
const quote = value => '"' + value.replaceAll('"', '""') + '"';
const terminal = new Set(['complete', 'failed', 'cancelled', 'uncertain', 'awaiting_user']);

export function treeDigest(directory) {
  const result = [], walk = root => {
    for (const entry of readdirSync(root).sort()) {
      const file = join(root, entry), stat = lstatSync(file);
      assert.ok(!stat.isSymbolicLink(), 'symlink in data volume requires review');
      if (stat.isDirectory()) walk(file);
      else { assert.ok(stat.isFile(), 'special file in data volume'); result.push([relative(directory, file), stat.size, hash(readFileSync(file))]); }
    }
  };
  walk(directory); return { files: result.length, sha256: hash(JSON.stringify(result)) };
}

export function audit(directory, { requireCraft = false } = {}) {
  const root = realpathSync(directory), file = join(root, 'image2.sqlite');
  assert.ok(existsSync(file), 'missing ledger');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    const tables = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    assert.ok(tables.some(t => t.name === 'documents') && tables.some(t => t.name === 'assets'));
    if (requireCraft) for (const name of craftTables) assert.ok(tables.some(t => t.name === name), `missing ${name}`);
    const fingerprints = {}, states = {}, uncertainRecords = []; let active = 0, uncertain = 0;
    for (const { name, sql } of tables) {
      // Sort hashes, not plaintext; receipt contains no prompts, owners or private_json.
      const rows = db.prepare(`SELECT * FROM ${quote(name)}`).all();
      fingerprints[name] = { count: rows.length, schema: hash(sql), rows: hash(rows.map(r => hash(JSON.stringify(r))).sort().join('\n')) };
      if (['jobs', 'runs', 'craft_jobs'].includes(name)) {
        states[name] = {};
        for (const row of rows) { const state = JSON.parse(row.json).state; states[name][state] = (states[name][state] || 0) + 1; if (!terminal.has(state)) active++; if (state === 'uncertain') { uncertain++; uncertainRecords.push(`${name}:${hash(String(row.id))}:${hash(JSON.stringify(row))}`); } }
      }
    }
    let assets = 0;
    for (const row of db.prepare('SELECT path,json FROM assets').all()) {
      const metadata = JSON.parse(row.json);
      // Absolute paths in backups stay /data/image2; map only that known root.
      assert.ok(row.path.startsWith('/data/image2/assets/') || row.path.startsWith(root + '/assets/'));
      const suffix = row.path.startsWith('/data/image2/') ? row.path.slice('/data/image2/'.length) : relative(root, row.path);
      const file = realpathSync(join(root, suffix)), rel = relative(join(root, 'assets'), file);
      assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel), 'asset escapes volume');
      assert.equal(hash(readFileSync(file)), metadata.hash, 'asset hash mismatch'); assets++;
    }
    return { integrity: 'ok', fingerprints, states, active, uncertain, uncertainRecords: uncertainRecords.sort(), verifiedAssets: assets, compatibilityBasis: 'full table/schema and asset hashes; not user_version' };
  } finally { db.close(); }
}
export function assertPreserved(before, after) {
  for (const [table, value] of Object.entries(before.fingerprints)) assert.deepEqual(after.fingerprints[table], value, `changed table ${table}`);
  assert.equal(after.verifiedAssets, before.verifiedAssets);
}

// An uploaded asset is associated through document_assets even before it is
// placed on the canvas. Carry the verified reference explicitly to the BFF.
export function witness(directory) {
  const root = realpathSync(directory), db = new DatabaseSync(join(root, 'image2.sqlite'), { readOnly: true });
  try {
    const rows = db.prepare(`SELECT d.id,d.owner,a.id AS asset_id,a.path,a.json
      FROM documents d JOIN document_assets da ON da.document_id=d.id
      JOIN assets a ON a.id=da.asset_id WHERE d.parent_id IS NULL ORDER BY d.rowid,a.rowid`).all();
    for (const row of rows) {
      try {
        const meta = JSON.parse(row.json);
        assert.equal(meta.id, row.asset_id); assert.match(meta.hash, /^[a-f0-9]{64}$/);
        const suffix = row.path.startsWith('/data/image2/assets/') ? row.path.slice('/data/image2/'.length) : relative(root, row.path);
        const file = realpathSync(join(root, suffix)), rel = relative(join(root, 'assets'), file);
        assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
        const bytes = readFileSync(file); assert.ok(bytes.length > 0); assert.equal(hash(bytes), meta.hash);
        return { id: row.id, owner: row.owner, assets: [{ id: row.asset_id, bytes: bytes.length, sha256: meta.hash }] };
      } catch { /* Try another associated asset; never accept a missing/corrupt one. */ }
    }
    throw Error('no valid nonempty associated asset for readback');
  } finally { db.close(); }
}

export async function readWithStore(directory, { storeModule = '/app/store.mjs', craftModule } = {}) {
  const before = audit(directory, { requireCraft: true });
  const { ImageStore } = await import(pathToFileURL(storeModule));
  const store = new ImageStore(directory);
  try {
    // Importing ImageStore does not run ImageRunner. CraftService constructor adds
    // schema/hooks only; never call start(), createImageService() or server.mjs here.
    let craft;
    if (craftModule) { const { CraftService } = await import(pathToFileURL(craftModule)); craft = new CraftService({ store }); }
    for (const row of store.db.prepare('SELECT id,owner FROM documents').all()) {
      store.getDocument(row.id, row.owner); store.listRevisions(row.id, row.owner);
      if (craft) for (const project of craft.listProjects(row.id, row.owner)) { craft.project(row.id, row.owner, project.id); craft.listRevisions(row.id, row.owner, project.id); }
    }
    for (const row of store.db.prepare('SELECT a.id,d.owner FROM assets a JOIN documents d ON d.id=a.document_id').all()) store.getAsset(row.id, row.owner);
  } finally { store.close(); }
  const after = audit(directory, { requireCraft: true }); assertPreserved(before, after);
  return { ...after, storeReadback: true, workerStarted: false, fullOldFeatureCompatibility: false };
}

// Read-only bounded observation of shared legacy files. No claim of instance
// attribution or atomic admission. Preserve only safe state counts and hashes.
export function legacyAudit(directory) {
  const imageRoot = join(directory, 'generated_images');
  assert.ok(existsSync(imageRoot), 'legacy image directory missing');
  const result = { integrity: 'ok', active: 0, uncertain: 0, uncertainRecords: [], externalVideoJobs: 0, states: {}, records: [], missing: [],
    scope: 'shared legacy ledger; bounded observation; no process attribution or atomic admission' };
  for (const kind of ['_jobs', '_ontology']) {
    const folder = join(imageRoot, kind); result.states[kind] = {};
    if (!existsSync(folder)) { result.missing.push(kind); continue; }
    assert.ok(lstatSync(folder).isDirectory() && !lstatSync(folder).isSymbolicLink());
    for (const name of readdirSync(folder).filter(f => f.endsWith('.json')).sort()) {
      const file = join(folder, name); assert.ok(lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink());
      const bytes = readFileSync(file), record = JSON.parse(bytes), state = record.state;
      assert.equal(typeof state, 'string', 'legacy state missing');
      const known = kind === '_jobs' ? ['running','queued','done','failed','cancelled','uncertain'] : ['drafted','anchoring','review','approved','generating','done','failed'];
      assert.ok(known.includes(state), 'unknown legacy state requires review');
      let busy = kind === '_jobs' ? !['done','failed','cancelled','uncertain'].includes(state) : state === 'anchoring';
      if (kind === '_ontology') {
        assert.ok(Array.isArray(record.anchors) && Array.isArray(record.shots), 'legacy ontology ledger malformed');
        // Shot videos execute in the independent gateway. generating/queued/running
        // can be stale display state until GET refresh; only anchor void Promises
        // belong to the Web process. In-flight video submits are awaited HTTP.
        busy ||= record.anchors.some(a => a.status === 'generating');
        result.externalVideoJobs += record.shots.filter(a => typeof a.video_job_id === 'string' && a.video_job_id.length > 0).length;
      }
      if (busy) result.active++; if (state === 'uncertain') { result.uncertain++; result.uncertainRecords.push(`${kind}:${hash(name)}:${hash(bytes)}`); }
      result.states[kind][state] = (result.states[kind][state] || 0) + 1;
      result.records.push({ kind, idSha256: hash(name), sha256: hash(bytes), state, unfinished: busy });
    }
  }
  result.uncertainRecords.sort();
  return result;
}

async function main() {
  const command = process.env.ARTCRAFT_UPGRADE_COMMAND, directory = process.env.ARTCRAFT_UPGRADE_DATA || '/data/image2';
  let result;
  if (command === 'audit') result = audit(directory);
  else if (command === 'web-jobs') result = legacyAudit(directory);
  else if (command === 'tree') result = treeDigest(directory);
  else if (command === 'writable') {
    const walk = d => { accessSync(d, constants.R_OK | constants.W_OK | constants.X_OK); for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); assert.ok(!e.isSymbolicLink()); if (e.isDirectory()) walk(p); else accessSync(p, constants.R_OK | constants.W_OK); } };
    walk(directory); result = { writableAsNode: true };
  } else if (command === 'old-read') result = await readWithStore(directory);
  else if (command === 'new-read') result = await readWithStore(directory, { craftModule: '/app/craft-service.mjs' });
  else if (command === 'witness') {
    // Only piped to the local Web probe's stdin; never persist this response.
    result = witness(directory);
  } else throw Error('unknown audit command');
  process.stdout.write(JSON.stringify(result));
}
if (process.env.ARTCRAFT_UPGRADE_COMMAND) main().catch(() => { process.stderr.write('upgrade ledger check failed; private data suppressed\n'); process.exitCode = 1; });
