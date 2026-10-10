import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { StudioStore } from './store.mjs';
import { StudioJobs } from './jobs.mjs';
import { StudioProvider, SubmissionError } from './provider.mjs';
import { createStudioRouter } from './router.mjs';
import { createProject, clone, digest, protectedUpdate } from './domain.mjs';
import { sceneSchema, validateSceneProgram, inspectVideo, NR_PARAMETERS, NR_RUNTIME, SCENE_MODEL } from './code-jobs.mjs';

const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
function program(film='three-knocks') {return {schemaVersion:1,id:'fixture-program',title:'Fixture story',film,fps:24,width:1280,height:720,totalFrames:1440,seed:42,shots:sceneSchema()['x-film-actions'][film].map((kind,i)=>({id:`s${String(i+1).padStart(2,'0')}`,startFrame:i*144,endFrame:(i+1)*144,camera:{position:[0,2,8],positionEnd:[1,2,8],target:[0,1,0],targetEnd:[0,1,0],lensMm:35},action:{kind,startFrame:0,endFrame:143}}))};}
const modelReceipt=content=>({content,provenance:{requestedModel:SCENE_MODEL,actualModel:SCENE_MODEL,requestBodyHash:digest('request'),responseHash:digest(content)}});
const provider=generate=>({capabilities:()=>({llm:true,video:false}),generateScene:generate||(async()=>modelReceipt(JSON.stringify(program())))});
function temporary(t){const dir=mkdtempSync(join(tmpdir(),'studio-code-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;}
function project(store,visitor=A){const p=createProject({demo:false});p.totalFrames=p.sequence.totalFrames=1440;return store.createProject(p,visitor);}
async function server(t,options={}){
  const dir=temporary(t),router=createStudioRouter({dataDir:dir,token:'fixture',provider:provider(),codeWorkerUrl:'http://worker.invalid',codeWorkerToken:'worker-fixture',startJobs:false,...options,jobsOptions:{...options.jobsOptions,codeOptions:{runtimeHashProvider:async()=>'a'.repeat(64),...options.jobsOptions?.codeOptions}}});router.jobs.tick=()=>{};
  const app=createServer((req,res)=>router.handle(req,res));app.listen(0,'127.0.0.1');await once(app,'listening');t.after(async()=>{app.closeAllConnections();await new Promise(r=>app.close(r));await router.close();});
  const call=async(path,body,visitor=A,method=body===undefined?'GET':'POST')=>{const response=await fetch(`http://127.0.0.1:${app.address().port}/api/v3${path}`,{method,headers:{authorization:'Bearer fixture',...(visitor?{'x-studio-visitor-id':visitor}:{}),'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const raw=await response.text();let value;try{value=JSON.parse(raw);}catch{value={raw};}return {status:response.status,...value};};
  return {router,store:router.store,jobs:router.jobs,call,dir};
}
function sceneRequest(p,key='scene'){return {baseRevision:p.revision,idempotencyKey:key,film:'three-knocks',prompt:'Preserve the story and adjust staging.'};}
function renderRequest(p,key='render'){return {baseRevision:p.revision,idempotencyKey:key,sceneId:p.scenes[0].id,sceneRevision:p.scenes[0].revision,backends:['three-webgl','remotion']};}

 test('anonymous ownership isolates projects, media, jobs and all mutation routes; internal compatibility remains',async t=>{
  const f=await server(t),a=project(f.store,A),b=project(f.store,B),old=project(f.store,null),asset=f.store.addAsset(b.id,{name:'private.png',kind:'image',mime:'image/png'},PNG).asset;
  const job=f.store.createJob(b.id,'render','private',{spec:{}});
  assert.deepEqual((await f.call('/projects')).data.map(v=>v.id),[a.id]);
  for(const path of [`/projects/${b.id}`,`/projects/${old.id}`,`/assets/${asset.id}/content`,`/jobs/${job.id}`,`/projects/${b.id}/jobs`])assert.equal((await f.call(path)).status,404,path);
  assert.equal((await f.call(`/jobs/${job.id}/cancel`,{})).status,404);
  assert.equal((await f.call(`/projects/${b.id}/assets`,{name:'x',kind:'image',mime:'image/png',base64:PNG.toString('base64')})).status,404);
  assert.equal((await f.call(`/projects/${old.id}`,undefined,null)).status,200);
  assert.equal((await f.call('/projects',undefined,'malformed')).status,400);
  const created=await f.call('/projects',{name:'Owned',demo:false});assert.equal(created.status,200);assert.equal(f.store.ownsProject(created.data.id,A),true);assert.equal((await f.call(`/projects/${created.data.id}`,undefined,B)).status,404);
});

test('explicit public demo is read-only, copies assets by new IDs and strips paid approvals/takes',async t=>{
  const dir=temporary(t),seed=new StudioStore(dir);let p=seed.createProject(createProject());const asset=seed.addAsset(p.id,{name:'ref.png',kind:'image',mime:'image/png'},PNG).asset;p=seed.change(p.id,1,c=>{c.shots[0].firstAssetId=asset.id;return c;});seed.close();
  const f=await server(t,{dataDir:dir,publicDemoProjectIds:[p.id]});const before=digest(f.store.getProject(p.id));
  assert.equal((await f.call(`/projects/${p.id}`)).data.access.readOnly,true);assert.equal((await f.call(`/assets/${asset.id}/content`)).status,200);
  assert.equal((await f.call(`/projects/${p.id}`,{baseRevision:p.revision,project:p},A,'PUT')).status,403);assert.equal((await f.call(`/projects/${p.id}/jobs`)).status,403);
  const copied=await f.call(`/projects/${p.id}/copy`,{});assert.equal(copied.status,200);assert.notEqual(copied.data.id,p.id);assert.notEqual(copied.data.assets[0].id,asset.id);assert.equal(copied.data.assets[0].hash,asset.hash);assert.equal(copied.data.shots[0].firstAssetId,copied.data.assets[0].id);assert.equal((await f.call(`/assets/${copied.data.assets[0].id}/content`,undefined,B)).status,404);assert.equal(digest(f.store.getProject(p.id)),before);
});

test('scene generation fixes Opus 5.5, records provenance, checkpoints valid output, replays key after revision change',async t=>{
  let count=0;const f=await server(t,{provider:provider(async()=>{count++;return modelReceipt(JSON.stringify(program()));})}),p=project(f.store),body=sceneRequest(p);
  const accepted=await f.call(`/projects/${p.id}/scene-generations`,body);assert.equal(accepted.status,200);const id=accepted.data.id;
  await f.jobs.step(id);const job=f.store.job(id);assert.equal(job.job.state,'complete');assert.equal(job.job.output.actualModel,SCENE_MODEL);assert.equal(job.private.attempts,1);assert.equal(job.private.provenance.length,1);
  f.store.change(p.id,p.revision,c=>{c.name='Saved while model ran';return c;});
  assert.equal((await f.call(`/projects/${p.id}/scene-generations`,body)).data.id,id);assert.equal(count,1);
  assert.equal((await f.call(`/projects/${p.id}/scene-generations`,{...body,prompt:'different'})).status,409);
  assert.equal((await f.call(`/jobs/${id}/retry`,{idempotencyKey:'retry'})).status,409);
});

test('only explicit invalid JSON can cause two repairs; third invalid result is final',async t=>{
  let count=0;const f=await server(t,{provider:provider(async(_input,options)=>{count++;if(count>1)assert.equal(options.repair.index,count-1);return modelReceipt(count<3?'not JSON':JSON.stringify(program()));})}),p=project(f.store),job=(await f.call(`/projects/${p.id}/scene-generations`,sceneRequest(p))).data;
  for(let n=0;n<3;n++)await f.jobs.step(job.id);assert.equal(f.store.job(job.id).job.state,'complete');assert.equal(count,3);
  f.jobs.code.provider=provider(async()=>modelReceipt('{bad'));const bad=(await f.call(`/projects/${p.id}/scene-generations`,sceneRequest(p,'bad'))).data;
  for(let n=0;n<6;n++)await f.jobs.step(bad.id);assert.equal(f.store.job(bad.id).private.attempts,3);assert.equal(f.store.job(bad.id).job.stage,'validation_failed');assert.equal(f.store.job(bad.id).job.retryable,false);
});

test('unknown model acceptance and process restart never resubmit; different returned model fails without repair',async t=>{
  let calls=0;const f=await server(t,{provider:provider(async()=>{calls++;throw new SubmissionError('lost response');})}),p=project(f.store),j=(await f.call(`/projects/${p.id}/scene-generations`,sceneRequest(p))).data;
  await f.jobs.step(j.id);assert.equal(f.store.job(j.id).job.state,'uncertain');await f.jobs.step(j.id);assert.equal(calls,1);assert.equal((await f.call(`/jobs/${j.id}/retry`,{idempotencyKey:'retry'})).status,409);
  const interrupted=f.store.createJob(p.id,'scene-generation','interrupt',{...f.store.job(j.id).private.input,prompt:'another'});f.store.updateJob(interrupted.id,{state:'running'},{phase:'submitting',attempts:1});f.store.recoverJobs();assert.equal(f.store.job(interrupted.id).job.state,'uncertain');
  f.jobs.code.provider=provider(async()=>({content:JSON.stringify(program()),provenance:{requestedModel:SCENE_MODEL,actualModel:'different-model'}}));const mismatch=(await f.call(`/projects/${p.id}/scene-generations`,sceneRequest(p,'mismatch'))).data;
  // The original uncertain input coalesces, so submit a distinct authoring intent.
  if(mismatch.id===j.id){const b={...sceneRequest(p,'different'),prompt:'distinct staging'};const value=(await f.call(`/projects/${p.id}/scene-generations`,b)).data;await f.jobs.step(value.id);assert.equal(f.store.job(value.id).job.state,'failed');assert.equal(f.store.job(value.id).private.attempts,1);}else assert.fail('uncertain same input must coalesce');
});

test('generation apply uses CAS, one undo, provenance binding; render freezes latest editable scene in both backends',async t=>{
  const f=await server(t),p=project(f.store),j=(await f.call(`/projects/${p.id}/scene-generations`,sceneRequest(p))).data;await f.jobs.step(j.id);
  const scene={...clone(p.scenes[0]),id:'compiled',name:'Code scene',codeProgram:program(),objects:['ashuan','scout'].map((id,i)=>({id,name:id,kind:'character',transform:{position:[i,0,0],rotation:[0,0,0,1],scale:[1,1,1]},color:'#aaa',visible:true,locked:false})),cameras:program().shots.map(s=>({...clone(p.scenes[0].cameras[0]),id:`fixture-program-${s.id}`})),activeCameraId:'fixture-program-s01'},apply={baseRevision:p.revision,commandId:'apply-once',scene};
  assert.equal((await f.call(`/projects/${p.id}/scene-generations/${j.id}/apply`,{...apply,baseRevision:9})).status,409);
  const result=await f.call(`/projects/${p.id}/scene-generations/${j.id}/apply`,apply);assert.equal(result.status,200);let live=result.data.project;const generated=live.scenes.find(s=>s.id===result.data.sceneId);assert.equal(generated.codeGenerationJobId,j.id);
  const forged=clone(live);forged.scenes.at(-1).codeProgram.seed++;assert.throws(()=>protectedUpdate(live,forged),/server owned/);
  live=f.store.change(p.id,live.revision,c=>{c.scenes.at(-1).cameras[0].position=[7,3,8];c.scenes.at(-1).revision++;return c;});
  const rendered=await f.call(`/projects/${p.id}/renders`,{...renderRequest(live),sceneId:generated.id,sceneRevision:1,sceneGenerationJobId:j.id});assert.equal(rendered.status,200);assert.equal(rendered.data.jobs.length,2);
  const specs=rendered.data.jobs.map(v=>f.store.job(v.id).private.input.spec);assert.equal(specs[0].specHash,specs[1].specHash);assert.equal(specs[0].sceneSnapshotHash,specs[1].sceneSnapshotHash);assert.notEqual(specs[0].backend,specs[1].backend);assert.deepEqual(specs[0].sceneSnapshot.cameras[0].position,[7,3,8]);
  f.store.change(p.id,live.revision,c=>{c.scenes.at(-1).cameras[0].position=[2,2,2];return c;});assert.deepEqual(f.store.job(rendered.data.jobs[0].id).private.input.spec.sceneSnapshot.cameras[0].position,[7,3,8]);
  const history=f.store.db.prepare('SELECT before_json,after_json FROM history WHERE project_id=? AND command_id=?').get(p.id,'apply-once');assert.equal(JSON.parse(history.after_json).shots.length-JSON.parse(history.before_json).shots.length,10);assert.equal(JSON.parse(history.after_json).nodes.length-JSON.parse(history.before_json).nodes.length,11);
});

test('schema rejects executable fields, mismatched film actions, bad blocking and non-monotonic beats',()=>{
  validateSceneProgram(program());for(const mutation of [p=>p.script='process.exit()',p=>p.shots[0].action.kind='grow-light',p=>p.shots[0].blocking=[{id:'fox',position:[0,0,0],yaw:0}],p=>p.shots[0].action.beatFrames=[40,20,60],p=>p.shots[0].camera.target=p.shots[0].camera.position]){const value=program();mutation(value);assert.throws(()=>validateSceneProgram(value));}
});

function workerFixture(t,{fetchImpl,inspectMedia}={}){
  const dir=temporary(t),store=new StudioStore(dir),p=project(store),jobs=new StudioJobs(store,{provider:provider(),codeWorkerUrl:'http://worker.invalid',codeWorkerToken:'test-worker',fetchImpl,pollIntervalMs:0,codeOptions:{inspectMedia:inspectMedia||(async()=>({fps:24,frames:1440,duration:60,width:1280,height:720}))}});t.after(async()=>{await jobs.close();store.close();});
  const make=(key='render',kind='render',spec={})=>store.createJob(p.id,kind,key,{sourceRevision:0,spec:{schemaVersion:1,backend:'three-webgl',fps:24,width:1280,height:720,totalFrames:1440,...(kind==='enhancement'?{sourceAssetId:'source-fixture',sourceHash:digest('source')}:{}),...spec},assets:[]});
  return {dir,store,p,jobs,make};
}
function output(job,bytes=Buffer.from('video'),role='base',name='base.mp4'){return {name,mime:'video/mp4',sha256:digest(bytes),bytes:bytes.length,url:`/api/v3/code/media/${job.id}/${name}`,role};}

test('worker accepted response lost: GET reconciles durable identity without a second POST; partial output is checkpointed once',async t=>{
  let job,posts=0,polls=0,downloads=0;const bytes=Buffer.from('video');let f;
  f=workerFixture(t,{fetchImpl:async(url,opts={})=>{const identity={jobRef:job.id,inputHash:f.store.job(job.id).private.inputHash};if(opts.method==='POST'){posts++;throw new Error('response lost after acceptance');}if(String(url).includes('/media/')){downloads++;return new Response(bytes);}polls++;return Response.json({...identity,status:polls===1?'running':'complete',stage:'rendering',outputs:polls===1?[]:[output(job,bytes)]});}});job=f.make();await f.jobs.step(job.id);assert.equal(f.store.job(job.id).job.stage,'waiting_for_worker');await f.jobs.step(job.id);await f.jobs.step(job.id);assert.equal(f.store.job(job.id).job.state,'complete');assert.equal(posts,1);assert.equal(downloads,1);await f.jobs.step(job.id);assert.equal(f.store.getProject(f.p.id).assets.length,1);assert.equal(f.store.job(job.id).private.archiveState,undefined);
});

test('worker hash/origin/identity mismatch is rejected before any output download or asset checkpoint',async t=>{
  for(const mismatch of ['identity','hash','origin']){let f,job,downloads=0;f=workerFixture(t,{fetchImpl:async(url,opts={})=>{const identity={jobRef:job.id,inputHash:f.store.job(job.id).private.inputHash};if(opts.method==='POST')return Response.json({...identity,status:'queued'});if(String(url).includes('/media/')){downloads++;return new Response('video');}const item=output(job);if(mismatch==='origin')item.url='https://evil.invalid/api/v3/code/media/'+job.id+'/base.mp4';return Response.json({...identity,...(mismatch==='identity'?{jobRef:'other'}:{}),...(mismatch==='hash'?{inputHash:'f'.repeat(64)}:{}),status:'complete',outputs:[item]});}});job=f.make();await f.jobs.step(job.id);await f.jobs.step(job.id);assert.equal(f.store.job(job.id).job.state,'failed');assert.equal(downloads,0);assert.equal(f.store.getProject(f.p.id).assets.length,0);}
});

test('partial worker assets survive failed task retry and reopening SQLite; retry action key is idempotent',async t=>{
  let f,job,poll=0,retries=0,downloads=0;const bytes=Buffer.from('clean');f=workerFixture(t,{fetchImpl:async(url,opts={})=>{const identity={jobRef:job.id,inputHash:f.store.job(job.id).private.inputHash};if(String(url).endsWith('/retry')){retries++;return Response.json({...identity,status:'queued'});}if(opts.method==='POST')return Response.json({...identity,status:'queued'});if(String(url).includes('/media/')){downloads++;return new Response(bytes);}poll++;return Response.json({...identity,status:poll===1?'failed':'complete',outputs:[output(job,bytes,'clean','clean.mp4'),...(poll>1?[output(job,bytes)]:[])],error:'final encode failed'});}});job=f.make();await f.jobs.step(job.id);await f.jobs.step(job.id);assert.equal(f.store.job(job.id).job.state,'failed');assert.equal(f.store.job(job.id).job.partialAssets.length,1);
  f.jobs.code.retry(job.id,'retry-1');f.jobs.code.retry(job.id,'retry-1');await f.jobs.step(job.id);await f.jobs.step(job.id);assert.equal(f.store.job(job.id).job.state,'complete');assert.equal(retries,1);assert.equal(downloads,2);const read=new StudioStore(f.dir);assert.equal(read.job(job.id).job.partialAssets.length,2);read.close();
});

test('cancellation persists while worker offline and only acknowledges confirmed cancellation',async t=>{
  let f,job,offline=true;f=workerFixture(t,{fetchImpl:async(_url,opts={})=>{if(offline)throw Error('offline');return Response.json({jobRef:job.id,inputHash:f.store.job(job.id).private.inputHash,status:opts.method==='POST'?'cancelled':'running'});}});job=f.make();f.store.updateJob(job.id,{state:'running'},{phase:'accepted',handle:{id:job.id},workerOrigin:'http://worker.invalid'});f.jobs.code.cancel(job.id);await f.jobs.step(job.id);assert.notEqual(f.store.job(job.id).job.state,'cancelled');assert.equal(f.store.job(job.id).private.cancelRequested,true);offline=false;await f.jobs.step(job.id);assert.equal(f.store.job(job.id).job.state,'cancelled');
});

test('NR requires real Feature18 evidence and exact pinned parameters, before copying even a playable enhanced output',async t=>{
  for(const valid of [false,true]){let f,job,downloads=0;f=workerFixture(t,{fetchImpl:async(url,opts={})=>{const identity={jobRef:job.id,inputHash:f.store.job(job.id).private.inputHash};if(opts.method==='POST')return Response.json({...identity,status:'queued'});if(String(url).includes('/media/')){downloads++;return new Response('video');}return Response.json({...identity,status:'complete',outputs:[output(job,Buffer.from('video'),'enhanced')],receipt:{sourceAssetId:f.store.job(job.id).private.input.spec.sourceAssetId,sourceHash:f.store.job(job.id).private.input.spec.sourceHash,neuralInputHash:f.store.job(job.id).private.input.spec.cleanSourceHash||f.store.job(job.id).private.input.spec.sourceHash,runtime:NR_RUNTIME,parameters:NR_PARAMETERS,nr:{featureId:18,created:true,evaluated:valid,verifiedNeuralFrames:null}}});}});job=f.make('nr','enhancement',{parameters:NR_PARAMETERS});await f.jobs.step(job.id);await f.jobs.step(job.id);assert.equal(f.store.job(job.id).job.state,valid?'complete':'failed');assert.equal(downloads,valid?1:0);}
});

test('unknown persisted kind fails explicitly instead of falling into the FFmpeg exporter',async t=>{
  const f=workerFixture(t),j=f.store.createJob(f.p.id,'invented','unknown',{});await f.jobs.step(j.id);assert.equal(f.store.job(j.id).job.state,'failed');assert.match(f.store.job(j.id).job.error,/Unknown job kind/);
});

test('real ffprobe rejects wrong frame count through the worker completion path',async t=>{
  const dir=temporary(t),file=join(dir,'tiny.mp4');execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','color=blue:s=1280x720:r=24','-frames:v','24','-c:v','libx264','-threads','1','-pix_fmt','yuv420p',file]);const bytes=readFileSync(file),media=await inspectVideo(file);assert.equal(media.frames,24);assert.equal(media.fps,24);
  let f,job;f=workerFixture(t,{inspectMedia:inspectVideo,fetchImpl:async(url,opts={})=>{const identity={jobRef:job.id,inputHash:f.store.job(job.id).private.inputHash};return opts.method==='POST'?Response.json({...identity,status:'queued'}):String(url).includes('/media/')?new Response(bytes):Response.json({...identity,status:'complete',outputs:[output(job,bytes)]});}});job=f.make();await f.jobs.step(job.id);await f.jobs.step(job.id);assert.equal(f.store.job(job.id).job.state,'failed');assert.equal(f.store.getProject(f.p.id).assets.length,0);
});

test('provider transmits fixed model and captures real response identity; timeout has no automatic transport retry',async()=>{
  let calls=0,body,prepared;const api=new StudioProvider({llm:{baseUrl:'https://model.invalid/v1',apiKey:'fixture-secret',model:'ignored-sonnet'}},{fetchImpl:async(_u,opts)=>{calls++;body=JSON.parse(opts.body);return Response.json({id:'response-1',model:SCENE_MODEL,choices:[{message:{content:JSON.stringify(program())},finish_reason:'stop'}],usage:{total_tokens:100}});}});
  const result=await api.generateScene({film:'three-knocks',prompt:'test',context:{},totalFrames:1440,aspect:'16:9',references:[]},{schema:JSON.stringify(sceneSchema()),onPrepared:p=>prepared=p});assert.equal(body.model,SCENE_MODEL);assert.equal(result.provenance.actualModel,SCENE_MODEL);assert.equal(prepared.requestBodyHash,digest(JSON.stringify(body)));assert.equal(calls,1);assert.ok(!JSON.stringify(prepared).includes('fixture-secret'));
});

test('source video enhancement binds source hash, uses clean render checkpoint, and freezes original audio/subtitle sequence',async t=>{
  const f=await server(t,{jobsOptions:{codeOptions:{inspectMedia:async()=>({fps:24,frames:1440,duration:60,width:1280,height:720,hasAudio:true,audioPacketHash:'a'.repeat(64)})}}});let p=project(f.store);
  const audio=f.store.addAsset(p.id,{name:'score.wav',kind:'audio',mime:'audio/wav'},Buffer.from('audio')).asset;p=f.store.getProject(p.id);
  p=f.store.change(p.id,p.revision,c=>{c.sequence.clips.push({id:'music',kind:'audio',track:1,startFrame:0,endFrame:1440,sourceIn:0,assetId:audio.id,volume:.6,fadeIn:0,fadeOut:24},{id:'subtitle',kind:'text',track:2,startFrame:0,endFrame:1440,sourceIn:0,text:'门外三声',x:.5,y:.8,fontSize:36,volume:1,fadeIn:0,fadeOut:0});return c;});
  const render=(await f.call(`/projects/${p.id}/renders`,{...renderRequest(p),backends:['three-webgl']})).data.jobs[0];
  const clean=f.store.checkpointOutput(render.id,'clean.mp4',{name:'clean.mp4',kind:'video',mime:'video/mp4',metadata:{jobId:render.id}},Buffer.from('clean'),{role:'clean'});
  const base=f.store.checkpointOutput(render.id,'base.mp4',{name:'base.mp4',kind:'video',mime:'video/mp4',metadata:{jobId:render.id}},Buffer.from('base'),{role:'base'});f.store.updateJob(render.id,{state:'complete',outputAssetId:base.id});p=f.store.getProject(p.id);
  const request={baseRevision:p.revision,idempotencyKey:'enhance',sourceAssetId:base.id,sourceHash:base.hash};const response=await f.call(`/projects/${p.id}/enhancements`,request);assert.equal(response.status,200);
  const input=f.store.job(response.data.id).private.input;assert.equal(input.spec.sourceAssetId,base.id);assert.equal(input.spec.cleanSourceAssetId,clean.id);assert.equal(input.spec.cleanSourceHash,clean.hash);assert.deepEqual(input.spec.parameters,NR_PARAMETERS);assert.equal(input.spec.sequence.clips.length,2);assert.ok(input.assets.some(a=>a.id===audio.id));
  assert.equal((await f.call(`/projects/${p.id}/enhancements`,{...request,idempotencyKey:'bad',sourceHash:'f'.repeat(64)})).status,409);
  assert.equal((await f.call(`/projects/${p.id}/enhancements`,{...request,idempotencyKey:'bad2',parameters:{stages:'sr'}})).status,422);
});

test('scene response checkpoint survives restart without paying again; cancelling a slow model discards late result',async t=>{
  const f=await server(t),p=project(f.store);const j=(await f.call(`/projects/${p.id}/scene-generations`,sceneRequest(p))).data;let calls=0;f.jobs.code.provider=provider(async()=>{calls++;throw Error('must not submit');});
  f.store.updateJob(j.id,{state:'running'},{phase:'validating',attempts:1,response:modelReceipt(JSON.stringify(program())),provenance:[modelReceipt('').provenance]});f.store.recoverJobs();await f.jobs.step(j.id);assert.equal(f.store.job(j.id).job.state,'complete');assert.equal(calls,0);
  let finish,entered;const gate=new Promise(r=>finish=r),started=new Promise(r=>entered=r);f.jobs.code.provider=provider(async()=>{entered();await gate;return modelReceipt(JSON.stringify(program()));});const other=(await f.call(`/projects/${p.id}/scene-generations`,{...sceneRequest(p,'cancel-scene'),prompt:'different movement'})).data;const running=f.jobs.step(other.id);await started;f.jobs.code.cancel(other.id);finish();await running;assert.equal(f.store.job(other.id).job.state,'cancelled');assert.equal(f.store.job(other.id).job.sceneProgram,undefined);
});

test('real worker video output passes exact-frame and source AAC packet checks',async t=>{
  const dir=temporary(t),file=join(dir,'source.mp4');execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','color=green:s=1280x720:r=24','-f','lavfi','-i','sine=frequency=330:sample_rate=48000','-t','1','-c:v','libx264','-threads','1','-c:a','aac','-pix_fmt','yuv420p',file]);const bytes=readFileSync(file),sourceMedia=await inspectVideo(file);assert.equal(sourceMedia.frames,24);assert.ok(sourceMedia.audioPacketHash);
  let f,job;f=workerFixture(t,{inspectMedia:inspectVideo,fetchImpl:async(url,opts={})=>{const identity={jobRef:job.id,inputHash:f.store.job(job.id).private.inputHash};return opts.method==='POST'?Response.json({...identity,status:'queued'}):String(url).includes('/media/')?new Response(bytes):Response.json({...identity,status:'complete',outputs:[output(job,bytes,'enhanced')],receipt:{sourceAssetId:f.store.job(job.id).private.input.spec.sourceAssetId,sourceHash:f.store.job(job.id).private.input.spec.sourceHash,neuralInputHash:f.store.job(job.id).private.input.spec.cleanSourceHash||f.store.job(job.id).private.input.spec.sourceHash,runtime:NR_RUNTIME,parameters:NR_PARAMETERS,nr:{featureId:18,created:true,evaluated:true,verifiedNeuralFrames:null}}});}});job=f.make('actual','enhancement',{totalFrames:24,sourceMedia,parameters:NR_PARAMETERS});await f.jobs.step(job.id);await f.jobs.step(job.id);assert.equal(f.store.job(job.id).job.state,'complete');assert.equal(f.store.getProject(f.p.id).assets[0].metadata.audioPacketHash,sourceMedia.audioPacketHash);
  const second=f.make('wrong-audio','enhancement',{totalFrames:24,sourceMedia:{...sourceMedia,audioPacketHash:'0'.repeat(64)},parameters:NR_PARAMETERS});job=second;await f.jobs.step(second.id);await f.jobs.step(second.id);assert.equal(f.store.job(second.id).job.state,'failed');assert.equal(f.store.getProject(f.p.id).assets.length,1);
});

test('capabilities reflect unavailable/offline worker and do not promise NR on configured URLs alone',async t=>{
  const f=await server(t,{fetchImpl:async()=>{throw Error('offline');}});const caps=await f.call('/capabilities');assert.equal(caps.status,200);assert.equal(caps.data.codeWorker.configured,true);assert.equal(caps.data.dlss.available,false);assert.equal(caps.data.renderers['three-webgl'].available,false);assert.equal(caps.data.sceneGeneration.model,SCENE_MODEL);
});

test('renderer siblings commit atomically; a failed second insert cannot leave a half group',async t=>{
  const f=await server(t),p=project(f.store),create=f.store.createJob.bind(f.store);let n=0;f.store.createJob=(...args)=>{if(++n===2)throw Error('simulated SQLite write failure');return create(...args);};
  const response=await f.call(`/projects/${p.id}/renders`,renderRequest(p));assert.equal(response.status,500);assert.equal(f.store.listJobs(p.id).length,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM job_receipts').get().n,0);
});

test('runtime hash is persisted per worker origin and freezes offline requests; unverified first worker rejects',async t=>{
  const f=await server(t,{jobsOptions:{codeOptions:{runtimeHashProvider:undefined}},fetchImpl:async()=>Response.json({available:true,runtimeHash:'c'.repeat(64),renderers:{'three-webgl':{available:true},remotion:{available:true}},dlss:{available:false}})}),p=project(f.store);
  const first=await f.call(`/projects/${p.id}/renders`,renderRequest(p));assert.equal(first.status,200);assert.equal(f.store.job(first.data.jobs[0].id).private.input.spec.runtimeHash,'c'.repeat(64));
  f.jobs.code.fetch=async()=>{throw Error('offline');};const second=await f.call(`/projects/${p.id}/renders`,renderRequest(p,'offline'));assert.equal(second.status,200);assert.equal(f.store.job(second.data.jobs[0].id).private.input.spec.runtimeHash,'c'.repeat(64));
  f.jobs.code.workerUrl='http://different-worker.invalid';const changed=await f.call(`/projects/${p.id}/renders`,renderRequest(p,'changed'));assert.equal(changed.status,503);
});

test('schema 2 migration preserves every old project/job and grants no anonymous claim to legacy rows',t=>{
  const dir=temporary(t);let store=new StudioStore(dir);const p=project(store,null),job=store.createJob(p.id,'export','legacy',{project:p});const before=digest(store.getProject(p.id));store.db.exec('DROP TABLE worker_versions; DROP TABLE job_actions; DROP TABLE project_owners; PRAGMA user_version=2;');store.close();store=new StudioStore(dir);t.after(()=>store.close());assert.equal(digest(store.getProject(p.id)),before);assert.equal(store.job(job.id).job.id,job.id);assert.equal(store.ownsProject(p.id,A),false);assert.equal(store.ownsProject(p.id,undefined),true);assert.equal(store.db.prepare('PRAGMA user_version').get().user_version,4);
});

test('render rejects external GLB resource references before contacting worker',async t=>{
  let calls=0;const f=workerFixture(t,{fetchImpl:async()=>{calls++;throw Error('must not contact worker');}}),json=Buffer.from(JSON.stringify({asset:{version:'2.0'},nodes:[],buffers:[{uri:'http://169.254.169.254/private',byteLength:4}]}));const padded=Buffer.alloc(Math.ceil(json.length/4)*4,32);json.copy(padded);const glb=Buffer.alloc(20+padded.length);glb.writeUInt32LE(0x46546c67);glb.writeUInt32LE(2,4);glb.writeUInt32LE(glb.length,8);glb.writeUInt32LE(padded.length,12);glb.writeUInt32LE(0x4e4f534a,16);padded.copy(glb,20);
  const asset=f.store.addAsset(f.p.id,{name:'unsafe.glb',kind:'model',mime:'model/gltf-binary'},glb).asset,job=f.store.createJob(f.p.id,'render','unsafe',{spec:{backend:'three-webgl'},assets:[{id:asset.id,hash:asset.hash}]});await f.jobs.step(job.id);assert.equal(f.store.job(job.id).job.state,'failed');assert.equal(calls,0);
});

test('shared JSON schema byte identity matches source contract when source tree is present',t=>{
  let shared;try{shared=readFileSync(new URL('../../web/lib/studio/code-scene/scene-program.schema.json',import.meta.url));}catch{t.skip('gateway-only deployment: source schema is not bundled');return;}assert.equal(digest(shared),digest(readFileSync(new URL('./code-scene-schema.json',import.meta.url))));
});

test('copied code scene preserves read-only provenance without granting access to the source model job',async t=>{
  const f=await server(t),p=project(f.store,A),j=f.store.createJob(p.id,'scene-generation','imported',{sourceRevision:0});const value=program();
  f.store.updateJob(j.id,{state:'complete',sceneProgram:value},{phase:'complete',sceneProgram:value});
  const scene={...clone(p.scenes[0]),codeProgram:value,codeProgramHash:digest(value),codeGenerationJobId:j.id};f.store.change(p.id,0,c=>{c.scenes[0]=scene;return c;});
  const copied=await f.call(`/projects/${p.id}/copy`,{},A);assert.equal(copied.status,200);const next=copied.data;assert.equal(next.scenes[0].codeGenerationJobId,j.id);
  // Internal demo copying into B models the same trusted copy operation after public allowlisting.
  const {copyDemo}=await import('./code-routes.mjs');const other=copyDemo(f.store,f.store.getProject(p.id),B);assert.equal((await f.call(`/jobs/${j.id}`,undefined,B)).status,404);
  const response=await f.call(`/projects/${other.id}/renders`,{...renderRequest(other),sceneGenerationJobId:j.id},B);assert.equal(response.status,200);assert.equal(f.store.job(response.data.jobs[0].id).private.input.spec.sceneProgram.id,value.id);
});

test('worker output cancellation during download cannot publish a late artifact or strand cancellation as failed',async t=>{
  let f,job,release,started;const waiting=new Promise(r=>release=r),entered=new Promise(r=>started=r);f=workerFixture(t,{fetchImpl:async(url,opts={})=>{const identity={jobRef:job.id,inputHash:f.store.job(job.id).private.inputHash};if(String(url).endsWith('/cancel'))return Response.json({...identity,status:'cancelled'});if(opts.method==='POST')return Response.json({...identity,status:'queued'});if(String(url).includes('/media/')){started();await waiting;return new Response('video');}return Response.json({...identity,status:'complete',outputs:[output(job)]});}});job=f.make();await f.jobs.step(job.id);const downloading=f.jobs.step(job.id);await entered;f.jobs.code.cancel(job.id);release();await downloading;assert.equal(f.store.job(job.id).job.stage,'cancelling');assert.equal(f.store.getProject(f.p.id).assets.length,0);await f.jobs.step(job.id);assert.equal(f.store.job(job.id).job.state,'cancelled');
});

test('a forged NR source receipt fails closed before any download',async t=>{
  let f,job;f=workerFixture(t,{fetchImpl:async(url,opts={})=>{const identity={jobRef:job.id,inputHash:f.store.job(job.id).private.inputHash};if(opts.method==='POST')return Response.json({...identity,status:'queued'});if(String(url).includes('/media/'))throw Error('must not download');return Response.json({...identity,status:'complete',outputs:[output(job,Buffer.from('video'),'enhanced')],receipt:{sourceAssetId:'other',sourceHash:digest('source'),neuralInputHash:digest('source'),runtime:NR_RUNTIME,parameters:NR_PARAMETERS,nr:{featureId:18,created:true,evaluated:true}}});}});job=f.make('wrong-source','enhancement');await f.jobs.step(job.id);await f.jobs.step(job.id);assert.equal(f.store.job(job.id).job.state,'failed');assert.equal(f.store.job(job.id).job.retryable,false);assert.equal(f.store.getProject(f.p.id).assets.length,0);
});

test('registered procedural parts validate without a GLB, while unknown parts or object identities are rejected',async()=>{
  const {validateProject}=await import('./domain.mjs'),p=createProject({demo:false}),s=p.scenes[0];p.totalFrames=p.sequence.totalFrames=1440;s.codeProgram=program();s.codeProgramHash=digest(s.codeProgram);s.codeGenerationJobId='generated-fixture';s.objects=[{id:'airlock-door',name:'Door',kind:'model',transform:{position:[0,0,0],rotation:[0,0,0,1],scale:[1,1,1]},color:'#aaa',visible:true,locked:false,parts:[{id:'part-doorLeaf',transform:{position:[0,0,0],rotation:[0,0,0,1],scale:[1,1,1]},visible:true,locked:false}]}];validateProject(p);
  const unknown=clone(p);unknown.scenes[0].objects[0].parts[0].id='part-invented';assert.throws(()=>validateProject(unknown),/registered model/);const wrong=clone(p);wrong.scenes[0].objects[0].id='invisible-unhandled-object';assert.throws(()=>validateProject(wrong),/registered template/);
});

test('code recipe scenes reject unsupported clip and morph/weight edits through commands and PUT without mutation',async t=>{
  const f=await server(t),p=project(f.store);const live=f.store.change(p.id,p.revision,c=>{const s=c.scenes[0];s.codeProgram=program();s.codeProgramHash=digest(s.codeProgram);s.codeGenerationJobId='generated-fixture';s.objects=[{id:'ashuan',name:'Robot',kind:'character',transform:{position:[0,0,0],rotation:[0,0,0,1],scale:[1,1,1]},color:'#aaa',visible:true,locked:false}];return c;}),s=live.scenes[0];
  const clip={id:'ignored-walk',targetId:'ashuan',clipName:'Walk',startFrame:0,endFrame:24,sourceIn:0,speed:1,weight:1,fadeIn:0,fadeOut:0,mask:'all',additive:false},before=digest(live);
  const commands=[{type:'clip.set',sceneId:s.id,clip},...['morph','weight'].map(property=>({type:'track.set',sceneId:s.id,track:{id:`ignored-${property}`,targetId:'ashuan',property,muted:false,locked:false,keys:[{frame:0,value:1,interpolation:'linear'}]}}))];
  for(const [i,op] of commands.entries()){const response=await f.call(`/projects/${p.id}/commands`,{baseRevision:live.revision,commandId:`unsupported-${i}`,ops:[op]});assert.equal(response.status,422,JSON.stringify(response));assert.equal(digest(f.store.getProject(p.id)),before);}
  const changed=clone(live);changed.scenes[0].clips.push(clip);assert.equal((await f.call(`/projects/${p.id}`,{baseRevision:live.revision,project:changed},A,'PUT')).status,422);assert.equal(digest(f.store.getProject(p.id)),before);
  const ordinary=project(f.store);const normal=f.store.change(ordinary.id,ordinary.revision,c=>{c.scenes[0].objects=clone(s.objects);return c;});const ok=await f.call(`/projects/${normal.id}/commands`,{baseRevision:normal.revision,commandId:'ordinary-walk',ops:[{type:'clip.set',sceneId:normal.scenes[0].id,clip}]});assert.equal(ok.status,200,'ordinary Blender/GLB clip behavior stays available');
});
