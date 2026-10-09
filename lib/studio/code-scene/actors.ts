import * as T from 'three';
import { box, sphere, cylinder, rod, torus, surface, mesh, entity, identify, pointOn } from './geometry';
import type { V3 } from './schema';

export type ActorId = 'ashuan' | 'scout' | 'bear' | 'mouse' | 'fox';
export type CodeActor = { id: ActorId; root: T.Group; bones: Map<string, T.Bone>; skeleton?: T.Skeleton; height: number; eye?: T.MeshStandardMaterial; cape?: T.Bone; hand: (side: 'Left' | 'Right') => T.Bone };
const HEIGHT = { ashuan: .75, scout: .30, bear: .35, mouse: .18, fox: .25 };

/** Rigid-jointed stylized characters, with real skinIndex/skinWeight and one shared skeleton. */
export function makeActor(id: ActorId, seed: number): CodeActor {
  const root = entity(id), bones = new Map<string, T.Bone>(), height = HEIGHT[id];
  if (id === 'scout') {
    const shell = surface('#e6dfcb', 'metal', seed), dark = surface('#252b2e', 'metal', seed), metal = surface('#59616a', 'metal', seed), eye = surface('#39bbff'); eye.emissive.set('#27aaff'); eye.emissiveIntensity = 2;
    sphere(root, [.15, .145, .145], [0, .16, 0], shell); torus(root, .146, .006, [0, .16, 0], dark).rotation.x = Math.PI / 2;
    box(root, [.17, .044, .045], [0, .18, .135], dark, .018); box(root, [.14, .014, .009], [0, .182, .16], eye, .006);
    rod(root, [0, .3, 0], [0, .36, 0], .006, metal); sphere(root, [.012,.012,.012],[0,.365,0],dark);
    for (const x of [-.085,.085]) { const w = cylinder(root,.035,.024,[x,.035,0],dark);w.rotation.z=Math.PI/2; }
    const thruster = entity('scout-thruster'); thruster.position.set(-.135,.17,0);root.add(thruster);torus(thruster,.058,.014,[0,0,0],dark).rotation.y=Math.PI/2;
    for(let i=0;i<7;i++){const a=i/7*Math.PI*2;rod(thruster,[0,Math.cos(a)*.047,Math.sin(a)*.047],[-.025,Math.cos(a+.25)*.03,Math.sin(a+.25)*.025],.009,dark);}
    rod(root,[.135,.17,0],[.205,.115,.10],.012,metal);box(root,[.10,.012,.09],[.215,.105,.13],metal,.004);
    identify(root,id);return {id,root,bones,height,eye,hand:()=>{throw Error('Scout has mechanical tray, no humanoid hand');}};
  }
  const scale = height / 1.65; root.scale.setScalar(scale);
  const bone = (name: string, parent: string | null, p: V3) => { const b = new T.Bone(); b.name = name; b.userData.studioBoneId = name; b.position.fromArray(p); (parent ? bones.get(parent)! : root).add(b); bones.set(name, b); return b; };
  const hips = bone('Hips',null,[0,.52,0]), spine=bone('Spine','Hips',[0,.23,0]), chest=bone('Chest','Spine',[0,.24,0]), neck=bone('Neck','Chest',[0,.20,0]), head=bone('Head','Neck',[0,.10,0]);
  for(const [s,x] of [['Left',-.25],['Right',.25]] as const) {
    bone(s+'UpperArm','Chest',[x,.02,0]);bone(s+'ForeArm',s+'UpperArm',[0,-.25,0]);bone(s+'Hand',s+'ForeArm',[0,-.23,0]);
    bone(s+'UpLeg','Hips',[x*.5,0,0]);bone(s+'Leg',s+'UpLeg',[0,-.24,0]);bone(s+'Foot',s+'Leg',[0,-.23,0]);
  }
  const isRobot=id==='ashuan', isFox=id==='fox', isBear=id==='bear';
  const body=surface(isRobot?'#eee4d3':isFox?'#bc8048':isBear?'#d5bd91':'#8f8c88',isRobot?'metal':isFox?'wood':'cloth',seed);
  const dark=surface('#242825',isRobot?'metal':'plain'), accent=surface(isRobot?'#dd722e':isFox?'#536646':isBear?'#284d3a':'#75a5c5',isRobot?'metal':'cloth',seed+11), cream=surface('#efdbba',isFox?'wood':'cloth',seed+4);
  const eye=surface(isRobot?'#ffc578':'#15120f');if(isRobot){eye.emissive.set('#ff9c37');eye.emissiveIntensity=1.5;}
  if(isRobot){
    box(hips,[.42,.19,.30],[0,0,0],dark);box(spine,[.50,.52,.33],[0,.10,0],accent,.065);box(chest,[.49,.10,.33],[0,.10,0],body);
    box(head,[.53,.38,.38],[0,.06,0],body,.13);cylinder(head,.15,.075,[0,.07,.20],dark).rotation.x=Math.PI/2;torus(head,.125,.017,[0,.07,.245],body);sphere(head,[.10,.10,.019],[0,.07,.256],eye);
    for(let i=-1;i<=1;i++)box(spine,[.038,.135,.008],[i*.085,.20,.173],cream,.008);
    box(bones.get('LeftUpperArm')!,[.085,.04,.02],[-.02,.02,.10],dark,.009);
    for(const s of ['Left','Right']){cylinder(head,.075,.025,[s==='Left'?-.27:.27,.07,0],dark).rotation.z=Math.PI/2;}
  } else if(isFox) {
    sphere(spine,[.23,.31,.18],[0,.06,0],body);sphere(spine,[.14,.21,.022],[0,.07,.172],cream);
    sphere(head,[.29,.27,.24],[0,.05,0],body);const snout=mesh(head,new T.ConeGeometry(.16,.36,12),cream,[0,-.05,.30]);snout.rotation.x=Math.PI/2;sphere(head,[.045,.036,.033],[0,-.048,.48],dark);
    for(const s of [-1,1]){const ear=mesh(head,new T.ConeGeometry(.15,.36,3),body,[s*.20,.35,-.01]);ear.rotation.z=s*-.12;const inner=mesh(head,new T.ConeGeometry(.10,.23,3),accent,[s*.20,.37,.045]);inner.rotation.z=s*-.12;}
    sphere(head,[.035,.040,.015],[0,.21,.206],cream);
    const tail=bone('Tail','Hips',[0,.05,-.12]);const tailMesh=sphere(tail,[.13,.12,.40],[0,.06,-.32],body);tailMesh.rotation.x=-.2;sphere(tail,[.12,.10,.13],[0,.11,-.61],cream);
  } else {
    sphere(spine,[isBear?.34:.24,.37,.25],[0,.06,0],body);sphere(chest,[isBear?.32:.25,.25,.245],[0,-.04,0],accent);
    sphere(head,[isBear?.34:.29,.31,.27],[0,.02,0],body);sphere(head,[.18,.11,.11],[0,-.09,.24],cream);sphere(head,[.064,.046,.038],[0,-.05,.33],dark);
    for(const s of [-1,1]){sphere(head,[isBear?.14:.20,isBear?.14:.20,.065],[s*(isBear?.27:.30),.25,-.02],body);sphere(head,[isBear?.09:.14,isBear?.09:.14,.015],[s*(isBear?.27:.30),.25,.045],surface('#c89991'));}
    if(isBear){for(let i=0;i<4;i++)rod(head,[.25+i*.015,.32,.051],[.28+i*.015,.25,.058],.008,surface('#a73e38'));for(let i=0;i<3;i++)sphere(spine,[.03,.03,.02],[0,.25-i*.14,.254],surface('#9c6933','wood'));}
    else {const tail=bone('Tail','Hips',[0,-.1,-.17]);rod(tail,[0,0,0],[.26,-.18,-.28],.025,body);}
  }
  if(!isRobot)for(const s of [-1,1]) {sphere(head,[.040,.047,.025],[s*.125,.06,.244],eye);sphere(head,[.009,.011,.007],[s*.125-.010,.079,.267],surface('#ffffff'));}
  for(const side of ['Left','Right']) {
    const upper=bones.get(side+'UpperArm')!, fore=bones.get(side+'ForeArm')!, hand=bones.get(side+'Hand')!, thigh=bones.get(side+'UpLeg')!, leg=bones.get(side+'Leg')!, foot=bones.get(side+'Foot')!;
    for(const [b,length,r] of [[upper,.25,.075],[fore,.23,.066],[thigh,.24,.084],[leg,.23,.069]] as [T.Bone,number,number][]) {sphere(b,[r*1.18,r*1.18,r*1.18],[0,0,0],isRobot||isFox?dark:body);cylinder(b,r,length,[0,-length/2,0],body);}
    box(hand,[.13,.105,.075],[0,-.025,.015],isRobot?dark:body,.034);
    for(let k=0;k<3;k++){const finger=bone(side+'Finger'+k,side+'Hand',[(k-1)*.035,-.065,.018]);box(finger,[.031,.065,.045],[0,-.025,.010],isRobot?dark:body,.012);}
    box(foot,[.17,.105,.27],[0,0,.07],isRobot?body:body,.04);
  }
  let cape: T.Bone|undefined;
  if(isFox||id==='mouse') {cape=bone('Cape','Chest',[0,.12,-.12]);const g=new T.CylinderGeometry(.24,.40,.62,20,6,true,0,Math.PI*1.15);g.rotateY(Math.PI*.425);mesh(cape,g,accent,[0,-.20,-.04]);accent.side=T.DoubleSide;}
  root.updateMatrixWorld(true);
  const boneList=[...bones.values()], skeleton=new T.Skeleton(boneList), pieces:T.Mesh[]=[];
  root.traverse(n=>{if(n instanceof T.Mesh)pieces.push(n);});
  const inverseRoot=root.matrixWorld.clone().invert();
  for(const old of pieces){let parent:T.Object3D|null=old.parent;while(parent&&!(parent instanceof T.Bone))parent=parent.parent; if(!(parent instanceof T.Bone))continue;
    const geometry=old.geometry.clone().applyMatrix4(inverseRoot.clone().multiply(old.matrixWorld)),count=geometry.attributes.position.count,index=boneList.indexOf(parent),indices=new Uint16Array(count*4),weights=new Float32Array(count*4);
    for(let n=0;n<count;n++){indices[n*4]=index;weights[n*4]=1;}
    geometry.setAttribute('skinIndex',new T.Uint16BufferAttribute(indices,4));geometry.setAttribute('skinWeight',new T.Float32BufferAttribute(weights,4));
    const skin=new T.SkinnedMesh(geometry,old.material);skin.name=old.name||`${id}-${parent.name}`;skin.frustumCulled=false;skin.castShadow=skin.receiveShadow=true;root.add(skin);skin.bind(skeleton,root.matrixWorld);old.removeFromParent();old.geometry.dispose();
  }
  identify(root,id); return {id,root,bones,skeleton,height,eye,cape,hand:(s)=>bones.get(s+'Hand')!};
}

/** World-space CCD rebuilt from the rest pose every frame; no accumulated solver state. */
export function reach(actor: CodeActor, side: 'Left'|'Right', target: T.Vector3) {
  const end=actor.hand(side),links=[actor.bones.get(side+'ForeArm')!,actor.bones.get(side+'UpperArm')!];actor.root.updateMatrixWorld(true);
  for(let i=0;i<100;i++) {if(pointOn(end).distanceToSquared(target)<1e-12)break;for(const b of links){const origin=pointOn(b),inv=b.getWorldQuaternion(new T.Quaternion()).invert(),from=pointOn(end).sub(origin).applyQuaternion(inv).normalize(),to=target.clone().sub(origin).applyQuaternion(inv).normalize();b.quaternion.multiply(new T.Quaternion().setFromUnitVectors(from,to)).normalize();b.updateMatrixWorld(true);}}
  actor.skeleton?.update();return pointOn(end).distanceTo(target);
}
export function nod(actor:CodeActor,amount:number,yaw=0){actor.bones.get('Head')?.rotation.set(amount,yaw,0);}
export function walk(actor:CodeActor,phase:number,amount=1) {for(const [s,sign] of [['Left',1],['Right',-1]] as const){actor.bones.get(s+'UpLeg')!.rotation.x=sign*Math.sin(phase)*.36*amount;actor.bones.get(s+'Leg')!.rotation.x=Math.max(0,-sign*Math.sin(phase))*.40*amount;}if(actor.cape)actor.cape.rotation.x=.06+Math.sin(phase)*.06*amount;}
