import { createHash, randomUUID } from 'node:crypto';
import { validateV3Document, createV3Document, applyV3Commands, CONTENT_MIME, validateContentJSON } from './domain-v3.mjs';

export class ImageError extends Error {
  constructor(message, status = 400, code = 'invalid_request') { super(message); this.status = status; this.code = code; }
}
export const fail = (condition, message, status = 400, code) => { if (!condition) throw new ImageError(message, status, code); };
export const clone = value => structuredClone(value);
export const timestamp = () => new Date().toISOString();
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const digest = value => createHash('sha256').update(Buffer.isBuffer(value) ? value : typeof value === 'string' ? value : canonical(value)).digest('hex');
export const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
export function requireOwner(owner) {
  fail(typeof owner === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(owner), 'visitor identity is required', 401, 'visitor_required');
  return owner.toLowerCase();
}
function record(value, label) { fail(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`); }
function text(value, max) { return typeof value === 'string' && value.length <= max; }
const finite = value => Number.isFinite(value) && typeof value === 'number';
const dimension = value => Number.isSafeInteger(value) && value > 0 && value <= 32768;
const layerKeys = new Set(['id','type','name','x','y','width','height','rotation','opacity','visible','locked','z','parentId','assetId','maskAssetId','sourceAssetId','sourceRect','text','fontAssetId','fontFamily','fontSize','fontWeight','fill','stroke','strokeWidth','tracking','lineHeight','editability','metadata']);
export function normalizeLayer(input) {
  record(input, 'layer');
  fail(Object.keys(input).every(k => layerKeys.has(k)), 'unsupported layer property');
  const layer = { name: input.type || 'Layer', x: 0, y: 0, width: 1, height: 1, rotation: 0, opacity: 1, visible: true, locked: false, z: 0,
    ...(input.type === 'text' ? { fontSize: 24, fill: '#20232b', lineHeight: 1.2, tracking: 0, fontWeight: 400 } : {}), ...clone(input) };
  fail(validId(layer.id), 'invalid layer id');
  fail(['raster','text','vector','group','mask'].includes(layer.type), 'invalid layer type');
  fail(text(layer.name, 500), 'invalid layer name');
  for (const field of ['x','y','width','height','rotation','z']) fail(finite(layer[field]) && Math.abs(layer[field]) <= 1e7, `invalid layer ${field}`);
  fail(layer.width >= 0 && layer.height >= 0, 'invalid layer dimensions');
  fail(finite(layer.opacity) && layer.opacity >= 0 && layer.opacity <= 1, 'invalid layer opacity');
  fail(typeof layer.visible === 'boolean' && typeof layer.locked === 'boolean', 'invalid layer visibility');
  for (const field of ['parentId','assetId','maskAssetId','sourceAssetId','fontAssetId']) if (layer[field] !== undefined) fail(validId(layer[field]), `invalid ${field}`);
  if (layer.text !== undefined) fail(text(layer.text, 100000), 'invalid layer text');
  if (layer.fontFamily !== undefined) fail(text(layer.fontFamily, 500), 'invalid font family');
  if (layer.fontWeight !== undefined) fail(finite(layer.fontWeight) && layer.fontWeight >= 1 && layer.fontWeight <= 1000 || text(layer.fontWeight, 40), 'invalid font weight');
  for (const field of ['fontSize','strokeWidth','tracking','lineHeight']) if (layer[field] !== undefined) fail(finite(layer[field]) && Math.abs(layer[field]) <= 32768 && (field === 'tracking' || layer[field] >= 0), `invalid ${field}`);
  if (layer.type === 'text') fail(layer.fontSize > 0 && layer.lineHeight > 0, 'text font size and line height must be positive');
  for (const field of ['fill','stroke']) if (layer[field] !== undefined) fail(text(layer[field], 500) && !/url\s*\(/i.test(layer[field]), `invalid ${field}`);
  if (layer.sourceRect !== undefined) {
    const r = layer.sourceRect;
    fail(Array.isArray(r) && r.length === 4 && r.every(finite) && r[0] >= 0 && r[1] >= 0 && r[2] > 0 && r[3] > 0 || r && !Array.isArray(r) && ['x','y','width','height'].every(k => finite(r[k])) && r.x >= 0 && r.y >= 0 && r.width > 0 && r.height > 0, 'invalid sourceRect');
  }
  if (layer.editability !== undefined) fail(['pixels','text','path'].includes(layer.editability), 'invalid editability');
  if (layer.metadata !== undefined) { record(layer.metadata, 'metadata'); fail(canonical(layer.metadata).length <= 2000000, 'metadata too large'); }
  return layer;
}
export function validateDocument(document) {
  if (document?.schemaVersion === 3) return validateV3Document(document);
  record(document, 'document');
  fail(document.schemaVersion === 2 && validId(document.id) && text(document.name, 500), 'invalid document identity');
  fail(Number.isSafeInteger(document.revision) && document.revision >= 0, 'invalid document revision');
  fail(dimension(document.width) && dimension(document.height) && document.width * document.height <= 100000000, 'invalid document dimensions');
  fail(Array.isArray(document.layers) && document.layers.length <= 10000 && Array.isArray(document.assetIds) && document.assetIds.length <= 50000 && document.assetIds.every(validId), 'invalid document collections');
  fail(new Set(document.assetIds).size === document.assetIds.length, 'duplicate asset id');
  document.layers = document.layers.map(normalizeLayer);
  const layers = new Map();
  for (const layer of document.layers) { fail(!layers.has(layer.id), 'duplicate layer id'); layers.set(layer.id, layer); }
  for (const layer of document.layers) {
    for (const field of ['assetId','maskAssetId','sourceAssetId','fontAssetId']) if (layer[field]) fail(document.assetIds.includes(layer[field]), `layer ${field} is not registered`);
    if (layer.metadata?.visibilitySourceAssetId) fail(validId(layer.metadata.visibilitySourceAssetId) && document.assetIds.includes(layer.metadata.visibilitySourceAssetId), 'visibility source is not registered');
    const visited = new Set([layer.id]); let current = layer;
    while (current.parentId) {
      fail(!visited.has(current.parentId), 'cyclic layer groups');
      const parent = layers.get(current.parentId); fail(parent && parent.type === 'group', 'layer parent must be a group');
      visited.add(parent.id); current = parent;
    }
  }
  if (document.metadata !== undefined) { record(document.metadata, 'document metadata'); fail(canonical(document.metadata).length <= 2000000, 'metadata too large'); }
  return document;
}
export function createImageDocument(body = {}) {
  if (body?.schemaVersion === 3) return createV3Document(body);
  fail(body?.schemaVersion === undefined || body.schemaVersion === 2, 'unsupported document schema', 422, 'unsupported_schema');
  record(body, 'document');
  const now = timestamp();
  return validateDocument({ id: randomUUID(), schemaVersion: 2, revision: 0, name: body.name || 'Untitled', width: body.width ?? 1024, height: body.height ?? 1024, layers: clone(body.layers || []), assetIds: [...new Set(body.assetIds || [])], createdAt: now, updatedAt: now, ...(body.metadata === undefined ? {} : { metadata: clone(body.metadata) }) });
}
export function applyCommands(document, commands) {
  if (document?.schemaVersion === 3) return applyV3Commands(document, commands);
  fail(Array.isArray(commands) && commands.length > 0 && commands.length <= 1000, 'commands must be a nonempty list');
  const result = clone(document);
  const locked = layer => {
    let current = layer;
    while (current) { if (current.locked) return true; current = result.layers.find(l => l.id === current.parentId); }
    return false;
  };
  for (const command of commands) {
    record(command, 'command');
    if (command.type === 'layer.add') { const layer = normalizeLayer(command.layer); fail(!result.layers.some(l => l.id === layer.id), 'layer already exists', 409); if (layer.parentId) fail(!locked(result.layers.find(l => l.id === layer.parentId)), 'locked layer group cannot be changed', 409, 'layer_locked'); result.layers.push(layer); }
    else if (command.type === 'layer.update') {
      const layer = result.layers.find(l => l.id === command.layerId); fail(layer, 'layer not found', 404); record(command.patch, 'patch');
      const unlock = Object.keys(command.patch).length === 1 && command.patch.locked === false && layer.locked && !locked(result.layers.find(l => l.id === layer.parentId));
      fail(!locked(layer) || unlock, 'locked layer cannot be changed', 409, 'layer_locked');
      fail(!('id' in command.patch), 'layer identity is immutable'); Object.assign(layer, clone(command.patch));
      for (const key of Object.keys(layer)) if (layer[key] === null && !['text','name'].includes(key)) delete layer[key];
    } else if (command.type === 'layer.remove') {
      fail(result.layers.some(l => l.id === command.layerId), 'layer not found', 404);
      const removed = new Set([command.layerId]); let count;
      do { count = removed.size; for (const layer of result.layers) if (removed.has(layer.parentId)) removed.add(layer.id); } while (count !== removed.size);
      fail(!result.layers.some(l => removed.has(l.id) && locked(l)), 'locked layer cannot be removed', 409, 'layer_locked');
      result.layers = result.layers.filter(l => !removed.has(l.id));
    } else if (command.type === 'layer.reorder') {
      fail(Array.isArray(command.layerIds) && command.layerIds.length === result.layers.length && new Set(command.layerIds).size === result.layers.length && command.layerIds.every(id => result.layers.some(l => l.id === id)), 'reorder must include each layer once');
      const map = new Map(result.layers.map(l => [l.id, l])); result.layers = command.layerIds.map((id, z) => ({ ...map.get(id), z }));
      fail(result.layers.every(l => !locked(l) || map.get(l.id).z === l.z), 'locked layer cannot be reordered', 409, 'layer_locked');
    } else if (command.type === 'document.update') {
      record(command.patch, 'document patch'); fail(Object.keys(command.patch).every(k => ['name','width','height','metadata'].includes(k)), 'unsupported document patch'); Object.assign(result, clone(command.patch));
    } else fail(false, 'unsupported command');
  }
  return validateDocument(result);
}
function equal(a, b) { return canonical(a) === canonical(b); }
export function mergeBranch(base, current, branch) {
  const merged = clone(current), conflicts = [];
  fail(base.schemaVersion === current.schemaVersion && current.schemaVersion === branch.schemaVersion, 'branch schema mismatch', 409, 'branch_conflict');
  for (const field of ['name','width','height', ...(current.schemaVersion === 3 ? ['resolution','workingColor','renderVersion'] : [])]) {
    if (!equal(base[field], branch[field])) { if (!equal(base[field], current[field]) && !equal(branch[field], current[field])) conflicts.push(field); else merged[field] = clone(branch[field]); }
  }
  const metadata = { ...current.metadata }, bookkeeping = new Set(['candidateJobId','runId','acceptedAt','acceptedRevision','acceptedIntoDocumentId']);
  for (const key of new Set([...Object.keys(base.metadata || {}), ...Object.keys(branch.metadata || {})])) {
    // Branch creation adds execution bookkeeping; it is not an authored change.
    if (bookkeeping.has(key)) continue;
    const before = base.metadata?.[key], live = current.metadata?.[key], candidate = branch.metadata?.[key];
    if (!equal(before, candidate)) {
      if (!equal(before, live) && !equal(live, candidate)) conflicts.push(`metadata:${key}`);
      else if (candidate === undefined) delete metadata[key]; else Object.defineProperty(metadata, key, { value: clone(candidate), enumerable: true, writable: true, configurable: true });
    }
  }
  if (current.metadata !== undefined || Object.keys(metadata).length) merged.metadata = metadata;
  const maps = [base,current,branch].map(d => new Map(d.layers.map(l => [l.id,l]))), result = new Map(maps[1]);
  for (const id of new Set([...maps[0].keys(), ...maps[2].keys()])) {
    const [before, live, candidate] = maps.map(m => m.get(id));
    if (!equal(before, candidate)) {
      if (!equal(before, live) && !equal(live, candidate)) conflicts.push(`layer:${id}`);
      else if (candidate) result.set(id, clone(candidate)); else result.delete(id);
    }
  }
  fail(conflicts.length === 0, `branch conflicts: ${conflicts.join(', ')}`, 409, 'branch_conflict');
  if (current.schemaVersion === 3) {
    for (const field of ['artboards','guides','savedSelections']) {
      const sets = [base,current,branch].map(d => new Map(d[field].map(item => [item.id,item]))), collection = new Map(sets[1]);
      for (const id of new Set([...sets[0].keys(),...sets[2].keys()])) {
        const [before,live,candidate] = sets.map(set => set.get(id));
        if (!equal(before,candidate)) {
          fail(equal(before,live) || equal(live,candidate), `branch conflict: ${field}:${id}`, 409, 'branch_conflict');
          if (candidate) collection.set(id,clone(candidate)); else collection.delete(id);
        }
      }
      merged[field] = [...collection.values()];
    }
    merged.requiredFeatures = [...new Set([...current.requiredFeatures,...branch.requiredFeatures])];
    const contents = new Map(current.contentAssets.map(c => [c.id,c]));
    for (const c of branch.contentAssets) { const old = contents.get(c.id); fail(!old || equal(old,c), 'content identity conflict', 409, 'branch_conflict'); contents.set(c.id,clone(c)); }
    merged.contentAssets = [...contents.values()];
  }
  merged.layers = [...result.values()].sort((a,b) => a.z - b.z); merged.assetIds = [...new Set([...current.assetIds, ...branch.assetIds])];
  return validateDocument(merged);
}
export function inspectBytes(bytes, declaredMime) {
  fail(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 64 * 1024 * 1024, 'asset must be 1 byte–64 MB');
  const mime = String(declaredMime || '').split(';')[0].toLowerCase(); let width, height;
  if (mime === CONTENT_MIME) {
    let content; try { content = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail(false, 'invalid content JSON'); }
    validateContentJSON(content);
  } else if (mime === 'image/png') { fail(bytes.length >= 24 && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])), 'invalid PNG'); width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20); }
  else if (mime === 'image/jpeg') fail(bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255, 'invalid JPEG');
  else if (mime === 'image/webp') fail(bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP', 'invalid WebP');
  else if (mime === 'image/svg+xml') {
    const svg = bytes.toString('utf8');
    const decode = value => value.replace(/&#(?:x([0-9a-f]+)|(\d+));/gi, (_,hex,decimal) => String.fromCodePoint(Math.min(0x10ffff, parseInt(hex || decimal, hex ? 16 : 10)))).replace(/&colon;/gi, ':');
    const refs = [...svg.matchAll(/\b(?:href|src)\s*=\s*(["'])(.*?)\1/gi)].map(m => decode(m[2]).trim());
    const urls = [...svg.matchAll(/url\(\s*([^)]+)\)/gi)].map(m => decode(m[1]).trim().replace(/^["']|["']$/g, ''));
    fail(/<svg\b/i.test(svg) && !/<(?:script|foreignObject)\b|<!DOCTYPE|<!ENTITY|\bon\w+\s*=|@import/i.test(svg) && refs.every(ref => ref.startsWith('#') || /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(ref)) && urls.every(ref => ref.startsWith('#') || /^data:font\/(?:ttf|otf|woff2?);base64,[A-Za-z0-9+/]+={0,2}$/.test(ref)), 'unsafe or invalid SVG');
  } else if (mime === 'application/pdf') fail(bytes.toString('ascii',0,5) === '%PDF-', 'invalid PDF');
  else if (mime === 'application/zip') fail(bytes[0] === 80 && bytes[1] === 75, 'invalid ZIP');
  else if (mime === 'font/ttf') fail(bytes.length >= 4 && (bytes.readUInt32BE(0) === 0x00010000 || bytes.toString('ascii',0,4) === 'true'), 'invalid TTF');
  else if (mime === 'font/otf') fail(bytes.toString('ascii',0,4) === 'OTTO', 'invalid OTF');
  else if (mime === 'font/woff') fail(bytes.toString('ascii',0,4) === 'wOFF', 'invalid WOFF');
  else if (mime === 'font/woff2') fail(bytes.toString('ascii',0,4) === 'wOF2', 'invalid WOFF2');
  else fail(false, 'unsupported asset MIME type');
  if (width !== undefined) fail(dimension(width) && dimension(height) && width * height <= 100000000, 'asset pixel limit exceeded');
  return { mime, ...(width === undefined ? {} : { width, height }) };
}
const JOB_FIELDS = ['id','documentId','kind','operation','state','progress','stage','createdAt','updatedAt','startedAt','finishedAt','metrics','output','error','retryable'];
const RUN_FIELDS = ['id','documentId','branchDocumentId','conversationId','state','jobId','message','output','createdAt','updatedAt','error'];
export const publicJob = job => Object.fromEntries(JOB_FIELDS.filter(k => job[k] !== undefined).map(k => [k, clone(job[k])]));
export const publicRun = run => Object.fromEntries(RUN_FIELDS.filter(k => run[k] !== undefined).map(k => [k, clone(run[k])]));
