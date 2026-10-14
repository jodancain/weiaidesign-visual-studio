import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { ImageStore } from '../store.mjs';
import { ImageRunner } from '../jobs.mjs';
import { CraftService } from '../craft-service.mjs';
import { digest } from '../domain.mjs';
import { encodePNG } from '../processors.mjs';
import { freezeCraftPackage } from '../craft-package.mjs';

const OWNER='11111111-1111-4111-8111-111111111111',OTHER='22222222-2222-4222-8222-222222222222';
function fixture(t,schemaVersion=2){
  const directory=mkdtempSync(join(tmpdir(),'craft-package-')),store=new ImageStore(directory);let calls=0;
  const runtime={get calls(){return calls;},async capabilities(){return [{id:'photocraft',name:'Photo fixture',available:true}];},async execute({engineId,workDir,nativeFile}){calls++;const before=nativeFile?JSON.parse(Buffer.from(JSON.parse(gunzipSync(readFileSync(nativeFile))).files[0].data,'base64')).edits:0,state={edits:before+1},bytes=Buffer.from(JSON.stringify(state));return {state,result:state,checkpoint:{name:'project.craftbundle',mime:'application/octet-stream',bytes:gzipSync(Buffer.from(JSON.stringify({version:1,engineId,workDir,files:[{path:'native/photo.native',data:bytes.toString('base64'),sha256:digest(bytes)}]})))},files:[{name:'result.png',mime:'image/png',role:'export',bytes:await encodePNG({width:1,height:1,data:Buffer.from([state.edits,20,30,255])})}],receipt:{processor:'native-package-fixture'}};}};
  const craft=new CraftService({store,runtime}),runner=new ImageRunner({store,config:{imageBaseUrl:'',imageApiKey:'',comfyBaseUrl:'',ocrUrl:'',agent:{baseUrl:'',apiKey:''}},fetchImpl:async()=>{throw Error('External calls forbidden');}});runner.craft=craft;craft.start();
  const doc=store.createDocument(OWNER,{schemaVersion,width:16,height:16,name:`Package v${schemaVersion}`});
  t.after(async()=>{await runner.stop();await craft.stop();store.close();rmSync(directory,{recursive:true,force:true});});return {store,craft,runner,runtime,doc};
}
async function nativeDone(f,doc,owner,job){const until=Date.now()+10000;while(Date.now()<until){const current=f.craft.getJob(doc.id,owner,job.id);if(['complete','failed','cancelled'].includes(current.state)){assert.equal(current.state,'complete',current.error);return current;}await new Promise(r=>setTimeout(r,10));}throw Error('native fixture timeout');}
async function edit(f,doc,owner,project,key){const job=await nativeDone(f,doc,owner,await f.craft.submit(doc.id,owner,{projectId:project.id,baseRevision:project.revision,steps:[{command:'edit',args:{}}],inputAssetIds:[],idempotencyKey:key}));return {job,project:f.craft.accept(doc.id,owner,job.id,{baseRevision:project.revision,idempotencyKey:`accept:${key}`})};}
async function archive(f,job,owner=OWNER){await f.runner.execute(job.id);const result=f.store.getJob(job.id,owner);assert.equal(result.state,'complete',result.error);return f.store.getAsset(result.output.assetId,owner).bytes;}
const unpack=bytes=>{const files=unzipSync(bytes);return {files,manifest:JSON.parse(strFromU8(files['manifest.json']))};};
const mutate=(bytes,change)=>{const {files,manifest}=unpack(bytes);change(manifest,files);files['manifest.json']=strToU8(JSON.stringify(manifest));return Buffer.from(zipSync(files));};

for(const schemaVersion of [2,3])test(`v${schemaVersion} package freezes all native history and imports into a new owner without replay`,async t=>{
  const f=fixture(t,schemaVersion),p=await f.craft.createProject(f.doc.id,OWNER,{engineId:'photocraft',name:'Native Photo',idempotencyKey:'create'}),first=await edit(f,f.doc,OWNER,p,'first'),second=await edit(f,f.doc,OWNER,first.project,'second');
  const metadata={craftProjectId:p.id,craftJobId:second.job.id,craftOutputAssetId:second.job.output.assetIds[0],craftRevision:2};
  const layer={id:'native-reference',type:'group',metadata,...(schemaVersion===3?{localBounds:{x:0,y:0,width:16,height:16}}:{x:0,y:0,width:16,height:16})};
  const doc=f.store.command(f.doc.id,OWNER,{baseRevision:0,commandId:'link',commands:[{type:'layer.add',layer}]});await f.craft.stop();
  const pending=await f.craft.submit(doc.id,OWNER,{projectId:p.id,baseRevision:2,steps:[{command:'edit',args:{}}],inputAssetIds:[],idempotencyKey:'pending'});
  const frozenJob=await f.runner.export(OWNER,{documentId:doc.id,baseRevision:doc.revision,format:'project',idempotencyKey:'frozen-export'});f.craft.cancel(doc.id,OWNER,pending.id);f.craft.start();const third=await edit(f,doc,OWNER,second.project,'later');assert.equal(third.project.revision,3);
  const bytes=await archive(f,frozenJob),{manifest}=unpack(bytes),native=manifest.craft;
  assert.equal(native.projects[0].project.revision,2);assert.deepEqual(native.projects[0].revisions.map(r=>r.revision),[0,1,2]);assert.equal(native.sourceReceipts.find(r=>r.id===pending.id).source.state,'queued');assert.ok(manifest.assets.some(a=>a.id===first.job.output.assetIds[0]&&a.metadata.role==='export'));assert.ok(!manifest.assets.some(a=>a.id===third.project.nativeAssetId));
  const calls=f.runtime.calls,imported=await f.runner.importProject(OTHER,{data:bytes.toString('base64')}),projects=f.craft.listProjects(imported.id,OTHER),copied=projects[0];assert.equal(f.runtime.calls,calls);assert.equal(copied.revision,2);assert.notEqual(copied.id,p.id);assert.notEqual(copied.nativeAssetId,second.project.nativeAssetId);assert.deepEqual(f.store.getAsset(copied.nativeAssetId,OTHER).bytes,f.store.getAsset(second.project.nativeAssetId,OWNER).bytes);
  const history=f.craft.listRevisions(imported.id,OTHER,copied.id);assert.deepEqual(history.map(r=>r.revision),[2,1,0]);assert.ok(history.every(r=>r.documentId===imported.id&&r.importedSource.projectId===p.id));
  const archived=f.craft.listJobs(imported.id,OTHER),pendingCopy=archived.find(j=>j.importedSource.jobId===pending.id);assert.equal(pendingCopy.state,'cancelled');assert.equal(pendingCopy.importedSource.state,'queued');await assert.rejects(f.craft.retry(imported.id,OTHER,pendingCopy.id,{idempotencyKey:'no-replay'}),e=>e.code==='craft_imported_receipt');
  const accepted=f.craft.projectView(imported.id,OTHER,copied.id);assert.equal(accepted.latestOutput.sourceDocumentId,imported.id);assert.equal(imported.layers[0].metadata.craftProjectId,copied.id);assert.equal(imported.layers[0].metadata.craftJobId,copied.lastJobId);assert.equal(imported.layers[0].metadata.craftOutputAssetId,copied.assetIds[0]);assert.equal(imported.metadata.craftImport.projectIds[p.id],copied.id);
  for(const assetId of imported.assetIds){const asset=f.store.getAsset(assetId,OTHER).asset;assert.equal(asset.documentId,imported.id);assert.ok((asset.inputs||[]).every(ref=>imported.assetIds.includes(ref.assetId)));assert.throws(()=>f.store.getAsset(assetId,OWNER));}assert.throws(()=>f.craft.project(doc.id,OTHER,p.id));
  const continued=await edit(f,imported,OTHER,copied,'continue');assert.equal(continued.job.output.state.edits,3);
  const restore=f.craft.restoreRevision(imported.id,OTHER,{projectId:copied.id,revision:1,baseRevision:3,idempotencyKey:'restore-one'});f.craft.accept(imported.id,OTHER,restore.id,{baseRevision:3,idempotencyKey:'accept-restore'});const final=await edit(f,imported,OTHER,f.craft.project(imported.id,OTHER,copied.id),'after-restore');assert.equal(final.job.output.state.edits,2);
  // The imported provenance is itself portable, including archived receipts and newly authored revisions.
  const again=await f.runner.export(OTHER,{documentId:imported.id,baseRevision:imported.revision,format:'project',idempotencyKey:'second-export'}),roundtrip=await f.runner.importProject(OWNER,{data:(await archive(f,again,OTHER)).toString('base64')});assert.equal(f.craft.listProjects(roundtrip.id,OWNER)[0].revision,5);
});

for(const schemaVersion of [2,3])test(`v${schemaVersion} rejects missing, forged and out-of-package native references atomically`,async t=>{
  const f=fixture(t,schemaVersion),p=await f.craft.createProject(f.doc.id,OWNER,{engineId:'photocraft',idempotencyKey:'create'}),first=await edit(f,f.doc,OWNER,p,'first'),job=await f.runner.export(OWNER,{documentId:f.doc.id,baseRevision:0,format:'project',idempotencyKey:'export'}),bytes=await archive(f,job),count=f.store.listDocuments(OTHER).length;
  const badCases=[m=>{m.craft.projects[0].project.nativeAssetId='outside';},m=>{m.craft.projects[0].revisions[1].nativeAssetId='outside';},m=>{m.craft.sourceReceipts[0].output.assetIds=['outside'];},m=>{m.craft.assetIds=m.craft.assetIds.filter(id=>id!==first.project.nativeAssetId);},(m,files)=>{const asset=m.assets.find(a=>a.id===first.project.nativeAssetId),bundle=JSON.parse(gunzipSync(files[asset.file]));bundle.files[0].path='../escape';files[asset.file]=gzipSync(Buffer.from(JSON.stringify(bundle)));asset.hash=digest(files[asset.file]);},m=>{m.craft.projects.push(cloneRecord(m.craft.projects[0]));}];
  for(const change of badCases){await assert.rejects(f.runner.importProject(OTHER,{data:mutate(bytes,change).toString('base64')}));assert.equal(f.store.listDocuments(OTHER).length,count);}
  assert.throws(()=>freezeCraftPackage(f.store,f.doc.id,OTHER));
});
function cloneRecord(value){return JSON.parse(JSON.stringify(value));}

test('promoted Agent native history closes over branch-only checkpoint inputs',async t=>{
  const f=fixture(t),p=await f.craft.createProject(f.doc.id,OWNER,{engineId:'photocraft',idempotencyKey:'create'}),first=await edit(f,f.doc,OWNER,p,'base'),branch=f.store.createBranch(f.doc.id,OWNER,{baseRevision:0}),runner={cancelled:()=>false};
  await f.craft.executeAgent(runner,'agent',branch.id,OWNER,{projectId:p.id,steps:[{command:'edit',args:{}}]},'one');await f.craft.executeAgent(runner,'agent',branch.id,OWNER,{projectId:p.id,steps:[{command:'edit',args:{}}]},'two');f.store.acceptBranch(f.doc.id,OWNER,{baseRevision:0,branchDocumentId:branch.id,commandId:'accept'});
  const doc=f.store.getDocument(f.doc.id,OWNER),job=await f.runner.export(OWNER,{documentId:doc.id,baseRevision:doc.revision,format:'project',idempotencyKey:'export'}),bytes=await archive(f,job),copy=await f.runner.importProject(OTHER,{data:bytes.toString('base64')}),project=f.craft.listProjects(copy.id,OTHER)[0];assert.equal(project.revision,2);const edited=await edit(f,copy,OTHER,project,'continue');assert.equal(edited.job.output.state.edits,4);assert.ok(unpack(bytes).manifest.assets.length>first.job.output.assetIds.length);
});

test('Agent enqueue freezes native checkpoints before main advances while the task waits',async t=>{
  const f=fixture(t),p=await f.craft.createProject(f.doc.id,OWNER,{engineId:'photocraft',idempotencyKey:'create'}),first=await edit(f,f.doc,OWNER,p,'one');let context;
  f.runner.config.agent={...f.runner.config.agent,baseUrl:'https://queue.fixture.invalid/v1',apiKey:'synthetic',models:['fixture']};f.runner.fetchImpl=async(url,init)=>{assert.match(String(url),/queue.fixture.invalid/);const body=JSON.parse(init.body),message=body.messages.find(m=>m.role==='system'&&m.content.startsWith('Current authoritative'));context=JSON.parse(message.content.slice(message.content.indexOf(': ')+2));return Response.json({choices:[{message:{role:'assistant',content:'只读检查完成'}}]});};
  const conversation=f.store.createConversation(OWNER,{documentId:f.doc.id}),run=await f.runner.submitRun(OWNER,conversation.id,{text:'查看当前原生工程',idempotencyKey:'queued-agent'}),branchId=run.run.branchDocumentId;
  const initial=f.craft.listProjects(branchId,OWNER)[0];assert.equal(initial.parentProjectRevision,1);assert.equal(initial.nativeAssetId,first.project.nativeAssetId);assert.ok(f.store.getDocument(branchId,OWNER).assetIds.includes(initial.nativeAssetId));
  const second=await edit(f,f.doc,OWNER,first.project,'two');assert.equal(second.project.revision,2);await f.runner.execute(run.job.id);const completed=f.store.getJob(run.job.id,OWNER);assert.equal(completed.state,'complete',completed.error);assert.equal(context.craftProjects[0].parentProjectRevision,1);assert.equal(context.craftProjects[0].nativeAssetId,first.project.nativeAssetId);assert.notEqual(context.craftProjects[0].nativeAssetId,second.project.nativeAssetId);
});

for(const schemaVersion of [2,3])test(`v${schemaVersion} whole candidate acceptance cannot promote native edits made after Agent preview`,async t=>{
  const f=fixture(t,schemaVersion);let calls=0;f.runner.config.agent={...f.runner.config.agent,baseUrl:'https://candidate.fixture.invalid/v1',apiKey:'synthetic',models:['fixture']};
  f.runner.fetchImpl=async()=>Response.json({choices:[{message:++calls===1?{role:'assistant',tool_calls:[{id:'native',type:'function',function:{name:'craft_execute',arguments:JSON.stringify({engineId:'photocraft',steps:[{command:'edit',args:{}}]})}}]}:{role:'assistant',content:'候选已完成'}}]});
  const conversation=f.store.createConversation(OWNER,{documentId:f.doc.id}),run=await f.runner.submitRun(OWNER,conversation.id,{text:'创建原生候选',idempotencyKey:'native-agent'});await f.runner.execute(run.job.id);const completed=f.store.getJob(run.job.id,OWNER);assert.equal(completed.state,'complete',completed.error);const branch=f.store.getDocument(completed.output.branchDocumentId,OWNER),reviewed=completed.output.craftProjects[0];assert.equal(reviewed.revision,1);
  const changed=await edit(f,branch,OWNER,reviewed,'unreviewed');assert.equal(changed.project.revision,2);assert.equal(f.store.getDocument(branch.id,OWNER).revision,branch.revision);
  assert.throws(()=>f.store.acceptBranch(f.doc.id,OWNER,{baseRevision:f.doc.revision,branchDocumentId:branch.id,branchRevision:branch.revision,commandId:'must-not-promote'}),e=>e.code==='craft_candidate_stale');assert.equal(f.craft.listProjects(f.doc.id,OWNER).length,0);assert.equal(f.store.getDocument(f.doc.id,OWNER).revision,f.doc.revision);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM branch_acceptances WHERE branch_document_id=?').get(branch.id).n,0);
});
