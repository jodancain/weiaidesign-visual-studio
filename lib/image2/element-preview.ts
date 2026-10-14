import { assetUrl } from './client';
import type { ImageDocument } from './types';

/** Pass the adapter's compatibility view: raw v3 layers store contentId, not assetId. */
export function elementPreviewSource(document: ImageDocument | null, target: { src?: string; layerId?: string }): string | undefined {
  if (!target.layerId) return target.src;
  const layer = document?.layers.find(item => item.id === target.layerId);
  return layer?.assetId ? assetUrl(layer.assetId) : undefined;
}
