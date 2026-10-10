import { readFileSync } from 'node:fs';
import { fail, StudioError } from './domain.mjs';
export function validateSchema(value,schema,path='$'){
  const reject=reason=>{throw new StudioError(`${path}: ${reason}`,422,'invalid_scene_program');};
  if(schema.const!==undefined&&JSON.stringify(value)!==JSON.stringify(schema.const))reject(`must equal ${JSON.stringify(schema.const)}`);
  if(schema.enum&&!schema.enum.some(v=>JSON.stringify(v)===JSON.stringify(value)))reject('value is not in the allowed enum');
  const type=schema.type;
  if(type==='object'){
    if(!value||typeof value!=='object'||Array.isArray(value))reject('expected object');
    for(const key of schema.required||[])if(!Object.hasOwn(value,key))reject(`missing ${key}`);
    for(const [key,child] of Object.entries(value)){if(!schema.properties?.[key]){if(schema.additionalProperties===false)reject(`unsupported field ${key}`);}else validateSchema(child,schema.properties[key],`${path}.${key}`);}
  }else if(type==='array'){
    if(!Array.isArray(value))reject('expected array');if(value.length<(schema.minItems??0)||value.length>(schema.maxItems??10000))reject('array length');
    if(schema.uniqueItems&&new Set(value.map(JSON.stringify)).size!==value.length)reject('duplicate items');value.forEach((v,i)=>validateSchema(v,schema.items||{},`${path}[${i}]`));
  }else if(type==='string'){
    if(typeof value!=='string'||value.length<(schema.minLength??0)||value.length>(schema.maxLength??20000))reject('string length/type');if(schema.pattern&&!new RegExp(schema.pattern).test(value))reject('string pattern');
  }else if(type==='number'||type==='integer'){
    if(typeof value!=='number'||!Number.isFinite(value)||(type==='integer'&&!Number.isSafeInteger(value))||value<(schema.minimum??-Infinity)||value>(schema.maximum??Infinity))reject('number range/type');
  }else if(type==='boolean'&&typeof value!=='boolean')reject('expected boolean');
  if(schema.allOf)for(const rule of schema.allOf)validateSchema(value,rule,path);
  return value;
}
export function sceneSchema(){return JSON.parse(readFileSync(new URL('./code-scene-schema.json',import.meta.url),'utf8'));}
export function engineeringBaseline(film){fail(['three-knocks','borrow-sunshine','last-seed-of-light'].includes(film),'unsupported scene template',422);return JSON.parse(readFileSync(new URL(`./code-scene-baselines/${film}-engineering-baseline.json`,import.meta.url),'utf8'));}
export function validateSceneProgram(value){
  const schema=sceneSchema();validateSchema(value,schema);
  const actors=value.film==='three-knocks'?['ashuan','scout']:value.film==='borrow-sunshine'?['bear','mouse']:['fox'];
  value.shots.forEach((shot,i)=>{
    fail(shot.id===`s${String(i+1).padStart(2,'0')}`&&shot.startFrame===i*144&&shot.endFrame===(i+1)*144,'scene shots must have ordered IDs and contiguous 144-frame ranges',422,'invalid_scene_program');
    fail(shot.action.kind===schema['x-film-actions'][value.film][i],'action order does not match selected film',422,'invalid_scene_program');
    fail(shot.action.startFrame<shot.action.endFrame,'action interval is invalid',422,'invalid_scene_program');
    fail(!shot.camera.position.every((n,j)=>n===shot.camera.target[j])&&!shot.camera.positionEnd.every((n,j)=>n===shot.camera.targetEnd[j]),'camera position equals target',422,'invalid_scene_program');
    if(shot.action.beatFrames)fail(shot.action.beatFrames.every((n,j,a)=>n>=shot.action.startFrame&&n<=shot.action.endFrame&&(!j||n>a[j-1])),'action beats must increase within action interval',422,'invalid_scene_program');
    fail(!shot.blocking?.length,'contact anchors are fixed; blocking overrides are not supported in this version',422,'invalid_scene_program');
    if(shot.blocking)fail(shot.blocking.length<=actors.length&&new Set(shot.blocking.map(b=>b.id)).size===shot.blocking.length&&shot.blocking.every(b=>actors.includes(b.id)),'invalid blocking actors',422,'invalid_scene_program');
  });return value;
}

export const codeSceneRegistry=JSON.parse(readFileSync(new URL('./code-scene-registry.json',import.meta.url),'utf8'));
