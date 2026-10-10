import { readFile, writeFile, stat, mkdir, copyFile } from 'node:fs/promises';
import { join, basename, resolve } from 'node:path';
import { renderPngs, encodeClean, finishFilm, fileHash, mediaEvidence } from './render.mjs';
import { applyEffects } from './effects.mjs';
import { enhance } from './enhance.mjs';
import { atomicJSON, durableReadFile, durableRename, throttledProgress } from './durable-io.mjs';
const dir=resolve(process.argv[2]),file=join(dir,'job.json');
let state=JSON.parse(await durableReadFile(file,'utf8'));
const abort=new AbortController();
let writing=Promise.resolve();
function update(patch) {
  writing=writing.then(async()=>{const current=JSON.parse(await durableReadFile(file,'utf8'));if(current.status==='cancelled'||await stat(join(dir,'cancelled.marker')).then(()=>true,()=>false)){abort.abort();throw Error('Job cancelled');}const next={...current,...patch,updatedAt:new Date().toISOString()};await atomicJSON(file,next);state=next;});return writing;
}
async function output(path,role,metadata={}) {
  const name=basename(path),info=await stat(path);
  const out={name,role,mime:path.endsWith('.mp4')?'video/mp4':'application/json',sha256:await fileHash(path),bytes:info.size,url:`/api/v3/code/media/${state.jobRef}/${name}`,...metadata};
  await update({outputs:[...state.outputs.filter(o=>o.name!==name),out]});return out;
}
function published(name){return state.outputs.find(o=>o.name===name);}
async function shot(start,count){const name=`shot-${start}-${start+count}.mp4`;if(published(name))return;const p=await encodeClean({dir,spec:state.spec,startFrame:start,count,shotOnly:true,signal:abort.signal});await output(p.path,'shot',{frameStart:start,frameEnd:start+count});}
const timer=setInterval(async()=>{try{const s=JSON.parse(await durableReadFile(file,'utf8'));if(s.status==='cancelled'||await stat(join(dir,'cancelled.marker')).then(()=>true,()=>false))abort.abort();}catch{}},500).unref();
try {
  for(const a of state.assets)if(await fileHash(a.path)!==a.hash)throw Error('Input asset changed since acceptance');
  for(const o of state.outputs)if(await fileHash(join(dir,o.name))!==o.sha256)throw Error('Previously published output changed; restore it before resuming');
  const spec=state.spec;
  await update({stage:'loading',progress:.01});
  if(state.kind==='render') {
    spec.browserAssets=state.assets.map(a=>({id:a.id,mime:a.mime,url:`data:${a.mime};base64,${''}`}));
    for(let i=0;i<state.assets.length;i++)if(/gltf/.test(state.assets[i].mime))spec.browserAssets[i].url+= (await readFile(state.assets[i].path)).toString('base64');
    const {receipt}=await renderPngs({spec,dir,signal:abort.signal,
      progress:throttledProgress(p=>update({stage:p.stage,progress:.02+.73*p.completedFrames/p.totalFrames,frame:p.frame})),
      onShot:shot,
    });
    for(let start=0;start<spec.totalFrames;start+=144)await shot(start,Math.min(144,spec.totalFrames-start));
    await update({stage:'encoding',progress:.78});
    const clean=published('clean.mp4')?{path:join(dir,'clean.mp4'),encodingMs:0}:await encodeClean({dir,spec,signal:abort.signal});if(!published('clean.mp4'))await output(clean.path,'clean');
    await update({stage:'compositing',progress:.88});
    const film=published('base.mp4')?{path:join(dir,'base.mp4'),compositingMs:0}:await finishFilm({cleanPath:clean.path,dir,spec,assets:state.assets});
    const media=await mediaEvidence(film.path);
    if(media.frames!==spec.totalFrames||media.fps!=='24/1')throw Error('Final render frame contract failed');
    receipt.timings.encodingMs=clean.encodingMs;receipt.timings.compositingMs=film.compositingMs;receipt.media=media;
    await writeFile(join(dir,'render-receipt.json'),JSON.stringify(receipt,null,2));
    await output(film.path,'base');
    await update({status:'complete',stage:'complete',progress:1,receipt,finishedAt:new Date().toISOString()});
  } else if(state.kind==='enhancement') {
    const attempt=join(dir,`enhancement-attempt-${state.retries.length}`);await mkdir(attempt,{recursive:true});
    const result=await enhance({spec,assets:state.assets,dir:attempt,signal:abort.signal,progress:update});
    for(const [path,role]of [[result.enhanced,'enhanced'],[result.comparison,'comparison']]){const target=join(dir,basename(path));if(!published(basename(path))){await copyFile(path,target+'.part');await durableRename(target+'.part',target);await output(target,role);}}
    await update({status:'complete',stage:'complete',progress:1,receipt:result.receipt,finishedAt:new Date().toISOString()});
  } else if(state.kind==='effects-render') {
    const result=await applyEffects({spec,assets:state.assets,dir,signal:abort.signal,progress:throttledProgress(update)});
    await output(result.effects,'effects');await output(result.comparison,'comparison');
    await update({status:'complete',stage:'complete',progress:1,receipt:result.receipt,finishedAt:new Date().toISOString()});
  } else throw Error('Unsupported job kind');
} catch(error) {
  writing=Promise.resolve();
  try {const current=JSON.parse(await durableReadFile(file,'utf8'));if(current.status!=='cancelled')await update({status:'failed',stage:'failed',error:String(error.message).slice(0,5000)});}catch{}
  console.error(error.stack||String(error));process.exitCode=1;
} finally {clearInterval(timer);}
