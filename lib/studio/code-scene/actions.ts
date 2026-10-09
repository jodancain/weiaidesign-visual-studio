import * as T from 'three';
import type { CodeWorld } from './world';
import type { CodeShot, V3 } from './schema';
import { reach, nod, walk, type CodeActor } from './actors';
import { pointOn, smooth, noise } from './geometry';

export type Contact = { actorId:string; bone:string; target:number[]; errorMeters:number; label:string };
const mix=(a:number,b:number,t:number)=>a+(b-a)*t;
const window=(p:number,a:number,b:number)=>smooth(Math.max(0,Math.min(1,(p-a)/(b-a))));
/** All poses are functions of the requested frame. State is reset by the runtime first. */
export function directShot(w:CodeWorld,shot:CodeShot,frame:number):Contact[] {
  const contacts:Contact[]=[], local=frame-shot.startFrame, p=window(local,shot.action.startFrame,shot.action.endFrame), index=Math.floor(shot.startFrame/144);
  const ref=(id:string)=>w.refs[id];
  const at=(id:string,pos:V3,yaw=0)=>{const r=ref(id);const adjusted=[...pos] as V3;if(w.actors.has('bear')){if(id==='scissors'||id==='blue-patch'||(id==='blue-umbrella'&&shot.action.kind==='cut-patch'))adjusted[1]-=.075;if(id==='yellow-umbrella')adjusted[1]-=.04;}r.position.fromArray(adjusted);r.rotation.y=yaw;return r;};
  const visible=(id:string,v:boolean)=>{ref(id).visible=v;};
  const hand=(id:string,side:'Left'|'Right',target:V3|T.Vector3,label:string)=>{const actor=w.actors.get(id)!,v=target instanceof T.Vector3?target:new T.Vector3(...target);const errorMeters=reach(actor,side,v);contacts.push({actorId:id,bone:side+'Hand',target:v.toArray(),errorMeters,label});return pointOn(actor.hand(side));};
  const finger=(a:CodeActor,side:'Left'|'Right',curl=.7)=>{for(let i=0;i<3;i++)a.bones.get(side+'Finger'+i)!.rotation.x=curl;};
  const pulse=()=>Math.max(0,...(shot.action.beatFrames??[40,65,90]).map(f=>Math.max(0,1-Math.abs(local-f)/5)));
  const film=shot.action.kind;
  if(w.actors.has('ashuan')){
    const a=w.actors.get('ashuan')!,scout=w.actors.get('scout')!;
    at('ashuan',[.45,0,.56]);at('scout',[-.55,0,-.30]);scout.root.visible=index===4||index>=6;
    visible('cell',index>=6);visible('charge-plug',index>=8);visible('charge-cable',index>=8);
    ref('doorLeaf').position.x=index>=6?-.68:0;
    a.eye!.emissiveIntensity=1.4;scout.eye!.emissiveIntensity=index>=8?2:.15;
    if(index<8){w.lights.warm.intensity=.32;w.lights.key.intensity*=.75;}
    if(index>=8){at('scout',[.68,.443,.26]);at('cell',[.68,.492,.37]);}
    if(film==='look-up'){nod(a,mix(.27,-.15,p),mix(.25,0,p));a.bones.get('Chest')!.rotation.y=.12;}
    if(film==='hear-knocks'){at('ashuan',[-.20,0,.10],mix(0,-1.15,p));nod(a,-.08,mix(.1,-.4,p));a.bones.get('Chest')!.rotation.y=-.13*p;}
    if(film==='knock-door'){
      at('ashuan',[-.20,0,-.55],Math.PI);const t:V3=[-.25,.49,-.715-.035*pulse()];hand('ashuan','Right',t,'three door taps');finger(a,'Right',1.1);nod(a,-.06);
    }
    if(film==='grasp-wheel'||film==='turn-wheel'){
      at('ashuan',[-.20,0,-.55],Math.PI);const angle=film==='turn-wheel'?p*Math.PI*1.3:0;ref('handwheel').rotation.z=angle;
      const grip=new T.Vector3(-.35+Math.cos(angle)*.09,.48+Math.sin(angle)*.09,-.715);
      const start=new T.Vector3(-.29,.29,-.58);if(film==='grasp-wheel')grip.lerpVectors(start,grip,window(p,.04,.65));
      hand('ashuan','Right',grip,film==='turn-wheel'?'handwheel locked grip':'handwheel grasp');finger(a,'Right',1.1);nod(a,.10);
      if(film==='turn-wheel')ref('doorLeaf').position.x=-.68*window(p,.12,.95);
    }
    if(film==='scout-approach'){
      a.root.visible=false;at('scout',[-.75,.54,mix(-1.58,-1.025,p)]);at('cell',[-.535,.69,mix(-1.45,-.895,p)]);visible('cell',true);scout.root.rotation.z=Math.sin(p*8)*.025;
    }
    if(film==='scout-enter'){
      at('ashuan',[-.10,0,-.36],Math.PI*.6);at('scout',[-.55,.54*(1-p),mix(-.84,-.25,p)]);scout.root.rotation.z=Math.sin(p*24)*.025*(1-p);
      ref('cell').position.copy(pointOn(scout.root,[.215,.152,.13]));nod(a,.18,-.15);
    }
    if(film==='inspect-thruster'){a.root.visible=false;at('scout',[-.55,0,-.30]);ref('cell').position.copy(pointOn(scout.root,[.215,.152,.13]));scout.eye!.emissiveIntensity=.10+.08*Math.sin(p*7);}
    if(film==='plug-cell'){
      at('ashuan',[.32,0,.36],0);const q=window(p,.04,.77);at('charge-plug',[mix(.34,.525,q),.60,.26]);const target=ref('charge-plug').position.clone();hand('ashuan','Right',target,'connector seated in scout side port');finger(a,'Right');nod(a,.27,.12);
      scout.eye!.emissiveIntensity=.12+1.9*window(p,.77,.92);w.materials.cellGlow.emissiveIntensity=1.3-.6*window(p,.77,.92);
    }
    if(film==='answer-knocks'){
      at('ashuan',[.12,0,.43]);at('scout',[.57,.443,.24]);hand('ashuan','Right',[.258,.473-.025*pulse(),.445],'three workbench taps');finger(a,'Right',1.0);nod(a,.08,.32);
      scout.eye!.emissiveIntensity=1.3+pulse()*1.2;w.lights.key.intensity*=.45;w.lights.warm.intensity=.12;
    }
    if(index>=8){const plug=ref('charge-plug').position,cell=ref('cell').position.clone().add(new T.Vector3(-.065,0,0)),d=cell.sub(plug);ref('charge-cable').position.copy(plug);ref('charge-cable').quaternion.setFromUnitVectors(new T.Vector3(0,1,0),d.clone().normalize());ref('charge-cable').scale.set(1,d.length(),1);}
  }else if(w.actors.has('bear')){
    const bear=w.actors.get('bear')!,mouse=w.actors.get('mouse')!;
    at('bear',[.08,0,.09]);at('mouse',[-.29,0,.14]);mouse.root.visible=[1,5,7,8].includes(index);
    at('blue-umbrella',[.39,.43,-.22]);at('yellow-umbrella',[-.15,.27,.22]);visible('yellow-umbrella',index>=1&&index<=5);
    ref('yellow-umbrellaPanel0').visible=false;ref('yellow-umbrellaPanel1').visible=false;
    ref('blue-umbrellaPanel0').visible=index<5;ref('blue-umbrellaPanel1').visible=index<5;
    visible('blue-patch',index>=5&&index<=5);visible('paper-sun',index>=7);
    at('paper-sun',[-.38,.17,-.167]);ref('toolboxLid').rotation.x=index===0?-.90:index===9?-1.45:0;ref('cloth-boxLid').rotation.x=index>=3?-1.4:0;
    visible('scissors',index===0||index===4);w.lights.shopLamp.intensity=index===9?.25:.04;w.materials.lamp.emissiveIntensity=index===9?1.5:.03;
    if(film==='put-scissors'){
      at('bear',[.207,0,.14]);const q=window(p,.08,.8);at('scissors',[.275,mix(.31,.27,q),mix(.185,.18,q)]);hand('bear','Right',ref('scissors').position.clone().add(new T.Vector3(0,0,-.042)),'scissors placed in tool box');finger(bear,'Right');nod(bear,.22);ref('toolboxLid').rotation.x=-.90;
    }
    if(film==='offer-umbrella'){
      at('mouse',[mix(-.348,-.158,p),0,.23]);walk(mouse,p*Math.PI*4,.5*(1-p));at('yellow-umbrella',[mix(-.32,-.13,p),.28,.23]);
      const shaft=ref('yellow-umbrella').position.clone().add(new T.Vector3(0,-.1425,0));hand('mouse','Right',shaft,'mouse presents broken umbrella');nod(bear,.16,-.35);
    }
    if(film==='open-cloth-box'){
      at('bear',[.068,0,.135]);const angle=-1.4*window(p,.04,.86);ref('cloth-boxLid').rotation.x=angle;
      hand('bear','Left',pointOn(ref('cloth-boxLid'),[0,0,.027]),'hand follows cloth box lid');nod(bear,.3);
    }
    if(film==='look-umbrella'){nod(bear,mix(.25,-.12,p),mix(0,1,p));bear.bones.get('Chest')!.rotation.y=.25*p;}
    if(film==='cut-patch'){
      at('bear',[.04,0,.15]);at('blue-umbrella',[.04,.255,.20]);const cut=window(p,.05,.72),detached=window(p,.72,1);
      const cutPos:V3=[mix(.04,.175,cut),mix(.305,.258,cut),.205];at('scissors',cutPos);ref('scissorA').rotation.y=.13+Math.sin(cut*Math.PI*10)*.15;ref('scissorB').rotation.y=-ref('scissorA').rotation.y;
      hand('bear','Right',ref('scissors').position.clone().add(new T.Vector3(0,-.006,-.047)),'scissor handle during cloth cut');finger(bear,'Right');nod(bear,.27);
      hand('bear','Left',[.018,.201,.188],'steady umbrella canopy');
      const removed=p>=.72;ref('blue-umbrellaPanel0').visible=!removed;ref('blue-umbrellaPanel1').visible=!removed;visible('blue-patch',removed);
      at('blue-patch',[.04+detached*.07,.255-detached*.008,.20+detached*.05]);ref('blue-patch').rotation.z=-detached*.13;
    }
    if(film==='give-umbrella'){
      at('bear',[.065,0,.18]);const q=window(p,.08,.83);at('mouse',[mix(-.087,-.217,q),0,.22]);at('yellow-umbrella',[mix(-.06,-.19,q),.285,.22]);ref('blue-patch').position.copy(ref('yellow-umbrella').position);ref('blue-patch').position.y+=.001;
      hand('bear','Left',[mix(.06,-.07,q),.23,.20],'bear passes repaired umbrella');hand('mouse','Right',[mix(-.06,-.19,q),.095,.22],'mouse receives repaired umbrella');nod(bear,.1,-.3);
    }
    if(film==='shop-alone'){nod(bear,mix(-.08,.26,p),-.25);bear.bones.get('Chest')!.rotation.x=.06*p;ref('toolboxLid').rotation.x=0;}
    if(film==='attach-sun'){
      at('mouse',[-.38,.035,-.12],Math.PI);const q=window(p,.05,.72);at('paper-sun',[-.38,mix(.14,.17,q),mix(-.11,-.167,q)]);
      hand('mouse','Left',ref('paper-sun').position.clone().add(new T.Vector3(.006,0,.012)),'paper sun pressed onto door');nod(bear,-.06,-.7);finger(mouse,'Left',.25);
    }
    if(film==='wave-thanks'){
      at('mouse',[-.38,.035,-.20]);mouse.root.visible=false;nod(bear,-.1,-.5);const t=new T.Vector3(-.027,.27,.12);t.x+=Math.sin(p*Math.PI*2)*.018;hand('bear','Left',t,'single thank-you wave');
    }
    if(film==='light-shop'){
      at('bear',[-.16,0,-.09]);const pull=window(p,.03,.33)*(1-window(p,.50,.75));if(p<=.55)hand('bear','Left',[-.235,.30-pull*.025,-.12],'lamp pull cord');nod(bear,-.22,-.10);
      w.lights.shopLamp.intensity=.04+.28*window(p,.25,.4);w.materials.lamp.emissiveIntensity=.03+1.5*window(p,.25,.4);ref('toolboxLid').rotation.x=-1.3*window(p,.6,.95);
      if(p>.55){at('bear',[mix(-.16,.28,window(p,.55,.82)),0,mix(-.09,.13,window(p,.55,.82))]);if(p>.82)hand('bear','Right',pointOn(ref('toolboxLid'),[0,0,.008]),'reopen toolbox for work');else walk(bear,p*15,.35);}
    }
    if(w.rain){const arr=w.rain.geometry.attributes.position;for(let i=0;i<arr.count;i++)arr.setY(i,(noise(23,i)*1.1-frame*.008%1.1+1.1)%1.1);arr.needsUpdate=true;}
  }else{
    const fox=w.actors.get('fox')!;at('fox',[-.20,0,.39]);at('lantern',[-.145,.075,.435]);visible('new-seed',index===9);visible('root-glow',index>=8);ref('lanternLid').position.set(0,0,0);
    const holdLamp=(x:number,y:number,z:number,both=false)=>{at('lantern',[x,y,z]);const target=pointOn(ref('lantern'),[0,.108,0]);hand('fox','Right',target,'lantern handle');finger(fox,'Right');if(both)hand('fox','Left',new T.Vector3(-.025,.055,0).applyQuaternion(fox.root.quaternion).add(new T.Vector3(x,y,z)),'steady lantern body');};
    const seedInLamp=()=>{ref('light-seed').position.copy(pointOn(ref('lantern'),[0,.04,0]));};
    if(film==='walk-lantern'){
      at('fox',[-.20,0,mix(.46,.32,p)]);walk(fox,p*Math.PI*4,.45);holdLamp(-.155,.066,.505-.14*p);seedInLamp();nod(fox,.06);
    }
    if(film==='hug-lantern'){holdLamp(-.19,.080,.443,true);seedInLamp();nod(fox,mix(.06,.25,p));}
    if(film==='show-tree'){at('fox',[-.15,0,.29],.50);holdLamp(-.105,.075,.326);seedInLamp();nod(fox,-.30*window(p,.1,.8),.65*p);}
    if(['hesitate','test-bridge','jump-bridge'].includes(film)){
      let x=-.16,y=.046;
      if(film==='jump-bridge'){
        const flight=window(p,.22,.78);x=mix(-.16,.18,flight);y=.046+Math.sin(flight*Math.PI)*.105-.020*(Math.sin(Math.min(1,p/.22)*Math.PI));
        if(p>.78)y-=Math.sin((p-.78)/.22*Math.PI)*.014;
        fox.bones.get('LeftUpLeg')!.rotation.x=-.45*Math.sin(flight*Math.PI);fox.bones.get('RightUpLeg')!.rotation.x=.32*Math.sin(flight*Math.PI);
        fox.bones.get('LeftLeg')!.rotation.x=.60*Math.sin(flight*Math.PI);fox.bones.get('RightLeg')!.rotation.x=.60*Math.sin(flight*Math.PI);
      }
      at('fox',[x,y,0],Math.PI/2);holdLamp(x+.04,y+.065,-.037,true);seedInLamp();nod(fox,.13);
      if(fox.cape)fox.cape.rotation.x=.18+Math.sin(p*Math.PI)*.40;
      if(film==='hesitate'){nod(fox,mix(.03,.30,p),-.2*p);}
      if(film==='test-bridge'){const tap=Math.sin(p*Math.PI);fox.bones.get('LeftUpLeg')!.rotation.x=-.40*tap;fox.bones.get('LeftLeg')!.rotation.x=.20*tap;ref('testPlank').rotation.z=-.08*tap;}
    }
    if(index>=6){
      at('fox',[.41,0,-.21],Math.PI/2);at('lantern',[.59,.008,-.14]);ref('lanternLid').position.set(.052,-.073,0);nod(fox,.32);
      ref('light-seed').position.set(.485,.012,-.23);
      if(film==='hold-seed'){
        const t:V3=[mix(.447,.469,p),.137,-.232];const hp=hand('fox','Right',t,'seed held above planting pit');ref('light-seed').position.copy(hp).add(new T.Vector3(0,.012,0));finger(fox,'Right',.30);
      }
      if(film==='drop-seed'){
        const hp=hand('fox','Right',[.469,.137,-.232],'release seed');const fall=window(p,.30,.69);ref('light-seed').position.copy(hp).add(new T.Vector3(0,.012,0)).lerp(new T.Vector3(.485,.012,-.23),fall);
        finger(fox,'Right',.50*(1-window(p,.25,.38)));w.materials['light-seed'].emissiveIntensity=1.8*(1-.9*window(p,.72,1));w.lights['light-seed'].intensity=.055*(1-.95*window(p,.72,1));
      }
      if(film==='grow-light'){
        nod(fox,mix(.30,-.30,p));for(let i=0;i<35;i++)ref(`growth-${i}`).visible=p>=i/40;for(let i=0;i<12;i++)ref(`root-${i}`).scale.setScalar(Math.max(.001,window(p,i*.035,.4+i*.035)));
        w.lights.warm.intensity=.02+.10*p;w.materials.rootGlow.emissiveIntensity=.6+1.3*p;
      }
      if(film==='catch-new-seed'){
        at('fox',[.51,0,-.15],0);holdLamp(.535,.072,-.11,true);ref('lanternLid').position.set(.055,-.069,0);const fall=window(p,.12,.72);
        at('new-seed',[.535,mix(.35,.112,fall),-.11]);ref('new-seed').rotation.z=p*2;ref('light-seed').visible=false;nod(fox,mix(-.25,.20,p));w.lights.warm.intensity=.12;
      }
    }
  }
  w.scene.updateMatrixWorld(true);for(const a of w.actors.values())a.skeleton?.update();
  return contacts;
}
