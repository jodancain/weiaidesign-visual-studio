import { timingSafeEqual, randomUUID } from 'node:crypto';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { StudioStore } from './store.mjs';
import { glbMetadata } from './glb.mjs';
import { copyDemo, submitCodeTask, codeJobAction, applyGeneratedScene } from './code-routes.mjs';
import { SCENE_MODEL } from './code-jobs.mjs';
import { projectEffectsSources, stripEffectsSources } from './effects-source.mjs';
import { StudioJobs, probeMediaAsset } from './jobs.mjs';
import { StudioProvider, boundedBytes } from './provider.mjs';
import { createProject, validateProject, protectedUpdate, applyOps, reviewProject, shotHash, shotGenerationMode, digest, clone, fail, StudioError } from './domain.mjs';

const send=(res,status,payload)=>{const bytes=Buffer.from(JSON.stringify(payload));res.writeHead(status,{'content-type':'application/json; charset=utf-8','content-length':bytes.length,'cache-control':'no-store','x-content-type-options':'nosniff'});res.end(bytes);};
async function readJson(req,max=720*1024*1024){let length=0;const chunks=[];for await(const chunk of req){length+=chunk.length;fail(length<=max,'request body is too large',413);chunks.push(chunk);}try{return chunks.length?JSON.parse(Buffer.concat(chunks).toString('utf8')):{};}catch{throw new StudioError('request body must be JSON');}}
function authorized(req,token){if(!token)return false;const actual=Buffer.from(req.headers.authorization||''),expected=Buffer.from(`Bearer ${token}`);return actual.length===expected.length&&timingSafeEqual(actual,expected);}
function serveAsset(req,res,record){
  const size=statSync(record.path).size,headers={'content-type':record.asset.mime,'accept-ranges':'bytes','cache-control':'private, max-age=31536000, immutable','etag':`"${record.asset.hash}"`,'x-content-type-options':'nosniff','content-disposition':`inline; filename*=UTF-8''${encodeURIComponent(record.asset.name)}`};
  if(req.headers['if-none-match']===headers.etag&&!req.headers.range){res.writeHead(304,headers);res.end();return;}
  let start=0,end=size-1,status=200;
  const range=req.headers.range;
  if(range&&(!req.headers['if-range']||req.headers['if-range']===headers.etag)){
    const match=/^bytes=(\d*)-(\d*)$/.exec(range);let valid=Boolean(match&&(match[1]||match[2]));
    if(valid){if(!match[1]){const suffix=Number(match[2]);valid=Number.isSafeInteger(suffix)&&suffix>0;start=Math.max(0,size-suffix);}else{start=Number(match[1]);end=match[2]?Number(match[2]):size-1;}valid=valid&&Number.isSafeInteger(start)&&Number.isSafeInteger(end)&&start>=0&&start<size&&end>=start;end=Math.min(end,size-1);}
    if(!valid){res.writeHead(416,{...headers,'content-range':`bytes */${size}`,'content-length':0});res.end();return;}
    status=206;headers['content-range']=`bytes ${start}-${end}/${size}`;
  }
  res.writeHead(status,{...headers,'content-length':end-start+1});if(req.method==='HEAD')res.end();else{const stream=createReadStream(record.path,{start,end});stream.on('error',()=>res.destroy());stream.pipe(res);}
}

function validateAIReferences(project,request){
  const scene=project.scenes.find(s=>s.id===request.sceneId);
  if(request.scope==='scene')fail(scene,'AI scene not found',404);
  const scenes=request.scope==='scene'?[scene]:project.scenes;
  fail(request.selectionIds.every(id=>typeof id==='string'&&scenes.some(s=>s.objects.some(o=>o.id===id)||s.cameras.some(c=>c.id===id))),'selected AI object or camera does not exist in the requested scene',422,'invalid_scene_selection');
  if(request.scope!=='scene')return;
  const nodes=project.nodes.filter(n=>(request.selectedNodeIds||[]).includes(n.id)),references=new Set();
  for(const node of nodes){if(node.assetId)references.add(node.assetId);const shot=project.shots.find(s=>s.id===node.shotId);if(shot?.firstAssetId)references.add(shot.firstAssetId);if(shot?.lastAssetId)references.add(shot.lastAssetId);}
  const captures=project.assets.filter(a=>references.has(a.id)&&a.kind==='image'&&(a.metadata?.provenance==='three-scene-capture'||a.metadata?.captureView!==undefined));
  if(!captures.length)return; // Ordinary reference images retain their existing behavior.
  const reject=(ok,message)=>fail(ok,message,409,'invalid_capture_context');
  reject(captures.length===1&&nodes.length===1&&request.selectedNodeIds.length===1&&nodes[0].type==='image'&&!nodes[0].shotId&&nodes[0].assetId===captures[0].id,'截图编辑必须明确绑定一张图片节点，不能混用镜头或其他参考节点');
  const m=captures[0].metadata;
  reject(m.provenance==='three-scene-capture'&&m.schemaVersion===1&&['selected-camera','observation'].includes(m.captureView),'截图元数据无效，请在导演台重新截图');
  reject(m.sceneId===scene.id&&Number.isSafeInteger(m.sceneRevision)&&m.sceneRevision===scene.revision,'截图场景已变更，请重新截图后编辑');
  reject(Number.isSafeInteger(m.frame)&&m.frame===request.frame&&m.mode===request.mode,'当前帧或静态/动态模式与截图不一致，请恢复截图上下文或重新截图');
  reject(m.aspect===project.aspect,'当前画幅与截图不一致，请重新截图');
  reject(typeof m.cameraId==='string'&&scene.cameras.some(c=>c.id===m.cameraId)&&request.cameraId===m.cameraId&&request.shotView===true,'当前机位与截图不一致，请恢复截图机位后编辑');
  reject(Array.isArray(m.objectIds)&&m.objectIds.length<=2000&&new Set(m.objectIds).size===m.objectIds.length&&m.objectIds.every(id=>typeof id==='string'&&scene.objects.some(o=>o.id===id)),'截图对象映射已失效，请重新截图');
  if(m.objectMapping!==undefined)reject(Array.isArray(m.objectMapping)&&m.objectMapping.length===m.objectIds.length&&new Set(m.objectMapping.map(v=>v?.objectId)).size===m.objectIds.length&&m.objectMapping.every(v=>v&&m.objectIds.includes(v.objectId)&&(v.assetId??null)===(scene.objects.find(o=>o.id===v.objectId)?.assetId??null)),'截图模型对象绑定已变更，请重新截图');
  const validPart=part=>part&&typeof part.objectId==='string'&&typeof part.partId==='string'&&m.objectIds.includes(part.objectId)&&scene.objects.find(o=>o.id===part.objectId)?.parts?.some(p=>p.id===part.partId);
  if(m.partIds!==undefined)reject(Array.isArray(m.partIds)&&m.partIds.length<=2000&&m.partIds.every(validPart)&&new Set(m.partIds.map(p=>`${p.objectId}/${p.partId}`)).size===m.partIds.length,'截图部件映射已失效，请重新截图');
  if(m.partMapping!==undefined)reject(Array.isArray(m.partMapping)&&Array.isArray(m.partIds)&&m.partMapping.length===m.partIds.length&&m.partMapping.every(part=>validPart(part)&&m.partIds.some(p=>p.objectId===part.objectId&&p.partId===part.partId))&&new Set(m.partMapping.map(p=>`${p.objectId}/${p.partId}`)).size===m.partMapping.length,'截图部件绑定已变更，请重新截图');
  reject(request.selectionIds.every(id=>m.objectIds.includes(id)||id===m.cameraId),'选中对象不在截图映射中，请重新截图');
  reject((request.partSelection||[]).every(part=>m.partIds?.some(p=>p.objectId===part.objectId&&p.partId===part.partId)),'选中部件不在截图映射中，请重新截图');
}

export function createStudioRouter({dataDir,token,provider,providerConfig,workerUrl='',workerToken='',fetchImpl=fetch,startJobs=true,jobsOptions={},legacyAssetOrigins=[],publicDemoProjectIds=[],codeWorkerUrl='',codeWorkerToken=''}={}){
  fail(dataDir,'STUDIO_DATA_DIR is required',500);
  const store=new StudioStore(dataDir),video=provider||new StudioProvider(providerConfig||{}, {fetchImpl});
  const jobs=new StudioJobs(store,{provider:video,workerUrl,workerToken,codeWorkerUrl,codeWorkerToken,fetchImpl,...jobsOptions});if(startJobs)jobs.start();
  const availableBinary=name=>{const r=spawnSync(name,['-version'],{timeout:5000,stdio:'ignore'});return !r.error&&r.status===0;};
  const hasFFmpeg=availableBinary(jobsOptions.ffmpegPath||'ffmpeg')&&availableBinary(jobsOptions.ffprobePath||'ffprobe');
  const publicDemos=new Set(publicDemoProjectIds);
  let codeCache={at:0,value:null};
  let workerCache={at:0,available:false};
  async function capabilities(){if(workerUrl&&Date.now()-workerCache.at>15000){try{const response=await fetchImpl(`${workerUrl.replace(/\/+$/,'')}/api/v3/capabilities`,{headers:workerToken?{authorization:`Bearer ${workerToken}`}:{},signal:AbortSignal.timeout(5000)});const data=await response.json();workerCache={at:Date.now(),available:response.ok&&Boolean((data.data||data).available&&(data.data||data).blender)};}catch{workerCache={at:Date.now(),available:false};}}if(Date.now()-codeCache.at>15000||!codeCache.value)codeCache={at:Date.now(),value:await jobs.code.capabilities()};const code=codeCache.value;return {...video.capabilities(),ffmpeg:hasFFmpeg,blender:workerCache.available,sceneGeneration:{available:Boolean(video.capabilities().llm),model:SCENE_MODEL,reason:video.capabilities().llm?'':'llm_unconfigured'},effects:{available:Boolean(hasFFmpeg&&video.capabilities().llm&&code.effects?.available),model:SCENE_MODEL,sourceKinds:['ai-original','code-animation','derived'],reason:!hasFFmpeg?'ffmpeg_unavailable':!video.capabilities().llm?'llm_unconfigured':code.effects?.reason||(!code.effects?.available?'worker_unavailable':'')},renderers:code.renderers,dlss:code.dlss,codeWorker:{configured:code.configured,available:code.available,runtimeHash:code.runtimeHash,waitingReason:code.waitingReason}};}
  function assetResolver(a){const record=store.getAsset(a);return `data:${record.asset.mime};base64,${readFileSync(record.path).toString('base64')}`;}
  function review(p){return reviewProject(p,assetResolver);}
  async function importLegacy(body,visitorId){
    const old=body.ontology?.data||body.ontology||{},p=createProject({name:body.name||old.title||'导入旧视频项目',demo:false});
    p.aspect=old.aspect_ratio==='9:16'?'9:16':'16:9';const scene=p.scenes[0],subjectMap=new Map(),cameraMap=new Map(),warnings=[];
    const oldObjects=(Array.isArray(old.objects)?old.objects:[]).slice(0,100),oldAnchors=(Array.isArray(old.anchors)?old.anchors:[]).slice(0,1000);
    const instances=(Array.isArray(old.blender?.subjects)?old.blender.subjects:Array.isArray(old.blender_instances)?old.blender_instances:[]).slice(0,1000);
    const finite=(v,fallback=0)=>Number.isFinite(Number(v))?Number(v):fallback;
    const zUpToYUp=v=>[Number(v[0]),Number(v[2]),-Number(v[1])];
    const vec3=v=>Array.isArray(v)&&v.length===3&&v.every(x=>typeof x==='number'&&Number.isFinite(x));
    // Native v1 normalizes subjects to +X forward, then places them in stage XY.
    // The original Studio proxy faces +Z; its extra 90-degree yaw preserves facing.
    for(const [i,spec] of (instances.length?instances:oldObjects).entries()){
      const o=instances.length?(oldObjects.find(o=>o.id===spec.object_id)||{}):spec;
      const kind=o.type==='actor'||(instances.length&&!spec.proxy)?'character':'box';
      const pos=Array.isArray(spec.position_m)?spec.position_m:[(i%5)*2-4,Math.floor(i/5)*2];
      let yaw=finite(spec.rotation_deg);
      const target=instances.find(s=>s.id===spec.face);
      if(target&&target!==spec&&Array.isArray(target.position_m))yaw=Math.atan2(finite(target.position_m[1])-finite(pos[1]),finite(target.position_m[0])-finite(pos[0]))*180/Math.PI;
      const angle=(yaw+(kind==='character'&&instances.length?90:0))*Math.PI/180;
      const position=instances.length?[finite(pos[0]),finite(spec.elevation_m),-finite(pos[1])]:[(i%5)*2-4,0,Math.floor(i/5)*2];
      const object={id:randomUUID(),name:String(o.name||spec.name||spec.id||`对象 ${i+1}`).slice(0,450)+(instances.length?` · ${String(spec.id||i+1).slice(0,45)}`:''),kind,transform:{position,rotation:[0,Math.sin(angle/2),0,Math.cos(angle/2)],scale:[1,1,1]},color:'#adb4c5',visible:true,locked:false};
      scene.objects.push(object);const oldId=spec.object_id||o.id;subjectMap.set(oldId,[...(subjectMap.get(oldId)||[]),object.id]);
      p.nodes.push({id:randomUUID(),type:'subject',x:i*290,y:650,label:object.name,sceneId:scene.id,objectId:object.id,text:JSON.stringify({legacyObjectId:oldId,legacyInstanceId:instances.length?spec.id:null,proxy:true},null,2)});
    }
    if(instances.length)warnings.push('已将旧 Blender 舞台 Z-up 坐标转换为 Studio Y-up，并保留独立实例与朝向；原模型、身高归一化、姿态、状态隐藏和环境资产仍为待重建记录，当前显示代理模型。');
    for(const a of oldAnchors){
      const c=a.greybox?.camera;
      if(!vec3(c?.location)||!vec3(c?.target))continue;
      if(cameraMap.size>=100){warnings.push('旧机位超过100个，剩余机位仅保留在来源记录。');break;}
      const camera={id:randomUUID(),name:String(a.label||a.id||'旧机位').slice(0,500),position:zUpToYUp(c.location),target:zUpToYUp(c.target),focalLength:finite(c.focal_mm,35),sensorWidth:36};
      if(camera.focalLength<=0||camera.focalLength>1000){warnings.push(`${camera.name}: 旧焦距无效，机位未转换`);continue;}
      if(!cameraMap.size)scene.cameras=[];scene.cameras.push(camera);cameraMap.set(a.id,camera.id);
    }
    if(cameraMap.size)scene.activeCameraId=scene.cameras[0].id;
    const oldShots=(Array.isArray(old.shots)?old.shots:[]).slice(0,1000).sort((a,b)=>(a.order||0)-(b.order||0));let frame=0;
    for(const oldShot of oldShots){const frames=Math.max(1,Math.round(Number(oldShot.duration_s||4)*24));fail(Number.isFinite(frames)&&frames<=2880,'legacy shot duration is invalid');const shot={id:randomUUID(),name:String(oldShot.title||`镜头 ${p.shots.length+1}`).slice(0,500),sceneId:scene.id,cameraId:cameraMap.get(oldShot.start_anchor)||scene.activeCameraId,startFrame:frame,endFrame:frame+frames,prompt:String(oldShot.motion_prompt||''),subjectIds:scene.objects.map(o=>o.id),overlay:String(oldShot.caption||''),takes:[]};p.shots.push(shot);p.nodes.push({id:randomUUID(),type:'shot',x:p.shots.length*290,y:300,label:shot.name,shotId:shot.id});frame+=frames;}
    if(p.shots.length)scene.activeCameraId=p.shots[0].cameraId;
    if(frame){p.totalFrames=frame;p.sequence.totalFrames=frame;}
    const provenance={legacyOntologyId:old.id||null,brief:old.brief||'',summary:old.summary||'',objects:old.objects||[],links:old.links||[],effects:old.effects||[],blender:old.blender||null,blender_instances:old.blender_instances||null,anchors:oldAnchors.map(a=>({id:a.id,kind:a.kind,object_id:a.object_id,render:a.render,camera:a.greybox?.camera,imageUrl:a.image?.public_url})),shots:oldShots.map(s=>({id:s.id,start_anchor:s.start_anchor,end_anchor:s.end_anchor,beats:s.beats,videoUrl:s.video_url,videoJobId:s.video_job_id})),videoJobs:(Array.isArray(body.videoJobs)?body.videoJobs:[]).slice(0,1000)};
    // Preserve legacy semantics visibly; imported proxy placements are authoring starting points.
    const provenanceText=JSON.stringify(provenance,null,2);for(let offset=0;offset<provenanceText.length;offset+=20000)p.nodes.push({id:randomUUID(),type:'text',x:0,y:1000+offset/20,label:`旧项目来源与本体记录（待重审）${offset?` · ${offset/20000+1}`:''}`,text:provenanceText.slice(offset,offset+20000)});
    store.createProject(p,visitorId);
    const anchors=new Map();
    const allowed=new Set(legacyAssetOrigins.map(u=>{try{return new URL(u).origin;}catch{return '';}}));
    async function copy(url,descriptor){
      if(!url)return null;
      try{const target=new URL(url);fail(['http:','https:'].includes(target.protocol)&&allowed.has(target.origin)&&!target.username&&!target.password,'legacy media origin is not configured');const response=await fetchImpl(target,{redirect:'error',signal:AbortSignal.timeout(120000)});fail(response.ok,`legacy download HTTP ${response.status}`);const bytes=await boundedBytes(response,512*1024*1024);const mime=(response.headers.get('content-type')||descriptor.mime).split(';')[0];return store.addAsset(p.id,{...descriptor,mime,source:'legacy-import'},bytes).asset;}catch(error){warnings.push(`${descriptor.name}: ${error.message}`);return null;}
    }
    for(const a of oldAnchors){const asset=await copy(a.image?.public_url,{name:String(a.label||a.id||'旧锚图').slice(0,500),kind:'image',mime:'image/png',metadata:{legacyAnchorId:a.id}});if(asset)anchors.set(a.id,asset.id);}
    const importedVideos=new Map();
    for(const [i,s] of oldShots.entries()){const asset=await copy(s.video_url,{name:`${p.shots[i].name}.mp4`,kind:'video',mime:'video/mp4',metadata:{legacyShotId:s.id,legacyJobId:s.video_job_id}});if(asset)importedVideos.set(i,asset);}
    const extraJobs=Array.isArray(body.videoJobs)?body.videoJobs:old.result_video_url||old.storage_video||old.video_url?[old]:[];
    for(const raw of extraJobs.slice(0,1000)){const j=raw.data||raw;const url=j.storage_video?.public_url||j.result_video_url||j.video_url||j.url||j.result?.video_url||j.output?.video_url;const asset=await copy(url,{name:String(j.title||j.subject||j.id||'旧视频').slice(0,490)+'.mp4',kind:'video',mime:'video/mp4',metadata:{legacyJobId:j.id}});if(!url)warnings.push(`旧任务 ${String(j.id||j.job_id||'unknown')}: 没有可复制的成品 URL`);if(asset)p.nodes.push({id:randomUUID(),type:'video',x:importedVideos.size*290,y:850,label:asset.name,assetId:asset.id});}
    return store.change(p.id,undefined,current=>{
      const extraNodes=p.nodes.filter(n=>n.type==='video'&&!current.nodes.some(c=>c.id===n.id));current.nodes.push(...extraNodes);
      for(const a of oldAnchors)if(a.kind==='identity'&&anchors.has(a.id))for(const objectId of subjectMap.get(a.object_id)||[]){const n=current.nodes.find(n=>n.type==='subject'&&n.objectId===objectId);if(n)n.assetId=anchors.get(a.id);}
      for(const [i,s] of current.shots.entries()){
        const source=oldShots[i];s.firstAssetId=anchors.get(source.start_anchor);s.lastAssetId=anchors.get(source.end_anchor);
        const a=importedVideos.get(i);if(a){const take={id:randomUUID(),assetId:a.id,jobId:String(source.video_job_id||'legacy'),model:String(source.video_model||'legacy'),referenceMode:'legacy-unverified'};s.takes.push(take);s.selectedTakeId=take.id;current.sequence.clips.push({id:randomUUID(),kind:'video',track:0,startFrame:s.startFrame,endFrame:s.endFrame,assetId:a.id,sourceIn:0,volume:1,fadeIn:0,fadeOut:0});}
      }
      if(warnings.length)current.nodes.push({id:randomUUID(),type:'text',x:400,y:550,label:'导入中未能复制的媒体',text:warnings.join('\n').slice(0,20000)});
      return current;
    },{undoable:false});
  }
  async function handle(req,res){
    const url=new URL(req.url||'/',`http://${req.headers.host||'localhost'}`);if(!url.pathname.startsWith('/api/v3/'))return false;
    try{
      const authToken=typeof token==='function'?token():token;
      fail(authToken,'video API token is not configured',503,'auth_unconfigured');fail(authorized(req,authToken),'invalid or missing bearer token',401,'unauthorized');
      const visitorId=req.headers['x-studio-visitor-id'];fail(visitorId===undefined||typeof visitorId==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(visitorId),'invalid visitor identity',400);
      const canRead=id=>store.ownsProject(id,visitorId)||publicDemos.has(id);
      const parts=url.pathname.slice('/api/v3/'.length).split('/').filter(Boolean),method=req.method;
      if(method==='OPTIONS'){res.writeHead(204,{'allow':'GET,HEAD,POST,PUT,OPTIONS'});res.end();return true;}
      let value;
      if(parts[0]==='capabilities'&&parts.length===1&&method==='GET')value=await capabilities();
      else if(parts[0]==='assets'&&parts[2]==='content'&&parts.length===3&&['GET','HEAD'].includes(method)){const asset=store.getAsset(parts[1]);fail(canRead(asset.projectId),'asset not found',404);serveAsset(req,res,asset);return true;}
      else if(parts[0]==='jobs'&&parts[1]){const record=store.job(parts[1]);store.assertOwner(record.job.projectId,visitorId);if(parts.length===2&&method==='GET')value=record.job;else if(parts.length===3&&['cancel','retry'].includes(parts[2])&&method==='POST')value=codeJobAction(store,jobs,parts[1],parts[2],await readJson(req,1000000));else throw new StudioError('route not found',404);}
      else if(parts[0]==='demos'&&parts.length===1&&method==='GET')value=store.listProjects().filter(p=>publicDemos.has(p.id)).map(p=>({...p,access:{readOnly:true,canCopy:true}}));
      else if(parts[0]==='projects'&&parts.length===1&&method==='GET')value=store.listProjects().filter(p=>canRead(p.id)).map(p=>visitorId&&!store.ownsProject(p.id,visitorId)?{...p,access:{readOnly:true,canCopy:true}}:p);
      else if(parts[0]==='projects'&&parts.length===1&&method==='POST')value=store.createProject(createProject(await readJson(req,1000000)),visitorId);
      else if(parts[0]==='projects'&&parts[1]==='import'&&parts.length===2&&method==='POST')value=await importLegacy(await readJson(req,20000000),visitorId);
      else if(parts[0]==='projects'&&parts[1]){
        const projectId=parts[1];fail(canRead(projectId),'project not found',404);const p=store.getProject(projectId),owned=store.ownsProject(projectId,visitorId),isCopy=parts[2]==='copy'&&parts.length===3&&method==='POST';
        if(!owned)fail(isCopy||method==='GET'&&(parts.length===2||parts.length===3&&['review','script'].includes(parts[2])),'public demo is read-only; copy it into your workspace first',403,'read_only_demo');
        if(isCopy){const b=await readJson(req,1000000);value=copyDemo(store,p,visitorId,b.name);}
        else if(parts.length===2&&method==='GET')value=owned?p:{...p,access:{readOnly:true,canCopy:true}};
        else if(parts.length===2&&method==='PUT'){const b=await readJson(req,20000000);fail(Number.isSafeInteger(b.baseRevision),'baseRevision is required');value=store.change(projectId,b.baseRevision,current=>protectedUpdate(current,stripEffectsSources(b.project)),{request:b});}
        else if(parts[2]==='commands'&&parts.length===3&&method==='POST'){const b=await readJson(req,2000000);fail(Number.isSafeInteger(b.baseRevision)&&b.commandId,'baseRevision and commandId are required');value=store.change(projectId,b.baseRevision,current=>applyOps(current,b.ops),{commandId:b.commandId,request:{ops:b.ops}});}
        else if(parts[2]==='history'&&parts.length===3&&method==='POST'){const b=await readJson(req,1000000);value=store.history(projectId,b.baseRevision,b.direction);}
        else if(parts[2]==='review'&&parts.length===3&&method==='GET')value=review(p);
        else if(parts[2]==='script'&&parts.length===3&&method==='GET'){const data=review(p);if(url.searchParams.get('format')==='json')value=data;else{res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'"});res.end(data.html);return true;}}
        else if(parts[2]==='assets'&&parts.length===3&&method==='POST'){
          const b=await readJson(req);fail(typeof b.base64==='string','base64 is required');const raw=b.base64.replace(/^data:[^;,]+;base64,/, '');fail(/^[A-Za-z0-9+/]*={0,2}$/.test(raw)&&raw.length%4===0,'invalid base64');const bytes=Buffer.from(raw,'base64');
          if(b.kind==='model')b.metadata={...b.metadata,...glbMetadata(bytes)};
          if(['video','audio'].includes(b.kind)&&hasFFmpeg){const prepared=store.prepareAsset(projectId,b,bytes);const media=await probeMediaAsset(prepared.path,b.kind,jobsOptions.ffprobePath||'ffprobe');b.metadata={...b.metadata,...media};}
          value=store.addAsset(projectId,b,bytes);
        }
        else if(parts[2]==='jobs'&&parts.length===3&&method==='GET')value=store.listJobs(projectId);
        else if(parts[2]==='shots'&&parts[3]&&parts.length===5&&method==='POST'){
          const s=p.shots.find(s=>s.id===parts[3]);fail(s,'shot not found',404);const b=await readJson(req,1000000),hash=shotHash(p,s);
          if(parts[4]==='approve'){fail(b.hash===hash,'shot changed since review; review again',409,'approval_conflict');value=store.change(projectId,p.revision,current=>{current.shots.find(x=>x.id===s.id).approval={hash,at:new Date().toISOString()};return current;},{undoable:false});}
          else if(parts[4]==='generate'){
            fail(s.approval?.hash===hash&&b.approvalHash===hash,'current shot must be approved before generation',409,'approval_required');
            const mode=shotGenerationMode(s),available=video.capabilities();
            fail(mode==='text-to-video'||s.firstAssetId,'capture or upload a first reference frame before generation',422);
            fail(available.video,'video provider is not configured',503);
            fail(mode!=='text-to-video'||available.generationModes?.includes(mode),'text-to-video is not supported by the configured video provider',422);
            fail(s.endFrame-s.startFrame<=288,'split shots longer than 12 seconds before generation',422);
            const frozenShot=clone(s);delete frozenShot.takes;delete frozenShot.approval;delete frozenShot.selectedTakeId;
            value=store.createJob(projectId,'generation',b.idempotencyKey,{shot:frozenShot,aspect:p.aspect,fps:24,approvalHash:hash},{baseRevision:p.revision});jobs.tick();
          }else throw new StudioError('route not found',404);
        }
        else if(parts[2]==='scene-generations'&&parts[3]&&parts[4]==='apply'&&parts.length===5&&method==='POST')value=applyGeneratedScene(store,jobs,p,parts[3],await readJson(req,20000000));
        else if(['scene-generations','renders','enhancements','effects-plans','effects-renders'].includes(parts[2])&&parts.length===3&&method==='POST')value=await submitCodeTask({store,jobs,project:p,route:parts[2],body:await readJson(req,2000000),inspectMedia:jobs.code.inspectMedia});
        else if(parts[2]==='previews'&&parts.length===3&&method==='POST'){
          const b=await readJson(req,20000000),scene=p.scenes.find(s=>s.id===b.sceneId),asset=p.assets.find(a=>a.id===b.bakedAssetId);fail(scene,'scene not found',404);fail(asset&&asset.kind==='bake','preview requires a baked GLB asset',422);fail(Number.isSafeInteger(b.frameStart)&&Number.isSafeInteger(b.frameEnd)&&b.frameStart>=0&&b.frameEnd>b.frameStart&&b.frameEnd<=p.totalFrames,'invalid preview frame range');if(b.resolution)fail(Array.isArray(b.resolution)&&b.resolution.length===2&&b.resolution.every(n=>Number.isInteger(n)&&n>=64&&n<=3840),'invalid preview resolution');fail(workerUrl,'Blender worker is not configured',503);
          value=store.createJob(projectId,'preview',b.idempotencyKey,{scene:clone(scene),bakedAssetId:asset.id,assetHash:asset.hash,frameStart:b.frameStart,frameEnd:b.frameEnd,resolution:b.resolution||(p.aspect==='9:16'?[720,1280]:[1280,720]),landmarks:b.landmarks||[]},{baseRevision:p.revision});jobs.tick();
        }
        else if(parts[2]==='exports'&&parts.length===3&&method==='POST'){const b=await readJson(req,1000000);fail(b.sequenceId===p.sequence.id,'sequence not found',404);fail(hasFFmpeg,'FFmpeg and ffprobe are required for export',503);fail(p.sequence.clips.some(c=>c.kind==='video'),'sequence has no video clips',422);value=store.createJob(projectId,'export',b.idempotencyKey,{project:clone(p)},{baseRevision:p.revision});jobs.tick();}
        else if(parts[2]==='ai'&&parts.length===3&&method==='POST'){
          const b=await readJson(req,2000000);fail(b.baseRevision===p.revision,'project changed; reload and retry',409,'revision_conflict');fail(typeof b.prompt==='string'&&b.prompt.trim()&&b.prompt.length<=20000,'prompt is required');fail(['static','dynamic'].includes(b.mode)&&['scene','storyboard'].includes(b.scope)&&Number.isSafeInteger(b.frame)&&b.frame>=0&&b.frame<p.totalFrames&&Array.isArray(b.selectionIds)&&b.selectionIds.length<=2000,'invalid AI request');
          if(b.selectedNodeIds!==undefined)fail(Array.isArray(b.selectedNodeIds)&&b.selectedNodeIds.length<=2000&&b.selectedNodeIds.every(id=>p.nodes.some(n=>n.id===id)),'invalid canvas reference selection');
          if(b.partSelection!==undefined)fail(Array.isArray(b.partSelection)&&b.partSelection.length<=2000&&b.partSelection.every(part=>part&&p.scenes.some(scene=>scene.id===b.sceneId&&scene.objects.some(object=>object.id===part.objectId&&object.parts?.some(p=>p.id===part.partId)))),'invalid model part selection');
          validateAIReferences(p,b);
          const result=await video.edit(b,p,async assetId=>{const a=store.getAsset(assetId);fail(a.projectId===projectId,'cross-project asset access');return {bytes:readFileSync(a.path),mime:a.asset.mime};});fail(result&&typeof result.message==='string'&&Array.isArray(result.ops)&&result.ops.length<=200,'invalid AI patch',422,'invalid_ai_patch');
          const project=store.change(projectId,b.baseRevision,current=>{
            let next=result.ops.length?applyOps(current,result.ops,{...b,ai:true}):clone(current);
            if(result.storyboard){fail(b.scope==='storyboard','AI storyboard patch is outside scope',422);fail(b.mode==='static'&&!b.partSelection?.length,'动态编辑或部件选择不能修改基础分镜；请使用静态分镜模式',422,'invalid_dynamic_patch');fail(Object.keys(result.storyboard).every(k=>['shots','nodes','edges'].includes(k)),'unsupported storyboard field',422);
              if(result.storyboard.shots){fail(Array.isArray(result.storyboard.shots),'invalid storyboard shots');next.shots=result.storyboard.shots.map(s=>{const existing=current.shots.find(x=>x.id===s.id);return {...s,takes:existing?.takes||[],...(existing?.approval?{approval:existing.approval}:{}),...(existing?.selectedTakeId?{selectedTakeId:existing.selectedTakeId}:{})};});}
              for(const field of ['nodes','edges'])if(result.storyboard[field])next[field]=result.storyboard[field];
              for(const shot of next.shots){const existing=current.shots.find(s=>s.id===shot.id);delete shot.approval;if(existing?.approval)shot.approval=existing.approval;}
              next=protectedUpdate(current,next);
            }
            fail(result.ops.length||result.storyboard,'AI proposed no typed edits',422);return validateProject(next);
          },{commandId:randomUUID(),request:{ai:b,result}});
          value={project,message:result.message.slice(0,4000),ops:result.ops};
        }else throw new StudioError('route not found',404);
      }else throw new StudioError('route not found',404);
      // Computed provenance is response-only, never client-controlled stored data.
      if(value?.schemaVersion===3&&Array.isArray(value.assets))value=projectEffectsSources(store,value);
      else if(value?.project?.schemaVersion===3&&Array.isArray(value.project.assets)){
        value={...value,project:projectEffectsSources(store,value.project)};
        if(value.asset)value.asset=value.project.assets.find(a=>a.id===value.asset.id)||value.asset;
      }
      send(res,200,{data:value});
    }catch(error){if(!res.headersSent)send(res,error instanceof StudioError?error.status:500,{detail:error instanceof StudioError?error.message:'Studio request failed',code:error instanceof StudioError?error.code:'internal_error'});else res.destroy();}
    return true;
  }
  return {handle,store,jobs,capabilities,close:async()=>{await jobs.close();store.close();}};
}
