import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { durableRename, durableReadFile, callbackQueue, throttledProgress } from './durable-io.mjs';

test('sharing errors retry the same atomic rename without exposing partial data',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'studio-rename-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const target=join(dir,'job.json'),source=join(dir,'job.tmp');
  await writeFile(target,'original');await writeFile(source,'replacement');let calls=0;const sleeps=[];
  await durableRename(source,target,{renameFile:async(a,b)=>{
    assert.equal(await readFile(target,'utf8'),'original');
    if(++calls<=3)throw Object.assign(Error('sharing violation'),{code:'EPERM'});
    await rename(a,b);
  },sleep:async ms=>sleeps.push(ms)});
  assert.equal(calls,4);assert.deepEqual(sleeps,[10,20,40]);assert.equal(await readFile(target,'utf8'),'replacement');
  await assert.rejects(readFile(source),{code:'ENOENT'});
});

test('permanent sharing error is bounded, non-sharing errors are never retried or hidden',async()=>{
  for(const code of ['EPERM','EBUSY','EACCES','ENOSPC','EIO']){
    let calls=0,sleeps=0;const error=Object.assign(Error(code),{code});
    await assert.rejects(durableRename('source','target',{renameFile:async()=>{calls++;throw error;},sleep:async()=>{sleeps++;}}),e=>e===error);
    const transient=['EPERM','EBUSY','EACCES'].includes(code);assert.equal(calls,transient?8:1);assert.equal(sleeps,transient?7:0);
  }
});

test('state read retries sharing errors but preserves missing/invalid data failures',async()=>{
  let calls=0;
  assert.equal(await durableReadFile('job.json','utf8',{read:async()=>{if(++calls===1)throw Object.assign(Error('busy'),{code:'EBUSY'});return '{"status":"running"}';},sleep:async()=>{}}),'{"status":"running"}');
  assert.equal(calls,2);const absent=Object.assign(Error('absent'),{code:'ENOENT'});
  await assert.rejects(durableReadFile('absent','utf8',{read:async()=>{throw absent;}}),e=>e===absent);
  assert.throws(()=>JSON.parse('{broken'),SyntaxError);
});

test('progress throttle keeps stage changes and terminal frames while PNG callbacks remain independent',async()=>{
  let time=0;const calls=[];const update=throttledProgress(async p=>calls.push(p),{now:()=>time});
  for(let frame=0;frame<100;frame++){time=frame*10;await update({stage:'rendering',frame,completedFrames:frame+1,totalFrames:100});}
  assert.deepEqual(calls.map(x=>x.frame),[0,25,50,75,99]);
  await update({stage:'encoding',frame:99,completedFrames:100,totalFrames:100});assert.equal(calls.at(-1).stage,'encoding');
});

test('callback queue drains started work and retains first failure without unhandled rejection',async()=>{
  const order=[];const original=Error('write denied');let cancelled=0;const q=callbackQueue(()=>cancelled++);
  q.push(async()=>{await new Promise(r=>setTimeout(r,5));order.push('first');});
  q.push(async()=>{order.push('failed');throw original;});q.push(async()=>order.push('must not run'));
  await assert.rejects(q.drain(),e=>e===original);assert.equal(cancelled,1);assert.deepEqual(order,['first','failed']);
});

test('real Remotion callback path catches progress rejection, cancels and reports original error',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'studio-progress-failure-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const source=`
    import {createRequire} from 'node:module';
    import {renderPngs} from ${JSON.stringify(new URL('./render.mjs',import.meta.url).href)};
    const require=createRequire(${JSON.stringify(resolve('web/package.json'))});
    let cancelled=false,closed=false;
    require.cache[require.resolve('@remotion/bundler')]={exports:{bundle:async()=> 'http://127.0.0.1/unused'}};
    require.cache[require.resolve('@remotion/renderer')]={exports:{
      openBrowser:async()=>({connection:{send:async()=>({value:{product:'Chrome/test'}})},close:async()=>{closed=true;}}),
      makeCancelSignal:()=>({cancelSignal:{},cancel:()=>{cancelled=true;}}),
      renderFrames:async options=>{options.onFrameUpdate(1,0);await new Promise(r=>setTimeout(r,40));if(cancelled)throw Error('Renderer cancelled');}
    }};
    try{await renderPngs({dir:${JSON.stringify(dir)},spec:{backend:'remotion',fps:24,totalFrames:1,width:1280,height:720},progress:async()=>{const e=Error('injected progress disk failure');e.code='ENOSPC';throw e;}});throw Error('Unexpected render success');}
    catch(e){if(e.message!=='injected progress disk failure'||!cancelled||!closed)throw e;console.log(JSON.stringify({originalError:e.message,cancelled,closed}));}
  `;
  const script=join(dir,'probe.mjs');await writeFile(script,source);
  const result=await new Promise(resolveResult=>{const child=spawn(process.execPath,[script],{stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.once('close',code=>resolveResult({code,stdout,stderr}));});
  assert.equal(result.code,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout.trim()),{originalError:'injected progress disk failure',cancelled:true,closed:true});
});

test('real runner persists failed state on injected progress I/O error instead of crashing unhandled',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'studio-runner-failure-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  await writeFile(join(dir,'job.json'),JSON.stringify({jobRef:'failure-probe',inputHash:'a'.repeat(64),kind:'render',status:'running',stage:'queued',outputs:[],assets:[],retries:[],spec:{backend:'remotion',fps:24,totalFrames:1,width:1280,height:720}}));
  const preload=`
    import fs from 'node:fs';import {createRequire,syncBuiltinESMExports}from'node:module';
    const original=fs.promises.rename;
    fs.promises.rename=async(a,b)=>{if(b===${JSON.stringify(join(dir,'job.json'))}&&JSON.parse(await fs.promises.readFile(a,'utf8')).stage==='rendering')throw Object.assign(Error('injected state ENOSPC'),{code:'ENOSPC'});return original(a,b);};syncBuiltinESMExports();
    const require=createRequire(${JSON.stringify(resolve('web/package.json'))});let cancelled=false;
    require.cache[require.resolve('@remotion/bundler')]={exports:{bundle:async()=> 'http://127.0.0.1/unused'}};
    require.cache[require.resolve('@remotion/renderer')]={exports:{openBrowser:async()=>({connection:{send:async()=>({value:{product:'Chrome/test'}})},close:async()=>{}}),makeCancelSignal:()=>({cancelSignal:{},cancel:()=>{cancelled=true;}}),renderFrames:async o=>{o.onFrameUpdate(1,0);await new Promise(r=>setTimeout(r,80));if(cancelled)throw Error('Renderer cancelled');}}};
  `;
  const script=join(dir,'preload.mjs');await writeFile(script,preload);
  const result=await new Promise(resolveResult=>{const child=spawn(process.execPath,['--import',script,resolve('workers/code-video/run-job.mjs'),dir],{stdio:['ignore','pipe','pipe']});let stderr='';child.stderr.on('data',b=>stderr+=b);child.once('close',code=>resolveResult({code,stderr}));});
  assert.equal(result.code,1);const state=JSON.parse(await readFile(join(dir,'job.json'),'utf8'));
  assert.equal(state.status,'failed');assert.equal(state.stage,'failed');assert.equal(state.error,'injected state ENOSPC');assert.match(result.stderr,/injected state ENOSPC/);assert.doesNotMatch(result.stderr,/triggerUncaughtException|node:internal\/fs\/promises/);
});

test('real FFmpeg composition retains validated staged media across injected Windows rename denials',async t=>{
  const {exportSequence,probeMedia}=await import('../../gateway/studio/compositor.mjs');
  const dir=await mkdtemp(join(tmpdir(),'studio-compose-retry-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const input=join(dir,'source.mp4'),output=join(dir,'base.mp4');
  const ff=spawnSync(process.env.FFMPEG_BIN||'ffmpeg',['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=c=blue:s=320x180:r=24:d=1','-c:v','libx264','-pix_fmt','yuv420p',input]);assert.equal(ff.status,0,ff.stderr.toString());
  const project={fps:24,aspect:'16:9',sequence:{fps:24,totalFrames:24,clips:[{id:'v',kind:'video',assetId:'v',startFrame:0,endFrame:24,sourceIn:0,volume:0,track:0}]}};
  let commits=0;const bytes=[];
  await exportSequence({project,outputPath:output,resolveAsset:()=>input,commitFile:(from,to)=>durableRename(from,to,{renameFile:async(a,b)=>{
    bytes.push(await readFile(a));if(++commits<=3)throw Object.assign(Error('injected output sharing lock'),{code:'EPERM'});await rename(a,b);
  },sleep:async()=>{}})});
  assert.equal(commits,4);for(const b of bytes)assert.deepEqual(b,await readFile(output),'same encoded bytes survive all commit attempts');
  const probe=await probeMedia(output);assert.equal(Number(probe.streams.find(x=>x.codec_type==='video').nb_read_frames),24);assert.ok(probe.streams.some(x=>x.codec_type==='audio'));
  const before=await readFile(output),failure=Object.assign(Error('permanent commit failure'),{code:'EIO'});
  await assert.rejects(exportSequence({project,outputPath:output,resolveAsset:()=>input,commitFile:async()=>{throw failure;}}),e=>e===failure);
  assert.deepEqual(await readFile(output),before,'failed new commit never alters existing published media');
});
