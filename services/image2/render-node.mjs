import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
import * as fontkit from 'fontkit';
import {Resvg} from '@resvg/resvg-js';
import {normalizeSvg} from './svg-normalize.mjs';
import {pdfFontBytes} from './fonts.mjs';
import {prepareRenderGraph,renderError} from './core/render-graph.mjs';
import {rectArray} from './core/matrix.mjs';
import {renderSoftware} from './core/render-software.mjs';
const require=createRequire(import.meta.url),hash=b=>createHash('sha256').update(b).digest('hex');let kitPromise;
export async function loadCanvasKit(options={}){if(options.modulePath){const init=require(options.modulePath);return init({locateFile:file=>join(dirname(options.modulePath),file)});}if(!kitPromise)kitPromise=(async()=>{const init=(await import('canvaskit-wasm')).default;const wasm=fileURLToPath(import.meta.resolve('canvaskit-wasm/bin/canvaskit.wasm'));return init({locateFile:file=>join(dirname(wasm),file)});})().catch(e=>{kitPromise=undefined;throw e;});return kitPromise;}
function payload(record,kind){let p;try{p=JSON.parse(record.bytes.toString('utf8'));}catch{throw renderError('Content JSON cannot be decoded');}if(!p||typeof p!=='object'||Array.isArray(p)||p.formatVersion!==1||(kind&&p.kind!==kind))throw renderError('Unsupported content format version');return p;}
const hex=value=>value||'#20232b';
function glyphs(face,p){const size=p.fontSize||24,leading=size*(p.lineHeight||1.2),scale=size/face.unitsPerEm,paths=[];for(const[lineIndex,line]of String(p.text||'').split('\n').entries()){let x=0,y=0;const run=face.layout(line.replace(/[\p{Cc}\p{Cf}]/gu,''));for(const[index,g]of run.glyphs.entries()){const pos=run.positions[index];paths.push({d:g.path.toSVG(),matrix:[scale,0,0,-scale,x+pos.xOffset*scale,size+lineIndex*leading-y-pos.yOffset*scale],fill:hex(p.fill),...(p.stroke?{stroke:p.stroke,strokeWidth:(p.strokeWidth??1)/scale}:{})});x+=pos.xAdvance*scale+(index<run.glyphs.length-1?p.tracking||0:0);y+=pos.yAdvance*scale;}}return paths;}
/** The caller supplies an owner-checked immutable resolver. It is invoked for every recursive source/font reference. */
export function createNodeResolver(getAsset,{maxPixels=40000000}={}){
 const records=new Map();async function get(id){if(!records.has(id)){const r=await getAsset(id);if(!r?.asset||!r.bytes)throw renderError('Owned asset unavailable');if(r.asset.hash&&hash(r.bytes)!==r.asset.hash)throw renderError('Immutable asset integrity failed');records.set(id,r);}return records.get(id);}
 async function raster(record,bounds){const{data,info}=await sharp(record.bytes,{limitInputPixels:maxPixels}).autoOrient().toColourspace('srgb').ensureAlpha().raw().toBuffer({resolveWithObject:true});return{kind:'raster',pixels:new Uint8Array(data),width:info.width,height:info.height,bounds:bounds?rectArray(bounds):[0,0,info.width,info.height],hash:hash(record.bytes),sourceAssetId:record.asset.id};}
 return async function resolve(content,{layer,document,role}){
  if(!document.assetIds.includes(content.assetId))throw renderError('Content asset is not registered');
  const ownedGet=async id=>{if(!document.assetIds.includes(id))throw renderError('Recursive content resource is not registered','RENDER_ASSET_SCOPE');return get(id);};
  const r=await ownedGet(content.assetId);
  if(content.kind==='raster')return raster(r);
  if(content.kind==='preservedText'){const p=payload(r,content.kind),source=await ownedGet(p.assetId);return{...await raster(source),hash:hash(Buffer.concat([r.bytes,source.bytes])),sourceAssetId:source.asset.id,preserved:true};}
  if(content.kind==='text'){const p=payload(r,content.kind);if(p.align&&p.align!=='left')throw renderError('Non-left text layout is not installed','RENDER_TEXT_UNAVAILABLE');if(p.mode&&p.mode!=='legacy-lines')throw renderError('Text layout mode is not installed','RENDER_TEXT_UNAVAILABLE');const fr=await ownedGet(p.fontAssetId);if(!fr.asset.mime.startsWith('font/'))throw renderError('Text requires an actual font');let face;try{face=fontkit.create(fr.bytes);}catch{throw renderError('Invalid actual font');}for(const c of new Set(p.text||''))if(!/[\p{Cc}\p{Cf}]/u.test(c)&&!face.hasGlyphForCodePoint(c.codePointAt(0)))throw renderError('Font has a missing glyph','FONT_GLYPH_MISSING');return{kind:'paths',paths:glyphs(face,p),hash:hash(Buffer.concat([r.bytes,fr.bytes])),sourceAssetId:r.asset.id,fontAssetId:fr.asset.id};}
  if(content.kind==='vector'&&r.asset.mime!=='image/svg+xml'){const p=payload(r,content.kind);if(p.resources&&Object.keys(p.resources).length)throw renderError('Structured resource paints are not yet installed','RENDER_VECTOR_RESOURCE_UNAVAILABLE');if(!Array.isArray(p.paths)||p.paths.length>100000)throw renderError('Invalid structured path count');return{kind:'paths',paths:p.paths,hash:hash(r.bytes),sourceAssetId:r.asset.id};}
  if(content.kind==='svg'||r.asset.mime==='image/svg+xml'){
   const p=r.asset.mime==='image/svg+xml'?null:payload(r,content.kind),source=p?await ownedGet(p.sourceAssetId):r,sourceText=source.bytes.toString('utf8'),fontIds=[...new Set(p?.fontAssetIds||[])];
   if(p?.appearanceAssetId){const appearance=await ownedGet(p.appearanceAssetId);return{...await raster(appearance,role==='content'?layer.localBounds:undefined),sourceAssetId:source.asset.id,appearanceProxy:true,hash:hash(Buffer.concat([r.bytes,source.bytes,appearance.bytes]))};}
   const normalized=normalizeSvg(sourceText,{scope:`v3_${layer.id}`,fill:p?.fill,styles:p?.pathStyles?Object.fromEntries(Object.entries(p.pathStyles).map(([id,style])=>{if(style.opacity!==undefined&&style.opacity!==1)throw renderError('Per-path opacity is not installed','RENDER_PATH_OPACITY_UNAVAILABLE');return[id,{...style,...(style.strokeWidth===undefined?{}:{'stroke-width':style.strokeWidth})}];})):undefined,fallbackWidth:source.asset.width,fallbackHeight:source.asset.height,preserveAspectRatio:'none'}),fontFiles=[],refs=[source.bytes],hasText=/<(?:[\w-]+:)?(?:text|tspan)\b/i.test(sourceText);let directory;
   if(hasText&&!fontIds.length)throw renderError('SVG text requires explicit actual fonts','SVG_FONT_REQUIRED');
   try{if(fontIds.length){directory=await mkdtemp(join(tmpdir(),'image2-v3-fonts-'));for(const id of fontIds){if(!document.assetIds.includes(id))throw renderError('Font source not registered');const font=await ownedGet(id);if(font.bytes.toString('ascii',0,4)==='wOFF')throw renderError('WOFF1 SVG rendering is unavailable','SVG_FONT_CONTAINER_UNAVAILABLE');const bytes=await pdfFontBytes(font.bytes),file=join(directory,`${fontFiles.length}.ttf`);await writeFile(file,bytes);fontFiles.push(file);refs.push(font.bytes);}}
    const renderer=new Resvg(normalized.svg,{font:{loadSystemFonts:false,fontFiles}});if(renderer.width*renderer.height>maxPixels)throw renderError('SVG proxy exceeds pixel budget');const proxy=await raster({asset:{id:source.asset.id},bytes:Buffer.from(renderer.render().asPng())},role==='content'?layer.localBounds:normalized.viewBox);return{...proxy,hash:hash(Buffer.concat([r.bytes,...refs])),sourceAssetId:source.asset.id,appearanceProxy:true};
   }finally{if(directory)await rm(directory,{recursive:true,force:true});}
  }
  throw renderError('Content format has no installed renderer','RENDER_CONTENT_UNAVAILABLE');
 };
}
export async function renderNode(document,getAsset,options={}){const graph=await prepareRenderGraph(document,createNodeResolver(getAsset,options),options);const kit=options.engine||await loadCanvasKit(options);const pixels=await renderSoftware(kit,graph,options);const png=await sharp(pixels.pixels,{raw:{width:pixels.width,height:pixels.height,channels:4}}).png().toBuffer();return{...pixels,png,graph,cacheKey:hash(Buffer.from(graph.cacheMaterial)),sourceAssetIds:[...new Set(Object.values(graph.resources).map(r=>r.sourceAssetId))]};}
/** Owner-checked resource endpoint helper; returns pure, transferable render input, never provider data. */
export async function resolveNodeResource(document,contentId,getAsset,options={}){
 const content=(Array.isArray(document.contentAssets)?document.contentAssets:Object.values(document.contentAssets||{})).find(c=>c.id===contentId);
 if(!content)throw renderError('Unknown document content');
 const layer=document.layers.find(l=>l.contentId===contentId&&(!options.layerId||l.id===options.layerId))||document.layers.find(l=>(l.masks||[]).some(m=>m.contentId===contentId));
 if(!layer)throw renderError('Content has no authored layer or mask reference');
 return createNodeResolver(getAsset,options)(content,{layer,document,role:layer.contentId===contentId?'content':'mask'});
}
