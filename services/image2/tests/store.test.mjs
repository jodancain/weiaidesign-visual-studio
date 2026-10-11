import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImageStore } from '../store.mjs';
import { encodePNG } from '../processors.mjs';

const OWNER = '11111111-1111-4111-8111-111111111111', OTHER = '22222222-2222-4222-8222-222222222222';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l2EAAAAASUVORK5CYII=', 'base64');
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'image2-store-')); let store = new ImageStore(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, get store() { return store; }, reopen() { store.close(); store = new ImageStore(directory); return store; } };
}
const layer = (id, text = id) => ({ id, type: 'text', text, width: 100, height: 30 });
test('job timing and provider counters persist across queue pauses and reopen without exposing private fields', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026,9,10) });
  const f = fixture(t), d = f.store.createDocument(OWNER, {});
  const job = f.store.createJob(d.id, OWNER, { kind: 'operation', idempotencyKey: 'metrics', input: { operation: 'matting' } });
  assert.deepEqual(job.metrics, { queueMs: 0, executionMs: 0, generationCalls: 0, llmCalls: 0, visionCalls: 0, totalMs: 0 });
  t.mock.timers.tick(125); const running = f.store.updateJob(job.id, { state: 'running', metrics: { visionCalls: 1 } }, { secret: 'private-fixture' });
  assert.equal(running.metrics.queueMs,125); assert.ok(running.startedAt); assert.equal(running.finishedAt,undefined);
  t.mock.timers.tick(200); f.store.updateJob(job.id, { stage: 'polling', metrics: { llmCalls: 2 } });
  t.mock.timers.tick(100); const paused = f.store.updateJob(job.id, { state: 'queued' });
  assert.equal(paused.metrics.executionMs,300); assert.equal(paused.metrics.visionCalls,1); assert.equal(paused.metrics.llmCalls,2);
  f.reopen(); t.mock.timers.tick(75); const resumed = f.store.updateJob(job.id, { state: 'running' });
  assert.equal(resumed.startedAt,running.startedAt); assert.equal(resumed.metrics.queueMs,200);
  t.mock.timers.tick(500); const done = f.store.updateJob(job.id, { state: 'complete' });
  assert.equal(done.metrics.executionMs,800); assert.equal(done.metrics.totalMs,1000); assert.ok(done.finishedAt);
  t.mock.timers.tick(100); const repeated = f.store.updateJob(job.id, { state: 'complete', metrics: { generationCalls: 1, secret: 'must-be-dropped' } });
  assert.equal(repeated.metrics.executionMs,800); assert.equal(repeated.finishedAt,done.finishedAt); assert.equal(repeated.metrics.totalMs,1000);
  assert.equal(repeated.metrics.generationCalls,1); assert.ok(!JSON.stringify(repeated).includes('secret')); assert.ok(!JSON.stringify(repeated).includes('lastStateAt'));
  assert.deepEqual(f.reopen().getJob(job.id,OWNER).metrics,repeated.metrics);
});
test('revisions, command identity, undo/redo and asset links survive restart without overwriting original bytes', t => {
  const f = fixture(t), d = f.store.createDocument(OWNER, { layers: [layer('one')] });
  const asset = f.store.addAsset(d.id, OWNER, { name: 'source.png', mime: 'image/png' }, PNG);
  assert.equal(f.store.getDocument(d.id, OWNER).revision, 0);
  const request = { commandId: 'edit-1', baseRevision: 0, commands: [{ type: 'layer.update', layerId: 'one', patch: { text: 'changed' } }] };
  f.store.command(d.id, OWNER, request); f.store.command(d.id, OWNER, request);
  assert.equal(f.store.getDocument(d.id, OWNER).revision, 1);
  assert.throws(() => f.store.command(d.id, OWNER, { ...request, commands: [{ type: 'layer.remove', layerId: 'one' }] }), /identity/);
  let restored = f.reopen(); const undone = restored.history(d.id, OWNER, { baseRevision: 1, commandId: 'undo-1', direction: 'undo' });
  assert.equal(undone.layers[0].text, 'one'); assert.ok(undone.assetIds.includes(asset.id));
  const redone = restored.history(d.id, OWNER, { baseRevision: 2, commandId: 'redo-1', direction: 'redo' }); assert.equal(redone.layers[0].text, 'changed');
  assert.deepEqual(restored.getAsset(asset.id, OWNER).bytes, PNG); assert.equal(restored.listRevisions(d.id, OWNER).length, 4);
  assert.throws(() => restored.getDocument(d.id, OTHER), e => e.status === 404);
  assert.throws(() => restored.getAsset(asset.id, OTHER), e => e.status === 404);
});
test('job receipt aliases, frozen input and checkpoints survive restart; public jobs exclude private state', t => {
  const f = fixture(t), d = f.store.createDocument(OWNER, {}), input = { operation: 'color_key', params: { tolerance: 10 } };
  const first = f.store.createJob(d.id, OWNER, { kind: 'operation', idempotencyKey: 'first', input }); input.params.tolerance = 999;
  const alias = f.store.createJob(d.id, OWNER, { kind: 'operation', idempotencyKey: 'lost-response', input: { operation: 'color_key', params: { tolerance: 10 } } }); assert.equal(alias.id, first.id);
  const asset = f.store.checkpointAsset(first.id, 'output', { name: 'out.png', mime: 'image/png' }, PNG);
  assert.equal(f.store.checkpointAsset(first.id, 'output', { name: 'out.png', mime: 'image/png' }, PNG).id, asset.id);
  f.store.updateJob(first.id, { state: 'running' }, { receipt: { apiKey: 'private-test-fixture' } });
  assert.equal(f.store.jobRecord(first.id).private.input.params.tolerance, 10);
  assert.throws(() => f.store.updateJob(first.id, {}, { input: { changed: true } }), /frozen/);
  const reopened = f.reopen(); assert.equal(reopened.getJob(first.id, OWNER).state, 'running');
  assert.equal(reopened.getJob(first.id, OWNER).operation, 'color_key');
  assert.ok(!JSON.stringify(reopened.getJob(first.id, OWNER)).includes('private-test-fixture'));
  assert.equal(reopened.jobRecord(first.id).private.checkpoints.output, asset.id);
  assert.throws(() => reopened.getJob(first.id, OTHER), e => e.status === 404);
  reopened.updateJob(first.id, { state: 'cancelled' }); assert.throws(() => reopened.checkpointAsset(first.id, 'late', { name: 'late.png', mime: 'image/png' }, PNG), /publish/);
});
test('branches merge only compatible edits, inherit immutable assets, and stay tenant isolated', t => {
  const f = fixture(t), d = f.store.createDocument(OWNER, { layers: [layer('a'),layer('b')] });
  const original = f.store.addAsset(d.id, OWNER, { name: 'base.png', mime: 'image/png' }, PNG);
  const branch = f.store.createBranch(d.id, OWNER, { baseRevision: 0 }); assert.ok(branch.assetIds.includes(original.id));
  f.store.command(branch.id, OWNER, { baseRevision: 0, commandId: 'candidate', commands: [{ type: 'layer.update', layerId: 'a', patch: { text: 'candidate' } }] });
  f.store.command(d.id, OWNER, { baseRevision: 0, commandId: 'human', commands: [{ type: 'layer.update', layerId: 'b', patch: { text: 'human' } }] });
  const accepted = f.store.acceptBranch(d.id, OWNER, { baseRevision: 1, branchDocumentId: branch.id, commandId: 'accept' }); assert.deepEqual(accepted.layers.map(l => l.text), ['candidate','human']);
  assert.equal(f.store.acceptBranch(d.id, OWNER, { baseRevision: 1, branchDocumentId: branch.id, commandId: 'accept' }).revision, 2);
  assert.throws(() => f.store.listBranches(d.id, OTHER), e => e.status === 404);
  const conflict = f.store.createBranch(d.id, OWNER, { baseRevision: 2 });
  f.store.command(conflict.id, OWNER, { baseRevision: 0, commandId: 'different', commands: [{ type: 'layer.remove', layerId: 'a' }] });
  f.store.command(d.id, OWNER, { baseRevision: 2, commandId: 'later', commands: [{ type: 'layer.update', layerId: 'a', patch: { text: 'new-human' } }] });
  assert.throws(() => f.store.acceptBranch(d.id, OWNER, { baseRevision: 3, branchDocumentId: conflict.id, commandId: 'reject' }), e => e.status === 409 && e.code === 'branch_conflict');
});
test('candidate checkpoints belong to the authorized job branch and only enter main when explicitly accepted', t => {
  const f = fixture(t), d = f.store.createDocument(OWNER, {}), asset = f.store.addAsset(d.id,OWNER,{name:'source.png',mime:'image/png'},PNG);
  const main = f.store.command(d.id,OWNER,{baseRevision:0,commandId:'source-layer',commands:[{type:'layer.add',layer:{id:'base',type:'raster',assetId:asset.id,width:1,height:1}}]});
  const branch = f.store.createBranch(d.id,OWNER,{baseRevision:1}), unrelated = f.store.createBranch(d.id,OWNER,{baseRevision:1}), foreign = f.store.createDocument(OTHER,{});
  const job = f.store.createJob(d.id,OWNER,{kind:'operation',idempotencyKey:'candidate',input:{operation:'flip'}});
  f.store.updateJob(job.id,{}, {branchDocumentId:branch.id});
  assert.throws(()=>f.store.checkpointAsset(job.id,'candidate',{name:'candidate.png',mime:'image/png'},PNG,unrelated.id),e=>e.code==='invalid_checkpoint_target');
  assert.throws(()=>f.store.checkpointAsset(job.id,'candidate',{name:'candidate.png',mime:'image/png'},PNG,foreign.id),e=>e.status===404);
  const candidate = f.store.checkpointAsset(job.id,'candidate',{name:'candidate.png',mime:'image/png',inputs:[{role:'base',assetId:asset.id}]},PNG,branch.id);
  assert.equal(candidate.documentId,branch.id);assert.deepEqual(f.store.getDocument(d.id,OWNER),main);
  assert.ok(f.store.getDocument(branch.id,OWNER).assetIds.includes(candidate.id));
  assert.equal(f.store.checkpointAsset(job.id,'candidate',{name:'candidate.png',mime:'image/png'},PNG,branch.id).id,candidate.id);
  f.store.command(branch.id,OWNER,{baseRevision:0,commandId:'candidate-layer',commands:[{type:'layer.update',layerId:'base',patch:{assetId:candidate.id}}]});
  const accepted = f.store.acceptBranch(d.id,OWNER,{baseRevision:1,branchDocumentId:branch.id,commandId:'accept'});
  assert.equal(accepted.layers[0].assetId,candidate.id);assert.ok(accepted.assetIds.includes(candidate.id));assert.deepEqual(f.reopen().getAsset(candidate.id,OWNER).bytes,PNG);
});
test('messages and runs persist semantic asset references without ordinal ids or foreign assets', t => {
  const f = fixture(t), d = f.store.createDocument(OWNER, { layers: [layer('text')] }), other = f.store.createDocument(OTHER, {});
  const asset = f.store.addAsset(d.id, OWNER, { name: 'base.png', mime: 'image/png' }, PNG), foreign = f.store.addAsset(other.id, OTHER, { name: 'other.png', mime: 'image/png' }, PNG);
  const conversation = f.store.createConversation(OWNER, { documentId: d.id });
  const message = { text: '只改这个字', role: 'user', references: [{ assetId: asset.id, layerId: 'text', revision: 0 }], idempotencyKey: 'message-1' };
  const saved = f.store.addMessage(conversation.id, OWNER, message); assert.equal(f.store.addMessage(conversation.id, OWNER, message).id, saved.id);
  assert.throws(() => f.store.addMessage(conversation.id, OWNER, { ...message, references: [{ assetId: foreign.id }], idempotencyKey: 'foreign' }));
  assert.throws(() => f.store.addMessage(conversation.id, OWNER, { text: 'ordinal', references: [{ id: 1 }] }));
  const run = f.store.createRun(conversation.id, OWNER, { idempotencyKey: 'run-1', message: message.text });
  f.store.updateRun(run.id, { state: 'complete', output: { assetId: asset.id } });
  const reopened = f.reopen(); assert.equal(reopened.getRun(run.id, OWNER).state, 'complete'); assert.equal(reopened.listMessages(conversation.id, OWNER).length, 1);
  assert.throws(() => reopened.getRun(run.id, OTHER), e => e.status === 404);
});
test('project import preserves historical views and undo head without importing executable jobs', t => {
  const f = fixture(t), source = f.store.createDocument(OWNER, { layers: [layer('a')] });
  f.store.command(source.id, OWNER, { baseRevision: 0, commandId: 'edit', commands: [{ type: 'layer.update', layerId: 'a', patch: { text: 'edited' } }] });
  f.store.history(source.id, OWNER, { baseRevision: 1, commandId: 'undo', direction: 'undo' });
  const revisions = f.store.listRevisions(source.id, OWNER), destination = f.store.createDocument(OWNER, {});
  f.store.importRevisions(destination.id, OWNER, { revisions, currentDocument: f.store.getDocument(source.id, OWNER) });
  assert.equal(f.store.listRevisions(destination.id, OWNER).length, 3);
  const redone = f.store.history(destination.id, OWNER, { baseRevision: 2, commandId: 'redo-imported', direction: 'redo' }); assert.equal(redone.layers[0].text, 'edited');
  assert.equal(f.store.listJobs(destination.id, OWNER).length, 0);
});
test('changed on-disk bytes are detected rather than served as the immutable asset', t => {
  const f = fixture(t), d = f.store.createDocument(OWNER, {}), asset = f.store.addAsset(d.id, OWNER, { name: 'base.png', mime: 'image/png' }, PNG);
  writeFileSync(join(f.directory, 'assets', asset.hash), Buffer.from('tampered'));
  assert.throws(() => f.store.getAsset(asset.id, OWNER), e => e.code === 'asset_corrupt');
});
test('a late candidate branch starts at the frozen historical revision rather than current edits', t => {
  const f = fixture(t), d = f.store.createDocument(OWNER, { layers: [layer('a','original')] });
  f.store.command(d.id, OWNER, { baseRevision: 0, commandId: 'human', commands: [{ type: 'layer.update', layerId: 'a', patch: { text: 'new-human' } }] });
  const branch = f.store.createBranch(d.id, OWNER, { baseRevision: 0 }); assert.equal(branch.layers[0].text,'original'); assert.equal(branch.baseRevision,0);
  assert.equal(f.store.getRevision(d.id, OWNER, 0).layers[0].text, 'original');
  assert.throws(() => f.store.getRevision(d.id, OTHER, 0), e => e.status === 404);
  assert.throws(() => f.store.getRevision(d.id, OWNER, 999), e => e.status === 404);
  f.store.command(branch.id, OWNER, { baseRevision: 0, commandId: 'operation', commands: [{ type: 'layer.update', layerId: 'a', patch: { text: 'candidate' } }] });
  assert.throws(() => f.store.acceptBranch(d.id, OWNER, { branchDocumentId: branch.id, baseRevision: 1, commandId:'accept' }), e => e.code === 'branch_conflict');
});
test('trusted import can preassign UUIDs but cannot replace an existing asset identity', t => {
  const f=fixture(t), d=f.store.createDocument(OWNER,{}), assignedId='33333333-3333-4333-8333-333333333333';
  const asset=f.store.addAsset(d.id,OWNER,{assignedId,name:'source.png',mime:'image/png'},PNG);assert.equal(asset.id,assignedId);
  assert.throws(()=>f.store.addAsset(d.id,OWNER,{assignedId,name:'overwrite.png',mime:'image/png'},PNG),e=>e.code==='asset_identity_conflict');
});
test('an owned image cannot be used as a font through document commands or history import', t => {
  const f=fixture(t), d=f.store.createDocument(OWNER,{}), image=f.store.addAsset(d.id,OWNER,{name:'image.png',mime:'image/png'},PNG);
  const invalid={...layer('text'),fontAssetId:image.id};
  assert.throws(()=>f.store.command(d.id,OWNER,{baseRevision:0,commandId:'image-as-font',commands:[{type:'layer.add',layer:invalid}]}),e=>e.code==='invalid_font_asset');
  assert.equal(f.store.getDocument(d.id,OWNER).revision,0);
  const snapshot={...f.store.getDocument(d.id,OWNER),layers:[invalid]};
  assert.throws(()=>f.store.importRevisions(d.id,OWNER,{revisions:[snapshot],currentDocument:snapshot}),e=>e.code==='invalid_font_asset');
});
test('real subset WOFF2 rejects missing glyph confirmation and changed text without silent fallback', t => {
  const f=fixture(t), d=f.store.createDocument(OWNER,{});
  const bytes=readFileSync(new URL('../../../public/fonts/source-han-sans.woff2',import.meta.url));
  const font=f.store.addAsset(d.id,OWNER,{name:'subset.woff2',mime:'font/woff2',metadata:{family:'forged family'}},bytes);
  assert.equal(font.metadata.family,'Noto Sans CJK SC');
  const add={type:'layer.add',layer:{...layer('text','中'),fontAssetId:font.id,metadata:{fontConfirmed:true}}};
  const confirmed=f.store.command(d.id,OWNER,{baseRevision:0,commandId:'known-glyph',commands:[add]});assert.equal(confirmed.revision,1);
  assert.throws(()=>f.store.command(d.id,OWNER,{baseRevision:1,commandId:'missing-glyph',commands:[{type:'layer.update',layerId:'text',patch:{text:'中文'}}]}),e=>e.code==='FONT_GLYPH_MISSING'&&e.status===422);
  assert.equal(f.store.getDocument(d.id,OWNER).layers[0].text,'中'); assert.equal(f.store.fontFaces.size,1);
  assert.throws(()=>f.store.createDocument(OTHER,{layers:[{...layer('foreign','中'),fontAssetId:font.id,metadata:{fontConfirmed:true}}],assetIds:[font.id]}),e=>e.status===404);
});
test('confirmed text needs a real font; unknown source patch may retain desired text with missing glyphs', t => {
  const f=fixture(t), d=f.store.createDocument(OWNER,{}), source=f.store.addAsset(d.id,OWNER,{name:'original.png',mime:'image/png'},PNG);
  assert.throws(()=>f.store.command(d.id,OWNER,{baseRevision:0,commandId:'no-font',commands:[{type:'layer.add',layer:{...layer('confirmed','中文'),metadata:{fontConfirmed:true}}}]}),e=>e.code==='FONT_ASSET_REQUIRED');
  const font=f.store.addAsset(d.id,OWNER,{name:'subset.woff2',mime:'font/woff2'},readFileSync(new URL('../../../public/fonts/source-han-sans.woff2',import.meta.url)));
  const unknown=f.store.command(d.id,OWNER,{baseRevision:0,commandId:'unknown',commands:[{type:'layer.add',layer:{...layer('original','中文'),assetId:source.id,fontAssetId:font.id,metadata:{fontConfirmed:false,desiredText:'中文',sourcePatchAssetId:source.id}}}]});
  assert.equal(unknown.layers[0].metadata.desiredText,'中文');
  assert.throws(()=>f.store.command(d.id,OWNER,{baseRevision:1,commandId:'bad-confirm',commands:[{type:'layer.update',layerId:'original',patch:{metadata:{fontConfirmed:true}}}]}),e=>e.code==='FONT_GLYPH_MISSING');
  assert.throws(()=>f.store.addAsset(d.id,OWNER,{name:'fake.otf',mime:'font/otf'},Buffer.from('OTTO-not-a-font')),e=>e.code==='invalid_font_asset');
});
test('full Noto face confirms CJK and controls, and rejected imported glyphs do not mutate the destination', t => {
  const f=fixture(t), d=f.store.createDocument(OWNER,{});
  const font=f.store.addAsset(d.id,OWNER,{name:'Noto.otf',mime:'font/otf'},readFileSync(new URL('../fonts/NotoSansCJKsc-Regular.otf',import.meta.url)));
  f.store.command(d.id,OWNER,{baseRevision:0,commandId:'full-cjk',commands:[{type:'layer.add',layer:{...layer('full','中文\nMAI\t'),fontAssetId:font.id,metadata:{fontConfirmed:true}}}]});
  const destination=f.store.createDocument(OWNER,{}), subset=f.store.addAsset(destination.id,OWNER,{name:'subset.woff2',mime:'font/woff2'},readFileSync(new URL('../../../public/fonts/source-han-sans.woff2',import.meta.url)));
  const snapshot={...f.store.getDocument(destination.id,OWNER),layers:[{...layer('bad','中文'),fontAssetId:subset.id,metadata:{fontConfirmed:true}}]};
  assert.throws(()=>f.store.importRevisions(destination.id,OWNER,{revisions:[snapshot],currentDocument:snapshot}),e=>e.code==='FONT_GLYPH_MISSING');
  assert.equal(f.store.getDocument(destination.id,OWNER).layers.length,0);
});
test('confirmed glyph metrics expand undersized boxes canonically without shrinking manual layout boxes', t => {
  const f=fixture(t), d=f.store.createDocument(OWNER,{}), font=f.store.addAsset(d.id,OWNER,{name:'Noto.otf',mime:'font/otf'},readFileSync(new URL('../fonts/NotoSansCJKsc-Regular.otf',import.meta.url)));
  const changed=f.store.command(d.id,OWNER,{baseRevision:0,commandId:'metrics',commands:[{type:'layer.add',layer:{...layer('long','长中文标题\n第二行'),width:1,height:1,fontAssetId:font.id,metadata:{fontConfirmed:true}}},{type:'layer.add',layer:{...layer('manual','中'),width:500,height:400,fontAssetId:font.id,metadata:{fontConfirmed:true}}}]});
  assert.equal(changed.layers[0].fontSize,24);assert.ok(changed.layers[0].width>=120);assert.ok(changed.layers[0].height>=58);
  assert.deepEqual([changed.layers[1].width,changed.layers[1].height],[500,400]);
  assert.equal(f.store.listRevisions(d.id,OWNER).at(-1).layers[0].width,changed.layers[0].width);
  f.store.history(d.id,OWNER,{baseRevision:1,commandId:'undo-metrics',direction:'undo'});
  const redo=f.store.history(d.id,OWNER,{baseRevision:2,commandId:'redo-metrics',direction:'redo'});assert.equal(redo.layers[0].width,changed.layers[0].width);
  assert.throws(()=>f.store.command(d.id,OWNER,{baseRevision:3,commandId:'oversized-text',commands:[{type:'layer.update',layerId:'long',patch:{text:'W'.repeat(400),fontSize:32768,tracking:32768}}]}),e=>e.code==='FONT_LAYOUT_TOO_LARGE');
  assert.equal(f.store.getDocument(d.id,OWNER).revision,3);assert.equal(f.store.getDocument(d.id,OWNER).layers[0].width,changed.layers[0].width);
});
test('unknown source text retains pixels and desiredText while confirmation requires a correctly sourced raster background', async t => {
  const f=fixture(t),d=f.store.createDocument(OWNER,{width:320,height:100});
  const pixelImage=async(width,height,glyph=false)=>{
    const data=Buffer.alloc(width*height*4,255);
    if(glyph)for(let y=3;y<height-3;y++)for(let x=8;x<12;x++)data.set([0,0,0,255],(y*width+x)*4);
    return encodePNG({width,height,data});
  };
  const sourceBytes=await pixelImage(32,20,true),source=f.store.addAsset(d.id,OWNER,{name:'source.png',mime:'image/png'},sourceBytes);
  const font=f.store.addAsset(d.id,OWNER,{name:'Noto.otf',mime:'font/otf'},readFileSync(new URL('../fonts/NotoSansCJKsc-Regular.otf',import.meta.url)));
  const metadata={role:'sourcePatch',fontStatus:'unknown',fontConfirmed:false,sourcePatchAssetId:source.id};
  f.store.command(d.id,OWNER,{baseRevision:0,commandId:'patch',commands:[{type:'layer.add',layer:{...layer('patch','中'),assetId:source.id,width:32,height:20,x:12,y:8,metadata}}]});
  const pending=f.store.command(d.id,OWNER,{baseRevision:1,commandId:'desired',commands:[{type:'layer.update',layerId:'patch',patch:{metadata:{...metadata,desiredText:'新中文'}}}]});
  assert.equal(pending.layers[0].text,'中');assert.equal(pending.layers[0].assetId,source.id);assert.equal(pending.layers[0].metadata.desiredText,'新中文');
  const attempt=(id,patch)=>f.store.command(d.id,OWNER,{baseRevision:2,commandId:id,commands:[{type:'layer.update',layerId:'patch',patch}]});
  assert.throws(()=>attempt('text-before-confirm',{text:'新中文'}),e=>e.code==='FONT_CONFIRMATION_REQUIRED');
  const confirmed=(extra={})=>({text:'新中文',fontAssetId:font.id,metadata:{...metadata,fontConfirmed:true,...extra}});
  assert.throws(()=>attempt('confirm-before-clean',confirmed()),e=>e.code==='TEXT_BACKGROUND_REQUIRED');
  assert.throws(()=>attempt('drop-source-before-clean',{...confirmed(),assetId:null}),e=>e.code==='TEXT_BACKGROUND_REQUIRED');
  assert.throws(()=>attempt('font-as-background',confirmed({cleanBackgroundAssetId:font.id})),e=>e.code==='TEXT_BACKGROUND_REQUIRED');
  const wrongSize=f.store.addAsset(d.id,OWNER,{name:'wrong.png',mime:'image/png',inputs:[{role:'base',assetId:source.id}]},await pixelImage(16,10));
  assert.throws(()=>attempt('wrong-background-size',confirmed({cleanBackgroundAssetId:wrongSize.id})),e=>e.code==='TEXT_BACKGROUND_REQUIRED');
  const unrelated=f.store.addAsset(d.id,OWNER,{name:'unrelated.png',mime:'image/png'},await pixelImage(32,20));
  assert.throws(()=>attempt('unrelated-background',confirmed({cleanBackgroundAssetId:unrelated.id})),e=>e.code==='TEXT_BACKGROUND_REQUIRED');
  const other=f.store.createDocument(OWNER,{}),foreignProject=f.store.addAsset(other.id,OWNER,{name:'other.png',mime:'image/png',inputs:[{role:'base',assetId:source.id}]},await pixelImage(32,20));
  assert.throws(()=>attempt('other-project-background',confirmed({cleanBackgroundAssetId:foreignProject.id})),e=>e.code==='TEXT_BACKGROUND_REQUIRED');
  const clean=f.store.addAsset(d.id,OWNER,{name:'clean.png',mime:'image/png',inputs:[{role:'base',assetId:source.id}],metadata:{role:'text_background'}},await pixelImage(32,20));
  assert.throws(()=>attempt('missing-detached-layer',confirmed({cleanBackgroundAssetId:clean.id,backgroundDetached:true,backgroundLayerId:'absent'})),e=>e.code==='TEXT_BACKGROUND_REQUIRED');
  const done=f.store.command(d.id,OWNER,{baseRevision:2,commandId:'confirm-with-clean-background',commands:[
    {type:'layer.add',layer:{id:'background',type:'raster',assetId:clean.id,x:12,y:8,width:32,height:20,z:-1}},
    {type:'layer.update',layerId:'patch',patch:confirmed({cleanBackgroundAssetId:clean.id,backgroundDetached:true,backgroundLayerId:'background'})}
  ]});
  assert.equal(done.layers.find(item=>item.id==='patch').text,'新中文');assert.equal(done.layers.find(item=>item.id==='patch').metadata.fontConfirmed,true);
  const moved=f.store.command(d.id,OWNER,{baseRevision:3,commandId:'move-confirmed-text',commands:[{type:'layer.update',layerId:'patch',patch:{x:150,text:'再次修改中文'}}]});
  assert.equal(moved.layers.find(item=>item.id==='background').x,12);assert.equal(moved.layers.find(item=>item.id==='patch').x,150);
  assert.ok(f.store.getAsset(source.id,OWNER).bytes.equals(sourceBytes));
});
test('source text background validation also protects imported history and detached branch acceptance', async t => {
  const f=fixture(t),d=f.store.createDocument(OWNER,{}),source=f.store.addAsset(d.id,OWNER,{name:'source.png',mime:'image/png'},PNG);
  const font=f.store.addAsset(d.id,OWNER,{name:'Noto.otf',mime:'font/otf'},readFileSync(new URL('../fonts/NotoSansCJKsc-Regular.otf',import.meta.url)));
  const original={...layer('source-text','中'),assetId:source.id,metadata:{role:'sourcePatch',fontConfirmed:false,sourcePatchAssetId:source.id}};
  f.store.command(d.id,OWNER,{baseRevision:0,commandId:'source',commands:[{type:'layer.add',layer:original}]});
  const snapshot={...f.store.getDocument(d.id,OWNER),layers:[{...original,fontAssetId:font.id,metadata:{...original.metadata,fontConfirmed:true}}]};
  const destination=f.store.createDocument(OWNER,{assetIds:snapshot.assetIds});
  assert.throws(()=>f.store.importRevisions(destination.id,OWNER,{revisions:[{...snapshot,id:destination.id,revision:0}],currentDocument:{...snapshot,id:destination.id,revision:0}}),e=>e.code==='TEXT_BACKGROUND_REQUIRED');
  assert.equal(f.store.getDocument(destination.id,OWNER).layers.length,0);assert.equal(f.store.listRevisions(destination.id,OWNER).length,1);
  const branch=f.store.createBranch(d.id,OWNER,{baseRevision:1}),clean=f.store.addAsset(branch.id,OWNER,{name:'clean.png',mime:'image/png',inputs:[{role:'base',assetId:source.id}]},PNG);
  const changed=f.store.command(branch.id,OWNER,{baseRevision:0,commandId:'confirmed-candidate',commands:[
    {type:'layer.add',layer:{id:'background',type:'raster',assetId:clean.id}},
    {type:'layer.update',layerId:'source-text',patch:{fontAssetId:font.id,text:'新中文',metadata:{...original.metadata,fontConfirmed:true,cleanBackgroundAssetId:clean.id,backgroundDetached:true,backgroundLayerId:'background'}}}
  ]});
  assert.equal(changed.layers.find(item=>item.id==='source-text').metadata.fontConfirmed,true);assert.equal(f.store.getDocument(d.id,OWNER).layers[0].metadata.fontConfirmed,false);
  const accepted=f.store.acceptBranch(d.id,OWNER,{baseRevision:1,commandId:'accept',branchDocumentId:branch.id});
  assert.equal(accepted.layers.find(item=>item.id==='source-text').text,'新中文');assert.ok(accepted.assetIds.includes(clean.id));
  assert.throws(()=>f.store.command(d.id,OWNER,{baseRevision:accepted.revision,commandId:'delete-used-background',commands:[{type:'layer.remove',layerId:'background'}]}),e=>e.code==='TEXT_BACKGROUND_REQUIRED');
  assert.equal(f.store.getDocument(d.id,OWNER).revision,accepted.revision);
});
