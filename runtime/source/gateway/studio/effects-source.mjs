import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { digest, fail, clone } from './domain.mjs';

const exec=promisify(execFile);
const hashPattern=/^[a-f0-9]{64}$/;
const shotContext=({id,name,prompt,startFrame,endFrame,dialogue,overlay}={})=>({id,name,prompt,startFrame,endFrame,dialogue,overlay});

// Never infer provenance from asset.source, parentId or metadata: uploads can
// supply all three. Only completed server jobs and private copy/import receipts
// establish ancestry. A resolver is request-scoped; GET does not read media bytes.
function sourceResolver(store){
  const jobsByProject=new Map(),resolved=new Map(),visiting=new Set();
  function outputJob(a){
    if(!jobsByProject.has(a.projectId)){
      const outputs=new Map();
      for(const job of store.listJobs(a.projectId).filter(j=>j.state==='complete')){
        if(job.outputAssetId)outputs.set(job.outputAssetId,{job});
        for(const output of job.partialAssets||[])outputs.set(output.id,{job,output});
      }
      jobsByProject.set(a.projectId,outputs);
    }
    const bound=jobsByProject.get(a.projectId).get(a.asset.id);
    fail(bound&&(!bound.output||bound.output.hash===a.asset.hash),'source is not a verified completed video output',422);
    return {...store.job(bound.job.id),output:bound.output};
  }
  function trace(id,depth=0){
    fail(depth<24&&!visiting.has(id),'invalid effects source lineage',409);
    if(resolved.has(id))return resolved.get(id);
    visiting.add(id);
    try{
      const a=store.getAsset(id);fail(a.asset.kind==='video','effects lineage must reference video assets',422);
      const origin=store.db.prepare('SELECT source_asset_id FROM asset_origins WHERE asset_id=?').get(id);
      if(origin){
        const original=store.getAsset(origin.source_asset_id);fail(original.asset.hash===a.asset.hash,'copied source identity changed',409);
        const result=trace(origin.source_asset_id,depth+1);resolved.set(id,result);return result;
      }
      const r=outputJob(a),jobId=r.job.id,input=r.private.input;
      const root=(rootKind,context,extra={})=>({kind:rootKind,rootKind,provenance:{rootJobId:jobId,rootAssetId:id,...extra},context});
      const parent=(parentId,parentHash)=>{
        const p=store.getAsset(parentId);fail(p.projectId===a.projectId,'cross-project source lineage',409);
        fail(hashPattern.test(parentHash)&&p.asset.hash===parentHash,'source lineage hash changed',409);
        return trace(parentId,depth+1);
      };
      let result;
      if(r.job.kind==='generation'){
        fail(r.job.outputAssetId===id&&input.shot,'invalid provider output receipt',422);
        result=root('ai-original',{shots:[shotContext(input.shot)]},{model:r.job.output?.model||null});
      }else if(r.job.kind==='render'){
        fail(r.output?.role==='base'&&input.spec?.sceneProgram,'source is not a completed code film',422);
        const spec=input.spec;result=root('code-animation',{sceneProgram:spec.sceneProgram,sceneSnapshot:spec.sceneSnapshot,sequence:spec.sequence},{sceneSnapshotHash:spec.sceneSnapshotHash,renderProfileHash:spec.renderProfileHash});
      }else if(r.job.kind==='export'){
        const p=input.project,clips=p?.sequence?.clips?.filter(c=>c.kind==='video')||[];
        fail(r.job.outputAssetId===id&&p?.id===a.projectId&&clips.length,'invalid export source receipt',422);
        const sources=[...new Set(clips.map(c=>c.assetId))].map(assetId=>{
          const frozen=p.assets.find(v=>v.id===assetId);fail(frozen?.kind==='video','export source snapshot is missing',409);
          return parent(assetId,frozen.hash);
        });
        const kinds=new Set(sources.map(v=>v.rootKind));fail(kinds.size===1,'mixed AI and code exports need separate effects sources',422);
        const rootKind=sources[0].rootKind;
        result={...root(rootKind,{shots:(p.shots||[]).map(shotContext),sequence:p.sequence},{sourceRoots:sources.map(v=>({jobId:v.provenance.rootJobId,assetId:v.provenance.rootAssetId,rootKind:v.rootKind}))}),kind:sources.some(v=>v.kind==='derived')?'derived':rootKind};
      }else if(r.job.kind==='trusted-media-import'){
        const proof=input.proof;
        fail(r.job.outputAssetId===id&&proof?.schemaVersion===1&&proof.transform==='audio-remix'&&proof.outputHash===a.asset.hash&&hashPattern.test(proof.sourceVideoPacketHash)&&proof.sourceVideoPacketHash===proof.outputVideoPacketHash&&hashPattern.test(proof.sourceVideoTimelineHash)&&proof.sourceVideoTimelineHash===proof.outputVideoTimelineHash&&hashPattern.test(proof.evidenceHash),'invalid trusted media import receipt',422);
        const source=parent(proof.sourceAssetId,proof.sourceHash);
        result={...source,provenance:{...source.provenance,importJobId:jobId,importAssetId:id,transform:proof.transform,evidenceHash:proof.evidenceHash}};
      }else{
        fail(['enhancement','effects-render'].includes(r.job.kind)&&r.output?.role===(r.job.kind==='enhancement'?'enhanced':'effects'),'unsupported effects source lineage',422);
        const source=parent(input.spec?.sourceAssetId,input.spec?.sourceHash);
        result={...source,kind:'derived'};
      }
      result.provenance={...result.provenance,sourceKind:result.kind,rootKind:result.rootKind};
      resolved.set(id,result);return result;
    }finally{visiting.delete(id);}
  }
  return trace;
}

export function effectsSource(store,projectId,assetId,sourceHash){
  const selected=store.getAsset(assetId);fail(selected.projectId===projectId&&selected.asset.kind==='video','effects source must belong to this project',404);
  fail(selected.asset.hash===sourceHash&&digest(readFileSync(selected.path))===sourceHash,'effects source hash changed',409);
  const source=sourceResolver(store)(assetId);
  return {asset:selected.asset,path:selected.path,provenance:clone(source.provenance),context:clone(source.context)};
}

export function projectEffectsSources(store,project){
  const resolve=sourceResolver(store);
  return {...project,assets:project.assets.map(asset=>{
    const {effectsSource:_untrusted,...clean}=asset;
    if(asset.kind!=='video')return clean;
    try{const actual=store.getAsset(asset.id);fail(actual.projectId===project.id&&actual.asset.hash===asset.hash,'asset identity changed',409);const source=resolve(asset.id);return {...clean,effectsSource:{kind:source.kind,rootKind:source.rootKind,sourceHash:asset.hash}};}catch{return clean;}
  })};
}

export function stripEffectsSources(project){
  return project&&Array.isArray(project.assets)?{...project,assets:project.assets.map(({effectsSource:_derived,...asset})=>asset)}:project;
}

export async function extractEffectsFrames(path,source,{ffmpegPath='ffmpeg'}={}){
  const indices=[...new Set(Array.from({length:Math.min(6,source.totalFrames)},(_,i)=>Math.round(i*(source.totalFrames-1)/Math.max(1,Math.min(6,source.totalFrames)-1))))];
  const result=[];
  for(const frame of indices){
    const {stdout}=await exec(ffmpegPath,['-v','error','-threads','1','-i',path,'-vf',`select=eq(n\\,${frame}),scale=640:360:force_original_aspect_ratio=decrease`,'-frames:v','1','-an','-threads','1','-f','image2pipe','-vcodec','mjpeg','pipe:1'],{encoding:'buffer',timeout:60000,maxBuffer:1024*1024});
    fail(stdout.length>0&&stdout.length<=1024*1024,'source frame extraction failed',422);result.push({frame,mime:'image/jpeg',hash:digest(stdout),base64:stdout.toString('base64')});
  }
  return result;
}
