import { createHash } from 'node:crypto';
/** Closed, executable-data-only contract. Frames are absolute; endFrame is exclusive. */
export const EFFECTS_TYPES = Object.freeze(['glow','particles','rain','fog','ring','light-trail','vignette']);
const number=(minimum,maximum)=>({type:'number',minimum,maximum});
const integer=(minimum,maximum)=>({type:'integer',minimum,maximum});
const closed=(properties,required=Object.keys(properties))=>({type:'object',additionalProperties:false,properties,required});
const point=closed({frame:integer(0,43199),x:number(0,1),y:number(0,1),scale:number(.05,4),opacity:number(0,1)});
const PARAMS={
 glow:closed({radius:number(.005,1),softness:number(.05,1),pulseHz:number(0,6)}),
 particles:closed({count:integer(1,256),size:number(.0005,.03),spread:number(.01,1),speedX:number(-1,1),speedY:number(-1,1),lifeFrames:integer(2,1440)}),
 rain:closed({count:integer(1,256),length:number(.005,.2),width:number(.0003,.01),speed:number(.01,2),angle:number(-1.2,1.2)}),
 fog:closed({count:integer(1,32),radius:number(.02,.5),speedX:number(-.2,.2),speedY:number(-.2,.2)}),
 ring:closed({radius:number(.005,1),width:number(.0005,.05),periodFrames:integer(2,1440)}),
 'light-trail':closed({width:number(.0005,.05),trailFrames:integer(1,240),segments:integer(2,64)}),
 vignette:closed({radius:number(.1,1.5),softness:number(.05,1)}),
};
export const EFFECTS_PROGRAM_SCHEMA=closed({
 schemaVersion:{const:1},fps:{const:24},totalFrames:integer(1,43200),width:integer(16,2560),height:integer(16,2560),seed:integer(0,4294967295),
 subtitleProtection:closed({enabled:{const:true},bottomFraction:number(.16,.5),paddingPx:integer(8,128)}),
 layers:{type:'array',minItems:1,maxItems:32,items:{oneOf:EFFECTS_TYPES.map(type=>closed({id:{type:'string',pattern:'^[a-zA-Z0-9_-]{1,64}$'},type:{const:type},description:{type:'string',maxLength:300},startFrame:integer(0,43199),endFrame:integer(1,43200),color:{type:'string',pattern:'^#[0-9a-fA-F]{6}$'},opacity:number(0,1),keyframes:{type:'array',minItems:1,maxItems:128,items:point},parameters:PARAMS[type]}))}},
});
export function effectsSchema(){return structuredClone(EFFECTS_PROGRAM_SCHEMA);}
function check(value,schema,path){
 if(schema.oneOf){const valid=schema.oneOf.filter(s=>{try{check(value,s,path);return true;}catch{return false;}});if(valid.length!==1)throw Error(`${path}: unsupported effect or invalid parameters`);return;}
 if('const'in schema&&value!==schema.const)throw Error(`${path}: expected ${JSON.stringify(schema.const)}`);
 if(schema.type==='object'){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype)throw Error(`${path}: expected plain object`);
  for(const k of Object.keys(value))if(!Object.hasOwn(schema.properties,k))throw Error(`${path}.${k}: unknown field`);
  for(const k of schema.required||[])if(!Object.hasOwn(value,k))throw Error(`${path}.${k}: required`);
  for(const[k,v]of Object.entries(value))check(v,schema.properties[k],`${path}.${k}`);
 }else if(schema.type==='array'){
  if(!Array.isArray(value)||value.length<(schema.minItems||0)||value.length>schema.maxItems)throw Error(`${path}: invalid array length`);
  value.forEach((v,i)=>check(v,schema.items,`${path}[${i}]`));
 }else if(schema.type==='number'||schema.type==='integer'){
  if(typeof value!=='number'||!Number.isFinite(value)||(schema.type==='integer'&&!Number.isSafeInteger(value))||value<schema.minimum||value>schema.maximum)throw Error(`${path}: invalid bounded number`);
 }else if(schema.type==='string'){
  if(typeof value!=='string'||value.length>(schema.maxLength??Infinity)||(schema.pattern&&!new RegExp(schema.pattern).test(value)))throw Error(`${path}: invalid string`);
 }
}
export function validateEffectsProgram(program,{source}={}){
 check(program,EFFECTS_PROGRAM_SCHEMA,'effectsProgram');
 if(program.width%2||program.height%2||program.width*program.height>2560*1440)throw Error('effectsProgram: dimensions must be even and at most 3.7 megapixels');
 if(source)for(const k of ['fps','totalFrames','width','height']){const expected=k==='totalFrames'?(source.totalFrames??source.frames):source[k];if(expected!==undefined&&expected!==program[k])throw Error(`effectsProgram.${k}: frozen source mismatch`);}
 const ids=new Set();let particles=0;
 for(const layer of program.layers){
  if(ids.has(layer.id))throw Error('effectsProgram: duplicate layer id');ids.add(layer.id);
  if(layer.startFrame>=layer.endFrame||layer.endFrame>program.totalFrames)throw Error(`layer ${layer.id}: frame range outside source`);
  let previous=-1;for(const key of layer.keyframes){if(key.frame<=previous||key.frame<layer.startFrame||key.frame>=layer.endFrame)throw Error(`layer ${layer.id}: keyframes must be strictly increasing inside layer range`);previous=key.frame;}
  particles+=layer.parameters.count||0;
 }
 if(!program.layers.some(layer=>layer.opacity>0&&layer.keyframes.some(k=>k.opacity>0)))throw Error('effectsProgram: at least one visible effect layer is required');
 if(particles>1024)throw Error('effectsProgram: total particle/blob budget exceeds 1024');
 return structuredClone(program);
}
export const EFFECTS_PROGRAM_PROMPT='Return only EffectsProgram JSON matching the supplied schema. Absolute integer frames, start inclusive/end exclusive; all positions and radii normalized to image dimensions. Layers are source-over transparent Canvas2D graphics, not source-aware bloom or tracked 3D effects. No code, URLs, plugins, new media, narration, automatic NR, source substitution, segmentation or optical tracking. Use sparse restrained effects, explicit position keyframes and deterministic seed. Keep bottom 16% plus at least 8 pixels protected because subtitles are already burned into the selected MP4. Describe each effect in description. Preserve source fps, totalFrames, width and height exactly. Each keyframe requires frame,x,y,scale,opacity; missing leading/trailing keys hold the nearest key. Maximum 32 layers and 1024 total particles/blobs.';

export function canonicalEffectsJSON(value){if(Array.isArray(value))return '['+value.map(canonicalEffectsJSON).join(',')+']';if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonicalEffectsJSON(value[key])).join(',')+'}';return JSON.stringify(value);}
export function effectsProgramHash(program){return createHash('sha256').update(canonicalEffectsJSON(program)).digest('hex');}
