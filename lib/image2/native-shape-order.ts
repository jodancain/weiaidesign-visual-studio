import type { ImageLayer } from './types';

interface CanvasShapeNode { id: string; parentId: string; index: string }

/** Canvas indices order siblings only. Validate the complete graph before any asset conversion. */
export function canvasShapesParentFirst<T extends CanvasShapeNode>(shapes: readonly T[], pageId: string): T[] {
  const byId = new Map<string, T>(), children = new Map<string, T[]>();
  for (const shape of shapes) {
    if (shape.id === pageId || byId.has(shape.id)) throw new Error('画布对象编号重复，原草稿已保留');
    byId.set(shape.id, shape);
  }
  for (const shape of shapes) {
    if (shape.parentId !== pageId && !byId.has(shape.parentId)) throw new Error('画布父对象缺失，原草稿已保留');
    const siblings = children.get(shape.parentId) || [];
    siblings.push(shape); children.set(shape.parentId, siblings);
  }
  for (const siblings of children.values()) siblings.sort((a, b) => a.index.localeCompare(b.index));
  const ordered: T[] = [], pending = [...(children.get(pageId) || [])].reverse();
  while (pending.length) {
    const shape = pending.pop()!;
    ordered.push(shape);
    const descendants = children.get(shape.id) || [];
    for (let i = descendants.length - 1; i >= 0; i--) pending.push(descendants[i]);
  }
  // Any unreachable node has a cycle: missing parents were rejected above.
  if (ordered.length !== shapes.length) throw new Error('画布分组存在循环，原草稿已保留');
  return ordered;
}

export function canvasParentLayerId(
  shape: Pick<CanvasShapeNode, 'parentId'>,
  pageId: string,
  staged: ReadonlyMap<string, ImageLayer>,
  existing: readonly ImageLayer[],
  shapeIdForLayer: (layer: ImageLayer) => string,
): string | undefined {
  if (shape.parentId === pageId) return undefined;
  const parent = staged.get(shape.parentId) || existing.find(layer => shapeIdForLayer(layer) === shape.parentId);
  if (!parent) throw new Error('画布父对象尚未转换，原草稿已保留');
  if (parent.type !== 'group') throw new Error('画布父对象无法作为图层组，原草稿已保留');
  return parent.id;
}
