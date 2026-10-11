'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Tldraw, createShapeId, getIndexAbove, getIndexBetween, type Editor, type TLShape } from 'tldraw';
import 'tldraw/tldraw.css';
import { designShapeUtils } from './DesignShapes';
import type { DocumentCommand, ImageDocument, ImageLayer } from '../../lib/image2/types';
import { orderedLayers } from '../../lib/image2/stacking';
const visibility = (shape: TLShape) => shape.meta.hidden ? 'hidden' as const : 'inherit' as const;

export function DocumentCanvas({ document, selectedId, onSelect, onCommands }: {
  document: ImageDocument; selectedId?: string; onSelect: (id?: string) => void; onCommands: (commands: DocumentCommand[]) => void;
}) {
  const [editor, setEditor] = useState<Editor | null>(null);
  const mountEditor = useCallback((instance: Editor) => { setEditor(instance); setTimeout(() => instance.zoomToFit({ animation: { duration: 0 } }), 150); }, []);
  const projecting = useRef(false), current = useRef(document), commandCallback = useRef(onCommands), selectCallback = useRef(onSelect);
  useEffect(() => { current.current = document; commandCallback.current = onCommands; selectCallback.current = onSelect; }, [document, onCommands, onSelect]);
  useEffect(() => {
    if (!editor) return;
    projecting.current = true;
    editor.run(() => {
      const artboardId = createShapeId(`image2-document-${document.id}`);
      const layers = orderedLayers(document.layers), wanted = new Set([artboardId, ...layers.map(layer => createShapeId(layer.id))]);
      const obsolete = [...editor.getCurrentPageShapeIds()].filter(id => !wanted.has(id)); if (obsolete.length) editor.deleteShapes(obsolete);
      const artboardLayer: ImageLayer = { id: `presentation-${document.id}`, type: 'group', name: document.name, x: 0, y: 0, width: document.width, height: document.height, rotation: 0, opacity: 1, visible: true, locked: true, z: -1, metadata: { presentationArtboard: true } };
      const artboard = { id: artboardId, type: 'design-group', x: 0, y: 0, rotation: 0, index: getIndexBetween(undefined, undefined), parentId: editor.getCurrentPageId(), isLocked: true, opacity: 1, meta: { presentation: true }, props: { w: document.width, h: document.height, layer: artboardLayer } };
      if (editor.getShape(artboardId)) editor.updateShapes([artboard as never]); else editor.createShapes([artboard as never]);
      const pending = [...layers], indexes = new Map<string, ReturnType<typeof getIndexAbove>>();
      while (pending.length) {
        const at = pending.findIndex(layer => !layer.parentId || editor.getShape(createShapeId(layer.parentId)) || !layers.some(item => item.id === layer.parentId));
        if (at < 0) break;
        const layer = pending.splice(at, 1)[0], id = createShapeId(layer.id);
        const parentKey = layer.parentId && layers.some(item => item.id === layer.parentId) ? layer.parentId : '';
        const index = indexes.has(parentKey) ? getIndexAbove(indexes.get(parentKey)!) : parentKey ? getIndexBetween(undefined, undefined) : getIndexAbove(artboard.index);
        indexes.set(parentKey, index);
        const record = {
          id, type: layer.type === 'group' ? 'design-group' : layer.type === 'text' ? 'design-text' : layer.type === 'vector' ? 'design-vector' : 'source-mask',
          x: layer.x, y: layer.y, rotation: layer.rotation * Math.PI / 180, index,
          parentId: layer.parentId && layers.some(item => item.id === layer.parentId) ? createShapeId(layer.parentId) : editor.getCurrentPageId(),
          opacity: layer.opacity, isLocked: layer.locked, meta: { layerId: layer.id, hidden: !layer.visible },
          props: { w: layer.width, h: layer.height, layer },
        };
        // Custom shapes are validated by the registered ShapeUtil schemas.
        if (editor.getShape(id)) editor.updateShapes([record as never]); else editor.createShapes([record as never]);
      }
    }, { history: 'ignore', ignoreShapeLock: true });
    projecting.current = false;
  }, [document, editor]);
  useEffect(() => { if (!editor) return; if (selectedId) editor.select(createShapeId(selectedId)); else editor.selectNone(); }, [editor, selectedId]);
  useEffect(() => {
    if (!editor) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unlisten = editor.store.listen(() => {
      if (projecting.current) return;
      clearTimeout(timer); timer = setTimeout(() => {
        const commands: DocumentCommand[] = [];
        for (const layer of current.current.layers) {
          const shape = editor.getShape(createShapeId(layer.id));
          if (!shape) { commands.push({ type: 'layer.remove', layerId: layer.id }); continue; }
          const props = shape.props as { w?: number; h?: number };
          const patch: Partial<ImageLayer> = { x: shape.x, y: shape.y, rotation: shape.rotation * 180 / Math.PI,
            width: props.w, height: props.h };
          if (Object.entries(patch).some(([key, value]) => typeof value === 'number' && Math.abs(value - Number(layer[key as keyof ImageLayer])) > 0.01)) commands.push({ type: 'layer.update', layerId: layer.id, patch });
        }
        const known = new Set(current.current.layers.map(layer => createShapeId(layer.id)));
        for (const shapeId of editor.getCurrentPageShapeIds()) {
          if (known.has(shapeId)) continue;
          const shape = editor.getShape(shapeId), props = shape?.props as { layer?: ImageLayer; w?: number; h?: number } | undefined;
          if (!shape || shape.meta.presentation || !props?.layer) continue;
          const parent = editor.getShape(shape.parentId as never);
          commands.push({ type: 'layer.add', layer: { ...props.layer, id: crypto.randomUUID(), name: `${props.layer.name} 副本`,
            x: shape.x, y: shape.y, width: props.w || props.layer.width, height: props.h || props.layer.height,
            rotation: shape.rotation * 180 / Math.PI, parentId: parent?.meta.layerId as string | undefined, z: current.current.layers.length + commands.filter(command => command.type === 'layer.add').length } });
        }
        if (commands.length) commandCallback.current(commands);
      }, 180);
    }, { scope: 'document', source: 'user' });
    const selection = editor.store.listen(() => {
      const shape = editor.getOnlySelectedShape(); selectCallback.current(shape?.meta.layerId as string | undefined);
    }, { scope: 'session', source: 'user' });
    return () => { unlisten(); selection(); clearTimeout(timer); };
  }, [editor]);
  return <div className="i2-canvas" data-testid="image2-canvas"><Tldraw key={document.id} hideUi shapeUtils={designShapeUtils}
    getShapeVisibility={visibility} onMount={mountEditor} /></div>;
}
