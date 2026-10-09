import * as T from 'three';
import { box, sphere, cylinder, rod, torus, surface, mesh, entity, identify, noise } from './geometry';
import { makeActor, type ActorId, type CodeActor } from './actors';
import type { SceneProgram, V3 } from './schema';
export type CodeWorld = { scene:T.Scene; entities:Map<string,T.Group>; actors:Map<string,CodeActor>; refs:Record<string,T.Object3D>; materials:Record<string,T.MeshStandardMaterial>; lights:Record<string,T.Light>; rain?:T.Points };

export function createWorld(program:SceneProgram):CodeWorld {
  const scene=new T.Scene(),entities=new Map<string,T.Group>(),actors=new Map<string,CodeActor>(),refs:Record<string,T.Object3D>={},materials:Record<string,T.MeshStandardMaterial>={},lights:Record<string,T.Light>={};
  const world:CodeWorld={scene,entities,actors,refs,materials,lights};
  const add=(id:string,p:V3=[0,0,0])=>{const g=entity(id);g.position.fromArray(p);scene.add(g);entities.set(id,g);refs[id]=g;return g;};
  const film=program.film,station=film==='three-knocks',shop=film==='borrow-sunshine';
  scene.background=new T.Color(station?'#101720':shop?'#253e4a':'#101b23');scene.fog=new T.Fog(scene.background,station?3:shop?1.8:1.3,station?12:shop?6:5);
  const ambient=new T.HemisphereLight(station?'#9ebbd7':shop?'#b4d7ed':'#85a3c3',station?'#111318':shop?'#5c412c':'#111511',program.look?.fillIntensity??.5);scene.add(ambient);lights.ambient=ambient;
  const key=new T.DirectionalLight(shop?'#ffe2b4':station?'#aac8ef':'#becbd4',program.look?.keyIntensity??3);key.position.set(station?2:1,station?3:2,station?1:1);key.castShadow=true;key.shadow.mapSize.set(2048,2048);key.shadow.camera.left=-3;key.shadow.camera.right=3;key.shadow.camera.top=3;key.shadow.camera.bottom=-3;key.shadow.camera.near=.01;key.shadow.camera.far=12;key.shadow.normalBias=.002;key.shadow.bias=-.00008;scene.add(key);lights.key=key;
  const fill=new T.DirectionalLight('#c0d4e9',station?1.5:shop?.85:.55);fill.position.set(-2,2,2);scene.add(fill);lights.fill=fill;
  const warm=new T.PointLight(shop?'#ffc56b':'#ffb663',shop?.55:station?.6:.02,shop?1.4:station?3:.6,2);warm.position.set(shop?.25:station?.65:.5,shop?.62:station?1.2:.25,shop?.15:station?.35:-.2);scene.add(warm);lights.warm=warm;
  for(const id of (station?['ashuan','scout']:shop?['bear','mouse']:['fox']) as ActorId[]){const a=makeActor(id,program.seed);scene.add(a.root);actors.set(id,a);entities.set(id,a.root);refs[id]=a.root;}
  const wood=surface('#64402b','wood',program.seed),darkMetal=surface('#303c42','metal',program.seed),iron=surface('#747b7a','metal',program.seed+1),gold=surface('#a77b37','metal',program.seed),black=surface('#101c22');
  if(station){
    const env=add('station-environment');const floor=surface('#3f4a52','metal',program.seed);
    for(let x=-3;x<=3;x++)for(let z=-3;z<=2;z++)box(env,[.49,.035,.49],[x*.5,-.025,z*.5],floor,.008);
    const wall=new T.Shape();wall.moveTo(-1.5,-.05);wall.lineTo(1.5,-.05);wall.lineTo(1.5,1.85);wall.lineTo(-1.5,1.85);wall.closePath();const opening=new T.Path();opening.absarc(-.60,.55,.475,0,Math.PI*2,true);wall.holes.push(opening);mesh(env,new T.ShapeGeometry(wall),surface('#4c555b','metal',program.seed),[0,0,-.91]);
    box(env,[.48,.025,.75],[-.75,.5275,-1.38],floor,.006);const ramp=box(env,[.46,.022,.80],[-.55,.27,-.545],floor,.006);ramp.rotation.x=Math.atan2(.54,.59);
    for(const x of [-1.2,.15,1.2]){box(env,[.07,1.85,.11],[x,.90,-.84],darkMetal,.008);for(let k=0;k<8;k++)sphere(env,[.016,.016,.008],[x,k*.22+.05,-.774],iron);}
    for(let k=0;k<4;k++){rod(env,[.3,.55+k*.08,-.84],[1.4,.55+k*.08,-.84],.014,iron);}
    const door=add('airlock-door',[-.60,.55,-.80]);torus(door,.50,.045,[0,0,0],iron);const leaf=new T.Group();leaf.name='door-leaf';door.add(leaf);refs.doorLeaf=leaf;
    const doorShape=new T.Shape();doorShape.absarc(0,0,.46,0,Math.PI*2,false);const portHole=new T.Path();portHole.absarc(-.15,.15,.102,0,Math.PI*2,true);doorShape.holes.push(portHole);const disc=mesh(leaf,new T.ShapeGeometry(doorShape,48),darkMetal,[0,0,.012]);disc.material.side=T.DoubleSide;torus(leaf,.37,.008,[0,0,.023],iron);
    for(let i=0;i<12;i++){const a=i/12*Math.PI*2;sphere(leaf,[.018,.018,.018],[Math.sin(a)*.43,Math.cos(a)*.43,.04],iron);}
    const port=new T.MeshPhysicalMaterial({color:'#75adcc',metalness:.1,roughness:.12,transparent:true,opacity:.34,transmission:0});mesh(leaf,new T.CircleGeometry(.102,40),port,[-.15,.15,.035]);torus(leaf,.11,.013,[-.15,.15,.042],iron);
    const wheel=add('handwheel',[-.35,.48,-.728]);torus(wheel,.10,.013,[0,0,0],iron);for(let i=0;i<4;i++){const a=i*Math.PI/2;rod(wheel,[0,0,0],[Math.sin(a)*.095,Math.cos(a)*.095,0],.009,iron);}sphere(wheel,[.025,.025,.025],[0,0,.01],darkMetal);
    const bench=add('workbench',[.50,0,.24]);box(bench,[.72,.045,.45],[0,.42,0],surface('#696d6a','metal',program.seed),.018);for(const x of [-.29,.29])for(const z of [-.16,.16])box(bench,[.045,.42,.045],[x,.20,z],darkMetal,.008);
    for(let i=0;i<3;i++)cylinder(bench,.027,.09,[.22+i*.045,.487,-.1],iron);
    const cell=add('cell',[.60,.49,.37]);cylinder(cell,.034,.13,[0,0,0],gold).rotation.z=Math.PI/2;materials.cellGlow=surface('#ffaa39');materials.cellGlow.emissive.set('#ff9d27');materials.cellGlow.emissiveIntensity=1.3;cylinder(cell,.029,.092,[0,0,0],materials.cellGlow).rotation.z=Math.PI/2;
    const plug=add('charge-plug',[.39,.58,.26]);cylinder(plug,.018,.07,[0,0,0],iron).rotation.z=Math.PI/2;const cable=add('charge-cable');rod(cable,[0,0,0],[0,1,0],.006,black);
  }else if(shop){
    const env=add('shop-environment');for(let x=-5;x<=5;x++)box(env,[.12,.02,1.30],[x*.123,-.013,.1],wood,.002);box(env,[1.5,.9,.035],[0,.44,-.31],surface('#c1a47c','plain'));for(const x of [-.7,-.2,.5,.7])box(env,[.033,.88,.035],[x,.44,-.282],wood,.003);
    for(let i=0;i<5;i++){box(env,[.15,.025,.12],[.53,.18+i*.12,-.235],wood);for(let j=0;j<3;j++)cylinder(env,.013,.035,[.48+j*.045,.21+i*.12,-.22],surface(j===0?'#557461':j===1?'#97763d':'#b86f4b'));}
    const door=add('shop-door',[-.42,.25,-.20]);for(const x of [-.14,.14])box(door,[.03,.52,.025],[x,0,0],wood,.005);box(door,[.26,.12,.025],[0,-.20,0],wood,.005);box(door,[.26,.035,.025],[0,.242,0],wood,.005);const glass=new T.MeshPhysicalMaterial({color:'#64858b',transparent:true,opacity:.22,roughness:.16});box(door,[.25,.37,.018],[0,.045,.018],glass,.001);for(const y of [-.05,.18])rod(door,[-.145,y,.03],[.145,y,.03],.009,wood);rod(door,[0,-.20,.03],[0,.25,.03],.008,wood);sphere(door,[.017,.017,.017],[.105,-.04,.035],gold);
    const bench=add('workbench',[.17,0,.29]);box(bench,[.46,.025,.28],[0,.150,0],wood,.010);for(const x of [-.18,.18])for(const z of [-.10,.10])box(bench,[.025,.145,.025],[x,.0675,z],wood,.004);
    for(const [id,pos,size] of [['toolbox',[.34,.165,.18],[.17,.065,.10]],['cloth-box',[.015,.165,.18],[.11,.04,.09]]] as [string,V3,V3][]){const b=add(id,pos);const m=id==='toolbox'?wood:surface('#425873','cloth');const [w,h,d]=size;box(b,[w,.007,d],[0,0,0],m,.002);for(const x of [-1,1])box(b,[.007,h,d],[x*w/2,h/2,0],m,.002);for(const z of [-1,1])box(b,[w,h,.007],[0,h/2,z*d/2],m,.002);const hinge=new T.Group();hinge.name=id+'-lid';hinge.position.set(0,h,-d/2);b.add(hinge);box(hinge,[w+.008,.009,d+.006],[0,0,d/2],m,.002);refs[id+'Lid']=hinge;}
    const scissors=add('scissors',[.13,.26,.22]);for(const s of [-1,1]){const blade=new T.Group();blade.name=s===1?'scissors-a':'scissors-b';scissors.add(blade);torus(blade,.018,.004,[s*.014,0,-.055],gold).rotation.x=Math.PI/2;box(blade,[.010,.004,.095],[0,0,.023],iron,.001);refs[s===1?'scissorA':'scissorB']=blade;}
    const makeUmbrella=(id:string,color:string)=>{const g=add(id);g.scale.setScalar(.75);const m=surface(color,'cloth',program.seed);const r=.16,segments=12;for(let i=0;i<segments;i++){const a=i/segments*Math.PI*2,b=(i+1)/segments*Math.PI*2;const geom=new T.BufferGeometry();geom.setAttribute('position',new T.Float32BufferAttribute([0,.05,0,Math.cos(a)*r,0,Math.sin(a)*r,Math.cos(b)*r,0,Math.sin(b)*r],3));geom.computeVertexNormals();const panel=mesh(g,geom,m,[0,0,0],id+'-panel-'+i);panel.material.side=T.DoubleSide;refs[id+'Panel'+i]=panel;rod(g,[0,.049,0],[Math.cos(a)*r,.001,Math.sin(a)*r],.0016,iron);}rod(g,[0,-.22,0],[0,.055,0],.003,iron);torus(g,.018,.004,[.018,-.21,0],gold);return g;};
    makeUmbrella('blue-umbrella','#284b77').position.set(.39,.43,-.22);makeUmbrella('yellow-umbrella','#e6bb35').position.set(-.2,.27,.18);
    const patch=add('blue-patch');patch.scale.setScalar(.75);const pg=new T.BufferGeometry();const r=.16;pg.setAttribute('position',new T.Float32BufferAttribute([0,.05,0,r,0,0,Math.cos(Math.PI/6)*r,0,Math.sin(Math.PI/6)*r,0,.05,0,Math.cos(Math.PI/6)*r,0,Math.sin(Math.PI/6)*r,Math.cos(Math.PI/3)*r,0,Math.sin(Math.PI/3)*r],3));pg.computeVertexNormals();const pm=surface('#295a95','cloth');pm.side=T.DoubleSide;mesh(patch,pg,pm);
    const sun=add('paper-sun');mesh(sun,new T.CircleGeometry(.045,32),surface('#edb73e'));for(let i=0;i<9;i++){const a=i/9*Math.PI*2;const tri=mesh(sun,new T.ConeGeometry(.014,.027,3),surface('#edb73e'),[Math.sin(a)*.056,Math.cos(a)*.056,0]);tri.rotation.z=-a;}
    box(env,[.17,.033,.10],[-.38,.016,-.12],wood,.004);
    const lamp=add('shop-lamp',[-.24,.52,-.17]);rod(lamp,[0,0,0],[0,-.055,0],.003,gold);materials.lamp=surface('#f2d091');materials.lamp.emissive.set('#ffbb58');sphere(lamp,[.028,.018,.028],[0,-.061,0],materials.lamp);const l=new T.PointLight('#ffbd60',.2,.8,2);l.position.set(0,-.06,0);lamp.add(l);lights.shopLamp=l;rod(lamp,[0,-.05,.05],[0,-.22,.05],.0015,gold);sphere(lamp,[.007,.010,.007],[0,-.22,.05],gold);
    const rainGeo=new T.BufferGeometry(),rains=new Float32Array(240*3);for(let i=0;i<240;i++)rains.set([(noise(program.seed,i)-.5)*1.4,noise(program.seed+9,i)*1.1,-.36-noise(program.seed+7,i)*.35],i*3);rainGeo.setAttribute('position',new T.BufferAttribute(rains,3));const rain=new T.Points(rainGeo,new T.PointsMaterial({color:'#adcadc',size:.003,transparent:true,opacity:.6}));scene.add(rain);world.rain=rain;
  }else{
    const env=add('forest-environment');const soil=surface('#413426','wood',program.seed);box(env,[1.445,.40,3],[-.7775,-.20,0],soil,.008);box(env,[1.40,.40,3],[.80,-.20,0],soil,.008);box(env,[.155,.03,3],[.0225,-.445,0],surface('#0d1215'),.001);
    const pit=mesh(env,new T.CircleGeometry(.025,32),surface('#11110e'),[.485,.001,-.23]);pit.rotation.x=-Math.PI/2;torus(env,.025,.002,[.485,.002,-.23],soil).rotation.x=Math.PI/2;
    const bark=surface('#513e2e','wood',program.seed),moss=surface('#465343','cloth',program.seed);
    for(let i=0;i<30;i++){const x=(noise(program.seed,i)-.5)*3,z=-.5-noise(program.seed+4,i)*1.6;if(Math.abs(x-.5)<.2||(x>-.055&&x<.10))continue;const h=.7+noise(program.seed+1,i)*1.2;rod(env,[x,0,z],[x+.04,h,z],.032+noise(program.seed+2,i)*.018,bark);for(const side of [-1,1])rod(env,[x,h*.55,z],[x+side*.20,h*.77,z+.02],.010,bark);}
    for(let i=0;i<100;i++){const x=(noise(program.seed+3,i)-.5)*2.4,z=(noise(program.seed+12,i)-.5)*1.6;if(x>-.055&&x<.10)continue;const o=sphere(env,[.015+noise(program.seed,i)*.018,.009,.02],[x,-.006,z],i%3?moss:bark);o.rotation.y=noise(program.seed+17,i)*Math.PI;}
    const tree=add('old-tree',[.55,0,-.32]);rod(tree,[0,0,0],[-.10,.58,0],.075,bark);rod(tree,[-.10,.58,0],[-.28,.90,.015],.04,bark);for(const [a,b] of [[[-.10,.40,0],[.30,.67,0]],[[-.22,.77,0],[-.55,.88,.03]],[[.10,.53,0],[.29,.83,-.05]]] as [V3,V3][])rod(tree,a,b,.017,bark);
    for(let i=0;i<7;i++){const a=i/7*Math.PI*2;rod(tree,[0,.07,0],[Math.cos(a)*.24,.01,Math.sin(a)*.22],.020,bark);}
    const bridge=add('bridge');for(let i=-5;i<=5;i++){if(i===0||i===1)continue;const plank=box(bridge,[.061,.016,.20],[i*.065-.005,.038,0],wood,.005,`plank-${i}`);if(i===-1)refs.testPlank=plank;}for(const z of [-.11,.11]){rod(bridge,[-.34,.025,z],[-.075,.025,z],.011,bark);rod(bridge,[.125,.025,z],[.34,.025,z],.011,bark);}
    const lantern=add('lantern');cylinder(lantern,.035,.007,[0,0,0],gold);torus(lantern,.026,.003,[0,.076,0],gold).rotation.x=Math.PI/2;const glass=new T.MeshPhysicalMaterial({color:'#f4e9c9',transparent:true,opacity:.20,roughness:.06,metalness:.05,depthWrite:false});sphere(lantern,[.032,.039,.032],[0,.04,0],glass);torus(lantern,.025,.003,[0,.108,0],gold);for(const s of [-1,1])rod(lantern,[s*.03,.005,0],[s*.023,.073,0],.002,gold);
    const lid=new T.Group();lid.name='lantern-lid';lantern.add(lid);cylinder(lid,.031,.008,[0,.083,0],gold);refs.lanternLid=lid;
    for(const id of ['light-seed','new-seed']){const g=add(id),m=surface('#f9d680');m.emissive.set('#ffc457');m.emissiveIntensity=1.8;materials[id]=m;sphere(g,[.011,.016,.011],[0,0,0],m);torus(g,.007,.001,[0,0,.010],gold);const light=new T.PointLight('#ffbf62',.055,.35,2);g.add(light);lights[id]=light;}
    const glow=add('root-glow');materials.rootGlow=surface('#d1cf7b');materials.rootGlow.emissive.set('#c9e18b');materials.rootGlow.emissiveIntensity=2;
    for(let i=0;i<35;i++){const a=i*.91,r=.07+i*.015;const orb=sphere(glow,[.004,.004,.004],[.55+Math.cos(a)*r,.016+Math.max(0,i-22)*.012,-.32+Math.sin(a)*r],materials.rootGlow,`growth-${i}`);refs[`growth-${i}`]=orb;}
    for(let i=0;i<12;i++){const a=i*.55;const root=rod(glow,[.50,.012,-.22],[.55+Math.cos(a)*.35,.014,-.32+Math.sin(a)*.35],.002,materials.rootGlow,`root-${i}`);refs[`root-${i}`]=root;}
  }
  for(const [id,g]of entities)identify(g,id);
  return world;
}
