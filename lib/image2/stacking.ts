import type { DocumentCommand, ImageLayer } from './types';

/** z is local to a parent. A whole child subtree paints before its next sibling. */
export function siblingLayers(layers: ImageLayer[], parentId?: string | null) {
  const parent = parentId || undefined;
  return layers.filter(layer => (layer.parentId || undefined) === parent).sort((a, b) => a.z - b.z);
}
export function orderedLayers(layers: ImageLayer[]): ImageLayer[] {
  const result: ImageLayer[] = [], visited = new Set<string>();
  const visit = (layer: ImageLayer) => {
    if (visited.has(layer.id)) return;
    visited.add(layer.id); result.push(layer);
    for (const child of siblingLayers(layers, layer.id)) visit(child);
  };
  for (const layer of layers.filter(layer => !layer.parentId || !layers.some(parent => parent.id === layer.parentId)).sort((a, b) => a.z - b.z)) visit(layer);
  return result;
}
export function reorderSiblingCommands(layers: ImageLayer[], layerId: string, direction: -1 | 1): DocumentCommand[] {
  const layer = layers.find(item => item.id === layerId); if (!layer) return [];
  const siblings = siblingLayers(layers, layer.parentId), at = siblings.indexOf(layer), next = at + direction;
  if (next < 0 || next >= siblings.length) return [];
  [siblings[at], siblings[next]] = [siblings[next], siblings[at]];
  if (siblings.some((item, z) => item.locked && item.z !== z)) throw new Error('请先解锁要调整顺序的图层');
  return siblings.flatMap((item, z): DocumentCommand[] => item.z === z ? [] : [{ type: 'layer.update', layerId: item.id, patch: { z } }]);
}
