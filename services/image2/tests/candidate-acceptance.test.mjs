import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ImageStore} from '../store.mjs';
import {ImageRunner} from '../jobs.mjs';
import {encodePNG,decodeRGBA} from '../processors.mjs';

const OWNER='11111111-1111-4111-8111-111111111111';
const config={imageBaseUrl:'',imageApiKey:'',comfyBaseUrl:'',comfyToken:'',ocrUrl:'',ocrToken:'',agent:{baseUrl:'https://candidate.fixture.invalid',apiKey:'synthetic-key',models:['stub'],timeoutMs:1000}};
function fixture(t){const directory=mkdtempSync(join(tmpdir(),'image2-candidate-acceptance-')),store=new ImageStore(directory),runner=new ImageRunner({store,config,fetchImpl:async()=>{throw Error('No real providers are permitted');}});t.after(async()=>{await runner.stop();store.close();rmSync(directory,{recursive:true,force:true});});return {store,runner};}
async function candidate(f,{schemaVersion=3,agent=true}={}){
  const main=f.store.createDocument(OWNER,{schemaVersion,name:'Main source',width:16,height:12}),bytes=await encodePNG({width:4,height:3,data:Buffer.alloc(4*3*4,255)}),asset=f.store.addAsset(main.id,OWNER,{name:'source.png',mime:'image/png'},bytes);
  const commands=schemaVersion===3?[{type:'content.add',content:{id:'source',kind:'raster',assetId:asset.id,formatVersion:1}},{type:'layer.add',layer:{id:'base',type:'raster',contentId:'source',localBounds:{x:0,y:0,width:4,height:3}}}]:[{type:'layer.add',layer:{id:'base',type:'raster',assetId:asset.id,width:4,height:3}}];
  const document=f.store.command(main.id,OWNER,{baseRevision:0,commandId:'source',commands});let branch,job;
  if(agent){const conversation=f.store.createConversation(OWNER,{documentId:document.id}),submitted=await f.runner.submitRun(OWNER,conversation.id,{text:'合成候选接受测试',idempotencyKey:'run'});job=submitted.job;branch=f.store.getDocument(submitted.run.branchDocumentId,OWNER);}
  else branch=f.store.createBranch(document.id,OWNER,{baseRevision:document.revision});
  branch=f.store.command(branch.id,OWNER,{baseRevision:0,commandId:'candidate-r1',commands:[{type:'document.update',patch:{name:'Candidate r1'}}]});
  branch=f.store.command(branch.id,OWNER,{baseRevision:1,commandId:'candidate-r2',commands:[{type:'document.update',patch:{name:'Candidate r2'}}]});
  if(job){f.store.updateJob(job.id,{state:'running'});const preview=await f.runner.exportInline(job.id,branch.id,OWNER,'png','agent_preview');f.store.updateJob(job.id,{state:'complete',output:{branchDocumentId:branch.id,revision:branch.revision,previewRevision:branch.revision,previewAssetId:preview.assetId,assetIds:[preview.assetId]}});branch=f.store.getDocument(branch.id,OWNER);}
  return {document,branch,job,asset,bytes};
}
const accept=(f,c,extra={})=>f.store.acceptBranch(c.document.id,OWNER,{baseRevision:c.document.revision,branchDocumentId:c.branch.id,branchRevision:c.branch.revision,commandId:'accept',...extra});

test('r2 preview acceptance races with a committed r3 branch edit and cannot change main or leave a receipt',async t=>{
  const f=fixture(t),c=await candidate(f),seenRevision=c.branch.revision;assert.equal(seenRevision,2);
  f.store.command(c.branch.id,OWNER,{baseRevision:seenRevision,commandId:'later-r3',commands:[{type:'document.update',patch:{name:'Unseen candidate r3'}}]});
  assert.throws(()=>accept(f,c),error=>error.status===409&&error.code==='candidate_revision_conflict');assert.deepEqual(f.store.getDocument(c.document.id,OWNER),c.document);assert.equal(f.store.getDocument(c.branch.id,OWNER).revision,3);assert.throws(()=>f.store.getCommandReceipt(c.document.id,OWNER,'accept'),error=>error.status===404);assert.equal(f.store.listBranches(c.document.id,OWNER).length,1);
  assert.throws(()=>accept(f,c,{branchRevision:3,commandId:'bypass-client-refresh'}),error=>error.status===409&&error.code==='candidate_preview_stale');assert.deepEqual(f.store.getDocument(c.document.id,OWNER),c.document);
});

test('fresh v3 Agent preview accepts only its exact branch version and receipt replay stays idempotent',async t=>{
  const f=fixture(t),c=await candidate(f),accepted=accept(f,c);assert.equal(accepted.name,'Candidate r2');assert.equal(accepted.revision,2);assert.deepEqual(f.store.listBranches(c.document.id,OWNER),[]);assert.equal(accept(f,c).revision,accepted.revision);
  f.store.command(c.branch.id,OWNER,{baseRevision:2,commandId:'post-accept-branch-edit',commands:[{type:'document.update',patch:{name:'Never reapply'}}]});assert.equal(accept(f,c).name,'Candidate r2');assert.equal(f.store.getDocument(c.document.id,OWNER).revision,2);
});

for(const badRevision of [undefined,null,'2',1.5,-1])test(`v3 Agent requires a concrete nonnegative branchRevision (${String(badRevision)})`,async t=>{
  const f=fixture(t),c=await candidate(f);assert.throws(()=>accept(f,c,{branchRevision:badRevision}),error=>error.status===409&&error.code==='candidate_revision_required');assert.deepEqual(f.store.getDocument(c.document.id,OWNER),c.document);
});

for(const change of [{previewAssetId:undefined},{previewRevision:undefined},{previewUnavailable:'RENDER_BUDGET'},{previewStale:true},{previewRevision:1},{revision:1}])test(`v3 Agent cannot bypass a missing/stale preview ${JSON.stringify(change)}`,async t=>{
  const f=fixture(t),c=await candidate(f),output=f.store.getJob(c.job.id,OWNER).output;f.store.updateJob(c.job.id,{output:{...output,...change}});assert.throws(()=>accept(f,c),error=>error.status===409&&['candidate_preview_required','candidate_preview_stale'].includes(error.code));assert.deepEqual(f.store.getDocument(c.document.id,OWNER),c.document);
});

test('preview claim must reference actual registered PNG export bytes from this branch and revision',async t=>{
  const f=fixture(t),c=await candidate(f),original=f.store.getJob(c.job.id,OWNER).output;
  f.store.updateJob(c.job.id,{output:{...original,previewAssetId:c.asset.id}});assert.throws(()=>accept(f,c),error=>error.code==='candidate_preview_required');
  const falsePreview=f.store.addAsset(c.branch.id,OWNER,{name:'lookalike.png',mime:'image/png',metadata:{role:'export',format:'png',sourceDocumentId:c.branch.id,sourceRevision:1}},c.bytes);f.store.updateJob(c.job.id,{output:{...original,previewAssetId:falsePreview.id}});assert.throws(()=>accept(f,c),error=>error.code==='candidate_preview_required');assert.deepEqual(f.store.getDocument(c.document.id,OWNER),c.document);
});

for(const schemaVersion of [2,3])test(`old non-Agent schema${schemaVersion} manual candidates remain compatible without a branchRevision`,async t=>{
  const f=fixture(t),c=await candidate(f,{schemaVersion,agent:false});const request={baseRevision:c.document.revision,branchDocumentId:c.branch.id,commandId:'legacy-manual'};assert.equal(f.store.acceptBranch(c.document.id,OWNER,request).name,'Candidate r2');
});

test('explicit stale revision is rejected for manual candidates while the omitted old request stays compatible',async t=>{
  const f=fixture(t),c=await candidate(f,{agent:false});assert.throws(()=>accept(f,c,{branchRevision:1}),error=>error.code==='candidate_revision_conflict');assert.deepEqual(f.store.getDocument(c.document.id,OWNER),c.document);assert.equal(accept(f,c).name,'Candidate r2');
});

test('empty v3 Agent candidates have an actual transparent PNG at the accepted revision',async t=>{
  const f=fixture(t),document=f.store.createDocument(OWNER,{schemaVersion:3,name:'Empty source',width:24,height:16}),conversation=f.store.createConversation(OWNER,{documentId:document.id}),submitted=await f.runner.submitRun(OWNER,conversation.id,{text:'保留空作品',idempotencyKey:'empty'});
  f.runner.fetchImpl=async()=>Response.json({choices:[{message:{role:'assistant',content:'空候选已保存。'}}]});
  f.runner.start();const until=Date.now()+60000;let done;
  while(Date.now()<until){done=f.store.getJob(submitted.job.id,OWNER);if(['complete','failed','uncertain','cancelled'].includes(done.state))break;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.equal(done.state,'complete',done.error);assert.ok(done.output.previewAssetId);assert.equal(done.output.previewRevision,0);const preview=f.store.getAsset(done.output.previewAssetId,OWNER),raw=await decodeRGBA(preview.bytes,'image/png');assert.deepEqual([raw.width,raw.height],[24,16]);assert.ok(raw.data.every(value=>value===0));
  const accepted=f.store.acceptBranch(document.id,OWNER,{baseRevision:0,branchDocumentId:submitted.run.branchDocumentId,branchRevision:0,commandId:'accept-empty'});assert.equal(accepted.revision,0);assert.equal(accepted.layers.length,0);assert.deepEqual(f.store.listBranches(document.id,OWNER),[]);
});
