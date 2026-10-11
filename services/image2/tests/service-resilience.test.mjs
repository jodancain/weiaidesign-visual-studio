import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createImageService } from '../server.mjs';
import { ImageStore } from '../store.mjs';
import { encodePNG, executeOperation } from '../processors.mjs';

const OWNER = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'image2-resilience-synthetic-internal-token';
const EMPTY_CONFIG = { imageBaseUrl: '', imageApiKey: '', comfyBaseUrl: '', comfyToken: '', ocrUrl: '', ocrToken: '', agent: { baseUrl: '', apiKey: '', models: ['fixture'], timeoutMs: 1000 } };
async function waitFor(check, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('isolated HTTP fixture did not settle');
}
function api(origin) {
  const request = (path, body, method = body === undefined ? 'GET' : 'POST') => fetch(origin + '/api/v3/image2' + path, { method, headers: { authorization: `Bearer ${TOKEN}`, 'x-studio-visitor-id': OWNER, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = async (path, body, method) => { const response = await request(path,body,method), value = await response.json(); assert.equal(response.status,200,JSON.stringify(value)); return value.data; };
  return { request, json };
}

test('HTTP frozen request replays after trace changes type and the target is deleted, while fresh requests retain typed guards', async t => {
  const directory = mkdtempSync(join(tmpdir(),'image2-replay-')); let calls = 0;
  const service = createImageService({ directory, token: TOKEN, config: EMPTY_CONFIG, fetchImpl: async () => { throw Error('fixture forbids all provider traffic'); }, processor: async (request,ctx) => { calls++; return executeOperation(request,ctx); } });
  await new Promise(resolve => service.server.listen(0,'127.0.0.1',resolve));
  t.after(async () => { service.server.closeAllConnections(); await service.close(); rmSync(directory,{recursive:true,force:true}); });
  const f = api(`http://127.0.0.1:${service.server.address().port}`), data = Buffer.alloc(12 * 10 * 4);
  for (let i = 0; i < data.length; i += 4) data.set((i / 4) % 12 < 6 ? [255,0,0,255] : [0,0,255,255],i);
  const bytes = await encodePNG({width:12,height:10,data}), document = await f.json('/documents',{width:12,height:10});
  const asset = await f.json('/assets',{documentId:document.id,name:'trace.png',mime:'image/png',data:bytes.toString('base64')});
  await f.json(`/documents/${document.id}/commands`,{baseRevision:0,commandId:'source',commands:[{type:'layer.add',layer:{id:'target',type:'raster',assetId:asset.id,width:12,height:10}}]});
  const frozen = { documentId:document.id, baseRevision:1, operation:'trace', targetLayerId:'target', inputs:[{role:'base',assetId:asset.id}], params:{preset:'logo',colors:2,pathomit:0}, idempotencyKey:'trace-fixed-body' };
  const first = await f.json('/operations',frozen);
  const done = await waitFor(async () => { const job = await f.json(`/jobs/${first.job.id}`); return ['complete','failed'].includes(job.state) ? job : null; });
  assert.equal(done.state,'complete',done.error); assert.equal(calls,1);
  let current = await f.json(`/documents/${document.id}`); assert.equal(current.layers[0].type,'vector'); assert.equal(current.revision,2);
  assert.equal((await f.json('/operations',frozen)).job.id,done.id);
  const guarded = await f.request('/operations',{...frozen,baseRevision:current.revision,idempotencyKey:'fresh-vector'});
  assert.equal(guarded.status,422); assert.equal((await guarded.json()).code,'typed_layer_required');
  current = await f.json(`/documents/${document.id}/commands`,{baseRevision:current.revision,commandId:'remove-vector',commands:[{type:'layer.remove',layerId:'target'}]});
  assert.equal(current.layers.length,0);
  const repeated = await f.json('/operations',frozen); assert.equal(repeated.job.id,done.id); assert.equal(repeated.job.state,'complete'); assert.equal(repeated.job.output.assetId,done.output.assetId);
  assert.equal((await f.request('/operations',{...frozen,baseRevision:current.revision,idempotencyKey:'fresh-deleted-target'})).status,404);
  assert.equal((await f.json(`/documents/${document.id}/jobs`)).length,1); assert.equal(calls,1);
});

test('SIGKILL after one local model POST preserves unknown acceptance across a real process restart without resubmission', { skip: process.platform === 'win32', timeout: 30000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(),'image2-sigkill-')), children = [], sockets = new Set(); let posts = 0;
  const provider = createServer((req,res) => {
    assert.equal(req.method,'POST'); assert.equal(req.url,'/v1/images/generations'); assert.equal(req.headers.authorization,'Bearer synthetic-local-provider-key');
    let body = ''; req.on('data',chunk => { body += chunk; });
    req.on('end',() => { const input = JSON.parse(body); assert.equal(input.prompt,'isolated synthetic fixture'); posts++; });
    // The provider has received the request and intentionally never acknowledges it.
    void res;
  });
  provider.on('connection',socket => { sockets.add(socket); socket.on('close',() => sockets.delete(socket)); });
  await new Promise(resolve => provider.listen(0,'127.0.0.1',resolve));
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await Promise.all(children.map(child => child.exited));
    for (const socket of sockets) socket.destroy(); await new Promise(resolve => provider.close(resolve));
    rmSync(directory,{recursive:true,force:true});
  });
  const config = { ...EMPTY_CONFIG, imageBaseUrl:`http://127.0.0.1:${provider.address().port}/v1`, imageApiKey:'synthetic-local-provider-key', imageModel:'gpt-image-2', imageQuality:'medium', imageTimeoutMs:60000 };
  async function openChild() {
    const serverURL = new URL('../server.mjs',import.meta.url).href;
    const script = `import {createImageService} from ${JSON.stringify(serverURL)}; const service=createImageService(${JSON.stringify({directory,token:TOKEN,config})}); service.server.listen(0,'127.0.0.1',()=>process.send({port:service.server.address().port}));`;
    const child = spawn(process.execPath,['--input-type=module','--eval',script],{stdio:['ignore','ignore','pipe','ipc'],env:{PATH:process.env.PATH || '/usr/bin:/bin',LANG:'C.UTF-8',NODE_NO_WARNINGS:'1'}});
    children.push(child); child.exited = new Promise(resolve => child.once('exit',(code,signal) => resolve({code,signal}))); let diagnostic = '';
    child.stderr.on('data',chunk => { diagnostic = (diagnostic + chunk).slice(-2000); });
    const port = await new Promise((resolve,reject) => {
      const timeout = setTimeout(() => reject(Error('child service start timeout: '+diagnostic)),10000);
      child.once('message',message => { clearTimeout(timeout); resolve(message.port); });
      child.once('error',error => { clearTimeout(timeout); reject(error); });
      child.once('exit',() => { clearTimeout(timeout); reject(Error('child exited before listen: '+diagnostic)); });
    });
    return { child, ...api(`http://127.0.0.1:${port}`) };
  }
  const first = await openChild(), document = await first.json('/documents',{name:'SIGKILL-fixture',width:16,height:16});
  const frozen = {documentId:document.id,baseRevision:0,operation:'generate',params:{prompt:'isolated synthetic fixture',n:1},idempotencyKey:'one-request-before-kill'};
  const submitted = await first.json('/operations',frozen); await waitFor(() => posts === 1);
  assert.equal((await first.json(`/jobs/${submitted.job.id}`)).state,'running');
  assert.equal(first.child.kill('SIGKILL'),true); assert.equal((await first.child.exited).signal,'SIGKILL');
  const crashed = new ImageStore(directory);
  try { const record = crashed.jobRecord(submitted.job.id); assert.equal(record.private.providerReceipt.provider,'image'); assert.equal(record.private.providerReceipt.phase,'submitting'); assert.equal(record.job.state,'running'); }
  finally { crashed.close(); }
  const reopened = await openChild(), recovered = await reopened.json(`/jobs/${submitted.job.id}`);
  assert.equal(recovered.state,'uncertain'); assert.equal(recovered.stage,'acceptance_unknown'); assert.equal(recovered.retryable,false); assert.equal(recovered.metrics.generationCalls,1);
  assert.ok(recovered.metrics.executionMs >= 0); assert.ok(recovered.finishedAt); assert.ok(!JSON.stringify(recovered).includes('synthetic-local-provider-key'));
  const replay = await reopened.json('/operations',frozen); assert.equal(replay.job.id,recovered.id); assert.equal(replay.job.state,'uncertain');
  assert.equal((await reopened.request(`/jobs/${recovered.id}/retry`,{idempotencyKey:'must-not-resubmit'})).status,409);
  assert.equal((await reopened.json(`/documents/${document.id}`)).revision,0); assert.equal((await reopened.json(`/documents/${document.id}/branches`)).length,1);
  await new Promise(resolve => setTimeout(resolve,450)); assert.equal(posts,1);
});
