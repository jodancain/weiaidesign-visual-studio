import { AssetRecordType, createShapeId, getIndexAbove, getIndexBetween, toRichText, type Editor, type TLShape, type TLShapeId } from 'tldraw';
import { assetUrl } from './client';
import type { ImageDocument, ImageLayer } from './types';
import { orderedLayers } from './stacking';

export const legacyFontVersion = 'full-original-families-20261012';
export const legacyFontUrls: Record<string, string> = { draw: `/fonts/lxgw-wenkai.woff2?v=${legacyFontVersion}`, sans: `/fonts/source-han-sans.woff2?v=${legacyFontVersion}`, serif: `/fonts/source-han-serif.woff2?v=${legacyFontVersion}`, mono: `/fonts/smiley-sans.woff2?v=${legacyFontVersion}` };
export const legacyFontSizes: Record<string, number> = { s: 18, m: 24, l: 36, xl: 44 };
export const legacyColors: Record<string, string> = { black: '#1d1d1d', grey: '#9fa8b2', white: '#ffffff', red: '#e03131', 'light-red': '#f87777', orange: '#e16919', yellow: '#f1ac4b', green: '#099268', 'light-green': '#4cb05e', blue: '#4465e9', 'light-blue': '#4ba1f1', violet: '#ae3ec9', 'light-violet': '#e085f4' };
export function shapeFingerprint(shape: TLShape) { return JSON.stringify({ type: shape.type, x: shape.x, y: shape.y, rotation: shape.rotation, parentId: shape.parentId, props: shape.props, index: shape.index, opacity: shape.opacity, isLocked: shape.isLocked, hidden: shape.meta.image2Hidden }); }
export function layerShapeId(layer: ImageLayer): TLShapeId {
  return (typeof layer.metadata?.legacyShapeId === 'string' && layer.metadata.legacyShapeId.startsWith('shape:') ? layer.metadata.legacyShapeId : createShapeId(`image2-${layer.id}`)) as TLShapeId;
}
export function plainRichText(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const node = value as { type?: string; text?: string; content?: unknown[] };
  if (typeof node.text === 'string') return node.text;
  return (node.content || []).map(plainRichText).join(node.type === 'doc' ? '\n' : '');
}

/** The original canvas keeps its native records. Only processed / new design layers need a custom shape. */
export function projectLegacyDocument(editor: Editor, document: ImageDocument, fingerprints: Map<string, string>) {
  const layers = orderedLayers(document.layers), wanted = new Set(layers.map(layerShapeId));
  const selected = editor.getSelectedShapeIds();
  editor.run(() => {
    const obsolete = [...editor.getCurrentPageShapeIds()].filter(id => {
      const shape = editor.getShape(id);
      return shape?.meta.image2DocumentId === document.id && !wanted.has(id);
    });
    if (obsolete.length) editor.deleteShapes(obsolete);
    const pending = [...layers], indexes = new Map<string, ReturnType<typeof getIndexAbove>>();
    while (pending.length) {
      const at = pending.findIndex(l => !l.parentId || editor.getShape(layerShapeId(layers.find(p => p.id === l.parentId)!)));
      if (at < 0) break;
      const layer = pending.splice(at, 1)[0], id = layerShapeId(layer);
      const parent = layers.find(p => p.id === layer.parentId);
      const parentId = parent ? layerShapeId(parent) : editor.getCurrentPageId();
      const parentKey = String(parentId);
      const index = indexes.has(parentKey) ? getIndexAbove(indexes.get(parentKey)!) : getIndexBetween(undefined, undefined);
      indexes.set(parentKey, index);
      const original = layer.metadata?.legacyRecord as TLShape | undefined;
      const current = editor.getShape(id);
      const textColor = Object.entries(legacyColors).find(([, value]) => value.toLowerCase() === layer.fill?.toLowerCase())?.[0];
      const nativeText = original?.type === 'text' && layer.type === 'text' && layer.metadata?.nativeText === true && layer.fontAssetId === layer.metadata?.nativeFontAssetId && !layer.stroke && !layer.tracking && layer.lineHeight === 1.35 && !!textColor;
      const proxySize = layer.metadata?.legacyProxySize as { width?: number; height?: number } | undefined;
      const nativeGeometry = original && (!['text', 'image', 'group'].includes(original.type) || layer.metadata?.nativeProjection === true) && layer.assetId === layer.metadata?.legacyProxyAssetId && !layer.fill && !layer.metadata?.pathStyles && layer.width === proxySize?.width && layer.height === proxySize?.height;
      const nativeRaster = original?.type === 'image' && layer.type === 'raster' && !layer.maskAssetId;
      const useNative = nativeText || nativeGeometry || nativeRaster || ((original?.type === 'group' || original?.type === 'frame') && layer.type === 'group');
      const meta = { ...(current?.meta || original?.meta || {}), image2LayerId: layer.id, layerId: layer.id, image2DocumentId: document.id, image2Hidden: !layer.visible, hidden: !layer.visible };
      let record: Record<string, unknown>;
      if (useNative && original) {
        record = { ...original, id, index, parentId, isLocked: layer.locked, opacity: layer.opacity, meta };
        if (nativeGeometry) {
          const origin = layer.metadata?.legacyProxyOrigin as { x: number; y: number } | undefined;
          record.x = original.x + layer.x - (origin?.x ?? layer.x); record.y = original.y + layer.y - (origin?.y ?? layer.y);
          record.rotation = layer.rotation * Math.PI / 180;
        } else { record.x = layer.x; record.y = layer.y; record.rotation = layer.rotation * Math.PI / 180; }
        if (nativeRaster && layer.assetId) {
          const assetId = AssetRecordType.createId(`image2-${layer.assetId}`);
          if (!editor.getAsset(assetId)) editor.createAssets([{ id: assetId, type: 'image', typeName: 'asset', meta: {}, props: { name: layer.name, src: assetUrl(layer.assetId), w: Number(layer.metadata?.pixelWidth || layer.width), h: Number(layer.metadata?.pixelHeight || layer.height), mimeType: 'image/png', isAnimated: false } }]);
          record.props = { ...original.props, assetId, w: layer.width, h: layer.height };
        }
        if (nativeText) {
          const originalProps = original.props as Record<string, unknown>;
          const size = String(originalProps.size || 'm');
          record.props = { ...originalProps, richText: layer.text === plainRichText(originalProps.richText) ? originalProps.richText : toRichText(layer.text || ''), font: layer.metadata?.legacyFontSlot || originalProps.font, color: textColor,
            w: layer.width / Number(originalProps.scale || 1), scale: (layer.fontSize || 24) / (legacyFontSizes[size] || 24) };
        }
        if (original.type === 'frame') record.props = { ...original.props, w: layer.width, h: layer.height, name: layer.name };
      } else {
        record = { id, type: layer.type === 'group' ? 'design-group' : layer.type === 'text' ? 'design-text' : layer.type === 'vector' ? 'design-vector' : 'source-mask', x: layer.x, y: layer.y, rotation: layer.rotation * Math.PI / 180,
          index, parentId, isLocked: layer.locked, opacity: layer.opacity, meta, props: { w: layer.width, h: layer.height, layer } };
      }
      if (current && current.type !== record.type) editor.deleteShapes([id]);
      if (editor.getShape(id)) editor.updateShapes([record as never]); else editor.createShapes([record as never]);
    }
    const retained = selected.filter(id => editor.getShape(id)); if (retained.length) editor.select(...retained);
  }, { history: 'ignore', ignoreShapeLock: true });
  fingerprints.clear(); for (const shape of editor.getCurrentPageShapes()) fingerprints.set(shape.id, shapeFingerprint(shape));
}
