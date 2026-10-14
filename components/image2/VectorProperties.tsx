'use client';
import { useEffect, useState } from 'react';
import { assetUrl } from '../../lib/image2/client';
import type { ImageLayer } from '../../lib/image2/types';
import { inspectDrawingNodes } from '../../services/image2/svg-normalize.mjs';
import { svgHexPaintChange } from '../../lib/image2/professional-svg-styles';
export function VectorProperties({ layer, onPatch, onPaint, disabled = false }: { layer: ImageLayer; onPatch: (patch: Partial<ImageLayer>) => void; onPaint?: (target: string, paint: Record<string, unknown>) => void; disabled?: boolean }) {
  const sourceWidth = Number(layer.metadata?.intrinsicWidth) || Number(layer.metadata?.pixelWidth) || undefined;
  const sourceHeight = Number(layer.metadata?.intrinsicHeight) || Number(layer.metadata?.pixelHeight) || undefined;
  const assetKey = `${layer.id}:${layer.assetId || ''}:${sourceWidth}:${sourceHeight}`;
  const [index, setIndex] = useState<{ key: string; paths: string[]; error: string }>({ key: '', paths: [], error: '' });
  const [target, setTarget] = useState('*');
  const ready = index.key === assetKey && !index.error;
  const paths = ready ? index.paths : [];
  const editable = ready && paths.length > 0 && !disabled;
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
  const strokeWidth = paint.strokeWidth ?? paint['stroke-width'];
  const change = (value: Record<string, unknown>) => { if (editable) { if (onPaint) onPaint(currentTarget, value); else onPatch({ metadata: { ...layer.metadata, pathStyles: { ...styles, [currentTarget]: { ...styles?.[currentTarget], ...value } } } }); } };
  const commitHex = (input: HTMLInputElement, field: 'fill' | 'stroke') => {
    if (!editable) return;
    try { const color = svgHexPaintChange(input.value, String(paint[field] || '#20232b')); input.setCustomValidity(''); if (color) change(field === 'stroke' && !onPaint ? { stroke: color, 'stroke-width': strokeWidth || 1 } : { [field]: color }); }
    catch (error) { input.setCustomValidity((error as Error).message); input.reportValidity(); }
  };
  return <section className="i2-text-properties"><h3>矢量属性</h3>{!ready && <p>{!layer.assetId ? '矢量素材缺失，请重新选择本地素材' : index.key === assetKey && index.error ? index.error : '正在读取矢量对象…'}</p>}{ready && !paths.length && <p>此素材暂无可直接改色的路径；嵌入图片保留原像素。</p>}<label>修改范围<select aria-label="Logo 路径" value={currentTarget} disabled={!editable} onChange={e => setTarget(e.target.value)}><option value="*">整个图形</option>{paths.map(id => <option key={id} value={id}>{id}</option>)}</select></label>
    <div style={{display:'grid',gridTemplateColumns:'76px minmax(0,1fr)',gap:8}}><label>填色<input aria-label="Logo 填色" type="color" disabled={!editable} value={String(paint.fill || '#20232b')} onChange={e => change({ fill: e.target.value })} /></label><label>填色色值<input aria-label="Logo 填色色值" type="text" disabled={!editable} key={`${assetKey}-${currentTarget}-fill-${paint.fill}`} defaultValue={String(paint.fill || '#20232b')} placeholder="#rrggbb" spellCheck={false} onChange={e => e.currentTarget.setCustomValidity('')} onBlur={e => commitHex(e.currentTarget, 'fill')} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }} /></label></div>
    <div style={{display:'grid',gridTemplateColumns:'76px minmax(0,1fr)',gap:8}}><label>描边<input aria-label="Logo 描边" type="color" disabled={!editable} value={String(paint.stroke || '#20232b')} onChange={e => change(onPaint ? { stroke: e.target.value } : { stroke: e.target.value, 'stroke-width': strokeWidth || 1 })} /></label><label>描边色值<input aria-label="Logo 描边色值" type="text" disabled={!editable} key={`${assetKey}-${currentTarget}-stroke-${paint.stroke}`} defaultValue={String(paint.stroke || '#20232b')} placeholder="#rrggbb" spellCheck={false} onChange={e => e.currentTarget.setCustomValidity('')} onBlur={e => commitHex(e.currentTarget, 'stroke')} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }} /></label></div>
    <label>描边宽度<input type="number" disabled={!editable} min="0" step=".1" key={`${assetKey}-${currentTarget}-${strokeWidth}`} defaultValue={Number(strokeWidth || 0)} onBlur={e => { const width = Number(e.target.value); if (Number.isFinite(width) && width >= 0 && width !== Number(strokeWidth || 0)) change({ 'stroke-width': width }); }} /></label>
  </section>;
}
