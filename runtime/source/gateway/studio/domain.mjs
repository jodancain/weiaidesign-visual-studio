import { createHash, randomUUID } from 'node:crypto';
import { validateSceneProgram, codeSceneRegistry } from './code-schema.mjs';

export class StudioError extends Error {
  constructor(message, status = 400, code = 'invalid_request') { super(message); this.status = status; this.code = code; }
}
export const fail = (condition, message, status = 400, code) => { if (!condition) throw new StudioError(message, status, code); };
export const clone = value => structuredClone(value);
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonical(value)).digest('hex');
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const vec = (value, n) => Array.isArray(value) && value.length === n && value.every(finite);
const str = (value, max = 20000) => typeof value === 'string' && value.length <= max;
const integer = (value, min = 0, max = 86400 * 24) => Number.isSafeInteger(value) && value >= min && value <= max;
const list = (value, max = 10000) => Array.isArray(value) && value.length <= max;
const enumOf = (v, options) => options.includes(v);
export function shotGenerationMode(shot) {
  const mode=shot.generationMode===undefined?'image-to-video':shot.generationMode;
  fail(enumOf(mode,['image-to-video','text-to-video']),'invalid shot generation mode',422);
  fail(mode!=='text-to-video'||shot.firstAssetId===undefined&&shot.lastAssetId===undefined,'text-to-video cannot include first or last reference images',422);
  return mode;
}
function unique(items, label) { const seen = new Set(); for (const item of items) { fail(id(item.id) && !seen.has(item.id), `${label}: invalid or duplicate id`); seen.add(item.id); } return seen; }
function keys(value, allowed, label) { fail(value && typeof value === 'object' && !Array.isArray(value), `${label}: expected object`); fail(Object.keys(value).every(k => allowed.includes(k)), `${label}: unsupported field`); }
const objectKeys = ['id','name','kind','transform','color','visible','locked','assetId','parentId','rig','bonePoses','morphs','parts'];
const cameraKeys = ['id','name','position','target','focalLength','sensorWidth'];
const sceneKeys = ['id','name','revision','units','up','objects','cameras','activeCameraId','background','groundColor','showGround','exposure','tracks','clips','lights','codeProgram','codeProgramHash','codeGenerationJobId'];
function interval(item, total, label) { fail(integer(item.startFrame) && integer(item.endFrame, 1) && item.startFrame < item.endFrame && item.endFrame <= total, `${label}: invalid frame interval`); }
function transform(t){keys(t,['position','rotation','scale'],'transform');fail(vec(t.position,3)&&vec(t.rotation,4)&&Math.abs(Math.hypot(...t.rotation)-1)<0.01&&vec(t.scale,3)&&t.scale.every(n=>n>0&&n<10000),'invalid transform');}

export function validateProject(p) {
  keys(p, ['schemaVersion','id','name','revision','createdAt','updatedAt','fps','aspect','totalFrames','nodes','edges','assets','scenes','shots','sequence','viewport'], 'project');
  if(p.viewport!==undefined){keys(p.viewport,['x','y','zoom'],'viewport');fail(finite(p.viewport.x)&&finite(p.viewport.y)&&finite(p.viewport.zoom)&&p.viewport.zoom>=0.15&&p.viewport.zoom<=2,'invalid viewport');}
  fail(p.schemaVersion === 3 && id(p.id) && str(p.name, 500) && integer(p.revision) && str(p.createdAt) && str(p.updatedAt), 'invalid project identity');
  fail(p.fps === 24 && enumOf(p.aspect, ['16:9','9:16']) && integer(p.totalFrames, 1), 'invalid project timing');
  for (const field of ['nodes','edges','assets','scenes','shots']) fail(list(p[field]), `invalid ${field}`);
  const assets = unique(p.assets, 'assets'), scenes = unique(p.scenes, 'scenes'), shots = unique(p.shots, 'shots'), nodes = unique(p.nodes, 'nodes');
  for (const a of p.assets) fail(enumOf(a.kind,['image','video','audio','model','bake']) && str(a.name,500) && str(a.mime,200) && /^[a-f0-9]{64}$/.test(a.hash) && integer(a.bytes,0,2**40) && a.url === `/api/v3/assets/${a.id}/content`, 'invalid asset revision');
  for (const s of p.scenes) {
    keys(s, sceneKeys, 'scene');
    if(s.codeProgram!==undefined){validateSceneProgram(s.codeProgram);fail(s.codeProgramHash===digest(s.codeProgram)&&id(s.codeGenerationJobId),'invalid scene program provenance',422);}
    fail(str(s.name,500) && integer(s.revision) && s.units === 'meters' && s.up === 'Y' && finite(s.exposure) && s.exposure >= 0 && s.exposure <= 100 && typeof s.showGround === 'boolean', 'invalid scene');
    fail(str(s.background,100) && str(s.groundColor,100) && list(s.objects,2000) && list(s.cameras,100) && list(s.tracks) && list(s.clips), 'invalid scene collections');
    if(s.codeProgram)fail(s.clips.length===0,'code scenes use procedural action recipes; motion clips are not supported',422);
    const objects = unique(s.objects,'objects'), cameras = unique(s.cameras,'cameras');
    if(s.lights){fail(list(s.lights,100),'invalid lights');unique(s.lights,'lights');for(const l of s.lights){keys(l,['id','name','type','position','intensity','color'],'light');fail(str(l.name,500)&&enumOf(l.type,['ambient','directional','point'])&&vec(l.position,3)&&finite(l.intensity)&&l.intensity>=0&&l.intensity<=100000&&str(l.color,100),'invalid light');}}
    fail(cameras.has(s.activeCameraId), 'active camera does not exist');
    for (const o of s.objects) {
      keys(o,objectKeys,'object');
      const registered=s.codeProgram?codeSceneRegistry[s.codeProgram.film]?.objects?.[o.id]:null;
      if(s.codeProgram)fail(registered&&o.kind===registered.kind&&!o.assetId,'code scene objects must use the registered template identities',422);
      fail(str(o.name,500) && enumOf(o.kind,['box','sphere','cylinder','plane','character','model']) && str(o.color,100) && typeof o.visible === 'boolean' && typeof o.locked === 'boolean', 'invalid object');
      keys(o.transform,['position','rotation','scale'],'transform');
      fail(vec(o.transform.position,3) && vec(o.transform.rotation,4) && Math.abs(Math.hypot(...o.transform.rotation)-1)<0.01 && vec(o.transform.scale,3) && o.transform.scale.every(n=>n>0 && n<10000), 'invalid transform');
      fail(!o.assetId || assets.has(o.assetId), 'object asset does not exist');
      if(o.parts!==undefined){
        const asset=p.assets.find(a=>a.id===o.assetId);fail((registered||o.kind==='model'&&asset?.kind==='model')&&list(o.parts,10000),'parts require a model asset or registered code object');unique(o.parts,'parts');
        for(const part of o.parts){keys(part,['id','transform','color','visible','locked'],'part');fail(registered?registered.partIds.includes(part.id):asset.metadata?.partNodes?.some(n=>n.id===part.id),registered?'part does not exist in its registered model':'part does not exist in uploaded GLB');transform(part.transform);fail((part.color===undefined||str(part.color,100))&&typeof part.visible==='boolean'&&typeof part.locked==='boolean','invalid part state');}
      }
      fail(!o.parentId || (objects.has(o.parentId) && o.parentId !== o.id), 'invalid object parent');
      const ancestors = new Set([o.id]); let current = o;
      while (current.parentId) { fail(!ancestors.has(current.parentId),'cyclic object parents'); ancestors.add(current.parentId); current=s.objects.find(x=>x.id===current.parentId); }
      if (o.rig) {
        keys(o.rig,['id','bones','chains','limits'],'rig');
        if(registered)fail(o.rig.bones&&Object.values(o.rig.bones).every(name=>registered.bones.includes(name))&&Array.isArray(o.rig.chains)&&o.rig.chains.every(c=>registered.bones.includes(c.effector)&&Array.isArray(c.links)&&c.links.every(name=>registered.bones.includes(name))),'code rig targets must belong to the registered actor',422);
        fail(id(o.rig.id) && o.rig.bones && Object.values(o.rig.bones).every(v=>str(v,200)) && list(o.rig.chains,100),'invalid rig');
        for (const c of o.rig.chains) fail(id(c.id) && vec(c.target,3) && str(c.effector,200) && list(c.links,100) && c.links.every(v=>str(v,200)) && typeof c.enabled==='boolean','invalid IK chain');
        if(o.rig.limits!==undefined){
          const bones=Object.values(o.rig.bones);keys(o.rig.limits,bones,'rig limits');
          for(const limit of Object.values(o.rig.limits)){keys(limit,['min','max'],'bone limit');fail(vec(limit.min,3)&&vec(limit.max,3)&&limit.min.every((min,axis)=>min<=limit.max[axis]),'invalid bone limit range');}
        }
      }
      if (o.bonePoses) fail(Object.values(o.bonePoses).every(q=>vec(q,4)&&Math.abs(Math.hypot(...q)-1)<0.01),'invalid bone poses');
      if (o.morphs) fail(Object.values(o.morphs).every(finite),'invalid morph weights');
    }
    for (const c of s.cameras) { keys(c,cameraKeys,'camera'); fail(str(c.name,500)&&vec(c.position,3)&&vec(c.target,3)&&finite(c.focalLength)&&c.focalLength>0&&c.focalLength<=1000&&finite(c.sensorWidth)&&c.sensorWidth>0,'invalid camera'); }
    unique(s.tracks,'tracks');
    for (const t of s.tracks) {
      keys(t,['id','targetId','bone','partId','property','keys','muted','locked'],'track');
      if(s.codeProgram)fail(!['weight','morph'].includes(t.property),'code scenes do not support clip weight or morph tracks',422);
      if(t.partId!==undefined)fail(t.bone===undefined&&enumOf(t.property,['position','rotation','scale','visible'])&&s.objects.find(o=>o.id===t.targetId)?.parts?.some(part=>part.id===t.partId),'invalid part track');
      fail((objects.has(t.targetId)||cameras.has(t.targetId)||(t.property==='weight'&&s.clips.some(c=>c.id===t.targetId))) && enumOf(t.property,['position','rotation','scale','ikTarget','weight','visible','focalLength','morph']) && list(t.keys), 'invalid track');
      let previous=-1;
      for (const k of t.keys) { fail(integer(k.frame)&&k.frame<=p.totalFrames&&k.frame>previous&&enumOf(k.interpolation,['linear','hold','smooth'])&&(finite(k.value)||(Array.isArray(k.value)&&k.value.length<=4&&k.value.every(finite))), 'invalid keyframe');if(['position','scale','ikTarget'].includes(t.property))fail(vec(k.value,3),'vector track requires 3 values');if(t.property==='rotation')fail(vec(k.value,4)&&Math.abs(Math.hypot(...k.value)-1)<0.01,'rotation track requires normalized quaternion');if(['weight','visible','focalLength','morph'].includes(t.property))fail(finite(k.value),'scalar track requires a number'); if(k.ease) fail(vec(k.ease,4),'invalid easing'); previous=k.frame; }
    }
    unique(s.clips,'motion clips');
    for (const c of s.clips) { keys(c,['id','targetId','clipName','startFrame','endFrame','sourceIn','speed','weight','fadeIn','fadeOut','mask','additive'],'motion clip'); interval(c,p.totalFrames,'motion clip'); fail(objects.has(c.targetId)&&str(c.clipName,200)&&integer(c.sourceIn)&&finite(c.speed)&&c.speed>0&&finite(c.weight)&&c.weight>=0&&c.weight<=1&&integer(c.fadeIn)&&integer(c.fadeOut)&&enumOf(c.mask,['all','upper','lower']), 'invalid motion clip'); const actor=s.objects.find(o=>o.id===c.targetId); const names=actor.kind==='character'?['Idle','Walk','Punch','Kick','Wave']:(Array.isArray(p.assets.find(a=>a.id===actor.assetId)?.metadata?.clips)?p.assets.find(a=>a.id===actor.assetId).metadata.clips.map(c=>c.name):null);if(names)fail(names.includes(c.clipName),'motion clip does not exist on this character'); }
  }
  for (const s of p.shots) {
    keys(s,['id','name','sceneId','cameraId','startFrame','endFrame','prompt','generationMode','firstAssetId','lastAssetId','subjectIds','dialogue','overlay','approval','takes','selectedTakeId'],'shot');
    shotGenerationMode(s);
    const scene=p.scenes.find(x=>x.id===s.sceneId);
    interval(s,p.totalFrames,'shot');
    fail(str(s.name,500)&&str(s.prompt)&&scene&&scene.cameras.some(c=>c.id===s.cameraId)&&list(s.subjectIds,100)&&s.subjectIds.every(v=>scene.objects.some(o=>o.id===v)), 'invalid shot references');
    for(const k of ['firstAssetId','lastAssetId']) fail(!s[k]||p.assets.some(a=>a.id===s[k]&&a.kind==='image'),'shot reference must be an image');
    fail(!s.dialogue||str(s.dialogue), 'invalid dialogue'); fail(!s.overlay||str(s.overlay),'invalid overlay');
    fail(list(s.takes),'invalid takes'); unique(s.takes,'takes');
    for(const take of s.takes) fail(assets.has(take.assetId)&&str(take.jobId)&&str(take.model)&&str(take.referenceMode),'invalid take');
    fail(!s.selectedTakeId||s.takes.some(t=>t.id===s.selectedTakeId),'selected take does not exist');
    if(s.approval) fail(/^[a-f0-9]{64}$/.test(s.approval.hash)&&str(s.approval.at),'invalid approval');
  }
  for(const n of p.nodes) { keys(n,['id','type','x','y','label','text','assetId','shotId','sceneId','modelAssetId','objectId','groupId','width'],'node'); fail(enumOf(n.type,['text','image','video','audio','subject','shot','director','sequence'])&&finite(n.x)&&finite(n.y)&&str(n.label,500)&&(!n.text||str(n.text))&&(!n.assetId||assets.has(n.assetId))&&(!n.shotId||shots.has(n.shotId))&&(!n.sceneId||scenes.has(n.sceneId)),'invalid canvas node'); }
  for(const n of p.nodes){if(n.modelAssetId)fail(n.type==='subject'&&p.assets.some(a=>a.id===n.modelAssetId&&a.kind==='model'),'subject model asset does not exist');if(n.objectId)fail(n.type==='subject'&&p.scenes.some(s=>s.id===n.sceneId&&s.objects.some(o=>o.id===n.objectId)),'subject object does not belong to the selected scene');if(n.type==='subject'&&n.assetId)fail(p.assets.some(a=>a.id===n.assetId&&a.kind==='image'),'subject identity must be an image');}
  unique(p.edges,'edges'); for(const e of p.edges) { keys(e,['id','source','target'],'edge'); fail(nodes.has(e.source)&&nodes.has(e.target)&&e.source!==e.target,'invalid edge'); }
  keys(p.sequence,['id','name','fps','totalFrames','clips'],'sequence');
  fail(id(p.sequence.id)&&str(p.sequence.name,500)&&p.sequence.fps===24&&p.sequence.totalFrames===p.totalFrames&&list(p.sequence.clips),'invalid sequence');
  unique(p.sequence.clips,'sequence clips');
  for(const c of p.sequence.clips) { keys(c,['id','kind','track','startFrame','endFrame','assetId','sourceIn','text','volume','fadeIn','fadeOut','x','y','fontSize','color'],'sequence clip'); interval(c,p.totalFrames,'sequence clip'); fail(enumOf(c.kind,['video','audio','text'])&&integer(c.track,0,100)&&integer(c.sourceIn)&&finite(c.volume)&&c.volume>=0&&c.volume<=10&&integer(c.fadeIn)&&integer(c.fadeOut),'invalid sequence clip'); if(c.kind==='text') fail(str(c.text)&&c.text.length>0,'text clip requires text'); else fail(p.assets.some(a=>a.id===c.assetId&&(a.kind===c.kind||(c.kind==='audio'&&a.kind==='video'))),'invalid sequence asset'); for(const field of ['x','y','fontSize']) fail(c[field]===undefined||finite(c[field]),`invalid ${field}`); }
  return p;
}

export function shotHash(p, shot) {
  const {approval,takes,selectedTakeId,...content}=shot;
  const scene=p.scenes.find(s=>s.id===shot.sceneId);
  const {revision,...sceneContent}=scene || {};
  const subjects=p.nodes.filter(n=>n.type==='subject'&&n.sceneId===shot.sceneId&&shot.subjectIds.includes(n.objectId)).map(n=>({objectId:n.objectId,assetId:n.assetId,modelAssetId:n.modelAssetId})).sort((a,b)=>canonical(a).localeCompare(canonical(b)));
  const referenced = new Set([shot.firstAssetId,shot.lastAssetId,...(scene?.objects.map(o=>o.assetId)||[]),...subjects.flatMap(n=>[n.assetId,n.modelAssetId])]);
  return digest({version:1,fps:p.fps,aspect:p.aspect,shot:content,scene:sceneContent,subjects,assets:p.assets.filter(a=>referenced.has(a.id)).map(a=>({id:a.id,hash:a.hash}))});
}
export function invalidateApprovals(p) { for(const s of p.shots) if(s.approval?.hash!==shotHash(p,s)) delete s.approval; return p; }
export function protectedUpdate(current, candidate) {
  fail(candidate.id===current.id && candidate.createdAt===current.createdAt,'project identity is immutable');
  fail(canonical(candidate.assets)===canonical(current.assets),'assets are immutable; use the upload endpoint',409);
  for(const scene of candidate.scenes){const old=current.scenes.find(s=>s.id===scene.id);for(const key of ['codeProgram','codeProgramHash','codeGenerationJobId'])fail(canonical(scene[key])===canonical(old?.[key]),'scene program provenance is server owned; use the apply endpoint',409);}
  for(const s of candidate.shots) {
    const old=current.shots.find(x=>x.id===s.id);
    fail(canonical(s.takes)===canonical(old?.takes||[])&&canonical(s.approval)===canonical(old?.approval), 'approval and takes are server owned',409);
  }
  return invalidateApprovals(validateProject(clone(candidate)));
}
export function applyOps(current, ops, context = {}) {
  fail(list(ops,200) && ops.length>0,'ops must contain 1–200 operations'); const p=clone(current);
  const modified=new Set();
  for(const op of ops) {
    const s=p.scenes.find(s=>s.id===op.sceneId); fail(s,'scene not found',404);
    if(context.ai&&context.mode==='dynamic'){
      fail(op.type==='track.set','动态编辑只能通过 track.set 修改当前帧关键帧；基础场景修改请使用静态模式',422,'invalid_dynamic_patch');
      fail(integer(context.frame)&&context.frame<p.totalFrames,'动态编辑需要有效的当前帧',422);
      const old=s.tracks.find(t=>t.id===op.track?.id),track=op.track;
      fail(track&&list(track.keys)&&track.keys.some(k=>k.frame===context.frame),'动态编辑必须包含当前帧关键帧',422,'invalid_dynamic_patch');
      if(old){fail(canonical({...old,keys:undefined})===canonical({...track,keys:undefined}),'动态编辑不能改变已有轨道的对象、属性或设置',422,'invalid_dynamic_patch');fail(canonical(old.keys.filter(k=>k.frame!==context.frame))===canonical(track.keys.filter(k=>k.frame!==context.frame)),'动态编辑不能改动其他帧关键帧',422,'invalid_dynamic_patch');}
      else fail(track.keys.length===1&&track.keys[0].frame===context.frame,'新动态轨道只能包含当前帧的关键帧',422,'invalid_dynamic_patch');
    }
    fail(!context.sceneId||context.sceneId===s.id,'operation outside requested scene');
    const rawTarget=op.objectId||op.cameraId||op.track?.targetId||op.clip?.targetId;
    const target=op.track?.property==='weight'?(s.clips.find(c=>c.id===rawTarget)?.targetId||rawTarget):rawTarget;
    if(context.ai&&context.partSelection?.length){const partId=op.type==='part.update'?op.partId:op.type==='track.set'?op.track?.partId:undefined;fail(partId&&context.partSelection.some(part=>part.objectId===target&&part.partId===partId),'operation outside selected model parts',422,'part_selection_violation');}
    if(context.selectionIds?.length && target) fail(context.selectionIds.includes(target),'operation outside selection');
    const o=s.objects.find(o=>o.id===op.objectId);
    if(o?.locked) fail(op.type==='object.update'&&Object.keys(op.patch||{}).every(k=>k==='locked')&&!context.ai,'object is locked',409);
    switch(op.type) {
      case 'object.add': s.objects.push(clone(op.object)); break;
      case 'object.remove': fail(o,'object not found',404); s.objects=s.objects.filter(x=>x.id!==o.id); s.objects.forEach(x=>{if(x.parentId===o.id)delete x.parentId;}); s.tracks=s.tracks.filter(t=>t.targetId!==o.id); s.clips=s.clips.filter(c=>c.targetId!==o.id);s.tracks=s.tracks.filter(t=>t.property!=='weight'||s.clips.some(c=>c.id===t.targetId)||s.objects.some(o=>o.id===t.targetId)); p.shots.filter(x=>x.sceneId===s.id).forEach(x=>x.subjectIds=x.subjectIds.filter(v=>v!==o.id));p.nodes.forEach(n=>{if(n.sceneId===s.id&&n.objectId===o.id)delete n.objectId;}); break;
      case 'object.update': fail(o,'object not found',404); keys(op.patch,objectKeys.filter(k=>k!=='id'),'object patch');if(context.ai)fail(!Object.hasOwn(op.patch,'parts'),'AI parts must be edited with part.update',422); Object.assign(o,clone(op.patch)); break;
      case 'part.update': {const part=o?.parts?.find(part=>part.id===op.partId);fail(part,'model part not found',404);keys(op.patch,['transform','color','visible','locked'],'part patch');if(part.locked)fail(!context.ai&&Object.keys(op.patch).every(k=>k==='locked'),'model part is locked',409);Object.assign(part,clone(op.patch));break;}
      case 'camera.update': { const c=s.cameras.find(c=>c.id===op.cameraId); fail(c,'camera not found',404); keys(op.patch,cameraKeys.filter(k=>k!=='id'),'camera patch'); Object.assign(c,clone(op.patch)); break; }
      case 'scene.update': keys(op.patch,['name','activeCameraId','background','groundColor','showGround','exposure','lights','cameras'],'scene patch'); fail(!context.selectionIds?.length,'scene patch cannot bypass selection'); Object.assign(s,clone(op.patch)); break;
      case 'track.set': { const i=s.tracks.findIndex(t=>t.id===op.track.id); fail(i<0||!s.tracks[i].locked,'track is locked',409); const object=s.objects.find(o=>o.id===target);fail(!object?.locked,'track target is locked',409);fail(!op.track.partId||!object?.parts?.find(part=>part.id===op.track.partId)?.locked,'model part is locked',409); if(i<0)s.tracks.push(clone(op.track));else s.tracks[i]=clone(op.track); break; }
      case 'track.remove': { const t=s.tracks.find(t=>t.id===op.trackId); fail(t&&!t.locked,'track missing or locked',409); const target=t.property==='weight'?(s.clips.find(c=>c.id===t.targetId)?.targetId||t.targetId):t.targetId;if(context.selectionIds?.length)fail(context.selectionIds.includes(target),'operation outside selection');fail(!s.objects.find(o=>o.id===target)?.locked,'track target is locked',409); s.tracks=s.tracks.filter(t=>t.id!==op.trackId); break; }
      case 'clip.set': { fail(!s.objects.find(o=>o.id===op.clip.targetId)?.locked,'clip target is locked',409); const i=s.clips.findIndex(c=>c.id===op.clip.id); if(i<0)s.clips.push(clone(op.clip));else s.clips[i]=clone(op.clip); break; }
      case 'clip.remove': { const c=s.clips.find(c=>c.id===op.clipId); fail(c,'clip not found',404); if(context.selectionIds?.length)fail(context.selectionIds.includes(c.targetId),'operation outside selection'); fail(!s.objects.find(o=>o.id===c.targetId)?.locked,'clip target is locked',409); s.clips=s.clips.filter(c=>c.id!==op.clipId);s.tracks=s.tracks.filter(t=>!(t.property==='weight'&&t.targetId===op.clipId)); break; }
      default: throw new StudioError('unsupported scene operation');
    }
    if(context.ai && context.mode==='static') fail(!['track.set','track.remove','clip.set','clip.remove'].includes(op.type),'static edit cannot change animation');
    if(context.ai&&context.selectionIds?.length) fail(op.type!=='object.add','selected-object edit cannot add unrelated objects');
    modified.add(s.id);
  }
  for(const s of p.scenes) if(modified.has(s.id)) s.revision++;
  return invalidateApprovals(validateProject(p));
}

export function createProject({name='未命名视频项目',demo=true}={}) {
  const now=new Date().toISOString(), projectId=randomUUID(), sceneId=randomUUID(), cameraId=randomUUID();
  const character=(name,x,color)=>({id:randomUUID(),name,kind:'character',transform:{position:[x,0,0],rotation:[0,0,0,1],scale:[1,1,1]},color,visible:true,locked:false,rig:builtinRig()});
  const objects=demo?[character('洛夜',-1.4,'#9aa9c2'),character('凌萧燃',0,'#cfb79b'),character('沈月',1.4,'#a3bdb8')]:[];
  const p={schemaVersion:3,id:projectId,name:String(name).slice(0,500),revision:0,createdAt:now,updatedAt:now,fps:24,aspect:'16:9',totalFrames:240,nodes:[],edges:[],assets:[],scenes:[{id:sceneId,name:'屋顶夜景',revision:0,units:'meters',up:'Y',objects,cameras:[{id:cameraId,name:'主相机',position:[0,2,6],target:[0,1,0],focalLength:50,sensorWidth:36}],activeCameraId:cameraId,background:'#111827',groundColor:'#44495b',showGround:true,exposure:1,tracks:[],clips:[]}],shots:[],sequence:{id:randomUUID(),name:'主序列',fps:24,totalFrames:240,clips:[]}};
  // Fractional seconds snap once to the nearest 24 fps frame: 0,58,116,162,223,240.
  if(demo) { const ranges=[0,58,116,162,223,240]; for(let i=0;i<5;i++){const shot={id:randomUUID(),name:`镜头 ${i+1}`,sceneId,cameraId,startFrame:ranges[i],endFrame:ranges[i+1],prompt:'现代屋顶夜幕，三位角色的电影感对话。请先编辑分镜与对白并捕获参考帧。',subjectIds:objects.map(o=>o.id),takes:[]};p.shots.push(shot);p.nodes.push({id:randomUUID(),type:'shot',x:i*290,y:280,label:shot.name,shotId:shot.id});} }
  p.nodes.push({id:randomUUID(),type:'director',x:0,y:0,label:'3D 导演台',sceneId},{id:randomUUID(),type:'sequence',x:580,y:0,label:'10 秒主序列'});
  return validateProject(p);
}

// Wire-equivalent to web/lib/studio/animation.ts builtinRig; no Three dependency in the service.
export function builtinRig(){
  const limits={Spine:{min:[-.7,-.7,-.5],max:[.7,.7,.5]},Chest:{min:[-.6,-.8,-.5],max:[.6,.8,.5]},Neck:{min:[-.7,-.9,-.5],max:[.7,.9,.5]},Head:{min:[-.8,-1.4,-.7],max:[.8,1.4,.7]}};
  for(const side of ['Left','Right']){limits[`${side}UpperArm`]={min:[-2.8,-1.55,-2.8],max:[2.8,1.55,2.8]};limits[`${side}ForeArm`]={min:[-1.5,-1.55,-2.7],max:[1.5,1.55,2.7]};limits[`${side}Hand`]={min:[-1.1,-.8,-.8],max:[1.1,.8,.8]};limits[`${side}UpLeg`]={min:[-1.7,-.8,-.9],max:[1.2,.8,.9]};limits[`${side}Leg`]={min:[-.05,-.1,-.1],max:[2.7,.1,.1]};limits[`${side}Foot`]={min:[-.8,-.5,-.5],max:[.8,.5,.5]};}
  return {id:'studio-human-v1',limits,bones:Object.fromEntries(['Hips','Spine','Chest','Neck','Head','LeftUpperArm','LeftForeArm','LeftHand','RightUpperArm','RightForeArm','RightHand','LeftUpLeg','LeftLeg','LeftFoot','RightUpLeg','RightLeg','RightFoot'].map(n=>[n,n])),chains:[
  {id:'left-hand',target:[.68,1.38,0],effector:'LeftHand',links:['LeftForeArm','LeftUpperArm'],enabled:false},
  {id:'right-hand',target:[-.68,1.38,0],effector:'RightHand',links:['RightForeArm','RightUpperArm'],enabled:false},
  {id:'left-foot',target:[.12,.1,.1],effector:'LeftFoot',links:['LeftLeg','LeftUpLeg'],enabled:false},
  {id:'right-foot',target:[-.12,.1,.1],effector:'RightFoot',links:['RightLeg','RightUpLeg'],enabled:false},
]};}

const htmlEscape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function reviewProject(p,resolveImage) {
  const shots=p.shots.map(s=>({shotId:s.id,hash:shotHash(p,s)}));
  const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${htmlEscape(p.name)}</title><style>body{font:16px system-ui;max-width:960px;margin:40px auto;padding:24px;background:#12151b;color:#edf0f4}article{border:1px solid #454b57;padding:20px;margin:20px 0;border-radius:12px}pre,p{white-space:pre-wrap;overflow-wrap:anywhere}code{font-size:11px;color:#b9c5dc}img{max-width:45%;max-height:240px}small{color:#aab4c5}</style><h1>${htmlEscape(p.name)}</h1><p>版本 ${p.revision} · 24 fps · ${p.totalFrames} 帧 · ${htmlEscape(p.aspect)}</p>${p.shots.map((s,i)=>`<article data-shot-id="${s.id}" data-approval-hash="${shots[i].hash}"><h2>${htmlEscape(s.name)}</h2><small>${s.startFrame}–${s.endFrame} 帧（${(s.startFrame/24).toFixed(3)}–${(s.endFrame/24).toFixed(3)} 秒）</small><pre>${htmlEscape(s.prompt)}</pre><p>对白：${htmlEscape(s.dialogue||'未设置')}</p><p>文字面板：${htmlEscape(s.overlay||'未设置')}</p><p>生成方式：${shotGenerationMode(s)==='text-to-video'?'文生视频（仅文字，不发送人物或场景参考图）':'图生视频（参考条件以生成回执为准）'}</p><p>参考图：${shotGenerationMode(s)==='text-to-video'?'无；由视频模型根据文字创建画面':htmlEscape([s.firstAssetId,s.lastAssetId].filter(Boolean).join(' / ')||'未设置')}</p><p>审核：${s.approval?.hash===shots[i].hash?'已确认':'待确认'}</p><code>SHA-256 ${shots[i].hash}</code></article>`).join('')}<p>审核锁定分镜、场景、动画与参考资产内容。画布位置调整不改变审核；内容改变必须重新确认。</p></html>`;
  if(resolveImage){let enriched=html;for(const s of p.shots){const refs=[{id:s.firstAssetId,label:'首参考帧'},{id:s.lastAssetId,label:'尾参考帧'}].filter(r=>r.id);const scene=p.scenes.find(x=>x.id===s.sceneId);for(const node of p.nodes.filter(n=>n.type==='subject'&&n.sceneId===s.sceneId&&s.subjectIds.includes(n.objectId)&&n.assetId)){refs.push({id:node.assetId,label:`${shotGenerationMode(s)==='text-to-video'?'本体规划资料（不发送给视频模型）':'人物身份图'}：${scene.objects.find(o=>o.id===node.objectId)?.name||node.label}`});}if(refs.length){const images=refs.map(r=>`<figure style="display:inline-block;margin:8px;max-width:45%"><img style="max-width:100%" alt="${htmlEscape(r.label)}" src="${resolveImage(r.id)}"><figcaption>${htmlEscape(r.label)}</figcaption></figure>`).join('');const marker=`<article data-shot-id="${s.id}" data-approval-hash="${shotHash(p,s)}">`;enriched=enriched.replace(marker,marker+images);}}return {html:enriched,shots};}
  return {html,shots};
}
