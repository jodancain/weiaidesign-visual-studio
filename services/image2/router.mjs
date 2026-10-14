import { timingSafeEqual, randomUUID } from 'node:crypto';
import { fail, ImageError, requireOwner, validId } from './domain.mjs';
import { routeCraft } from './craft-service.mjs';
import { CONTENT_MIME } from './domain-v3.mjs';

const PREFIX = '/api/v3/image2';
const MAX_BODY = 96 * 1024 * 1024;
function send(res, status, data) {
  const bytes = Buffer.from(JSON.stringify(data));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': bytes.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(bytes);
}
async function body(req, maximum = MAX_BODY) {
  fail(!req.headers['content-length'] || Number(req.headers['content-length']) <= maximum, 'request body too large', 413, 'body_too_large');
  const chunks = []; let length = 0;
  for await (const chunk of req) { length += chunk.length; fail(length <= maximum, 'request body too large', 413, 'body_too_large'); chunks.push(chunk); }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw new ImageError('invalid JSON body'); }
  fail(value && typeof value === 'object' && !Array.isArray(value), 'JSON body must be an object'); return value;
}
function base64(data) {
  fail(typeof data === 'string', 'asset data must be base64');
  const encoded = data.replace(/^data:[^;,]+;base64,/, '');
  fail(encoded.length > 0 && encoded.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(encoded), 'invalid base64');
  return Buffer.from(encoded, 'base64');
}
function content(req, res, { asset, bytes }) {
  const etag = `"${asset.hash}"`, headers = { 'content-type': asset.mime, 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=31536000, immutable', etag, 'x-content-type-options': 'nosniff', 'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(asset.name)}` };
  if (asset.mime === 'image/svg+xml') headers['content-security-policy'] = "default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; sandbox";
  if (!req.headers.range && req.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return; }
  let start = 0, end = bytes.length - 1, status = 200;
  if (req.headers.range && (!req.headers['if-range'] || req.headers['if-range'] === etag)) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range); let valid = !!(match && (match[1] || match[2]));
    if (valid) {
      if (!match[1]) { const count = Number(match[2]); valid = Number.isSafeInteger(count) && count > 0; start = Math.max(0, bytes.length - count); }
      else { start = Number(match[1]); end = match[2] ? Number(match[2]) : end; }
      valid = valid && Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && start < bytes.length && end >= start;
    }
    if (!valid) { res.writeHead(416, { ...headers, 'content-range': `bytes */${bytes.length}` }); res.end(); return; }
    end = Math.min(end, bytes.length - 1); status = 206; headers['content-range'] = `bytes ${start}-${end}/${bytes.length}`;
  }
  headers['content-length'] = String(end - start + 1); res.writeHead(status, headers); res.end(req.method === 'HEAD' ? undefined : bytes.subarray(start, end + 1));
}
function legacyLayers(snapshot, mappings) {
  const raw = snapshot?.document?.store || snapshot?.store || snapshot?.document || snapshot;
  if (Array.isArray(raw?.layers)) return { layers: raw.layers.map(l => ({ ...l, assetId: mappings.get(l.assetId) || l.assetId })), warnings: [] };
  const records = Object.values(raw || {}).filter(r => r && typeof r === 'object'), shapes = records.filter(r => r.typeName === 'shape');
  const ids = new Map(shapes.map(s => [s.id, randomUUID()])), groups = new Set(shapes.filter(s => ['group','frame'].includes(s.type)).map(s => s.id));
  const warnings = [], layers = [];
  for (const [z,s] of shapes.entries()) {
    const p = s.props || {}, common = { id: ids.get(s.id), name: s.type, x: Number(s.x || 0), y: Number(s.y || 0), width: Number(p.w || 1), height: Number(p.h || 1), rotation: Number(s.rotation || 0) * 180 / Math.PI, opacity: s.opacity ?? 1, visible: true, locked: !!s.isLocked, z, metadata: { legacyShapeId: s.id }, ...(groups.has(s.parentId) ? { parentId: ids.get(s.parentId) } : {}) };
    if (['group','frame'].includes(s.type)) layers.push({ ...common, type: 'group' });
    else if (s.type === 'image') {
      const record = records.find(r => r.typeName === 'asset' && r.id === p.assetId), assetId = mappings.get(p.assetId) || mappings.get(record?.props?.src);
      if (assetId) layers.push({ ...common, type: 'raster', assetId, editability: 'pixels' });
      else warnings.push(`Missing uploaded file for ${s.id}`);
    } else if (s.type === 'text') {
      const collectText = node => typeof node?.text === 'string' ? node.text : (node?.content || node?.children || []).map(collectText).join('');
      layers.push({ ...common, type: 'text', text: String(p.text ?? collectText(p.richText)), fontFamily: 'sans-serif', fontSize: ({ s: 18, m: 24, l: 36, xl: 48 })[p.size] || 24, fill: '#000000', editability: 'text', metadata: { ...common.metadata, legacyProps: p, fontConfirmed: false } });
    } else warnings.push(`Unsupported legacy shape ${s.id} (${s.type}); retained in import source`);
  }
  return { layers, warnings };
}
export function createImageRouter({ store, runner, craft, config = {}, assetInspector }) {
  async function execute(name, ...args) { fail(typeof runner?.[name] === 'function', `${name} is unavailable`, 503, 'runner_unavailable'); return runner[name](...args); }
  return async function handle(req, res) {
    let url; try { url = new URL(req.url || '/', 'http://image2.internal'); } catch { send(res, 400, { detail: 'invalid URL', code: 'invalid_request' }); return true; }
    if (url.pathname === '/health') { send(res, 200, { data: { status: 'ok', service: 'image2' } }); return true; }
    if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return false;
    try {
      const configured = typeof config.token === 'function' ? config.token() : config.token || config.apiToken || config.internalToken;
      fail(typeof configured === 'string' && configured.length >= 24, 'image2 internal authentication is not configured', 503, 'auth_unconfigured');
      const actual = Buffer.from(String(req.headers.authorization || '')), expected = Buffer.from(`Bearer ${configured}`);
      fail(actual.length === expected.length && timingSafeEqual(actual, expected), 'invalid or missing internal token', 401, 'unauthorized');
      const owner = requireOwner(req.headers['x-studio-visitor-id']);
      const parts = url.pathname.slice(PREFIX.length).split('/').filter(Boolean).map(p => decodeURIComponent(p));
      fail(parts.every(p => p !== '..' && !p.includes('/') && !p.includes('\\')), 'invalid path');
      const method = req.method; let value;
      if (method === 'OPTIONS') { res.writeHead(204, { allow: 'GET,HEAD,POST,PUT,OPTIONS', 'cache-control': 'no-store' }); res.end(); return true; }
      if (parts[0] === 'capabilities' && parts.length === 1 && method === 'GET') value = await execute('capabilities');
      else if (parts[0] === 'documents' && parts.length === 1 && method === 'GET') value = store.listDocuments(owner);
      else if (parts[0] === 'documents' && parts.length === 1 && method === 'POST') value = store.createDocument(owner, await body(req, 2 * 1024 * 1024));
      else if (parts[0] === 'documents' && parts[1]) {
        const id = parts[1]; store.getDocument(id, owner);
        if (parts[2] === 'craft') { fail(craft, 'Craft service unavailable', 503, 'craft_unavailable'); value = await routeCraft(craft, parts, method, owner, () => body(req, parts[3] === 'assets' ? MAX_BODY : 2 * 1024 * 1024)); }
        else if (parts.length === 2 && method === 'GET') value = store.getDocument(id, owner);
        else if (parts[2] === 'commands' && parts[3] && parts.length === 4 && method === 'GET') value = store.getCommandReceipt(id, owner, parts[3]);
        else if (parts[2] === 'commands' && parts.length === 3 && method === 'POST') value = store.command(id, owner, await body(req, 2 * 1024 * 1024));
        else if (parts[2] === 'migrate-v3' && parts.length === 3 && method === 'POST') value = await store.migrateV3(id, owner, await body(req, 2 * 1024 * 1024));
        else if (parts[2] === 'history' && parts.length === 3 && method === 'POST') value = store.history(id, owner, await body(req, 2 * 1024 * 1024));
        else if (parts[2] === 'revisions' && parts[3] && parts.length === 4 && method === 'GET') value = store.getRevision(id, owner, Number(parts[3]));
        else if (parts[2] === 'revisions' && parts.length === 3 && method === 'GET') value = store.listRevisions(id, owner);
        else if (parts[2] === 'render-resource' && parts[3] && parts.length === 4 && method === 'GET') {
          fail(validId(parts[3]), 'invalid content identity');
          const options = {};
          if (url.searchParams.has('revision')) {
            options.revision = Number(url.searchParams.get('revision'));
            store.getRevision(id, owner, options.revision);
          }
          if (url.searchParams.has('layerId')) { options.layerId = url.searchParams.get('layerId'); fail(validId(options.layerId), 'invalid layer identity'); }
          if (url.searchParams.has('role')) { options.role = url.searchParams.get('role'); fail(['content','mask'].includes(options.role), 'invalid render resource role'); }
          const document = options.revision === undefined ? store.getDocument(id, owner) : store.getRevision(id, owner, options.revision);
          fail(document.schemaVersion === 3, 'render resources require a v3 document', 422, 'unsupported_schema');
          fail(document.contentAssets.some(c => c.id === parts[3]), 'content not found in this revision', 404, 'not_found');
          value = await execute('renderResource', owner, id, parts[3], options);
        }
        else if (parts[2] === 'assets' && parts.length === 3 && method === 'GET') value = store.listAssets(id, owner);
        else if (parts[2] === 'jobs' && parts.length === 3 && method === 'GET') value = store.listJobs(id, owner);
        else if (parts[2] === 'runs' && parts.length === 3 && method === 'GET') value = store.listRuns(id, owner);
        else if (parts[2] === 'branches' && parts.length === 3 && method === 'GET') value = store.listBranches(id, owner);
        else if (parts[2] === 'accept' && parts.length === 3 && method === 'POST') value = store.acceptBranch(id, owner, await body(req, 2 * 1024 * 1024));
        else throw new ImageError('route not found', 404);
      } else if (parts[0] === 'assets' && parts[1] === 'default-font' && parts.length === 2 && method === 'POST') {
        const b = await body(req, 2 * 1024 * 1024); store.getDocument(b.documentId, owner); value = await execute('defaultFont', owner, b.documentId);
      } else if (parts[0] === 'assets' && parts.length === 1 && method === 'POST') {
        const b = await body(req), bytes = base64(b.data);
        fail(!('assignedId' in b), 'asset identity is assigned by the server');
        store.getDocument(b.documentId, owner);
        const inspected = assetInspector && b.mime !== CONTENT_MIME ? await assetInspector(bytes, b.mime) : {};
        value = store.addAsset(b.documentId, owner, { ...b, ...inspected, metadata: { ...b.metadata, ...inspected.metadata } }, bytes);
      } else if (parts[0] === 'assets' && parts[1] && parts[2] === 'content' && parts.length === 3 && ['GET','HEAD'].includes(method)) { content(req, res, store.getAsset(parts[1], owner)); return true; }
      else if (parts[0] === 'operations' && parts.length === 1 && method === 'POST') {
        const b = await body(req, 2 * 1024 * 1024); store.getDocument(b.documentId, owner); value = { job: await execute('submit', owner, b) };
      } else if (parts[0] === 'jobs' && parts[1]) {
        store.getJob(parts[1], owner);
        if (parts.length === 2 && method === 'GET') value = store.getJob(parts[1], owner);
        else if (parts[2] === 'cancel' && parts.length === 3 && method === 'POST') value = await execute('cancel', owner, parts[1]);
        else if (parts[2] === 'retry' && parts.length === 3 && method === 'POST') value = await execute('retry', owner, parts[1], (await body(req, 2 * 1024 * 1024)).idempotencyKey);
        else throw new ImageError('route not found', 404);
      } else if (parts[0] === 'conversations' && parts.length === 1 && method === 'GET') value = store.listConversations(url.searchParams.get('documentId'), owner);
      else if (parts[0] === 'conversations' && parts.length === 1 && method === 'POST') value = store.createConversation(owner, await body(req, 2 * 1024 * 1024));
      else if (parts[0] === 'conversations' && parts[1] && parts[2] === 'messages' && parts.length === 3) {
        store.getConversation(parts[1], owner);
        if (method === 'GET') value = store.listMessages(parts[1], owner);
        else if (method === 'POST') { const b = await body(req, 2 * 1024 * 1024); fail(typeof b.text === 'string' && b.text.trim(), 'message text is required'); value = await execute('submitRun', owner, parts[1], b); }
        else throw new ImageError('route not found', 404);
      } else if (parts[0] === 'runs' && parts[1] && parts.length === 2 && method === 'GET') value = store.getRun(parts[1], owner);
      else if (parts[0] === 'imports' && parts[1] === 'legacy' && parts.length === 2 && method === 'POST') {
        const b = await body(req, 2 * 1024 * 1024); fail(b.snapshot && typeof b.snapshot === 'object' && Array.isArray(b.assets), 'snapshot and uploaded asset mappings are required');
        const mappings = new Map(), assets = new Set();
        for (const mapping of b.assets) {
          fail(mapping && validId(mapping.assetId), 'mapping requires an uploaded assetId'); const { asset } = store.getAsset(mapping.assetId, owner); assets.add(asset.id);
          for (const name of ['legacyId','sourceId','fileId','id','src','url']) if (typeof mapping[name] === 'string') mappings.set(mapping[name], asset.id);
        }
        const { layers, warnings } = legacyLayers(b.snapshot, mappings);
        value = store.createDocument(owner, { name: b.name || 'Imported legacy canvas', width: b.width || 1024, height: b.height || 1024, assetIds: [...assets], layers, metadata: { legacySnapshot: b.snapshot, importWarnings: warnings, importedAt: new Date().toISOString() } });
      } else if (parts[0] === 'imports' && parts[1] === 'project' && parts.length === 2 && method === 'POST') value = await execute('importProject', owner, await body(req));
      else if (parts[0] === 'exports' && parts.length === 1 && method === 'POST') { const b = await body(req, 2 * 1024 * 1024); store.getDocument(b.documentId, owner); value = { job: await execute('export', owner, b) }; }
      else throw new ImageError('route not found', 404);
      send(res, 200, { data: value });
    } catch (error) {
      if (!res.headersSent) send(res, error instanceof ImageError ? error.status : Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500, { detail: error instanceof ImageError || error.status ? error.message : 'Image service request failed', code: error.code || 'internal_error' });
      else res.destroy();
    }
    return true;
  };
}
