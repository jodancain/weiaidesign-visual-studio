import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudioProvider } from './provider.mjs';
import { StudioStore } from './store.mjs';
import { StudioJobs } from './jobs.mjs';
import { createProject, digest } from './domain.mjs';

// Official Seedance 2.0 duration range: 4–15 seconds. Studio keeps its tighter
// 12-second shot limit; timeline frame ranges are never extended to the minimum.
// https://www.volcengine.com/activity/seedance2
// https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh&redirect=1
const resolveAsset=async()=>({bytes:Buffer.from('reference-image'),mime:'image/png'});
const input=frames=>({shot:{id:'shot',name:'shot',prompt:'Exact action',dialogue:'你好。',firstAssetId:'first',startFrame:0,endFrame:frames},aspect:'16:9',fps:24,approvalHash:'fixture'});

test('Seedance 2.0 floors all five approved frame ranges to 4 seconds and receipts match exact transmitted body',async()=>{
  for(const model of ['dreamina-seedance-2-0','dreamina-seedance-2-0-260128','doubao-seedance-2-0-260128'])for(const frames of [58,58,46,61,17,96,97,288]){
    let prepared,request,calls=0;
    const provider=new StudioProvider({baseUrl:'https://fixture.invalid/v1',apiKey:'synthetic',backend:'seedance',model},{fetchImpl:async(_url,options)=>{calls++;assert.ok(prepared,'receipt must persist before external submission');request=JSON.parse(options.body);assert.equal(prepared.requestBodyHash,digest(Buffer.from(options.body)));return Response.json({task_id:'accepted',properties:{upstream_model_name:model}});}});
    const original=input(frames),snapshot=structuredClone(original);
    const handle=await provider.submit(original,resolveAsset,async receipt=>{prepared=receipt;});
    const seconds=Math.max(4,Math.ceil(frames/24));assert.match(request.prompt,new RegExp(`--duration ${seconds}$`));assert.equal(calls,1);assert.equal(handle.providerDuration,seconds);assert.equal(handle.parameters.providerDuration,seconds);assert.equal(handle.parameters.requestedFrames,frames);assert.equal(handle.requestBodyHash,prepared.requestBodyHash);assert.equal(handle.references[0].hash,digest(Buffer.from('reference-image')));assert.equal(handle.prompt,request.prompt);assert.deepEqual(original,snapshot);
  }
});

test('Seedance upper bounds reject locally without submitting, and unrelated models retain their own minimum',async()=>{
  let calls=0;const provider=new StudioProvider({baseUrl:'https://fixture.invalid/v1',apiKey:'synthetic',backend:'seedance',model:'dreamina-seedance-2-0'},{fetchImpl:async()=>{calls++;return Response.json({task_id:'wrong'});}});
  for(const frames of [289,360,361,0,-1,NaN])await assert.rejects(provider.submit(input(frames),resolveAsset));assert.equal(calls,0);
  let submitted;const legacy=new StudioProvider({baseUrl:'https://fixture.invalid/v1',apiKey:'synthetic',backend:'seedance',model:'doubao-seedance-1-0-pro'},{fetchImpl:async(_u,o)=>{submitted=JSON.parse(o.body);return Response.json({task_id:'legacy'});}});
  const handle=await legacy.submit(input(17),resolveAsset);assert.match(submitted.prompt,/--duration 2$/);assert.equal(handle.providerDuration,2);
});

test('cannot send a paid request if persisting its prepared receipt fails',async()=>{
  let calls=0;const provider=new StudioProvider({baseUrl:'https://fixture.invalid/v1',apiKey:'synthetic',backend:'seedance',model:'dreamina-seedance-2-0'},{fetchImpl:async()=>{calls++;return Response.json({task_id:'wrong'});}});
  await assert.rejects(provider.submit(input(58),resolveAsset,async()=>{throw Error('injected receipt persistence failure');}),/receipt persistence/);assert.equal(calls,0);
});

test('rejected submission preserves exact request receipt and same key remains failed after restart, without a retry',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'studio-provider-contract-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));let store=new StudioStore(dir),calls=0;
  const p=store.createProject(createProject()),asset=store.addAsset(p.id,{name:'frame.png',kind:'image',mime:'image/png'},Buffer.from('reference-image')).asset;
  const submitted=input(58);submitted.shot.firstAssetId=asset.id;
  const provider=new StudioProvider({baseUrl:'https://fixture.invalid/v1',apiKey:'synthetic',backend:'seedance',model:'dreamina-seedance-2-0'},{fetchImpl:async()=>{calls++;return Response.json({error:{message:'fixture explicit rejection'}},{status:400});}});
  let jobs=new StudioJobs(store,{provider});const job=store.createJob(p.id,'generation','authorized-once',submitted);await jobs.step(job.id);
  const r=store.job(job.id);assert.equal(r.job.state,'failed');assert.equal(r.private.attempts,1);assert.equal(r.private.submission.parameters.providerDuration,4);assert.equal(r.job.output.parameters.providerDuration,4);assert.equal(r.job.output.parameters.requestedFrames,58);assert.match(r.job.output.prompt,/--duration 4$/);assert.match(r.job.output.requestBodyHash,/^[a-f0-9]{64}$/);assert.equal(r.job.output.modelReported,false);
  await jobs.close();store.close();store=new StudioStore(dir);jobs=new StudioJobs(store,{provider});t.after(async()=>{await jobs.close();store.close();});assert.equal(store.createJob(p.id,'generation','authorized-once',submitted).id,job.id);await jobs.step(job.id);assert.equal(calls,1);assert.equal(store.job(job.id).job.state,'failed');
});

test('generated media duration is measured from real output, distinct from requested frames and provider duration',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'studio-provider-media-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const video=join(dir,'provider.mp4'),encode=spawnSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=blue:s=320x180:r=24:d=4.25','-c:v','libx264','-pix_fmt','yuv420p',video]);assert.equal(encode.status,0,encode.stderr?.toString());
  const store=new StudioStore(join(dir,'store'));t.after(()=>store.close());const p=store.createProject(createProject()),asset=store.addAsset(p.id,{name:'frame.png',kind:'image',mime:'image/png'},Buffer.from('reference-image')).asset,submitted=input(58);submitted.shot.firstAssetId=asset.id;
  let posts=0;const provider=new StudioProvider({baseUrl:'https://fixture.invalid/v1',apiKey:'synthetic',backend:'seedance',model:'dreamina-seedance-2-0'},{fetchImpl:async(url,options={})=>{if(options.method==='POST'){posts++;return Response.json({task_id:'accepted-real-media'});}if(String(url).endsWith('/video/generations/accepted-real-media'))return Response.json({status:'SUCCESS',result_url:'https://cdn.invalid/result.mp4',properties:{upstream_model_name:'dreamina-seedance-2-0-260128'}});return new Response(readFileSync(video));}});
  const jobs=new StudioJobs(store,{provider});t.after(()=>jobs.close());const j=store.createJob(p.id,'generation','real-output-duration',submitted);await jobs.step(j.id);await jobs.step(j.id);
  const complete=store.job(j.id).job,media=store.getAsset(complete.outputAssetId).asset;assert.equal(complete.state,'complete');assert.equal(posts,1);assert.equal(complete.output.duration,4.25);assert.equal(media.metadata.duration,4.25);assert.equal(media.metadata.providerDuration,4);assert.equal(complete.output.parameters.requestedFrames,58);assert.equal(complete.output.model,'dreamina-seedance-2-0-260128');assert.equal(complete.output.modelReported,true);
});

test('native Veo keeps discrete 4/6/8-second and first/last-frame contracts with pre-submit receipts',async()=>{
  for(const [frames,last,expected] of [[58,false,4],[121,false,6],[169,false,8],[58,true,8]]){
    let prepared;const provider=new StudioProvider({baseUrl:'https://native.invalid/v1beta',apiKey:'synthetic',backend:'gemini',model:'veo-fixture'},{fetchImpl:async(_url,options)=>{assert.ok(prepared);assert.equal(prepared.requestBodyHash,digest(Buffer.from(options.body)));const body=JSON.parse(options.body);assert.equal(body.parameters.durationSeconds,expected);assert.equal(Boolean(body.instances[0].lastFrame),last);return Response.json({name:'operations/fixture'});}});
    const request=input(frames);if(last)request.shot.lastAssetId='last';const handle=await provider.submit(request,resolveAsset,receipt=>{prepared=receipt;});assert.equal(handle.providerDuration,expected);assert.equal(handle.referenceMode,last?'first_last_frame':'first_frame');assert.equal(handle.references.length,last?2:1);
  }
});
