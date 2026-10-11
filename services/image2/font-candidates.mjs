import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import * as fontkit from 'fontkit';

const MAX_FACES=3,MAX_REGISTERED_READS=12,MAX_REGISTERED_BYTES=48*1024*1024;
const builtinPath=fileURLToPath(new URL('./fonts/NotoSansCJKsc-Regular.otf',import.meta.url));
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const fontMime=mime=>/^(?:font\/(?:ttf|otf|woff2?)|application\/(?:x-font-ttf|x-font-opentype|font-woff))$/.test(mime||'');
const round=value=>Math.round(value*1000)/1000;

/** A clear border permits measuring contrasting visible glyph pixels; otherwise use the OCR rectangle only. */
export function sourceGlyphGeometry(raw){
  const fallback={x:0,y:0,width:raw.width,height:raw.height,measurement:'ocr_rectangle',reason:'background_not_separable'};
  if(!raw.width||!raw.height||raw.width*raw.height>4000000)return {...fallback,reason:'measurement_budget'};
  const border=[];for(let y=0;y<raw.height;y++)for(let x=0;x<raw.width;x++)if(x===0||y===0||x===raw.width-1||y===raw.height-1)border.push((y*raw.width+x)*4);
  const bins=new Map();for(const j of border){const key=[0,1,2,3].map(c=>raw.data[j+c]>>4).join(',');const bin=bins.get(key)||[];bin.push(j);bins.set(key,bin);}
  const dominant=[...bins.values()].sort((a,b)=>b.length-a.length)[0];if(!dominant||dominant.length/border.length<.9)return fallback;
  const background=[0,1,2,3].map(c=>{const v=dominant.map(j=>raw.data[j+c]).sort((a,b)=>a-b);return v[Math.floor(v.length/2)];});
  const distance=j=>Math.max(...[0,1,2,3].map(c=>Math.abs(raw.data[j+c]-background[c])));
  if(border.filter(j=>distance(j)<=16).length/border.length<.94)return fallback;
  let x0=raw.width,y0=raw.height,x1=-1,y1=-1,pixels=0;
  for(let y=0;y<raw.height;y++)for(let x=0;x<raw.width;x++){const j=(y*raw.width+x)*4;if(raw.data[j+3]>0&&distance(j)>20){x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x);y1=Math.max(y1,y);pixels++;}}
  if(!pixels||pixels/(raw.width*raw.height)>.65)return {...fallback,reason:'glyph_pixels_not_identifiable'};
  return {x:x0,y:y0,width:x1-x0+1,height:y1-y0+1,measurement:'source_glyph_bounds',contrastingPixels:pixels};
}

function faceGeometry(face,text){
  const lines=text.split(/\r?\n/);let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
  for(const [lineIndex,line] of lines.entries()){
    const run=face.layout(line);let penX=0,penY=-lineIndex*face.unitsPerEm*1.2;
    for(const [index,glyph] of run.glyphs.entries()){
      const pos=run.positions[index],box=glyph.bbox;
      if(box.maxX>box.minX&&box.maxY>box.minY){const x=penX+pos.xOffset,y=penY+pos.yOffset;x0=Math.min(x0,x+box.minX);x1=Math.max(x1,x+box.maxX);y0=Math.min(y0,y+box.minY);y1=Math.max(y1,y+box.maxY);}
      penX+=pos.xAdvance;penY+=pos.yAdvance;
    }
  }
  if(!Number.isFinite(x0)||x1<=x0||y1<=y0)return null;
  return {width:(x1-x0)/face.unitsPerEm,height:(y1-y0)/face.unitsPerEm};
}

/** Bounded CPU geometry suggestions. No face recognition, original-font inference, remote fetch, or automatic confirmation. */
export async function createFontCandidateFitter(ctx){
  const faces=[],hashes=new Set(),saved=new Map();let registeredBytes=0;
  const add=(record,builtin=false)=>{
    if(faces.length>=MAX_FACES||!Buffer.isBuffer(record.bytes)||record.bytes.length>32*1024*1024)return;
    const hash=digest(record.bytes);if(hashes.has(hash))return;
    try{const face=fontkit.create(record.bytes);if(face.fonts||!face.unitsPerEm||typeof face.layout!=='function'||typeof face.hasGlyphForCodePoint!=='function')return;hashes.add(hash);faces.push({...record,face,hash,builtin});}catch{/* Invalid/unsupported font data is not a candidate. */}
  };
  const ids=[...new Set([...ctx.document.layers.map(l=>l.fontAssetId).filter(Boolean),...ctx.document.assetIds||[]])].slice(0,MAX_REGISTERED_READS);
  for(const id of ids){
    if(faces.length>=MAX_FACES-1||registeredBytes>=MAX_REGISTERED_BYTES)break;
    try{const record=await ctx.getAsset(id);registeredBytes+=record.bytes.length;if(registeredBytes>MAX_REGISTERED_BYTES)break;if(fontMime(record.asset.mime))add(record);}catch{/* Source assets remain untouched if a registered font is unavailable. */}
  }
  try{add({asset:{name:'NotoSansCJKsc-Regular.otf',mime:'font/otf'},bytes:await readFile(ctx.config?.defaultFontPath||builtinPath)},true);}catch{/* No runtime installation or download; no built-in candidate if missing. */}
  return async function fit(text,raw,{scaleX=1,scaleY=1}={}){
    text=String(text||'').replace(/[\p{Cc}\p{Cf}]/gu,c=>c==='\n'?'\n':'');
    const glyphs=[...text].filter(c=>!/^\s$/u.test(c));if(!glyphs.length||glyphs.length>256||text.split('\n').length>4)return [];
    const source=sourceGlyphGeometry(raw),width=source.width*scaleX,height=source.height*scaleY,candidates=[];
    if(!(width>0&&height>0))return [];
    for(const item of faces){
      let supported=0;for(const char of glyphs)if(item.face.hasGlyphForCodePoint(char.codePointAt(0)))supported++;
      if(supported!==glyphs.length)continue;
      const geometry=faceGeometry(item.face,text);if(!geometry)continue;
      const size=(width*geometry.width+height*geometry.height)/(geometry.width**2+geometry.height**2);if(!Number.isFinite(size)||size<1||size>4096)continue;
      const fittedWidth=geometry.width*size,fittedHeight=geometry.height*size,widthError=Math.abs(fittedWidth-width)/width,heightError=Math.abs(fittedHeight-height)/height;
      const aspectRatioError=Math.abs(geometry.width/geometry.height-width/height)/(width/height),sizeError=Math.hypot(fittedWidth-width,fittedHeight-height)/Math.hypot(width,height);
      let asset=saved.get(item.hash);
      if(!asset){asset=await ctx.saveAsset(`restore_font_candidate_${item.hash}`,{name:item.asset.name||`${item.face.postscriptName||'candidate'}.font`,mime:item.asset.mime,inputs:item.asset.id?[{role:'font_candidate_source',assetId:item.asset.id,hash:item.hash}]:[],metadata:{family:item.face.familyName,postscriptName:item.face.postscriptName,role:'font_candidate',builtin:item.builtin,...(item.builtin?{license:'SIL OFL 1.1'}:{})}},item.bytes);saved.set(item.hash,asset);}
      candidates.push({fontAssetId:asset.id,family:item.face.familyName,postscriptName:item.face.postscriptName,glyphCoverage:{supported,total:glyphs.length,ratio:1},estimatedFontSize:round(size),originalFont:'unknown',requiresManualConfirmation:true,geometryFit:{method:'fontkit_ink_bounds',coordinateSpace:'document',measurement:source.measurement,sourceBounds:{x:source.x,y:source.y,width:source.width,height:source.height},measuredWidth:round(width),measuredHeight:round(height),fittedWidth:round(fittedWidth),fittedHeight:round(fittedHeight),widthError:round(widthError),heightError:round(heightError),aspectRatioError:round(aspectRatioError),sizeError:round(sizeError),score:round(1/(1+sizeError+aspectRatioError)),limitation:'Geometry fit only; this does not identify the original font or match glyph style.'}});
    }
    return candidates.sort((a,b)=>b.geometryFit.score-a.geometryFit.score).slice(0,MAX_FACES);
  };
}
