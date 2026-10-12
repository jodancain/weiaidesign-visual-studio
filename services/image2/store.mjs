import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, existsSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import * as fontkit from 'fontkit';
import { fontWeight } from './fonts.mjs';
import { fail, ImageError, clone, canonical, digest, timestamp, requireOwner, validId, createImageDocument, validateDocument, applyCommands, mergeBranch, inspectBytes, publicJob, publicRun } from './domain.mjs';

const JOB_STATES = new Set(['queued','running','complete','failed','uncertain','cancelled','awaiting_user']);
const JOB_TERMINAL = new Set(['complete','failed','uncertain','cancelled','awaiting_user']);
const EMPTY_METRICS = { queueMs: 0, executionMs: 0, generationCalls: 0, llmCalls: 0, visionCalls: 0, totalMs: 0 };
function key(value) { fail(typeof value === 'string' && value.length > 0 && value.length <= 200, 'idempotency key is required'); return value; }
function json(value, max = 4000000) { const result = JSON.stringify(value); fail(typeof result === 'string' && result.length <= max, 'JSON payload is too large'); return result; }
function parse(row, field = 'json') { return JSON.parse(row[field]); }

export class ImageStore {
  constructor(directory) {
    this.directory = resolve(directory); this.blobs = join(this.directory, 'assets');
    this.fontFaces = new Map();
    mkdirSync(this.blobs, { recursive: true });
    this.db = new DatabaseSync(join(this.directory, 'image2.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY, owner TEXT NOT NULL, json TEXT NOT NULL, history_head INTEGER NOT NULL DEFAULT 0, parent_id TEXT, base_json TEXT);
      CREATE TABLE IF NOT EXISTS revisions(document_id TEXT NOT NULL, revision INTEGER NOT NULL, json TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY(document_id,revision), FOREIGN KEY(document_id) REFERENCES documents(id));
      CREATE TABLE IF NOT EXISTS history(document_id TEXT NOT NULL, seq INTEGER NOT NULL, before_json TEXT NOT NULL, after_json TEXT NOT NULL, PRIMARY KEY(document_id,seq), FOREIGN KEY(document_id) REFERENCES documents(id));
      CREATE TABLE IF NOT EXISTS command_receipts(document_id TEXT NOT NULL, command_id TEXT NOT NULL, request_hash TEXT NOT NULL, response_json TEXT NOT NULL, PRIMARY KEY(document_id,command_id), FOREIGN KEY(document_id) REFERENCES documents(id));
      CREATE TABLE IF NOT EXISTS branch_acceptances(branch_document_id TEXT PRIMARY KEY,document_id TEXT NOT NULL,accepted_at TEXT NOT NULL,accepted_revision INTEGER NOT NULL,FOREIGN KEY(branch_document_id) REFERENCES documents(id),FOREIGN KEY(document_id) REFERENCES documents(id));
      CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY, document_id TEXT NOT NULL, json TEXT NOT NULL, path TEXT NOT NULL, FOREIGN KEY(document_id) REFERENCES documents(id));
      CREATE TABLE IF NOT EXISTS document_assets(document_id TEXT NOT NULL, asset_id TEXT NOT NULL, PRIMARY KEY(document_id,asset_id), FOREIGN KEY(document_id) REFERENCES documents(id), FOREIGN KEY(asset_id) REFERENCES assets(id));
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, document_id TEXT NOT NULL, request_key TEXT NOT NULL, input_hash TEXT NOT NULL, json TEXT NOT NULL, private_json TEXT NOT NULL, UNIQUE(document_id,request_key), FOREIGN KEY(document_id) REFERENCES documents(id));
      CREATE TABLE IF NOT EXISTS job_receipts(document_id TEXT NOT NULL, request_key TEXT NOT NULL, input_hash TEXT NOT NULL, job_id TEXT NOT NULL, PRIMARY KEY(document_id,request_key), FOREIGN KEY(job_id) REFERENCES jobs(id));
      CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, document_id TEXT NOT NULL, json TEXT NOT NULL, FOREIGN KEY(document_id) REFERENCES documents(id));
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, request_key TEXT NOT NULL, request_hash TEXT NOT NULL, json TEXT NOT NULL, UNIQUE(conversation_id,request_key), FOREIGN KEY(conversation_id) REFERENCES conversations(id));
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, document_id TEXT NOT NULL, conversation_id TEXT NOT NULL, request_key TEXT NOT NULL, request_hash TEXT NOT NULL, json TEXT NOT NULL, private_json TEXT NOT NULL, UNIQUE(conversation_id,request_key), FOREIGN KEY(conversation_id) REFERENCES conversations(id));
      PRAGMA user_version=1;`);
  }
  close() { this.db.close(); this.fontFaces.clear(); }
  transaction(fn) {
    const depth = this.depth || 0, savepoint = `image2_${depth}`; this.depth = depth + 1;
    this.db.exec(depth ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec(depth ? `RELEASE SAVEPOINT ${savepoint}` : 'COMMIT'); return result; }
    catch (error) { this.db.exec(depth ? `ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}` : 'ROLLBACK'); throw error; }
    finally { this.depth = depth; }
  }
  documentRow(id, owner) {
    const tenant = requireOwner(owner), row = this.db.prepare('SELECT * FROM documents WHERE id=? AND owner=?').get(id, tenant);
    fail(row, 'document not found', 404, 'not_found'); return row;
  }
  getDocument(id, owner) {
    const document = parse(this.documentRow(id, owner));
    document.assetIds = this.db.prepare('SELECT asset_id FROM document_assets WHERE document_id=? ORDER BY rowid').all(id).map(r => r.asset_id);
    const accepted=this.db.prepare('SELECT * FROM branch_acceptances WHERE branch_document_id=?').get(id);
    if(accepted)document.metadata={...document.metadata,acceptedAt:accepted.accepted_at,acceptedRevision:accepted.accepted_revision,acceptedIntoDocumentId:accepted.document_id};
    return document;
  }
  createDocument(owner, body = {}) {
    const tenant = requireOwner(owner), document = createImageDocument(body);
    for (const id of document.assetIds) this.getAsset(id, tenant);
    this.validateFontAssets(document, tenant);
    return this.transaction(() => {
      this.db.prepare('INSERT INTO documents(id,owner,json) VALUES(?,?,?)').run(document.id, tenant, json(document));
      for (const id of document.assetIds) this.linkAsset(document.id, id);
      this.db.prepare('INSERT INTO revisions VALUES(?,?,?,?)').run(document.id, 0, json(document), 'create'); return clone(document);
    });
  }
  listDocuments(owner) {
    const tenant = requireOwner(owner);
    return this.db.prepare('SELECT id FROM documents WHERE owner=? AND parent_id IS NULL ORDER BY rowid DESC').all(tenant).map(r => this.getDocument(r.id, tenant));
  }
  linkAsset(documentId, assetId) { this.db.prepare('INSERT OR IGNORE INTO document_assets VALUES(?,?)').run(documentId, assetId); }
  receipt(documentId, commandId, request) {
    key(commandId); const old = this.db.prepare('SELECT * FROM command_receipts WHERE document_id=? AND command_id=?').get(documentId, commandId);
    if (old) fail(old.request_hash === digest(request), 'command identity reused with different content', 409, 'idempotency_conflict'); return old;
  }
  persistDocument(document, kind) {
    validateDocument(document);
    this.validateFontAssets(document, this.db.prepare('SELECT owner FROM documents WHERE id=?').get(document.id)?.owner);
    this.db.prepare('UPDATE documents SET json=? WHERE id=?').run(json(document), document.id);
    this.db.prepare('INSERT INTO revisions VALUES(?,?,?,?)').run(document.id, document.revision, json(document), kind); return clone(document);
  }
  commit(documentId, before, after, commandId, request, kind) {
    const row = this.db.prepare('SELECT history_head FROM documents WHERE id=?').get(documentId), head = row.history_head;
    after.id = before.id; after.createdAt = before.createdAt; after.revision = before.revision + 1; after.updatedAt = timestamp();
    this.validateSourceTextTransitions(before, after);
    this.validateFontAssets(after, this.db.prepare('SELECT owner FROM documents WHERE id=?').get(documentId)?.owner);
    this.db.prepare('DELETE FROM history WHERE document_id=? AND seq>?').run(documentId, head);
    this.db.prepare('INSERT INTO history VALUES(?,?,?,?)').run(documentId, head + 1, json(before), json(after));
    this.db.prepare('UPDATE documents SET history_head=? WHERE id=?').run(head + 1, documentId);
    const result = this.persistDocument(after, kind);
    this.db.prepare('INSERT INTO command_receipts VALUES(?,?,?,?)').run(documentId, commandId, digest(request), json(result)); return result;
  }
  command(id, owner, body) {
    return this.transaction(() => {
      const before = this.getDocument(id, owner), request = { type: 'commands', ...body };
      if (this.receipt(id, body.commandId, request)) return before;
      fail(Number.isSafeInteger(body.baseRevision) && before.revision === body.baseRevision, 'document changed; reload and retry', 409, 'revision_conflict');
      return this.commit(id, before, applyCommands(before, body.commands), body.commandId, request, 'commands');
    });
  }
  history(id, owner, body) {
    return this.transaction(() => {
      const before = this.getDocument(id, owner), request = { type: 'history', ...body };
      if (this.receipt(id, body.commandId, request)) return before;
      fail(body.baseRevision === before.revision, 'document changed; reload and retry', 409, 'revision_conflict');
      fail(['undo','redo'].includes(body.direction), 'invalid history direction');
      const head = this.documentRow(id, owner).history_head, seq = body.direction === 'undo' ? head : head + 1;
      const row = this.db.prepare('SELECT * FROM history WHERE document_id=? AND seq=?').get(id, seq);
      fail(row, `nothing to ${body.direction}`, 409, 'empty_history');
      const after = parse(row, body.direction === 'undo' ? 'before_json' : 'after_json');
      after.assetIds = before.assetIds; after.revision = before.revision + 1; after.updatedAt = timestamp();
      this.db.prepare('UPDATE documents SET history_head=? WHERE id=?').run(body.direction === 'undo' ? head - 1 : head + 1, id);
      const result = this.persistDocument(after, body.direction);
      this.db.prepare('INSERT INTO command_receipts VALUES(?,?,?,?)').run(id, body.commandId, digest(request), json(result)); return result;
    });
  }
  listRevisions(id, owner) { this.getDocument(id, owner); return this.db.prepare('SELECT revision,kind,json FROM revisions WHERE document_id=? ORDER BY revision').all(id).map(r => ({ ...parse(r), kind: r.kind })); }
  validateFontAssets(document, owner) {
    const faces = new Map();
    for (const fontId of new Set(document.layers.filter(layer => layer.fontAssetId).map(layer => layer.fontAssetId))) {
      const { asset, bytes } = this.getAsset(fontId, owner);
      fail(asset.mime.startsWith('font/'), 'fontAssetId must refer to a validated font file', 400, 'invalid_font_asset');
      faces.set(fontId, this.fontFace(asset.hash, bytes));
    }
    for (const layer of document.layers) {
      if (layer.type === 'text' && faces.has(layer.fontAssetId)) {
        const face = faces.get(layer.fontAssetId);
        layer.fontWeight = fontWeight(face);
        layer.fontFamily = face.familyName;
      }
      if (layer.type !== 'text' || layer.metadata?.fontConfirmed !== true) continue;
      fail(layer.fontAssetId && faces.has(layer.fontAssetId), 'confirmed text requires a registered font file', 422, 'FONT_ASSET_REQUIRED');
      const face = faces.get(layer.fontAssetId), missing = [];
      for (const character of new Set(layer.text || '')) {
        if (/[\p{Cc}\p{Cf}]/u.test(character)) continue;
        const point = character.codePointAt(0);
        if (!face.hasGlyphForCodePoint(point)) missing.push(`${character} (U+${point.toString(16).toUpperCase().padStart(4,'0')})`);
        if (missing.length >= 16) break;
      }
      fail(missing.length === 0, `字体缺少字符：${missing.join('、')}；请选择包含这些字形的真实字体`, 422, 'FONT_GLYPH_MISSING');
      if (layer.assetId) this.validateTextBackground(document, layer, owner);
      this.expandTextBounds(layer, face);
    }
  }
  validateSourceTextTransitions(before, after) {
    for (const original of before.layers) {
      if (original.type !== 'text' || !original.assetId || original.metadata?.fontConfirmed === true) continue;
      const next = after.layers.find(layer => layer.id === original.id);
      if (!next || next.type !== 'text') continue;
      if (next.metadata?.fontConfirmed === true) {
        fail(next.assetId === original.assetId, '确认字体时必须保留原文字裁片及清底来源', 422, 'TEXT_BACKGROUND_REQUIRED');
      } else {
        fail(next.text === original.text, '原文字尚未清底并确认字体；请将待改文字保存到 desiredText', 422, 'FONT_CONFIRMATION_REQUIRED');
      }
    }
  }
  validateTextBackground(document, layer, owner) {
    const id = layer.metadata?.cleanBackgroundAssetId;
    fail(validId(id) && document.assetIds.includes(id), '原文字必须先清底再确认字体', 422, 'TEXT_BACKGROUND_REQUIRED');
    const original = this.getAsset(layer.assetId, owner).asset, background = this.getAsset(id, owner).asset;
    fail(['image/png','image/jpeg','image/webp'].includes(background.mime), '文字背景必须为真实位图素材', 422, 'TEXT_BACKGROUND_REQUIRED');
    fail(Number.isSafeInteger(original.width) && Number.isSafeInteger(original.height) && background.width === original.width && background.height === original.height, '文字背景尺寸与原裁片不匹配', 422, 'TEXT_BACKGROUND_REQUIRED');
    fail(id !== original.id && background.inputs?.some(ref => ref.role === 'base' && ref.assetId === original.id && ref.hash === original.hash), '文字背景缺少当前原裁片的清底来源', 422, 'TEXT_BACKGROUND_REQUIRED');
    if (layer.metadata?.backgroundDetached === true) {
      const backgroundLayer = document.layers.find(item => item.id === layer.metadata.backgroundLayerId);
      fail(backgroundLayer?.type === 'raster' && backgroundLayer.assetId === id, '独立文字背景图层缺失或素材不一致', 422, 'TEXT_BACKGROUND_REQUIRED');
    }
  }
  expandTextBounds(layer, face) {
    const size = layer.fontSize, scale = size / face.unitsPerEm, leading = size * layer.lineHeight;
    let minX = 0, maxX = 0, minY = 0, maxY = 0, maxAdvance = 0;
    const lines = String(layer.text || '').split(/\r?\n/);
    for (const [lineIndex,text] of lines.entries()) {
      const run = face.layout(text.replace(/[\p{Cc}\p{Cf}]/gu, '')); let penX = 0, penY = 0;
      for (const [index,glyph] of run.glyphs.entries()) {
        const position = run.positions[index], box = glyph.bbox, x = penX + position.xOffset * scale;
        const baseline = size + lineIndex * leading - (penY + position.yOffset * scale);
        minX = Math.min(minX, x + box.minX * scale); maxX = Math.max(maxX, x + box.maxX * scale);
        minY = Math.min(minY, baseline - box.maxY * scale); maxY = Math.max(maxY, baseline - box.minY * scale);
        penX += position.xAdvance * scale + (index < run.glyphs.length - 1 ? layer.tracking : 0); penY += position.yAdvance * scale;
      }
      maxAdvance = Math.max(maxAdvance, penX);
    }
    const stroke = layer.stroke ? (layer.strokeWidth || 1) / 2 : 0;
    const width = Math.ceil(Math.max(maxAdvance, maxX - Math.min(0,minX)) + stroke * 2);
    const height = Math.ceil(Math.max(lines.length * leading, maxY - Math.min(0,minY)) + stroke * 2);
    fail(Number.isFinite(width) && Number.isFinite(height) && width <= 1e7 && height <= 1e7, 'text glyph layout exceeds document geometry limits', 422, 'FONT_LAYOUT_TOO_LARGE');
    layer.width = Math.max(layer.width, width); layer.height = Math.max(layer.height, height);
  }
  fontFace(hash, bytes) {
    let face = this.fontFaces.get(hash);
    if (face) { this.fontFaces.delete(hash); this.fontFaces.set(hash, face); return face; }
    try { face = fontkit.create(bytes); } catch { throw new ImageError('font bytes cannot be parsed as a real face', 400, 'invalid_font_asset'); }
    fail(!face.fonts && face.familyName && face.postscriptName && typeof face.hasGlyphForCodePoint === 'function', 'a real single font face is required', 400, 'invalid_font_asset');
    this.fontFaces.set(hash, face);
    if (this.fontFaces.size > 16) this.fontFaces.delete(this.fontFaces.keys().next().value);
    return face;
  }
  getRevision(id, owner, revision) {
    const current = this.getDocument(id, owner);
    fail(Number.isSafeInteger(revision) && revision >= 0, 'invalid document revision');
    const row = this.db.prepare('SELECT json FROM revisions WHERE document_id=? AND revision=?').get(id, revision);
    fail(row, 'document revision not found', 404, 'not_found');
    return { ...parse(row), assetIds: current.assetIds };
  }
  importRevisions(documentId, owner, { revisions, currentDocument }) {
    return this.transaction(() => {
      const fresh = this.getDocument(documentId, owner);
      fail(fresh.revision === 0 && !this.db.prepare('SELECT id FROM jobs WHERE document_id=? LIMIT 1').get(documentId), 'history import requires a fresh document', 409);
      fail(Array.isArray(revisions) && revisions.length > 0 && revisions.length <= 10000 && currentDocument, 'invalid imported revisions');
      const allowed = new Set(fresh.assetIds);
      const normalize = source => {
        const snapshot = clone(source); delete snapshot.kind;
        snapshot.id = documentId; snapshot.schemaVersion = 2;
        delete snapshot.parentDocumentId; delete snapshot.baseRevision;
        fail(Array.isArray(snapshot.assetIds) && snapshot.assetIds.every(id => allowed.has(id)), 'history references an asset outside this document');
        for (const id of snapshot.assetIds) this.getAsset(id, owner);
        validateDocument(snapshot); this.validateFontAssets(snapshot, owner); return snapshot;
      };
      const versions = revisions.map(r => ({ document: normalize(r), kind: typeof r.kind === 'string' ? r.kind : 'imported' })).sort((a,b) => a.document.revision - b.document.revision);
      fail(new Set(versions.map(v => v.document.revision)).size === versions.length, 'duplicate imported revision');
      const current = normalize(currentDocument), last = versions.at(-1).document;
      const authored = d => digest({ name: d.name, width: d.width, height: d.height, layers: d.layers });
      fail(current.revision === last.revision && authored(current) === authored(last), 'current document does not match imported history');
      const history = []; let head = 0, previous = versions[0].document;
      for (const item of versions.slice(1)) {
        if (item.kind === 'undo') { fail(head > 0 && authored(item.document) === authored(history[head - 1].before), 'invalid imported undo history'); head--; }
        else if (item.kind === 'redo') { fail(head < history.length && authored(item.document) === authored(history[head].after), 'invalid imported redo history'); head++; }
        else { history.splice(head); history.push({ before: previous, after: item.document }); head++; }
        previous = item.document;
      }
      this.db.prepare('DELETE FROM revisions WHERE document_id=?').run(documentId);
      this.db.prepare('DELETE FROM history WHERE document_id=?').run(documentId);
      this.db.prepare('DELETE FROM command_receipts WHERE document_id=?').run(documentId);
      for (const item of versions) this.db.prepare('INSERT INTO revisions VALUES(?,?,?,?)').run(documentId, item.document.revision, json(item.document), item.kind);
      for (const [index,item] of history.entries()) this.db.prepare('INSERT INTO history VALUES(?,?,?,?)').run(documentId, index + 1, json(item.before), json(item.after));
      current.assetIds = fresh.assetIds; current.createdAt = fresh.createdAt; current.updatedAt = timestamp();
      this.db.prepare('UPDATE documents SET json=?,history_head=? WHERE id=?').run(json(current), head, documentId);
      this.db.prepare('UPDATE revisions SET json=? WHERE document_id=? AND revision=?').run(json(current), documentId, current.revision);
      return current;
    });
  }
  writeBlob(bytes, hash) {
    const file = join(this.blobs, hash);
    if (existsSync(file)) { fail(digest(readFileSync(file)) === hash, 'stored asset integrity failed', 500, 'asset_corrupt'); return file; }
    const temp = `${file}.tmp-${randomUUID()}`; let fd;
    try { fd = openSync(temp, 'wx', 0o600); writeFileSync(fd, bytes); fsyncSync(fd); closeSync(fd); fd = undefined; renameSync(temp, file);
      if (process.platform !== 'win32') { const directory = openSync(this.blobs, 'r'); try { fsyncSync(directory); } finally { closeSync(directory); } }
    } finally { if (fd !== undefined) closeSync(fd); try { unlinkSync(temp); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
    return file;
  }
  addAsset(documentId, owner, descriptor, bytes) {
    this.getDocument(documentId, owner);
    fail(descriptor && typeof descriptor === 'object', 'asset descriptor is required');
    if (descriptor.assignedId !== undefined) fail(typeof descriptor.assignedId === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(descriptor.assignedId) && !this.db.prepare('SELECT id FROM assets WHERE id=?').get(descriptor.assignedId), 'invalid or existing assigned asset identity', 409, 'asset_identity_conflict');
    const inspected = inspectBytes(bytes, descriptor.mime), hash = digest(bytes);
    const font = inspected.mime.startsWith('font/') ? this.fontFace(hash, bytes) : null;
    if (descriptor.width !== undefined || descriptor.height !== undefined) fail(Number.isSafeInteger(descriptor.width) && Number.isSafeInteger(descriptor.height) && descriptor.width > 0 && descriptor.height > 0 && descriptor.width <= 32768 && descriptor.height <= 32768 && descriptor.width * descriptor.height <= 100000000, 'asset pixel limit exceeded');
    fail(typeof descriptor.name === 'string' && descriptor.name.length > 0 && descriptor.name.length <= 500, 'invalid asset name');
    fail(descriptor.inputs === undefined || Array.isArray(descriptor.inputs), 'asset inputs must be a list');
    const inputs = (descriptor.inputs || []).map(input => {
      fail(input && typeof input.role === 'string' && input.role.length > 0 && input.role.length <= 100, 'invalid input role');
      const { asset } = this.getAsset(input.assetId, owner); fail(!input.hash || input.hash === asset.hash, 'asset input hash changed', 409, 'source_changed');
      return { role: input.role, assetId: asset.id, hash: asset.hash };
    });
    fail(inputs.length <= 100, 'too many asset inputs');
    const asset = { id: descriptor.assignedId || randomUUID(), documentId, name: descriptor.name, ...inspected, hash, bytes: bytes.length, createdAt: timestamp(),
      ...(inspected.width === undefined && Number.isSafeInteger(descriptor.width) && Number.isSafeInteger(descriptor.height) ? { width: descriptor.width, height: descriptor.height } : {}),
      ...(descriptor.metadata || font ? { metadata: { ...clone(descriptor.metadata || {}), ...(font ? { family: font.familyName, postscriptName: font.postscriptName, fullName: font.fullName, numGlyphs: font.numGlyphs, weight: fontWeight(font) } : {}) } } : {}), ...(inputs.length ? { inputs } : {}) };
    asset.url = `/api/v3/image2/assets/${asset.id}/content`;
    const file = this.writeBlob(bytes, hash);
    return this.transaction(() => {
      this.getDocument(documentId, owner);
      this.db.prepare('INSERT INTO assets VALUES(?,?,?,?)').run(asset.id, documentId, json(asset), file); this.linkAsset(documentId, asset.id);
      for (const input of inputs) this.linkAsset(documentId, input.assetId); return clone(asset);
    });
  }
  getAsset(id, owner) {
    requireOwner(owner); const row = this.db.prepare('SELECT * FROM assets WHERE id=?').get(id);
    fail(row, 'asset not found', 404, 'not_found'); this.documentRow(row.document_id, owner);
    const asset = parse(row), bytes = readFileSync(row.path); fail(digest(bytes) === asset.hash && bytes.length === asset.bytes, 'stored asset integrity failed', 500, 'asset_corrupt');
    return { asset, bytes };
  }
  listAssets(documentId, owner) { const document = this.getDocument(documentId, owner); return document.assetIds.map(id => this.getAsset(id, owner).asset); }
  createJob(documentId, owner, { kind, idempotencyKey, input }) {
    const tenant = requireOwner(owner); this.getDocument(documentId, tenant); key(idempotencyKey);
    fail(validId(kind) && input && typeof input === 'object', 'invalid job input');
    const frozen = JSON.parse(json(input)), inputHash = digest({ kind, input: frozen });
    return this.transaction(() => {
      const old = this.db.prepare('SELECT * FROM job_receipts WHERE document_id=? AND request_key=?').get(documentId, idempotencyKey);
      if (old) { fail(old.input_hash === inputHash, 'idempotency key reused with different input', 409, 'idempotency_conflict'); return this.getJob(old.job_id, tenant); }
      const active = this.db.prepare('SELECT * FROM jobs WHERE document_id=? AND input_hash=? ORDER BY rowid').all(documentId, inputHash).find(r => ['queued','running','uncertain','awaiting_user'].includes(parse(r).state));
      if (active) { this.db.prepare('INSERT INTO job_receipts VALUES(?,?,?,?)').run(documentId, idempotencyKey, inputHash, active.id); return publicJob(parse(active)); }
      const now = timestamp(), job = { id: randomUUID(), documentId, kind, ...(typeof frozen.operation === 'string' ? { operation: frozen.operation } : {}), state: 'queued', progress: 0, stage: 'queued', createdAt: now, updatedAt: now, metrics: { ...EMPTY_METRICS } };
      this.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?)').run(job.id, documentId, idempotencyKey, inputHash, json(job), json({ input: frozen, inputHash, checkpoints: {}, lastStateAt: now }));
      this.db.prepare('INSERT INTO job_receipts VALUES(?,?,?,?)').run(documentId, idempotencyKey, inputHash, job.id); return publicJob(job);
    });
  }
  jobRecord(id) { const row = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id); fail(row, 'job not found', 404, 'not_found'); return { job: parse(row), private: parse(row, 'private_json'), owner: this.db.prepare('SELECT owner FROM documents WHERE id=?').get(row.document_id).owner }; }
  getJob(id, owner) { const r = this.jobRecord(id); this.documentRow(r.job.documentId, owner); return publicJob(r.job); }
  updateJob(id, patch, privatePatch = {}) {
    const record = this.jobRecord(id);
    for (const field of ['id','documentId','kind','createdAt']) if (patch[field] !== undefined) fail(patch[field] === record.job[field], 'job identity is immutable', 409);
    if (privatePatch.input !== undefined) fail(digest(privatePatch.input) === digest(record.private.input), 'job input is frozen', 409);
    if (privatePatch.inputHash !== undefined) fail(privatePatch.inputHash === record.private.inputHash, 'job input hash is frozen', 409);
    if (patch.state !== undefined) { fail(JOB_STATES.has(patch.state), 'invalid job state'); fail(!['cancelled','uncertain'].includes(record.job.state) || ['queued',record.job.state].includes(patch.state), 'terminal job must be explicitly retried', 409); }
    if (patch.progress !== undefined) fail(Number.isFinite(patch.progress) && patch.progress >= 0 && patch.progress <= 1, 'invalid job progress');
    const now = timestamp(), metrics = { ...EMPTY_METRICS };
    for (const field of Object.keys(metrics)) {
      const value = patch.metrics?.[field] ?? record.job.metrics?.[field] ?? 0;
      fail(Number.isFinite(value) && value >= 0, 'invalid job metrics'); metrics[field] = value;
    }
    const job = { ...record.job, ...clone(patch), metrics, updatedAt: now }, priv = { ...record.private, ...clone(privatePatch) };
    if (job.state !== record.job.state || JOB_TERMINAL.has(job.state)) {
      const elapsed = Math.max(0, Date.parse(now) - Date.parse(record.private.lastStateAt || record.job.updatedAt || record.job.createdAt));
      if (record.job.state === 'queued') metrics.queueMs += elapsed;
      if (record.job.state === 'running') metrics.executionMs += elapsed;
      priv.lastStateAt = now;
      if (job.state === 'running' && !record.job.startedAt) job.startedAt = now;
      if (JOB_TERMINAL.has(job.state)) job.finishedAt = job.state === record.job.state && record.job.finishedAt ? record.job.finishedAt : now;
      else delete job.finishedAt;
      metrics.totalMs = Math.max(0, Date.parse(job.finishedAt || now) - Date.parse(job.createdAt));
    }
    this.db.prepare('UPDATE jobs SET json=?,private_json=? WHERE id=?').run(json(job), json(priv), id); return publicJob(job);
  }
  listJobs(documentId, owner) { this.getDocument(documentId, owner); return this.db.prepare('SELECT json FROM jobs WHERE document_id=? ORDER BY rowid DESC').all(documentId).map(r => publicJob(parse(r))); }
  pendingJobs() { return this.db.prepare('SELECT id,json FROM jobs ORDER BY rowid').all().filter(r => ['queued','running'].includes(parse(r).state)).map(r => r.id); }
  checkpointAsset(jobId, checkpointKey, descriptor, bytes, targetDocumentId) {
    key(checkpointKey); const record = this.jobRecord(jobId);
    fail(!['cancelled','uncertain'].includes(record.job.state), 'job cannot publish output', 409);
    const target = targetDocumentId ?? record.job.documentId;
    this.getDocument(target, record.owner);
    fail(target === record.job.documentId || target === record.private.branchDocumentId, 'checkpoint target must be the job document or its candidate branch', 409, 'invalid_checkpoint_target');
    const old = record.private.checkpoints?.[checkpointKey];
    if (old) { const asset = this.getAsset(typeof old === 'string' ? old : old.id || old.assetId, record.owner).asset; fail(asset.hash === digest(bytes), 'checkpoint identity reused with different bytes', 409); return asset; }
    return this.transaction(() => {
      const asset = this.addAsset(target, record.owner, descriptor, bytes);
      this.updateJob(jobId, {}, { checkpoints: { ...record.private.checkpoints, [checkpointKey]: asset.id } }); return asset;
    });
  }
  createBranch(documentId, owner, { baseRevision, name, metadata } = {}) {
    return this.transaction(() => {
      const current = this.getDocument(documentId, owner);
      fail(Number.isSafeInteger(baseRevision) && baseRevision >= 0 && baseRevision <= current.revision, 'invalid branch base revision', 409, 'revision_conflict');
      const revision = baseRevision === current.revision ? current : this.db.prepare('SELECT json FROM revisions WHERE document_id=? AND revision=?').get(documentId, baseRevision);
      fail(revision, 'branch base revision not found', 409, 'revision_conflict');
      const base = baseRevision === current.revision ? current : parse(revision);
      base.assetIds = current.assetIds;
      const now = timestamp(), branch = { ...clone(base), id: randomUUID(), revision: 0, name: name || base.name, parentDocumentId: documentId, baseRevision, createdAt: now, updatedAt: now, metadata: { ...base.metadata, ...metadata } };
      validateDocument(branch); this.validateFontAssets(branch, owner); this.db.prepare('INSERT INTO documents(id,owner,json,parent_id,base_json) VALUES(?,?,?,?,?)').run(branch.id, requireOwner(owner), json(branch), documentId, json(base));
      for (const id of base.assetIds) this.linkAsset(branch.id, id);
      this.db.prepare('INSERT INTO revisions VALUES(?,?,?,?)').run(branch.id, 0, json(branch), 'branch'); return branch;
    });
  }
  listBranches(documentId, owner) { this.getDocument(documentId, owner); return this.db.prepare('SELECT id FROM documents WHERE parent_id=? AND owner=? AND id NOT IN (SELECT branch_document_id FROM branch_acceptances) ORDER BY rowid DESC').all(documentId, requireOwner(owner)).map(r => this.getDocument(r.id, owner)); }
  acceptBranch(documentId, owner, body) {
    return this.transaction(() => {
      const current = this.getDocument(documentId, owner), request = { type: 'accept', ...body };
      if (this.receipt(documentId, body.commandId, request)) return current;
      const row = this.documentRow(body.branchDocumentId, owner); fail(row.parent_id === documentId && row.base_json, 'branch belongs to another document', 409);
      const consumed=this.db.prepare('SELECT document_id FROM branch_acceptances WHERE branch_document_id=?').get(body.branchDocumentId);
      if(consumed){fail(consumed.document_id===documentId,'branch accepted into another document',409);this.db.prepare('INSERT INTO command_receipts VALUES(?,?,?,?)').run(documentId,body.commandId,digest(request),json(current));return current;}
      fail(current.revision === body.baseRevision, 'document changed; reload and retry', 409, 'revision_conflict');
      const branch = this.getDocument(body.branchDocumentId, owner),base=parse(row,'base_json'); let merged;
      const producers=this.db.prepare("SELECT id FROM jobs WHERE document_id=? AND json_extract(private_json,'$.branchDocumentId')=?").all(documentId,branch.id).map(item=>this.getJob(item.id,owner));
      fail(!producers.some(job=>['queued','running'].includes(job.state)),'候选任务仍在执行，请完成或取消后接受',409,'candidate_not_ready');
      fail(!producers.some(job=>job.state!=='complete')||branch.revision>0||canonical(branch.layers)!==canonical(base.layers),'候选分支尚无已完成编辑，请保留任务回执等待处理',409,'candidate_empty');
      try { merged = mergeBranch(base, current, branch); } catch (error) { if (error instanceof ImageError) { error.status = 409; error.code = 'branch_conflict'; } throw error; }
      for (const id of branch.assetIds) this.linkAsset(documentId, id);
      const authored=doc=>canonical({name:doc.name,width:doc.width,height:doc.height,layers:doc.layers,metadata:doc.metadata});
      const unchanged=authored(current)===authored(merged),accepted=unchanged?this.getDocument(documentId,owner):this.commit(documentId, current, merged, body.commandId, request, 'accept-branch');
      if(unchanged)this.db.prepare('INSERT INTO command_receipts VALUES(?,?,?,?)').run(documentId,body.commandId,digest(request),json(accepted));
      this.db.prepare('INSERT INTO branch_acceptances VALUES(?,?,?,?)').run(branch.id,documentId,timestamp(),accepted.revision);return accepted;
    });
  }
  createConversation(owner, { documentId }) {
    this.getDocument(documentId, owner); const now = timestamp(), conversation = { id: randomUUID(), documentId, createdAt: now, updatedAt: now };
    this.db.prepare('INSERT INTO conversations VALUES(?,?,?)').run(conversation.id, documentId, json(conversation)); return conversation;
  }
  getConversation(id, owner) { const row = this.db.prepare('SELECT * FROM conversations WHERE id=?').get(id); fail(row, 'conversation not found', 404); this.getDocument(row.document_id, owner); return parse(row); }
  listConversations(documentId, owner) { this.getDocument(documentId, owner); return this.db.prepare('SELECT json FROM conversations WHERE document_id=? ORDER BY rowid DESC').all(documentId).map(r => parse(r)); }
  addMessage(conversationId, owner, message) {
    const conversation = this.getConversation(conversationId, owner), document = this.getDocument(conversation.documentId, owner);
    fail(message && ['user','assistant','tool','system'].includes(message.role || 'user') && typeof message.text === 'string' && message.text.length <= 100000, 'invalid message');
    const references = clone(message.references || []); fail(Array.isArray(references) && references.length <= 100, 'invalid message references');
    for (const ref of references) {
      fail(ref && (validId(ref.assetId) || validId(ref.layerId)), 'reference requires an asset or layer id');
      if (ref.assetId) { this.getAsset(ref.assetId, owner); fail(document.assetIds.includes(ref.assetId), 'reference is not in this document'); }
      if (ref.layerId) { const revision = ref.revision === undefined ? document : this.db.prepare('SELECT json FROM revisions WHERE document_id=? AND revision=?').get(document.id, ref.revision); const d = ref.revision === undefined ? document : revision && parse(revision); fail(d?.layers.some(l => l.id === ref.layerId), 'referenced layer does not exist'); }
    }
    const requestKey = message.idempotencyKey || message.id || randomUUID(); key(requestKey); const requestHash = digest({ role: message.role || 'user', text: message.text, references });
    const old = this.db.prepare('SELECT * FROM messages WHERE conversation_id=? AND request_key=?').get(conversationId, requestKey);
    if (old) { fail(old.request_hash === requestHash, 'message identity reused with different content', 409, 'idempotency_conflict'); return parse(old); }
    const saved = { id: randomUUID(), conversationId, documentId: conversation.documentId, role: message.role || 'user', text: message.text, references, revision: document.revision, createdAt: timestamp(), ...(message.operationId ? { operationId: message.operationId } : {}) };
    this.db.prepare('INSERT INTO messages VALUES(?,?,?,?,?)').run(saved.id, conversationId, requestKey, requestHash, json(saved)); return saved;
  }
  listMessages(id, owner) { this.getConversation(id, owner); return this.db.prepare('SELECT json FROM messages WHERE conversation_id=? ORDER BY rowid').all(id).map(r => parse(r)); }
  createRun(conversationId, owner, body) {
    const conversation = this.getConversation(conversationId, owner); key(body.idempotencyKey); const requestHash = digest(body);
    const old = this.db.prepare('SELECT * FROM runs WHERE conversation_id=? AND request_key=?').get(conversationId, body.idempotencyKey);
    if (old) { fail(old.request_hash === requestHash, 'run identity reused with different content', 409, 'idempotency_conflict'); return publicRun(parse(old)); }
    if (body.branchDocumentId) this.getDocument(body.branchDocumentId, owner);
    const now = timestamp(), run = { id: randomUUID(), conversationId, documentId: conversation.documentId, state: body.state || 'queued', message: String(body.message || body.text || ''), createdAt: now, updatedAt: now, ...(body.branchDocumentId ? { branchDocumentId: body.branchDocumentId } : {}), ...(body.jobId ? { jobId: body.jobId } : {}) };
    this.db.prepare('INSERT INTO runs VALUES(?,?,?,?,?,?,?)').run(run.id, run.documentId, conversationId, body.idempotencyKey, requestHash, json(run), json({ input: clone(body) })); return publicRun(run);
  }
  runRecord(id) { const row = this.db.prepare('SELECT * FROM runs WHERE id=?').get(id); fail(row, 'run not found', 404); return { run: parse(row), private: parse(row, 'private_json'), owner: this.db.prepare('SELECT owner FROM documents WHERE id=?').get(row.document_id).owner }; }
  getRun(id, owner) { const r = this.runRecord(id); this.documentRow(r.run.documentId, owner); return publicRun(r.run); }
  updateRun(id, patch) { const r = this.runRecord(id); for (const field of ['id','documentId','conversationId','createdAt']) if (patch[field] !== undefined) fail(patch[field] === r.run[field], 'run identity is immutable', 409); if (patch.branchDocumentId) this.getDocument(patch.branchDocumentId, r.owner); if (patch.jobId) this.getJob(patch.jobId, r.owner); const run = { ...r.run, ...clone(patch), updatedAt: timestamp() }; this.db.prepare('UPDATE runs SET json=? WHERE id=?').run(json(run), id); return publicRun(run); }
  listRuns(documentId, owner) { this.getDocument(documentId, owner); return this.db.prepare('SELECT json FROM runs WHERE document_id=? ORDER BY rowid DESC').all(documentId).map(r => publicRun(parse(r))); }
}
