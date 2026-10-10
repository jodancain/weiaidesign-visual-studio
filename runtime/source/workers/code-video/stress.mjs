/** Trusted operator acceptance harness. This is not a public generation endpoint. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { renderPngs, encodeClean, mediaEvidence, sha256, runtimeHash } from './render.mjs';
const dir=resolve(process.argv[2]),input=JSON.parse(await readFile(join(dir,'stress-input.json'),'utf8'));
const version=await runtimeHash(),results=[];
for(const item of input.films){
  for(const backend of ['three-webgl','remotion']){
    const spec={...item.spec,backend,runtimeHash:version};
    const out=join(dir,item.film,backend);await mkdir(out,{recursive:true});
    const frames=Array.from({length:144},(_,i)=>item.startFrame+i);
    console.log(JSON.stringify({film:item.film,backend,status:'started',runtimeHash:version}));
    const rendered=await renderPngs({spec,dir:out,frames});
    const encoded=await encodeClean({dir:out,spec,startFrame:item.startFrame,count:144});
    const media=await mediaEvidence(encoded.path);
    if(media.frames!==144||media.fps!=='24/1'||media.width!==1280||media.height!==720||media.videoDuration!==6)throw Error('Stress-shot media contract failed');
    const result={film:item.film,backend,receipt:rendered.receipt,media,encodingMs:encoded.encodingMs,frameStart:item.startFrame};results.push(result);
    await writeFile(join(dir,'stress-results.json'),JSON.stringify({runtimeHash:version,results},null,2));
    console.log(JSON.stringify({film:item.film,backend,status:'complete',frames:media.frames,gpu:rendered.receipt.gpu,seconds:rendered.receipt.timings.totalRenderMs/1000}));
  }
}
