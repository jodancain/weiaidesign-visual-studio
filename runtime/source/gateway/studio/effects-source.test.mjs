import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,readFileSync,writeFileSync,renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { StudioStore } from './store.mjs';
import { createProject,digest } from './domain.mjs';
import { effectsSource,projectEffectsSources } from './effects-source.mjs';
import { effectsVideoEvidence,importEffectsAudioRemix } from './effects-import.mjs';
import { copyDemo } from './code-routes.mjs';

const owner='11111111-1111-4111-8111-111111111111';
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'effects-source-')),store=new StudioStore(dir),p=store.createProject(createProject({demo:false}),owner);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return {dir,store,p};}
function generated(store,p,bytes=Buffer.from('provider-original'),key='generated'){
  const job=store.createJob(p.id,'generation',key,{shot:{id:'shot',name:'A light',prompt:'A fox finds a light',startFrame:0,endFrame:48},fps:24,approvalHash:'a'.repeat(64)});
  const done=store.completeJob(job.id,{name:'AI original.mp4',kind:'video',mime:'video/mp4',source:'provider',metadata:{jobId:job.id}},bytes,{model:'actual-video-model'});
  return {job:done,asset:store.getAsset(done.outputAssetId).asset};
}
function exported(store,p,assets,{name='export',snapshotHash}={}){
  const frozen=store.getProject(p.id);frozen.sequence.clips=assets.map((asset,i)=>({id:`clip-${i}`,kind:'video',track:0,startFrame:i*24,endFrame:(i+1)*24,sourceIn:0,assetId:asset.id}));
  if(snapshotHash)frozen.assets.find(a=>a.id===assets[0].id).hash=snapshotHash;
  const job=store.createJob(p.id,'export',name,{project:frozen});
  const done=store.completeJob(job.id,{name:name+'.mp4',kind:'video',mime:'video/mp4',source:'export'},Buffer.from(name));
  return {job:done,asset:store.getAsset(done.outputAssetId).asset};
}
const annotation=(store,p,asset)=>projectEffectsSources(store,store.getProject(p.id)).assets.find(a=>a.id===asset.id).effectsSource;

test('native AI output and multi-clip export use completed output bindings, without requiring metadata jobId',t=>{
  const {store,p}=fixture(t),a=generated(store,p),b=generated(store,p,Buffer.from('second'),'second'),final=exported(store,p,[a.asset,b.asset]);
  assert.equal(final.asset.metadata?.jobId,undefined);
  for(const asset of [a.asset,b.asset,final.asset]){
    assert.deepEqual(annotation(store,p,asset),{kind:'ai-original',rootKind:'ai-original',sourceHash:asset.hash});
    assert.equal(effectsSource(store,p.id,asset.id,asset.hash).provenance.rootKind,'ai-original');
  }
  const source=effectsSource(store,p.id,final.asset.id,final.asset.hash);assert.equal(source.provenance.rootJobId,final.job.id);assert.equal(source.provenance.sourceRoots.length,2);assert.equal(source.context.sequence.clips.length,2);
});

test('uploads cannot forge provider, import, copy, enhancement or response provenance; one unverified clip rejects an export',t=>{
  const {store,p}=fixture(t),a=generated(store,p);
  for(const source of ['provider','export','verified-media-import','effects-compositor','dlss-nr']){
    const asset=store.addAsset(p.id,{name:'forged.mp4',kind:'video',mime:'video/mp4',source,parentId:a.asset.id,metadata:{jobId:a.job.id,model:'actual-video-model',sourceAssetId:a.asset.id,sourceHash:a.asset.hash,effectsSource:{kind:'ai-original'}}},Buffer.from(source)).asset;
    assert.equal(annotation(store,p,asset),undefined);assert.throws(()=>effectsSource(store,p.id,asset.id,asset.hash),/verified completed/);
  }
  const upload=store.addAsset(p.id,{name:'unverified.mp4',kind:'video',mime:'video/mp4'},Buffer.from('upload')).asset,final=exported(store,p,[a.asset,upload]);
  assert.equal(annotation(store,p,final.asset),undefined);
  const fake=store.getProject(p.id);fake.assets.find(v=>v.id===upload.id).effectsSource={kind:'ai-original',rootKind:'ai-original',sourceHash:upload.hash};
  assert.equal(projectEffectsSources(store,fake).assets.find(v=>v.id===upload.id).effectsSource,undefined);
});

test('export frozen asset hashes, incomplete generation, and cross-project parent bindings fail closed',t=>{
  const {store,p}=fixture(t),a=generated(store,p),bad=exported(store,p,[a.asset],{snapshotHash:'f'.repeat(64)});
  assert.throws(()=>effectsSource(store,p.id,bad.asset.id,bad.asset.hash),/lineage hash/);
  store.updateJob(a.job.id,{state:'failed'});assert.equal(annotation(store,p,a.asset),undefined);store.updateJob(a.job.id,{state:'complete'});
  const other=store.createProject(createProject({demo:false}),'22222222-2222-4222-8222-222222222222');
  const wrong=store.createJob(other.id,'effects-render','cross',{spec:{sourceAssetId:a.asset.id,sourceHash:a.asset.hash}});
  const output=store.checkpointOutput(wrong.id,'effects.mp4',{name:'effects.mp4',kind:'video',mime:'video/mp4'},Buffer.from('bad'),{role:'effects'});store.updateJob(wrong.id,{state:'complete'});
  assert.throws(()=>effectsSource(store,other.id,output.id,output.hash),/cross-project/);assert.throws(()=>effectsSource(store,other.id,a.asset.id,a.asset.hash),/belong/);
});

test('trusted copies preserve AI ancestry and effects derivatives, while comparison artifacts remain ineligible',t=>{
  const {store,p}=fixture(t),a=generated(store,p),r=store.createJob(p.id,'effects-render','effects',{spec:{sourceAssetId:a.asset.id,sourceHash:a.asset.hash}});
  const effect=store.checkpointOutput(r.id,'effects.mp4',{name:'effects.mp4',kind:'video',mime:'video/mp4'},Buffer.from('effect'),{role:'effects'}),comparison=store.checkpointOutput(r.id,'comparison.mp4',{name:'comparison.mp4',kind:'video',mime:'video/mp4'},Buffer.from('compare'),{role:'comparison'});store.updateJob(r.id,{state:'complete'});
  assert.equal(annotation(store,p,effect).kind,'derived');assert.equal(annotation(store,p,effect).rootKind,'ai-original');assert.equal(annotation(store,p,comparison),undefined);
  const copy=copyDemo(store,store.getProject(p.id),owner);for(const asset of copy.assets){assert.deepEqual(annotation(store,copy,asset),annotation(store,p,store.getProject(p.id).assets.find(a=>a.hash===asset.hash)));}
  const final=exported(store,p,[effect],{name:'effects-export'});assert.equal(annotation(store,p,final.asset).kind,'derived');
});

test('GET provenance is byte-free and does not mutate stored assets; submission still detects byte changes',t=>{
  const {store,p}=fixture(t),a=generated(store,p),file=store.getAsset(a.asset.id).path,snapshot=JSON.stringify(store.getProject(p.id));
  renameSync(file,file+'.saved');assert.equal(annotation(store,p,a.asset).kind,'ai-original');renameSync(file+'.saved',file);
  assert.equal(JSON.stringify(store.getProject(p.id)),snapshot);writeFileSync(file,'changed');assert.throws(()=>effectsSource(store,p.id,a.asset.id,a.asset.hash),/hash changed/);
});

test('legacy imports and fabricated private-import-shaped metadata are not trusted jobs',t=>{
  const {store,p}=fixture(t),a=generated(store,p),asset=store.addAsset(p.id,{name:'old.mp4',kind:'video',mime:'video/mp4',source:'legacy-import',metadata:{proof:{sourceAssetId:a.asset.id,sourceHash:a.asset.hash,transform:'audio-remix'}}},Buffer.from('legacy')).asset;
  assert.equal(annotation(store,p,asset),undefined);
  const job=store.createJob(p.id,'trusted-media-import','incomplete-proof',{proof:{schemaVersion:1,transform:'audio-remix',sourceAssetId:a.asset.id,sourceHash:a.asset.hash,outputHash:asset.hash}});store.completeJobWithAsset(job.id,asset.id);
  assert.throws(()=>effectsSource(store,p.id,asset.id,asset.hash),/invalid trusted media/);
});

test('operator audio-remix import measures real packet identity and timing; persisted proof, idempotency and changed video rejection',async t=>{
  const {dir,store,p}=fixture(t),original=join(dir,'original.mp4'),remix=join(dir,'remix.mp4'),changed=join(dir,'changed.mp4');
  execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=128x72:rate=24','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','2','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-c:a','aac',original]);
  execFileSync('ffmpeg',['-v','error','-i',original,'-f','lavfi','-i','sine=frequency=660:sample_rate=48000','-map','0:v:0','-map','1:a:0','-t','2','-c:v','copy','-c:a','aac',remix]);
  execFileSync('ffmpeg',['-v','error','-i',original,'-vf','negate','-c:v','libx264','-threads','1','-c:a','copy',changed]);
  const a=generated(store,p,readFileSync(original)),request={projectId:p.id,sourceAssetId:a.asset.id,sourceHash:a.asset.hash,outputPath:remix,outputHash:digest(readFileSync(remix)),name:'without narration.mp4',idempotencyKey:'historical-remix',evidenceHash:digest('operator audit evidence')};
  const first=await importEffectsAudioRemix(store,request),second=await importEffectsAudioRemix(store,request);
  assert.equal(first.job.id,second.job.id);assert.equal(first.asset.id,second.asset.id);assert.equal(first.asset.source,'verified-media-import');assert.equal(annotation(store,p,first.asset).kind,'ai-original');
  const saved=store.job(first.job.id).private.input;assert.equal(saved.proof.sourceVideoPacketHash,saved.proof.outputVideoPacketHash);assert.equal(saved.proof.sourceVideoTimelineHash,saved.proof.outputVideoTimelineHash);assert.equal(saved.outputMedia.frames,48);assert.equal(saved.outputMedia.fps,24);assert.notEqual(saved.outputMedia.audioPacketHash,saved.sourceMedia.audioPacketHash);
  const evidence=await effectsVideoEvidence(remix);assert.equal(evidence.packetCount,48);assert.equal(evidence.profile.width,128);assert.equal(effectsSource(store,p.id,first.asset.id,first.asset.hash).provenance.transform,'audio-remix');
  await assert.rejects(importEffectsAudioRemix(store,{...request,idempotencyKey:'different-video',outputPath:changed,outputHash:digest(readFileSync(changed))}),/changed video packets/);
  assert.equal(store.listJobs(p.id).filter(j=>j.kind==='trusted-media-import').length,1);
});
