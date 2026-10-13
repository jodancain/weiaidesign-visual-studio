import sharp from 'sharp';
import ImageTracer from 'imagetracerjs';
import { Resvg } from '@resvg/resvg-js';
import * as fontkit from 'fontkit';
import { randomUUID,createHash } from 'node:crypto';
import {Worker} from 'node:worker_threads';
import {createRequire} from 'node:module';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import { runComfy, generateImages, providerCapabilities,imageFrameFor,configFromEnv } from './providers.mjs';
import { restoreLayers } from './restore.mjs';
import { normalizeSvg } from './svg-normalize.mjs';
import {pdfFontBytes} from './fonts.mjs';

export const registry = Object.fromEntries([
  ['resize','cpu','调整像素尺寸'], ['crop','cpu','裁切'], ['pad','cpu','扩展画布'],
  ['rotate','cpu','旋转'], ['flip','cpu','翻转'], ['recolor','cpu','换色'],
  ['erase','cpu','像素擦除'], ['color_key','cpu','颜色去底'], ['trace','cpu','描摹矢量'],
  ['fill','cpu','选区填色'], ['repair','cpu','传统局部修补'],
  ['prepare_text','cpu','准备可编辑文字背景'],
  ['refine_mask','cpu','修正可见区域蒙版'],
  ['matting','vision','精细抠图'], ['segment','vision','对象分割'],
  ['super_resolution','vision','真实超分'], ['restore_layers','vision','还原可编辑图层'],
  ['generate','generation','生成图片'], ['inpaint','generation','局部生成'], ['export','cpu','导出'],
].map(([name, executionClass, label]) => [name, { executionClass, label }]));

export function processingError(message, code='INVALID_PARAMS', extra={}) {
  return Object.assign(new Error(message), { code, status: code==='UNAVAILABLE'?503:400, ...extra });
}
const finite=(v,fallback)=>Number.isFinite(Number(v))?Number(v):fallback;
function sourceFontIds(request,target,id,asset){
  const explicit=(request.inputs||[]).filter(input=>['font','font_source'].includes(input.role)).map(input=>input.assetId);
  if(explicit.length)return [...new Set(explicit)];
  if(id===target?.assetId&&target.fontAssetId)return [target.fontAssetId];
  const own=[asset?.metadata?.fontAssetId,...(Array.isArray(asset?.metadata?.fontAssetIds)?asset.metadata.fontAssetIds:[]),...(asset?.inputs||[]).filter(input=>['font','font_source'].includes(input.role)).map(input=>input.assetId)].filter(value=>typeof value==='string');
  return [...new Set(own)];
}
export function positiveInt(v, name, max=16384) {
  const n=Number(v);
  if (!Number.isInteger(n)||n<1||n>max) throw processingError(`${name} must be an integer in 1..${max}`);
  return n;
}
export function parseColor(value, fallback) {
  if (value==null&&fallback) return fallback;
  if (value==='transparent') return {r:0,g:0,b:0,alpha:0};
  const m=/^#([a-f\d]{6})([a-f\d]{2})?$/i.exec(String(value));
  if (!m) throw processingError('color must be #RRGGBB or #RRGGBBAA');
  return {r:parseInt(m[1].slice(0,2),16),g:parseInt(m[1].slice(2,4),16),b:parseInt(m[1].slice(4,6),16),alpha:m[2]?parseInt(m[2],16)/255:1};
}
function safeSvg(bytes) {
  return normalizeSvg(bytes.toString('utf8')).svg;
}
export async function decodeRGBA(bytes, mime, maxPixels=40000000) {
  const b=Buffer.from(bytes);
  let input=b;
  if (mime==='image/svg+xml'||b.subarray(0,256).toString().trimStart().startsWith('<svg')) {
    const svg=safeSvg(b);
    const renderer=new Resvg(svg, {font:{loadSystemFonts:false}});
    if (renderer.width*renderer.height>maxPixels) throw processingError('Image exceeds pixel budget');
    const rendered=renderer.render();
    input=Buffer.from(rendered.asPng());
  }
  const {data,info}=await sharp(input,{limitInputPixels:maxPixels}).autoOrient().toColourspace('srgb').ensureAlpha().raw().toBuffer({resolveWithObject:true});
  if (info.width*info.height>maxPixels) throw processingError('Image exceeds pixel budget');
  return {data:Buffer.from(data),width:info.width,height:info.height,channels:4};
}
export async function encodePNG(rgba) {
  return sharp(rgba.data,{raw:{width:rgba.width,height:rgba.height,channels:4}}).png({compressionLevel:9}).toBuffer();
}
export async function inspectAsset(bytes,mime) {
  const b=Buffer.from(bytes),signature=b.subarray(0,4).toString('ascii');
  if(['OTTO','wOFF','wOF2','true','ttcf'].includes(signature)||(b.length>=4&&b.readUInt32BE(0)===0x00010000)){
    const font=fontkit.create(b);
    if(!font.familyName||!font.postscriptName)throw processingError('A single font face is required; font collections are not supported');
    return {mime:signature==='wOFF'?'font/woff':signature==='wOF2'?'font/woff2':signature==='OTTO'?'font/otf':'font/ttf',metadata:{family:font.familyName,postscriptName:font.postscriptName,fullName:font.fullName,subfamily:font.subfamilyName,unitsPerEm:font.unitsPerEm,numGlyphs:font.numGlyphs,weight:Number(font['OS/2']?.usWeightClass)||400}};
  }
  if(b.subarray(0,5).toString()==='%PDF-')return {mime:'application/pdf',metadata:{format:'pdf'}};
  if(b.length>=4&&[0x04034b50,0x06054b50,0x08074b50].includes(b.readUInt32LE(0)))return {mime:'application/zip',metadata:{format:'zip'}};
  if (mime==='image/svg+xml') {
    const normalized=normalizeSvg(b.toString('utf8')),r=await decodeRGBA(Buffer.from(normalized.svg),mime);
    const requiresFont=/<(?:[\w-]+:)?(?:text|tspan)\b/i.test(b.toString('utf8'));
    return {mime,width:r.width,height:r.height,metadata:{format:'svg',renderable:true,requiresFont,...(requiresFont?{fontStatus:'svg_font_binding_required'}:{}),svgNormalizationVersion:1,sourceViewBox:normalized.viewBox,intrinsicWidth:normalized.width,intrinsicHeight:normalized.height}};
  }
  const m=await sharp(bytes,{limitInputPixels:40000000}).metadata();
  const resolved={png:'image/png',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif',tiff:'image/tiff',avif:'image/avif'}[m.format];
  if (!resolved) throw processingError('Unsupported image format');
  const swapped=[5,6,7,8].includes(m.orientation);
  return {mime:resolved,width:swapped?m.height:m.width,height:swapped?m.width:m.height,metadata:{format:m.format,hasAlpha:Boolean(m.hasAlpha),pages:m.pages||1,originalOrientation:m.orientation||1,originalWidth:m.width,originalHeight:m.height,normalizedOrientation:1}};
}
export async function baseInput(request,ctx) {
  const target=ctx.document.layers.find(l=>l.id===request.targetLayerId);
  const id=request.inputs?.find(x=>x.role==='base')?.assetId||target?.assetId;
  if (!id) throw processingError('A base asset or target layer is required');
  const source=await ctx.getAsset(id);
  return {...source,id,target,fontAssetIds:sourceFontIds(request,target,id,source.asset),activeMaskId:request.inputs?.find(x=>x.role==='active_mask')?.assetId||(id===target?.assetId?target.maskAssetId:undefined)};
}
async function sourceDisplayRGBA(base,ctx){
  const styled=base.asset.mime==='image/svg+xml'&&base.id===base.target?.assetId;
  const bytes=styled?Buffer.from(normalizeSvg(base.bytes.toString('utf8'),{fill:base.target.fill,styles:base.target.metadata?.pathStyles}).svg):base.bytes;
  if(base.asset.mime==='image/svg+xml'&&/<(?:[\w-]+:)?(?:text|tspan)\b/i.test(bytes.toString('utf8'))&&!base.fontAssetIds?.length)throw processingError('SVG 含有文字，但没有绑定可重复使用的实际字体。请先绑定字体或把原文字转为路径；原始文件保留。','SVG_FONT_REQUIRED',{status:422,retryable:false});
  if(base.asset.mime!=='image/svg+xml'||!base.fontAssetIds?.length)return decodeRGBA(bytes,base.asset.mime,ctx.config?.maxPixels);
  if(base.fontAssetIds.length>16)throw processingError('SVG font source exceeds the 16-face limit','FONT_ASSET',{status:422});
  const directory=await mkdtemp(join(tmpdir(),'image2-input-fonts-'));
  try{
    const files=[];
    for(const id of base.fontAssetIds){const font=await ctx.getAsset(id);if(!font.asset.mime.startsWith('font/'))throw processingError('SVG 字形源需要实际字体资产。','FONT_ASSET',{status:422});if(font.bytes.toString('ascii',0,4)==='wOFF')throw processingError('SVG 像素处理暂不支持 WOFF1 字体，请使用 TTF、OTF 或 WOFF2；原文件保留。','SVG_FONT_CONTAINER_UNAVAILABLE',{status:422});const file=join(directory,`${files.length}.ttf`);await writeFile(file,await pdfFontBytes(font.bytes));files.push(file);}
    const renderer=new Resvg(safeSvg(bytes),{font:{loadSystemFonts:false,fontFiles:files,defaultFontFamily:base.target?.fontFamily||'Noto Sans CJK SC'}});
    if(renderer.width*renderer.height>(ctx.config?.maxPixels||40000000))throw processingError('Image exceeds pixel budget');
    return decodeRGBA(Buffer.from(renderer.render().asPng()),'image/png',ctx.config?.maxPixels);
  }finally{await rm(directory,{recursive:true,force:true});}
}
export async function decodeTargetRGBA(base,ctx){
  const raw=await sourceDisplayRGBA(base,ctx);
  if(!base.activeMaskId)return raw;
  const mask=await ctx.getAsset(base.activeMaskId),decoded=await decodeRGBA(mask.bytes,mask.asset.mime,ctx.config?.maxPixels);
  if(decoded.width!==raw.width||decoded.height!==raw.height)throw processingError('Active layer mask dimensions do not match source pixels','MASK_SIZE',{status:422});
  base.activeMaskRecord=mask;
  for(let i=0;i<raw.width*raw.height;i++){
    const j=i*4,luminance=.2126*decoded.data[j]+.7152*decoded.data[j+1]+.0722*decoded.data[j+2];
    raw.data[j+3]=Math.round(raw.data[j+3]*luminance*decoded.data[j+3]/(255*255));
    if(raw.data[j+3]===0)raw.data[j]=raw.data[j+1]=raw.data[j+2]=0; // canonical visible RGBA
  }
  return raw;
}
async function maskInput(request,ctx,role,width,height) {
  const aliases=role==='edit'?['edit','edit_mask']:['protect','protect_mask'];
  const id=request.inputs?.find(x=>aliases.includes(x.role))?.assetId;
  if (!id) return null;
  const a=await ctx.getAsset(id);const d=await decodeRGBA(a.bytes,a.asset.mime);
  if(d.width!==width||d.height!==height)throw processingError('Masks must have the same pixel dimensions as the source','MASK_SIZE');
  const mask=new Uint8Array(width*height);
  for(let i=0;i<mask.length;i++)mask[i]=Math.round((d.data[i*4]*.2126+d.data[i*4+1]*.7152+d.data[i*4+2]*.0722)*d.data[i*4+3]/255);
  return mask;
}
/** Positive protection wins. Feathering only reduces values *inside* effective edit. */
export function effectiveMask(width,height,edit,protect,feather=0) {
  const n=width*height;const m=new Uint8Array(n);
  for(let i=0;i<n;i++)m[i]=protect?.[i]>0?0:(edit?edit[i]:255);
  const radius=Math.max(0,Math.min(256,Math.floor(Number(feather)||0)));
  if(!radius)return m;
  // Manhattan distance transform, including image exterior; no feather can expand the edit region.
  const d=new Uint16Array(n);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const i=y*width+x;d[i]=m[i]?(x===0||y===0?1:Math.min(d[i-1],d[i-width])+1):0;
  }
  for(let y=height-1;y>=0;y--)for(let x=width-1;x>=0;x--){
    const i=y*width+x;if(!m[i])continue;
    d[i]=Math.min(d[i],x===width-1||y===height-1?1:Math.min(d[i+1],d[i+width])+1);
    m[i]=Math.round(m[i]*Math.min(1,d[i]/(radius+1)));
  }
  return m;
}
export async function masksFor(request,ctx,rgba) {
  const [edit,protect]=await Promise.all([maskInput(request,ctx,'edit',rgba.width,rgba.height),maskInput(request,ctx,'protect',rgba.width,rgba.height)]);
  return {edit,protect,effective:effectiveMask(rgba.width,rgba.height,edit,protect,request.params?.feather)};
}
export function compositeProtected(original,result,mask,protect) {
  if(original.width!==result.width||original.height!==result.height)throw processingError('Masked edits cannot change image dimensions','MASK_GEOMETRY');
  const data=Buffer.from(original.data);
  for(let i=0;i<mask.length;i++){
    if(protect?.[i]>0||mask[i]===0)continue;
    const a=mask[i]/255;
    for(let c=0;c<4;c++)data[i*4+c]=Math.round(original.data[i*4+c]+(result.data[i*4+c]-original.data[i*4+c])*a);
  }
  return {...original,data};
}
function layerCommands(request,ctx,asset,extras={}) {
  const target=ctx.document.layers.find(l=>l.id===request.targetLayerId);
  // Pixel edits replace an asset in its existing canvas frame. A downsampled
  // source must not shrink a scaled/rotated object when only its pixels change.
  const pixelEdits=['recolor','erase','repair','fill','color_key','inpaint','matting','trace','flip'];
  const keepLayout=target&&(pixelEdits.includes(request.operation)||['resize','super_resolution'].includes(request.operation)&&request.params?.resizeLayout!==true);
  const {clearVectorPaint,clearSourceMask,...layerExtras}=extras;
  const priorMetadata={...target?.metadata};
  if(request.operation==='trace'){delete priorMetadata.traceVersion;delete priorMetadata.lineart;}
  if(clearVectorPaint)delete priorMetadata.pathStyles;
  if(clearSourceMask)delete priorMetadata.sourceMaskAssetId;
  const patch={assetId:asset.id,width:keepLayout?target.width:asset.width,height:keepLayout?target.height:asset.height,...layerExtras,...(clearVectorPaint&&target?{fill:null}:{}),maskAssetId:null,metadata:{...priorMetadata,...asset.metadata,...layerExtras.metadata}};
  if(target)return [{type:'layer.update',layerId:target.id,patch}];
  // Null clears a property in update commands; newly added layers must omit absent IDs.
  const {maskAssetId:_mask,...added}=patch;void _mask;
  return [{type:'layer.add',layer:{id:randomUUID(),type:extras.type||'raster',name:asset.name||'处理结果',x:0,y:0,width:asset.width,height:asset.height,rotation:0,opacity:1,visible:true,locked:false,z:Math.max(-1,...ctx.document.layers.map(x=>x.z))+1,editability:extras.type==='vector'?'path':'pixels',...added}}];
}
async function saveResult(request,ctx,bytes,mime,metadata={},key='output') {
  const info=await inspectAsset(bytes,mime);
  const target=ctx.document.layers.find(l=>l.id===request.targetLayerId);
  const requestedBaseId=request.inputs?.find(x=>x.role==='base')?.assetId||target?.assetId;
  const maskId=request.inputs?.find(x=>x.role==='active_mask')?.assetId||(requestedBaseId===target?.assetId?target?.maskAssetId:undefined);
  const inputs=[];
  for(const ref of request.inputs||[]){const record=await ctx.getAsset(ref.assetId);inputs.push({...ref,hash:record.asset.hash||createHash('sha256').update(record.bytes).digest('hex')});}
  const baseId=request.inputs?.find(x=>x.role==='base')?.assetId||target?.assetId;
  if(baseId&&!inputs.some(x=>x.role==='base')){const base=await ctx.getAsset(baseId);inputs.push({role:'base',assetId:baseId,hash:base.asset.hash||createHash('sha256').update(base.bytes).digest('hex')});}
  if(maskId&&!inputs.some(x=>x.role==='active_mask')){const mask=await ctx.getAsset(maskId);inputs.push({role:'active_mask',assetId:maskId,hash:mask.asset.hash||createHash('sha256').update(mask.bytes).digest('hex')});}
  if(baseId){const source=await ctx.getAsset(baseId);if(source.asset.mime==='image/svg+xml')for(const id of sourceFontIds(request,target,baseId,source.asset))if(!inputs.some(input=>['font','font_source'].includes(input.role)&&input.assetId===id)){const font=await ctx.getAsset(id);inputs.push({role:'font',assetId:id,hash:font.asset.hash||createHash('sha256').update(font.bytes).digest('hex')});}}
  return ctx.saveAsset(key,{name:`${request.operation}.${mime==='image/svg+xml'?'svg':'png'}`,mime,...info,inputs,metadata:{...info.metadata,...metadata,...(maskId?{sourceMaskAssetId:maskId}: {})}},bytes);
}
function checkpointCancel(ctx){if(ctx.cancelled?.())throw processingError('Operation cancelled','CANCELLED',{status:409});}
function unknownTextPatch(target){return target?.type==='text'&&target.metadata?.fontConfirmed!==true&&Boolean(target.metadata?.sourcePatchAssetId||target.metadata?.role==='sourcePatch');}
function backgroundRequired(message='复杂背景需要先画蒙版修补或指定背景填色，原文字裁片保持不变。'){return processingError(message,'TEXT_BACKGROUND_REQUIRED',{status:422,needsReview:true,retryable:false});}
async function prepareText(request,ctx,base,raw){
  if(!unknownTextPatch(base.target))throw backgroundRequired('请选择尚未确认字体的原文字裁片。');
  const metadata=base.target.metadata||{};
  if(metadata.cleanBackgroundAssetId){
    const existing=await ctx.getAsset(metadata.cleanBackgroundAssetId);
    const d=await decodeRGBA(existing.bytes,existing.asset.mime);
    if(d.width!==raw.width||d.height!==raw.height)throw backgroundRequired('现有文字背景尺寸与原裁片不匹配，请先修补背景。');
    return {commands:[],output:{cleanBackgroundAssetId:existing.asset.id,cleanBgAssetId:existing.asset.id,backgroundStatus:'ready',sourcePatchAssetId:metadata.sourcePatchAssetId||base.id},needsReview:false};
  }
  const tolerance=Math.max(0,Math.min(20,Number(request.params?.backgroundTolerance)||10));
  const border=[];
  for(let y=0;y<raw.height;y++)for(let x=0;x<raw.width;x++)if(x===0||y===0||x===raw.width-1||y===raw.height-1)border.push((y*raw.width+x)*4);
  if(!border.length||raw.width*raw.height>4000000)throw backgroundRequired();
  const bins=new Map();
  for(const j of border){const key=[0,1,2,3].map(c=>raw.data[j+c]>>4).join(',');const bucket=bins.get(key)||[];bucket.push(j);bins.set(key,bucket);}
  const dominant=[...bins.values()].sort((a,b)=>b.length-a.length)[0];
  if(dominant.length/border.length<.9)throw backgroundRequired();
  const background=[0,1,2,3].map(c=>{const values=dominant.map(j=>raw.data[j+c]).sort((a,b)=>a-b);return values[Math.floor(values.length/2)];});
  const distance=j=>Math.max(...[0,1,2,3].map(c=>Math.abs(raw.data[j+c]-background[c])));
  if(border.filter(j=>distance(j)<=tolerance).length/border.length<.94)throw backgroundRequired();
  const clean=Buffer.from(raw.data),glyph=Buffer.alloc(raw.data.length);let glyphPixels=0;
  for(let i=0;i<raw.width*raw.height;i++){
    const j=i*4;glyph[j+3]=255;
    if(distance(j)>tolerance){glyphPixels++;glyph[j]=glyph[j+1]=glyph[j+2]=255;clean.set(background,j);}
  }
  // A photo/texture occupying most of the crop is not inferred to be a glyph region merely
  // because a frame happened to have a uniform border. Keep the original and ask for a mask.
  if(glyphPixels/(raw.width*raw.height)>.5)throw backgroundRequired();
  const backgroundAsset=await saveResult(request,ctx,await encodePNG({...raw,data:clean}),'image/png',{role:'text_background',method:'near_solid_glyph_difference',backgroundRGBA:background,sourcePatchAssetId:metadata.sourcePatchAssetId||base.id},'text_background');
  const maskAsset=await saveResult(request,ctx,await encodePNG({...raw,data:glyph}),'image/png',{role:'glyph_mask',sourcePatchAssetId:metadata.sourcePatchAssetId||base.id},'text_glyph_mask');
  return {commands:[{type:'layer.update',layerId:base.target.id,patch:{metadata:{...metadata,cleanBackgroundAssetId:backgroundAsset.id,glyphMaskAssetId:maskAsset.id,backgroundStatus:'ready',backgroundMethod:'near_solid_glyph_difference',fontConfirmed:false,fontStatus:'unknown',sourcePatchAssetId:metadata.sourcePatchAssetId||base.id,...(base.activeMaskId?{sourceMaskAssetId:base.activeMaskId}: {})}}}],output:{cleanBackgroundAssetId:backgroundAsset.id,cleanBgAssetId:backgroundAsset.id,glyphMaskAssetId:maskAsset.id,backgroundStatus:'ready',backgroundRGBA:background,glyphPixels,sourcePatchAssetId:metadata.sourcePatchAssetId||base.id},needsReview:false};
}
/** Source provenance describes the original extraction; visibility describes the current
 * processed pixels that a mask may reveal. Never derive a processed layer from stale
 * provenance: doing so would silently undo its crop, orientation and colour edits. */
async function visibilitySource(base,ctx,current){
  const target=base.id===base.target?.assetId?base.target:undefined,metadata=target?.metadata||base.asset.metadata||{};
  const svgSource=base.asset.mime==='image/svg+xml';
  let id=svgSource?undefined:metadata.visibilitySourceAssetId,rect=svgSource?undefined:metadata.visibilitySourceRect;
  let legacyOriginal=false;
  // Compatibility for original restoration patches. Old processed results have no valid
  // transform history, so retain their current pixels instead of guessing a transform.
  const processed=metadata.operation||base.asset.metadata?.operation;
  if(!svgSource&&!id&&(!processed||processed==='restore_layers')&&target?.sourceAssetId&&Array.isArray(target.sourceRect)){
    id=target.sourceAssetId;rect=target.sourceRect;legacyOriginal=true;
  }
  if(!id){id=base.id;rect=undefined;}
  const record=id===base.id?base:await ctx.getAsset(id);
  let raw=record===base?await sourceDisplayRGBA(base,ctx):await decodeRGBA(record.bytes,record.asset.mime,ctx.config?.maxPixels);
  if(rect!==undefined){
    if(!Array.isArray(rect)||rect.length!==4||!rect.every(Number.isInteger))throw processingError('Visibility source rectangle must use integer source pixels','SOURCE_RECT',{status:422});
    const [x,y,width,height]=rect;
    if(x<0||y<0||width<1||height<1||x+width>raw.width||y+height>raw.height)throw processingError('Visibility source rectangle is outside its immutable asset','SOURCE_RECT',{status:422});
    if(x!==0||y!==0||width!==raw.width||height!==raw.height)raw=await decodeRGBA(await sharp(raw.data,{raw:{width:raw.width,height:raw.height,channels:4}}).extract({left:x,top:y,width,height}).png().toBuffer(),'image/png');
  }
  if(raw.width!==current.width||raw.height!==current.height)raw=await decodeRGBA(await sharp(raw.data,{raw:{width:raw.width,height:raw.height,channels:4}}).resize(current.width,current.height,{fit:'fill'}).png().toBuffer(),'image/png');
  const canExpand=!svgSource&&(legacyOriginal||metadata.visibilityCanExpand===true)||raw.data.some((alpha,i)=>i%4===3&&alpha>current.data[i]);
  return {raw,id,canExpand,legacyOriginal};
}
async function saveVisibilitySource(request,ctx,state,raw,method){
  const inputs=[...(request.inputs||[]),{role:'visibility_source',assetId:state.id}];
  return saveResult({...request,inputs},ctx,await encodePNG(raw),'image/png',{role:'visibility_source',method,hiddenContent:'not_reconstructed'},'visibility_source');
}
async function refineMask(request,ctx,base,current){
  const target=base.target,p=request.params||{};
  if(target?.type!=='raster'&&!unknownTextPatch(target))throw processingError('请选择像素图层或未确认字体的文字裁片。','MASK_TARGET',{status:422});
  const masks=await masksFor(request,ctx,current);if(!masks.edit)throw processingError('Refine mask requires a new white-visible mask','MASK_REQUIRED');
  const state=await visibilitySource(base,ctx,current),source=state.raw,canExpand=state.canExpand;
  const visibility=effectiveMask(current.width,current.height,masks.edit,null,p.feather),data=Buffer.from(source.data);
  for(let i=0;i<visibility.length;i++){
    const j=i*4;
    if(masks.protect?.[i]>0){current.data.copy(data,j,j,j+4);continue;}
    data[j+3]=Math.round(source.data[j+3]*visibility[i]/255);
    if(data[j+3]===0)data[j]=data[j+1]=data[j+2]=0;
  }
  checkpointCancel(ctx);
  const visibilityAsset=await saveVisibilitySource(request,ctx,state,source,'current_processed_visible_pixels');
  const metadata={...target.metadata,operation:'refine_mask',method:canExpand?'processed_visible_source':'existing_visible_patch',canExpandWithinSourceRect:canExpand,visibilitySourceAssetId:visibilityAsset.id,visibilitySourceRect:[0,0,source.width,source.height],visibilityCanExpand:canExpand,hiddenContent:'not_reconstructed',...(base.activeMaskId?{sourceMaskAssetId:base.activeMaskId}: {})};
  const asset=await saveResult({...request,inputs:[...(request.inputs||[]),{role:'visibility_source',assetId:visibilityAsset.id},...(state.legacyOriginal?[{role:'original_source',assetId:state.id}]:[])]},ctx,await encodePNG({...current,data}),'image/png',metadata);
  const layerMeta={...target.metadata,...metadata};
  if(unknownTextPatch(target)){
    layerMeta.originalSourcePatchAssetId=target.metadata.originalSourcePatchAssetId||target.metadata.sourcePatchAssetId||base.id;
    layerMeta.sourcePatchAssetId=asset.id;layerMeta.fontConfirmed=false;layerMeta.fontStatus='unknown';
    // A background prepared before a visibility change is stale; preserve its audit reference.
    if(layerMeta.cleanBackgroundAssetId){layerMeta.previousCleanBackgroundAssetId=layerMeta.cleanBackgroundAssetId;delete layerMeta.cleanBackgroundAssetId;delete layerMeta.backgroundStatus;}
    if(layerMeta.glyphMaskAssetId){layerMeta.previousGlyphMaskAssetId=layerMeta.glyphMaskAssetId;delete layerMeta.glyphMaskAssetId;}
  }
  return {commands:[{type:'layer.update',layerId:target.id,patch:{assetId:asset.id,maskAssetId:null,metadata:layerMeta}}],output:{assetId:asset.id,width:asset.width,height:asset.height,canExpandWithinSourceRect:canExpand,hiddenContent:'not_reconstructed'},needsReview:!canExpand};
}
const linear=v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4;
const srgb=v=>v<=.0031308?v*12.92:1.055*v**(1/2.4)-.055;
const luminance=c=>.2126*c[0]+.7152*c[1]+.0722*c[2];
function rgbToHSV(c){const max=Math.max(...c),min=Math.min(...c),d=max-min;let h=0;if(d)h=max===c[0]?((c[1]-c[2])/d+6)%6:max===c[1]?(c[2]-c[0])/d+2:(c[0]-c[1])/d+4;return [h*60,max?d/max:0,max];}
function hsvToRGB([h,s,v]){const c=v*s,x=c*(1-Math.abs((h/60)%2-1)),m=v-c,triplet=h<60?[c,x,0]:h<120?[x,c,0]:h<180?[0,c,x]:h<240?[0,x,c]:h<300?[x,0,c]:[c,0,x];return triplet.map(t=>t+m);}
function texturedColor(source,color,p){
  if(p.mode==='flatten'||p.preserveLuminance===false&&p.mode!=='hsv')return [color.r,color.g,color.b];
  const original=source.map(v=>v/255),target=[color.r,color.g,color.b].map(v=>v/255);
  let candidate=target;
  if(p.mode==='hsv'){const [h,s]=rgbToHSV(target);candidate=hsvToRGB([h,s,rgbToHSV(original)[2]]);if(p.preserveLuminance===false)return candidate.map(v=>Math.round(v*255));}
  const desired=luminance(original.map(linear)),c=candidate.map(linear),current=luminance(c);
  // Scaling towards black or interpolating towards white preserves linear luminance even
  // when a saturated target cannot reach the source brightness without clipping.
  const result=current>desired?c.map(v=>v*(current?desired/current:0)):c.map(v=>v+(1-v)*(current<1?(desired-current)/(1-current):0));
  return result.map(v=>Math.round(Math.max(0,Math.min(1,srgb(v)))*255));
}
function repairPixels(raw,mask,p){
  const n=raw.width*raw.height,data=Buffer.from(raw.data),holes=new Uint8Array(n),count=mask.reduce((s,v)=>s+(v>0),0);
  if(!count)return {raw:{...raw,data},method:'no_edit',needsReview:false};
  if(count>2000000)return {raw:{...raw,data},method:'retained_original',needsReview:true,warning:'Repair region exceeds two-million-pixel budget'};
  if(p.sourceX!=null||p.sourceY!=null){
    const sx=Number(p.sourceX),sy=Number(p.sourceY);if(!Number.isInteger(sx)||!Number.isInteger(sy))throw processingError('Clone sample sourceX/sourceY must be integers');
    let x0=raw.width,y0=raw.height;for(let i=0;i<n;i++)if(mask[i]){x0=Math.min(x0,i%raw.width);y0=Math.min(y0,Math.floor(i/raw.width));}
    for(let i=0;i<n;i++)if(mask[i]){const x=sx+i%raw.width-x0,y=sy+Math.floor(i/raw.width)-y0;if(x<0||y<0||x>=raw.width||y>=raw.height)throw processingError('Clone sample lies outside source');raw.data.copy(data,i*4,(y*raw.width+x)*4,(y*raw.width+x)*4+4);}
    return {raw:{...raw,data},method:'source_clone',needsReview:false};
  }
  for(let i=0;i<n;i++)holes[i]=mask[i]>0?1:0;
  const neighbors=i=>{const x=i%raw.width,y=Math.floor(i/raw.width);return [x?i-1:-1,x<raw.width-1?i+1:-1,y?i-raw.width:-1,y<raw.height-1?i+raw.width:-1].filter(j=>j>=0);};
  const queue=new Uint32Array(n),seen=new Uint8Array(n);let head=0,tail=0;
  for(let i=0;i<n;i++)if(!holes[i]&&neighbors(i).some(j=>holes[j])){queue[tail++]=i;seen[i]=1;}
  if(!tail)return {raw:{...raw,data},method:'retained_original',needsReview:true,warning:'No unmasked context for traditional repair'};
  while(head<tail){const i=queue[head++];for(const j of neighbors(i))if(holes[j]&&!seen[j]){seen[j]=1;data.copy(data,j*4,i*4,i*4+4);queue[tail++]=j;}}
  const iterations=Math.max(1,Math.min(64,Math.floor(Number(p.iterations)||12)));let current=data,next=Buffer.from(data);
  for(let pass=0;pass<iterations;pass++){
    for(let i=0;i<n;i++)if(holes[i]){const neighborsOf=neighbors(i);for(let c=0;c<4;c++)next[i*4+c]=Math.round(neighborsOf.reduce((s,j)=>s+current[j*4+c],0)/neighborsOf.length);}
    [current,next]=[next,current];
  }
  return {raw:{...raw,data:current},method:'boundary_propagation_harmonic',needsReview:true};
}
const geometricOperations=new Set(['resize','crop','pad','rotate','flip']);
function paddingFrame(raw,p){
  const width=positiveInt(p.width,'width'),height=positiveInt(p.height,'height');
  const x=p.offsetX==null?Math.floor((width-raw.width)/2):Number(p.offsetX),y=p.offsetY==null?Math.floor((height-raw.height)/2):Number(p.offsetY);
  if(!Number.isInteger(x)||!Number.isInteger(y)||x<0||y<0||x+raw.width>width||y+raw.height>height)throw processingError('Padding must contain the whole source');
  return {width,height,x,y};
}
/** Pixel geometry operates in the decoded source frame, whereas layer geometry lives in
 * its parent's canvas coordinates. Keep that existing mapping when changing pixel bounds. */
function processedLayerGeometry(request,base,source,output){
  const target=base.target,op=request.operation,p=request.params||{};
  if(!target||!['crop','pad','rotate'].includes(op))return {};
  const sx=target.width/source.width,sy=target.height/source.height;
  let width=output.width*sx,height=output.height*sy,dx=0,dy=0;
  if(op==='crop'){
    dx=Number(p.x)*sx;dy=Number(p.y)*sy;
  }else if(op==='pad'){
    const frame=paddingFrame(source,p);
    dx=-frame.x*sx;dy=-frame.y*sy;
  }else{
    const degrees=((Number(p.degrees)%360)+360)%360,quarter=degrees/90;
    if(Number.isInteger(quarter)){
      if(quarter%2){width=output.width*sy;height=output.height*sx;}
    }else if(Math.abs(sx-sy)>1e-9*Math.max(1,Math.abs(sx),Math.abs(sy))){
      throw processingError('这张图片在画布上被非等比缩放，任意角度像素旋转会改变拉伸比例。请先恢复等比尺寸，或使用画布旋转；像素旋转目前支持 90° 的倍数。','NONUNIFORM_PIXEL_ROTATION',{status:422,retryable:false});
    }
    dx=(target.width-width)/2;dy=(target.height-height)/2;
  }
  const angle=(target.rotation||0)*Math.PI/180,cos=Math.cos(angle),sin=Math.sin(angle);
  return {x:target.x+dx*cos-dy*sin,y:target.y+dx*sin+dy*cos,width,height};
}
async function geometryBytes(operation,raw,p){
  const image=()=>sharp(raw.data,{raw:{width:raw.width,height:raw.height,channels:4}});
  switch(operation){
    case 'resize':return image().resize(positiveInt(p.width,'width'),positiveInt(p.height,'height'),{fit:'fill',kernel:p.kernel==='nearest'?'nearest':'lanczos3'}).png().toBuffer();
    case 'crop':{
      const x=Number(p.x),y=Number(p.y),width=positiveInt(p.width,'width'),height=positiveInt(p.height,'height');
      if(!Number.isInteger(x)||!Number.isInteger(y)||x<0||y<0||x+width>raw.width||y+height>raw.height)throw processingError('Crop rectangle is outside the source');
      return image().extract({left:x,top:y,width,height}).png().toBuffer();
    }
    case 'pad':{
      const {width,height,x,y}=paddingFrame(raw,p);
      return image().extend({left:x,top:y,right:width-x-raw.width,bottom:height-y-raw.height,background:parseColor(p.fill,{r:0,g:0,b:0,alpha:0})}).png().toBuffer();
    }
    case 'rotate':{
      if(!Number.isFinite(Number(p.degrees)))throw processingError('degrees must be finite');
      return image().rotate(Number(p.degrees),{background:{r:0,g:0,b:0,alpha:0}}).png().toBuffer();
    }
    case 'flip':{
      if(!['horizontal','vertical','x','y'].includes(p.axis))throw processingError('axis must be horizontal or vertical');
      return (['horizontal','x'].includes(p.axis)?image().flop():image().flip()).png().toBuffer();
    }
    default:throw processingError('Unknown pixel geometry operation');
  }
}
function colorPixels(operation,raw,p){
  const out={...raw,data:Buffer.from(raw.data)};
  const color=operation==='erase'?null:parseColor(p.color),tolerance=Math.max(0,Math.min(255,finite(p.tolerance,30)));
  if(operation==='recolor'&&p.mode&&!['flatten','luminance','hsv'].includes(p.mode))throw processingError('Unknown recolor mode');
  for(let i=0;i<raw.width*raw.height;i++){
    const j=i*4;
    if(operation==='recolor'){const rgb=texturedColor([raw.data[j],raw.data[j+1],raw.data[j+2]],color,p);out.data[j]=rgb[0];out.data[j+1]=rgb[1];out.data[j+2]=rgb[2];}
    else if(operation==='fill'){out.data[j]=color.r;out.data[j+1]=color.g;out.data[j+2]=color.b;out.data[j+3]=Math.round(color.alpha*255);}
    else if(operation==='erase')out.data[j+3]=0;
    else if(Math.max(Math.abs(raw.data[j]-color.r),Math.abs(raw.data[j+1]-color.g),Math.abs(raw.data[j+2]-color.b))<=tolerance)out.data[j+3]=0;
  }
  return out;
}
async function processedVisibility(request,ctx,base,current,result,masks){
  const state=await visibilitySource(base,ctx,current),op=request.operation,p=request.params||{};
  let raw=state.raw;
  if(geometricOperations.has(op))raw=await decodeRGBA(await geometryBytes(op,raw,p),'image/png');
  else if(op==='super_resolution')raw=await decodeRGBA(await geometryBytes('resize',raw,{width:result.width,height:result.height}),'image/png');
  else if(['recolor','fill','repair'].includes(op)){
    const transformed=op==='repair'?repairPixels(raw,masks.effective,p).raw:colorPixels(op,raw,p);
    raw=(masks.edit||masks.protect)?compositeProtected(raw,transformed,masks.effective,masks.protect):transformed;
  }
  if(raw.width!==result.width||raw.height!==result.height)throw processingError('Visibility source dimensions do not match processed pixels','MASK_GEOMETRY');
  // The current visible result is authoritative. Preserve its RGB exactly, while retaining
  // known alpha behind masks/erasures. Transparent source pixels never acquire invented RGB.
  const data=Buffer.from(raw.data);
  for(let i=0;i<result.width*result.height;i++){
    const j=i*4;
    if(result.data[j+3]>0){result.data.copy(data,j,j,j+3);data[j+3]=Math.max(raw.data[j+3],result.data[j+3]);}
  }
  const asset=await saveVisibilitySource(request,ctx,state,{...raw,data},`${op}_visible_pixels`);
  return {asset,canExpand:state.canExpand||data.some((alpha,i)=>i%4===3&&alpha>result.data[i])};
}
async function traceSVG(raw,options,ctx){
  if(raw.width*raw.height>(ctx.config?.maxTracePixels||4000000))throw processingError('Image exceeds tracing pixel budget; source retained','PIXEL_BUDGET');
  const data=new Uint8ClampedArray(raw.data);
  return new Promise((resolve,reject)=>{
    const worker=new Worker(`const {parentPort,workerData}=require('node:worker_threads');const tracer=require(workerData.module);try{parentPort.postMessage({svg:tracer.imagedataToSVG({width:workerData.width,height:workerData.height,data:new Uint8ClampedArray(workerData.data)},workerData.options)});}catch(error){parentPort.postMessage({error:error.message});}`,{eval:true,workerData:{module:createRequire(import.meta.url).resolve('imagetracerjs'),width:raw.width,height:raw.height,data,options},transferList:[data.buffer],resourceLimits:{maxOldGenerationSizeMb:384}});
    let settled=false;
    const finish=(error,svg)=>{if(settled)return;settled=true;clearInterval(cancelTimer);clearTimeout(timer);void worker.terminate();error?reject(error):resolve(svg);};
    const cancelTimer=setInterval(()=>{if(ctx.cancelled?.())finish(processingError('Tracing cancelled','CANCELLED',{status:409}));},50);
    const timer=setTimeout(()=>finish(processingError('Tracing time budget exceeded; source retained','CPU_TIMEOUT')),ctx.config?.traceTimeoutMs||60000);
    worker.on('message',r=>finish(r.error?processingError('Tracing failed; source retained','TRACE_FAILED'):null,r.svg));
    worker.on('error',()=>finish(processingError('Tracing worker failed; source retained','TRACE_FAILED')));
    worker.on('exit',code=>{if(!settled)finish(processingError(`Tracing worker exited (${code}); source retained`,'TRACE_FAILED'));});
  });
}
function monochromePixels(raw,p){
  const threshold=p.threshold==null?128:Number(p.threshold),alphaThreshold=p.alphaThreshold==null?128:Number(p.alphaThreshold);
  if(!Number.isFinite(threshold)||threshold<0||threshold>255)throw processingError('Line-art threshold must be in 0..255');
  if(!Number.isInteger(alphaThreshold)||alphaThreshold<1||alphaThreshold>255)throw processingError('Line-art alphaThreshold must be an integer in 1..255');
  const data=Buffer.alloc(raw.data.length);
  for(let i=0;i<raw.width*raw.height;i++){
    const j=i*4;
    if(raw.data[j+3]<alphaThreshold)continue;
    const luminance=.2126*raw.data[j]+.7152*raw.data[j+1]+.0722*raw.data[j+2],value=luminance<threshold?0:255;
    data[j]=data[j+1]=data[j+2]=value;data[j+3]=255;
  }
  return {raw:{...raw,data},metadata:{method:'luminance_threshold',threshold,alphaThreshold,alphaHandling:'below_threshold_transparent_otherwise_opaque',alphaContour:'pixel_boundary_clip'}};
}
function clipMonochromeSVG(svg,raw){
  // Traced curves can antialias across the original transparent boundary. Use merged
  // integer pixel runs as a vector clip, so that no transparent source pixel acquires paint.
  const rectangles=[];let active=new Map();
  for(let y=0;y<raw.height;y++){
    const next=new Map();let x=0;
    while(x<raw.width){
      while(x<raw.width&&raw.data[(y*raw.width+x)*4+3]===0)x++;
      const start=x;while(x<raw.width&&raw.data[(y*raw.width+x)*4+3]!==0)x++;
      if(start===x)continue;
      const key=`${start}:${x}`,prior=active.get(key),rectangle=prior||{x:start,y,width:x-start,height:0};
      rectangle.height++;next.set(key,rectangle);
    }
    for(const [key,rectangle] of active)if(!next.has(key))rectangles.push(rectangle);
    active=next;
  }
  rectangles.push(...active.values());
  const d=rectangles.map(r=>`M${r.x} ${r.y}h${r.width}v${r.height}h${-r.width}z`).join('');
  const open=/<svg\b[^>]*>/.exec(svg),close=svg.lastIndexOf('</svg>');
  if(!open||close<open.index+open[0].length)throw processingError('Tracing returned an invalid SVG','TRACE_FAILED');
  const start=open.index+open[0].length;
  return `${svg.slice(0,start)}<defs><clipPath id="lineart-visible-pixels" clipPathUnits="userSpaceOnUse"><path d="${d}"/></clipPath></defs><g clip-path="url(#lineart-visible-pixels)">${svg.slice(start,close)}</g>${svg.slice(close)}`;
}
async function computeOperation(request,ctx) {
  const op=request.operation,p=request.params||{};
  if(!registry[op])throw processingError(`Unknown operation ${op}`);
  checkpointCancel(ctx);
  if(op==='restore_layers')return restoreLayers(request,ctx);
  if(op==='generate') {
    const outputs=await generateImages(request,ctx);const commands=[],assets=[];
    for(let i=0;i<outputs.length;i++){
      checkpointCancel(ctx);const asset=await saveResult(request,ctx,outputs[i].bytes,outputs[i].mime,outputs[i].metadata,`generated_${i}`);
      commands.push(...layerCommands({...request,targetLayerId:undefined},ctx,asset));assets.push(asset.id);
    }
    return {commands,output:{assetIds:assets},needsReview:true};
  }
  if(op==='export')throw processingError('Exports are handled by the export runner');
  const base=await baseInput(request,ctx);const raw=await decodeTargetRGBA(base,ctx);
  if(op==='prepare_text')return prepareText(request,ctx,base,raw);
  if(op==='refine_mask')return refineMask(request,ctx,base,raw);
  const preparingBackground=p.purpose==='text_background';
  if(preparingBackground&&(!['repair','inpaint','fill'].includes(op)||!unknownTextPatch(base.target)))throw backgroundRequired('文字背景修补需要尚未确认字体的原文字裁片。');
  const masks=await masksFor(request,ctx,raw);
  let out,bytes,mime='image/png',meta={...base.target?.metadata,operation:op,processingSourceAssetId:base.id,...(base.activeMaskId?{sourceMaskAssetId:base.activeMaskId}: {})};
  if(base.target&&base.id!==base.target.assetId){
    for(const key of ['visibilitySourceAssetId','visibilitySourceRect','visibilityCanExpand'])delete meta[key];
    if(!base.activeMaskId)delete meta.sourceMaskAssetId;
  }
  if(op==='trace') {
    // Mode-specific processing facts describe this output, not a previous trace.
    delete meta.traceVersion;delete meta.lineart;
    const options={ltres:1,qtres:1,pathomit:8,numberofcolors:16,mincolorratio:0,scale:1,roundcoords:3,desc:false,viewbox:true};
    const presets={monochrome:{numberofcolors:2,colorsampling:0},color:{numberofcolors:16},logo:{numberofcolors:8,pathomit:0,ltres:.5,qtres:.5},posterized2:{...ImageTracer.optionpresets.posterized2}};
    const preset=p.preset||'posterized2';if(!presets[preset])throw processingError('Unknown tracing preset');
    Object.assign(options,presets[preset]);
    for(const key of ['ltres','qtres','pathomit'])if(p[key]!=null)options[key]=Math.max(0,Math.min(100,finite(p[key],1)));
    if(p.colors!=null)options.numberofcolors=positiveInt(p.colors,'colors',256);
    if(p.blurradius!=null)options.blurradius=Math.max(0,Math.min(5,Math.floor(finite(p.blurradius,0))));
    if(p.blurdelta!=null)options.blurdelta=Math.max(0,Math.min(255,finite(p.blurdelta,20)));
    let traceInput=raw;
    if(preset==='monochrome'){
      const lineart=monochromePixels(raw,p);traceInput=lineart.raw;
      // Never cluster opacity with colours: averaging transparent pixels into a dark
      // palette entry makes opaque halftone dots translucent. A single fixed-palette
      // cycle maps these exact binary pixels without any averaging or blur.
      Object.assign(options,{numberofcolors:3,colorsampling:0,colorquantcycles:1,mincolorratio:0,pathomit:0,blurradius:0,strokewidth:0,linefilter:false,pal:[{r:0,g:0,b:0,a:255},{r:255,g:255,b:255,a:255},{r:0,g:0,b:0,a:0}]});
      meta={...meta,traceVersion:'monochrome-luminance-fixed-alpha-v2',lineart:lineart.metadata};
    }
    let svg=await traceSVG(traceInput,options,ctx);
    if(preset==='monochrome')svg=clipMonochromeSVG(svg,traceInput);
    svg=normalizeSvg(svg).svg;
    bytes=Buffer.from(svg);mime='image/svg+xml';meta={...meta,preset,options,approximation:true};
  } else if(['matting','segment','super_resolution'].includes(op)) {
    const preparedBase={...base,asset:{...base.asset,mime:'image/png',width:raw.width,height:raw.height},bytes:await encodePNG(raw)};
    const result=await runComfy(op,{...request,base:preparedBase},ctx);
    if(op==='segment') {
      const commands=[],ids=[];
      for(let i=0;i<result.masks.length;i++){
        const a=await saveResult(request,ctx,result.masks[i].bytes,'image/png',{...meta,role:'segmentation_mask'},`mask_${i}`);ids.push(a.id);
        commands.push({type:'layer.add',layer:{id:randomUUID(),type:'mask',name:`对象蒙版 ${i+1}`,x:0,y:0,width:a.width,height:a.height,rotation:0,opacity:1,visible:false,locked:false,z:ctx.document.layers.length+i,assetId:a.id,sourceAssetId:base.id,metadata:{...meta,role:'segmentation_mask'}}});
      }
      return {commands,output:{maskAssetIds:ids,backend:result.backend},needsReview:true};
    }
    bytes=result.bytes;out=await decodeRGBA(bytes,result.mime);meta={...meta,...result.metadata};
    if(op==='super_resolution'){
      const scale=Number(p.scale);if(![2,4].includes(scale))throw processingError('Super resolution scale must be 2 or 4');
      if(out.width!==raw.width*scale||out.height!==raw.height*scale)throw processingError('Super-resolution backend returned incorrect dimensions','UPSTREAM_DIMENSIONS',{status:502});
      meta.scale=scale;
      if(raw.data.some((v,i)=>i%4===3&&v!==255)){
        const alpha=await sharp(raw.data,{raw:{width:raw.width,height:raw.height,channels:4}}).extractChannel(3).resize(out.width,out.height,{kernel:'lanczos3'}).raw().toBuffer();
        for(let i=0;i<alpha.length;i++)out.data[i*4+3]=alpha[i];
        meta.alphaResampledFromSource=true;
      }
    }
  } else if(op==='inpaint') {
    if(!masks.edit)throw processingError('Inpaint requires an explicit edit mask');
    const maskRGBA={...raw,data:Buffer.alloc(raw.data.length)};
    for(let i=0;i<masks.effective.length;i++){
      maskRGBA.data[i*4+3]=255-masks.effective[i]; // OpenAI transparent=edit
    }
    // Stable supported frames for the configured GPT Image models, preserving aspect by
    // letterboxing both the source and mask. The adapter maps only the source rectangle back.
    const frame=imageFrameFor(p.model||ctx.config?.imageModel||configFromEnv().imageModel,raw.width,raw.height,ctx.config);
    const scale=Math.min(frame.width/raw.width,frame.height/raw.height),width=Math.max(1,Math.round(raw.width*scale)),height=Math.max(1,Math.round(raw.height*scale));
    const left=Math.floor((frame.width-width)/2),top=Math.floor((frame.height-height)/2);
    const padding={left,top,right:frame.width-width-left,bottom:frame.height-height-top};
    const preparedBase={...base,asset:{...base.asset,mime:'image/png',width:frame.width,height:frame.height},bytes:await sharp(raw.data,{raw:{width:raw.width,height:raw.height,channels:4}}).resize(width,height,{fit:'fill'}).extend({...padding,background:{r:0,g:0,b:0,alpha:0}}).png().toBuffer()};
    const maskBytes=await sharp(maskRGBA.data,{raw:{width:raw.width,height:raw.height,channels:4}}).resize(width,height,{fit:'fill',kernel:'nearest'}).extend({...padding,background:{r:0,g:0,b:0,alpha:1}}).png().toBuffer();
    const result=(await generateImages({...request,base:preparedBase,maskBytes},ctx))[0];
    bytes=result.bytes;out=await decodeRGBA(bytes,result.mime);
    if(out.width!==frame.width||out.height!==frame.height)throw processingError('Inpaint returned different frame dimensions; original preserved','UPSTREAM_DIMENSIONS',{status:502});
    out=await decodeRGBA(await sharp(out.data,{raw:{width:out.width,height:out.height,channels:4}}).extract({left,top,width,height}).resize(raw.width,raw.height,{fit:'fill'}).png().toBuffer(),'image/png');
    meta={...meta,...result.metadata,modelFrame:{...frame,sourceRect:[left,top,width,height],sourceToFrame:[width/raw.width,0,0,height/raw.height,left,top],frameToSource:[raw.width/width,0,0,raw.height/height,-left*raw.width/width,-top*raw.height/height]},resampledToSource:true};
  } else {
    switch(op){
      case 'resize':case 'crop':case 'pad':case 'rotate':case 'flip':bytes=await geometryBytes(op,raw,p);break;
      case 'repair':{
        if(!masks.edit)throw processingError('Traditional repair requires an explicit edit mask');
        const repaired=repairPixels(raw,masks.effective,p);
        if(preparingBackground&&['retained_original','no_edit'].includes(repaired.method))throw backgroundRequired('当前蒙版没有可用的修补上下文，请缩小蒙版或指定背景填色。');
        out=repaired.raw;meta={...meta,method:repaired.method,needsReview:repaired.needsReview,warning:repaired.warning};break;
      }
      case 'recolor':case 'erase':case 'color_key':case 'fill':{
        out=colorPixels(op,raw,p);
        if(op==='recolor')meta.mode=p.mode|| (p.preserveLuminance===false?'flatten':'luminance');
        break;
      }
      default:throw processingError(`Operation ${op} has no processor`);
    }
  }
  checkpointCancel(ctx);
  if(mime==='image/png'){
    out||=await decodeRGBA(bytes,mime);
    if(masks.edit||masks.protect)out=compositeProtected(raw,out,masks.effective,masks.protect);
    bytes=await encodePNG(out);
    meta.protectedPixelsExact=true;
  }else if(masks.edit||masks.protect)throw processingError('Vector tracing with pixel masks is not supported; source preserved','MASK_GEOMETRY');
  // Calculate (and validate) layout before saving either output or visibility provenance.
  const geometry=processedLayerGeometry(request,base,raw,out);
  if(preparingBackground){
    const asset=await saveResult(request,ctx,bytes,mime,meta);
    const metadata=base.target.metadata||{};
    return {commands:[{type:'layer.update',layerId:base.target.id,patch:{metadata:{...metadata,...meta,cleanBackgroundAssetId:asset.id,backgroundStatus:'ready',backgroundMethod:op,sourcePatchAssetId:metadata.sourcePatchAssetId||base.id,fontStatus:'unknown',fontConfirmed:false}}}],output:{assetId:asset.id,cleanBackgroundAssetId:asset.id,cleanBgAssetId:asset.id,sourcePatchAssetId:metadata.sourcePatchAssetId||base.id,width:asset.width,height:asset.height,metadata:meta},needsReview:op!=='fill'};
  }
  const clearVectorPaint=op==='trace'||mime==='image/png'&&(base.asset.mime==='image/svg+xml'||base.target?.type==='vector');
  if(clearVectorPaint)delete meta.pathStyles;
  let saveRequest=request;
  if(mime==='image/png'){
    const visibility=await processedVisibility(request,ctx,base,raw,out,masks);
    meta={...meta,visibilitySourceAssetId:visibility.asset.id,visibilitySourceRect:[0,0,out.width,out.height],visibilityCanExpand:visibility.canExpand};
    if(geometricOperations.has(op)||op==='super_resolution'){
      // Stored screen selections use the old pixel frame, even when a flip/rotation keeps
      // its dimensions. Require a fresh selection rather than silently editing wrong pixels.
      for(const key of ['editMaskAssetId','protectMaskAssetId','visibilityMaskAssetId','visibilityProtectMaskAssetId']){
        if(typeof meta[key]==='string')meta[`previous${key[0].toUpperCase()}${key.slice(1)}`]=meta[key];
        meta[key]=null;
      }
    }
    saveRequest={...request,inputs:[...(request.inputs||[]),{role:'visibility_source',assetId:visibility.asset.id}]};
  }
  const asset=await saveResult(saveRequest,ctx,bytes,mime,meta);
  const differentBase=base.target&&base.id!==base.target.assetId;
  return {commands:layerCommands(request,ctx,asset,{...geometry,clearVectorPaint,clearSourceMask:differentBase&&!base.activeMaskId,sourceAssetId:differentBase?base.id:base.target?.sourceAssetId||base.id,...(differentBase?{sourceRect:null}:{}),...(op==='trace'?{type:'vector',editability:'path'}:{type:'raster',editability:'pixels'})}),output:{assetId:asset.id,width:asset.width,height:asset.height,metadata:meta},needsReview:['matting','inpaint','trace'].includes(op)||meta.needsReview===true};
}

export async function executeOperation(request,ctx){
  if(ctx.checkpoints?.processorResult)return ctx.checkpoints.processorResult;
  const result=await computeOperation(request,ctx);
  // Includes stable layer IDs; a recovered job must not regenerate commands after commit.
  await ctx.checkpoint({processorResult:result});
  return result;
}

export async function capabilities(config={},fetchImpl=fetch) {
  const providers=await providerCapabilities(config,fetchImpl);
  return {operations:Object.entries(registry).map(([operation,item])=>({operation,...item,available:item.executionClass==='cpu'||operation==='restore_layers'||Boolean(providers[operation]?.ready),...providers[operation]})),providers};
}
