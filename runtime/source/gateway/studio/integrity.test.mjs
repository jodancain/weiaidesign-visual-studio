import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { StudioStore } from './store.mjs';
import { StudioJobs } from './jobs.mjs';
import { StudioProvider } from './provider.mjs';
import { createStudioRouter } from './router.mjs';
import { createProject, clone, digest, shotHash } from './domain.mjs';

const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
function directory(t){const dir=mkdtempSync(join(tmpdir(),'studio-integrity-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;}
function fixture(t){const store=new StudioStore(directory(t));t.after(()=>store.close());return {store,p:store.createProject(createProject())};}
function inputFor(p){return {shot:clone(p.shots[0]),approvalHash:shotHash(p,p.shots[0]),aspect:p.aspect,fps:24};}
async function httpFixture(t,options={}){
  const router=createStudioRouter({dataDir:directory(t),token:'synthetic-integrity-token',startJobs:false,...options});
  router.jobs.tick=()=>{}; // Test each durable checkpoint explicitly; no background work.
  const server=createServer((req,res)=>router.handle(req,res));server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await router.close();});
  const call=async(path,method='GET',body)=>{const res=await fetch(`http://127.0.0.1:${server.address().port}/api/v3${path}`,{method,headers:{authorization:'Bearer synthetic-integrity-token','content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:res.status,...await res.json()};};
  return {router,call};
}
const renameOp=(p,name)=>({type:'object.update',sceneId:p.scenes[0].id,objectId:p.scenes[0].objects[0].id,patch:{name}});

test('HTTP concurrent CAS admits one writer; command aliases replay without mutating authoring or history',async t=>{
  const {router,call}=await httpFixture(t);let p=(await call('/projects','POST',{})).data;
  const attempts=await Promise.all(['left','right'].map(name=>call(`/projects/${p.id}/commands`,'POST',{baseRevision:0,commandId:name,ops:[renameOp(p,name)]})));
  assert.deepEqual(attempts.map(r=>r.status).sort(),[200,409]);const winner=attempts.find(r=>r.status===200).data.scenes[0].objects[0].name;
  p=(await call(`/projects/${p.id}`)).data;assert.equal(p.revision,1);
  const replay=await call(`/projects/${p.id}/commands`,'POST',{baseRevision:0,commandId:winner,ops:[renameOp(p,winner)]});assert.equal(replay.status,200);assert.equal(replay.data.revision,1);
  const collision=await call(`/projects/${p.id}/commands`,'POST',{baseRevision:1,commandId:winner,ops:[renameOp(p,'different')]});assert.equal(collision.status,409);
  const stale=clone(p);stale.name='stale';assert.equal((await call(`/projects/${p.id}`,'PUT',{baseRevision:0,project:stale})).status,409);
  assert.equal(router.store.db.prepare('SELECT count(*) AS n FROM history WHERE project_id=?').get(p.id).n,1);
  assert.equal((await call(`/projects/${p.id}/history`,'POST',{baseRevision:1,direction:'undo'})).data.revision,2);
  assert.equal(router.store.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
});

test('HTTP references and approvals cannot be forged across projects; content change invalidates approval before generation',async t=>{
  let submits=0;const provider={capabilities:()=>({video:true}),submit:async()=>{submits++;throw Error('must never submit');}};
  const {router,call}=await httpFixture(t,{provider,workerUrl:'http://worker.invalid'});let p=(await call('/projects','POST',{})).data,other=(await call('/projects','POST',{})).data;
  const foreign=router.store.addAsset(other.id,{name:'foreign.png',kind:'image',mime:'image/png'},PNG).asset;
  const foreignBake=router.store.addAsset(other.id,{name:'foreign.glb',kind:'bake',mime:'model/gltf-binary'},Buffer.from('fixture')).asset;
  const own=router.store.addAsset(p.id,{name:'own.png',kind:'image',mime:'image/png'},PNG).asset;p=router.store.getProject(p.id);
  for(const modify of [c=>{c.shots[0].firstAssetId=foreign.id;},c=>{c.assets.push(foreign);c.shots[0].firstAssetId=foreign.id;},c=>{c.shots[0].takes.push({id:'forged',assetId:own.id,jobId:'forged',model:'fixture',referenceMode:'first_frame'});}]){
    const candidate=clone(p);modify(candidate);assert.notEqual((await call(`/projects/${p.id}`,'PUT',{baseRevision:p.revision,project:candidate})).status,200);assert.equal(router.store.getProject(p.id).revision,p.revision);
  }
  assert.equal((await call(`/projects/${p.id}/assets`,'POST',{name:'child.png',kind:'image',mime:'image/png',parentId:foreign.id,base64:PNG.toString('base64')})).status,400);
  assert.equal((await call(`/projects/${p.id}/previews`,'POST',{idempotencyKey:'foreign-bake',sceneId:p.scenes[0].id,bakedAssetId:foreignBake.id,frameStart:0,frameEnd:1})).status,422);
  const foreignHash=(await call(`/projects/${other.id}/review`)).data.shots[0].hash;
  assert.equal((await call(`/projects/${p.id}/shots/${p.shots[0].id}/approve`,'POST',{hash:foreignHash})).status,409);
  const candidate=clone(p);candidate.shots[0].firstAssetId=own.id;p=(await call(`/projects/${p.id}`,'PUT',{baseRevision:p.revision,project:candidate})).data;
  const hash=(await call(`/projects/${p.id}/review`)).data.shots[0].hash;p=(await call(`/projects/${p.id}/shots/${p.shots[0].id}/approve`,'POST',{hash})).data;
  p=(await call(`/projects/${p.id}/commands`,'POST',{baseRevision:p.revision,commandId:'edit-approved',ops:[renameOp(p,'Changed identity')]})).data;
  assert.equal(p.shots[0].approval,undefined);
  assert.equal((await call(`/projects/${p.id}/shots/${p.shots[0].id}/generate`,'POST',{idempotencyKey:'stale-review',approvalHash:hash})).status,409);
  assert.equal(submits,0);assert.deepEqual(router.store.listJobs(p.id),[]);
});

test('slow AI response cannot overwrite a newer user save or add a stale undo entry',async t=>{
  let release,entered;const pending=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
  const {router,call}=await httpFixture(t,{provider:{capabilities:()=>({llm:true}),edit:async(_b,p)=>{entered();await pending;return {message:'stale',ops:[renameOp(p,'AI stale')]};}}});
  const p=(await call('/projects','POST',{})).data;
  const ai=call(`/projects/${p.id}/ai`,'POST',{baseRevision:p.revision,prompt:'rename',sceneId:p.scenes[0].id,mode:'static',scope:'scene',frame:0,selectionIds:[]});
  await started;const edited=await call(`/projects/${p.id}/commands`,'POST',{baseRevision:p.revision,commandId:'newer-user',ops:[renameOp(p,'User current')]});release();
  assert.equal((await ai).status,409);assert.equal(edited.status,200);assert.equal(router.store.getProject(p.id).scenes[0].objects[0].name,'User current');
  assert.equal(router.store.db.prepare('SELECT count(*) AS n FROM history WHERE project_id=?').get(p.id).n,1);
});

test('export receipt remains idempotent after its own output changes project revision, including legacy hash receipts',async t=>{
  const {router,call}=await httpFixture(t,{jobsOptions:{exportSequence:async({outputPath})=>{writeFileSync(outputPath,'synthetic-local-video');return {path:outputPath,frames:240,fps:24,duration:10,width:1280,height:720};}}});
  let p=(await call('/projects','POST',{})).data;const asset=router.store.addAsset(p.id,{name:'clip.mp4',kind:'video',mime:'video/mp4'},Buffer.from('fixture-input')).asset;p=router.store.getProject(p.id);
  p=router.store.change(p.id,p.revision,c=>{c.sequence.clips=[{id:'clip',kind:'video',assetId:asset.id,track:0,startFrame:0,endFrame:240,sourceIn:0,volume:1,fadeIn:0,fadeOut:0}];return c;});
  // Manufacture the pre-fix receipt format in the same public API path.
  const body={sequenceId:p.sequence.id,idempotencyKey:'same-export'},first=await call(`/projects/${p.id}/exports`,'POST',body);assert.equal(first.status,200);
  const original=router.store.job(first.data.id).private.input,legacyHash=digest({kind:'export',input:original});
  assert.equal(router.store.job(first.data.id).private.inputHash,legacyHash,'persisted format remains compatible with the previous image');
  router.store.db.prepare('UPDATE job_receipts SET input_hash=? WHERE job_id=?').run(legacyHash,first.data.id);
  router.store.db.prepare('UPDATE jobs SET input_hash=? WHERE id=?').run(legacyHash,first.data.id);
  router.store.addAsset(p.id,{name:'unrelated.png',kind:'image',mime:'image/png'},PNG);
  const alias=await call(`/projects/${p.id}/exports`,'POST',{...body,idempotencyKey:'alias-during-export'});assert.equal(alias.status,200);assert.equal(alias.data.id,first.data.id);
  await router.jobs.step(first.data.id);assert.equal(router.store.job(first.data.id).job.state,'complete');
  const replay=await call(`/projects/${p.id}/exports`,'POST',body);assert.equal(replay.status,200);assert.equal(replay.data.id,first.data.id);assert.equal(router.store.listJobs(p.id).length,1);
  p=router.store.getProject(p.id);router.store.change(p.id,p.revision,c=>{c.sequence.clips[0].volume=.5;return c;});
  assert.equal((await call(`/projects/${p.id}/exports`,'POST',body)).status,409,'changed rendering input still conflicts');
});

test('export aliases and frozen sourceRevision survive SQLite reopen after unrelated assets and completed output',async t=>{
  const dir=directory(t);let store=new StudioStore(dir),p=store.createProject(createProject());
  const first=store.createJob(p.id,'export','original',{project:p}),legacyHash=digest({kind:'export',input:{project:p}});
  store.db.prepare('UPDATE job_receipts SET input_hash=? WHERE job_id=?').run(legacyHash,first.id);store.db.prepare('UPDATE jobs SET input_hash=? WHERE id=?').run(legacyHash,first.id);
  store.addAsset(p.id,{name:'unrelated.png',kind:'image',mime:'image/png'},PNG);assert.equal(store.createJob(p.id,'export','alias',{project:store.getProject(p.id)}).id,first.id);
  store.completeJob(first.id,{name:'export.mp4',kind:'video',mime:'video/mp4'},Buffer.from('exported'),{sourceRevision:0});store.close();store=new StudioStore(dir);t.after(()=>store.close());
  p=store.getProject(p.id);for(const key of ['original','alias'])assert.equal(store.createJob(p.id,'export',key,{project:p}).id,first.id);
  assert.equal(store.job(first.id).private.input.project.revision,0);assert.equal(store.job(first.id).job.output.sourceRevision,0);assert.equal(store.listJobs(p.id).length,1);
  const changed=clone(p);changed.aspect='9:16';assert.throws(()=>store.createJob(p.id,'export','alias',{project:changed}),/different input/);
  assert.notEqual(store.createJob(p.id,'export','intentional-new-export',{project:p}).id,first.id);
});

test('a compositor execution failure commits neither output nor NAS archive and a new key permits safe local retry',async t=>{
  const {store,p}=fixture(t);let exports=0,archives=0;
  const jobs=new StudioJobs(store,{exportSequence:async({outputPath})=>{exports++;writeFileSync(outputPath,'partial encoder output');throw Error('injected FFmpeg exit 1');},archiveVideo:async()=>{archives++;throw Error('must not archive');}});t.after(()=>jobs.close());
  const first=store.createJob(p.id,'export','failed-encoder',{project:p});await jobs.step(first.id);await jobs.step(first.id);
  assert.equal(store.job(first.id).job.state,'failed');assert.equal(store.job(first.id).job.outputAssetId,undefined);assert.equal(store.getProject(p.id).assets.length,0);assert.equal(exports,1);assert.equal(archives,0);
  assert.equal(store.createJob(p.id,'export','failed-encoder',{project:p}).id,first.id);assert.notEqual(store.createJob(p.id,'export','explicit-retry',{project:p}).id,first.id);
});

test('submission transport uncertainty is durable across restart and different idempotency keys',async t=>{
  for(const mode of ['network','http-503','invalid-json','missing-id'])await t.test(mode,async t=>{
    const dir=directory(t);let calls=0,store=new StudioStore(dir);const p=store.createProject(createProject());
    const provider=new StudioProvider({baseUrl:'https://fixture.invalid/v1',apiKey:'synthetic',backend:'seedance',model:'fixture'},{fetchImpl:async()=>{calls++;if(mode==='network')throw Error('disconnect');if(mode==='http-503')return Response.json({detail:'unavailable'},{status:503});if(mode==='invalid-json')return new Response('{broken');return Response.json({status:'accepted'});}});
    const asset=store.addAsset(p.id,{name:'frame.png',kind:'image',mime:'image/png'},PNG).asset;const input=inputFor(p);input.shot.firstAssetId=asset.id;
    let jobs=new StudioJobs(store,{provider});const job=store.createJob(p.id,'generation','first-click',input);await jobs.step(job.id);assert.equal(store.job(job.id).job.state,'uncertain');await jobs.close();store.close();
    store=new StudioStore(dir);jobs=new StudioJobs(store,{provider});t.after(async()=>{await jobs.close();store.close();});assert.equal(store.createJob(p.id,'generation','new-click',input).id,job.id);await jobs.step(job.id);assert.equal(calls,1);assert.equal(store.pendingJobs().length,0);
  });
});

async function killedCheckpoint(t,phase){
  const dir=directory(t),storeURL=new URL('./store.mjs',import.meta.url).href,jobsURL=new URL('./jobs.mjs',import.meta.url).href,domainURL=new URL('./domain.mjs',import.meta.url).href;
  const code=`import {StudioStore} from ${JSON.stringify(storeURL)};import {StudioJobs} from ${JSON.stringify(jobsURL)};import {createProject} from ${JSON.stringify(domainURL)};import {appendFileSync} from 'node:fs';const s=new StudioStore(process.env.FIXTURE_DIRECTORY),p=s.createProject(createProject()),input={shot:p.shots[0],aspect:p.aspect,fps:24,approvalHash:'fixture'};const j=s.createJob(p.id,'generation','original',input);const mark=()=>process.stdout.write(JSON.stringify({jobId:j.id,projectId:p.id,input})+'\\n');const jobs=new StudioJobs(s,{provider:{submit:async()=>{appendFileSync(process.env.FIXTURE_DIRECTORY+'/submits','1\\n');${phase==='submitting'?'mark();await new Promise(()=>{});':"return {id:'accepted-operation',model:'fixture'};"}}}});await jobs.step(j.id);${phase==='accepted'?'mark();':''}setInterval(()=>{},1000);`;
  const child=spawn(process.execPath,['--input-type=module','-e',code],{env:{PATH:process.env.PATH,FIXTURE_DIRECTORY:dir,NODE_NO_WARNINGS:'1'},stdio:['ignore','pipe','pipe']});t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
  const marker=await new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(Error('checkpoint timeout')),10000);child.stdout.on('data',data=>{text+=data;if(text.includes('\n')){clearTimeout(timer);resolve(JSON.parse(text.split('\n')[0]));}});child.once('error',reject);child.once('exit',code=>{if(!text){clearTimeout(timer);reject(Error(`checkpoint child exited ${code}`));}});});
  const exit=once(child,'exit');child.kill('SIGKILL');await exit;return {dir,...marker};
}

test('real SIGKILL before and after accepted-ID commit recovers the correct submission boundary',async t=>{
  for(const phase of ['submitting','accepted'])await t.test(phase,async t=>{
    const {dir,jobId,projectId,input}=await killedCheckpoint(t,phase),store=new StudioStore(dir);let resubmits=0,polls=0;
    const jobs=new StudioJobs(store,{provider:{submit:async()=>{resubmits++;throw Error('must not resubmit');},poll:async handle=>{polls++;assert.equal(handle.id,'accepted-operation');return {state:'complete',url:'https://fixture.invalid/video'};},download:async()=>Buffer.from('recovered fixture')},validateMedia:async()=>({duration:3,width:1280,height:720})});
    t.after(async()=>{await jobs.close();store.close();});assert.equal(store.createJob(projectId,'generation','retry-new-key',input).id,jobId);await jobs.step(jobId);
    assert.equal(store.job(jobId).job.state,phase==='submitting'?'uncertain':'complete');assert.equal(resubmits,0);assert.equal(polls,phase==='submitting'?0:1);assert.equal(readFileSync(join(dir,'submits'),'utf8'),'1\n');assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  });
});

function nasReceipt(id,asset){return {id:'nas-record',source_task_id:id,kind:'studio-v3-video',size:asset.bytes,metadata:{assetHash:asset.hash},public_url:'https://media.invalid/final.mp4'};}
test('wrong NAS receipt never claims archive complete and leaves the valid local artifact unchanged',async t=>{
  const faults={missingId:r=>{delete r.id;},wrongJob:r=>{r.source_task_id='foreign-job';},wrongKind:r=>{r.kind='other-kind';},wrongSize:r=>{r.size++;},wrongHash:r=>{r.metadata.assetHash='0'.repeat(64);},missingMetadata:r=>{delete r.metadata;}};
  for(const [name,corrupt] of Object.entries(faults))await t.test(name,async t=>{
    const {store,p}=fixture(t),job=store.createJob(p.id,'export','archive-fault',{project:p});store.completeJob(job.id,{name:'local.mp4',kind:'video',mime:'video/mp4'},Buffer.from('local bytes'),{frames:240});const asset=store.getAsset(store.job(job.id).job.outputAssetId).asset;
    let uploads=0;const jobs=new StudioJobs(store,{archiveVideo:async id=>{uploads++;const receipt=nasReceipt(id,asset);corrupt(receipt);return receipt;}});t.after(()=>jobs.close());
    for(let i=0;i<4;i++)await jobs.step(job.id);const result=store.job(job.id).job;assert.equal(result.state,'complete');assert.equal(result.output.archive.state,'failed');assert.equal(uploads,3);assert.equal(result.outputAssetId,asset.id);assert.equal(digest(store.assetBytes(asset.id)),asset.hash);assert.equal(store.getProject(p.id).assets.length,1);
  });
});

test('archive acceptance lost before SQLite commit resumes the same task, never rerenders, and records deduplication',async t=>{
  const dir=directory(t);let store=new StudioStore(dir);const p=store.createProject(createProject()),job=store.createJob(p.id,'export','archive-resume',{project:p});store.completeJob(job.id,{name:'local.mp4',kind:'video',mime:'video/mp4'},Buffer.from('local video'));const asset=store.getAsset(store.job(job.id).job.outputAssetId).asset;
  let calls=0;const archiveVideo=async(id,_path,_name,metadata)=>{calls++;assert.equal(id,job.id);assert.equal(metadata.assetHash,asset.hash);return {...nasReceipt(id,asset),deduped:calls>1};};
  let jobs=new StudioJobs(store,{archiveVideo});const update=store.updateJob.bind(store);store.updateJob=(id,patch,priv)=>{if(priv?.archiveState==='complete'||priv?.archiveState==='pending')throw Error('injected SQLite interruption');return update(id,patch,priv);};
  await assert.rejects(jobs.step(job.id),/SQLite interruption/);assert.equal(store.job(job.id).private.archiveState,'running');await jobs.close();store.close();
  store=new StudioStore(dir);let renders=0;jobs=new StudioJobs(store,{archiveVideo,exportSequence:async()=>{renders++;throw Error('must not rerender');}});t.after(async()=>{await jobs.close();store.close();});await jobs.step(job.id);await jobs.step(job.id);
  assert.equal(calls,2);assert.equal(renders,0);assert.equal(store.job(job.id).job.output.archive.state,'complete');assert.equal(store.job(job.id).job.output.archive.deduped,true);assert.equal(store.getProject(p.id).assets.length,1);
});
