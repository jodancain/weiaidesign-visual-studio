import { documentToLocal, localToDocument } from './geometry';
import type { DocumentCommand, ImageDocument, ImageLayer } from './types';
import { siblingLayers } from './stacking';
function chain(layer: ImageLayer, layers: ImageLayer[]) {
  const result: ImageLayer[] = []; let next: ImageLayer | undefined = layer;
  while (next) { result.push(next); next = layers.find(item => item.id === next!.parentId); }
  return result;
}
const rotation = (layer: ImageLayer, layers: ImageLayer[]) => chain(layer, layers).reduce((sum, item) => sum + item.rotation, 0);
/** Structure only: pixels, paths, font assets and stable child IDs are retained. */
export function groupLayerCommands(document: ImageDocument, selectedIds: string[], groupId = crypto.randomUUID()): DocumentCommand[] {
  const selected = document.layers.filter(layer => selectedIds.includes(layer.id)).filter(layer => !chain(layer, document.layers).slice(1).some(parent => selectedIds.includes(parent.id))).sort((a, b) => a.z - b.z);
  if (selected.length < 2) throw new Error('选择两个或更多图层再编组');
  if (selected.some(layer => chain(layer, document.layers).some(parent => parent.locked))) throw new Error('请先解锁要编组的图层');
  const parentId = selected[0].parentId || undefined;
  if (!selected.every(layer => (layer.parentId || undefined) === parentId)) throw new Error('请选择同一个组合内的图层，保留原来的遮挡顺序');
  const siblings = siblingLayers(document.layers, parentId), positions = selected.map(layer => siblings.indexOf(layer)).sort((a, b) => a - b);
  if (positions.at(-1)! - positions[0] + 1 !== selected.length) throw new Error('请选择相邻的图层，保留原来的遮挡顺序');
  selected.sort((a, b) => siblings.indexOf(a) - siblings.indexOf(b));
  const parent = document.layers.find(layer => layer.id === parentId);
  const inParent = (point: { x: number; y: number }) => parent ? documentToLocal(point, parent, document.layers) : point;
  const corners = selected.flatMap(layer => [[0, 0], [layer.width, 0], [0, layer.height], [layer.width, layer.height]].map(([x, y]) => inParent(localToDocument({ x, y }, layer, document.layers))));
  const x = Math.min(...corners.map(point => point.x)), y = Math.min(...corners.map(point => point.y));
  const z = selected[0].z;
  const group: ImageLayer = { id: groupId, type: 'group', name: '组合', x, y, width: Math.max(1, Math.max(...corners.map(point => point.x)) - x), height: Math.max(1, Math.max(...corners.map(point => point.y)) - y),
    rotation: 0, opacity: 1, visible: true, locked: false, z, ...(parentId ? { parentId } : {}) };
  const commands: DocumentCommand[] = [{ type: 'layer.add', layer: group }];
  // Normalize only this sibling context, including ties, around the new subtree.
  const replacement = siblings.filter(layer => !selected.includes(layer)); replacement.splice(positions[0], 0, group);
  if (replacement.some((layer, z) => layer.locked && layer.z !== z)) throw new Error('请先解锁同组图层，再调整编组顺序');
  commands.push(...replacement.flatMap((layer, z): DocumentCommand[] => layer.z === z ? [] : [{ type: 'layer.update', layerId: layer.id, patch: { z } }]));
  for (const [index, layer] of selected.entries()) {
    const origin = inParent(localToDocument({ x: 0, y: 0 }, layer, document.layers));
    commands.push({ type: 'layer.update', layerId: layer.id, patch: { parentId: groupId, x: origin.x - x, y: origin.y - y, rotation: rotation(layer, document.layers) - (parent ? rotation(parent, document.layers) : 0), z: index,
    } });
  }
  return commands;
}
export function ungroupLayerCommands(document: ImageDocument, groupId: string): DocumentCommand[] {
  const group = document.layers.find(layer => layer.id === groupId);
  if (!group || group.type !== 'group') throw new Error('请选择一个组合');
  if (group.opacity !== 1) throw new Error('此组合使用整体透明度，请保留编组以保持重叠部分的颜色');
  if (chain(group, document.layers).some(node => node.locked)) throw new Error('请先解锁这个组合');
  const children = document.layers.filter(layer => layer.parentId === groupId).sort((a, b) => a.z - b.z);
  if (children.some(layer => layer.locked)) throw new Error('请先解锁组合中的图层');
  const parent = document.layers.find(layer => layer.id === group.parentId);
  const siblings = siblingLayers(document.layers, group.parentId), expanded = siblings.flatMap(layer => layer.id === groupId ? children : [layer]);
  if (expanded.some((layer, z) => layer.locked && layer.z !== z)) throw new Error('请先解锁同组图层，再拆开组合');
  const commands: DocumentCommand[] = children.map(layer => {
    const point = localToDocument({ x: 0, y: 0 }, layer, document.layers), origin = parent ? documentToLocal(point, parent, document.layers) : point;
    return { type: 'layer.update', layerId: layer.id, patch: { parentId: group.parentId || null, x: origin.x, y: origin.y,
      rotation: rotation(layer, document.layers) - (parent ? rotation(parent, document.layers) : 0), visible: layer.visible && group.visible, z: expanded.indexOf(layer) } };
  });
  commands.push(...expanded.filter(layer => !children.includes(layer)).flatMap((layer): DocumentCommand[] => layer.z === expanded.indexOf(layer) ? [] : [{ type: 'layer.update', layerId: layer.id, patch: { z: expanded.indexOf(layer) } }]));
  commands.push({ type: 'layer.remove', layerId: groupId }); return commands;
}
