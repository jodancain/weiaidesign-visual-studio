import * as T from 'three';
import { validateSceneProgram, type SceneProgram, type V3 } from './schema';
import { createWorld } from './world';
import { directShot } from './actions';
import { smooth } from './geometry';
import { sampleTrack } from '../animation';
import type { StudioScene, SceneObject, StudioCamera, AnimationTrack, Transform, RigProfile } from '../types';
export { validateSceneProgram } from './schema';
export { makeTemplateProgram } from './defaults';
export type { SceneProgram } from './schema';
export type CodeSceneEdits = Partial<Pick<StudioScene,'objects'|'tracks'|'cameras'|'lights'|'exposure'|'background'>>;
type Pose = {position:T.Vector3;quaternion:T.Quaternion;scale:T.Vector3;visible:boolean};
const pose=(o:T.Object3D):Pose=>({position:o.position.clone(),quaternion:o.quaternion.clone(),scale:o.scale.clone(),visible:o.visible});
const transform=(o:T.Object3D):Transform=>({position:o.position.toArray(),rotation:o.quaternion.toArray(),scale:o.scale.toArray()});
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
function delta(o:T.Object3D,t:Transform,base:Transform){o.position.add(new T.Vector3(...t.position).sub(new T.Vector3(...base.position)));o.quaternion.premultiply(new T.Quaternion(...t.rotation).multiply(new T.Quaternion(...base.rotation).invert())).normalize();o.scale.multiply(new T.Vector3(...t.scale).divide(new T.Vector3(...base.scale)));}

/** Shared scene evaluator used without React by both render adapters and by the director. */
export function createCodeScene(input:SceneProgram){
  const program=validateSceneProgram(input),world=createWorld(program),scene=world.scene;
  const cameras=new Map<string,T.PerspectiveCamera>();
  for(const s of program.shots){const c=new T.PerspectiveCamera(40,16/9,.005,50);c.name=`${program.id}-${s.id}`;c.userData.studioCameraId=c.name;scene.add(c);cameras.set(c.name,c);}
  const camera=new T.PerspectiveCamera(40,16/9,.005,50);camera.name='CodeSceneOutputCamera';
  const parts=new Map<string,Map<string,T.Object3D>>();
  for(const [key,node]of Object.entries(world.refs)){
    if(world.entities.has(key)||node instanceof T.Bone)continue;
    let parent:T.Object3D|null=node.parent;while(parent&&!world.entities.has(parent.name))parent=parent.parent;
    if(!parent)continue;const id=`part-${key}`,m=parts.get(parent.name)||new Map<string,T.Object3D>();parts.set(parent.name,m);m.set(id,node);node.userData.studioPartRoot=true;node.userData.studioPartId=id;node.traverse(child=>{child.userData.studioObjectId=parent!.name;child.userData.studioPartId=id;});
  }
  // Material instances are isolated by semantic object and part: editing one panel cannot recolor another.
  for(const [id,root]of world.entities){const cache=new Map<T.Material,T.Material>();root.traverse(o=>{if(o instanceof T.Mesh){const clone=(m:T.Material)=>{if(!cache.has(m))cache.set(m,m.clone());return cache.get(m)!;};o.material=Array.isArray(o.material)?o.material.map(clone):clone(o.material);}});for(const part of parts.get(id)?.values()??[])part.traverse(o=>{if(o instanceof T.Mesh)o.material=Array.isArray(o.material)?o.material.map(m=>m.clone()):o.material.clone();});}
  // Keep animation references on the isolated material instance actually rendered.
  for(const [id,a]of world.actors)if(a.eye){let rendered:T.MeshStandardMaterial|undefined;world.entities.get(id)!.traverse(o=>{if(o instanceof T.Mesh)for(const m of Array.isArray(o.material)?o.material:[o.material])if(m instanceof T.MeshStandardMaterial&&m.color.equals(a.eye!.color))rendered=m;});if(rendered)a.eye=rendered;}
  const animatedMaterials=new Map<T.MeshStandardMaterial,T.MeshStandardMaterial[]>();
  for(const key of Object.keys(world.materials)){const original=world.materials[key],owner=world.entities.get(({cellGlow:'cell',lamp:'shop-lamp',rootGlow:'root-glow'} as Record<string,string>)[key]??key),matches:T.MeshStandardMaterial[]=[];(owner??scene).traverse(o=>{if(o instanceof T.Mesh)for(const m of Array.isArray(o.material)?o.material:[o.material])if(m instanceof T.MeshStandardMaterial&&m.color.equals(original.color)&&m.emissive.equals(original.emissive)&&!matches.includes(m))matches.push(m);});if(matches.length){world.materials[key]=matches[0];animatedMaterials.set(matches[0],matches);}}
  const rest=new Map<T.Object3D,Pose>(),materialRest=new Map<T.MeshStandardMaterial,{color:T.Color;emissive:T.Color;intensity:number}>(),lightRest=new Map<T.Light,{color:T.Color;intensity:number}>();
  scene.traverse(o=>{rest.set(o,pose(o));if(o instanceof T.Mesh){for(const m of Array.isArray(o.material)?o.material:[o.material])if(m instanceof T.MeshStandardMaterial)materialRest.set(m,{color:m.color.clone(),emissive:m.emissive.clone(),intensity:m.emissiveIntensity});}if(o instanceof T.Light)lightRest.set(o,{color:o.color.clone(),intensity:o.intensity});});
  const background=scene.background instanceof T.Color?scene.background.clone():new T.Color('#101820');
  const baseObjects=new Map<string,SceneObject>(),baseCameras=new Map<string,StudioCamera>();
  let exposure=program.look?.exposure??1;
  function reset(){for(const [o,r]of rest){o.position.copy(r.position);o.quaternion.copy(r.quaternion);o.scale.copy(r.scale);o.visible=r.visible;}for(const[m,r]of materialRest){m.color.copy(r.color);m.emissive.copy(r.emissive);m.emissiveIntensity=r.intensity;}for(const[l,r]of lightRest){l.color.copy(r.color);l.intensity=r.intensity;}scene.background=background.clone();if(scene.fog instanceof T.Fog)scene.fog.color.copy(background);exposure=program.look?.exposure??1;}
  function tint(node:T.Object3D,color:string){node.traverse(n=>{if(n instanceof T.Mesh)for(const m of Array.isArray(n.material)?n.material:[n.material])if(m instanceof T.MeshStandardMaterial)m.color.set(color);});}
  function evaluateFrame(requested:number,edits?:CodeSceneEdits){
    const frame=Math.max(0,Math.min(program.totalFrames-1,Math.floor(requested)));reset();const shot=program.shots[Math.floor(frame/144)];const contacts=directShot(world,shot,frame);for(const[source,members]of animatedMaterials)for(const m of members){m.emissive.copy(source.emissive);m.emissiveIntensity=source.emissiveIntensity;}
    const frameTargets=new Map<string,T.Vector3>();for(const s of program.shots){const c=cameras.get(`${program.id}-${s.id}`)!,t=smooth(Math.max(0,Math.min(1,(frame-s.startFrame)/143)));c.position.fromArray(s.camera.position).lerp(new T.Vector3(...s.camera.positionEnd),t);const target=new T.Vector3(...s.camera.target).lerp(new T.Vector3(...s.camera.targetEnd),t);frameTargets.set(c.name,target);c.filmGauge=36;c.setFocalLength(s.camera.lensMm);c.lookAt(target);}
    if(edits){
      if(edits.objects){const ids=new Set(edits.objects.map(o=>o.id));for(const[id,node]of world.entities)if(!ids.has(id))node.visible=false;}
      for(const obj of edits.objects??[]){const node=world.entities.get(obj.id),base=baseObjects.get(obj.id);if(!node||!base)continue;delta(node,obj.transform,base.transform);node.visible=node.visible&&obj.visible;if(obj.color!==base.color)tint(node,obj.color);
        for(const part of obj.parts??[]){const pn=parts.get(obj.id)?.get(part.id),pb=base.parts?.find(p=>p.id===part.id);if(pn&&pb){delta(pn,part.transform,pb.transform);pn.visible=pn.visible&&part.visible;if(part.color&&part.color!==pb.color)tint(pn,part.color);}}
        const actor=world.actors.get(obj.id);if(actor)for(const[name,q]of Object.entries(obj.bonePoses??{}))actor.bones.get(name)?.quaternion.fromArray(q).normalize();
      }
      for(const c of edits.cameras??[]){let node=cameras.get(c.id);if(!node){node=new T.PerspectiveCamera(40,16/9,.005,50);node.name=c.id;scene.add(node);cameras.set(c.id,node);}const base=baseCameras.get(c.id);if(!base||!same(c.position,base.position))node.position.fromArray(c.position);if(!base||c.sensorWidth!==base.sensorWidth)node.filmGauge=c.sensorWidth;if(!base||c.focalLength!==base.focalLength)node.setFocalLength(c.focalLength);node.lookAt(!base||!same(c.target,base.target)?new T.Vector3(...c.target):frameTargets.get(c.id)!);}
      for(const track of edits.tracks??[]){const v=sampleTrack(track,frame);if(v===undefined)continue;const target=track.partId?parts.get(track.targetId)?.get(track.partId):track.bone?world.actors.get(track.targetId)?.bones.get(track.bone):world.entities.get(track.targetId)??cameras.get(track.targetId);if(!target)continue;
        if(track.property==='position'&&Array.isArray(v))target.position.fromArray(v);else if(track.property==='rotation'&&Array.isArray(v))target.quaternion.fromArray(v).normalize();else if(track.property==='scale'&&Array.isArray(v))target.scale.fromArray(v);else if(track.property==='visible')target.visible=!!Number(v);else if(track.property==='focalLength'&&target instanceof T.PerspectiveCamera)target.setFocalLength(Number(v));
      }
      scene.updateMatrixWorld(true);
      for(const obj of edits.objects??[]){const actor=world.actors.get(obj.id);if(!actor||!obj.rig)continue;
        const clamp=(b:T.Bone)=>{const l=obj.rig?.limits?.[b.name];if(l){const e=new T.Euler().setFromQuaternion(b.quaternion,'XYZ');e.set(T.MathUtils.clamp(e.x,l.min[0],l.max[0]),T.MathUtils.clamp(e.y,l.min[1],l.max[1]),T.MathUtils.clamp(e.z,l.min[2],l.max[2]));b.quaternion.setFromEuler(e);}};
        for(const b of actor.bones.values())clamp(b);
        for(const chain of obj.rig.chains.filter(c=>c.enabled)){const t=(edits.tracks??[]).find(t=>t.targetId===obj.id&&t.bone===chain.id&&t.property==='ikTarget'),v=t?sampleTrack(t,frame):undefined,target=actor.root.localToWorld(new T.Vector3(...(Array.isArray(v)?v:chain.target) as V3)),end=actor.bones.get(chain.effector);if(!end)continue;
          for(let i=0;i<40;i++)for(const name of chain.links){const b=actor.bones.get(name);if(!b)continue;actor.root.updateMatrixWorld(true);const origin=b.getWorldPosition(new T.Vector3()),inv=b.getWorldQuaternion(new T.Quaternion()).invert(),from=end.getWorldPosition(new T.Vector3()).sub(origin).applyQuaternion(inv).normalize(),to=target.clone().sub(origin).applyQuaternion(inv).normalize();b.quaternion.multiply(new T.Quaternion().setFromUnitVectors(from,to));clamp(b);}
        }
      }
      if(edits.background&&edits.background!==`#${background.getHexString()}`){scene.background=new T.Color(edits.background);if(scene.fog instanceof T.Fog)scene.fog.color.set(edits.background);}
      if(edits.exposure!==undefined)exposure=edits.exposure;
      if(edits.lights){const ids=new Set(edits.lights.map(l=>l.id));for(const[id,l]of Object.entries(world.lights))if(l.parent===scene&&!ids.has(id))l.visible=false;}
      for(const data of edits.lights??[]){let l=world.lights[data.id];if(!l){l=data.type==='point'?new T.PointLight():data.type==='directional'?new T.DirectionalLight():new T.AmbientLight();l.name=data.id;scene.add(l);world.lights[data.id]=l;}l.visible=true;const base=lightRest.get(l);if(!base||data.intensity!==base.intensity)l.intensity=data.intensity;if(!base||data.color!==`#${base.color.getHexString()}`)l.color.set(data.color);l.position.fromArray(data.position);}
    }
    scene.updateMatrixWorld(true);for(const a of world.actors.values())a.skeleton?.update();for(const c of cameras.values())c.updateProjectionMatrix();const active=cameras.get(`${program.id}-${shot.id}`)!;camera.position.copy(active.position);camera.quaternion.copy(active.quaternion);camera.filmGauge=active.filmGauge;camera.setFocalLength(active.getFocalLength());camera.updateMatrixWorld(true);
    return{frame,shotId:shot.id,cameraId:active.name,action:shot.action.kind,contacts,exposure};
  }
  evaluateFrame(0);
  for(const[id,node]of world.entities){const actor=world.actors.get(id);const rig:RigProfile|undefined=actor?.bones.size?{id:`code-${id}-v1`,bones:Object.fromEntries([...actor.bones.keys()].map(n=>[n,n])),chains:['Left','Right'].flatMap(side=>[{id:side.toLowerCase()+'-hand',target:node.worldToLocal(actor.hand(side as 'Left'|'Right').getWorldPosition(new T.Vector3())).toArray(),effector:side+'Hand',links:[side+'ForeArm',side+'UpperArm'],enabled:false},{id:side.toLowerCase()+'-foot',target:node.worldToLocal(actor.bones.get(side+'Foot')!.getWorldPosition(new T.Vector3())).toArray(),effector:side+'Foot',links:[side+'Leg',side+'UpLeg'],enabled:false}])}:undefined;
    baseObjects.set(id,{id,name:({ashuan:'阿栓 · 单眼机器人',scout:'探路机',bear:'针脚熊',mouse:'灰绒鼠',fox:'木狐狸'})[id as 'ashuan']??id,kind:actor?'character':'model',transform:transform(node),color:'#ffffff',visible:true,locked:false,...(rig?{rig}:{}),...(parts.has(id)?{parts:[...parts.get(id)!].map(([partId,p])=>({id:partId,transform:transform(p),visible:true,locked:false}))}:{})});
  }
  for(const s of program.shots)baseCameras.set(`${program.id}-${s.id}`,{id:`${program.id}-${s.id}`,name:`${s.id} · ${s.action.kind}`,position:[...s.camera.position],target:[...s.camera.target],focalLength:s.camera.lensMm,sensorWidth:36});
  function snapshot():StudioScene{return{id:program.id,name:program.title,revision:0,units:'meters',up:'Y',objects:structuredClone([...baseObjects.values()]),cameras:structuredClone([...baseCameras.values()]),activeCameraId:`${program.id}-s01`,background:`#${background.getHexString()}`,groundColor:'#303030',showGround:false,exposure:program.look?.exposure??1,lights:Object.entries(world.lights).filter(([,l])=>l.parent===scene).map(([id,l])=>({id,name:id,type:l instanceof T.DirectionalLight?'directional':l instanceof T.PointLight?'point':'ambient',position:l.position.toArray(),intensity:lightRest.get(l)!.intensity,color:`#${lightRest.get(l)!.color.getHexString()}`})),tracks:[],clips:[],codeProgram:structuredClone(program)};}
  function dispose(){const geometries=new Set<T.BufferGeometry>(),materials=new Set<T.Material>(),textures=new Set<T.Texture>();scene.traverse(o=>{if(o instanceof T.Mesh||o instanceof T.Points){geometries.add(o.geometry);for(const m of Array.isArray(o.material)?o.material:[o.material]){materials.add(m);for(const v of Object.values(m))if(v instanceof T.Texture)textures.add(v);}}});geometries.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());textures.forEach(t=>t.dispose());for(const a of world.actors.values())a.skeleton?.dispose();scene.clear();}
  return{scene,camera,cameras,world,parts,program,get exposure(){return exposure;},evaluateFrame,snapshot,dispose};
}
export type CodeSceneRuntime=ReturnType<typeof createCodeScene>;
export function compileSceneProgram(program:SceneProgram):StudioScene{const runtime=createCodeScene(program);try{return runtime.snapshot();}finally{runtime.dispose();}}
