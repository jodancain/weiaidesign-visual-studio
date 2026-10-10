import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { clone, digest, fail, StudioError } from './domain.mjs';
import { validateEffectsProgram, effectsSchema, effectsProgramHash } from './effects-program.mjs';
import { extractEffectsFrames, effectsSource } from './effects-source.mjs';
import { glbMetadata } from './glb.mjs';
import { boundedBytes, SubmissionError } from './provider.mjs';

export const SCENE_MODEL='claude-opus-5-5';
export const MODEL_JOB_KINDS=['scene-generation','effects-plan'];
export const CODE_JOB_KINDS=[...MODEL_JOB_KINDS,'render','enhancement','effects-render'];
export const NR_RUNTIME=Object.freeze({executableSHA256:'fdefd51abf31a63f20f970f8a7a82d230e825dd3da962836b8e9e8febbf16b89',nrSHA256:'6eb209e764f39872625debd6abaf45e2bb6322f6f270f781f70c059ae30b3927'});
export const NR_PARAMETERS=Object.freeze({stages:'nr',preset:'natural',passes:1,processingScale:100,frameGeneration:false,superResolution:false});
const exec=promisify(execFile),stamp=()=>new Date().toISOString();
const hashPattern=/^[a-f0-9]{64}$/;
export { validateSceneProgram, sceneSchema } from './code-schema.mjs';
import { validateSceneProgram, sceneSchema } from './code-schema.mjs';
export async function inspectVideo(path,ffprobePath='ffprobe'){
  const {stdout}=await exec(ffprobePath,['-v','error','-count_frames','-show_entries','format=duration:stream=codec_type,width,height,r_frame_rate,avg_frame_rate,nb_read_frames,duration','-of','json',path],{timeout:120000,maxBuffer:2000000});
  const data=JSON.parse(stdout),video=data.streams?.find(s=>s.codec_type==='video');fail(video,'output contains no video',422);
  const [a,b]=String(video.avg_frame_rate||video.r_frame_rate).split('/').map(Number),fps=a/b,frames=Number(video.nb_read_frames),duration=Number(video.duration||data.format?.duration);
  fail(Number.isFinite(fps)&&fps>0&&Number.isSafeInteger(frames)&&frames>0&&Number.isFinite(duration)&&duration>0,'video timing is not verifiable',422);
  const hasAudio=data.streams.some(s=>s.codec_type==='audio');let audioPacketHash=null,audioTimelineHash=null;if(hasAudio){const result=await exec(ffprobePath,['-v','error','-select_streams','a:0','-show_packets','-show_data_hash','sha256','-show_entries','packet=data_hash,pts_time,dts_time,duration_time,size,side_data_list','-of','json',path],{timeout:120000,maxBuffer:16000000});const packets=JSON.parse(result.stdout).packets;fail(Array.isArray(packets)&&packets.length&&packets.every(p=>typeof p.data_hash==='string'),'audio packet identity cannot be verified',422);audioPacketHash=digest(packets.map(p=>p.data_hash));audioTimelineHash=digest(packets.map(p=>[p.pts_time,p.dts_time,p.duration_time,p.size,p.side_data_list||[]]));}
  return {fps,frames,duration,width:video.width,height:video.height,hasAudio,audioPacketHash,audioTimelineHash};
}
function checkEmbeddedModel(bytes){
  glbMetadata(bytes);let json;
  for(let n=12;n<bytes.length;){const size=bytes.readUInt32LE(n),type=bytes.readUInt32LE(n+4);if(type===0x4e4f534a)json=JSON.parse(bytes.subarray(n+8,n+8+size).toString('utf8').trim());n+=8+size;}
  const walk=value=>{if(value&&typeof value==='object'){for(const [key,child] of Object.entries(value)){if(key==='uri')fail(typeof child==='string'&&/^data:(application\/(octet-stream|gltf-buffer)|image\/(png|jpeg|webp));base64,[A-Za-z0-9+/]*={0,2}$/.test(child),'render models must embed all buffers and images; external URIs are forbidden',422);else walk(child);}}};walk(json);
}
export class CodeJobs {
  constructor(store,{provider,codeWorkerUrl='',codeWorkerToken='',fetchImpl=fetch,pollIntervalMs=5000,ffprobePath='ffprobe',inspectMedia=inspectVideo,validateProgram=validateSceneProgram,programSchema=sceneSchema,runtimeHashProvider,ffmpegPath='ffmpeg',extractFrames=extractEffectsFrames}={}){
    Object.assign(this,{store,provider,workerUrl:codeWorkerUrl.replace(/\/+$/,''),workerToken:codeWorkerToken,fetch:fetchImpl,pollIntervalMs,ffprobePath,inspectMedia,validateProgram,programSchema,runtimeHashProvider,ffmpegPath,extractFrames});this.controllers=new Map();this.active=new Set();
  }
  headers(json=false){return {...(json?{'content-type':'application/json'}:{}),...(this.workerToken?{authorization:`Bearer ${this.workerToken}`}:{})};}
  async request(path,options={}){fail(this.workerUrl&&this.workerToken,'code worker is not configured',503);const response=await this.fetch(`${this.workerUrl}${path}`,{...options,headers:this.headers(Boolean(options.body)),redirect:'error',signal:AbortSignal.timeout(120000)});if(!response.ok)throw new StudioError(`Code worker HTTP ${response.status}`,response.status===404?404:response.status>=400&&response.status<500?409:502);const data=await response.json();return data.data||data;}
  checkIdentity(data,r){fail(data?.jobRef===r.job.id&&data.inputHash===r.private.inputHash,'code worker identity/hash mismatch',409,'worker_contract');fail(['queued','running','complete','failed','cancelled'].includes(data.status),'invalid code worker state',409,'worker_contract');}
  checkOrigin(r){fail(!r.private.workerOrigin||r.private.workerOrigin===this.workerUrl,'code worker configuration changed; restore original worker',409,'worker_changed');}
  async capabilities(){
    const fallback={available:false,renderers:{'three-webgl':{available:false,reason:'worker_unavailable'},remotion:{available:false,reason:'worker_unavailable'}},dlss:{available:false,reason:'worker_unavailable'},effects:{available:false,reason:'worker_unavailable'}};
    if(!this.workerUrl||!this.workerToken)return {...fallback,configured:false};
    try{const response=await this.fetch(`${this.workerUrl}/api/v3/code/capabilities`,{headers:this.headers(),redirect:'error',signal:AbortSignal.timeout(5000)}),body=await response.json(),data=body.data||body;if(!response.ok)return {...fallback,configured:true};if(hashPattern.test(data.runtimeHash))this.store.db.prepare('INSERT INTO worker_versions VALUES(?,?,?) ON CONFLICT(origin) DO UPDATE SET runtime_hash=excluded.runtime_hash,checked_at=excluded.checked_at').run(this.workerUrl,data.runtimeHash,stamp());return {configured:true,effects:{available:data.effects?.available===true,reason:String(data.effects?.reason||'').slice(0,500)},runtimeHash:hashPattern.test(data.runtimeHash)?data.runtimeHash:undefined,available:data.available===true,renderers:Object.fromEntries(['three-webgl','remotion'].map(k=>[k,{available:data.renderers?.[k]?.available===true,reason:String(data.renderers?.[k]?.reason||'').slice(0,500)}])),dlss:{available:data.dlss?.available===true,reason:String(data.dlss?.reason||'').slice(0,500)},...(data.waitingReason?{waitingReason:String(data.waitingReason).slice(0,500)}:{})};}catch{return {...fallback,configured:true};}
  }
  async runtimeHash(){
    if(this.runtimeHashProvider){const hash=await this.runtimeHashProvider();fail(hashPattern.test(hash),'invalid injected runtime hash',503);return hash;}
    const caps=await this.capabilities();if(hashPattern.test(caps.runtimeHash))return caps.runtimeHash;
    const previous=this.store.db.prepare('SELECT runtime_hash FROM worker_versions WHERE origin=?').get(this.workerUrl);fail(previous&&hashPattern.test(previous.runtime_hash),'Worker version has not been verified; connect the worker before submitting this task',503,'worker_version_unknown');return previous.runtime_hash;
  }
  async step(id){
    if(this.active.has(id))return this.store.job(id).job;this.active.add(id);
    try{
      let r=this.store.job(id);fail(CODE_JOB_KINDS.includes(r.job.kind),'unknown code task kind',422);if(r.job.kind==='effects-plan'&&r.job.state==='complete'&&['pending','waiting'].includes(r.private.effectsHandoff))return await this.handoffEffects(id);if(!['queued','running'].includes(r.job.state))return r.job;
      if(r.private.cancelRequested){if(MODEL_JOB_KINDS.includes(r.job.kind))return this.store.updateJob(id,{state:r.private.phase==='submitting'?'uncertain':'cancelled',stage:'cancelled',cancellable:false,retryable:!r.private.attempts},{phase:r.private.phase==='submitting'?'uncertain':'cancelled'});return await this.cancelWorker(r);}
      return MODEL_JOB_KINDS.includes(r.job.kind)?await this.scene(id):await this.worker(id);
    }catch(error){
      const r=this.store.job(id);if(['complete','cancelled','uncertain'].includes(r.job.state))return r.job;
      const message=String(error.message||'Task failed').slice(0,1500);
      if(MODEL_JOB_KINDS.includes(r.job.kind)){
        const uncertain=r.private.phase==='submitting'&&(error instanceof SubmissionError?error.uncertain:!(error instanceof StudioError));
        return this.store.updateJob(id,{state:uncertain?'uncertain':'failed',stage:uncertain?'acceptance_unknown':'failed',error:message,cancellable:false,retryable:!uncertain&&!r.private.attempts},{phase:uncertain?'uncertain':'failed'});
      }
      if(r.private.cancelRequested)return this.store.updateJob(id,{state:'running',stage:'cancelling',waitingReason:message,cancellable:false,retryable:false},{nextPollAt:Date.now()+Math.max(1000,this.pollIntervalMs)});
      // Reconciliation only. Idempotent worker jobRef survives a lost POST response;
      // no model call is ever hidden behind this retry path.
      if(!(error instanceof StudioError&&error.status>=400&&error.status<500))return this.store.updateJob(id,{state:r.private.handle?'running':'queued',stage:'waiting_for_worker',waitingReason:message,cancellable:true,retryable:false},{nextPollAt:Date.now()+Math.max(1000,this.pollIntervalMs),pollFailures:(r.private.pollFailures||0)+1});
      return this.store.updateJob(id,{state:'failed',stage:'failed',error:message,cancellable:false,retryable:error.code!=='worker_contract'},{phase:'failed'});
    }finally{this.active.delete(id);}
  }
  async scene(id){
    let r=this.store.job(id);const effects=r.job.kind==='effects-plan';
    if(r.private.phase==='submitting'&&!r.private.response)return this.store.updateJob(id,{state:'uncertain',stage:'acceptance_unknown',error:'Model acceptance is unknown; automatic resubmission and retry are disabled.',cancellable:false,retryable:false},{phase:'uncertain'});
    if(!r.private.response){
      fail(typeof this.provider?.[effects?'generateEffects':'generateScene']==='function'&&this.provider.capabilities().llm,'Planning model is not configured',503);
      if(effects&&!r.private.frames){const source=effectsSource(this.store,r.job.projectId,r.private.input.sourceAssetId,r.private.input.sourceHash);const frames=await this.extractFrames(source.path,r.private.input.sourceMedia,{ffmpegPath:this.ffmpegPath});fail(Array.isArray(frames)&&frames.length>0&&frames.length<=6,'actual source frames are required',422);this.store.updateJob(id,{stage:'source_frames_ready'},{frames});r=this.store.job(id);}
      if(r.private.cancelRequested)return this.store.updateJob(id,{state:'cancelled',stage:'cancelled',cancellable:false,retryable:!r.private.attempts},{phase:'cancelled'});
      fail((r.private.attempts||0)<3,'Scene validation repair limit reached',422);
      const repair=r.private.validationError?{index:r.private.attempts,error:r.private.validationError,previous:r.private.invalidContent}:undefined;
      const controller=new AbortController();this.controllers.set(id,controller);
      this.store.updateJob(id,{state:'running',stage:repair?(effects?'repairing_effects':'repairing_scene'):(effects?'planning_effects':'generating_scene'),progress:0.1,cancellable:true,retryable:false},{phase:'submitting',attempts:(r.private.attempts||0)+1});
      try{
        const response=await this.provider[effects?'generateEffects':'generateScene'](r.private.input,{signal:controller.signal,schema:JSON.stringify(effects?effectsSchema():this.programSchema()),frames:r.private.frames,repair,resolveAsset:async assetId=>{const a=this.store.getAsset(assetId);fail(a.projectId===r.job.projectId,'cross-project scene reference',409);return {bytes:readFileSync(a.path),mime:a.asset.mime};},onPrepared:prepared=>{const live=this.store.job(id);fail(!live.private.cancelRequested,'Planning cancelled before provider submission',409,'cancelled');fail(!live.private.submissions?.length||live.private.submissions[0].baseUrl===prepared.baseUrl,'scene provider route changed during validation repair; restore the original route',409,'provider_changed');this.store.updateJob(id,{output:{...live.job.output,requestedModel:SCENE_MODEL}},{submissions:[...(live.private.submissions||[]),prepared]});}});
        const live=this.store.job(id);this.store.updateJob(id,{}, {phase:'validating',response,provenance:[...(live.private.provenance||[]),response.provenance]});
      }finally{this.controllers.delete(id);}
    }
    r=this.store.job(id);if(r.private.cancelRequested)return this.store.updateJob(id,{state:'cancelled',stage:'cancelled',cancellable:false,retryable:false},{phase:'cancelled'});
    const response=r.private.response;
    fail(response.provenance?.requestedModel===SCENE_MODEL&&response.provenance?.actualModel===SCENE_MODEL,'Scene response did not verify the required claude-opus-5-5 model; no fallback is permitted',409,'model_mismatch');
    let program;
    try{program=JSON.parse(response.content.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''));if(effects)validateEffectsProgram(program,{source:r.private.input.sourceMedia});else {this.validateProgram(program);fail(program.fps===24&&program.totalFrames===r.private.input.totalFrames&&program.film===r.private.input.film,'Generated scene timing differs from requested project',422,'invalid_scene_program');}}
    catch(error){
      if(r.private.attempts>=3)return this.store.updateJob(id,{state:'failed',stage:'validation_failed',error:'Scene remained invalid after two repairs.',cancellable:false,retryable:false,output:{requestedModel:SCENE_MODEL,provenance:r.private.provenance}},{phase:'failed',validationError:String(error.message).slice(0,2000)});
      return this.store.updateJob(id,{state:'queued',stage:'repair_pending',progress:0.2,error:'Scene JSON was invalid; a bounded validation repair is pending.'},{phase:'repair_pending',validationError:String(error.message).slice(0,2000),invalidContent:response.content.slice(0,100000),response:null,nextPollAt:0});
    }
    if(effects){this.store.updateJob(id,{state:'complete',stage:'complete',progress:1,cancellable:Boolean(r.private.input.autoRender),retryable:false,output:{effectsProgram:program,effectsProgramHash:effectsProgramHash(program),sourceAssetId:r.private.input.sourceAssetId,sourceHash:r.private.input.sourceHash,requestedModel:SCENE_MODEL,actualModel:response.provenance.actualModel,provenance:r.private.provenance,sourceRevision:r.private.input.sourceRevision}},{phase:'complete',effectsProgram:program,effectsHandoff:r.private.input.autoRender?'pending':'manual',nextPollAt:0});return r.private.input.autoRender?this.handoffEffects(id):this.store.job(id).job;}
    return this.store.updateJob(id,{state:'complete',stage:'complete',progress:1,cancellable:false,retryable:false,sceneProgram:program,output:{sceneProgram:program,sceneProgramHash:digest(program),requestedModel:SCENE_MODEL,actualModel:response.provenance.actualModel,provenance:r.private.provenance,sourceRevision:r.private.input.sourceRevision}},{phase:'complete',sceneProgram:program});
  }
  async handoffEffects(id){
    const r=this.store.job(id);if(!r.private.input.autoRender||!['pending','waiting'].includes(r.private.effectsHandoff))return r.job;
    try{
      // Dynamic import avoids making the routes/module dependency a startup cycle.
      // The same transactional plan deduplication handles browser and server handoffs.
      const {submitCodeTask}=await import('./code-routes.mjs');const p=this.store.getProject(r.job.projectId);
      const render=await submitCodeTask({store:this.store,jobs:{code:this,provider:this.provider,ffprobePath:this.ffprobePath,tick(){}},project:p,route:'effects-renders',body:{baseRevision:p.revision,planJobId:id,planHash:r.job.output.effectsProgramHash,sourceAssetId:r.private.input.sourceAssetId,sourceHash:r.private.input.sourceHash,idempotencyKey:`effects-auto:${id}`},inspectMedia:this.inspectMedia});
      const live=this.store.job(id);if(live.private.cancelRequested){this.cancel(render.id);return live.job;}
      if(r.private.handoffRetryKey){const child=this.store.job(render.id);if(child.private.cancelRequested&&!['cancelled','failed','complete'].includes(child.job.state))throw new StudioError('Waiting for the prior cancellation to finish',503);if(['failed','cancelled'].includes(child.job.state))this.retry(render.id,`effects-handoff:${r.private.handoffRetryKey}`);}
      return this.store.updateJob(id,{stage:'complete',cancellable:false,waitingReason:undefined,renderJobId:render.id,output:{...r.job.output,renderJobId:render.id}},{effectsHandoff:'complete',renderJobId:render.id,handoffRetryKey:null,nextPollAt:0});
    }catch(error){
      if(this.store.job(id).private.cancelRequested)return this.store.job(id).job;
      const terminal=error instanceof StudioError&&error.status>=400&&error.status<500&&error.code!=='revision_conflict';
      return this.store.updateJob(id,{stage:terminal?'effects_handoff_failed':'waiting_for_effects_render',cancellable:!terminal,waitingReason:String(error.message||'Effects renderer unavailable').slice(0,1500)},{effectsHandoff:terminal?'failed':'waiting',nextPollAt:Date.now()+Math.min(60000,Math.max(1000,this.pollIntervalMs)*((r.private.handoffFailures||0)+1)),handoffFailures:(r.private.handoffFailures||0)+1});
    }
  }
  outputURL(output,id){
    fail(output&&typeof output.name==='string'&&/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,199}$/.test(output.name)&&!output.name.includes('..'),'invalid worker output name',409,'worker_contract');
    fail(hashPattern.test(output.sha256)&&Number.isSafeInteger(output.bytes)&&output.bytes>0&&output.bytes<=512*1024*1024,'invalid worker output identity',409,'worker_contract');
    fail(['video/mp4','image/png','image/jpeg','audio/wav','audio/mp4'].includes(output.mime),'invalid worker output MIME',409,'worker_contract');
    fail(['clean','base','enhanced','effects','comparison','shot','thumbnail','audio'].includes(output.role),'invalid worker output role',409,'worker_contract');
    let target;try{target=new URL(output.url,this.workerUrl+'/');}catch{throw new StudioError('invalid worker media URL',409,'worker_contract');}
    fail(target.origin===new URL(this.workerUrl).origin&&!target.username&&!target.password&&!target.search&&!target.hash&&target.pathname===`/api/v3/code/media/${encodeURIComponent(id)}/${output.name}`,'worker media URL is outside this task',409,'worker_contract');return target;
  }
  async worker(id){
    let r=this.store.job(id);this.checkOrigin(r);
    if(r.private.retryPending){const response=await this.request(`/api/v3/code/jobs/${id}/retry`,{method:'POST',body:JSON.stringify({inputHash:r.private.inputHash,retryKey:r.private.retryPending})});this.checkIdentity(response,r);this.store.updateJob(id,{state:response.requiresSubmission?'queued':'running',stage:response.stage||'queued'},{retryPending:null,phase:response.requiresSubmission?'queued':'accepted',handle:response.requiresSubmission?null:{id}});return this.store.job(id).job;}
    if(!r.private.handle){
      let accepted;
      if(r.private.phase==='submitting')try{accepted=await this.request(`/api/v3/code/jobs/${id}`);}catch(error){if(!(error instanceof StudioError&&error.status===404))throw error;}
      if(!accepted){
        const assets=(r.private.input.assets||[]).map(ref=>{const a=this.store.getAsset(ref.id);fail(a.projectId===r.job.projectId&&a.asset.hash===ref.hash,'worker input asset changed',409);const bytes=readFileSync(a.path);fail(digest(bytes)===ref.hash,'worker input file hash changed',409);if(a.asset.kind==='model'||a.asset.kind==='bake')checkEmbeddedModel(bytes);return {id:ref.id,hash:ref.hash,mime:a.asset.mime,base64:bytes.toString('base64')};});
        this.store.updateJob(id,{state:'queued',stage:'submitting',cancellable:true,retryable:false},{phase:'submitting',workerOrigin:this.workerUrl});
        accepted=await this.request('/api/v3/code/jobs',{method:'POST',body:JSON.stringify({jobRef:id,inputHash:r.private.inputHash,kind:r.job.kind,spec:r.private.input.spec,assets})});
      }
      this.checkIdentity(accepted,r);if(accepted.status==='cancelled')return this.store.updateJob(id,{state:'cancelled',stage:'cancelled',cancellable:false,retryable:true},{handle:{id},phase:'cancelled',workerCancellationReceipt:accepted});this.store.updateJob(id,{state:'running',stage:accepted.stage||'queued',waitingReason:accepted.waitingReason||undefined},{handle:{id},phase:'accepted',nextPollAt:Date.now()+this.pollIntervalMs});return this.store.job(id).job;
    }
    const result=await this.request(`/api/v3/code/jobs/${id}`);this.checkIdentity(result,r);
    if(result.status==='complete'&&r.private.input.spec.runtimeHash)fail(result.receipt?.runtimeHash===r.private.input.spec.runtimeHash,'worker runtime version differs from frozen RenderSpec',409,'worker_contract');
    if(result.status==='complete'&&r.job.kind==='enhancement')fail(result.receipt?.nr?.featureId===18&&result.receipt.nr.created===true&&result.receipt.nr.evaluated===true&&result.receipt.parameters&&digest(result.receipt.parameters)===digest(NR_PARAMETERS)&&result.receipt.runtime?.executableSHA256===NR_RUNTIME.executableSHA256&&result.receipt.runtime?.nrSHA256===NR_RUNTIME.nrSHA256&&result.receipt.sourceAssetId===r.private.input.spec.sourceAssetId&&result.receipt.sourceHash===r.private.input.spec.sourceHash&&result.receipt.neuralInputHash===(r.private.input.spec.cleanSourceHash||r.private.input.spec.sourceHash),'NR completion lacks matching source, pinned runtime, Feature18 execution or exact parameters',409,'worker_contract');
    if(result.status==='complete'&&r.job.kind==='effects-render'){const spec=r.private.input.spec;fail(result.receipt?.sourceAssetId===spec.sourceAssetId&&result.receipt.sourceHash===spec.sourceHash&&result.receipt.effectsProgramHash===spec.effectsProgramHash,'effects completion lacks matching source and plan identity',409,'worker_contract');}
    fail(result.outputs===undefined||Array.isArray(result.outputs)&&result.outputs.length<=1000,'invalid worker outputs',409,'worker_contract');
    const outputs=result.outputs||[],names=new Set();if(r.job.kind==='effects-render')fail(outputs.every(o=>['effects','comparison'].includes(o.role))&&(result.status!=='complete'||outputs.length===2&&outputs.every(o=>o.mime==='video/mp4')&&['effects','comparison'].every(role=>outputs.filter(o=>o.role===role).length===1)),'effects output roles incomplete or invalid',409,'worker_contract');for(const item of outputs){this.outputURL(item,id);fail(!names.has(item.name),'duplicate worker output name',409,'worker_contract');names.add(item.name);}
    for(const item of outputs){
      r=this.store.job(id);if(r.private.cancelRequested)return this.cancelWorker(r);
      const existing=r.private.outputs?.[item.name];if(existing){fail(existing.hash===item.sha256&&existing.bytes===item.bytes,'worker overwrote an immutable output',409,'worker_contract');continue;}
      const response=await this.fetch(this.outputURL(item,id),{headers:this.headers(),redirect:'error',signal:AbortSignal.timeout(300000)});fail(response.ok,`worker output download HTTP ${response.status}`,502);const bytes=await boundedBytes(response,512*1024*1024);fail(bytes.length===item.bytes&&digest(bytes)===item.sha256,'worker output bytes/hash mismatch',409,'worker_contract');
      const kind=item.mime.startsWith('video/')?'video':item.mime.startsWith('image/')?'image':'audio';
      const descriptor={name:item.name,kind,mime:item.mime,source:r.job.kind==='effects-render'?'effects-compositor':r.job.kind==='enhancement'?'dlss-nr':r.private.input.spec.backend,parentId:r.job.kind==='effects-render'?r.private.input.spec.sourceAssetId:undefined,metadata:{effectsProgramHash:r.private.input.spec.effectsProgramHash,planJobId:r.private.input.spec.planJobId,jobId:id,inputHash:r.private.inputHash,sourceRevision:r.private.input.sourceRevision,renderGroupId:r.job.renderGroupId,backend:r.private.input.spec.backend,role:item.role,runtimeHash:r.private.input.spec.runtimeHash,sourceAssetId:r.private.input.spec.sourceAssetId,sourceHash:r.private.input.spec.sourceHash}};
      if(kind==='video'){
        const prepared=this.store.prepareAsset(r.job.projectId,descriptor,bytes),media=await this.inspectMedia(prepared.path,this.ffprobePath),spec=r.private.input.spec;
        let frames=spec.totalFrames;if(item.role==='shot'){fail(Number.isSafeInteger(item.frameStart)&&Number.isSafeInteger(item.frameEnd)&&item.frameStart>=0&&item.frameEnd>item.frameStart&&item.frameEnd<=spec.totalFrames,'invalid partial shot frames',409,'worker_contract');frames=item.frameEnd-item.frameStart;}
        fail(media.fps===24&&media.frames===frames&&media.width===(item.role==='comparison'?spec.width*2:spec.width)&&media.height===spec.height&&Math.abs(media.duration-frames/24)<.05,'worker video frame/fps/resolution mismatch',409,'worker_contract');if((r.job.kind==='enhancement'&&item.role==='enhanced'||r.job.kind==='effects-render'&&['effects','comparison'].includes(item.role))&&spec.sourceMedia?.hasAudio)fail(media.hasAudio&&media.audioPacketHash===spec.sourceMedia.audioPacketHash,'enhancement did not preserve source audio packet identity',409,'worker_contract');if(r.job.kind==='effects-render')fail(media.hasAudio===spec.sourceMedia.hasAudio&&media.audioTimelineHash===spec.sourceMedia.audioTimelineHash,'effects changed source audio timeline or presence',409,'worker_contract');descriptor.metadata={...descriptor.metadata,...media};
      }
      this.store.checkpointOutput(id,item.name,descriptor,bytes,{role:item.role,backend:r.private.input.spec.backend,...(item.frameStart===undefined?{}:{frameStart:item.frameStart,frameEnd:item.frameEnd})});
    }
    r=this.store.job(id);
    if(result.status==='complete'){
      const finalRole=r.job.kind==='effects-render'?'effects':r.job.kind==='enhancement'?'enhanced':'base',final=(r.job.partialAssets||[]).find(a=>a.role===finalRole&&a.kind==='video');fail(final,'worker completed without a final video',409,'worker_contract');

      return this.store.updateJob(id,{state:'complete',stage:'complete',progress:1,outputAssetId:final.id,cancellable:false,retryable:false,waitingReason:undefined,error:undefined,output:{planJobId:r.job.planJobId,planHash:r.job.planHash,sourceAssetId:r.job.sourceAssetId,sourceHash:r.job.sourceHash,inputHash:r.private.inputHash,specHash:r.private.input.spec.specHash,renderGroupId:r.job.renderGroupId,sourceRevision:r.private.input.sourceRevision,assets:r.job.partialAssets||[],receipt:result.receipt||null}},{phase:'complete',workerReceipt:result});
    }
    if(['failed','cancelled'].includes(result.status))return this.store.updateJob(id,{state:result.status,stage:result.stage||result.status,error:String(result.error||'').slice(0,1500),cancellable:false,retryable:true,waitingReason:undefined},{phase:result.status,workerReceipt:result});
    return this.store.updateJob(id,{state:result.status,stage:String(result.stage||'queued').slice(0,100),progress:Math.min(.99,Math.max(0,Number(result.progress)||0)),waitingReason:result.waitingReason?String(result.waitingReason).slice(0,1000):undefined,cancellable:true,retryable:false},{nextPollAt:Date.now()+this.pollIntervalMs,pollFailures:0});
  }
  async cancelWorker(r){this.checkOrigin(r);if(!r.private.handle&&r.private.phase!=='submitting')return this.store.updateJob(r.job.id,{state:'cancelled',stage:'cancelled',cancellable:false,retryable:true},{phase:'cancelled'});const response=await this.request(`/api/v3/code/jobs/${r.job.id}/cancel`,{method:'POST',body:JSON.stringify({inputHash:r.private.inputHash})});this.checkIdentity(response,r);if(response.status==='complete')return this.store.updateJob(r.job.id,{state:'running',stage:'recovering_completed_output',cancellable:false,retryable:false,cancellationTooLate:true,waitingReason:'Worker already completed; recovering the existing immutable output.'},{cancelRequested:false,phase:'accepted',handle:{id:r.job.id},nextPollAt:0,workerCancellationReceipt:response});if(['cancelled','failed'].includes(response.status))return this.store.updateJob(r.job.id,{state:'cancelled',stage:'cancelled',cancellable:false,retryable:true},{phase:'cancelled',workerCancellationReceipt:response});return this.store.updateJob(r.job.id,{state:'running',stage:'cancelling',cancellable:false},{nextPollAt:Date.now()+this.pollIntervalMs});}
  cancel(id){const r=this.store.job(id);fail(CODE_JOB_KINDS.includes(r.job.kind),'this task does not support cancellation',409);if(r.job.kind==='effects-plan'&&r.job.state==='complete'&&['pending','waiting'].includes(r.private.effectsHandoff)){const job=this.store.updateJob(id,{state:'cancelled',stage:'cancelled',cancellable:false,retryable:true},{cancelRequested:true,effectsHandoff:'cancelled',handoffRetryKey:null,phase:'cancelled'});const render=this.store.listJobs(r.job.projectId).find(j=>j.kind==='effects-render'&&j.planJobId===id);if(render)this.cancel(render.id);return job;}if(['complete','failed','cancelled','uncertain'].includes(r.job.state))return r.job;const job=this.store.updateJob(id,{stage:'cancelling',cancellable:false},{cancelRequested:true,nextPollAt:0});this.controllers.get(id)?.abort();return job;}
  retry(id,key){return this.store.jobAction(id,'retry',key,{key},r=>{if(r.job.kind==='effects-plan'&&r.private.effectsProgram&&['cancelled','failed'].includes(r.private.effectsHandoff)){return this.store.updateJob(id,{state:'complete',stage:'waiting_for_effects_render',cancellable:true,retryable:false,waitingReason:undefined},{cancelRequested:false,effectsHandoff:'pending',handoffRetryKey:key,phase:'complete',nextPollAt:0});}fail(CODE_JOB_KINDS.includes(r.job.kind)&&['failed','cancelled'].includes(r.job.state)&&r.job.retryable!==false,'this task cannot be retried safely',409,'retry_forbidden');fail(!MODEL_JOB_KINDS.includes(r.job.kind)||!r.private.attempts,'model submissions cannot be replayed',409,'retry_forbidden');return this.store.updateJob(id,{state:'queued',stage:'retry_pending',error:undefined,waitingReason:undefined,cancellable:true,retryable:false},{cancelRequested:false,retryPending:!MODEL_JOB_KINDS.includes(r.job.kind)&&(r.private.handle||r.private.workerCancellationReceipt?.cancelledBeforeAcceptance)?key:null,phase:r.private.handle?'accepted':'queued',nextPollAt:0});});}
}
