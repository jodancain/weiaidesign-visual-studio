import type { ImageDocument } from './types';

export interface LayerReference { documentId: string; layerId: string; revision: number }
const prefix = '/api/v3/image2/documents/';
const validIdentity = (value: string) => /^[A-Za-z0-9_-]{1,128}$/.test(value);
/** Explicit frozen layer appearance. Ordinary asset/history URLs never become live references. */
export function layerReferenceUrl(reference: LayerReference): string {
  return `${prefix}${encodeURIComponent(reference.documentId)}/layer-appearance/${encodeURIComponent(reference.layerId)}?revision=${reference.revision}`;
}
export function parseLayerReference(src: string, origin: string): LayerReference | undefined {
  try {
    const url = new URL(src, origin);
    if (url.origin !== new URL(origin).origin) return;
    const match = /^\/api\/v3\/image2\/documents\/([^/]+)\/layer-appearance\/([^/]+)$/.exec(url.pathname);
    if (!match || url.searchParams.getAll('revision').length !== 1 || !/^\d+$/.test(url.searchParams.get('revision') || '')) return;
    const documentId = decodeURIComponent(match[1]), layerId = decodeURIComponent(match[2]), revision = Number(url.searchParams.get('revision'));
    if (!validIdentity(documentId) || !validIdentity(layerId) || !Number.isSafeInteger(revision)) return;
    return { documentId, layerId, revision };
  } catch { return; }
}
/** Shape identity, rather than shared asset identity, distinguishes edited duplicates. */
export function selectedLayerReference(document: ImageDocument | null, shape: { id: string; meta?: Record<string, unknown> }): string | undefined {
  if (!document) return;
  const layer = document.layers.find(layer => {
    const shapeId = layer.matrix && layer.localBounds ? `shape:image2-${layer.id}` : typeof layer.metadata?.legacyShapeId === 'string' ? layer.metadata.legacyShapeId : `shape:image2-${layer.id}`;
    return shapeId === shape.id;
  });
  return layer && layer.type !== 'mask' && layer.type !== 'adjustment' ? layerReferenceUrl({ documentId: document.id, layerId: layer.id, revision: document.revision }) : undefined;
}
