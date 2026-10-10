import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { run, runtimeHash, fileHash, sha256 } from './render.mjs';
import { probeMedia } from '../../gateway/studio/compositor.mjs';

async function runner(dir) {
  return new Promise((resolveResult, reject) => {
    const child=spawn(process.execPath,[resolve('workers/code-video/run-job.mjs'),dir],{stdio:['ignore','pipe','pipe']});
    let stderr='';child.stderr.on('data',b=>stderr+=b);child.once('error',reject);child.once('close',code=>resolveResult({code,stderr}));
  });
}
async function rawFrame(path) {
  return new Promise((resolveResult,reject)=>{
    const child=spawn(process.env.FFMPEG_BIN||'ffmpeg',['-v','error','-i',path,'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','-'],{stdio:['ignore','pipe','pipe']});
    const chunks=[];let stderr='';child.stdout.on('data',b=>chunks.push(b));child.stderr.on('data',b=>stderr+=b);child.once('error',reject);child.once('close',code=>code===0?resolveResult(Buffer.concat(chunks)):reject(Error(stderr)));
  });
}

for(const totalFrames of [72,144])test(`real ${totalFrames}-frame runner publishes separate shot/clean/base and preserves each on re-entry`,async t=>{
  const dir=await mkdtemp(join(tmpdir(),`studio-short-${totalFrames}-`));t.after(()=>rm(dir,{recursive:true,force:true}));
  await mkdir(join(dir,'frames'));
  const first=join(dir,'fixture.png');
  await run(process.env.FFMPEG_BIN||'ffmpeg',['-v','error','-y','-f','lavfi','-i','color=c=blue:s=1280x720','-frames:v','1',first]);
  const bytes=await readFile(first),hash=sha256(bytes);
  for(let i=0;i<totalFrames;i++){
    const p=join(dir,'frames',`frame-${String(i).padStart(6,'0')}.png`);await writeFile(p,bytes);await writeFile(p+'.sha256',hash);
  }
  const spec={schemaVersion:1,backend:'remotion',runtimeHash:await runtimeHash(),fps:24,width:1280,height:720,totalFrames,browserAssets:[],sequence:{fps:24,totalFrames,clips:[{id:'caption',kind:'text',text:'VISIBLE CAPTION',fontSize:72,x:.5,y:.5,color:'#ffffff',track:2,startFrame:0,endFrame:totalFrames}]}};
  // CPU-only fixture: validates the runner's real encode/compose path without launching or claiming a GPU render.
  await writeFile(join(dir,'render-binding.json'),JSON.stringify({runtimeHash:spec.runtimeHash,specHash:sha256(JSON.stringify(spec)),backend:spec.backend}));
  await writeFile(join(dir,'render-session.json'),JSON.stringify({backend:spec.backend,runtimeHash:spec.runtimeHash,gpu:{fixture:'synthetic CPU PNGs; no GPU execution'},browserVersion:'synthetic-test-fixture',timings:{}}));
  await writeFile(join(dir,'job.json'),JSON.stringify({jobRef:`short-${totalFrames}`,inputHash:'a'.repeat(64),kind:'render',status:'running',stage:'queued',outputs:[],assets:[],retries:[],spec}));
  const firstRun=await runner(dir);assert.equal(firstRun.code,0,firstRun.stderr);
  const state=JSON.parse(await readFile(join(dir,'job.json'),'utf8'));assert.equal(state.status,'complete');
  assert.deepEqual(state.outputs.map(x=>[x.name,x.role]).sort(),[[`shot-0-${totalFrames}.mp4`,'shot'],['clean.mp4','clean'],['base.mp4','base']].sort());
  const signatures={};
  for(const o of state.outputs){
    const path=join(dir,o.name),probe=await probeMedia(path),v=probe.streams.find(s=>s.codec_type==='video');
    assert.equal(Number(v.nb_read_frames),totalFrames);assert.equal(v.avg_frame_rate,'24/1');assert.equal(Number(v.duration),totalFrames/24);
    assert.equal(probe.streams.some(s=>s.codec_type==='audio'),o.role==='base');
    const fileStat=await stat(path);signatures[o.name]={sha256:await fileHash(path),mtime:fileStat.mtimeMs,bytes:fileStat.size};assert.equal(signatures[o.name].sha256,o.sha256);
    await run(process.env.FFMPEG_BIN||'ffmpeg',['-v','error','-xerror','-i',path,'-f','null','-']);
  }
  const clean=await rawFrame(join(dir,'clean.mp4')),base=await rawFrame(join(dir,'base.mp4'));
  assert.equal(clean.length,1280*720*3);assert.equal(base.length,clean.length);
  let whiteClean=0,whiteBase=0;
  for(let y=250;y<470;y++)for(let x=100;x<1180;x++){const i=(y*1280+x)*3;if(clean[i]>210&&clean[i+1]>210&&clean[i+2]>210)whiteClean++;if(base[i]>210&&base[i+1]>210&&base[i+2]>210)whiteBase++;}
  assert.equal(whiteClean,0,'Clean input must contain no caption glyphs');assert.ok(whiteBase>1000,'Base must contain the visible white caption');
  const secondRun=await runner(dir);assert.equal(secondRun.code,0,secondRun.stderr);
  const resumed=JSON.parse(await readFile(join(dir,'job.json'),'utf8'));assert.deepEqual(resumed.outputs,state.outputs);
  for(const o of resumed.outputs){const p=join(dir,o.name),s=await stat(p);assert.deepEqual({sha256:await fileHash(p),mtime:s.mtimeMs,bytes:s.size},signatures[o.name],`${o.name} was rewritten on re-entry`);}
  assert.equal(resumed.receipt.reusedFrames,totalFrames);assert.equal(resumed.receipt.renderedNow,0);
});
