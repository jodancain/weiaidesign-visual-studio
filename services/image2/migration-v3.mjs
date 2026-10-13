import { randomUUID } from 'node:crypto';
import { clone, fail, digest } from './domain.mjs';
import { CONTENT_MIME, IDENTITY, multiplyMatrix, validateV3Document } from './domain-v3.mjs';
import { normalizeSvg } from './svg-normalize.mjs';

const safeMetadata = source => {
  const out = clone(source || {});
  for (const key of ['legacySnapshot','legacyProps','paths','paragraphs','runs','tiles','pixels','shader','script','pathStyles','frameClip']) delete out[key];
  return out;
};
const translation = (x,y) => [1,0,0,1,x,y];
const rotation = degrees => {
  const angle = degrees * Math.PI / 180;
  return [Math.cos(angle),Math.sin(angle),-Math.sin(angle),Math.cos(angle),0,0];
};
const geometry = layer => multiplyMatrix(translation(layer.x,layer.y),rotation(layer.rotation));

// This planner has no writes. Store commits the copied assets, revisions and
// migration receipt together, leaving the v2 ledger and jobs unchanged.
export function planV3Migration(revisions, assetRecords) {
  const assets = new Map(assetRecords.map(record => [record.asset.id,record]));
  const layerIds = new Map(), assetIds = new Map(assetRecords.map(record => [record.asset.id,randomUUID()]));
  const contentIds = new Map(), contents = new Map(), jsonAssets = new Map(), auxiliaryIds = new Map();
  const auxiliary = key => { if (!auxiliaryIds.has(key)) auxiliaryIds.set(key,randomUUID()); return auxiliaryIds.get(key); };
  for (const document of revisions) for (const layer of document.layers) if (!layerIds.has(layer.id)) layerIds.set(layer.id,randomUUID());
  const mapAsset = id => { fail(assetIds.has(id),'migration source asset is missing',422,'MIGRATION_ASSET_MISSING'); return assetIds.get(id); };
  const descriptor = (kind,assetId,identity) => {
    const key = `${kind}:${identity}`;
    if (contents.has(key)) return contents.get(key);
    const content = {id:randomUUID(),kind,assetId,formatVersion:1};
    contents.set(key,content); contentIds.set(key,content.id); return content;
  };
  const jsonContent = value => {
    const identity = digest(value);
    if (!jsonAssets.has(identity)) jsonAssets.set(identity,{assignedId:randomUUID(),name:`migrated-${value.kind}.json`,mime:CONTENT_MIME,value});
    return descriptor(value.kind,jsonAssets.get(identity).assignedId,identity);
  };
  const common = layer => ({
    id:layerIds.get(layer.id),type:layer.type,name:layer.name,
    ...(layer.parentId ? {parentId:layerIds.get(layer.parentId)} : {}),
    z:layer.z,visible:layer.visible,locked:layer.locked,opacity:layer.opacity,
    blendMode:'normal',compositeMode:'isolated',masks:[],effects:[],
  });
  function transformLayer(layer) {
    let content, localBounds = {x:0,y:0,width:layer.width,height:layer.height}, matrix = geometry(layer);
    const notes = safeMetadata(layer.metadata);
    for (const key of ['visibilitySourceAssetId','sourcePatchAssetId','cleanBackgroundAssetId']) if (notes[key]) notes[key] = mapAsset(notes[key]);
    if (notes.backgroundLayerId) notes.backgroundLayerId = layerIds.get(notes.backgroundLayerId);
    // v2 sourceRect is extraction provenance; current assetId is already the
    // visible slice. It never changes the content viewport during migration.
    if (layer.sourceAssetId) notes.sourceAssetId = mapAsset(layer.sourceAssetId);
    if (layer.sourceRect) notes.sourceRect = clone(layer.sourceRect);
    const base = layer.assetId ? assets.get(layer.assetId) : null;
    if (layer.type === 'text') {
      if (layer.fontAssetId && layer.metadata?.fontConfirmed === true) {
        content = jsonContent({
          formatVersion:1,kind:'text',text:layer.text || '',fontAssetId:mapAsset(layer.fontAssetId),
          fontSize:layer.fontSize,fontFamily:layer.fontFamily,
          fontWeight:typeof layer.fontWeight === 'number' ? layer.fontWeight : 400,
          fill:layer.fill,stroke:layer.stroke,strokeWidth:layer.strokeWidth,
          tracking:layer.tracking,lineHeight:layer.lineHeight,
        });
      } else {
        const originalStyle = Object.fromEntries(['fontFamily','fontSize','fontWeight','fill','stroke','strokeWidth','tracking','lineHeight'].filter(key => layer[key] !== undefined).map(key => [key,layer[key]]));
        content = jsonContent({
          formatVersion:1,kind:'preservedText',text:layer.text || '',fontStatus:'unknown',
          status:base ? 'preserved' : 'unavailable',...(base ? {assetId:mapAsset(layer.assetId)} : {}),
          ...(layer.metadata?.desiredText === undefined ? {} : {desiredText:layer.metadata.desiredText}),originalStyle,
        });
        if (base) {
          const {width,height} = base.asset;
          fail(width > 0 && height > 0,'unknown text source dimensions are missing',422,'MIGRATION_ASSET_DIMENSIONS_REQUIRED');
          localBounds = {x:0,y:0,width,height};
          matrix = multiplyMatrix(matrix,[layer.width/width,0,0,layer.height/height,0,0]);
        }
      }
    } else if (layer.type !== 'group') {
      fail(base,'drawing layer has no source asset',422,'MIGRATION_ASSET_MISSING');
      if (base.asset.mime === 'image/svg+xml') {
        const normalized = normalizeSvg(base.bytes.toString('utf8'),{fallbackWidth:base.asset.width,fallbackHeight:base.asset.height});
        const [x,y,width,height] = normalized.viewBox;
        localBounds = {x,y,width,height};
        matrix = multiplyMatrix(matrix,multiplyMatrix([layer.width/width,0,0,layer.height/height,0,0],translation(-x,-y)));
        content = jsonContent({formatVersion:1,kind:'svg',sourceAssetId:mapAsset(layer.assetId),fontAssetIds:layer.fontAssetId ? [mapAsset(layer.fontAssetId)] : [],...(layer.fill === undefined ? {} : {fill:layer.fill}),...(layer.metadata?.pathStyles === undefined ? {} : {pathStyles:clone(layer.metadata.pathStyles)})});
      } else {
        const {width,height} = base.asset;
        fail(width > 0 && height > 0,'source pixel dimensions are missing',422,'MIGRATION_ASSET_DIMENSIONS_REQUIRED');
        localBounds = {x:0,y:0,width,height};
        matrix = multiplyMatrix(matrix,[layer.width/width,0,0,layer.height/height,0,0]);
        content = descriptor('raster',mapAsset(layer.assetId),layer.assetId);
      }
    }
    const masks = [];
    if (layer.maskAssetId) {
      const mask = assets.get(layer.maskAssetId);
      fail(mask?.asset.width > 0 && mask.asset.height > 0,'mask dimensions are missing',422,'MIGRATION_ASSET_DIMENSIONS_REQUIRED');
      const maskContent = descriptor('raster',mapAsset(layer.maskAssetId),layer.maskAssetId);
      masks.push({id:auxiliary(`mask:${layer.id}:${layer.maskAssetId}`),kind:'raster',contentId:maskContent.id,channel:'luminance',coordinateSpace:'layerLocal',matrix:[localBounds.width/mask.asset.width,0,0,localBounds.height/mask.asset.height,localBounds.x,localBounds.y],linked:true,enabled:true,inverted:false,density:1,featherPx:0});
    }
    if (layer.type === 'group' && layer.metadata?.frameClip === true) {
      const frameContent = jsonContent({formatVersion:1,kind:'vector',viewBox:[0,0,layer.width,layer.height],paths:[{id:'frame',d:`M0 0H${layer.width}V${layer.height}H0Z`,fill:'#ffffff'}]});
      masks.push({id:auxiliary(`frame:${layer.id}`),kind:'vector',contentId:frameContent.id,channel:'alpha',coordinateSpace:'layerLocal',matrix:[...IDENTITY],linked:true,enabled:true,inverted:false,density:1,featherPx:0});
    }
    const output = {...common(layer),type:layer.type==='group'?'group':layer.type==='text'?'text':content.kind==='svg'?'vector':layer.type==='mask'?'mask':'raster',...(content ? {contentId:content.id} : {}),localBounds,matrix,masks,metadata:notes};
    if (layer.type === 'text' && content.kind === 'text' && layer.metadata?.cleanBackgroundAssetId && layer.metadata?.backgroundDetached !== true) {
      const background = assets.get(layer.metadata.cleanBackgroundAssetId);
      fail(background?.asset.width > 0 && background.asset.height > 0,'attached text background is missing',422,'MIGRATION_ASSET_MISSING');
      const backgroundContent = descriptor('raster',mapAsset(background.asset.id),background.asset.id);
      const text = {...output,id:auxiliary(`text:${layer.id}`),parentId:output.id,z:1,matrix:[...IDENTITY],opacity:1,masks:[],metadata:{}};
      const backing = {...common(layer),id:auxiliary(`background:${layer.id}`),parentId:output.id,type:'raster',name:`${layer.name} background`,z:0,opacity:1,contentId:backgroundContent.id,localBounds:{x:0,y:0,width:background.asset.width,height:background.asset.height},matrix:[layer.width/background.asset.width,0,0,layer.height/background.asset.height,0,0],masks:[],metadata:{}};
      delete output.contentId; output.type='group';
      return [output,backing,text];
    }
    return [output];
  }
  const versions = revisions.map(document => {
    const layers = document.layers.flatMap(transformLayer);
    return {...clone(document),schemaVersion:3,layers,assetIds:[],contentAssets:[],artboards:[],guides:[],savedSelections:[],resolution:{dpiX:72,dpiY:72,unit:'px'},workingColor:{space:'srgb',bitDepth:8,alphaEncoding:'straight'},renderVersion:'weiai-rg-1',requiredFeatures:['matrix','content-assets',...(layers.some(layer=>layer.masks.length)?['layer-masks']:[])],metadata:safeMetadata(document.metadata)};
  });
  // Preallocated identities are shared by every historical revision, so undo
  // does not change mask identity or silently acquire a different content ID.
  for (const document of versions) {
    document.contentAssets = [...contents.values()];
    document.assetIds = [...assetIds.values(),...Array.from(jsonAssets.values()).map(asset=>asset.assignedId)];
    validateV3Document(document);
  }
  return {versions,assetIds,layerIds,contentIds,jsonAssets:[...jsonAssets.values()],mappings:{assets:Object.fromEntries(assetIds),layers:Object.fromEntries(layerIds),contents:Object.fromEntries(contentIds),auxiliary:Object.fromEntries(auxiliaryIds)}};
}
