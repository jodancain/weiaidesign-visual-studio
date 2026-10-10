import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fail, StudioError } from './domain.mjs';
import { boundedBytes, SubmissionError } from './provider.mjs';
import { CodeJobs, CODE_JOB_KINDS } from './code-jobs.mjs';

const execFileAsync=promisify(execFile);
function generationReceipt(handle,result={}){
  const actualModel=Object.hasOwn(result,'actualModel')?result.actualModel:Object.hasOwn(handle,'actualModel')?handle.actualModel:result.model||handle.model;
  return {model:actualModel||'unreported',modelReported:Boolean(actualModel),requestedModel:handle.requestedModel||handle.model,referenceMode:handle.referenceMode,references:handle.references||[],ignoredReferences:handle.ignoredReferences||[],parameters:handle.parameters||{},prompt:handle.prompt,requestBodyHash:handle.requestBodyHash,...(handle.warning?{warning:handle.warning}:{}),...(result.state==='complete'&&result.providerOriginalLastFrame?{providerOriginalLastFrame:result.providerOriginalLastFrame}:{})};
}
function verifyWorkerIdentity(receipt,record){
  fail(receipt?.jobRef===record.job.id&&['id','jobId','job_id'].every(key=>receipt[key]===undefined||receipt[key]===record.job.id),'worker receipt identity does not match this preview job',409);
  fail(receipt.inputHash===record.private.inputHash,'worker receipt input hash does not match the submitted preview',409);
}
export async function probeMediaAsset(path,kind='video',ffprobePath='ffprobe'){
  const {stdout}=await execFileAsync(ffprobePath,['-v','error','-show_entries','format=duration:stream=codec_type,duration,width,height','-of','json',path],{timeout:30000,maxBuffer:1000000});
  const info=JSON.parse(stdout),stream=info.streams?.find(s=>s.codec_type===kind);fail(stream,`asset contains no decodable ${kind}`,422);
  const duration=Number(stream.duration||info.format?.duration);fail(Number.isFinite(duration)&&duration>0,'asset has no finite duration',422);
  return {duration,...(kind==='video'?{width:stream.width,height:stream.height}:{})};
}
async function probeVideo(path,expectedFrames,ffprobePath='ffprobe'){
  const media=await probeMediaAsset(path,'video',ffprobePath);fail(media.width>0&&media.height>0,'provider output contains no decodable video',502);
  fail(media.duration*24+0.1>=expectedFrames,'provider video is shorter than the approved shot; it cannot be stretched silently',422);return media;
}
export class StudioJobs {
  constructor(store,{provider,workerUrl='',workerToken='',fetchImpl=fetch,exportSequence,archiveVideo,ffmpegPath='ffmpeg',ffprobePath='ffprobe',validateMedia=probeVideo,pollIntervalMs=5000,maxConcurrent=2,codeWorkerUrl='',codeWorkerToken='',codeOptions={}}={}){
    Object.assign(this,{store,provider,workerUrl:workerUrl.replace(/\/+$/,''),workerToken,fetch:fetchImpl,exportSequence,archiveVideo,ffmpegPath,ffprobePath,validateMedia,pollIntervalMs,maxConcurrent});
    this.code=new CodeJobs(store,{provider,codeWorkerUrl,codeWorkerToken,fetchImpl,pollIntervalMs,ffprobePath,ffmpegPath,...codeOptions});
    this.active=new Set();this.closed=false;store.recoverJobs();store.prepareArchives(Boolean(archiveVideo));
  }
  start(){if(!this.timer){this.timer=setInterval(()=>this.tick(),1000);this.timer.unref();queueMicrotask(()=>this.tick());}return this;}
  async close(){this.closed=true;clearInterval(this.timer);while(this.active.size)await new Promise(r=>setTimeout(r,10));}
  tick(){if(this.closed)return;for(const id of this.store.pendingJobs()){if(this.active.size>=this.maxConcurrent)break;if(this.active.has(id))continue;const r=this.store.job(id);if(r.private.nextPollAt>Date.now())continue;this.active.add(id);this.step(id).catch(()=>{}).finally(()=>this.active.delete(id));}}
  async step(id){
    const record=this.store.job(id);if(CODE_JOB_KINDS.includes(record.job.kind))return this.code.step(id);if(record.job.state==='complete'&&['pending','running'].includes(record.private.archiveState))return this.archive(id);if(!['queued','running'].includes(record.job.state))return record.job;
    try{let result;if(record.job.kind==='generation')result=await this.generation(id);else if(record.job.kind==='preview')result=await this.preview(id);else if(record.job.kind==='export')result=await this.export(id);else throw new StudioError('Unknown job kind; dispatch refused',422,'unknown_job_kind');if(result.state==='complete'&&record.job.kind!=='preview')return this.store.queueArchive(id,Boolean(this.archiveVideo));return result;}
    catch(error){const r=this.store.job(id);if(r.job.state==='complete')return r.job;
      if(r.job.kind==='generation'&&r.private.phase==='submitting'&&!r.private.handle){const uncertain=error instanceof SubmissionError?error.uncertain:!(error instanceof StudioError);return this.store.updateJob(id,{state:uncertain?'uncertain':'failed',error:String(error.message).slice(0,1500)},{phase:uncertain?'uncertain':'failed'});}
      if((r.private.handle||r.job.kind==='preview')&&!(error instanceof StudioError&&error.status>=400&&error.status<500)){
        const failures=(r.private.pollFailures||0)+1;
        // Poll/download retries are safe because the accepted operation ID is durable.
        if(failures<=120)return this.store.updateJob(id,{state:'running',error:String(error.message).slice(0,1500)},{pollFailures:failures,nextPollAt:Date.now()+Math.min(60000,this.pollIntervalMs*failures)});
      }
      const uncertain=r.job.kind==='generation'&&r.private.handle&&!(r.private.result?.state==='complete'&&error instanceof StudioError&&error.status===422);
      const state=uncertain?'uncertain':'failed';
      return this.store.updateJob(id,{state,error:String(error.message).slice(0,1500)+(uncertain?' Provider acceptance is known but completion could not be verified; automatic resubmission is disabled.':'')},{phase:state});
    }
  }
  async archive(id){
    const r=this.store.job(id);if(!this.archiveVideo)return this.store.queueArchive(id,false);
    const attempts=(r.private.archiveAttempts||0)+1;this.store.updateJob(id,{output:{...r.job.output,archive:{state:'running'}}},{archiveState:'running',archiveAttempts:attempts});
    try{
      const asset=this.store.getAsset(r.job.outputAssetId),receipt=await this.archiveVideo(id,asset.path,asset.asset.name,{...asset.asset.metadata,studioProjectId:r.job.projectId,studioJobKind:r.job.kind,assetHash:asset.asset.hash});
      fail(typeof receipt?.id==='string'&&receipt.id.length>0,'NAS archive returned no durable record',502);
      fail(receipt.source_task_id===id&&receipt.kind==='studio-v3-video','NAS archive receipt belongs to a different task',502);
      fail(receipt.size===asset.asset.bytes&&receipt.metadata?.assetHash===asset.asset.hash,'NAS archive receipt does not match the local artifact',502);
      return this.store.updateJob(id,{output:{...r.job.output,archive:{state:'complete',id:receipt.id,publicUrl:receipt.public_url||null,bytes:receipt.size,deduped:Boolean(receipt.deduped)}}},{archiveState:'complete',nextPollAt:0});
    }catch{
      const state=attempts<3?'pending':'failed';return this.store.updateJob(id,{output:{...r.job.output,archive:{state,error:'NAS 归档暂未完成，本地成片仍可播放和下载。'}}},{archiveState:state,nextPollAt:Date.now()+attempts*30000});
    }
  }
  async generation(id){
    let r=this.store.job(id);
    if(!r.private.handle){
      this.store.updateJob(id,{state:'running',progress:0.02},{phase:'submitting',attempts:r.private.attempts+1});
      const handle=await this.provider.submit(r.private.input,async assetId=>{const a=this.store.getAsset(assetId);fail(a.projectId===r.job.projectId,'cross-project asset access');return {bytes:readFileSync(a.path),mime:a.asset.mime};},prepared=>{this.store.updateJob(id,{output:generationReceipt(prepared)},{submission:prepared});});
      this.store.updateJob(id,{state:'running',progress:0.1,output:generationReceipt(handle)},{phase:'accepted',handle,nextPollAt:Date.now()+this.pollIntervalMs});
      return this.store.job(id).job;
    }
    const handle=r.private.handle,result=r.private.result||await this.provider.poll(handle);
    if(result.state==='failed')return this.store.updateJob(id,{state:'failed',error:result.error},{phase:'failed'});
    if(result.state!=='complete')return this.store.updateJob(id,{state:'running',progress:result.progress||0.5,error:undefined},{nextPollAt:Date.now()+this.pollIntervalMs,pollFailures:0});
    this.store.updateJob(id,{progress:0.95,error:undefined},{phase:'downloading',result});
    const receipt=generationReceipt(handle,result),bytes=await this.provider.download(result,handle),prepared=this.store.prepareAsset(r.job.projectId,{name:`${r.private.input.shot.name}.mp4`,kind:'video',mime:'video/mp4',source:'provider',metadata:{jobId:id,approvalHash:r.private.input.approvalHash,model:receipt.model,requestedModel:receipt.requestedModel,referenceMode:handle.referenceMode,providerDuration:handle.providerDuration}},bytes);
    const media=await this.validateMedia(prepared.path,r.private.input.shot.endFrame-r.private.input.shot.startFrame,this.ffprobePath);
    return this.store.completeJob(id,{...prepared.asset,url:undefined,id:undefined,metadata:{...prepared.asset.metadata,...media}},bytes,{...r.job.output,...receipt,...media,approvalHash:r.private.input.approvalHash});
  }
  workerHeaders(json=false){return {...(json?{'content-type':'application/json'}:{}),...(this.workerToken?{authorization:`Bearer ${this.workerToken}`}:{})};}
  async workerRequest(url,options={}){const response=await this.fetch(url,{...options,redirect:'error',signal:AbortSignal.timeout(120000)});fail(response.ok,`Blender worker HTTP ${response.status}`,502);const data=await response.json();return data.data||data;}
  workerAssetURL(url,id){
    fail(typeof url==='string'&&url.length>0,'worker media URL is missing',409);
    let target;try{target=new URL(url,this.workerUrl+'/');}catch{throw new StudioError('worker media URL is invalid',409);}
    fail(target.origin===new URL(this.workerUrl).origin&&!target.username&&!target.password&&target.pathname.startsWith(`/api/v3/render/${encodeURIComponent(id)}/assets/`),'worker media URL must belong to this preview job on the worker origin',409);return target;
  }
  async workerAsset(url,id){const target=this.workerAssetURL(url,id);const response=await this.fetch(target,{headers:this.workerHeaders(),redirect:'error',signal:AbortSignal.timeout(300000)});fail(response.ok,`worker media download HTTP ${response.status}`,502);return boundedBytes(response,512*1024*1024);}
  async preview(id){
    fail(this.workerUrl,'Blender worker is not configured',503);let r=this.store.job(id),input=r.private.input;
    if(!r.private.handle){
      this.store.updateJob(id,{state:'running',progress:0.02},{phase:'submitting'});
      const baked=this.store.getAsset(input.bakedAssetId);fail(baked.projectId===r.job.projectId,'cross-project bake');
      const accepted=await this.workerRequest(`${this.workerUrl}/api/v3/render`,{method:'POST',headers:this.workerHeaders(true),body:JSON.stringify({jobRef:id,inputHash:r.private.inputHash,baked_glb_b64:readFileSync(baked.path).toString('base64'),scene:input.scene,frameStart:input.frameStart,frameEnd:input.frameEnd,fps:24,resolution:input.resolution||[1280,720],landmarks:input.landmarks||[]})});
      verifyWorkerIdentity(accepted,r);
      this.store.updateJob(id,{state:'running',progress:0.05},{phase:'accepted',handle:{id:accepted.jobRef},nextPollAt:Date.now()+this.pollIntervalMs});return this.store.job(id).job;
    }
    fail(r.private.handle.id===id,'worker accepted identity does not match this preview job',409);
    const result=await this.workerRequest(`${this.workerUrl}/api/v3/render/${encodeURIComponent(r.private.handle.id)}`,{headers:this.workerHeaders()});
    verifyWorkerIdentity(result,r);
    if(result.state==='failed')return this.store.updateJob(id,{state:'failed',error:result.error||'Blender preview failed'},{phase:'failed'});
    if(result.state!=='complete')return this.store.updateJob(id,{state:'running',progress:Math.min(0.9,(Number(result.progress)||20)/100),error:undefined},{nextPollAt:Date.now()+this.pollIntervalMs,pollFailures:0});
    const inRange=frame=>Number.isSafeInteger(frame)&&frame>=input.frameStart&&frame<input.frameEnd;
    fail(result.frames===input.frameEnd-input.frameStart&&result.fps===24&&JSON.stringify(result.resolution)===JSON.stringify(input.resolution||[1280,720]),'worker completion frame count, fps or resolution does not match the submitted preview',409);
    fail(Array.isArray(result.images)&&result.images.length>0&&result.images.every(item=>item&&typeof item==='object'&&inRange(item.frame)),'worker image frame is outside the requested preview range',409);
    fail(Array.isArray(result.landmarks)&&result.landmarks.every(item=>item&&inRange(item.frame)),'worker landmark frame is outside the requested preview range',409);
    // Validate the entire receipt before downloading or checkpointing even its first image.
    for(const item of result.images)this.workerAssetURL(item.url,id);
    if(result.video_url)this.workerAssetURL(result.video_url,id);
    const images=r.private.images||[];
    {
      for(const [i,item] of (Array.isArray(result.images)?result.images:[]).entries()){
        if(i<images.length)continue;
        const bytes=await this.workerAsset(item.url,id),frame=item.frame;
        // Asset, project revision and job checkpoint commit in one SQLite transaction.
        images.push(this.store.addJobImage(id,i,{name:`预览帧 ${i+1}.png`,kind:'image',mime:'image/png',source:'blender',metadata:{jobId:id,frame}},bytes,frame));
      }
    }
    if(!result.video_url){fail(input.frameEnd-input.frameStart===1&&images.length>0,'worker completed without preview video',502);return this.store.completeJobWithAsset(id,images[0].id,{images,landmarks:result.landmarks||[],landmarkValidation:result.landmarkValidation||null,inputHash:result.inputHash,frame:input.frameStart});}
    const bytes=await this.workerAsset(result.video_url,id),descriptor={name:'Blender 预览.mp4',kind:'video',mime:'video/mp4',source:'blender',metadata:{jobId:id,inputHash:result.inputHash,frameStart:input.frameStart,frameEnd:input.frameEnd}};
    const prepared=this.store.prepareAsset(r.job.projectId,descriptor,bytes);const media=await this.validateMedia(prepared.path,input.frameEnd-input.frameStart,this.ffprobePath);
    return this.store.completeJob(id,{...descriptor,metadata:{...descriptor.metadata,...media}},bytes,{...media,images,landmarks:result.landmarks||[],landmarkValidation:result.landmarkValidation||null,inputHash:r.private.inputHash});
  }
  async export(id){
    const r=this.store.job(id),project=r.private.input.project;
    this.store.updateJob(id,{state:'running',progress:0.1},{phase:'rendering'});
    const dir=join(this.store.workDirectory,id);mkdirSync(dir,{recursive:true});
    const compositor=this.exportSequence||(await import('./compositor.mjs')).exportSequence;
    const result=await compositor({project,outputPath:join(dir,'final.mp4'),resolveAsset:async assetId=>{const a=this.store.getAsset(assetId);fail(a.projectId===r.job.projectId,'cross-project sequence asset');return a.path;},ffmpegPath:this.ffmpegPath,ffprobePath:this.ffprobePath});
    const {path,...metadata}=result;
    return this.store.completeJob(id,{name:`${project.name}.mp4`,kind:'video',mime:'video/mp4',source:'export',metadata:{...metadata,sourceRevision:project.revision,sequenceId:project.sequence.id}},readFileSync(path),{...metadata,sourceRevision:project.revision});
  }
}
