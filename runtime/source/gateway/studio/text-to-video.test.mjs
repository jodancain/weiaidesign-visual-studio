import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { StudioProvider } from './provider.mjs';
import { StudioStore } from './store.mjs';
import { StudioJobs } from './jobs.mjs';
import { createStudioRouter } from './router.mjs';
import { createProject, clone, digest, shotHash, validateProject, reviewProject } from './domain.mjs';

// The configured relay documents image as optional for Seedance text-to-video:
// https://docs.easyrouter.io/zh/docs/api/ai-model/videos/seedance
// These tests do not contact a provider or spend generation quota.
const config={baseUrl:'https://fixture.invalid/v1',apiKey:'synthetic',backend:'seedance',model:'dreamina-seedance-2-0'};
const prompt='A wholly new fictional adult woman in a cream sweater pauses beside a mirror.';
const input=(frames=192)=>({shot:{id:'shot',name:'Original fictional character',prompt,generationMode:'text-to-video',startFrame:0,endFrame:frames},aspect:'9:16',fps:24,approvalHash:'fixture'});
const PNG=Buffer.from('reference-image');
const resolveAsset=async()=>({bytes:PNG,mime:'image/png'});
const neverResolve=async()=>{assert.fail('text-to-video must not resolve or transmit any image');};
function directory(t){const path=mkdtempSync(join(tmpdir(),'studio-text-video-'));t.after(()=>rmSync(path,{recursive:true,force:true}));return path;}

test('Seedance text-to-video transmits model, prompt and native audio/last-frame options with an exact receipt before POST',async()=>{
  for(const model of ['dreamina-seedance-2-0','dreamina-seedance-2-0-260128','doubao-seedance-2-0-260128'])for(const frames of [17,97,192,288]){
    let prepared,body,calls=0;
    const provider=new StudioProvider({...config,model},{fetchImpl:async(url,options)=>{
      calls++;assert.equal(url,'https://fixture.invalid/v1/video/generations');assert.equal(options.method,'POST');
      assert.ok(prepared,'receipt must precede submission');assert.equal(prepared.requestBodyHash,digest(Buffer.from(options.body)));
      body=JSON.parse(options.body);return Response.json({task_id:'accepted',properties:{upstream_model_name:model}});
    }});
    const request=input(frames),before=clone(request),handle=await provider.submit(request,neverResolve,receipt=>{prepared=receipt;});
    const providerDuration=Math.max(4,Math.ceil(frames/24));
    assert.deepEqual(body,{model,prompt:`${prompt}\n--ratio 9:16 --duration ${providerDuration}`,metadata:{generate_audio:true,return_last_frame:true}});
    assert.equal(Object.hasOwn(body,'image'),false);assert.equal(calls,1);assert.deepEqual(request,before);
    assert.equal(handle.referenceMode,'text_only');assert.deepEqual(handle.references,[]);assert.deepEqual(handle.ignoredReferences,[]);
    assert.deepEqual(handle.parameters,{aspect:'9:16',requestedFrames:frames,providerDuration,generationMode:'text-to-video',metadata:{generate_audio:true,return_last_frame:true}});
    assert.equal(handle.prompt,body.prompt);assert.equal(handle.requestBodyHash,prepared.requestBodyHash);
  }
});

test('text-to-video capability is restricted to the verified Seedance 2 contract',async()=>{
  const supported=new StudioProvider(config);assert.deepEqual(supported.capabilities().generationModes,['image-to-video','text-to-video']);
  assert.deepEqual(new StudioProvider({...config,backend:undefined}).capabilities().generationModes,['image-to-video','text-to-video']);
  for(const patch of [{backend:'gemini'},{backend:'veo-openai'},{backend:'unknown'},{model:'doubao-seedance-1-5-pro-251215'},{model:'other-video-model'},{model:undefined}]){
    let posts=0;const provider=new StudioProvider({...config,...patch},{fetchImpl:async()=>{posts++;assert.fail('unsupported contract must not submit');}});
    assert.deepEqual(provider.capabilities().generationModes,['image-to-video']);
    await assert.rejects(provider.submit(input(),neverResolve),/text-to-video is not supported/);assert.equal(posts,0);
  }
});

test('ambiguous modes, attached references and invalid durations are rejected before image resolution or submission',async()=>{
  let posts=0;const provider=new StudioProvider(config,{fetchImpl:async()=>{posts++;assert.fail('invalid text-to-video must not submit');}});
  for(const patch of [{firstAssetId:'existing-image'},{lastAssetId:'existing-image'},{firstAssetId:''},{lastAssetId:null},{generationMode:'auto'},{generationMode:null}]){
    const request=input();Object.assign(request.shot,patch);await assert.rejects(provider.submit(request,neverResolve),/generation mode|cannot include/);
  }
  for(const frames of [0,289,360,NaN])await assert.rejects(provider.submit(input(frames),neverResolve));
  await assert.rejects(provider.submit(input(),neverResolve,()=>{throw Error('receipt persistence failed');}),/receipt persistence failed/);
  assert.equal(posts,0);
});

test('legacy and explicit image-to-video retain the exact original transmitted body and receipt parameters',async()=>{
  for(const mode of [undefined,'image-to-video']){
    let sent;const provider=new StudioProvider(config,{fetchImpl:async(_url,options)=>{sent=options.body;return Response.json({task_id:'image-task'});}});
    const request=input();request.shot.generationMode=mode;request.shot.firstAssetId='first';
    const handle=await provider.submit(request,resolveAsset);
    assert.equal(sent,JSON.stringify({model:config.model,prompt:`${prompt}\n--ratio 9:16 --duration 8`,image:`data:image/png;base64,${PNG.toString('base64')}`}));
    assert.equal(handle.referenceMode,'first_frame');assert.deepEqual(handle.references,[{assetId:'first',role:'first_frame',hash:digest(PNG)}]);
    assert.deepEqual(handle.parameters,{aspect:'9:16',requestedFrames:192,providerDuration:8});
  }
  let calls=0;const provider=new StudioProvider(config,{fetchImpl:async()=>{calls++;assert.fail('missing image must not become text-to-video');}});
  const request=input();delete request.shot.generationMode;
  await assert.rejects(provider.submit(request,async()=>null),/first reference image required/);assert.equal(calls,0);
});

test('schema and approval hash distinguish explicit text-only generation while HTML identifies unsent planning images',()=>{
  const p=createProject(),s=p.shots[0],before=shotHash(p,s);s.generationMode='text-to-video';
  validateProject(p);assert.notEqual(shotHash(p,s),before);
  const image={id:'planning-image',name:'Planning only',kind:'image',mime:'image/png',hash:digest(PNG),bytes:PNG.length,url:'/api/v3/assets/planning-image/content'};
  p.assets.push(image);p.nodes.push({id:'planning-subject',type:'subject',x:0,y:0,label:'Planning character',sceneId:s.sceneId,objectId:s.subjectIds[0],assetId:image.id});
  validateProject(p);const review=reviewProject(p,()=> 'data:image/png;base64,cGxhbg==');
  assert.match(review.html,/文生视频（仅文字，不发送人物或场景参考图）/);assert.match(review.html,/本体规划资料（不发送给视频模型）/);
  for(const patch of [{firstAssetId:image.id},{lastAssetId:image.id},{generationMode:'auto'}]){
    const invalid=clone(p);Object.assign(invalid.shots[0],patch);assert.throws(()=>validateProject(invalid),/cannot include|generation mode/);
  }
});

async function httpFixture(t,provider){
  const router=createStudioRouter({dataDir:directory(t),token:'synthetic-test-token',provider,startJobs:false});router.jobs.tick=()=>{};
  const server=createServer((req,res)=>router.handle(req,res));server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await router.close();});
  const call=async(path,method='GET',body)=>{const response=await fetch(`http://127.0.0.1:${server.address().port}/api/v3${path}`,{method,headers:{authorization:'Bearer synthetic-test-token','content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,...await response.json()};};
  return {router,call};
}

test('HTTP explicit mode requires new approval, freezes text input, and never infers mode from absent images',async t=>{
  let submits=0,submitted;const provider=new StudioProvider(config,{fetchImpl:async(_url,options)=>{submits++;submitted=JSON.parse(options.body);return Response.json({task_id:'frozen-text-task'});}});
  const {router,call}=await httpFixture(t,provider);let p=(await call('/projects','POST',{})).data;
  const path=`/projects/${p.id}`,shotPath=`${path}/shots/${p.shots[0].id}`;
  const previousHash=shotHash(p,p.shots[0]);p=(await call(`${shotPath}/approve`,'POST',{hash:previousHash})).data;
  assert.equal((await call(`${shotPath}/generate`,'POST',{idempotencyKey:'must-not-infer',approvalHash:previousHash})).status,422);
  assert.deepEqual(router.store.listJobs(p.id),[]);
  let candidate=clone(p);candidate.shots[0].generationMode='text-to-video';candidate.shots[0].prompt=prompt;
  p=(await call(path,'PUT',{baseRevision:p.revision,project:candidate})).data;assert.equal(p.shots[0].approval,undefined);
  assert.equal((await call(`${shotPath}/generate`,'POST',{idempotencyKey:'stale-mode',approvalHash:previousHash})).status,409);
  const hash=shotHash(p,p.shots[0]);assert.notEqual(hash,previousHash);p=(await call(`${shotPath}/approve`,'POST',{hash})).data;
  const body={idempotencyKey:'text-once',approvalHash:hash},first=await call(`${shotPath}/generate`,'POST',body);
  assert.equal(first.status,200);assert.equal((await call(`${shotPath}/generate`,'POST',body)).data.id,first.data.id);
  const frozen=clone(router.store.job(first.data.id).private.input);assert.equal(frozen.shot.generationMode,'text-to-video');assert.equal(frozen.shot.prompt,prompt);
  candidate=clone(p);candidate.shots[0].prompt='Later edit';p=(await call(path,'PUT',{baseRevision:p.revision,project:candidate})).data;
  await router.jobs.step(first.data.id);assert.equal(submits,1);assert.ok(submitted.prompt.startsWith(prompt));assert.equal(Object.hasOwn(submitted,'image'),false);
  assert.deepEqual(router.store.job(first.data.id).private.input,frozen);assert.equal(router.store.job(first.data.id).job.output.referenceMode,'text_only');
  assert.equal(p.shots[0].approval,undefined);assert.equal(router.store.listJobs(p.id).length,1);
});

test('HTTP unsupported text-only provider creates no job or implicit image request',async t=>{
  let submits=0;const {router,call}=await httpFixture(t,{capabilities:()=>({video:true,generationModes:['image-to-video']}),submit:async()=>{submits++;assert.fail('must not submit');}});
  let p=(await call('/projects','POST',{})).data;const candidate=clone(p);candidate.shots[0].generationMode='text-to-video';
  p=(await call(`/projects/${p.id}`,'PUT',{baseRevision:p.revision,project:candidate})).data;
  const hash=shotHash(p,p.shots[0]),path=`/projects/${p.id}/shots/${p.shots[0].id}`;
  await call(`${path}/approve`,'POST',{hash});const result=await call(`${path}/generate`,'POST',{idempotencyKey:'unsupported',approvalHash:hash});
  assert.equal(result.status,422);assert.deepEqual(router.store.listJobs(p.id),[]);assert.equal(submits,0);
});

test('rejection and uncertain acceptance preserve mode through restart without fallback or resubmission',async t=>{
  for(const mode of ['text-to-video','image-to-video'])for(const failure of ['rejected','unknown']){
    const path=directory(t);let store=new StudioStore(path),calls=0,lastBody;
    const provider=new StudioProvider(config,{fetchImpl:async(_url,options)=>{calls++;lastBody=JSON.parse(options.body);if(failure==='unknown')throw Error('connection interrupted');return Response.json({error:{message:'explicit input rejected'}},{status:400});}});
    const p=store.createProject(createProject()),request=input();request.shot.generationMode=mode;
    if(mode==='image-to-video')request.shot.firstAssetId=store.addAsset(p.id,{name:'frame.png',kind:'image',mime:'image/png'},PNG).asset.id;
    let jobs=new StudioJobs(store,{provider});const job=store.createJob(p.id,'generation','once',request);await jobs.step(job.id);
    const state=failure==='rejected'?'failed':'uncertain';assert.equal(store.job(job.id).job.state,state);assert.equal(calls,1);
    assert.equal(Object.hasOwn(lastBody,'image'),mode==='image-to-video');assert.equal(store.job(job.id).private.attempts,1);
    await jobs.close();store.close();store=new StudioStore(path);jobs=new StudioJobs(store,{provider});
    assert.equal(store.createJob(p.id,'generation','once',request).id,job.id);await jobs.step(job.id);
    assert.equal(store.job(job.id).job.state,state);assert.equal(calls,1);assert.equal(store.job(job.id).private.input.shot.generationMode,mode);
    await jobs.close();store.close();
  }
});

test('poll accepts official nested content URLs and preserves original last-frame identity without fetching it',async()=>{
  const video='https://provider-cdn.invalid/original.mp4',lastFrame='https://provider-cdn.invalid/original-last.jpeg?signature=fixture';
  const handle={id:'relay-accepted',baseUrl:config.baseUrl,backend:config.backend,model:config.model,referenceMode:'text_only'};
  for(const nested of [false,true]){
    let gets=0;const raw={id:'upstream-accepted',status:'succeeded',model:'dreamina-seedance-2-0-260128',content:{video_url:video,last_frame_url:lastFrame}};
    const provider=new StudioProvider(config,{fetchImpl:async url=>{gets++;assert.equal(url,`${config.baseUrl}/video/generations/relay-accepted`);return Response.json({data:nested?{status:'SUCCESS',data:raw}:raw});}});
    const result=await provider.poll(handle);assert.equal(gets,1);assert.equal(result.state,'complete');assert.equal(result.url,video);
    assert.deepEqual(result.providerOriginalLastFrame,{source:'provider',url:lastFrame,providerTaskId:'relay-accepted',responseField:'content.last_frame_url',upstreamTaskId:'upstream-accepted'});
  }
  const provider=new StudioProvider(config,{fetchImpl:async()=>Response.json({data:{status:'SUCCESS',result_url:'https://original-contract.invalid/result.mp4',data:{id:'upstream-accepted',content:{video_url:video,last_frame_url:lastFrame}}}})});
  const result=await provider.poll(handle);assert.equal(result.url,'https://original-contract.invalid/result.mp4');assert.equal(result.needsAuth,false);assert.equal(result.providerOriginalLastFrame.url,lastFrame);
});

test('poll does not invent or retain last-frame URLs from pending, failed or malformed responses',async()=>{
  const handle={id:'accepted',baseUrl:config.baseUrl,backend:config.backend,model:config.model,referenceMode:'text_only'};
  for(const state of ['RUNNING','FAILED']){
    const provider=new StudioProvider(config,{fetchImpl:async()=>Response.json({data:{status:state,data:{content:{video_url:'https://cdn.invalid/video.mp4',last_frame_url:'https://cdn.invalid/last.jpeg'}}}})});
    assert.equal(Object.hasOwn(await provider.poll(handle),'providerOriginalLastFrame'),false);
  }
  for(const last of [undefined,'file:///tmp/frame.jpeg','javascript:alert(1)','https://user:password@cdn.invalid/last.jpeg',{}]){
    const provider=new StudioProvider(config,{fetchImpl:async()=>Response.json({data:{status:'SUCCESS',data:{content:{video_url:'https://cdn.invalid/video.mp4',...(last===undefined?{}:{last_frame_url:last})}}}})});
    const result=await provider.poll(handle);assert.equal(result.state,'complete');assert.equal(Object.hasOwn(result,'providerOriginalLastFrame'),false);
  }
});

test('completed job durably retains actual supplier last-frame output and never downloads it or submits a continuation',async t=>{
  const path=directory(t);let store=new StudioStore(path),posts=0,videoGets=0,lastFrameGets=0;
  const p=store.createProject(createProject()),request=input(),lastFrame='https://provider-cdn.invalid/official-last.jpeg';
  const provider=new StudioProvider(config,{fetchImpl:async(url,options={})=>{
    url=String(url);
    if(options.method==='POST'){posts++;return Response.json({task_id:'accepted-text'});}
    if(url===`${config.baseUrl}/video/generations/accepted-text`)return Response.json({data:{status:'SUCCESS',data:{id:'upstream-text',model:'dreamina-seedance-2-0-260128',content:{video_url:'https://provider-cdn.invalid/original.mp4',last_frame_url:lastFrame}}}});
    if(url===lastFrame){lastFrameGets++;assert.fail('last frame must only be recorded, never automatically downloaded');}
    assert.equal(url,'https://provider-cdn.invalid/original.mp4');assert.equal(options.headers.authorization,undefined);videoGets++;return new Response('synthetic-video');
  }});
  const jobs=new StudioJobs(store,{provider,validateMedia:async()=>({duration:8,width:720,height:1280})});
  const job=store.createJob(p.id,'generation','once-with-last-frame',request);await jobs.step(job.id);
  assert.equal(Object.hasOwn(store.job(job.id).job.output,'providerOriginalLastFrame'),false);
  await jobs.step(job.id);const completed=store.job(job.id).job;
  assert.equal(completed.state,'complete');assert.equal(posts,1);assert.equal(videoGets,1);assert.equal(lastFrameGets,0);
  assert.deepEqual(completed.output.parameters.metadata,{generate_audio:true,return_last_frame:true});
  assert.deepEqual(completed.output.providerOriginalLastFrame,{source:'provider',url:lastFrame,providerTaskId:'accepted-text',responseField:'content.last_frame_url',upstreamTaskId:'upstream-text'});
  await jobs.close();store.close();store=new StudioStore(path);
  assert.deepEqual(store.job(job.id).job.output.providerOriginalLastFrame,completed.output.providerOriginalLastFrame);
  assert.equal(store.listJobs(p.id).length,1);assert.equal(store.getProject(p.id).assets.length,1);store.close();
});
