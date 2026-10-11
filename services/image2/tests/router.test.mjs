import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImageStore } from '../store.mjs';
import { createImageRouter } from '../router.mjs';

const OWNER = '11111111-1111-4111-8111-111111111111', OTHER = '22222222-2222-4222-8222-222222222222', TOKEN = 'image2-test-internal-token-123456';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l2EAAAAASUVORK5CYII=', 'base64');
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'image2-router-')), store = new ImageStore(directory); let submissions = 0;
  const runner = {
    capabilities: async () => ({ operations: [{ name: 'resize', available: true, executionClass: 'cpu' }], agent: { available: false } }),
    submit: async (owner, request) => { submissions++; return store.createJob(request.documentId, owner, { kind: 'operation', input: request, idempotencyKey: request.idempotencyKey }); },
    cancel: async (owner,id) => { store.getJob(id,owner); return store.updateJob(id,{state:'cancelled'}); },
    retry: async (owner,id,key) => { assert.ok(key); store.getJob(id,owner); return store.updateJob(id,{state:'queued'}); },
    defaultFont: async (owner,id) => { store.getDocument(id,owner); return { family:'verified fixture family',available:true }; },
  };
  const handle = createImageRouter({ store, runner, config: { token: TOKEN }, fetchImpl: () => { throw Error('imports may not fetch URLs'); } });
  const server = createServer(async (req,res) => { if (!await handle(req,res)) { res.writeHead(404); res.end(); } });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory,{recursive:true,force:true}); });
  const base = `http://127.0.0.1:${server.address().port}/api/v3/image2`;
  const call = (path, { method = 'GET', body, owner = OWNER, headers = {} } = {}) => fetch(base + path, { method, headers: { authorization: `Bearer ${TOKEN}`, 'x-studio-visitor-id': owner, ...(body === undefined ? {} : { 'content-type':'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { store, call, get submissions() { return submissions; } };
}
test('all private routes require both internal bearer and visitor; documents never cross tenants', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('/documents',{headers:{authorization:''}})).status,401);
  assert.equal((await f.call('/documents',{headers:{'x-studio-visitor-id':''}})).status,401);
  const d = (await (await f.call('/documents',{method:'POST',body:{name:'private'}})).json()).data;
  assert.equal((await f.call(`/documents/${d.id}`,{owner:OTHER})).status,404);
  assert.deepEqual((await (await f.call('/documents',{owner:OTHER})).json()).data,[]);
});
test('uploads retain exact bytes and verified identity; authenticated Range and HEAD work', async t => {
  const f = await fixture(t), d = f.store.createDocument(OWNER,{});
  const response = await f.call('/assets',{method:'POST',body:{documentId:d.id,name:'base.png',mime:'image/png',data:PNG.toString('base64')}}); assert.equal(response.status,200);
  const asset = (await response.json()).data; assert.equal(asset.width,1); assert.equal(asset.url,`/api/v3/image2/assets/${asset.id}/content`);
  const partial = await f.call(`/assets/${asset.id}/content`,{headers:{range:'bytes=2-5'}}); assert.equal(partial.status,206); assert.deepEqual(Buffer.from(await partial.arrayBuffer()),PNG.subarray(2,6));
  assert.equal((await f.call(`/assets/${asset.id}/content`,{method:'HEAD'})).headers.get('content-length'),String(PNG.length));
  assert.equal((await f.call(`/assets/${asset.id}/content`,{headers:{range:'bytes=999-'}})).status,416);
  assert.equal((await f.call(`/assets/${asset.id}/content`,{owner:OTHER})).status,404);
  assert.equal((await f.call('/assets',{method:'POST',body:{documentId:d.id,name:'bad.png',mime:'image/png',data:Buffer.from('not an image').toString('base64')}})).status,400);
  assert.equal((await f.call('/assets',{method:'POST',body:{documentId:d.id,name:'identity.png',mime:'image/png',assignedId:'33333333-3333-4333-8333-333333333333',data:PNG.toString('base64')}})).status,400);
});
test('operations delegate only owned requests and job routes never return frozen private receipts', async t => {
  const f = await fixture(t), d = f.store.createDocument(OWNER,{});
  assert.equal((await f.call('/operations',{method:'POST',owner:OTHER,body:{documentId:d.id,operation:'resize',idempotencyKey:'bad'}})).status,404); assert.equal(f.submissions,0);
  const r = await f.call('/operations',{method:'POST',body:{documentId:d.id,baseRevision:0,operation:'resize',params:{width:2,height:2},idempotencyKey:'resize'}});
  const job = (await r.json()).data.job; assert.equal(f.submissions,1);
  f.store.updateJob(job.id,{}, { receipt:{apiKey:'secret-fixture'}, checkpoints:{secret:'private-fixture'} });
  const publicBody = await (await f.call(`/jobs/${job.id}`)).text(); assert.ok(!/secret-fixture|private-fixture|receipt|checkpoints/.test(publicBody));
  assert.equal((await f.call(`/jobs/${job.id}`,{owner:OTHER})).status,404);
  assert.equal((await f.call(`/jobs/${job.id}/cancel`,{method:'POST'})).status,200);
  assert.equal(f.store.getJob(job.id,OWNER).state,'cancelled');
});
test('legacy import only binds uploaded mappings and retains missing URL references as warnings', async t => {
  const f = await fixture(t), uploadDocument = f.store.createDocument(OWNER,{}), asset = f.store.addAsset(uploadDocument.id,OWNER,{name:'base.png',mime:'image/png'},PNG);
  const snapshot = { document:{store:{'asset:old':{typeName:'asset',id:'asset:old',props:{src:'https://untrusted.invalid/image.png'}},'shape:old':{typeName:'shape',id:'shape:old',type:'image',x:10,y:20,props:{assetId:'asset:old',w:100,h:100}},'shape:missing':{typeName:'shape',id:'shape:missing',type:'image',props:{assetId:'asset:missing',w:10,h:10}}}} };
  const response = await f.call('/imports/legacy',{method:'POST',body:{snapshot,assets:[{legacyId:'asset:old',assetId:asset.id}],width:200,height:200}}); assert.equal(response.status,200);
  const document = (await response.json()).data; assert.equal(document.layers.length,1); assert.equal(document.layers[0].assetId,asset.id); assert.equal(document.metadata.importWarnings.length,1);
  assert.equal((await f.call('/imports/legacy',{method:'POST',owner:OTHER,body:{snapshot,assets:[{legacyId:'asset:old',assetId:asset.id}]}})).status,404);
});
test('document bodies reject oversized requests before runner submission and malformed command graphs', async t => {
  const f = await fixture(t), d = f.store.createDocument(OWNER,{});
  const response = await f.call('/documents',{method:'POST',body:{name:'large',metadata:{value:'x'.repeat(2*1024*1024)}}}); assert.equal(response.status,413);
  assert.equal((await f.call(`/documents/${d.id}/commands`,{method:'POST',body:{baseRevision:0,commandId:'bad',commands:[{type:'layer.add',layer:{id:'x',type:'raster',assetId:'unregistered'}}]}})).status,400);
});
test('default font delegates with document authorization before any font registration', async t => {
  const f = await fixture(t), d = f.store.createDocument(OWNER,{});
  assert.equal((await f.call('/assets/default-font',{method:'POST',owner:OTHER,body:{documentId:d.id}})).status,404);
  const result = await (await f.call('/assets/default-font',{method:'POST',body:{documentId:d.id}})).json(); assert.equal(result.data.family,'verified fixture family');
});
test('injected decoder metadata overrides untrusted client claims before bytes are registered', async t => {
  const f = await fixture(t), d = f.store.createDocument(OWNER,{}); let inspected = 0;
  const handle = createImageRouter({ store:f.store,config:{token:TOKEN},assetInspector:async(bytes,mime)=>{ assert.deepEqual(bytes,PNG);assert.equal(mime,'image/png');inspected++;return {mime:'image/png',width:1,height:1,metadata:{decoded:true,fontFamily:'actual'}}; } });
  const server = createServer(async(req,res)=>{await handle(req,res);});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const response=await fetch(`http://127.0.0.1:${server.address().port}/api/v3/image2/assets`,{method:'POST',headers:{authorization:`Bearer ${TOKEN}`,'x-studio-visitor-id':OWNER,'content-type':'application/json'},body:JSON.stringify({documentId:d.id,name:'image.png',mime:'image/png',data:PNG.toString('base64'),width:999,height:999,metadata:{fontFamily:'forged'}})});
  const asset=(await response.json()).data;assert.equal(inspected,1);assert.equal(asset.width,1);assert.equal(asset.metadata.fontFamily,'actual');
});
