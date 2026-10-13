'use client';
import { useEffect, useState } from 'react';
import { assetUrl } from '../../lib/image2/client';
import type { ImageLayer } from '../../lib/image2/types';
import { inspectDrawingNodes } from '../../services/image2/svg-normalize.mjs';
export function VectorProperties({ layer, onPatch }: { layer: ImageLayer; onPatch: (patch: Partial<ImageLayer>) => void }) {
  const sourceWidth = Number(layer.metadata?.intrinsicWidth) || Number(layer.metadata?.pixelWidth) || undefined;
  const sourceHeight = Number(layer.metadata?.intrinsicHeight) || Number(layer.metadata?.pixelHeight) || undefined;
  const assetKey = `${layer.id}:${layer.assetId || ''}:${sourceWidth}:${sourceHeight}`;
  const [index, setIndex] = useState<{ key: string; paths: string[]; error: string }>({ key: '', paths: [], error: '' });
  const [target, setTarget] = useState('*');
  const ready = index.key === assetKey && !index.error;
  const paths = ready ? index.paths : [];
  const editable = ready && paths.length > 0;
  const currentTarget = ready && (target === '*' || paths.includes(target)) ? target : '*';
  useEffect(() => {
    if (!layer.assetId) return; let active = true;
    fetch(assetUrl(layer.assetId)).then(response => { if (!response.ok) throw new Error('矢量对象暂时无法读取'); return response.text(); }).then(markup => {
      // Paint controls edit actual painted geometry, not embedded pixels or use instances.
      const ids = inspectDrawingNodes(markup, { fallbackWidth: sourceWidth, fallbackHeight: sourceHeight }).filter(node => !['image', 'use'].includes(node.tag)).map(node => node.id);
      if (active) { setIndex({ key: assetKey, paths: ids, error: '' }); setTarget(current => current === '*' || ids.includes(current) ? current : '*'); }
    }).catch(error => { if (active) { setIndex({ key: assetKey, paths: [], error: error.message }); setTarget('*'); } }); return () => { active = false; };
  }, [assetKey, layer.assetId, sourceWidth, sourceHeight]);
  const styles = layer.metadata?.pathStyles as Record<string, Record<string, unknown>> | undefined;
  const paint = { ...styles?.['*'], ...styles?.[currentTarget] };
  const change = (value: Record<string, unknown>) => { if (editable) onPatch({ metadata: { ...layer.metadata, pathStyles: { ...styles, [currentTarget]: { ...styles?.[currentTarget], ...value } } } }); };
  return <section className="i2-text-properties"><h3>矢量属性</h3>{!ready && <p>{!layer.assetId ? '矢量素材缺失，请重新选择本地素材' : index.key === assetKey && index.error ? index.error : '正在读取矢量对象…'}</p>}{ready && !editable && <p>此素材暂无可直接改色的路径；嵌入图片保留原像素。</p>}<label>修改范围<select aria-label="Logo 路径" value={currentTarget} disabled={!editable} onChange={e => setTarget(e.target.value)}><option value="*">整个图形</option>{paths.map(id => <option key={id} value={id}>{id}</option>)}</select></label>
    <label>填色<input aria-label="Logo 填色" type="color" disabled={!editable} value={String(paint.fill || '#20232b')} onChange={e => change({ fill: e.target.value })} /></label>
    <label>描边<input aria-label="Logo 描边" type="color" disabled={!editable} value={String(paint.stroke || '#20232b')} onChange={e => change({ stroke: e.target.value, 'stroke-width': paint['stroke-width'] || 1 })} /></label>
    <label>描边宽度<input type="number" disabled={!editable} min="0" step=".1" key={`${assetKey}-${currentTarget}-${paint['stroke-width']}`} defaultValue={Number(paint['stroke-width'] || 0)} onBlur={e => { const width = Number(e.target.value); if (Number.isFinite(width) && width >= 0) change({ 'stroke-width': width }); }} /></label>
  </section>;
}
