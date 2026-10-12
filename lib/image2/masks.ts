import type { ImageLayer } from './types';

export function savedMaskReferences(layer: ImageLayer, purpose: 'edit' | 'visibility') {
  const metadata = layer.metadata || {};
  const edit = metadata[purpose === 'visibility' ? 'visibilityMaskAssetId' : 'editMaskAssetId'];
  const protect = metadata[purpose === 'visibility' ? 'visibilityProtectMaskAssetId' : 'protectMaskAssetId'];
  return { edit: typeof edit === 'string' && edit ? edit : undefined, protect: typeof protect === 'string' && protect ? protect : undefined };
}

/** Stored masks use luminance times alpha, exactly as the pixel processor does. */
export function maskPixelsForCanvas(pixels: Uint8ClampedArray, width: number, height: number, expectedWidth: number, expectedHeight: number) {
  if (width !== expectedWidth || height !== expectedHeight || pixels.length !== width * height * 4) throw new Error('已保存的范围与当前图片尺寸不一致；请取消局部范围后重新选择');
  const result = new Uint8ClampedArray(pixels.length);
  for (let index = 0; index < pixels.length; index += 4) {
    result[index] = result[index + 1] = result[index + 2] = 255;
    result[index + 3] = Math.round((pixels[index] * .2126 + pixels[index + 1] * .7152 + pixels[index + 2] * .0722) * pixels[index + 3] / 255);
  }
  return result;
}

/** Current reversible pixel baseline is distinct from immutable original provenance. */
export function visibilityBackdrop(layer: ImageLayer) {
  const metadata = layer.metadata || {};
  const assetId = typeof metadata.visibilitySourceAssetId === 'string' ? metadata.visibilitySourceAssetId : undefined;
  const rect = metadata.visibilitySourceRect;
  if (assetId && Array.isArray(rect) && rect.length === 4) return { assetId, rect: rect as number[] };
  // A legacy processed image cannot safely reuse the original pre-edit crop.
  if (metadata.operation && metadata.operation !== 'restore_layers') return undefined;
  if (!layer.sourceAssetId || !layer.sourceRect) return undefined;
  const originalRect = Array.isArray(layer.sourceRect) ? layer.sourceRect : [layer.sourceRect.x, layer.sourceRect.y, layer.sourceRect.width, layer.sourceRect.height];
  return { assetId: layer.sourceAssetId, rect: originalRect };
}
