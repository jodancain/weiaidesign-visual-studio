import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { createStudioRouter } from './router.mjs';
import { StudioStore } from './store.mjs';
import { StudioJobs } from './jobs.mjs';
import { StudioProvider,SubmissionError } from './provider.mjs';
import { createProject,digest } from './domain.mjs';
import { extractEffectsFrames } from './effects-source.mjs';
import { inspectVideo,SCENE_MODEL } from './code-jobs.mjs';

const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',R='a'.repeat(64);
const media={fps:24,frames:48,totalFrames:48,width:1280,height:720,duration:2,hasAudio:false,audioPacketHash:null};
const frame={frame:0,mime:'image/jpeg',base64:Buffer.from('sample').toString('base64'),hash:digest(Buffer.from('sample'))};
const program=()=>({schemaVersion:1,fps:24,totalFrames:48,width:1280,height:720,seed:42,subtitleProtection:{enabled:true,bottomFraction:.2,paddingPx:12},layers:[{id:'glow',type:'glow',description:'small warm highlight',startFrame:0,endFrame:48,color:'#ffcc66',opacity:.25,keyframes:[{frame:0,x:.5,y:.4,scale:1,opacity:1}],parameters:{radius:.08,softness:.7,pulseHz:.5}}]});
const response=(content=JSON.stringify(program()))=>({content,provenance:{requestedModel:SCENE_MODEL,actualModel:SCENE_MODEL,responseId:'fixture-response',responseHash:digest(content)}});
async function setup(t,options={}){
  const dir=mkdtempSync(join(tmpdir(),'effects-http-'));let calls=0;
  const provider={capabilities:()=>({llm:true}),generateEffects:async(...args)=>{calls++;return options.generate?options.generate(...args):response();}};
  const router=createStudioRouter({dataDir:dir,token:'fixture',provider,codeWorkerUrl:'http://worker.invalid',codeWorkerToken:'private-worker',startJobs:false,...options,jobsOptions:{codeOptions:{runtimeHashProvider:async()=>R,inspectMedia:async()=>media,extractFrames:async()=>[frame],...options.codeOptions}}});router.jobs.tick=()=>{};
  const server=createServer((req,res)=>router.handle(req,res));server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await router.close();rmSync(dir,{recursive:true,force:true});});
  const call=async(path,body,visitor=A,method=body?'POST':'GET')=>{const r=await fetch(`http://127.0.0.1:${server.address().port}/api/v3${path}`,{method,headers:{authorization:'Bearer fixture','x-studio-visitor-id':visitor,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,...await r.json()};};
  const store=router.store,p=store.createProject(createProject({demo:false}),A);
  const render=store.createJob(p.id,'render','base',{spec:{sceneProgram:{film:'three-knocks',shots:[]},sceneSnapshot:{},sequence:{clips:[]}}});
  const asset=store.checkpointOutput(render.id,'base.mp4',{name:'base.mp4',kind:'video',mime:'video/mp4',metadata:{jobId:render.id,role:'base'}},Buffer.from('fixture-source'),{role:'base'});
  store.updateJob(render.id,{state:'complete',outputAssetId:asset.id});
  const planBody=key=>({baseRevision:store.getProject(p.id).revision,sourceAssetId:asset.id,sourceHash:asset.hash,prompt:'Subtle light effects; preserve the source.',autoRender:false,idempotencyKey:key});
  return {dir,store,jobs:router.jobs,call,p,asset,render,planBody,calls:()=>calls};
}
async function plan(f,key='plan'){const r=await f.call(`/projects/${f.p.id}/effects-plans`,f.planBody(key));assert.equal(r.status,200);await f.jobs.step(r.data.id);const j=f.store.job(r.data.id);assert.equal(j.job.state,'complete',j.job.error);return j;}
const renderBody=(f,j,key='render')=>({baseRevision:f.store.getProject(f.p.id).revision,planJobId:j.job.id,planHash:j.job.output.effectsProgramHash,sourceAssetId:f.asset.id,sourceHash:f.asset.hash,idempotencyKey:key});

test('effects plan retains exact source, actual frame checkpoint, owner boundary and idempotent model call',async t=>{
  const f=await setup(t),before=readFileSync(f.store.getAsset(f.asset.id).path),b=f.planBody('once');const r=await f.call(`/projects/${f.p.id}/effects-plans`,b);assert.equal(r.status,200);await f.jobs.step(r.data.id);const j=f.store.job(r.data.id);assert.equal(j.job.state,'complete',j.job.error);assert.deepEqual(j.private.frames,[frame]);assert.equal(j.job.output.sourceHash,f.asset.hash);assert.equal(j.job.output.actualModel,SCENE_MODEL);
  f.store.change(f.p.id,undefined,p=>{p.name='new name';return p;});assert.equal((await f.call(`/projects/${f.p.id}/effects-plans`,b)).data.id,j.job.id);assert.equal(f.calls(),1);assert.equal((await f.call(`/jobs/${j.job.id}`,undefined,B)).status,404);assert.deepEqual(readFileSync(f.store.getAsset(f.asset.id).path),before);
});
test('forged metadata, stale hash, non-code output and cross-owner source are rejected before model',async t=>{
  const f=await setup(t);const forged=f.store.addAsset(f.p.id,{name:'spoof.mp4',kind:'video',mime:'video/mp4',metadata:{jobId:f.render.id,role:'base'}},Buffer.from('spoof')).asset;
  for(const patch of [{sourceAssetId:forged.id,sourceHash:forged.hash},{sourceHash:'f'.repeat(64)}])assert.ok((await f.call(`/projects/${f.p.id}/effects-plans`,{...f.planBody('bad-'+Math.random()),...patch})).status>=400);
  assert.equal((await f.call(`/projects/${f.p.id}/effects-plans`,f.planBody('other'),B)).status,404);
  f.store.updateJob(f.render.id,{}, {input:{spec:{sceneSnapshot:{},sequence:{clips:[]}}}});assert.equal((await f.call(`/projects/${f.p.id}/effects-plans`,f.planBody('generic'))).status,422);assert.equal(f.calls(),0);
});
test('effects explicit invalid JSON permits two repairs only; unknown/restart/model mismatch never resubmits',async t=>{
  let n=0;const f=await setup(t,{generate:async()=>{n++;return response(n<3?'invalid':JSON.stringify(program()));}}),r=await f.call(`/projects/${f.p.id}/effects-plans`,f.planBody('repair'));for(let i=0;i<3;i++)await f.jobs.step(r.data.id);assert.equal(f.store.job(r.data.id).job.state,'complete');assert.equal(n,3);
  f.jobs.code.provider.generateEffects=async()=>{n++;throw new SubmissionError('unknown acceptance');};const u=await f.call(`/projects/${f.p.id}/effects-plans`,{...f.planBody('unknown'),prompt:'another'});await f.jobs.step(u.data.id);assert.equal(f.store.job(u.data.id).job.state,'uncertain');assert.equal((await f.call(`/jobs/${u.data.id}/retry`,{idempotencyKey:'no'})).status,409);
  f.store.change(f.p.id,undefined,p=>{p.name='later';return p;});assert.equal((await f.call(`/projects/${f.p.id}/effects-plans`,{...f.planBody('different-key'),prompt:'another'})).data.id,u.data.id);await f.jobs.step(u.data.id);assert.equal(n,4);
  const crash=f.store.createJob(f.p.id,'effects-plan','crash',{...f.store.job(u.data.id).private.input,prompt:'crash'});f.store.updateJob(crash.id,{state:'running'},{phase:'submitting',attempts:1});f.store.recoverJobs();assert.equal(f.store.job(crash.id).job.state,'uncertain');await f.jobs.step(crash.id);assert.equal(n,4);
  f.jobs.code.provider.generateEffects=async()=>({content:JSON.stringify(program()),provenance:{requestedModel:SCENE_MODEL,actualModel:'wrong-model'}});const m=await f.call(`/projects/${f.p.id}/effects-plans`,{...f.planBody('mismatch'),prompt:'different'});await f.jobs.step(m.data.id);assert.equal(f.store.job(m.data.id).job.state,'failed');assert.equal(f.store.job(m.data.id).private.attempts,1);
});
test('render binds completed plan, deduplicates concurrent different keys and never reruns model on retry',async t=>{
  const f=await setup(t),j=await plan(f),b=renderBody(f,j);const [a,c]=await Promise.all([f.call(`/projects/${f.p.id}/effects-renders`,b),f.call(`/projects/${f.p.id}/effects-renders`,{...b,idempotencyKey:'another'})]);assert.equal(a.status,200);assert.equal(c.status,200);assert.equal(a.data.id,c.data.id);assert.equal(a.data.planJobId,j.job.id);
  const frozen=f.store.job(a.data.id).private.input.spec;assert.equal(frozen.sourceHash,f.asset.hash);assert.equal(frozen.runtimeHash,R);assert.equal(frozen.effectsProgramHash,j.job.output.effectsProgramHash);
  f.store.updateJob(a.data.id,{state:'failed',retryable:true},{phase:'failed'});assert.equal((await f.call(`/projects/${f.p.id}/effects-renders`,{...b,idempotencyKey:'third'})).data.id,a.data.id);assert.equal((await f.call(`/jobs/${a.data.id}/retry`,{idempotencyKey:'resume'})).status,200);assert.equal(f.calls(),1);assert.equal(f.store.listJobs(f.p.id).filter(j=>j.kind==='effects-render').length,1);
  assert.equal((await f.call(`/projects/${f.p.id}/effects-renders`,{...b,planHash:'b'.repeat(64),idempotencyKey:'changed'})).status,409);
});
test('server copy lineage supports copied Mode3 assets without trusting uploaded copy metadata',async t=>{
  const f=await setup(t);const copied=await f.call(`/projects/${f.p.id}/copy`,{});assert.equal(copied.status,200);const a=copied.data.assets[0];const r=await f.call(`/projects/${copied.data.id}/effects-plans`,{baseRevision:0,sourceAssetId:a.id,sourceHash:a.hash,prompt:'small glow',idempotencyKey:'copy-plan'});assert.equal(r.status,200);await f.jobs.step(r.data.id);assert.equal(f.store.job(r.data.id).job.state,'complete');assert.equal(f.store.db.prepare('SELECT source_asset_id FROM asset_origins WHERE asset_id=?').get(a.id).source_asset_id,f.asset.id);
});
test('HTTP project projections support AI sources, survive save/copy, and ignore forged upload source/metadata',async t=>{
  const f=await setup(t),job=f.store.createJob(f.p.id,'generation','ai-original',{shot:{id:'original',name:'AI fox',startFrame:0,endFrame:48}});
  f.store.completeJob(job.id,{name:'AI original.mp4',kind:'video',mime:'video/mp4',source:'provider'},Buffer.from('actual-ai-source'),{model:'actual-video-model'});
  const asset=f.store.getAsset(f.store.job(job.id).job.outputAssetId).asset;
  let project=(await f.call(`/projects/${f.p.id}`)).data;
  assert.deepEqual(project.assets.find(a=>a.id===asset.id).effectsSource,{kind:'ai-original',rootKind:'ai-original',sourceHash:asset.hash});
  project.name='Saved with annotations';const saved=await f.call(`/projects/${f.p.id}`,{baseRevision:project.revision,project},A,'PUT');assert.equal(saved.status,200,JSON.stringify(saved));assert.ok(saved.data.assets.find(a=>a.id===asset.id).effectsSource);assert.equal(f.store.getAsset(asset.id).asset.effectsSource,undefined);assert.equal(f.store.getProject(f.p.id).assets.find(a=>a.id===asset.id).effectsSource,undefined);
  const copy=await f.call(`/projects/${f.p.id}/copy`,{});assert.equal(copy.status,200);assert.equal(copy.data.assets.find(a=>a.hash===asset.hash).effectsSource.kind,'ai-original');
  const forged=f.store.addAsset(f.p.id,{name:'fake AI.mp4',kind:'video',mime:'video/mp4',source:'provider',parentId:asset.id,metadata:{jobId:job.id,effectsSource:{kind:'ai-original'}}},Buffer.from('untrusted-upload')).asset;
  project=(await f.call(`/projects/${f.p.id}`)).data;assert.equal(project.assets.find(a=>a.id===forged.id).effectsSource,undefined);
  const bad=await f.call(`/projects/${f.p.id}/effects-plans`,{baseRevision:project.revision,sourceAssetId:forged.id,sourceHash:forged.hash,prompt:'glow',idempotencyKey:'no-forgery'});assert.equal(bad.status,422);assert.equal(f.calls(),0);
  const planned=await f.call(`/projects/${f.p.id}/effects-plans`,{baseRevision:project.revision,sourceAssetId:asset.id,sourceHash:asset.hash,prompt:'glow',autoRender:false,idempotencyKey:'real-ai'});assert.equal(planned.status,200);await f.jobs.step(planned.data.id);assert.equal(f.store.job(planned.data.id).job.state,'complete');assert.equal(f.calls(),1);assert.equal(f.store.job(planned.data.id).private.input.sourceProvenance.rootKind,'ai-original');
});
test('schema4 upgrade preserves every prior table row including owners and receipts',t=>{
  const dir=mkdtempSync(join(tmpdir(),'effects-migrate-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));let s=new StudioStore(dir);const p=s.createProject(createProject({demo:false}),A);s.createJob(p.id,'scene-generation','unchanged',{a:1});s.db.exec('DROP TABLE asset_origins; PRAGMA user_version=3;');const tables=s.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r=>r.name);const before=Object.fromEntries(tables.map(n=>[n,s.db.prepare(`SELECT * FROM ${n} ORDER BY rowid`).all()]));s.close();s=new StudioStore(dir);try{for(const n of tables)assert.deepEqual(s.db.prepare(`SELECT * FROM ${n} ORDER BY rowid`).all(),before[n],n);assert.equal(s.db.prepare('PRAGMA user_version').get().user_version,4);}finally{s.close();}
});
test('real FFmpeg extracts at most six source frames and provider sends actual frame hashes without transport retries',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'effects-frames-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'source.mp4');execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=1280x720:rate=24','-frames:v','48','-c:v','libx264','-threads','2','-pix_fmt','yuv420p',path]);
  const m=await inspectVideo(path),frames=await extractEffectsFrames(path,{...m,totalFrames:m.frames});assert.equal(frames.length,6);assert.equal(frames[0].frame,0);assert.equal(frames[5].frame,47);assert.ok(new Set(frames.map(f=>f.hash)).size>1);
  let sent,calls=0,prepared;const p=new StudioProvider({llm:{baseUrl:'https://model.invalid/v1',apiKey:'fixture-secret'}},{fetchImpl:async(url,o)=>{calls++;sent=JSON.parse(o.body);assert.equal(url,'https://model.invalid/v1/chat/completions');return Response.json({id:'effects-1',model:SCENE_MODEL,choices:[{message:{content:JSON.stringify(program())}}]});}});await p.generateEffects({prompt:'glow',sourceMedia:m,sourceAssetId:'source',sourceHash:digest(readFileSync(path))},{schema:'{}',frames,onPrepared:r=>prepared=r});assert.equal(calls,1);assert.equal(sent.model,SCENE_MODEL);assert.equal(sent.messages[1].content.filter(c=>c.type==='image_url').length,6);assert.deepEqual(prepared.frames.map(f=>f.hash),frames.map(f=>f.hash));assert.ok(!JSON.stringify(prepared).includes('fixture-secret'));
  p.fetch=async()=>{calls++;throw Error('timeout');};await assert.rejects(p.generateEffects({},{schema:'{}',frames}),e=>e instanceof SubmissionError&&e.uncertain);assert.equal(calls,2);
});

test('known invalid plans stop after two repairs; persisted response recovers without paying and cancellation during extraction calls zero models',async t=>{
  const f=await setup(t,{generate:async()=>response('not-json')}),r=await f.call(`/projects/${f.p.id}/effects-plans`,f.planBody('invalid'));for(let i=0;i<6;i++)await f.jobs.step(r.data.id);assert.equal(f.store.job(r.data.id).job.state,'failed');assert.equal(f.calls(),3);assert.equal((await f.call(`/jobs/${r.data.id}/retry`,{idempotencyKey:'forbidden'})).status,409);
  const recover=f.store.createJob(f.p.id,'effects-plan','recover',f.store.job(r.data.id).private.input);f.store.updateJob(recover.id,{state:'running'},{phase:'validating',attempts:1,response:response(),provenance:[response().provenance]});f.store.recoverJobs();await f.jobs.step(recover.id);assert.equal(f.store.job(recover.id).job.state,'complete');assert.equal(f.calls(),3);
  let release,entered;const wait=new Promise(r=>release=r),started=new Promise(r=>entered=r);f.jobs.code.extractFrames=async()=>{entered();await wait;return [frame];};const c=await f.call(`/projects/${f.p.id}/effects-plans`,{...f.planBody('cancel'),prompt:'cancel me'});const step=f.jobs.step(c.data.id);await started;await f.call(`/jobs/${c.data.id}/cancel`,{});release();await step;assert.equal(f.store.job(c.data.id).job.state,'cancelled');assert.equal(f.calls(),3);
});

test('lost worker POST reconciles by original ID; effects/comparison bytes and exact source stay immutable through recovery',async t=>{
  let submitted,posts=0,gets=0;const effect=Buffer.from('effects-output'),compare=Buffer.from('compare-output');
  const f=await setup(t,{fetchImpl:async(url,o={})=>{url=String(url);
    if(url.endsWith('/jobs')){posts++;submitted=JSON.parse(o.body);throw Error('response lost after acceptance');}
    if(url.includes('/media/'))return new Response(url.endsWith('effects.mp4')?effect:compare);
    gets++;const status=gets===1?'queued':'complete';return Response.json({jobRef:submitted.jobRef,inputHash:submitted.inputHash,status,receipt:{runtimeHash:R,sourceAssetId:submitted.spec.sourceAssetId,sourceHash:submitted.spec.sourceHash,effectsProgramHash:submitted.spec.effectsProgramHash},outputs:status==='complete'?[['effects',effect],['comparison',compare]].map(([role,bytes])=>({name:role+'.mp4',role,mime:'video/mp4',bytes:bytes.length,sha256:digest(bytes),url:`/api/v3/code/media/${submitted.jobRef}/${role}.mp4`})) :[]});
  },codeOptions:{inspectMedia:async path=>({...media,width:readFileSync(path).equals(compare)?2560:1280})}});
  const j=await plan(f),r=await f.call(`/projects/${f.p.id}/effects-renders`,renderBody(f,j)),original=readFileSync(f.store.getAsset(f.asset.id).path);
  await f.jobs.step(r.data.id);assert.equal(f.store.job(r.data.id).job.state,'queued');f.store.recoverJobs();await f.jobs.step(r.data.id);await f.jobs.step(r.data.id);let final=f.store.job(r.data.id);assert.equal(final.job.state,'complete',final.job.error||final.job.waitingReason);assert.equal(posts,1);assert.equal(final.job.partialAssets.length,2);assert.equal(final.job.planJobId,j.job.id);assert.equal(final.job.output.planHash,j.job.output.effectsProgramHash);assert.equal(f.calls(),1);assert.deepEqual(readFileSync(f.store.getAsset(f.asset.id).path),original);const ids=final.job.outputAssetIds;await f.jobs.step(r.data.id);assert.deepEqual(f.store.job(r.data.id).job.outputAssetIds,ids);
});

test('wrong effects receipt plan or incomplete roles fail closed before output download',async t=>{
  let submit,downloads=0,wrong=true;const bytes=Buffer.from('video');const f=await setup(t,{fetchImpl:async(url,o={})=>{url=String(url);
    if(url.endsWith('/jobs')){submit=JSON.parse(o.body);return Response.json({jobRef:submit.jobRef,inputHash:submit.inputHash,status:'queued'});}
    if(url.includes('/media/')){downloads++;return new Response(bytes);}
    return Response.json({jobRef:submit.jobRef,inputHash:submit.inputHash,status:'complete',receipt:{runtimeHash:R,sourceAssetId:submit.spec.sourceAssetId,sourceHash:submit.spec.sourceHash,effectsProgramHash:wrong?'f'.repeat(64):submit.spec.effectsProgramHash},outputs:[{name:'effects.mp4',role:'effects',mime:'video/mp4',bytes:bytes.length,sha256:digest(bytes),url:`/api/v3/code/media/${submit.jobRef}/effects.mp4`}]});
  }});const j=await plan(f),r=await f.call(`/projects/${f.p.id}/effects-renders`,renderBody(f,j));await f.jobs.step(r.data.id);await f.jobs.step(r.data.id);assert.equal(f.store.job(r.data.id).job.state,'failed');assert.equal(f.store.job(r.data.id).job.retryable,false);assert.equal(downloads,0);assert.equal(f.store.getProject(f.p.id).assets.length,1);
  wrong=false;f.store.updateJob(r.data.id,{state:'running'},{phase:'accepted'});await f.jobs.step(r.data.id);assert.equal(f.store.job(r.data.id).job.state,'failed');assert.equal(downloads,0);
});

test('without further browser calls default autoRender hands off a completed plan; restart closes the accepted-render handoff gap without a second model or render',async t=>{
  const f=await setup(t),b=f.planBody('background');delete b.autoRender;const accepted=await f.call(`/projects/${f.p.id}/effects-plans`,b);
  // No more browser/API calls: the server alone finishes planning and creates render.
  await f.jobs.step(accepted.data.id);const p=f.store.job(accepted.data.id);assert.equal(p.private.input.autoRender,true);assert.equal(p.private.effectsHandoff,'complete');assert.ok(p.job.renderJobId);assert.equal(f.store.job(p.job.renderJobId).job.planJobId,p.job.id);assert.equal(f.calls(),1);
  // Simulate crash after createJob committed but before handoff completion persisted.
  f.store.updateJob(p.job.id,{renderJobId:undefined},{effectsHandoff:'pending',renderJobId:null,nextPollAt:0});
  const fresh=new StudioStore(f.dir);let modelCalls=0;const jobs=new StudioJobs(fresh,{provider:{capabilities:()=>({llm:true}),generateEffects:async()=>{modelCalls++;throw Error('must not pay again');}},codeWorkerUrl:'http://worker.invalid',codeWorkerToken:'worker',fetchImpl:async()=>{throw Error('offline');},pollIntervalMs:5,codeOptions:{runtimeHashProvider:async()=>R,inspectMedia:async()=>media}});
  try{assert.ok(fresh.pendingJobs().includes(p.job.id));jobs.start();await new Promise(r=>setTimeout(r,80));assert.equal(fresh.job(p.job.id).private.effectsHandoff,'complete');assert.equal(fresh.job(p.job.id).job.renderJobId,p.job.renderJobId);assert.equal(fresh.listJobs(f.p.id).filter(j=>j.kind==='effects-render').length,1);assert.equal(modelCalls,0);}finally{await jobs.close();fresh.close();}
});

test('automatic handoff waits durably for worker configuration then resumes without calling the model',async t=>{
  const f=await setup(t);f.jobs.code.workerUrl='';const b=f.planBody('offline-auto');delete b.autoRender;const r=await f.call(`/projects/${f.p.id}/effects-plans`,b);await f.jobs.step(r.data.id);let p=f.store.job(r.data.id);assert.equal(p.job.state,'complete');assert.equal(p.job.stage,'waiting_for_effects_render');assert.equal(p.private.effectsHandoff,'waiting');assert.ok(f.store.pendingJobs().includes(p.job.id));assert.equal(f.calls(),1);
  f.jobs.code.workerUrl='http://worker.invalid';await f.jobs.step(r.data.id);p=f.store.job(r.data.id);assert.equal(p.private.effectsHandoff,'complete');assert.ok(p.job.renderJobId);assert.equal(f.calls(),1);
});

test('cancelling a waiting or in-flight background handoff prevents subsequent render creation',async t=>{
  let release,entered;const wait=new Promise(r=>release=r),started=new Promise(r=>entered=r);
  const f=await setup(t,{codeOptions:{runtimeHashProvider:async()=>{entered();await wait;return R;}}}),b=f.planBody('cancel-handoff');delete b.autoRender;const r=await f.call(`/projects/${f.p.id}/effects-plans`,b);const work=f.jobs.step(r.data.id);await started;
  assert.equal(f.store.job(r.data.id).job.state,'complete');assert.equal((await f.call(`/jobs/${r.data.id}/cancel`,{})).data.state,'cancelled');release();await work;assert.equal(f.store.job(r.data.id).private.effectsHandoff,'cancelled');assert.equal(f.store.listJobs(f.p.id).filter(j=>j.kind==='effects-render').length,0);assert.equal(f.calls(),1);
  f.jobs.code.workerUrl='';const other=await f.call(`/projects/${f.p.id}/effects-plans`,{...b,idempotencyKey:'waiting',prompt:'other'});await f.jobs.step(other.data.id);assert.equal(f.store.job(other.data.id).job.stage,'waiting_for_effects_render');assert.equal(f.store.job(other.data.id).job.cancellable,true);await f.call(`/jobs/${other.data.id}/cancel`,{});f.jobs.code.workerUrl='http://worker.invalid';await f.jobs.step(other.data.id);assert.equal(f.store.job(other.data.id).job.state,'cancelled');assert.equal(f.store.listJobs(f.p.id).filter(j=>j.kind==='effects-render').length,0);
  const count=f.calls();assert.equal((await f.call(`/jobs/${other.data.id}/retry`,{idempotencyKey:'resume-handoff'})).status,200);await f.jobs.step(other.data.id);assert.equal(f.store.job(other.data.id).private.effectsHandoff,'complete');assert.equal(f.store.listJobs(f.p.id).filter(j=>j.kind==='effects-render').length,1);assert.equal(f.calls(),count);
});

test('cancel-before-acceptance tombstone retry requires explicit action and resends only the original frozen worker input',async t=>{
  let job,posts=0,retries=0,submitted;const f=await setup(t,{fetchImpl:async(url,o={})=>{url=String(url);const r=f.store.job(job.id),identity={jobRef:job.id,inputHash:r.private.inputHash};if(url.endsWith('/cancel'))return Response.json({...identity,status:'cancelled',cancelledBeforeAcceptance:true,requiresSubmission:true});if(url.endsWith('/retry')){retries++;return Response.json({...identity,status:'queued',stage:'awaiting-original-submission',requiresSubmission:true});}if(url.endsWith('/jobs')){posts++;submitted=JSON.parse(o.body);return Response.json({...identity,status:'queued'});}return Response.json({...identity,status:'queued'});}});
  const p=await plan(f);job=(await f.call(`/projects/${f.p.id}/effects-renders`,renderBody(f,p))).data;const input=f.store.job(job.id).private.input;f.store.updateJob(job.id,{}, {phase:'submitting',workerOrigin:'http://worker.invalid'});await f.call(`/jobs/${job.id}/cancel`,{});await f.jobs.step(job.id);assert.equal(f.store.job(job.id).job.state,'cancelled');assert.equal(posts,0);assert.equal((await f.call(`/jobs/${job.id}/retry`,{idempotencyKey:'explicit-resume'})).status,200);await f.jobs.step(job.id);assert.equal(f.store.job(job.id).private.handle,null);await f.jobs.step(job.id);assert.equal(posts,1);assert.equal(retries,1);assert.equal(submitted.jobRef,job.id);assert.deepEqual(submitted.spec,input.spec);assert.equal(f.calls(),1);assert.equal(f.store.listJobs(f.p.id).filter(j=>j.kind==='effects-render').length,1);
});

test('concurrent plan requests share one paid intent for same and different keys across asynchronous inspection',async t=>{
  let entered=0,release;const gate=new Promise(r=>release=r);const f=await setup(t,{codeOptions:{inspectMedia:async()=>{entered++;if(entered>=3)release();await gate;return media;}}}),body=f.planBody('same');const results=await Promise.all([f.call(`/projects/${f.p.id}/effects-plans`,body),f.call(`/projects/${f.p.id}/effects-plans`,body),f.call(`/projects/${f.p.id}/effects-plans`,{...body,idempotencyKey:'different'})]);assert.deepEqual(results.map(r=>r.status),[200,200,200]);assert.equal(new Set(results.map(r=>r.data.id)).size,1);await f.jobs.step(results[0].data.id);assert.equal(f.calls(),1);
});

test('a completed worker wins a cancellation race: download original outputs and never offer a GPU retry',async t=>{
  let job,cancelCalls=0;const effect=Buffer.from('fx'),compare=Buffer.from('cmp');const f=await setup(t,{fetchImpl:async(url)=>{url=String(url);if(url.includes('/media/'))return new Response(url.endsWith('comparison.mp4')?compare:effect);if(url.endsWith('/cancel'))cancelCalls++;const r=f.store.job(job.id),spec=r.private.input.spec;return Response.json({jobRef:job.id,inputHash:r.private.inputHash,status:'complete',receipt:{runtimeHash:R,sourceAssetId:spec.sourceAssetId,sourceHash:spec.sourceHash,effectsProgramHash:spec.effectsProgramHash},outputs:[['effects',effect],['comparison',compare]].map(([role,bytes])=>({name:role+'.mp4',role,mime:'video/mp4',bytes:bytes.length,sha256:digest(bytes),url:`/api/v3/code/media/${job.id}/${role}.mp4`}))});},codeOptions:{inspectMedia:async path=>({...media,width:readFileSync(path).equals(compare)?2560:1280})}});
  const p=await plan(f);job=(await f.call(`/projects/${f.p.id}/effects-renders`,renderBody(f,p))).data;f.store.updateJob(job.id,{state:'running'},{phase:'accepted',handle:{id:job.id}});await f.call(`/jobs/${job.id}/cancel`,{});await f.jobs.step(job.id);assert.equal(f.store.job(job.id).job.stage,'recovering_completed_output');assert.equal(f.store.job(job.id).job.retryable,false);assert.equal((await f.call(`/jobs/${job.id}/retry`,{idempotencyKey:'never'})).status,409);await f.jobs.step(job.id);assert.equal(f.store.job(job.id).job.state,'complete');assert.equal(f.store.job(job.id).job.cancellationTooLate,true);assert.equal(f.store.job(job.id).job.partialAssets.length,2);assert.equal(cancelCalls,1);assert.equal(f.calls(),1);
});
