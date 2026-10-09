import { ACTIONS, type FilmId, type SceneProgram, type V3 } from './schema';
/** Deterministic engineering baseline, NOT an LLM-authored artifact. */
export function makeTemplateProgram(film: FilmId): SceneProgram {
  const camera: Array<[V3,V3,number]> = film === 'three-knocks' ? [
    [[1.6,1.05,2.0],[0,.43,-.18],35],[[1,.80,1.5],[-.36,.42,-.48],42],[[-1.05,.78,.20],[-.33,.46,-.64],55],[[-1.05,.78,.20],[-.33,.46,-.64],65],
    [[-.36,.90,-.18],[-.79,.65,-.91],50],[[-1.05,.78,.20],[-.33,.46,-.64],35],[[.45,.38,.56],[-.44,.22,-.45],48],
    [[-.95,.36,.06],[-.69,.17,-.31],55],[[.48,1.30,.42],[.48,.57,.27],40],[[1.4,1.10,1.85],[.34,.43,.12],38],
  ] : film === 'borrow-sunshine' ? [
    [[.70,.55,1.0],[.07,.23,.12],45],[[.30,.34,.82],[-.12,.17,.12],45],[[.28,.51,.52],[.015,.21,.19],45],[[.62,.40,.59],[.19,.29,-.02],55],
    [[.32,.61,.62],[.115,.215,.23],45],[[.43,.42,.85],[-.09,.19,.16],45],[[.82,.56,1.15],[-.08,.23,.01],38],
    [[-.02,.35,.43],[-.38,.24,-.085],58],[[.39,.38,.82],[-.11,.20,.065],48],[[.1,.56,1.28],[-.14,.24,.05],40],
  ] : [
    [[.62,.47,1.02],[-.19,.14,.37],38],[[-.035,.28,.73],[-.16,.15,.39],45],[[.70,.53,1.10],[.14,.32,-.16],35],[[.31,.36,.56],[-.16,.15,.12],45],
    [[.52,.30,.66],[0,.14,0],45],[[.45,.32,.70],[.015,.21,0],32],[[.75,.35,.15],[.47,.13,-.22],62],[[.49,.50,-.12],[.485,.055,-.23],40],
    [[1.1,.78,1.25],[.45,.40,-.30],32],[[.99,.52,.61],[.54,.20,-.24],50],
  ];
  return {schemaVersion:1,id:`code-${film}`,title:({'three-knocks':'三下敲门','borrow-sunshine':'借你一块晴天','last-seed-of-light':'最后一粒光'})[film],film,fps:24,width:1280,height:720,totalFrames:1440,seed:20261002,look:{exposure:film==='three-knocks'?1.05:1,keyIntensity:film==='three-knocks'?2.4:3,fillIntensity:film==='last-seed-of-light'?.28:.55},shots:camera.map(([position,target,lensMm],i)=>({id:`s${String(i+1).padStart(2,'0')}`,startFrame:i*144,endFrame:(i+1)*144,camera:{position,positionEnd:position.map((v,j)=>target[j]+(v-target[j])*(i===9?1.12:.96)) as V3,target,targetEnd:[...target],lensMm},action:{kind:ACTIONS[film][i],startFrame:12,endFrame:130,...(film==='three-knocks'&&[2,9].includes(i)?{beatFrames:[40,65,90]}:{})}}))};
}
