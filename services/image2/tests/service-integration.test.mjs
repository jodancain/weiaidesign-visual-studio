import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createImageService } from '../server.mjs';
import { encodePNG, decodeRGBA, executeOperation } from '../processors.mjs';
import { unzipSync, strFromU8 } from 'fflate';

const OWNER = '11111111-1111-4111-8111-111111111111', OTHER = '22222222-2222-4222-8222-222222222222';
const TOKEN = 'image2-http-integration-synthetic-token';
const EMPTY_CONFIG = { imageBaseUrl: '', imageApiKey: '', comfyBaseUrl: '', comfyToken: '', ocrUrl: '', ocrToken: '', agent: { baseUrl: '', apiKey: '', models: ['fixture'], timeoutMs: 1000 } };

async function waitFor(check, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('service fixture did not settle');
}
async function image(width = 8, height = 6) {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set([x * 23, y * 31, 90, 255], (y * width + x) * 4);
  return encodePNG({ width, height, data });
}
async function harness(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'image2-http-')); let service, origin;
  const config = { ...EMPTY_CONFIG, ...options.config, agent: { ...EMPTY_CONFIG.agent, ...options.config?.agent } };
  const fetchImpl = options.fetchImpl || (async url => { throw new Error(`fixture forbids provider traffic: ${new URL(url).hostname}`); });
  async function open() {
    service = createImageService({ directory, token: TOKEN, config, fetchImpl, ...(options.processor ? { processor: options.processor } : {}) });
    await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${service.server.address().port}`;
  }
  async function close() { if (!service) return; const old = service; service = undefined; old.server.closeAllConnections(); await old.close(); }
  await open(); t.after(async () => { await close(); rmSync(directory, { recursive: true, force: true }); });
  const request = (path, { method = 'GET', body, owner = OWNER, headers = {} } = {}) => fetch(origin + '/api/v3/image2' + path, { method, headers: { authorization: `Bearer ${TOKEN}`, 'x-studio-visitor-id': owner, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  async function json(path, body, method = body === undefined ? 'GET' : 'POST', owner = OWNER) {
    const response = await request(path, { method, body, owner }), result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result)); return result.data;
  }
  async function terminal(id) {
    return waitFor(async () => { const job = await json(`/jobs/${id}`); return ['complete','failed','uncertain','cancelled','awaiting_user'].includes(job.state) ? job : null; });
  }
  async function bytes(id, owner = OWNER) { const response = await request(`/assets/${id}/content`, { owner }); assert.equal(response.status, 200); return Buffer.from(await response.arrayBuffer()); }
  async function baseDocument(name = 'source') {
    const source = await image(), document = await json('/documents', { name, width: 8, height: 6 });
    const asset = await json('/assets', { documentId: document.id, name: 'source.png', mime: 'image/png', data: source.toString('base64') });
    const edited = await json(`/documents/${document.id}/commands`, { baseRevision: 0, commandId: 'base-layer', commands: [{ type: 'layer.add', layer: { id: 'base-layer', type: 'raster', assetId: asset.id, width: 8, height: 6, x: 0, y: 0, z: 0 } }] });
    return { document: edited, asset, source };
  }
  return { directory, get service() { return service; }, open, close, request, json, terminal, bytes, baseDocument };
}

test('HTTP pixel resize produces true dimensions, candidate isolation, and an explicit branch accept', async t => {
  const f = await harness(t), { document, asset } = await f.baseDocument();
  const { job } = await f.json('/operations', { documentId: document.id, baseRevision: document.revision, operation: 'resize', targetLayerId: 'base-layer', inputs: [{ role: 'base', assetId: asset.id }], params: { width: 16, height: 12, kernel: 'nearest', resizeLayout: true }, mode: 'candidate', idempotencyKey: 'actual-resize' });
  const done = await f.terminal(job.id); assert.equal(done.state, 'complete', done.error);
  const output = await decodeRGBA(await f.bytes(done.output.assetId), 'image/png'); assert.deepEqual([output.width, output.height], [16,12]);
  assert.deepEqual([...output.data.subarray((4 * 16 + 6) * 4, (4 * 16 + 6) * 4 + 4)], [69,62,90,255]);
  const main = await f.json(`/documents/${document.id}`); assert.deepEqual(main,document);
  const branch = await f.json(`/documents/${done.output.branchDocumentId}`); assert.equal(branch.layers[0].assetId, done.output.assetId);
  const accepted = await f.json(`/documents/${document.id}/accept`, { branchDocumentId: branch.id, baseRevision: main.revision, commandId: 'accept-resize' });
  assert.equal(accepted.layers[0].assetId, done.output.assetId); assert.equal(accepted.layers[0].width, 16);
});

test('candidate assets and provenance export/import independently while the main document remains byte-for-byte unchanged', async t => {
  const f = await harness(t), {document,asset} = await f.baseDocument('candidate-package');
  const {job} = await f.json('/operations',{documentId:document.id,baseRevision:1,operation:'flip',targetLayerId:'base-layer',inputs:[{role:'base',assetId:asset.id}],params:{axis:'horizontal'},mode:'candidate',idempotencyKey:'candidate-flip'});
  const done = await f.terminal(job.id);assert.equal(done.state,'complete',done.error);
  const branch = await f.json(`/documents/${done.output.branchDocumentId}`), output = (await f.json(`/documents/${branch.id}/assets`)).find(a=>a.id===done.output.assetId);
  assert.equal(output.documentId,branch.id);assert.deepEqual(output.inputs.map(i=>i.assetId),[asset.id]);assert.deepEqual(await f.json(`/documents/${document.id}`),document);
  const exported = await f.json('/exports',{documentId:branch.id,baseRevision:branch.revision,format:'project',idempotencyKey:'candidate-package'}), archived = await f.terminal(exported.job.id);assert.equal(archived.state,'complete',archived.error);
  const imported = await f.json('/imports/project',{data:(await f.bytes(archived.output.assetId)).toString('base64')});
  assert.equal(imported.parentDocumentId,undefined);assert.deepEqual(await f.bytes(imported.layers[0].assetId),await f.bytes(output.id));
  const remapped = (await f.json(`/documents/${imported.id}/assets`)).find(a=>a.id===imported.layers[0].assetId);assert.equal(remapped.inputs.length,1);assert.notEqual(remapped.inputs[0].assetId,asset.id);
  assert.deepEqual(await f.json(`/documents/${document.id}`),document);
});

test('native project export/import retains real pixels, historical revisions, undo and no executable jobs', async t => {
  const f = await harness(t), { document, asset, source } = await f.baseDocument('history');
  let current = await f.json(`/documents/${document.id}/commands`, { baseRevision: 1, commandId: 'move', commands: [{ type: 'layer.update', layerId: 'base-layer', patch: { x: 2 } }] });
  current = await f.json(`/documents/${document.id}/history`, { baseRevision: current.revision, commandId: 'undo', direction: 'undo' });
  current = await f.json(`/documents/${document.id}/history`, { baseRevision: current.revision, commandId: 'redo', direction: 'redo' });
  const { job } = await f.json('/exports', { documentId: current.id, baseRevision: current.revision, format: 'project', idempotencyKey: 'project-export' });
  const done = await f.terminal(job.id); assert.equal(done.state, 'complete', done.error);
  const archive = await f.bytes(done.output.assetId), imported = await f.json('/imports/project', { data: archive.toString('base64') });
  assert.notEqual(imported.id, current.id); assert.equal(imported.layers[0].x, 2); assert.notEqual(imported.layers[0].assetId, asset.id);
  assert.deepEqual(await f.bytes(imported.layers[0].assetId), source);
  const versions = await f.json(`/documents/${imported.id}/revisions`); assert.equal(versions.length, 5); assert.ok(versions.every(v => v.id === imported.id));
  assert.equal((await f.json(`/documents/${imported.id}/jobs`)).length, 0);
  const undone = await f.json(`/documents/${imported.id}/history`, { baseRevision: imported.revision, commandId: 'import-undo', direction: 'undo' }); assert.equal(undone.layers[0].x, 0);
});

test('native project roundtrip retains remapped base and edit-mask provenance with authoritative hashes', async t => {
  const f = await harness(t), { document, asset } = await f.baseDocument('provenance');
  const pixels = Buffer.alloc(8 * 6 * 4, 255), maskBytes = await encodePNG({ width: 8, height: 6, data: pixels });
  const mask = await f.json('/assets', { documentId: document.id, name: 'mask.png', mime: 'image/png', data: maskBytes.toString('base64') });
  const { job } = await f.json('/operations', { documentId: document.id, baseRevision: 1, operation: 'erase', targetLayerId: 'base-layer', inputs: [{ role: 'base', assetId: asset.id }, { role: 'edit', assetId: mask.id }], params: {}, idempotencyKey: 'erase-provenance' });
  const done = await f.terminal(job.id); assert.equal(done.state, 'complete', done.error);
  const current = await f.json(`/documents/${document.id}`), records = await f.json(`/documents/${document.id}/assets`);
  assert.deepEqual(records.find(a => a.id === done.output.assetId).inputs.map(i => i.role).sort(), ['base','edit']);
  const exported = await f.json('/exports', { documentId: document.id, baseRevision: current.revision, format: 'project', idempotencyKey: 'provenance-export' });
  const complete = await f.terminal(exported.job.id); assert.equal(complete.state, 'complete', complete.error);
  const imported = await f.json('/imports/project', { data: (await f.bytes(complete.output.assetId)).toString('base64') });
  const importedAssets = await f.json(`/documents/${imported.id}/assets`), derived = importedAssets.find(a => a.id === imported.layers[0].assetId);
  assert.equal(derived.inputs.length, 2);
  for (const input of derived.inputs) { const source = importedAssets.find(a => a.id === input.assetId); assert.ok(source); assert.equal(input.hash, source.hash); assert.notEqual(input.assetId, input.role === 'base' ? asset.id : mask.id); }
});

test('one tenant font supplies actual Chinese glyphs in PNG, editable SVG and embedded-font PDF', async t => {
  const f = await harness(t), document = await f.json('/documents', { name: '中文字体', width: 256, height: 96 });
  const font = await f.json('/assets/default-font', { documentId: document.id }); assert.match(font.metadata.family, /Noto Sans CJK SC/);
  assert.equal((await f.bytes(font.id)).toString('ascii', 0, 4), 'OTTO');
  const current = await f.json(`/documents/${document.id}/commands`, { baseRevision: 0, commandId: 'text', commands: [{ type: 'layer.add', layer: { id: 'text', type: 'text', text: '中文 MAI', name: '标题', width: 230, height: 60, x: 10, y: 10, fontAssetId: font.id, fontFamily: font.metadata.family, fontSize: 32, fontWeight: 400, fill: '#000000', metadata: { fontConfirmed: true }, z: 0 } }] });
  const artifacts = {};
  for (const format of ['png','svg','pdf']) {
    const { job } = await f.json('/exports', { documentId: document.id, baseRevision: current.revision, format, idempotencyKey: `font-${format}` });
    const done = await f.terminal(job.id); assert.equal(done.state, 'complete', `${format}: ${done.error}`); artifacts[format] = await f.bytes(done.output.assetId);
  }
  const rgba = await decodeRGBA(artifacts.png, 'image/png'); assert.deepEqual([rgba.width,rgba.height], [256,96]);
  let ink = 0; for (let i=3;i<rgba.data.length;i+=4) if (rgba.data[i] > 0) ink++; assert.ok(ink > 300, 'actual glyph rasterization must be present');
  assert.match(artifacts.svg.toString(), /<text[^>]*font-family="Noto Sans CJK SC"/);
  const embeddedFont = artifacts.svg.toString().match(/data:font\/otf;base64,([A-Za-z0-9+/=]+)/);
  assert.ok(embeddedFont); assert.deepEqual(Buffer.from(embeddedFont[1], 'base64'), await f.bytes(font.id));
  assert.equal(artifacts.pdf.toString('ascii',0,5), '%PDF-'); assert.match(artifacts.pdf.toString('latin1'), /\/FontFile3/);
});

test('service reopen recovers a candidate committed before its completion acknowledgement without repeating pixels', async t => {
  let calls = 0;
  const processor = async (request,ctx) => { calls++; return executeOperation(request,ctx); };
  const f = await harness(t, { processor }), { document } = await f.baseDocument();
  await f.service.runner.stop();
  const { job } = await f.json('/operations', { documentId: document.id, baseRevision: 1, operation: 'flip', targetLayerId: 'base-layer', params: { axis: 'horizontal' }, mode: 'candidate', idempotencyKey: 'post-apply-restart' });
  const record = f.service.store.jobRecord(job.id), branch = f.service.store.getDocument(record.private.branchDocumentId, OWNER);
  f.service.store.updateJob(job.id, { state: 'running' });
  const ctx = f.service.runner.context(job.id, branch, OWNER);
  const result = await executeOperation(record.private.input, ctx);
  f.service.store.command(branch.id, OWNER, { baseRevision: 0, commandId: `job-apply:${job.id}`, commands: result.commands });
  // The command is committed and processorResult is checkpointed; the job completion write was lost.
  const assetId = result.output.assetId; await f.close(); await f.open();
  const done = await f.terminal(job.id); assert.equal(done.state, 'complete', done.error);
  assert.equal(done.output.assetId, assetId); assert.equal((await f.json(`/documents/${branch.id}`)).revision, 1);
  assert.equal((await f.json(`/documents/${document.id}`)).revision, 1);
  const rgba = await decodeRGBA(await f.bytes(assetId),'image/png'); assert.deepEqual([...rgba.data.subarray(0,4)], [161,0,90,255]);
  assert.equal(calls,1, 'recovery may read cached result but must not submit another external operation');
});

test('frozen project export excludes edits and revisions made after submission and remains importable', async t => {
  const f = await harness(t), { document } = await f.baseDocument('frozen'); await f.service.runner.stop();
  const { job } = await f.json('/exports', { documentId: document.id, baseRevision: 1, format: 'project', idempotencyKey: 'frozen-project' });
  await f.json(`/documents/${document.id}/commands`, { baseRevision: 1, commandId: 'later-edit', commands: [{ type: 'document.update', patch: { name: 'later-name' } }] });
  f.service.runner.start(); const done = await f.terminal(job.id); assert.equal(done.state,'complete',done.error);
  const archive = await f.bytes(done.output.assetId), manifest = JSON.parse(strFromU8(unzipSync(archive)['manifest.json']));
  assert.equal(manifest.document.name,'frozen'); assert.ok(manifest.revisions.every(r => r.revision <= manifest.document.revision));
  const imported = await f.json('/imports/project',{data:archive.toString('base64')}); assert.equal(imported.name,'frozen');
});

test('HTTP visitor isolation rejects foreign document, bytes, jobs, branches and conversation references', async t => {
  const f = await harness(t), { document, asset } = await f.baseDocument();
  const conversation = await f.json('/conversations', { documentId: document.id });
  const { job } = await f.json('/operations', { documentId: document.id, baseRevision: 1, operation: 'resize', targetLayerId: 'base-layer', params: { width: 16, height: 12 }, mode: 'candidate', idempotencyKey: 'isolated-job' });
  const done = await f.terminal(job.id); assert.equal(done.state,'complete',done.error);
  for (const path of [`/documents/${document.id}`,`/assets/${asset.id}/content`,`/jobs/${job.id}`,`/documents/${done.output.branchDocumentId}`,`/conversations/${conversation.id}/messages`]) assert.equal((await f.request(path,{owner:OTHER})).status,404,path);
  assert.equal((await f.request('/documents',{headers:{'x-studio-visitor-id':''}})).status,401);
});

test('unknown generation acceptance persists across service reopen and never repeats the provider POST', async t => {
  let submitted = 0;
  const f = await harness(t, { config:{imageBaseUrl:'https://image.fixture.invalid/v1',imageApiKey:'synthetic-image-key'}, fetchImpl:async(url,options)=>{assert.ok(String(url).endsWith('/images/generations'));assert.equal(options.method,'POST');submitted++;throw Error('connection ended after possible acceptance');} });
  const document = await f.json('/documents',{name:'unknown',width:16,height:16}), request = {documentId:document.id,baseRevision:0,operation:'generate',params:{prompt:'fake fixture',n:1},idempotencyKey:'unknown-request'};
  const {job} = await f.json('/operations',request);assert.equal((await f.terminal(job.id)).state,'uncertain');assert.equal(submitted,1);
  await f.close();await f.open();
  const repeated = await f.json('/operations',request);assert.equal(repeated.job.id,job.id);assert.equal(repeated.job.state,'uncertain');
  assert.equal((await f.request(`/jobs/${job.id}/retry`,{method:'POST',body:{idempotencyKey:'must-not-charge'}})).status,409);
  assert.equal(submitted,1);assert.equal((await f.json(`/documents/${document.id}`)).revision,0);
});

test('accepted Comfy task resumes polling after its short poll budget and restart, with one submission', async t => {
  let posts=0,polls=0,ready=false;const output=await image();
  const f = await harness(t,{config:{comfyBaseUrl:'http://comfy.fixture.invalid',comfyToken:'synthetic-comfy-key',comfyPollMs:0,comfyPollAttempts:1,comfyTimeoutMs:1000},fetchImpl:async(url,options={})=>{
    const text=String(url);
    if(text.endsWith('/upload/image'))return Response.json({name:'fixture.png'});
    if(text.endsWith('/prompt')){assert.equal(options.method,'POST');posts++;return Response.json({prompt_id:'accepted-fixture'});}
    if(text.endsWith('/history/accepted-fixture')){polls++;return Response.json(ready?{'accepted-fixture':{status:{completed:true},outputs:{'3':{images:[{filename:'image2_matting_0001.png'}]}}}}:{});}
    if(text.includes('/view?'))return new Response(output,{headers:{'content-type':'image/png'}});
    throw Error('unexpected provider route');
  }});
  const {document}=await f.baseDocument(),{job}=await f.json('/operations',{documentId:document.id,baseRevision:1,operation:'matting',targetLayerId:'base-layer',params:{},idempotencyKey:'one-comfy-submit'});
  await waitFor(()=>polls>=1&&f.service.store.jobRecord(job.id).private.providerReceipt?.promptId==='accepted-fixture'&&!f.service.runner.active.has(job.id));
  assert.equal(posts,1);await f.close();ready=true;await f.open();
  const done=await f.terminal(job.id);assert.equal(done.state,'complete',done.error);assert.equal(posts,1);assert.ok(polls>=2);
  assert.deepEqual(await f.bytes(done.output.assetId),output);
});
