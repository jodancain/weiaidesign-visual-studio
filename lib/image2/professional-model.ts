import type { ContentDescriptor, DocumentCommand, ImageDocument, ImageLayer, LayerEffect, LayerMask, Matrix2D } from './types';
import type { QueuedBatch } from './queue';

export const PROFESSIONAL_IDENTITY: Matrix2D = [1, 0, 0, 1, 0, 0];
export const PROFESSIONAL_CONTENT_MIME = 'application/vnd.weiai.image2-content+json';
export interface PixelBounds { x: number; y: number; width: number; height: number }
export type RawProfessionalLayer = Pick<ImageLayer, 'id' | 'type' | 'name' | 'z' | 'visible' | 'locked' | 'opacity' | 'metadata'> & {
  parentId?: string; contentId?: string; localBounds: PixelBounds; matrix: Matrix2D;
  blendMode: string; compositeMode: 'isolated' | 'passthrough'; clipToLayerId?: string;
  masks: LayerMask[]; effects: LayerEffect[];
};
export type RawProfessionalDocument = Omit<ImageDocument, 'schemaVersion' | 'layers' | 'contentAssets' | 'artboards' | 'guides' | 'savedSelections'> & {
  schemaVersion: 3; layers: RawProfessionalLayer[]; contentAssets: ContentDescriptor[];
  artboards: NonNullable<ImageDocument['artboards']>; guides: NonNullable<ImageDocument['guides']>;
  savedSelections: NonNullable<ImageDocument['savedSelections']>;
};
export type ContentPayload = Record<string, unknown>;
export type ContentPayloads = Readonly<Record<string, ContentPayload>> | ReadonlyMap<string, ContentPayload>;
export class ProfessionalModelError extends Error {
  constructor(message: string, public code = 'invalid_request', public status = 422) { super(message); this.name = 'ProfessionalModelError'; }
}
const requireValue: (condition: unknown, message: string, code?: string, status?: number) => asserts condition = (condition, message, code, status) => {
  if (!condition) throw new ProfessionalModelError(message, code, status);
};
const copy = <T>(value: T): T => structuredClone(value);
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 1e7;
const id = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const object = (value: unknown, label: string): Record<string, unknown> => {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  return value as Record<string, unknown>;
};
function fields(value: object, keys: readonly string[], label: string) { requireValue(Object.keys(value).every(k => keys.includes(k)), `unsupported ${label} property`); }
function canonical(value: unknown): string {
  const visit = (v: unknown, depth: number): unknown => {
    requireValue(depth <= 64, 'JSON nesting exceeds limit');
    if (Array.isArray(v)) return v.map(x => visit(x, depth + 1));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).filter(([, x]) => x !== undefined).map(([k, x]) => [k, visit(x, depth + 1)]));
    return v;
  };
  return JSON.stringify(visit(value, 0));
}
export function asProfessional(document: ImageDocument | RawProfessionalDocument): RawProfessionalDocument {
  requireValue(document.schemaVersion === 3, 'Professional commands require a v3 document', 'unsupported_schema');
  return document as unknown as RawProfessionalDocument;
}
export function matrix(value: readonly number[]): Matrix2D {
  requireValue(Array.isArray(value) && value.length === 6 && value.every(finite), 'invalid six-parameter matrix');
  return [...value] as Matrix2D;
}
export function multiplyMatrix(a: readonly number[], b: readonly number[]): Matrix2D {
  matrix(a); matrix(b);
  return matrix([a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1], a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3], a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]]);
}
export function inverseMatrix(value: readonly number[]): Matrix2D {
  const m = matrix(value), det = m[0]*m[3]-m[1]*m[2];
  requireValue(Number.isFinite(det) && Math.abs(det) > 1e-12, '父图层变换不可逆，请恢复缩放后再执行世界坐标变换', 'MATRIX_NOT_INVERTIBLE');
  return matrix([m[3]/det,-m[1]/det,-m[2]/det,m[0]/det,(m[2]*m[5]-m[3]*m[4])/det,(m[1]*m[4]-m[0]*m[5])/det]);
}
export function transformPoint(m: readonly number[], point: {x:number;y:number}) {
  matrix(m); requireValue(finite(point.x) && finite(point.y), 'invalid point');
  return { x:m[0]*point.x+m[2]*point.y+m[4], y:m[1]*point.x+m[3]*point.y+m[5] };
}
export function localBounds(value: unknown): PixelBounds {
  const v=object(value,'bounds'); fields(v,['x','y','width','height'],'bounds');
  requireValue(['x','y','width','height'].every(k=>finite(v[k])) && Number(v.width)>=0 && Number(v.height)>=0, 'invalid bounds');
  return copy(v) as unknown as PixelBounds;
}
export function unionBounds(values: readonly PixelBounds[]): PixelBounds {
  requireValue(values.length > 0, 'bounds require at least one rectangle');
  values.forEach(localBounds);
  const x=Math.min(...values.map(b=>b.x)), y=Math.min(...values.map(b=>b.y));
  return {x,y,width:Math.max(...values.map(b=>b.x+b.width))-x,height:Math.max(...values.map(b=>b.y+b.height))-y};
}
export function transformBounds(m: readonly number[], value: PixelBounds): PixelBounds {
  const b=localBounds(value), points=[[b.x,b.y],[b.x+b.width,b.y],[b.x,b.y+b.height],[b.x+b.width,b.y+b.height]].map(([x,y])=>transformPoint(m,{x,y}));
  const x=Math.min(...points.map(p=>p.x)), y=Math.min(...points.map(p=>p.y));
  return {x,y,width:Math.max(...points.map(p=>p.x))-x,height:Math.max(...points.map(p=>p.y))-y};
}
export function worldMatrix(document: ImageDocument | RawProfessionalDocument, layerId: string): Matrix2D {
  const d=asProfessional(document), byId=new Map(d.layers.map(l=>[l.id,l])), chain: Matrix2D[]=[], seen=new Set<string>();
  let layer=byId.get(layerId); requireValue(layer,'layer not found','not_found',404);
  while(layer) {
    requireValue(!seen.has(layer.id),'cyclic layer groups'); seen.add(layer.id); chain.unshift(matrix(layer.matrix));
    if (!layer.parentId) break;
    const parent=byId.get(layer.parentId); requireValue(parent?.type==='group','layer parent must be a group'); layer=parent;
  }
  return chain.reduce(multiplyMatrix,matrix(PROFESSIONAL_IDENTITY));
}
export function worldBounds(document: ImageDocument | RawProfessionalDocument, layerId: string): PixelBounds {
  const d=asProfessional(document), seen=new Set<string>();
  const visit=(key:string):PixelBounds=>{
    requireValue(!seen.has(key),'cyclic layer groups'); seen.add(key);
    const layer=d.layers.find(l=>l.id===key); requireValue(layer,'layer not found','not_found',404);
    const children=layer.type==='group'?d.layers.filter(l=>l.parentId===key):[];
    const result=children.length?unionBounds(children.map(l=>visit(l.id))):transformBounds(worldMatrix(d,key),layer.localBounds);
    seen.delete(key); return result;
  };
  return visit(layerId);
}
export interface ProxyGeometry { x:number; y:number; width?:number; height?:number; w?:number; h?:number; rotation?:number; props?:{w:number;h:number} }
/** tldraw rotations are radians. The proxy maps its unit rectangle to document space. */
export function proxyMatrix(proxy: ProxyGeometry): Matrix2D {
  const w=proxy.width??proxy.w??proxy.props?.w, h=proxy.height??proxy.h??proxy.props?.h, r=proxy.rotation??0;
  requireValue(finite(proxy.x)&&finite(proxy.y)&&finite(w)&&finite(h)&&w>0&&h>0&&finite(r),'invalid proxy geometry');
  const c=Math.cos(r),s=Math.sin(r); return matrix([c*w,s*w,-s*h,c*h,proxy.x,proxy.y]);
}
/** A proxy resize/rotation multiplies the full raw matrix; no scale/rotation decomposition loses shear. */
export function deriveWorldDelta(before: ProxyGeometry, after: ProxyGeometry): Matrix2D {
  // Hit proxies have a minimum one-pixel box. A tiny/empty source must not gain scale merely on drag.
  const baseline=after.props?{...before,width:Math.max(1,before.width??before.w??before.props?.w??0),height:Math.max(1,before.height??before.h??before.props?.h??0)}:before;
  return multiplyMatrix(proxyMatrix(after),inverseMatrix(proxyMatrix(baseline)));
}
export function maskWorldMatrix(document: ImageDocument | RawProfessionalDocument, layerId:string, mask:LayerMask): Matrix2D {
  return mask.coordinateSpace==='document'?matrix(mask.matrix):multiplyMatrix(worldMatrix(document,layerId),mask.matrix);
}
export function linkedMaskAfterTransform(oldWorld:readonly number[], newWorld:readonly number[], mask:LayerMask): LayerMask {
  const result=copy(mask);
  if (!mask.linked && mask.coordinateSpace==='layerLocal') result.matrix=multiplyMatrix(multiplyMatrix(inverseMatrix(newWorld),oldWorld),mask.matrix);
  else if(mask.linked && mask.coordinateSpace==='document') result.matrix=multiplyMatrix(multiplyMatrix(newWorld,inverseMatrix(oldWorld)),mask.matrix);
  return result;
}
export function clippingBase(document: ImageDocument | RawProfessionalDocument, layerId:string):RawProfessionalLayer|undefined {
  const d=asProfessional(document), l=d.layers.find(v=>v.id===layerId); requireValue(l,'layer not found','not_found',404);
  if (!l.clipToLayerId) return undefined;
  const base=d.layers.find(v=>v.id===l.clipToLayerId);
  requireValue(base&&base.id!==l.id&&base.parentId===l.parentId&&base.z<l.z,'clipping base must be a lower sibling layer'); return base;
}
function safeMetadata(value:unknown) {
  if (value===undefined) return;
  object(value,'metadata'); requireValue(canonical(value).length<=2000000,'metadata too large');
  const walk=(v:unknown,depth=0)=>{ requireValue(depth<=64,'metadata nesting exceeds limit'); if (!v||typeof v!=='object') return; for(const [k,x] of Object.entries(v)){requireValue(!['paths','paragraphs','runs','tiles','pixels','shader','script'].includes(k),'drawing content belongs in immutable content assets');walk(x,depth+1);} };
  walk(value);
}
function normalizeMask(value:unknown):LayerMask {
  const v=object(value,'mask'); fields(v,['id','kind','contentId','channel','coordinateSpace','matrix','linked','enabled','inverted','density','featherPx'],'mask');
  const m={channel:'alpha',coordinateSpace:'layerLocal',matrix:matrix(PROFESSIONAL_IDENTITY),linked:true,enabled:true,inverted:false,density:1,featherPx:0,...copy(v)} as unknown as LayerMask;
  requireValue(id(m.id)&&id(m.contentId)&&['raster','vector'].includes(m.kind),'invalid mask identity');
  requireValue(['alpha','luminance'].includes(m.channel)&&['layerLocal','document'].includes(m.coordinateSpace),'invalid mask coordinates'); m.matrix=matrix(m.matrix);
  requireValue(['linked','enabled','inverted'].every(k=>typeof (m as unknown as Record<string,unknown>)[k]==='boolean'),'invalid mask flags');
  requireValue(finite(m.density)&&m.density>=0&&m.density<=1&&finite(m.featherPx)&&m.featherPx>=0&&m.featherPx<=256,'invalid mask density or feather');return m;
}
function normalizeEffect(value:unknown):LayerEffect {
  const v=object(value,'effect');fields(v,['id','type','enabled','params'],'effect');const e={enabled:true,...copy(v)} as unknown as LayerEffect;
  requireValue(id(e.id)&&typeof e.enabled==='boolean','invalid effect identity');object(e.params,'effect params');
  if(e.type==='colorMatrix'){fields(e.params,['matrix'],'color matrix');requireValue(Array.isArray(e.params.matrix)&&e.params.matrix.length===20&&e.params.matrix.every(n=>typeof n==='number'&&Number.isFinite(n)),'color matrix requires 20 finite values');}
  else if(e.type==='gaussianBlur'){fields(e.params,['sigma'],'blur');requireValue(finite(e.params.sigma)&&e.params.sigma>=0&&e.params.sigma<=256,'invalid gaussian blur sigma');}
  else requireValue(false,'图层效果尚不可用，请保留原内容','unsupported_feature');return e;
}
const LAYER_FIELDS=['id','type','name','parentId','z','visible','locked','opacity','contentId','localBounds','matrix','blendMode','compositeMode','clipToLayerId','masks','effects','metadata'];
function normalizeLayer(value:unknown):RawProfessionalLayer {
  const v=object(value,'layer');fields(v,LAYER_FIELDS,'layer');
  const l={name:v.type||'Layer',z:0,visible:true,locked:false,opacity:1,localBounds:{x:0,y:0,width:1,height:1},matrix:matrix(PROFESSIONAL_IDENTITY),blendMode:'normal',compositeMode:'isolated',masks:[],effects:[],...copy(v)} as unknown as RawProfessionalLayer;
  requireValue(id(l.id)&&['raster','vector','text','group','mask','adjustment'].includes(l.type),'invalid layer identity');
  requireValue(typeof l.name==='string'&&l.name.length<=500&&finite(l.z)&&typeof l.visible==='boolean'&&typeof l.locked==='boolean','invalid layer properties');
  requireValue(finite(l.opacity)&&l.opacity>=0&&l.opacity<=1,'invalid layer opacity');l.localBounds=localBounds(l.localBounds);l.matrix=matrix(l.matrix);
  for(const k of ['parentId','contentId','clipToLayerId'] as const) if(l[k]!==undefined)requireValue(id(l[k]),`invalid ${k}`);
  requireValue(['normal','multiply','screen','overlay','darken','lighten','difference','exclusion'].includes(l.blendMode),'混合模式尚不可用','unsupported_feature');
  requireValue(['isolated','passthrough'].includes(l.compositeMode)&&(l.type==='group'||l.compositeMode==='isolated'),'invalid group composite mode');
  requireValue(Array.isArray(l.masks)&&l.masks.length<=100,'invalid layer masks');l.masks=l.masks.map(normalizeMask);requireValue(new Set(l.masks.map(m=>m.id)).size===l.masks.length,'duplicate mask identity');
  requireValue(Array.isArray(l.effects)&&l.effects.length<=20,'invalid layer effects');l.effects=l.effects.map(normalizeEffect);requireValue(new Set(l.effects.map(e=>e.id)).size===l.effects.length,'duplicate effect identity');
  requireValue(l.type!=='adjustment','调整图层尚不可用','unsupported_feature');
  if(l.compositeMode==='passthrough')requireValue(l.opacity===1&&l.blendMode==='normal'&&!l.effects.some(e=>e.enabled)&&!l.masks.some(m=>m.enabled),'穿透组上的透明度、效果或蒙版尚不可用','unsupported_feature');
  requireValue(l.type==='group'?l.contentId===undefined:id(l.contentId),'drawing layer requires contentId; group cannot own drawing content');safeMetadata(l.metadata);return l;
}
function descriptor(value:unknown):ContentDescriptor {
  const v=object(value,'content descriptor');fields(v,['id','kind','assetId','formatVersion'],'content descriptor');
  requireValue(id(v.id)&&id(v.assetId)&&['raster','svg','vector','text','preservedText','tiles'].includes(String(v.kind))&&v.formatVersion===1,'invalid content descriptor');return copy(v) as unknown as ContentDescriptor;
}
const FEATURES=['matrix','content-assets','layer-masks','saved-selections','artboards','guides','blend-modes','layer-effects','clipping','passthrough-groups'];
function normalizeCollection(kind:'guide'|'artboard'|'selection', value:unknown):Record<string,unknown> {
  const v=object(value,kind),defaults={guide:{locked:false,visible:true},artboard:{name:'Artboard',visible:true},selection:{name:'Selection',matrix:matrix(PROFESSIONAL_IDENTITY),channel:'alpha',inverted:false,density:1,featherPx:0}}[kind];
  const keys={guide:['id','axis','position','locked','visible','artboardId'],artboard:['id','name','bounds','background','visible'],selection:['id','name','contentId','matrix','channel','inverted','density','featherPx']}[kind];fields(v,keys,kind);const out={...defaults,...copy(v)} as Record<string,unknown>;
  requireValue(id(out.id),`invalid ${kind} identity`);
  if(kind==='guide'){requireValue(['x','y'].includes(String(out.axis))&&finite(out.position)&&typeof out.locked==='boolean'&&typeof out.visible==='boolean','invalid guide');if(out.artboardId!==undefined)requireValue(id(out.artboardId),'invalid artboardId');}
  else {requireValue(typeof out.name==='string'&&out.name.length<=500,`invalid ${kind} name`);if(kind==='artboard'){const b=localBounds(out.bounds);requireValue(b.width>0&&b.height>0&&typeof out.visible==='boolean','invalid artboard');out.bounds=b;if(out.background!==undefined)requireValue(typeof out.background==='string'&&out.background.length<=100&&!/(?:url|var)\s*\(/i.test(out.background),'invalid artboard background');}
    else {requireValue(id(out.contentId)&&['alpha','luminance'].includes(String(out.channel))&&typeof out.inverted==='boolean'&&finite(out.density)&&out.density>=0&&out.density<=1&&finite(out.featherPx)&&out.featherPx>=0&&out.featherPx<=256,'invalid selection');out.matrix=matrix(out.matrix as number[]);}}
  return out;
}
/** Structural validation mirrors domain-v3. Actual font/glyph and asset ownership validation remains on the server. */
export function validateProfessionalDocument(document:RawProfessionalDocument):RawProfessionalDocument {
  const d=copy(document);requireValue(id(d.id)&&Number.isSafeInteger(d.revision)&&d.revision>=0&&typeof d.name==='string'&&d.name.length<=500,'invalid document identity');
  requireValue([d.width,d.height].every(n=>Number.isSafeInteger(n)&&n>0&&n<=32768)&&d.width*d.height<=100000000,'invalid document dimensions');
  requireValue(Array.isArray(d.assetIds)&&d.assetIds.length<=50000&&new Set(d.assetIds).size===d.assetIds.length&&d.assetIds.every(id),'invalid asset registry');
  for(const [key,max] of [['layers',10000],['contentAssets',50000],['guides',10000],['artboards',1000],['savedSelections',1000]] as const){requireValue(Array.isArray(d[key])&&d[key].length<=max,`invalid document ${key}`);requireValue(new Set(d[key].map(v=>v.id)).size===d[key].length,`duplicate ${key} identity`);}
  d.layers=d.layers.map(normalizeLayer);d.contentAssets=d.contentAssets.map(descriptor);d.guides=d.guides.map(v=>normalizeCollection('guide',v) as unknown as RawProfessionalDocument['guides'][number]);d.artboards=d.artboards.map(v=>normalizeCollection('artboard',v) as unknown as RawProfessionalDocument['artboards'][number]);d.savedSelections=d.savedSelections.map(v=>normalizeCollection('selection',v) as unknown as RawProfessionalDocument['savedSelections'][number]);
  const contents=new Map(d.contentAssets.map(c=>[c.id,c]));for(const c of contents.values())requireValue(d.assetIds.includes(c.assetId),'content asset is not registered');
  const checkMask=(m:LayerMask)=>{const c=contents.get(m.contentId);requireValue(c&&(m.kind==='raster'?c.kind==='raster':['svg','vector'].includes(c.kind)),'mask content kind does not match');};
  for(const l of d.layers){worldMatrix(d,l.id);if(l.contentId){const c=contents.get(l.contentId);requireValue(c,'content reference is not registered');requireValue(l.type==='raster'?['raster','tiles'].includes(c.kind):l.type==='vector'?['svg','vector'].includes(c.kind):l.type==='text'?['text','preservedText'].includes(c.kind):true,'layer content kind does not match');}l.masks.forEach(checkMask);clippingBase(d,l.id);}
  for(const s of d.savedSelections)requireValue(contents.has(s.contentId)&&['raster','svg','vector'].includes(contents.get(s.contentId)!.kind),'selection requires mask-compatible content');
  for(const g of d.guides)if(g.artboardId)requireValue(d.artboards.some(a=>a.id===g.artboardId),'guide artboard not found');
  requireValue(d.renderVersion==='weiai-rg-1','unsupported render version','unsupported_feature');requireValue(canonical(d.workingColor)===canonical({space:'srgb',bitDepth:8,alphaEncoding:'straight'}),'unsupported working color','unsupported_feature');
  const resolution=object(d.resolution,'resolution');fields(resolution,['dpiX','dpiY','unit'],'resolution');requireValue([resolution.dpiX,resolution.dpiY].every(n=>finite(n)&&n>0&&n<=9600)&&['px','mm','in'].includes(String(resolution.unit)),'invalid resolution');
  requireValue(Array.isArray(d.requiredFeatures)&&d.requiredFeatures.every(f=>FEATURES.includes(f))&&new Set(d.requiredFeatures).size===d.requiredFeatures.length,'unsupported required feature','unsupported_feature');
  const f=new Set(d.requiredFeatures);f.add('matrix');f.add('content-assets');if(d.layers.some(l=>l.masks.length))f.add('layer-masks');if(d.layers.some(l=>l.blendMode!=='normal'))f.add('blend-modes');if(d.layers.some(l=>l.effects.length))f.add('layer-effects');if(d.layers.some(l=>l.clipToLayerId))f.add('clipping');if(d.layers.some(l=>l.compositeMode==='passthrough'))f.add('passthrough-groups');if(d.artboards.length)f.add('artboards');if(d.guides.length)f.add('guides');if(d.savedSelections.length)f.add('saved-selections');d.requiredFeatures=[...f];safeMetadata(d.metadata);return d;
}
function inheritedLocked(d:RawProfessionalDocument,layer:RawProfessionalLayer|undefined):boolean {const seen=new Set<string>();while(layer){requireValue(!seen.has(layer.id),'cyclic layer groups');seen.add(layer.id);if(layer.locked)return true;layer=d.layers.find(p=>p.id===layer!.parentId);}return false;}
function preserveMaskLinkage(before:RawProfessionalDocument,after:RawProfessionalDocument) {
  const prior=new Map(before.layers.map(l=>[l.id,l]));
  for(const layer of after.layers){const old=prior.get(layer.id);if(!old||!layer.masks.length)continue;const a=worldMatrix(before,layer.id),b=worldMatrix(after,layer.id);if(canonical(a)===canonical(b))continue;layer.masks=layer.masks.map(mask=>{const prev=old.masks.find(m=>m.id===mask.id);return !prev||canonical(prev.matrix)!==canonical(mask.matrix)||prev.coordinateSpace!==mask.coordinateSpace?mask:linkedMaskAfterTransform(a,b,mask);});}
}
/** Atomic browser-only reducer. It neither increments revision nor writes compatibility geometry. */
export function applyProfessionalCommands(document:ImageDocument|RawProfessionalDocument,commands:readonly DocumentCommand[]):ImageDocument {
  requireValue(Array.isArray(commands)&&commands.length>0&&commands.length<=1000,'commands must be a nonempty list');
  const out=copy(asProfessional(document));
  const get=(key:string)=>{const l=out.layers.find(v=>v.id===key);requireValue(l,'layer not found','not_found',404);return l;};
  const mutable=(key:string)=>{const l=get(key);requireValue(!inheritedLocked(out,l),'locked layer cannot be changed','layer_locked',409);return l;};
  const upsert=<T extends {id:string}>(list:T[],v:T)=>{const at=list.findIndex(x=>x.id===v.id);if(at<0)list.push(v);else list[at]=v;};
  const allowed:Record<string,string[]>={'content.add':['content'],'layer.add':['layer'],'layer.update':['layerId','patch'],'layer.content':['layerId','contentId','localBounds'],'layer.transformWorld':['layerIds','deltaWorld'],'layer.remove':['layerId'],'layer.reorder':['layerIds'],'mask.upsert':['layerId','mask'],'mask.remove':['layerId','maskId'],'mask.reorder':['layerId','maskIds'],'selection.upsert':['selection'],'selection.remove':['selectionId'],'artboard.upsert':['artboard'],'artboard.remove':['artboardId'],'guide.upsert':['guide'],'guide.remove':['guideId'],'document.update':['patch']};
  for(const command of commands){const c=object(command,'command') as Record<string,unknown>;requireValue(typeof c.type==='string'&&allowed[c.type],'unsupported command');fields(c,['type',...allowed[c.type]],'command');const prior=['layer.update','layer.transformWorld'].includes(c.type)?copy(out):undefined;
    if(c.type==='content.add'){const value=descriptor(c.content),old=out.contentAssets.find(v=>v.id===value.id);requireValue(!old||canonical(old)===canonical(value),'content identity is immutable','content_identity_conflict',409);if(!old)out.contentAssets.push(value);}
    else if(c.type==='layer.add'){const l=normalizeLayer(c.layer);requireValue(!out.layers.some(v=>v.id===l.id),'layer already exists','invalid_request',409);if(l.parentId)requireValue(!inheritedLocked(out,get(l.parentId)),'locked layer group cannot be changed','layer_locked',409);out.layers.push(l);}
    else if(c.type==='layer.update'){const l=get(String(c.layerId)),p=object(c.patch,'patch');const unlock=Object.keys(p).length===1&&p.locked===false&&l.locked&&!inheritedLocked(out,out.layers.find(v=>v.id===l.parentId));requireValue(!inheritedLocked(out,l)||unlock,'locked layer cannot be changed','layer_locked',409);requireValue(!('id'in p)&&!('type'in p),'layer identity and type are immutable');if(p.parentId)requireValue(!inheritedLocked(out,get(String(p.parentId))),'locked layer group cannot be changed','layer_locked',409);Object.assign(l,copy(p));for(const k of ['parentId','clipToLayerId','metadata'] as const)if((l as unknown as Record<string,unknown>)[k]===null)delete l[k];}
    else if(c.type==='layer.content'){const l=mutable(String(c.layerId));l.contentId=String(c.contentId);if(c.localBounds!==undefined)l.localBounds=localBounds(c.localBounds);}
    else if(c.type==='layer.transformWorld'){requireValue(Array.isArray(c.layerIds)&&c.layerIds.length>0&&new Set(c.layerIds).size===c.layerIds.length&&c.layerIds.every(id),'invalid transform selection');const ids=new Set(c.layerIds as string[]),delta=matrix(c.deltaWorld as number[]),snapshot=copy(out);for(const key of ids){const l=mutable(key);let parent=l.parentId,selectedParent=false;while(parent){if(ids.has(parent))selectedParent=true;parent=get(parent).parentId;}if(selectedParent)continue;const pm=l.parentId?worldMatrix(snapshot,l.parentId):matrix(PROFESSIONAL_IDENTITY);l.matrix=multiplyMatrix(inverseMatrix(pm),multiplyMatrix(delta,worldMatrix(snapshot,key)));}}
    else if(c.type==='layer.remove'){mutable(String(c.layerId));const remove=new Set([String(c.layerId)]);let count=-1;while(count!==remove.size){count=remove.size;for(const l of out.layers)if(l.parentId&&remove.has(l.parentId))remove.add(l.id);}requireValue(!out.layers.some(l=>remove.has(l.id)&&inheritedLocked(out,l)),'locked layer cannot be removed','layer_locked',409);out.layers=out.layers.filter(l=>!remove.has(l.id));}
    else if(c.type==='layer.reorder'){requireValue(Array.isArray(c.layerIds)&&c.layerIds.length===out.layers.length&&new Set(c.layerIds).size===out.layers.length,'reorder must include each layer once');out.layers=(c.layerIds as string[]).map((key,z)=>{const l=get(key);requireValue(!inheritedLocked(out,l)||l.z===z,'locked layer cannot be reordered','layer_locked',409);return {...l,z};});}
    else if(c.type.startsWith('mask.')){const l=mutable(String(c.layerId));if(c.type==='mask.upsert')upsert(l.masks,normalizeMask(c.mask));else if(c.type==='mask.remove'){requireValue(l.masks.some(m=>m.id===c.maskId),'mask not found','not_found',404);l.masks=l.masks.filter(m=>m.id!==c.maskId);}else{requireValue(Array.isArray(c.maskIds)&&c.maskIds.length===l.masks.length&&new Set(c.maskIds).size===l.masks.length&&c.maskIds.every(key=>l.masks.some(m=>m.id===key)),'mask reorder must include each mask once');const masks=new Map(l.masks.map(m=>[m.id,m]));l.masks=(c.maskIds as string[]).map(key=>masks.get(key)!);}}
    else if(/^(selection|artboard|guide)\.(upsert|remove)$/.test(c.type)){const [kind,action]=c.type.split('.') as ['guide'|'artboard'|'selection','upsert'|'remove'],key={guide:'guides',artboard:'artboards',selection:'savedSelections'}[kind] as 'guides'|'artboards'|'savedSelections';const list=out[key] as unknown as Array<Record<string,unknown>&{id:string}>;if(action==='upsert'){const v=normalizeCollection(kind,c[kind]) as Record<string,unknown>&{id:string},old=list.find(x=>x.id===v.id);if(kind==='guide'&&old?.locked)requireValue(canonical(old)===canonical(v)||canonical({...old,locked:false})===canonical(v),'locked guide cannot be changed','guide_locked',409);upsert(list,v);}else{const value=c[`${kind}Id`],old=list.find(v=>v.id===value);requireValue(old,`${kind} not found`,'not_found',404);if(kind==='guide')requireValue(!old.locked,'locked guide cannot be removed','guide_locked',409);(out as unknown as Record<string,unknown>)[key]=list.filter(v=>v.id!==value);}}
    else if(c.type==='document.update'){const p=object(c.patch,'document patch');fields(p,['name','width','height','resolution','metadata'],'document patch');Object.assign(out,copy(p));}
    if(prior)preserveMaskLinkage(prior,out);
  }
  return validateProfessionalDocument(out) as unknown as ImageDocument;
}
/** A stale/unknown submitted outcome is kept by the queue, never optimistically replayed over new server state. */
export function applyProfessionalDraft(document:ImageDocument,batches:readonly QueuedBatch[]):ImageDocument {
  let result=copy(document);
  for(const batch of batches){if(batch.documentId!==document.id||batch.state==='blocked'||(batch.submittedRevision!==undefined&&batch.submittedRevision!==document.revision))break;result=applyProfessionalCommands(result,batch.commands);}
  return result;
}
export function contentPayload(payloads:ContentPayloads,contentId:string):ContentPayload|undefined {return 'get' in payloads && typeof payloads.get==='function'?payloads.get(contentId): (payloads as Readonly<Record<string,ContentPayload>>)[contentId];}
function validatePayload(value:ContentPayload,document:RawProfessionalDocument) {
  const v=object(value,'content JSON');requireValue(v.formatVersion===1&&['svg','vector','text','preservedText'].includes(String(v.kind)),'unsupported content JSON format','CONTENT_FORMAT_UNSUPPORTED');
  const walk=(x:unknown,depth=0)=>{requireValue(depth<=64,'content nesting exceeds limit');if(typeof x==='number')requireValue(Number.isFinite(x),'content contains nonfinite number');if(!x||typeof x!=='object')return;for(const [k,n]of Object.entries(x)){requireValue(!['__proto__','prototype','constructor','script','shader','url','href'].includes(k),'unsafe content property');if(['assetId','fontAssetId','sourceAssetId','appearanceAssetId'].includes(k))requireValue(id(n)&&document.assetIds.includes(n),'content resource is not registered','CONTENT_RESOURCE_UNREGISTERED');else if(k==='fontAssetIds')requireValue(Array.isArray(n)&&n.every(i=>id(i)&&document.assetIds.includes(i)),'content font is not registered','CONTENT_RESOURCE_UNREGISTERED');else walk(n,depth+1);}};walk(v);
  const paint=(n:unknown)=>typeof n==='string'&&n.length<=500&&!/(?:url|var)\s*\(|javascript|https?:|data:/i.test(n);
  if(v.kind==='text'){fields(v,['formatVersion','kind','text','fontAssetId','fontFamily','fontWeight','fontSize','fill','stroke','strokeWidth','tracking','lineHeight','align','locale','mode'],'text content');requireValue(typeof v.text==='string'&&v.text.length<=100000&&id(v.fontAssetId)&&finite(v.fontSize)&&v.fontSize>0&&v.fontSize<=32768,'text requires actual font asset and valid metrics');requireValue(v.mode===undefined||v.mode==='legacy-lines','paragraph layout mode is unavailable','unsupported_feature');requireValue(v.align===undefined||v.align==='left','invalid text alignment');for(const k of ['fill','stroke'])if(v[k]!==undefined)requireValue(paint(v[k]),`invalid text ${k}`);for(const k of ['strokeWidth','tracking','lineHeight'])if(v[k]!==undefined)requireValue(finite(v[k])&&(k==='tracking'||v[k]>=0)&&(k!=='lineHeight'||v[k]>0),'invalid text metrics');}
  else if(v.kind==='svg'){fields(v,['formatVersion','kind','sourceAssetId','fontAssetIds','fill','pathStyles','appearanceAssetId'],'SVG content');requireValue(id(v.sourceAssetId)&&Array.isArray(v.fontAssetIds),'invalid SVG content references');if(v.fill!==undefined)requireValue(paint(v.fill),'invalid SVG fill');if(v.pathStyles!==undefined){const styles=object(v.pathStyles,'SVG path styles');for(const style of Object.values(styles)){const s=object(style,'path style');fields(s,['fill','stroke','strokeWidth'],'path style');for(const k of ['fill','stroke'])if(s[k]!==undefined)requireValue(paint(s[k]),'invalid SVG path paint');if(s.strokeWidth!==undefined)requireValue(finite(s.strokeWidth)&&s.strokeWidth>=0,'invalid SVG path stroke width');}}}
  else if(v.kind==='preservedText'){fields(v,['formatVersion','kind','assetId','text','desiredText','fontStatus','sourceRect','originalStyle','status'],'preserved text content');requireValue(typeof v.text==='string'&&v.fontStatus==='unknown','invalid preserved text');if(v.status==='preserved')requireValue(id(v.assetId),'preserved text requires original pixels');if(v.sourceRect!==undefined)localBounds(v.sourceRect);}
  else {fields(v,['formatVersion','kind','paths','resources','viewBox'],'vector content');requireValue(Array.isArray(v.paths)&&v.paths.length<=100000,'invalid vector paths');if(v.resources!==undefined)requireValue(Array.isArray(v.resources)&&v.resources.length===0,'vector resources are unavailable','unsupported_feature');}
}
/** Caller uploads the returned payload first, then commits these commands using its actual new asset ID. */
export function copyOnWriteContent(document:ImageDocument|RawProfessionalDocument,layerId:string,sourcePayload:ContentPayload,newAssetId:string,newContentId:string,patch:ContentPayload={},bounds?:PixelBounds) {
  const d=asProfessional(document),layer=d.layers.find(l=>l.id===layerId);requireValue(layer?.contentId,'drawing layer requires contentId');const old=d.contentAssets.find(c=>c.id===layer.contentId);requireValue(old,'content reference is not registered');requireValue(id(newAssetId)&&id(newContentId)&&newAssetId!==old.assetId&&!d.contentAssets.some(c=>c.id===newContentId),'copy-on-write requires fresh content and asset identities','content_identity_conflict',409);
  requireValue(sourcePayload.kind===old.kind&&sourcePayload.formatVersion===1,'content payload does not match active descriptor','CONTENT_FORMAT_UNSUPPORTED');const payload={...copy(sourcePayload),...copy(patch)};requireValue(payload.kind===old.kind,'content kind conversion requires an explicit source conversion');validatePayload(payload,d);
  const content:ContentDescriptor={id:newContentId,kind:old.kind,assetId:newAssetId,formatVersion:1};
  const commands:DocumentCommand[]=[{type:'content.add',content},{type:'layer.content',layerId,contentId:newContentId,...(bounds?{localBounds:localBounds(bounds)}:{})}];
  return {content,payload,commands,mime:PROFESSIONAL_CONTENT_MIME};
}
function rootSelection(d:RawProfessionalDocument,ids:readonly string[]) {requireValue(ids.length>0&&new Set(ids).size===ids.length,'invalid selection');const selected=new Set(ids);return ids.map(key=>{const l=d.layers.find(x=>x.id===key);requireValue(l,'layer not found','not_found',404);requireValue(!inheritedLocked(d,l),'locked layer cannot be changed','layer_locked',409);return l;}).filter(l=>{let parent=l.parentId;while(parent){if(selected.has(parent))return false;parent=d.layers.find(x=>x.id===parent)?.parentId;}return true;});}
export function groupProfessionalLayerCommands(document:ImageDocument|RawProfessionalDocument,selectedIds:readonly string[],groupId:string,name='组合'):DocumentCommand[] {
  const d=asProfessional(document),selected=rootSelection(d,selectedIds);requireValue(selected.length>=2,'选择两个或更多图层再编组');requireValue(id(groupId)&&!d.layers.some(l=>l.id===groupId),'invalid new group identity');const parentId=selected[0].parentId;requireValue(selected.every(l=>l.parentId===parentId),'请选择同一个组合内的图层');const siblings=d.layers.filter(l=>l.parentId===parentId).sort((a,b)=>a.z-b.z),positions=selected.map(l=>siblings.indexOf(l)).sort((a,b)=>a-b);requireValue(positions.at(-1)!-positions[0]+1===selected.length,'请选择相邻图层以保留遮挡顺序');const ids=new Set(selected.map(l=>l.id));requireValue(!d.layers.some(l=>l.clipToLayerId&&ids.has(l.id)!==ids.has(l.clipToLayerId)),'编组不能拆开剪贴关系');selected.sort((a,b)=>siblings.indexOf(a)-siblings.indexOf(b));const box=unionBounds(selected.map(l=>worldBounds(d,l.id))),pm=parentId?worldMatrix(d,parentId):matrix(PROFESSIONAL_IDENTITY),gm:Matrix2D=[1,0,0,1,box.x,box.y];const group=normalizeLayer({id:groupId,type:'group',name,parentId,z:selected[0].z,matrix:multiplyMatrix(inverseMatrix(pm),gm),localBounds:{x:0,y:0,width:box.width,height:box.height}});
  return [{type:'layer.add',layer:group as unknown as ImageLayer},...selected.map((l,z):DocumentCommand=>({type:'layer.update',layerId:l.id,patch:{parentId:groupId,z,matrix:multiplyMatrix(inverseMatrix(gm),worldMatrix(d,l.id))}}))];
}
export function ungroupProfessionalLayerCommands(document:ImageDocument|RawProfessionalDocument,groupId:string):DocumentCommand[] {
  const d=asProfessional(document),g=d.layers.find(l=>l.id===groupId);requireValue(g?.type==='group','group not found','not_found',404);requireValue(!inheritedLocked(d,g),'locked layer cannot be changed','layer_locked',409);requireValue(g.opacity===1&&g.blendMode==='normal'&&!g.masks.some(m=>m.enabled)&&!g.effects.some(e=>e.enabled)&&!g.clipToLayerId&&!d.layers.some(l=>l.clipToLayerId===g.id),'此组合需保留合成与剪贴关系，不能直接解组','unsupported_feature');
  const children=d.layers.filter(l=>l.parentId===groupId).sort((a,b)=>a.z-b.z),siblings=d.layers.filter(l=>l.parentId===g.parentId).sort((a,b)=>a.z-b.z),ordered=siblings.flatMap(l=>l.id===groupId?children:[l]),pm=g.parentId?worldMatrix(d,g.parentId):matrix(PROFESSIONAL_IDENTITY),commands:DocumentCommand[]=[];
  for(const child of children){requireValue(!inheritedLocked(d,child),'locked layer cannot be changed','layer_locked',409);commands.push({type:'layer.update',layerId:child.id,patch:{parentId:g.parentId??null,matrix:multiplyMatrix(inverseMatrix(pm),worldMatrix(d,child.id))}});}
  for(const [z,l]of ordered.entries())if(l.z!==z)commands.push({type:'layer.update',layerId:l.id,patch:{z}});commands.push({type:'layer.remove',layerId:groupId});return commands;
}
/** Locked sources may be copied; every new layer is unlocked. A locked existing parent is never modified. */
export function duplicateProfessionalLayerCommands(document:ImageDocument|RawProfessionalDocument,selectedIds:readonly string[],deltaWorld:readonly number[],uuidFactory:()=>string=()=>crypto.randomUUID()):{commands:DocumentCommand[];newLayerIds:string[];mappings:{layers:Record<string,string>;masks:Record<string,Record<string,string>>;effects:Record<string,Record<string,string>>}} {
  const d=asProfessional(document),delta=matrix(deltaWorld),byId=new Map(d.layers.map(l=>[l.id,l])),selection=new Set(selectedIds);
  requireValue(selectedIds.length>0&&selection.size===selectedIds.length,'invalid duplicate selection');
  const roots=selectedIds.map(key=>{const l=byId.get(key);requireValue(l,'layer not found','not_found',404);worldMatrix(d,key);return l;}).filter(l=>{let parent=l.parentId;while(parent){if(selection.has(parent))return false;parent=byId.get(parent)?.parentId;}return true;});
  for(const root of roots)if(root.parentId)requireValue(!inheritedLocked(d,byId.get(root.parentId)),'请选中锁定父组整体复制；不能在原锁定组中添加副本','layer_locked',409);
  const source:RawProfessionalLayer[]=[],copied=new Set<string>();
  const visit=(l:RawProfessionalLayer)=>{if(copied.has(l.id))return;copied.add(l.id);source.push(l);for(const child of d.layers.filter(c=>c.parentId===l.id).sort((a,b)=>a.z-b.z))visit(child);};
  // Repeated descendant selections do not produce another copy of the same subtree.
  const order=new Map(d.layers.map((l,i)=>[l.id,i]));roots.sort((a,b)=>a.parentId===b.parentId?a.z-b.z:order.get(a.id)!-order.get(b.id)!);roots.forEach(visit);
  const mappings={layers:{} as Record<string,string>,masks:{} as Record<string,Record<string,string>>,effects:{} as Record<string,Record<string,string>>};
  const used=new Set([...d.layers.map(l=>l.id),...d.layers.flatMap(l=>l.masks.map(m=>m.id)),...d.layers.flatMap(l=>l.effects.map(e=>e.id))]);
  const fresh=()=>{const value=uuidFactory();requireValue(id(value)&&!used.has(value),'duplicate requires fresh unique identities','content_identity_conflict',409);used.add(value);return value;};
  for(const l of source)mappings.layers[l.id]=fresh();
  const rootsSet=new Set(roots.map(l=>l.id)),nextZ=new Map<string,number>(),commands:DocumentCommand[]=[];
  for(const original of source){const l=copy(original);l.id=mappings.layers[original.id];l.locked=false;
    if(original.parentId)l.parentId=mappings.layers[original.parentId]||original.parentId;
    if(original.clipToLayerId)l.clipToLayerId=mappings.layers[original.clipToLayerId]||original.clipToLayerId;
    const oldWorld=worldMatrix(d,original.id),newWorld=multiplyMatrix(delta,oldWorld);
    if(rootsSet.has(original.id)){
      const parentWorld=original.parentId?worldMatrix(d,original.parentId):matrix(PROFESSIONAL_IDENTITY);
      l.matrix=multiplyMatrix(inverseMatrix(parentWorld),newWorld);l.name=`${original.name.slice(0,496)} 副本`;
      const parentKey=original.parentId||'';let z=nextZ.get(parentKey);if(z===undefined)z=Math.max(-1,...d.layers.filter(v=>v.parentId===original.parentId).map(v=>v.z))+1;l.z=z;nextZ.set(parentKey,z+1);
    }
    mappings.masks[original.id]={};l.masks=original.masks.map(mask=>{const m=linkedMaskAfterTransform(oldWorld,newWorld,mask);m.id=fresh();mappings.masks[original.id][mask.id]=m.id;return m;});
    mappings.effects[original.id]={};l.effects=original.effects.map(effect=>{const e=copy(effect);e.id=fresh();mappings.effects[original.id][effect.id]=e.id;return e;});
    commands.push({type:'layer.add',layer:normalizeLayer(l) as unknown as ImageLayer});
  }
  // Validate dangling clips and hierarchy as one atomic command batch before enqueueing.
  applyProfessionalCommands(document,commands);
  return {commands,newLayerIds:roots.map(l=>mappings.layers[l.id]),mappings};
}
