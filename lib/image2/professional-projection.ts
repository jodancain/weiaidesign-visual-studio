import { getIndexAbove, getIndexBetween } from '@tldraw/utils';
import type { Editor, TLShapeId } from 'tldraw';
import type { ImageDocument, ImageLayer } from './types';
import { asProfessional, contentPayload, worldBounds, worldMatrix, type ContentPayload, type ContentPayloads, type RawProfessionalDocument, type RawProfessionalLayer } from './professional-model';

export type ProfessionalLegacyLayer = ImageLayer & { professionalView: true; contentPayload?: ContentPayload };
function ordered(document: RawProfessionalDocument): RawProfessionalLayer[] {
  const result:RawProfessionalLayer[]=[],seen=new Set<string>();
  const visit=(layer:RawProfessionalLayer)=>{if(seen.has(layer.id))throw new Error('cyclic layer groups');seen.add(layer.id);result.push(layer);for(const child of document.layers.filter(l=>l.parentId===layer.id).sort((a,b)=>a.z-b.z))visit(child);};
  for(const root of document.layers.filter(l=>!l.parentId).sort((a,b)=>a.z-b.z))visit(root);
  if(result.length!==document.layers.length)throw new Error('invalid layer hierarchy');return result;
}
export function professionalLayerShapeId(layer:Pick<ImageLayer,'id'|'metadata'>):TLShapeId {
  // Imported native IDs are provenance. A copied v3 hierarchy must not reuse them.
  return `shape:image2-${layer.id}` as TLShapeId;
}
function ancestry(document:RawProfessionalDocument,layer:RawProfessionalLayer) {
  const chain:RawProfessionalLayer[]=[layer],seen=new Set([layer.id]);let next=layer;
  while(next.parentId){const parent=document.layers.find(l=>l.id===next.parentId);if(!parent||seen.has(parent.id))throw new Error('invalid layer hierarchy');chain.push(parent);seen.add(parent.id);next=parent;}return chain;
}
/** Read-only compatibility values for existing dialogs; never submit these layers to the v3 server. */
export function professionalLegacyView(document:ImageDocument|RawProfessionalDocument,payloads:ContentPayloads={},options:{includeContentPayload?:boolean;compactMetadata?:boolean}={}):ImageDocument {
  const d=asProfessional(document);
  const layers:ProfessionalLegacyLayer[]=d.layers.map(raw=>{
    const b=worldBounds(d,raw.id),descriptor=d.contentAssets.find(c=>c.id===raw.contentId),cached=raw.contentId?contentPayload(payloads,raw.contentId):undefined;
    const payload=cached&&cached.formatVersion===1&&cached.kind===descriptor?.kind?cached:undefined;
    const metadata={...(options.compactMetadata?{}:structuredClone(raw.metadata||{})),professionalContentReady:raw.type==='group'||descriptor?.kind==='raster'||Boolean(payload),professionalContentKind:descriptor?.kind};
    const view:ProfessionalLegacyLayer={...structuredClone(raw),professionalView:true,x:b.x,y:b.y,width:b.width,height:b.height,rotation:0,metadata};
    if(descriptor?.kind==='raster')view.assetId=descriptor.assetId;
    if(payload){if(options.includeContentPayload!==false)view.contentPayload=structuredClone(payload);
      if(payload.kind==='svg'){
        if(typeof payload.sourceAssetId==='string')view.assetId=payload.sourceAssetId;
        if(typeof payload.fill==='string')view.fill=payload.fill;
        if(!options.compactMetadata){
          if(payload.pathStyles&&typeof payload.pathStyles==='object'&&!Array.isArray(payload.pathStyles))view.metadata!.pathStyles=structuredClone(payload.pathStyles);
          view.metadata!.svgFontAssetIds=Array.isArray(payload.fontAssetIds)?structuredClone(payload.fontAssetIds):[];
        }
      }else if(payload.kind==='text'){
        for(const key of ['text','fontAssetId','fontFamily','fontWeight','fontSize','fill','stroke','strokeWidth','tracking','lineHeight'] as const){if(payload[key]!==undefined)(view as unknown as Record<string,unknown>)[key]=structuredClone(payload[key]);}
        view.editability='text';view.metadata!.fontConfirmed=true;view.metadata!.fontStatus='confirmed';
      }else if(payload.kind==='preservedText'){
        view.text=typeof payload.text==='string'?payload.text:undefined;
        if(typeof payload.assetId==='string'){view.assetId=payload.assetId;view.metadata!.sourcePatchAssetId=payload.assetId;}
        if(payload.sourceRect&&typeof payload.sourceRect==='object')view.sourceRect=structuredClone(payload.sourceRect) as ImageLayer['sourceRect'];
        if(payload.originalStyle&&typeof payload.originalStyle==='object'&&!Array.isArray(payload.originalStyle)){
          for(const key of ['fontFamily','fontWeight','fontSize','fill','stroke','strokeWidth','tracking','lineHeight']){const v=(payload.originalStyle as Record<string,unknown>)[key];if(v!==undefined)(view as unknown as Record<string,unknown>)[key]=structuredClone(v);}
        }
        view.metadata!.fontConfirmed=false;view.metadata!.fontStatus='unknown';view.metadata!.desiredText=payload.desiredText;view.metadata!.preservedTextStatus=payload.status??'preserved';
      }else if(payload.kind==='vector')view.editability='path';
    }
    return view;
  });
  return {...structuredClone(document),layers} as ImageDocument;
}
export interface ProfessionalProxyRecord {
  id:TLShapeId; type:'design-proxy'; x:number;y:number;rotation:0;parentId:string;index:ReturnType<typeof getIndexAbove>;
  isLocked:boolean;opacity:number;meta:Record<string,unknown>;props:{w:number;h:number;layer:ProfessionalLegacyLayer};
}
/** Transparent hit targets live at the page root. Parent transforms and shear remain in raw v3 only. */
export function professionalProxyRecords(document:ImageDocument|RawProfessionalDocument,pageId:string,payloads:ContentPayloads={}):ProfessionalProxyRecord[] {
  const d=asProfessional(document),views=new Map(professionalLegacyView(d,payloads,{includeContentPayload:false,compactMetadata:true}).layers.map(l=>[l.id,l as ProfessionalLegacyLayer]));
  let index=getIndexBetween(undefined,undefined);
  return ordered(d).map(layer=>{
    const view=views.get(layer.id)!,chain=ancestry(d,layer),visible=chain.every(l=>l.visible),locked=chain.some(l=>l.locked);
    const record:ProfessionalProxyRecord={id:professionalLayerShapeId(layer),type:'design-proxy',x:view.x,y:view.y,rotation:0,parentId:pageId,index,isLocked:locked,opacity:1,
      meta:{image2DocumentId:d.id,image2LayerId:layer.id,layerId:layer.id,image2Hidden:!visible,hidden:!visible,image2Professional:true,image2ContentId:layer.contentId,professionalWorldMatrix:worldMatrix(d,layer.id)},
      props:{w:Math.max(1,view.width),h:Math.max(1,view.height),layer:view}};
    // tldraw's T.jsonValue rejects undefined, including optional content on groups.
    index=getIndexAbove(index);return JSON.parse(JSON.stringify(record)) as ProfessionalProxyRecord;
  });
}
function fingerprint(shape:{type:unknown;x:unknown;y:unknown;rotation:unknown;parentId:unknown;props:unknown;index:unknown;opacity:unknown;isLocked:unknown;meta:Record<string,unknown>}) {
  return JSON.stringify({type:shape.type,x:shape.x,y:shape.y,rotation:shape.rotation,parentId:shape.parentId,props:shape.props,index:shape.index,opacity:shape.opacity,isLocked:shape.isLocked,hidden:shape.meta.image2Hidden});
}

/** A retained v2 display record is redundant only with exact migration provenance, never by name or old layer ID. */
export function migratedProjectionResidueIds(document: ImageDocument, shapes: readonly { id: string; parentId: string; meta: Record<string, unknown> }[]): string[] {
  const source = document.metadata?.professionalSource as { documentId?: unknown } | undefined;
  if (typeof source?.documentId !== 'string' || source.documentId === document.id) return [];
  const matched = new Set(shapes.filter(shape => shape.meta.image2DocumentId === source.documentId && document.layers.filter(layer => layer.metadata?.legacyShapeId === shape.id).length === 1).map(shape => shape.id));
  // Deleting a group also deletes descendants. Unmapped children must stay recoverable.
  let changed = true;
  while (changed) { changed = false; for (const shape of shapes) if (matched.has(shape.parentId) && !matched.has(shape.id)) { matched.delete(shape.parentId); changed = true; } }
  return [...matched];
}
/** Updates only this document's hit targets; the root owns registration and authoritative rendering. */
export function projectProfessionalDocument(editor:Editor,document:ImageDocument,fingerprints:Map<string,string>,payloads:ContentPayloads={},options:{reconcileLegacyProjection?:boolean}={}) {
  const records=professionalProxyRecords(document,editor.getCurrentPageId(),payloads),wanted=new Set(records.map(r=>r.id)),selected=editor.getSelectedShapeIds();
  editor.run(()=>{
    if (options.reconcileLegacyProjection) { const stale = migratedProjectionResidueIds(document, editor.getCurrentPageShapes()); if (stale.length) editor.deleteShapes(stale as TLShapeId[]); }
    const obsolete=[...editor.getCurrentPageShapeIds()].filter(key=>editor.getShape(key)?.meta.image2DocumentId===document.id&&!wanted.has(key));if(obsolete.length)editor.deleteShapes(obsolete);
    for(const record of records){const current=editor.getShape(record.id);const meta={...(current?.meta||{}),...record.meta};if(current&&current.type!==record.type)editor.deleteShapes([record.id]);const value={...record,meta};if(editor.getShape(record.id))editor.updateShapes([value as never]);else editor.createShapes([value as never]);}
    const retained=selected.filter(key=>editor.getShape(key));if(retained.length)editor.select(...retained);
  },{history:'ignore',ignoreShapeLock:true});
  fingerprints.clear();for(const shape of editor.getCurrentPageShapes())fingerprints.set(shape.id,fingerprint(shape));
}
