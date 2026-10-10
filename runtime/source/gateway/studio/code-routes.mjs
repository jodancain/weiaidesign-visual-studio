import { clone, digest, fail, validateProject } from './domain.mjs';
import { randomUUID } from 'node:crypto';
import { effectsSource } from './effects-source.mjs';
import { validateEffectsProgram, effectsProgramHash } from './effects-program.mjs';
import { engineeringBaseline } from './code-schema.mjs';
import { CODE_JOB_KINDS, NR_PARAMETERS, SCENE_MODEL, inspectVideo } from './code-jobs.mjs';

export function copyDemo(store,source,visitorId,name){
  const assetIds=new Map(source.assets.map(a=>[a.id,randomUUID()])),newId=randomUUID();
  const replace=value=>typeof value==='string'?(assetIds.get(value)||value.replace(/^\/api\/v3\/assets\/([^/]+)\/content$/,(_m,id)=>`/api/v3/assets/${assetIds.get(id)||id}/content`)):Array.isArray(value)?value.map(replace):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,replace(v)])):value;
  const p=replace(clone(source));p.id=newId;p.name=typeof name==='string'&&name.trim()?name.trim().slice(0,500):`${source.name} · 我的副本`;p.revision=0;p.createdAt=p.updatedAt=new Date().toISOString();delete p.access;
  for(const shot of p.shots){shot.takes=[];delete shot.approval;delete shot.selectedTakeId;}
  return store.transaction(()=>{
    store.createProject(p,visitorId);
    for(const old of source.assets){const row=store.getAsset(old.id);fail(row.projectId===source.id,'invalid demo asset owner',409);const asset=p.assets.find(a=>a.id===assetIds.get(old.id));store.insertAsset(p.id,{asset,path:row.path});store.db.prepare('INSERT INTO asset_origins VALUES(?,?)').run(asset.id,old.id);}
    return p;
  });
}
function assetRefs(project,ids){const unique=[...new Set(ids)];fail(unique.reduce((size,id)=>size+(project.assets.find(a=>a.id===id)?.bytes||0),0)<=512*1024*1024,'task asset transfer exceeds 512 MB',413);return unique.map(id=>{const a=project.assets.find(a=>a.id===id);fail(a,'input asset does not belong to this project',404);return {id:a.id,hash:a.hash,mime:a.mime,kind:a.kind};}).sort((a,b)=>a.id.localeCompare(b.id));}
function aliasJob(store,projectId,key,job){return store.transaction(()=>{const old=store.db.prepare('SELECT job_id FROM job_receipts WHERE project_id=? AND idempotency_key=?').get(projectId,key);fail(!old||old.job_id===job.id,'idempotency key already used with different request',409,'idempotency_conflict');if(!old)store.db.prepare('INSERT INTO job_receipts VALUES(?,?,?,?)').run(projectId,key,store.job(job.id).private.inputHash,job.id);return job;});}
function requireRevision(body,p){fail(Number.isSafeInteger(body.baseRevision)&&body.baseRevision===p.revision,'project changed; reload and retry',409,'revision_conflict');}
function decorate(store,job,patch,requestHash){return job.stage?job:store.updateJob(job.id,{stage:'queued',sourceRevision:store.job(job.id).private.input.sourceRevision,cancellable:true,retryable:false,outputAssetIds:[],partialAssets:[],...patch},{requestHash});}
export async function submitCodeTask({store,jobs,project:p,route,body:b,inspectMedia=inspectVideo}){
  fail(typeof b.idempotencyKey==='string'&&b.idempotencyKey.length>0&&b.idempotencyKey.length<=170,'idempotencyKey is required (max 170 characters)');
  const {baseRevision:_revision,idempotencyKey:_key,...request}=b,requestHash=digest({route,request});
  const keys=route==='renders'?(b.backends||['three-webgl']).map(k=>`${b.idempotencyKey}:${k}`):[b.idempotencyKey];
  const receipts=keys.map(key=>store.db.prepare('SELECT job_id FROM job_receipts WHERE project_id=? AND idempotency_key=?').get(p.id,key));
  if(receipts.some(Boolean)){
    fail(receipts.every(Boolean),'incomplete render group receipt; use a new explicit request key',409);
    const existing=receipts.map(v=>store.job(v.job_id));fail(existing.every(v=>v.private.requestHash===requestHash),'idempotency key already used with different request',409,'idempotency_conflict');
    return route==='renders'?{jobs:existing.map(v=>v.job),renderGroupId:existing[0].job.renderGroupId}:existing[0].job;
  }
  if(route==='effects-renders'){
    const prior=store.listJobs(p.id).find(j=>j.kind==='effects-render'&&j.planJobId===b.planJobId);
    if(prior){fail(prior.planHash===b.planHash&&prior.sourceAssetId===b.sourceAssetId&&prior.sourceHash===b.sourceHash,'effects plan is already bound to a different source',409);return aliasJob(store,p.id,b.idempotencyKey,prior);}
  }
  if(route==='effects-plans'){const prior=store.listJobs(p.id).find(j=>j.kind==='effects-plan'&&['queued','running','uncertain'].includes(j.state)&&store.job(j.id).private.requestHash===requestHash);if(prior){return aliasJob(store,p.id,b.idempotencyKey,prior);}}
  requireRevision(b,p);
  if(['effects-plans','effects-renders'].includes(route)){
    fail(typeof b.sourceAssetId==='string'&&b.sourceAssetId.length>0&&typeof b.sourceHash==='string'&&/^[a-f0-9]{64}$/.test(b.sourceHash),'sourceAssetId and SHA256 sourceHash are required');
    if(route==='effects-renders')fail(typeof b.planJobId==='string'&&b.planJobId.length>0&&typeof b.planHash==='string'&&/^[a-f0-9]{64}$/.test(b.planHash),'planJobId and SHA256 planHash are required');
    const source=effectsSource(store,p.id,b.sourceAssetId,b.sourceHash);
    const media=await inspectMedia(source.path,jobs.ffprobePath);fail(media.fps===24&&media.frames<=7200&&media.width>=16&&media.height>=16&&media.width<=2560&&media.height<=2560&&media.width%2===0&&media.height%2===0&&media.width*media.height<=2560*1440,'effects requires 24 fps, at most 7200 frames and even dimensions up to 2560 / 3.7 megapixels',422);
    const sourceMedia={...media,totalFrames:media.frames};
    if(route==='effects-plans'){
      fail(jobs.provider?.capabilities().llm&&typeof jobs.provider.generateEffects==='function','Effects model is not configured',503);
      fail(typeof b.prompt==='string'&&b.prompt.trim()&&b.prompt.length<=20000,'prompt is required');
      fail(b.autoRender===undefined||typeof b.autoRender==='boolean','autoRender must be boolean');
      const input={sourceRevision:p.revision,autoRender:b.autoRender!==false,model:SCENE_MODEL,sourceAssetId:b.sourceAssetId,sourceHash:b.sourceHash,sourceMedia,sourceProvenance:source.provenance,context:source.context,prompt:b.prompt.trim()};
      const job=store.transaction(()=>{const prior=store.listJobs(p.id).find(j=>j.kind==='effects-plan'&&['queued','running','uncertain'].includes(j.state)&&store.job(j.id).private.requestHash===requestHash);if(prior){return aliasJob(store,p.id,b.idempotencyKey,prior);}return decorate(store,store.createJob(p.id,'effects-plan',b.idempotencyKey,input,{baseRevision:p.revision}),{requestedModel:SCENE_MODEL,sourceAssetId:b.sourceAssetId,sourceHash:b.sourceHash},requestHash);});jobs.tick();return job;
    }
    fail(jobs.code.workerUrl&&jobs.code.workerToken,'Code worker is not configured',503);
    const plan=store.job(b.planJobId);fail(plan.job.projectId===p.id&&plan.job.kind==='effects-plan'&&plan.job.state==='complete','completed effects plan not found',404);
    const effectsProgram=plan.private.effectsProgram;fail(effectsProgram&&effectsProgramHash(effectsProgram)===b.planHash,'effects plan hash changed',409);
    fail(plan.private.input.sourceAssetId===b.sourceAssetId&&plan.private.input.sourceHash===b.sourceHash,'effects plan source differs from selected version',409);
    validateEffectsProgram(effectsProgram,{source:sourceMedia});
    const runtimeHash=await jobs.code.runtimeHash();
    const spec={schemaVersion:1,runtimeHash,planJobId:b.planJobId,planHash:b.planHash,effectsProgram:clone(effectsProgram),effectsProgramHash:b.planHash,sourceAssetId:b.sourceAssetId,sourceHash:b.sourceHash,sourceMedia,fps:24,totalFrames:media.frames,width:media.width,height:media.height};spec.specHash=digest(spec);
    const input={sourceRevision:p.revision,spec,assets:assetRefs(p,[b.sourceAssetId])};
    const job=store.transaction(()=>{const livePlan=store.job(b.planJobId);fail(livePlan.job.state==='complete'&&!livePlan.private.cancelRequested,'effects planning was cancelled',409,'cancelled');const prior=store.listJobs(p.id).find(j=>j.kind==='effects-render'&&j.planJobId===b.planJobId);if(prior){fail(prior.planHash===b.planHash&&prior.sourceAssetId===b.sourceAssetId&&prior.sourceHash===b.sourceHash,'effects plan already bound',409);return aliasJob(store,p.id,b.idempotencyKey,prior);}return decorate(store,store.createJob(p.id,'effects-render',b.idempotencyKey,input,{baseRevision:p.revision}),{planJobId:b.planJobId,planHash:b.planHash,sourceAssetId:b.sourceAssetId,sourceHash:b.sourceHash},requestHash);});jobs.tick();return job;
  }
  if(route==='scene-generations'){
    fail(jobs.provider?.capabilities().llm,'Scene model is not configured',503);
    fail(['three-knocks','borrow-sunshine','last-seed-of-light'].includes(b.film),'choose one of the three supported story templates',422);
    fail(typeof b.prompt==='string'&&b.prompt.trim()&&b.prompt.length<=20000,'prompt is required');
    fail(p.totalFrames===1440&&p.aspect==='16:9','SceneProgram v1 requires a 60-second 16:9 project',422);
    fail(b.model===undefined||b.model===SCENE_MODEL,'Only claude-opus-5-5 is supported',422);
    fail(Array.isArray(b.referenceAssetIds||[])&&(b.referenceAssetIds||[]).length<=4,'up to four reference images are supported');
    const references=assetRefs(p,b.referenceAssetIds||[]);fail(references.every(a=>a.kind==='image'&&['image/png','image/jpeg','image/webp'].includes(a.mime)),'scene references must be images',422);
    fail(references.reduce((sum,a)=>sum+p.assets.find(v=>v.id===a.id).bytes,0)<=8*1024*1024,'scene references exceed 8 MB',413);
    const baseline=engineeringBaseline(b.film);
    const input={sourceRevision:p.revision,engineeringBaseline:baseline,engineeringBaselineHash:digest(baseline),film:b.film,prompt:b.prompt.trim(),model:SCENE_MODEL,fps:24,totalFrames:p.totalFrames,aspect:p.aspect,references,context:{projectId:p.id,name:p.name,shots:p.shots.map(({id,name,prompt,startFrame,endFrame,overlay,subjectIds})=>({id,name,prompt,startFrame,endFrame,overlay,subjectIds})),subjects:p.nodes.filter(n=>n.type==='subject').map(({id,label,text})=>({id,label,text}))}};
    const job=decorate(store,store.createJob(p.id,'scene-generation',b.idempotencyKey,input,{baseRevision:p.revision}),{requestedModel:SCENE_MODEL},requestHash);jobs.tick();return job;
  }
  fail(jobs.code.workerUrl&&jobs.code.workerToken,'Code worker is not configured',503);
  if(route==='renders'){
    const scene=p.scenes.find(s=>s.id===b.sceneId);fail(scene,'scene not found',404);fail(b.sceneRevision===scene.revision,'scene changed; reload before rendering',409,'revision_conflict');
    const backends=b.backends??['three-webgl'];fail(Array.isArray(backends)&&backends.length>0&&backends.length<=2&&new Set(backends).size===backends.length&&backends.every(v=>['three-webgl','remotion'].includes(v)),'invalid render backends');
    fail(Number.isSafeInteger(p.totalFrames)&&p.totalFrames>0&&p.totalFrames<=7200,'render task supports 1–7200 frames',422);
    let sceneProgram,provenance;
    if(scene.codeProgram){sceneProgram=clone(scene.codeProgram);jobs.code.validateProgram(sceneProgram);fail(scene.codeProgramHash===digest(sceneProgram),'scene program hash mismatch',409);fail(sceneProgram.totalFrames===p.totalFrames&&p.aspect==='16:9','scene program timing/aspect no longer matches project',409);provenance={jobId:scene.codeGenerationJobId,sceneProgramHash:scene.codeProgramHash,model:SCENE_MODEL};}
    if(b.sceneGenerationJobId)fail(scene.codeGenerationJobId===b.sceneGenerationJobId&&sceneProgram,'apply the completed generation to the director before rendering',409);
    const sequence={...clone(p.sequence),clips:clone(p.sequence.clips.filter(c=>['audio','text'].includes(c.kind)))};
    const assets=assetRefs(p,[...scene.objects.map(o=>o.assetId).filter(Boolean),...sequence.clips.map(c=>c.assetId).filter(Boolean)]);
    const [width,height]=p.aspect==='9:16'?[720,1280]:[1280,720],seed=sceneProgram?.seed??0;
    const renderProfile={fps:24,width,height,totalFrames:p.totalFrames,seed,colorSpace:'srgb',toneMapping:'aces',exposure:sceneProgram?.look?.exposure??scene.exposure,audio:'preserve',narration:false};
    const snapshot=clone(scene),sceneSnapshotHash=digest({sceneSnapshot:snapshot,sceneProgram:sceneProgram||null,assets}),renderProfileHash=digest({renderProfile,sequence});
    const renderGroupId=digest({projectId:p.id,idempotencyKey:b.idempotencyKey,sceneSnapshotHash,renderProfileHash}).slice(0,32);
    const runtimeHash=await jobs.code.runtimeHash();
    const common={schemaVersion:1,runtimeHash,backends,renderGroupId,projectId:p.id,sourceRevision:p.revision,sceneId:scene.id,sceneRevision:scene.revision,fps:24,width,height,totalFrames:p.totalFrames,seed,sceneSnapshot:snapshot,...(sceneProgram?{sceneProgram,provenance}:{}),sceneSnapshotHash,renderProfile,renderProfileHash,sequence,assets};
    const {backends:_backends,...hashable}=common,specHash=digest(hashable);
    // Validate both requested keys before creating either sibling, avoiding a half-created group on conflict.
    fail(typeof b.idempotencyKey==='string'&&b.idempotencyKey.length>0&&b.idempotencyKey.length<=170,'idempotencyKey is required (max 170 characters)');
    const pending=backends.map(backend=>({backend,key:`${b.idempotencyKey}:${backend}`,input:{sourceRevision:p.revision,spec:{...common,backend,specHash},assets}}));
    for(const item of pending){const old=store.db.prepare('SELECT input_hash FROM job_receipts WHERE project_id=? AND idempotency_key=?').get(p.id,item.key);fail(!old||old.input_hash===digest({kind:'render',input:item.input}),'idempotency key already used with different input',409,'idempotency_conflict');}
    const created=store.transaction(()=>pending.map(({backend,key,input})=>decorate(store,store.createJob(p.id,'render',key,input,{baseRevision:p.revision}),{backend,renderGroupId,sceneSnapshotHash,renderProfileHash},requestHash)));jobs.tick();return {jobs:created,renderGroupId};
  }
  if(route==='enhancements'){
    const a=p.assets.find(a=>a.id===b.sourceAssetId);fail(a&&a.kind==='video','enhancement source must be a video in this project',404);fail(a.hash===b.sourceHash,'enhancement source hash changed',409);
    fail(b.parameters===undefined||digest(b.parameters)===digest(NR_PARAMETERS),'enhancement parameters are fixed to verified NR settings',422);
    const media=await inspectMedia(store.getAsset(a.id).path,jobs.ffprobePath);fail(media.fps===24&&media.frames<=7200&&media.width<=3840&&media.height<=3840,'NR task requires 24 fps, at most 7200 frames and at most 3840 pixels per dimension',422);
    let clean,renderSpec;
    if(a.metadata?.jobId&&store.db.prepare('SELECT id FROM jobs WHERE id=?').get(a.metadata.jobId)){const sourceJob=store.job(a.metadata.jobId);if(sourceJob.job.projectId===p.id&&sourceJob.job.kind==='render'&&sourceJob.job.state==='complete'&&sourceJob.job.outputAssetId===a.id){clean=(sourceJob.job.partialAssets||[]).find(o=>o.role==='clean'&&o.kind==='video');if(clean){fail(p.assets.some(v=>v.id===clean.id&&v.hash===clean.hash),'clean source is missing or changed',409);renderSpec=clone(sourceJob.private.input.spec);}}}
    const runtimeHash=await jobs.code.runtimeHash();
    const spec={schemaVersion:1,runtimeHash,sourceAssetId:a.id,sourceHash:a.hash,parameters:{...NR_PARAMETERS},fps:24,totalFrames:media.frames,width:media.width,height:media.height,sourceMedia:media,...(clean?{cleanSourceAssetId:clean.id,cleanSourceHash:clean.hash,renderSpec,sequence:renderSpec.sequence}:{burnedTextWillBeEnhanced:true})};spec.specHash=digest(spec);
    const input={sourceRevision:p.revision,spec,assets:assetRefs(p,[a.id,...(clean?[clean.id,...renderSpec.assets.map(v=>v.id)]:[])])};const job=decorate(store,store.createJob(p.id,'enhancement',b.idempotencyKey,input,{baseRevision:p.revision}),{sourceAssetId:a.id,sourceHash:a.hash},requestHash);jobs.tick();return job;
  }
  fail(false,'unknown task route',404);
}
export function codeJobAction(store,jobs,id,action,body){const r=store.job(id);fail(CODE_JOB_KINDS.includes(r.job.kind),'job does not support this operation',409);const result=action==='cancel'?jobs.code.cancel(id):jobs.code.retry(id,body.idempotencyKey);jobs.tick();return result;}

export function applyGeneratedScene(store,jobs,project,jobId,body){
  fail(Number.isSafeInteger(body.baseRevision),'baseRevision is required');
  const generated=store.job(jobId);fail(generated.job.projectId===project.id&&generated.job.kind==='scene-generation'&&generated.job.state==='complete','completed scene generation not found',404);
  fail(typeof body.commandId==='string'&&body.commandId.length>0,'commandId is required');
  const program=generated.private.sceneProgram;fail(program,'completed scene program is missing',409);jobs.code.validateProgram(program);
  fail(body.scene&&body.scene.codeProgram!==undefined&&digest(body.scene.codeProgram)===digest(program),'compiled scene must contain exactly the completed SceneProgram',409);
  const scene={...clone(body.scene),id:`code-${jobId}`,revision:0,codeProgram:clone(program),codeProgramHash:digest(program),codeGenerationJobId:jobId};
  const result=store.change(project.id,body.baseRevision,current=>{
    fail(current.totalFrames===program.totalFrames&&current.aspect==='16:9','project timing changed before applying scene',409);
    fail(!current.scenes.some(s=>s.id===scene.id),'scene already applied; use its existing director',409);
    current.scenes.push(scene);
    const subjectIds=program.film==='three-knocks'?['ashuan','scout']:program.film==='borrow-sunshine'?['bear','mouse']:['fox'];
    fail(subjectIds.every(id=>scene.objects.some(o=>o.id===id)),'compiled scene is missing a registered story actor',422);
    for(const [i,shot] of program.shots.entries()){const cameraId=`${program.id}-${shot.id}`;fail(scene.cameras.some(c=>c.id===cameraId),'compiled scene is missing a shot camera',422);const id=`${jobId}-${shot.id}`;current.shots.push({id,name:`${program.title} · ${shot.id}`,sceneId:scene.id,cameraId,startFrame:shot.startFrame,endFrame:shot.endFrame,prompt:`${shot.action.kind}；按代码场景动作与机位渲染`,subjectIds,takes:[]});current.nodes.push({id:`shot-${id}`,type:'shot',x:i*290,y:1280,label:`${program.title} · ${shot.id}`,shotId:id});}
    current.nodes.push({id:`director-${jobId}`,type:'director',x:0,y:1000,label:scene.name,sceneId:scene.id});return validateProject(current);
  },{commandId:body.commandId,request:{action:'apply-generated-scene',jobId,scene:body.scene}});
  return {project:result,sceneId:scene.id};
}
