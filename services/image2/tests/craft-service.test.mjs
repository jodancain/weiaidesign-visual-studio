import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {gzipSync,gunzipSync} from 'node:zlib';
import {digest} from '../domain.mjs';
import { ImageStore } from '../store.mjs';
import { CraftService } from '../craft-service.mjs';
import { createImageService } from '../server.mjs';
import { buildAgentTools } from '../agent-control.mjs';
import { encodePNG } from '../processors.mjs';

const OWNER='11111111-1111-4111-8111-111111111111',OTHER='22222222-2222-4222-8222-222222222222';
const ENGINES=['photocraft','vectorcraft','filmcraft','lightcraft','pdfcraft','effectcraft','designcraft','figcraft','wordcraft','soundcraft','deckcraft','cadcraft','gridcraft'];
const caps=ENGINES.map(id=>({id,name:id,available:true,nativeExtension:'.native',commands:[{id:'new',inputSchema:{type:'object'}},{id:'edit',inputSchema:{type:'object'}}],tools:[]}));
function fakeRuntime({delay=0,onExecute=()=>{}}={}) {
  let calls=0;
  return {get calls(){return calls;},async capabilities(){return caps;},async execute({engineId,workDir,nativeFile,inputFiles,steps,signal}){
    calls++;onExecute({engineId,workDir,nativeFile,inputFiles,steps,signal});
    if(delay)await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,delay);signal.addEventListener('abort',()=>{clearTimeout(timer);reject(Object.assign(new Error('aborted'),{code:'CANCELLED'}));},{once:true});});
    let before={edits:0};if(nativeFile){const bundle=JSON.parse(gunzipSync(readFileSync(nativeFile)).toString('utf8'));before=JSON.parse(Buffer.from(bundle.files.find(f=>f.path==='native/document.native').data,'base64').toString('utf8'));}
    const result={engineId,edits:before.edits+steps.filter(step=>step.command!=='inspect').length},native=Buffer.from(JSON.stringify(result));
    return {result,state:result,checkpoint:{name:'checkpoint.craftbundle',mime:'application/vnd.image2.craft-bundle+json',bytes:gzipSync(Buffer.from(JSON.stringify({version:1,engineId,workDir,files:[{path:'native/document.native',data:native.toString('base64'),sha256:digest(native)}]})))},files:[{name:'native.json',mime:'application/json',bytes:Buffer.from(JSON.stringify(result)),role:'export'}],receipt:{processor:'synthetic-native-ledger-fixture',steps:steps.length}};
  }};
}
async function fixture(t,options={}) {
  const directory=mkdtempSync(join(tmpdir(),'craft-service-')),store=new ImageStore(directory),runtime=options.runtime||fakeRuntime(options),craft=new CraftService({store,runtime});
  const doc=store.createDocument(OWNER,{name:'native fixture',width:64,height:64});craft.start();
  t.after(async()=>{await craft.stop();store.close();rmSync(directory,{recursive:true,force:true});});
  return {directory,store,runtime,craft,doc};
}
async function done(craft,doc,job) { const until=Date.now()+10000;while(Date.now()<until){const current=craft.getJob(doc.id,OWNER,job.id);if(['complete','failed','cancelled'].includes(current.state))return current;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('fixture job timeout'); }
async function create(f,engineId='vectorcraft',key=engineId) { return f.craft.createProject(f.doc.id,OWNER,{engineId,name:engineId,idempotencyKey:`create:${key}`}); }
async function submit(f,project,key='edit',revision=project.revision) { return f.craft.submit(f.doc.id,OWNER,{projectId:project.id,baseRevision:revision,steps:[{command:'edit',args:{}}],inputAssetIds:[],idempotencyKey:key}); }

test('accepted legacy Vector SVG outputs regain source dimensions while preview size and immutable receipts stay unchanged',async t=>{
  const runtime=fakeRuntime(),execute=runtime.execute.bind(runtime),svg=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="192" viewBox="0 0 256 192"><path d="M16 16 L240 32 L160 176 L32 144 Z" fill="#136a9f"/></svg>');
  const preview=await encodePNG({width:1024,height:768,data:new Uint8Array(1024*768*4)});
  runtime.execute=async args=>({...await execute(args),files:[{name:'preview.png',mime:'image/png',bytes:preview,role:'preview'},{name:'网页真实路径.svg',mime:'image/svg+xml',bytes:svg,role:'export'}]});
  const f=await fixture(t,{runtime}),project=await create(f),job=await done(f.craft,f.doc,await submit(f,project));assert.equal(job.state,'complete',job.error);
  const accepted=f.craft.accept(f.doc.id,OWNER,job.id,{baseRevision:0,idempotencyKey:'accept-svg'}),output=job.output.assets.find(asset=>asset.role==='export');
  assert.deepEqual([output.width,output.height],[256,192]);
  const legacy={...f.store.getAsset(output.id,OWNER).asset};delete legacy.width;delete legacy.height;f.store.db.prepare('UPDATE assets SET json=? WHERE id=?').run(JSON.stringify(legacy),output.id);
  const frozen=f.craft.record(f.doc.id,OWNER,job.id);for(const asset of frozen.output.assets)if(asset.id===output.id){delete asset.width;delete asset.height;}const frozenJSON=JSON.stringify(frozen);f.store.db.prepare('UPDATE craft_jobs SET json=? WHERE id=?').run(frozenJSON,job.id);
  for(const read of [f.craft.getJob(f.doc.id,OWNER,job.id).output,f.craft.listJobs(f.doc.id,OWNER)[0].output,f.craft.projectView(f.doc.id,OWNER,project.id).latestOutput]){
    const exported=read.assets.find(asset=>asset.id===output.id),thumb=read.assets.find(asset=>asset.role==='preview');assert.deepEqual([exported.width,exported.height],[256,192]);assert.deepEqual([thumb.width,thumb.height],[1024,768]);assert.equal(exported.hash,output.hash);
  }
  assert.equal(f.store.db.prepare('SELECT json FROM craft_jobs WHERE id=?').get(job.id).json,frozenJSON);assert.deepEqual(f.store.getAsset(output.id,OWNER).bytes,svg);assert.equal(f.craft.project(f.doc.id,OWNER,project.id).revision,accepted.revision);assert.equal(runtime.calls,1);
  assert.throws(()=>f.craft.getJob(f.doc.id,OTHER,job.id),e=>e.status===404);
});

test('all thirteen engines have independent native ledgers and immutable candidate outputs',async t=>{
  const f=await fixture(t);
  for(const engineId of ENGINES){const project=await create(f,engineId),job=await done(f.craft,f.doc,await submit(f,project,engineId));assert.equal(job.state,'complete',job.error);assert.equal(f.craft.project(f.doc.id,OWNER,project.id).revision,0);assert.equal(job.output.needsAcceptance,true);const accepted=f.craft.accept(f.doc.id,OWNER,job.id,{baseRevision:0,idempotencyKey:`accept:${engineId}`});assert.equal(accepted.revision,1);assert.equal(f.store.getDocument(f.doc.id,OWNER).layers.length,0);assert.equal(f.store.getAsset(accepted.nativeAssetId,OWNER).asset.mime,'application/octet-stream');}
  assert.equal(f.craft.listProjects(f.doc.id,OWNER).length,13);assert.equal(f.runtime.calls,13);
});

test('native edit restores the accepted immutable checkpoint in a different job workspace',async t=>{
  const roots=[],f=await fixture(t,{onExecute:x=>roots.push(x.workDir)}),p=await create(f),first=await done(f.craft,f.doc,await submit(f,p));
  const accepted=f.craft.accept(f.doc.id,OWNER,first.id,{baseRevision:0,idempotencyKey:'accept'}),original=f.store.getAsset(accepted.nativeAssetId,OWNER).bytes;
  const next=await done(f.craft,f.doc,await submit(f,accepted,'again'));assert.equal(next.output.result.edits,2);assert.notEqual(roots[0],roots[1]);assert.deepEqual(f.store.getAsset(accepted.nativeAssetId,OWNER).bytes,original);
});

test('duplicate submission and lost acceptance response do not execute or advance twice',async t=>{
  const f=await fixture(t),p=await create(f),a=await submit(f,p,'same'),b=await submit(f,p,'same');assert.equal(a.id,b.id);
  const complete=await done(f.craft,f.doc,a),request={baseRevision:0,idempotencyKey:'accepted'};
  const one=f.craft.accept(f.doc.id,OWNER,complete.id,request),two=f.craft.accept(f.doc.id,OWNER,complete.id,request);assert.deepEqual(two,one);assert.equal(f.runtime.calls,1);
  await assert.rejects(()=>f.craft.submit(f.doc.id,OWNER,{projectId:p.id,baseRevision:0,steps:[{command:'new',args:{}}],idempotencyKey:'same'}),e=>e.code==='idempotency_conflict');
  assert.throws(()=>f.craft.accept(f.doc.id,OWNER,complete.id,{baseRevision:1,idempotencyKey:'accepted'}),e=>e.code==='idempotency_conflict');
});

test('two native candidates from the same revision preserve the conflicted candidate',async t=>{
  const f=await fixture(t),p=await create(f),one=await done(f.craft,f.doc,await submit(f,p,'one')),two=await done(f.craft,f.doc,await submit(f,p,'two'));
  f.craft.accept(f.doc.id,OWNER,one.id,{baseRevision:0,idempotencyKey:'one'});
  assert.throws(()=>f.craft.accept(f.doc.id,OWNER,two.id,{baseRevision:0,idempotencyKey:'two'}),e=>e.code==='craft_revision_conflict');
  assert.equal(f.craft.getJob(f.doc.id,OWNER,two.id).output.needsAcceptance,true);assert.ok(f.store.getAsset(two.output.nativeAssetId,OWNER).bytes.length);
});

test('visitor and document scopes apply to projects jobs uploaded inputs and assets',async t=>{
  const f=await fixture(t),p=await create(f),job=await done(f.craft,f.doc,await submit(f,p));
  assert.throws(()=>f.craft.listProjects(f.doc.id,OTHER),e=>e.status===404);assert.throws(()=>f.craft.getJob(f.doc.id,OTHER,job.id),e=>e.status===404);assert.throws(()=>f.store.getAsset(job.output.nativeAssetId,OTHER),e=>e.status===404);
  const another=f.store.createDocument(OWNER,{name:'same owner different project',width:64,height:64});
  assert.throws(()=>f.craft.project(another.id,OWNER,p.id),e=>e.status===404);
  const uploaded=f.craft.addAsset(another.id,OWNER,{name:'office.docx',mime:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'},Buffer.from('opaque fixture'));
  await assert.rejects(()=>f.craft.submit(f.doc.id,OWNER,{projectId:p.id,baseRevision:0,steps:[{command:'edit',args:{path:{assetId:uploaded.id}}}],inputAssetIds:[uploaded.id],idempotencyKey:'crossdoc'}),e=>e.code==='craft_asset_scope');
});

test('cancel kills the active native operation and prevents checkpoint acceptance',async t=>{
  const f=await fixture(t,{delay:1000}),p=await create(f),job=await submit(f,p);
  while(f.craft.getJob(f.doc.id,OWNER,job.id).state==='queued')await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(f.craft.cancel(f.doc.id,OWNER,job.id).state,'cancelled');await Promise.allSettled([...f.craft.active.values()].map(x=>x.promise));
  const cancelled=f.craft.getJob(f.doc.id,OWNER,job.id);assert.equal(cancelled.state,'cancelled');assert.equal(cancelled.output,undefined);assert.equal(f.craft.project(f.doc.id,OWNER,p.id).revision,0);
});

test('queued and interrupted native CPU jobs recover from SQLite without a browser',async t=>{
  const f=await fixture(t),p=await create(f);await f.craft.stop();
  const job=await submit(f,p);const rec=f.craft.record(f.doc.id,OWNER,job.id);f.craft.updateJob(rec,{state:'running',stage:'native_execution'});
  const resumed=new CraftService({store:f.store,runtime:f.runtime});resumed.start();t.after(()=>resumed.stop());
  const complete=await done(resumed,f.doc,job);assert.equal(complete.state,'complete');assert.equal(f.runtime.calls,1);assert.equal(complete.metrics.generationCalls,0);
});

test('image and native branch acceptance commit together and roll back together on native conflict',async t=>{
  const f=await fixture(t),p=await create(f),initial=await done(f.craft,f.doc,await submit(f,p,'initial'));
  const main=f.craft.accept(f.doc.id,OWNER,initial.id,{baseRevision:0,idempotencyKey:'initial-accept'});
  const branch=f.store.createBranch(f.doc.id,OWNER,{baseRevision:0}),bp=f.store.transaction(()=>f.craft.forkForAgent(branch.id,OWNER,main.id));
  const bj=await done(f.craft,branch,await f.craft.submit(branch.id,OWNER,{projectId:bp.id,baseRevision:0,steps:[{command:'edit',args:{}}],idempotencyKey:'branch-edit'}));f.craft.accept(branch.id,OWNER,bj.id,{baseRevision:0,idempotencyKey:'branch-internal'});
  f.store.command(branch.id,OWNER,{baseRevision:0,commandId:'image-edit',commands:[{type:'document.update',patch:{name:'branch changed'}}]});
  const concurrent=await done(f.craft,f.doc,await submit(f,main,'concurrent'));f.craft.accept(f.doc.id,OWNER,concurrent.id,{baseRevision:1,idempotencyKey:'concurrent-accept'});
  assert.throws(()=>f.store.acceptBranch(f.doc.id,OWNER,{branchDocumentId:branch.id,baseRevision:0,commandId:'accept-both'}),e=>e.code==='craft_branch_conflict');
  assert.equal(f.store.getDocument(f.doc.id,OWNER).revision,0);assert.equal(f.store.getDocument(f.doc.id,OWNER).name,'native fixture');assert.equal(f.craft.project(f.doc.id,OWNER,main.id).revision,2);
  const fresh=f.store.createBranch(f.doc.id,OWNER,{baseRevision:0}),fp=f.store.transaction(()=>f.craft.forkForAgent(fresh.id,OWNER,main.id));
  const fj=await done(f.craft,fresh,await f.craft.submit(fresh.id,OWNER,{projectId:fp.id,baseRevision:0,steps:[{command:'edit',args:{}}],idempotencyKey:'fresh-edit'}));f.craft.accept(fresh.id,OWNER,fj.id,{baseRevision:0,idempotencyKey:'fresh-internal'});
  f.store.command(fresh.id,OWNER,{baseRevision:0,commandId:'image-edit2',commands:[{type:'document.update',patch:{name:'accepted both'}}]});
  const accepted=f.store.acceptBranch(f.doc.id,OWNER,{branchDocumentId:fresh.id,baseRevision:0,commandId:'fresh-accept'});assert.equal(accepted.name,'accepted both');assert.equal(f.craft.project(f.doc.id,OWNER,main.id).revision,3);
  f.store.acceptBranch(f.doc.id,OWNER,{branchDocumentId:fresh.id,baseRevision:0,commandId:'fresh-accept'});assert.equal(f.craft.project(f.doc.id,OWNER,main.id).revision,3);
});

test('Craft tools expose schema discovery and execute through the existing bounded Agent protocol',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'craft-agent-')),runtime=fakeRuntime();let calls=0;
  const service=createImageService({directory,token:'synthetic-craft-test-token',craftRuntime:runtime,config:{agent:{baseUrl:'https://fixture.invalid/v1',apiKey:'synthetic',models:['fixture']}},fetchImpl:async(url,init)=>{
    assert.match(String(url),/chat\/completions$/);const request=JSON.parse(init.body);assert.ok(request.tools.some(t=>t.function.name==='craft_capabilities'));assert.ok(request.tools.some(t=>t.function.name==='craft_execute'));calls++;
    return Response.json({choices:[{message:calls===1?{role:'assistant',tool_calls:[{id:'craft',type:'function',function:{name:'craft_execute',arguments:JSON.stringify({engineId:'gridcraft',steps:[{command:'edit',args:{}}]})}}]}:{role:'assistant',content:'原生表格候选已保存'}}]});
  }});
  t.after(async()=>{await service.close();rmSync(directory,{recursive:true,force:true});});
  const doc=service.store.createDocument(OWNER,{name:'agent native',width:64,height:64}),conversation=service.store.createConversation(OWNER,{documentId:doc.id});
  const submitted=await service.runner.submitRun(OWNER,conversation.id,{text:'建立原生表格',references:[],baseRevision:0,idempotencyKey:'native-agent'});
  const end=Date.now()+10000;let doneJob;while(Date.now()<end){doneJob=service.store.getJob(submitted.job.id,OWNER);if(['complete','awaiting_user','failed'].includes(doneJob.state))break;await new Promise(resolve=>setTimeout(resolve,20));}
  assert.equal(doneJob.state,'complete',doneJob.error);assert.equal(runtime.calls,1);assert.equal(service.craft.listProjects(doc.id,OWNER).length,0);assert.equal(doneJob.output.craftProjects.length,1);
  const accepted=service.store.acceptBranch(doc.id,OWNER,{baseRevision:0,branchDocumentId:doneJob.output.branchDocumentId,commandId:'native-final-accept'});assert.equal(accepted.layers.length,0);assert.equal(service.craft.listProjects(doc.id,OWNER).length,1);assert.equal(calls,2);
});

test('native HTTP routes require internal token and owner and return canonical API shapes',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'craft-http-')),service=createImageService({directory,token:'synthetic-craft-http-token',craftRuntime:fakeRuntime(),config:{agent:{baseUrl:'',apiKey:''}}});
  await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await service.close();rmSync(directory,{recursive:true,force:true});});
  const doc=service.store.createDocument(OWNER,{name:'HTTP',width:64,height:64}),base=`http://127.0.0.1:${service.server.address().port}/api/v3/image2/documents/${doc.id}/craft`,headers={authorization:'Bearer synthetic-craft-http-token','x-studio-visitor-id':OWNER,'content-type':'application/json'};
  assert.equal((await fetch(`${base}/capabilities`)).status,401);
  const available=await (await fetch(`${base}/capabilities`,{headers})).json();assert.equal(available.data.engines.length,13);
  const created=await (await fetch(`${base}/projects`,{method:'POST',headers,body:JSON.stringify({engineId:'wordcraft',idempotencyKey:'http-create'})})).json();assert.equal(created.data.engineId,'wordcraft');
  const listed=await (await fetch(`${base}/projects`,{headers})).json();assert.ok(Array.isArray(listed.data));
  assert.equal((await fetch(`${base}/projects`,{headers:{...headers,'x-studio-visitor-id':OTHER}})).status,404);
});

test('Agent Craft schema is registered for both document versions',()=>{for(const schemaVersion of [2,3]){const names=buildAgentTools({schemaVersion}).map(t=>t.function.name);assert.ok(names.includes('craft_capabilities'));assert.ok(names.includes('craft_execute'));assert.ok(names.includes('craft_restore'));}});

test('Agent freezes native source revisions before tools and cannot silently use a newer main checkpoint',async t=>{
  const f=await fixture(t),p=await create(f),job=await done(f.craft,f.doc,await submit(f,p,'first'));const initial=f.craft.accept(f.doc.id,OWNER,job.id,{baseRevision:0,idempotencyKey:'first-accept'});
  const branch=f.store.createBranch(f.doc.id,OWNER,{baseRevision:0}),snapshot=f.craft.agentProjects(branch.id,OWNER);assert.equal(snapshot[0].nativeAssetId,initial.nativeAssetId);
  const second=await done(f.craft,f.doc,await submit(f,initial,'second'));const latest=f.craft.accept(f.doc.id,OWNER,second.id,{baseRevision:1,idempotencyKey:'second-accept'});
  const inherited=f.craft.forkForAgent(branch.id,OWNER,p.id);assert.equal(inherited.nativeAssetId,initial.nativeAssetId);assert.notEqual(inherited.nativeAssetId,latest.nativeAssetId);assert.equal(inherited.parentProjectRevision,1);
  const fresh=await create(f,'gridcraft','later');assert.throws(()=>f.craft.forkForAgent(branch.id,OWNER,fresh.id),e=>e.code==='craft_project_snapshot_missing');
});

test('already accepted image branches cannot receive later native edits or uploads',async t=>{
  const f=await fixture(t),branch=f.store.createBranch(f.doc.id,OWNER,{baseRevision:0});
  f.store.acceptBranch(f.doc.id,OWNER,{branchDocumentId:branch.id,baseRevision:0,commandId:'empty-accept'});
  await assert.rejects(()=>f.craft.createProject(branch.id,OWNER,{engineId:'wordcraft',idempotencyKey:'late'}),e=>e.code==='craft_branch_accepted');
  assert.throws(()=>f.craft.addAsset(branch.id,OWNER,{name:'late.dat'},Buffer.from('late')),e=>e.code==='craft_branch_accepted');
});

test('only signature-verified media keeps playable MIME; HTML and unknown native remain opaque',async t=>{
  const f=await fixture(t),wav=Buffer.alloc(16);wav.write('RIFF',0);wav.write('WAVE',8);
  const media=f.craft.addAsset(f.doc.id,OWNER,{name:'sound.wav',mime:'audio/wav'},wav);assert.equal(media.mime,'audio/wav');
  const fake=f.craft.addAsset(f.doc.id,OWNER,{name:'fake.wav',mime:'audio/wav'},Buffer.from('<script>bad</script>'));assert.equal(fake.mime,'application/octet-stream');
  const html=f.craft.addAsset(f.doc.id,OWNER,{name:'native.html',mime:'text/html'},Buffer.from('<script>bad</script>'));assert.equal(html.mime,'application/octet-stream');
});

test('lost Agent native tool acknowledgement reuses the frozen job and accepted branch revision',async t=>{
  const f=await fixture(t),branch=f.store.createBranch(f.doc.id,OWNER,{baseRevision:0}),runner={cancelled:()=>false};
  const args={engineId:'gridcraft',steps:[{command:'edit',args:{}}]},one=await f.craft.executeAgent(runner,'agent-fixture',branch.id,OWNER,args,'tool_1_0');
  const two=await f.craft.executeAgent(runner,'agent-fixture',branch.id,OWNER,args,'tool_1_0');assert.equal(one.craftJobId,two.craftJobId);assert.equal(two.project.revision,1);assert.equal(f.runtime.calls,1);assert.equal(f.craft.listProjects(f.doc.id,OWNER).length,0);
});

test('native outputs are not accepted after parent Agent cancellation',async t=>{
  const f=await fixture(t,{delay:300}),branch=f.store.createBranch(f.doc.id,OWNER,{baseRevision:0});let cancel=false;
  const task=f.craft.executeAgent({cancelled:()=>cancel},'agent-cancel',branch.id,OWNER,{engineId:'gridcraft',steps:[{command:'edit',args:{}}]},'tool_1_0');
  while(!f.craft.listJobs(branch.id,OWNER).length)await new Promise(resolve=>setTimeout(resolve,5));cancel=true;
  await assert.rejects(()=>task,e=>e.code==='CANCELLED');assert.equal(f.craft.listProjects(branch.id,OWNER)[0].revision,0);assert.equal(f.craft.listProjects(f.doc.id,OWNER).length,0);
});

test('whole branch acceptance cannot discard pending native work and explicit discard retains artifacts',async t=>{
  const f=await fixture(t,{delay:100}),branch=f.store.createBranch(f.doc.id,OWNER,{baseRevision:0}),project=await f.craft.createProject(branch.id,OWNER,{engineId:'wordcraft',idempotencyKey:'branch-project'});
  const job=await f.craft.submit(branch.id,OWNER,{projectId:project.id,baseRevision:0,steps:[{command:'edit',args:{}}],idempotencyKey:'branch-pending'});
  assert.throws(()=>f.store.acceptBranch(f.doc.id,OWNER,{branchDocumentId:branch.id,baseRevision:0,commandId:'too-early'}),e=>e.code==='craft_candidate_not_ready');
  const completed=await done(f.craft,branch,job);
  assert.throws(()=>f.store.acceptBranch(f.doc.id,OWNER,{branchDocumentId:branch.id,baseRevision:0,commandId:'not-accepted'}),e=>e.code==='craft_native_acceptance_required');
  f.craft.discard(branch.id,OWNER,job.id);assert.ok(f.store.getAsset(completed.output.nativeAssetId,OWNER).bytes.length);
  f.store.acceptBranch(f.doc.id,OWNER,{branchDocumentId:branch.id,baseRevision:0,commandId:'after-discard'});assert.equal(f.craft.listProjects(f.doc.id,OWNER).length,0);
});

test('accepting a branch during asynchronous engine discovery prevents a late native project write',async t=>{
  let release;const runtime=fakeRuntime(),original=runtime.capabilities;runtime.capabilities=()=>new Promise(resolve=>{release=async()=>resolve(await original());});
  const f=await fixture(t,{runtime}),branch=f.store.createBranch(f.doc.id,OWNER,{baseRevision:0});
  const pending=f.craft.createProject(branch.id,OWNER,{engineId:'wordcraft',idempotencyKey:'late-discovery'});
  f.store.acceptBranch(f.doc.id,OWNER,{branchDocumentId:branch.id,baseRevision:0,commandId:'accept-during-discovery'});await release();
  await assert.rejects(()=>pending,e=>e.code==='craft_branch_accepted');assert.equal(f.craft.listProjects(branch.id,OWNER).length,0);
});

test('explicit failed native retry uses a new receipt and freezes original inputs and revision',async t=>{
  const runtime=fakeRuntime(),execute=runtime.execute;let rejectOnce=true;runtime.execute=async args=>{if(rejectOnce){rejectOnce=false;throw Object.assign(new Error('synthetic native failure'),{code:'fixture_failure'});}return execute(args);};
  const f=await fixture(t,{runtime}),p=await create(f),failed=await done(f.craft,f.doc,await submit(f,p,'failed'));assert.equal(failed.state,'failed');
  const retry=await f.craft.retry(f.doc.id,OWNER,failed.id,{idempotencyKey:'retry'}),duplicate=await f.craft.retry(f.doc.id,OWNER,failed.id,{idempotencyKey:'retry'});assert.equal(retry.id,duplicate.id);
  assert.equal((await done(f.craft,f.doc,retry)).state,'complete');assert.equal(f.craft.getJob(f.doc.id,OWNER,failed.id).state,'failed');assert.equal(runtime.calls,1);
});

test('persistent native history restore is an idempotent candidate and advances only on acceptance',async t=>{
  const f=await fixture(t),p=await create(f),one=await done(f.craft,f.doc,await submit(f,p,'h1')),first=f.craft.accept(f.doc.id,OWNER,one.id,{baseRevision:0,idempotencyKey:'h1a'});
  const two=await done(f.craft,f.doc,await submit(f,first,'h2')),second=f.craft.accept(f.doc.id,OWNER,two.id,{baseRevision:1,idempotencyKey:'h2a'});
  const request={projectId:p.id,revision:1,baseRevision:2,idempotencyKey:'restore'},candidate=f.craft.restoreRevision(f.doc.id,OWNER,request);
  assert.equal(candidate.output.nativeAssetId,first.nativeAssetId);assert.equal(f.craft.project(f.doc.id,OWNER,p.id).nativeAssetId,second.nativeAssetId);assert.equal(f.craft.restoreRevision(f.doc.id,OWNER,request).id,candidate.id);
  const restored=f.craft.accept(f.doc.id,OWNER,candidate.id,{baseRevision:2,idempotencyKey:'restore-accept'});assert.equal(restored.revision,3);assert.equal(restored.nativeAssetId,first.nativeAssetId);assert.equal(f.runtime.calls,2);
  assert.throws(()=>f.craft.restoreRevision(f.doc.id,OWNER,{...request,revision:0,baseRevision:3,idempotencyKey:'empty'}),e=>e.code==='craft_history_unavailable');
  assert.throws(()=>f.craft.restoreRevision(f.doc.id,OWNER,{...request,baseRevision:2,idempotencyKey:'stale'}),e=>e.code==='craft_revision_conflict');
  const discard=f.craft.restoreRevision(f.doc.id,OWNER,{...request,revision:2,baseRevision:3,idempotencyKey:'discard-restore'});f.craft.discard(f.doc.id,OWNER,discard.id);
  const retried=await f.craft.retry(f.doc.id,OWNER,discard.id,{idempotencyKey:'retry-restore'});assert.equal(retried.state,'complete');assert.equal(retried.output.nativeAssetId,second.nativeAssetId);assert.equal(f.runtime.calls,2);assert.equal((await f.craft.retry(f.doc.id,OWNER,discard.id,{idempotencyKey:'retry-restore'})).id,retried.id);
});

test('Agent history restore uses frozen source history and waits for atomic whole-branch acceptance',async t=>{
  const f=await fixture(t),p=await create(f),one=await done(f.craft,f.doc,await submit(f,p,'ar1')),first=f.craft.accept(f.doc.id,OWNER,one.id,{baseRevision:0,idempotencyKey:'ar1a'});
  const two=await done(f.craft,f.doc,await submit(f,first,'ar2'));f.craft.accept(f.doc.id,OWNER,two.id,{baseRevision:1,idempotencyKey:'ar2a'});
  const branch=f.store.createBranch(f.doc.id,OWNER,{baseRevision:0}),runner={cancelled:()=>false},args={projectId:p.id,revision:1,history:'source'};
  const restored=await f.craft.restoreAgent(runner,'restore-agent',branch.id,OWNER,args,'tool_1_0'),repeated=await f.craft.restoreAgent(runner,'restore-agent',branch.id,OWNER,args,'tool_1_0');assert.equal(repeated.craftJobId,restored.craftJobId);assert.equal(restored.project.nativeAssetId,first.nativeAssetId);assert.equal(f.craft.project(f.doc.id,OWNER,p.id).revision,2);
  f.store.acceptBranch(f.doc.id,OWNER,{branchDocumentId:branch.id,baseRevision:0,commandId:'history-whole-branch'});assert.equal(f.craft.project(f.doc.id,OWNER,p.id).revision,3);assert.equal(f.craft.project(f.doc.id,OWNER,p.id).nativeAssetId,first.nativeAssetId);
});

test('a downloaded native bundle imports into a new project with actual verification before acceptance',async t=>{
  const f=await fixture(t),p=await create(f),job=await done(f.craft,f.doc,await submit(f,p,'original')),original=f.craft.accept(f.doc.id,OWNER,job.id,{baseRevision:0,idempotencyKey:'original-a'});
  const otherDoc=f.store.createDocument(OWNER,{name:'bundle imported elsewhere',width:64,height:64}),source=f.store.getAsset(original.nativeAssetId,OWNER),uploaded=f.craft.addAsset(otherDoc.id,OWNER,{name:'downloaded.craftbundle',mime:source.asset.metadata.sourceMime},source.bytes);
  const request={engineId:'vectorcraft',initialAssetId:uploaded.id,idempotencyKey:'import'},project=await f.craft.createProject(otherDoc.id,OWNER,request);assert.ok(project.importJobId);assert.equal(project.nativeAssetId,undefined);assert.equal((await f.craft.createProject(otherDoc.id,OWNER,request)).id,project.id);
  const verified=await done(f.craft,otherDoc,{id:project.importJobId});assert.equal(verified.state,'complete',verified.error);assert.equal(verified.output.state.edits,1);assert.equal(f.craft.project(otherDoc.id,OWNER,project.id).revision,0);
  await assert.rejects(()=>f.craft.submit(otherDoc.id,OWNER,{projectId:project.id,baseRevision:0,steps:[{command:'edit',args:{}}],idempotencyKey:'too-early'}),e=>e.code==='craft_import_pending');
  const accepted=f.craft.accept(otherDoc.id,OWNER,verified.id,{baseRevision:0,idempotencyKey:'import-accept'});assert.equal(accepted.revision,1);assert.equal(accepted.pendingImportAssetId,undefined);assert.equal(accepted.importSourceAssetId,uploaded.id);
  const view=f.craft.projectView(otherDoc.id,OWNER,project.id);assert.equal(view.latestOutput.state.edits,1);assert.equal(view.latestOutput.acceptedProjectRevision,1);
});

test('bundle import validates engine paths hashes and ownership before creating a native project',async t=>{
  const f=await fixture(t),base=Buffer.from('{}'),pack=(engineId,path,hash=digest(base))=>gzipSync(Buffer.from(JSON.stringify({version:1,engineId,workDir:'/old-owned-root',files:[{path,data:base.toString('base64'),sha256:hash}]})));
  for(const [name,bytes] of [['engine',pack('wordcraft','native/document.native')],['path',pack('vectorcraft','native/../../escape')],['hash',pack('vectorcraft','native/document.native','0'.repeat(64))]]){
    const asset=f.craft.addAsset(f.doc.id,OWNER,{name:`${name}.craftbundle`},bytes);await assert.rejects(()=>f.craft.createProject(f.doc.id,OWNER,{engineId:'vectorcraft',initialAssetId:asset.id,idempotencyKey:name}),e=>e.status===422);assert.equal(f.craft.listProjects(f.doc.id,OWNER).length,0);
  }
  const other=f.store.createDocument(OTHER,{name:'other',width:64,height:64}),asset=f.craft.addAsset(other.id,OTHER,{name:'other.craftbundle'},pack('vectorcraft','native/document.native'));
  await assert.rejects(()=>f.craft.createProject(f.doc.id,OWNER,{engineId:'vectorcraft',initialAssetId:asset.id,idempotencyKey:'cross-owner'}),e=>e.code==='craft_asset_scope');
});

test('promoted native project exposes its actual branch outputs without rewriting job identity',async t=>{
  const f=await fixture(t),branch=f.store.createBranch(f.doc.id,OWNER,{baseRevision:0}),result=await f.craft.executeAgent({cancelled:()=>false},'project-view-agent',branch.id,OWNER,{engineId:'gridcraft',steps:[{command:'edit',args:{}}]},'tool_1_0');
  f.store.acceptBranch(f.doc.id,OWNER,{branchDocumentId:branch.id,baseRevision:0,commandId:'promote-view'});const project=f.craft.listProjects(f.doc.id,OWNER)[0],view=f.craft.projectView(f.doc.id,OWNER,project.id);
  assert.equal(view.latestOutput.sourceDocumentId,branch.id);assert.equal(view.latestOutput.sourceJobId,result.craftJobId);assert.equal(view.latestOutput.state.edits,1);assert.equal(f.craft.getJob(branch.id,OWNER,result.craftJobId).documentId,branch.id);
  assert.throws(()=>f.craft.projectView(f.doc.id,OTHER,project.id),e=>e.status===404);
});
