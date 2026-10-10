import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { StudioStore } from './store.mjs';
import { StudioProvider } from './provider.mjs';
import { StudioJobs } from './jobs.mjs';
import { createProject, shotHash, clone } from './domain.mjs';

function fixture(t){const directory=mkdtempSync(join(tmpdir(),'studio-fault-'));const store=new StudioStore(directory);t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});return {store,p:store.createProject(createProject()),directory};}
const inputFor=p=>({shot:clone(p.shots[0]),approvalHash:shotHash(p,p.shots[0]),aspect:p.aspect,fps:p.fps});

test('checkpointed downloads cannot send replacement-provider credentials to the old operation origin',async t=>{
  let calls=0;const provider=new StudioProvider({baseUrl:'https://replacement.invalid/v1',backend:'seedance',apiKey:'synthetic-replacement-secret'},{fetchImpl:async()=>{calls++;return new Response('fixture');}});
  const result={state:'complete',url:'https://original.invalid/v1/result.mp4',needsAuth:true},handle={id:'original-accepted',baseUrl:'https://original.invalid/v1',backend:'seedance'};
  await assert.rejects(provider.download(result,handle),/configuration changed/);
  const {store,p}=fixture(t),input=inputFor(p),job=store.createJob(p.id,'generation','checkpointed-result',input);store.updateJob(job.id,{state:'running'},{phase:'downloading',handle,result});
  const jobs=new StudioJobs(store,{provider});t.after(()=>jobs.close());await jobs.step(job.id);
  assert.equal(store.job(job.id).job.state,'uncertain');assert.equal(store.job(job.id).private.handle.id,handle.id);assert.equal(store.job(job.id).private.result.state,'complete');assert.equal(store.createJob(p.id,'generation','retry-after-config-change',input).id,job.id);
  assert.equal(calls,0,'configuration must be checked before any download request');
});

test('late generation keeps edited content and historical result without automatically selecting a stale take',async t=>{
  const {store,p}=fixture(t),input=inputFor(p);let finish;const deferred=new Promise(resolve=>{finish=resolve;});let downloads=0;
  const jobs=new StudioJobs(store,{provider:{submit:async()=>({id:'accepted-original',model:'fixture'}),poll:async()=>({state:'complete',url:'https://fixture.invalid'}),download:async()=>{downloads++;await deferred;return Buffer.from('video');}},validateMedia:async()=>({duration:3})});t.after(()=>jobs.close());
  const job=store.createJob(p.id,'generation','late-result',input);await jobs.step(job.id);const completion=jobs.step(job.id);await new Promise(resolve=>setImmediate(resolve));assert.equal(downloads,1);
  const edited=store.change(p.id,p.revision,current=>{current.shots[0].prompt='The new user-authored shot';return current;});finish();await completion;
  const current=store.getProject(p.id);assert.equal(current.shots[0].prompt,edited.shots[0].prompt);assert.equal(current.shots[0].takes.length,1);assert.equal(current.shots[0].selectedTakeId,undefined);assert.equal(store.job(job.id).job.state,'complete');
});

test('completion transaction rollback and retry create one asset/take without resubmitting the paid operation',async t=>{
  const {store,p}=fixture(t);let submits=0,downloads=0;
  const jobs=new StudioJobs(store,{provider:{submit:async()=>{submits++;return {id:'durable-operation',model:'fixture'};},poll:async()=>({state:'complete',url:'https://fixture.invalid'}),download:async()=>{downloads++;return Buffer.from('video');}},validateMedia:async()=>({duration:3})});t.after(()=>jobs.close());
  const job=store.createJob(p.id,'generation','database-fault',inputFor(p));await jobs.step(job.id);
  const update=store.updateJob.bind(store);let interrupt=true;store.updateJob=(id,patch,privatePatch)=>{if(patch.state==='complete'&&interrupt){interrupt=false;throw Error('injected SQLite write failure after asset insert');}return update(id,patch,privatePatch);};
  await jobs.step(job.id);assert.equal(store.getProject(p.id).assets.length,0);assert.equal(store.getProject(p.id).shots[0].takes.length,0);assert.equal(store.job(job.id).private.result.state,'complete');
  await jobs.step(job.id);const current=store.getProject(p.id);assert.equal(current.assets.length,1);assert.equal(current.shots[0].takes.length,1);assert.equal(current.shots[0].selectedTakeId,current.shots[0].takes[0].id);assert.equal(submits,1);assert.equal(downloads,2);
});

test('interrupted media streams resume download from the persisted result and preserve the user-selected take',async t=>{
  const {store,p}=fixture(t);let submits=0,polls=0,downloads=0;
  const existing=store.addAsset(p.id,{name:'chosen.mp4',kind:'video',mime:'video/mp4'},Buffer.from('chosen')).asset;
  let current=store.getProject(p.id);current=store.change(p.id,current.revision,value=>{value.shots[0].takes.push({id:'chosen-take',assetId:existing.id,jobId:'previous',model:'fixture',referenceMode:'first_frame'});value.shots[0].selectedTakeId='chosen-take';return value;});
  const transport=new StudioProvider({baseUrl:'https://fixture.invalid/v1',backend:'seedance',apiKey:'synthetic'},{fetchImpl:async()=>{downloads++;return downloads===1?new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array([1,2]));controller.error(Error('injected stream disconnect'));}})):new Response('recovered-video');}});
  const jobs=new StudioJobs(store,{provider:{submit:async()=>{submits++;return {id:'operation',baseUrl:'https://fixture.invalid/v1',backend:'seedance'};},poll:async()=>{polls++;return {state:'complete',url:'https://fixture.invalid/v1/result.mp4',needsAuth:true};},download:transport.download.bind(transport)},validateMedia:async()=>({duration:3})});t.after(()=>jobs.close());
  const job=store.createJob(p.id,'generation','stream-fault',inputFor(current));await jobs.step(job.id);await jobs.step(job.id);assert.equal(store.job(job.id).job.state,'running');await jobs.step(job.id);
  assert.equal(store.getProject(p.id).shots[0].selectedTakeId,'chosen-take');assert.equal(store.getProject(p.id).shots[0].takes.length,2);assert.deepEqual({submits,polls,downloads},{submits:1,polls:1,downloads:2});
});

test('cross-project export inputs are rejected by the resolver before compositor can read media',async t=>{
  const {store,p}=fixture(t),other=store.createProject(createProject()),asset=store.addAsset(other.id,{name:'foreign.mp4',kind:'video',mime:'video/mp4'},Buffer.from('foreign')).asset;
  let gotPath=false;const jobs=new StudioJobs(store,{exportSequence:async({resolveAsset})=>{await resolveAsset(asset.id);gotPath=true;throw Error('must not reach');}});t.after(()=>jobs.close());
  const job=store.createJob(p.id,'export','foreign-export',{project:p});await jobs.step(job.id);assert.equal(gotPath,false);assert.equal(store.job(job.id).job.state,'failed');assert.match(store.job(job.id).job.error,/cross-project sequence asset/);assert.equal(store.getProject(p.id).assets.length,0);
});

test('SIGKILL during export resumes the frozen input in a new process without replacing later authoring',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'studio-export-crash-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const storeURL=new URL('./store.mjs',import.meta.url).href,jobsURL=new URL('./jobs.mjs',import.meta.url).href,domainURL=new URL('./domain.mjs',import.meta.url).href;
  const code=`import {StudioStore} from ${JSON.stringify(storeURL)};import {StudioJobs} from ${JSON.stringify(jobsURL)};import {createProject} from ${JSON.stringify(domainURL)};import {writeFileSync} from 'node:fs';const store=new StudioStore(process.env.FAULT_DIRECTORY);const p=store.createProject(createProject({name:'frozen export'}));const job=store.createJob(p.id,'export','crash-export',{project:p});store.change(p.id,p.revision,c=>{c.name='later authoring';return c;});const jobs=new StudioJobs(store,{exportSequence:async({outputPath})=>{writeFileSync(outputPath,'partial-output');process.stdout.write(JSON.stringify({jobId:job.id,projectId:p.id})+'\\n');await new Promise(()=>{});}});jobs.start();setInterval(()=>{},1000);`;
  const child=spawn(process.execPath,['--input-type=module','-e',code],{env:{PATH:process.env.PATH,FAULT_DIRECTORY:directory,NODE_NO_WARNINGS:'1'},stdio:['ignore','pipe','pipe']});t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
  const marker=await new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(Error('crash fixture did not reach export checkpoint')),10000);child.stdout.on('data',bytes=>{text+=bytes;if(text.includes('\n')){clearTimeout(timer);resolve(JSON.parse(text.split('\n')[0]));}});child.once('error',reject);child.once('exit',code=>{if(!text)reject(Error(`fixture exited ${code}`));});});
  const exited=once(child,'exit');child.kill('SIGKILL');await exited;
  const store=new StudioStore(directory);t.after(()=>store.close());let calls=0;
  const jobs=new StudioJobs(store,{exportSequence:async({project,outputPath})=>{calls++;assert.equal(project.name,'frozen export');assert.equal(readFileSync(outputPath,'utf8'),'partial-output');writeFileSync(outputPath,'completed-output');return {path:outputPath,frames:240,fps:24,duration:10,width:1280,height:720};}});t.after(()=>jobs.close());
  assert.equal(store.job(marker.jobId).job.state,'queued');await jobs.step(marker.jobId);assert.equal(calls,1);assert.equal(store.job(marker.jobId).job.state,'complete');assert.equal(store.getProject(marker.projectId).name,'later authoring');assert.equal(store.getProject(marker.projectId).assets.length,1);assert.equal(store.job(marker.jobId).job.output.sourceRevision,0);
});
