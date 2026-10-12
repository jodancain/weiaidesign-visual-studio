import {randomUUID,createHash} from 'node:crypto';
import {decodeRGBA,decodeTargetRGBA,encodePNG,baseInput,processingError} from './processors.mjs';
import {requestOCR,runComfy} from './providers.mjs';
import {createFontCandidateFitter} from './font-candidates.mjs';

/** Partition visible source pixels; no completion, typography synthesis or background invention. */
export function connectedRegions(raw,owners,{minArea=24,maxRegions=64}={}){
  const n=raw.width*raw.height,visited=new Uint8Array(n),queue=new Uint32Array(n),found=[];
  const key=i=>((raw.data[i*4]>>5)<<6)|((raw.data[i*4+1]>>5)<<3)|(raw.data[i*4+2]>>5);
  const counts=new Map();for(let i=0;i<n;i++)if(!owners[i])counts.set(key(i),(counts.get(key(i))||0)+1);
  const background=[...counts.entries()].sort((a,b)=>b[1]-a[1])[0]?.[0];
  for(let start=0;start<n;start++){
    if(visited[start]||owners[start]||raw.data[start*4+3]===0)continue;
    const color=key(start);let head=0,tail=1;queue[0]=start;visited[start]=1;
    while(head<tail){
      const i=queue[head++],x=i%raw.width,y=Math.floor(i/raw.width);
      for(const j of [x?i-1:-1,x<raw.width-1?i+1:-1,y?i-raw.width:-1,y<raw.height-1?i+raw.width:-1]){
        if(j<0||visited[j]||owners[j]||raw.data[j*4+3]===0||key(j)!==color)continue;
        visited[j]=1;queue[tail++]=j;
      }
    }
    if(color!==background&&tail>=minArea){
      found.push({pixels:Uint32Array.from(queue.subarray(0,tail)),area:tail});
      // Retain only largest candidates, so noisy photos cannot allocate unlimited arrays.
      if(found.length>maxRegions*2)found.sort((a,b)=>b.area-a.area).splice(maxRegions);
    }
  }
  return found.sort((a,b)=>b.area-a.area).slice(0,maxRegions);
}
export function partitionToPatches(raw,owners,regions){
  const bounds=regions.map(()=>({x0:raw.width,y0:raw.height,x1:-1,y1:-1,area:0}));
  for(let i=0;i<owners.length;i++){
    const b=bounds[owners[i]],x=i%raw.width,y=Math.floor(i/raw.width);
    if(!b)throw processingError('Invalid pixel ownership','RESTORE_COVERAGE');
    b.x0=Math.min(b.x0,x);b.y0=Math.min(b.y0,y);b.x1=Math.max(b.x1,x);b.y1=Math.max(b.y1,y);b.area++;
  }
  const patches=[];let allocatedPixels=0;
  for(let id=0;id<regions.length;id++){
    const b=bounds[id];if(!b.area)continue;
    const width=b.x1-b.x0+1,height=b.y1-b.y0+1;allocatedPixels+=width*height;
    if(allocatedPixels>Math.max(40000000,owners.length*4))throw processingError('Layer patch allocation exceeds budget','RESTORE_PATCH_BUDGET');
    const data=Buffer.alloc(width*height*4),mask=Buffer.alloc(data.length);
    for(let i=3;i<mask.length;i+=4)mask[i]=255;
    patches.push({id,region:regions[id],x:b.x0,y:b.y0,width,height,area:b.area,data,mask});
  }
  const byId=new Map(patches.map(p=>[p.id,p]));
  for(let i=0;i<owners.length;i++){
    const p=byId.get(owners[i]),x=i%raw.width,y=Math.floor(i/raw.width),j=((y-p.y)*p.width+x-p.x)*4;
    raw.data.copy(p.data,j,i*4,i*4+4);p.mask[j]=p.mask[j+1]=p.mask[j+2]=255;
  }
  return patches;
}
export function recomposePartition(raw,owners,patches){
  const data=Buffer.alloc(raw.data.length),byId=new Map(patches.map(x=>[x.id,x]));
  for(let i=0;i<owners.length;i++){
    const p=byId.get(owners[i]);if(!p)throw processingError('Partition has an uncovered pixel','RESTORE_COVERAGE');
    const x=i%raw.width,y=Math.floor(i/raw.width),j=((y-p.y)*p.width+x-p.x)*4;p.data.copy(data,i*4,j,j+4);
  }
  return data;
}
function ocrRect(item,width,height){
  const box=item.bbox||item.box;let r;
  if(Array.isArray(box)&&box.length===4&&box.every(Number.isFinite))r=box;
  else if(Array.isArray(item.polygon)){const points=item.polygon.filter(p=>Array.isArray(p)&&p.length===2&&p.every(Number.isFinite));if(points.length)r=[Math.min(...points.map(p=>p[0])),Math.min(...points.map(p=>p[1])),Math.max(...points.map(p=>p[0])),Math.max(...points.map(p=>p[1]))];}
  if(!r)return null;
  const x0=Math.max(0,Math.min(width,Math.floor(r[0]))),y0=Math.max(0,Math.min(height,Math.floor(r[1]))),x1=Math.max(x0,Math.min(width,Math.ceil(r[2]))),y1=Math.max(y0,Math.min(height,Math.ceil(r[3])));
  return x1>x0&&y1>y0?[x0,y0,x1,y1]:null;
}
export async function restoreLayers(request,ctx){
  const base=await baseInput(request,ctx),raw=await decodeTargetRGBA(base,ctx);
  const target=base.target;
  if(target&&target.type!=='raster')throw processingError('Select a raster source to restore; native text and vectors are preserved','RESTORE_SCOPE',{status:422});
  const newFlat=!ctx.document.layers.length||(ctx.document.layers.length===1&&ctx.document.layers[0].type==='raster'&&ctx.document.layers[0].assetId===base.id);
  if(!target&&!newFlat)throw processingError('Select the raster layer to restore in a mixed document','RESTORE_SCOPE',{status:422});
  const p=request.params||{},n=raw.width*raw.height,owners=new Uint16Array(n),regions=[{type:'raster',name:'残余背景',metadata:{role:'residual',missingBehindObjects:true}}],warnings=[];
  const maxPixels=ctx.config?.maxRestorePixels||16000000;
  const check=()=>{if(ctx.cancelled?.())throw processingError('Operation cancelled','CANCELLED',{status:409});};
  if(n>maxPixels)warnings.push('Source exceeds restoration analysis budget; all original pixels retained in residual layer');
  else {
    if(p.ocr!==false){
      try{
        const ocr=ctx.checkpoints?.restoreOCR||await requestOCR(await encodePNG(raw),ctx);
        await ctx.checkpoint({restoreOCR:ocr});
        for(const item of ocr.items.slice(0,256)){
          const rect=ocrRect(item,raw.width,raw.height);if(!rect||!String(item.text||'').trim())continue;
          const id=regions.length;regions.push({type:'text',name:String(item.text).slice(0,48),text:String(item.text),metadata:{role:'sourcePatch',fontStatus:'unknown',fontConfirmed:false,textConfidence:Number(item.confidence)||0,polygon:item.polygon,model:ocr.models,requiresReview:true}});
          for(let y=rect[1];y<rect[3];y++)for(let x=rect[0];x<rect[2];x++){const i=y*raw.width+x;if(!owners[i])owners[i]=id;}
        }
      }catch(error){if(error.code==='CANCELLED')throw error;warnings.push(`OCR unavailable or failed (${error.code||'UPSTREAM'}); original pixels retained`);}
    }
    check();
    if(p.segment!==false){
      try{
        const preparedBase={...base,asset:{...base.asset,mime:'image/png',width:raw.width,height:raw.height},bytes:await encodePNG(raw)};
        const segmented=await runComfy('segment',{...request,base:preparedBase,params:{...p,maxSegments:64}},ctx);
        for(const result of segmented.masks){
          const mask=await decodeRGBA(result.bytes,result.mime);
          if(mask.width!==raw.width||mask.height!==raw.height){warnings.push('Segmentation mask dimensions did not match; mask skipped');continue;}
          const id=regions.length;let area=0;
          for(let i=0;i<n;i++)if(!owners[i]&&mask.data[i*4]>=128&&mask.data[i*4+3]>0){owners[i]=id;area++;}
          if(area)regions.push({type:'raster',name:`分割对象 ${id}`,metadata:{role:'object',method:'sam2',requiresReview:true,visiblePixelsOnly:true}});
        }
      }catch(error){if(error.code==='CANCELLED')throw error;if(error.uncertain)warnings.push('Segmentation receipt preserved for review; incomplete task was not resubmitted');else warnings.push(`Segmentation unavailable or failed (${error.code||'UPSTREAM'}); original pixels retained`);}
    }
    check();
    if(p.connected!==false){
      for(const candidate of connectedRegions(raw,owners,{minArea:Math.max(4,Number(p.minArea)||24),maxRegions:Math.max(1,Math.min(128,Number(p.maxRegions)||64))})){
        const id=regions.length;for(const i of candidate.pixels)owners[i]=id;
        regions.push({type:'raster',name:`颜色区域 ${id}`,metadata:{role:'connected_region',method:'quantized_connected_component',requiresReview:true,visiblePixelsOnly:true}});
      }
    }
  }
  let patches;
  try{patches=partitionToPatches(raw,owners,regions);}catch(error){warnings.push(`Layer extraction exceeded budget (${error.code}); all original pixels retained`);owners.fill(0);patches=partitionToPatches(raw,owners,[regions[0]]);}
  let recomposed=recomposePartition(raw,owners,patches);
  let diff=0;for(let i=0;i<raw.data.length;i++)if(raw.data[i]!==recomposed[i])diff++;
  if(diff){warnings.push('Partition recomposition failed; reverted to original pixels');owners.fill(0);patches=partitionToPatches(raw,owners,[regions[0]]);recomposed=recomposePartition(raw,owners,patches);diff=0;}
  const commands=target?[{type:'layer.update',layerId:target.id,patch:{type:'group',sourceAssetId:base.id,maskAssetId:null,metadata:{...target.metadata,role:'restored_flat',sourceAssetId:base.id,sourceWidth:raw.width,sourceHeight:raw.height,...(base.activeMaskId?{sourceMaskAssetId:base.activeMaskId}: {}),requiresReview:true}}}]:ctx.document.layers.map(layer=>({type:'layer.remove',layerId:layer.id}));
  if(!target)commands.push({type:'document.update',patch:{width:raw.width,height:raw.height}});
  const sx=target?target.width/raw.width:1,sy=target?target.height/raw.height:1;
  // An existing source mask is part of the visible source being restored. Freeze it once
  // so later mask expansion cannot reveal pixels that were hidden before restoration.
  let visibilitySourceId=base.id,visibilitySourceHash=base.asset.hash||createHash('sha256').update(base.bytes).digest('hex');
  if(base.activeMaskId){
    const visibleBytes=await encodePNG(raw);
    const visibilitySource=await ctx.saveAsset('restore_visibility_source',{name:'还原可见源.png',mime:'image/png',width:raw.width,height:raw.height,inputs:[{role:'base',assetId:base.id,hash:visibilitySourceHash},{role:'active_mask',assetId:base.activeMaskId,hash:base.activeMaskRecord.asset.hash||createHash('sha256').update(base.activeMaskRecord.bytes).digest('hex')}],metadata:{role:'visibility_source',sourceAssetId:base.id,sourceMaskAssetId:base.activeMaskId,hiddenContent:'not_reconstructed'}},visibleBytes);
    visibilitySourceId=visibilitySource.id;visibilitySourceHash=visibilitySource.hash||createHash('sha256').update(visibleBytes).digest('hex');
  }
  let fitFont;
  if(patches.some(patch=>patch.region.type==='text'))try{fitFont=await createFontCandidateFitter(ctx);}catch{warnings.push('Font candidate geometry unavailable; original text pixels retained');}
  const ids=[];
  for(const [z,patch]of patches.entries()){
    check();
    if(patch.region.type==='text'){
      let fontCandidates=[];try{fontCandidates=fitFont?await fitFont(patch.region.text,patch,{scaleX:sx,scaleY:sy}):[];}catch{warnings.push('Font candidate geometry unavailable; original text pixels retained');}
      patch.region.metadata={...patch.region.metadata,originalFont:'unknown',fontCandidates,fontConfirmed:false,fontStatus:'unknown'};
    }
    const bytes=await encodePNG(patch),maskBytes=await encodePNG({...patch,data:patch.mask});
    const visibilitySourceRect=[patch.x,patch.y,patch.width,patch.height];
    const visibilityMetadata={visibilitySourceAssetId:visibilitySourceId,visibilitySourceRect,visibilityCanExpand:true};
    const asset=await ctx.saveAsset(`restore_patch_${patch.id}`,{name:`${patch.region.name}.png`,mime:'image/png',width:patch.width,height:patch.height,inputs:[{role:'base',assetId:base.id,hash:base.asset.hash||createHash('sha256').update(base.bytes).digest('hex')},...(base.activeMaskId?[{role:'active_mask',assetId:base.activeMaskId,hash:base.activeMaskRecord.asset.hash||createHash('sha256').update(base.activeMaskRecord.bytes).digest('hex')}]:[]),...(visibilitySourceId!==base.id?[{role:'visibility_source',assetId:visibilitySourceId,hash:visibilitySourceHash}]:[])],metadata:{...patch.region.metadata,...visibilityMetadata,sourceAssetId:base.id,sourceRect:visibilitySourceRect,...(base.activeMaskId?{sourceMaskAssetId:base.activeMaskId}: {})}},bytes);
    const mask=await ctx.saveAsset(`restore_mask_${patch.id}`,{name:`${patch.region.name}蒙版.png`,mime:'image/png',width:patch.width,height:patch.height,metadata:{role:'ownership_mask',sourceAssetId:base.id}},maskBytes);
    ids.push(asset.id);
    commands.push({type:'layer.add',layer:{id:randomUUID(),type:patch.region.type,name:patch.region.name,x:patch.x*sx,y:patch.y*sy,width:patch.width*sx,height:patch.height*sy,rotation:0,opacity:1,visible:true,locked:false,z,...(target?{parentId:target.id}:{}),assetId:asset.id,maskAssetId:mask.id,sourceAssetId:base.id,sourceRect:visibilitySourceRect,editability:patch.region.type==='text'?'text':'pixels',...(patch.region.type==='text'?{text:patch.region.text}:{}),metadata:{...patch.region.metadata,...visibilityMetadata,sourcePatchAssetId:asset.id,ownedPixelCount:patch.area,missingBehindObjects:patch.region.type!=='text'}}});
  }
  await ctx.checkpoint({restoreValidation:{sourceAssetId:base.id,pixels:n,coveredPixels:patches.reduce((s,p)=>s+p.area,0),differentChannels:diff}});
  return {commands,output:{assetIds:ids,layerCount:patches.length,sourceAssetId:base.id,targetGroupId:target?.id,width:raw.width,height:raw.height,coverage:1,differentChannels:diff,warnings,fonts:'unknown',hiddenContent:'not_reconstructed'},needsReview:true};
}
