import test from 'node:test';
import { effectsProgramHash } from '../../gateway/studio/effects-program.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { createServer } from 'node:net';
const digest=x=>createHash('sha256').update(x).digest('hex');
test('worker authenticates, freezes inputs, deduplicates concurrent acceptance and preserves stopped-job retries',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'code-worker-test-')),token=randomBytes(32).toString('hex');
  const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));
  await mkdir(join(dir,'interrupted'));
  await writeFile(join(dir,'interrupted','job.json'),JSON.stringify({jobRef:'interrupted',inputHash:'a'.repeat(64),status:'running',outputs:[],retries:[]}));
  const child=spawn(process.execPath,[resolve('workers/code-video/worker.mjs')],{env:{...process.env,STUDIO_CODE_DATA:dir,STUDIO_CODE_WORKER_TOKEN:token,STUDIO_CODE_PORT:String(port),STUDIO_CHROME_BIN:'/unavailable-test-browser'},stdio:['ignore','pipe','pipe']});
  let logs='';child.stderr.on('data',b=>{logs+=b;});
  t.after(async()=>{child.kill('SIGTERM');await new Promise(r=>child.once('close',r));await rm(dir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${port}/api/v3/code`;
  async function call(path,{method='GET',body,auth=true}={}){const r=await fetch(base+path,{method,headers:{...(auth?{authorization:'Bearer '+token}:{}),'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return{status:r.status,body:await r.json()};}
  let ready=false;for(let i=0;i<100;i++){try{await call('/capabilities');ready=true;break;}catch{await new Promise(r=>setTimeout(r,30));}}assert.ok(ready,logs);
  assert.equal((await call('/capabilities',{auth:false})).status,401);
  assert.equal((await call('/jobs/missing')).status,404);
  assert.equal((await call('/jobs/interrupted')).body.stage,'interrupted');
  const bytes=Buffer.from('test source'),input={jobRef:'dedupe',inputHash:digest('input'),kind:'enhancement',spec:{schemaVersion:1,sourceAssetId:'source',sourceHash:digest(bytes),parameters:{stages:'nr',preset:'natural',passes:1,processingScale:100,frameGeneration:false,superResolution:false}},assets:[{id:'source',hash:digest(bytes),mime:'video/mp4',base64:bytes.toString('base64')}]};
  const wrong=structuredClone(input);wrong.assets[0].hash='0'.repeat(64);assert.equal((await call('/jobs',{method:'POST',body:wrong})).status,400);
  const pair=await Promise.all([call('/jobs',{method:'POST',body:input}),call('/jobs',{method:'POST',body:input})]);assert.deepEqual(pair.map(r=>r.status).sort(),[200,202]);
  const different=structuredClone(input);different.spec.sourceHash='f'.repeat(64);assert.equal((await call('/jobs',{method:'POST',body:different})).status,409);
  assert.equal((await call('/media/dedupe/job.json')).status,404);
  for(let i=0;i<100;i++){const current=await call('/jobs/dedupe');if(current.body.status==='failed')break;await new Promise(r=>setTimeout(r,50));}
  assert.equal((await call('/jobs/dedupe')).body.status,'failed');
  // The runner persists its error before the OS emits process close. Retrying
  // is deliberately forbidden until the worker releases that active process.
  for(let i=0;i<200;i++){if(!(await call('/capabilities')).body.scheduler.activeJobs.includes('dedupe'))break;await new Promise(r=>setTimeout(r,25));}
  assert.equal((await call('/capabilities')).body.scheduler.activeJobs.includes('dedupe'),false);
  const retry={inputHash:input.inputHash,retryKey:'resume-once'};
  const retries=await Promise.all([call('/jobs/dedupe/retry',{method:'POST',body:retry}),call('/jobs/dedupe/retry',{method:'POST',body:retry})]);
  assert.deepEqual(retries.map(r=>r.status).sort(),[200,202]);
  assert.deepEqual(JSON.parse(await readFile(join(dir,'dedupe','job.json'),'utf8')).retries,['resume-once']);
  const capabilities=(await call('/capabilities')).body;assert.equal(capabilities.effects.available,false);
  const program={schemaVersion:1,fps:24,totalFrames:24,width:320,height:180,seed:1,subtitleProtection:{enabled:true,bottomFraction:.16,paddingPx:8},layers:[{id:'glow1',type:'glow',description:'visible glow',startFrame:0,endFrame:24,color:'#ffcc66',opacity:.3,keyframes:[{frame:0,x:.5,y:.4,scale:1,opacity:1}],parameters:{radius:.1,softness:.8,pulseHz:1}}]};
  const fx={...structuredClone(input),jobRef:'effects-acceptance',inputHash:digest('effects-input'),kind:'effects-render',spec:{schemaVersion:1,runtimeHash:capabilities.runtimeHash,sourceAssetId:'source',sourceHash:digest(bytes),effectsProgram:program,effectsProgramHash:effectsProgramHash(program),fps:24,totalFrames:24,width:320,height:180}};
  const badFX=structuredClone(fx);badFX.spec.effectsProgram.layers[0].parameters.code='for(;;){}';assert.equal((await call('/jobs',{method:'POST',body:badFX})).status,400);
  assert.equal((await call('/jobs',{method:'POST',body:{...fx,kind:'effects-plan'}})).status,400);
  const acceptedFX=await Promise.all([call('/jobs',{method:'POST',body:fx}),call('/jobs',{method:'POST',body:fx})]);assert.deepEqual(acceptedFX.map(r=>r.status).sort(),[200,202]);
  const changedFX=structuredClone(fx);changedFX.spec.effectsProgram.layers[0].opacity=.8;changedFX.spec.effectsProgramHash=effectsProgramHash(changedFX.spec.effectsProgram);assert.equal((await call('/jobs',{method:'POST',body:changedFX})).status,409);
  assert.equal((await call('/media/effects-acceptance/effects.mp4')).status,404);
});

test('unknown cancellation persists a hash-bound tombstone; late POST cannot run and explicit retry safely restores frozen input',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'code-worker-cancel-')),token=randomBytes(32).toString('hex');const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));let child;
  async function stop(){if(!child)return;const stopped=new Promise(r=>child.once('close',r));child.kill('SIGTERM');await stopped;child=null;}
  t.after(async()=>{await stop();await rm(dir,{recursive:true,force:true});});
  async function call(path,body){const r=await fetch(`http://127.0.0.1:${port}/api/v3/code${path}`,{method:body?'POST':'GET',headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return{status:r.status,body:await r.json()};}
  async function start(){child=spawn(process.execPath,[resolve('workers/code-video/worker.mjs')],{env:{...process.env,STUDIO_CODE_DATA:dir,STUDIO_CODE_WORKER_TOKEN:token,STUDIO_CODE_PORT:String(port),STUDIO_CHROME_BIN:'/unavailable-test-browser'},stdio:'ignore'});for(let i=0;i<100;i++){try{await call('/capabilities');return;}catch{await new Promise(r=>setTimeout(r,30));}}throw Error('Worker did not start');}
  await start();const hash=digest('lost-worker-post'),identity='lost-before-acceptance';
  const cancelled=await call(`/jobs/${identity}/cancel`,{inputHash:hash});assert.equal(cancelled.status,200);assert.equal(cancelled.body.status,'cancelled');assert.equal(cancelled.body.cancelledBeforeAcceptance,true);
  await stop();await start();assert.equal((await call(`/jobs/${identity}`)).body.status,'cancelled');
  const bytes=Buffer.from('frozen source'),input={jobRef:identity,inputHash:hash,kind:'enhancement',spec:{schemaVersion:1,sourceAssetId:'source',sourceHash:digest(bytes),parameters:{stages:'nr',preset:'natural',passes:1,processingScale:100,frameGeneration:false,superResolution:false}},assets:[{id:'source',hash:digest(bytes),mime:'video/mp4',base64:bytes.toString('base64')}]};
  assert.equal((await call('/jobs',{...input,inputHash:digest('different')})).status,409);
  const late=await call('/jobs',input);assert.equal(late.status,200);assert.equal(late.body.status,'cancelled');assert.deepEqual(JSON.parse(await readFile(join(dir,identity,'job.json'),'utf8')).assets,[]);
  assert.equal((await call(`/jobs/${identity}/cancel`,{inputHash:digest('wrong')})).status,409);
  const retry={inputHash:hash,retryKey:'first-resume'};const pair=await Promise.all([call(`/jobs/${identity}/retry`,retry),call(`/jobs/${identity}/retry`,retry)]);assert.deepEqual(pair.map(r=>r.status).sort(),[200,202]);assert.ok(pair.every(r=>r.body.requiresSubmission===true));
  await new Promise(r=>setTimeout(r,150));const waiting=(await call(`/jobs/${identity}`)).body;assert.equal(waiting.status,'queued');assert.equal(waiting.stage,'awaiting-original-submission');
  await call(`/jobs/${identity}/cancel`,{inputHash:hash});assert.equal((await call(`/jobs/${identity}/retry`,retry)).body.status,'cancelled');assert.equal((await call('/jobs',input)).body.status,'cancelled');
  await call(`/jobs/${identity}/retry`,{inputHash:hash,retryKey:'second-resume'});assert.equal((await call('/jobs',input)).status,202);
  const restored=JSON.parse(await readFile(join(dir,identity,'job.json'),'utf8'));assert.deepEqual(restored.spec,input.spec);assert.equal(restored.inputHash,hash);assert.equal(restored.assets[0].hash,digest(bytes));assert.equal(restored.requiresSubmission,false);assert.deepEqual(restored.retries,['first-resume','second-resume']);
});
