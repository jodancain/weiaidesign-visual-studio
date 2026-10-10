import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudioStore } from './store.mjs';
import { StudioJobs } from './jobs.mjs';
import { createProject } from './domain.mjs';

function fixture(t, mutate, stage){
  const directory=mkdtempSync(join(tmpdir(),'studio-worker-receipt-')),store=new StudioStore(directory),p=store.createProject(createProject());
  const bake=store.addAsset(p.id,{name:'bake.glb',kind:'bake',mime:'model/gltf-binary'},Buffer.from('synthetic bake')).asset;
  const job=store.createJob(p.id,'preview','worker-receipt',{scene:p.scenes[0],bakedAssetId:bake.id,frameStart:3,frameEnd:5,resolution:[1280,720]});
  let downloads=0,submits=0;
  const jobs=new StudioJobs(store,{workerUrl:'http://worker.invalid',validateMedia:async()=>({duration:2/24,width:1280,height:720}),fetchImpl:async(url,options={})=>{
    const accepted=options.method==='POST';if(accepted)submits++;
    if(accepted||String(url).endsWith(`/api/v3/render/${job.id}`)){
      const receipt={id:job.id,jobRef:job.id,inputHash:store.job(job.id).private.inputHash,state:accepted?'queued':'complete',frames:2,fps:24,resolution:[1280,720],images:[{frame:3,url:`/api/v3/render/${job.id}/assets/frame_000003.png`}],video_url:`/api/v3/render/${job.id}/assets/preview.mp4`,landmarks:[]};
      if((stage==='accepted')===accepted)mutate(receipt);
      return Response.json(receipt);
    }
    downloads++;return new Response('synthetic media');
  }});
  t.after(async()=>{await jobs.close();store.close();rmSync(directory,{recursive:true,force:true});});
  return {store,p,job,jobs,counts:()=>({downloads,submits})};
}

test('worker accepted receipts reject missing or mismatched job identity before polling or downloading',async t=>{
  for(const mutate of [r=>{r.jobRef='foreign-job';r.id='foreign-job';},r=>{delete r.jobRef;},r=>{r.inputHash='foreign-hash';},r=>{r.id='foreign-alias';}]){
    const f=fixture(t,mutate,'accepted');await f.jobs.step(f.job.id);await f.jobs.step(f.job.id);
    const r=f.store.job(f.job.id);assert.equal(r.job.state,'failed');assert.match(r.job.error,/worker.*(identity|input hash)/);assert.equal(r.private.handle,undefined);assert.deepEqual(f.counts(),{submits:1,downloads:0});assert.equal(f.store.getProject(f.p.id).assets.length,1);
  }
});

test('worker poll receipts reject mismatched identity even after accepted-job recovery',async t=>{
  for(const mutate of [r=>{r.jobRef='foreign-job';},r=>{r.inputHash='foreign-hash';},r=>{delete r.inputHash;}]){
    const f=fixture(t,mutate,'poll');await f.jobs.step(f.job.id);f.store.recoverJobs();await f.jobs.step(f.job.id);
    const r=f.store.job(f.job.id);assert.equal(r.job.state,'failed');assert.match(r.job.error,/worker.*(identity|input hash)/);assert.equal(r.job.outputAssetId,undefined);assert.deepEqual(f.counts(),{submits:1,downloads:0});assert.equal(f.store.getProject(f.p.id).assets.length,1);
  }
});

test('worker completion validates every frame and media namespace before any media is committed',async t=>{
  for(const mutate of [
    r=>{r.images.push({frame:99,url:r.images[0].url});},r=>{r.images[0].frame=5;},r=>{r.images[0].frame=2;},r=>{delete r.images[0].frame;},
    r=>{r.landmarks=[{frame:99,objectId:'foreign-object'}];},r=>{r.images[0].url='/api/v3/render/foreign-job/assets/frame.png';},
    r=>{r.video_url='http://foreign.invalid/preview.mp4';},r=>{r.frames=99;},r=>{r.fps=30;},r=>{r.resolution=[720,1280];}
  ]){
    const f=fixture(t,mutate,'poll');await f.jobs.step(f.job.id);await f.jobs.step(f.job.id);
    const r=f.store.job(f.job.id);assert.equal(r.job.state,'failed');assert.equal(r.job.outputAssetId,undefined);assert.deepEqual(f.counts(),{submits:1,downloads:0});assert.equal(f.store.getProject(f.p.id).assets.length,1);
  }
});
