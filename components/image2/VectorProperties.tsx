'use client';
import { useEffect, useState } from 'react';
import { assetUrl } from '../../lib/image2/client';
import type { ImageLayer } from '../../lib/image2/types';
import { svgPaintChange } from '../../lib/image2/professional-svg-styles';
import { commonSvgPaint, readSvgPaints, type SvgPathPaint } from '../../lib/image2/svg-paint-readback';
export function VectorProperties({ layer, onPatch, onPaint, disabled = false }: { layer: ImageLayer; onPatch: (patch: Partial<ImageLayer>) => void; onPaint?: (target: string, paint: Record<string, unknown>) => void; disabled?: boolean }) {
  const sourceWidth = Number(layer.metadata?.intrinsicWidth) || Number(layer.metadata?.pixelWidth) || undefined;
  const sourceHeight = Number(layer.metadata?.intrinsicHeight) || Number(layer.metadata?.pixelHeight) || undefined;
  const assetKey = `${layer.id}:${layer.assetId || ''}:${sourceWidth}:${sourceHeight}`;
  const [source, setSource] = useState({ key: '', markup: '', error: '' });
  const stylesJson = JSON.stringify(layer.metadata?.pathStyles || {});
  const paintKey = JSON.stringify([assetKey, layer.fill, stylesJson]);
  const [index, setIndex] = useState<{ key: string; paths: SvgPathPaint[]; error: string }>({ key: '', paths: [], error: '' });
  const [target, setTarget] = useState('*');
  const ready = index.key === paintKey && !index.error;
  const paths = ready ? index.paths.map(path => path.id) : [];
  const editable = ready && paths.length > 0 && !disabled;
  const currentTarget = ready && (target === '*' || paths.includes(target)) ? target : '*';
  useEffect(() => {
    if (!layer.assetId) return; let active = true;
    fetch(assetUrl(layer.assetId)).then(response => { if (!response.ok) throw new Error('矢量对象暂时无法读取'); return response.text(); }).then(markup => {
      if (active) setSource({ key: assetKey, markup, error: '' });
    }).catch(error => { if (active) setSource({ key: assetKey, markup: '', error: error.message }); }); return () => { active = false; };
  }, [assetKey, layer.assetId, sourceWidth, sourceHeight]);
  useEffect(() => {
    if (source.key !== assetKey) return; let active = true;
    void Promise.resolve().then(() => {
      if (!active) return;
      if (source.error) throw new Error(source.error);
      const paints = readSvgPaints(source.markup, { fill: layer.fill, styles: JSON.parse(stylesJson), fallbackWidth: sourceWidth, fallbackHeight: sourceHeight });
      if (active) { setIndex({ key: paintKey, paths: paints, error: '' }); setTarget(current => current === '*' || paints.some(path => path.id === current) ? current : '*'); }
    }).catch(error => { if (active) setIndex({ key: paintKey, paths: [], error: error.message }); });
    return () => { active = false; };
  }, [assetKey, source, paintKey, layer.fill, stylesJson, sourceWidth, sourceHeight]);
  const styles = layer.metadata?.pathStyles as Record<string, Record<string, unknown>> | undefined;
  const paint = commonSvgPaint(ready ? index.paths : [], currentTarget);
  const strokeWidth = paint.strokeWidth;
  const change = (value: Record<string, unknown>) => { if (editable) { if (onPaint) onPaint(currentTarget, value); else onPatch({ metadata: { ...layer.metadata, pathStyles: { ...styles, [currentTarget]: { ...styles?.[currentTarget], ...value } } } }); } };
  const commitHex = (input: HTMLInputElement, field: 'fill' | 'stroke') => {
    if (!editable) return;
    try { const color = svgPaintChange(input.value, paint[field]); input.setCustomValidity(''); if (color) change({ [field]: color }); }
    catch (error) { input.setCustomValidity((error as Error).message); input.reportValidity(); }
  };
  return <section className="i2-text-properties"><h3>矢量属性</h3>{!ready && <p>{!layer.assetId ? '矢量素材缺失，请重新选择本地素材' : index.key === paintKey && index.error ? index.error : '正在读取矢量对象…'}</p>}{ready && !paths.length && <p>此素材暂无可直接改色的路径；嵌入图片保留原像素。</p>}<label>修改范围<select aria-label="Logo 路径" value={currentTarget} disabled={!editable} onChange={e => setTarget(e.target.value)}><option value="*">整个图形</option>{paths.map(id => <option key={id} value={id}>{id}</option>)}</select></label>
    {(['fill', 'stroke'] as const).map(field => {
      const label = field === 'fill' ? '填色' : '描边', value = paint[field], solid = !!value && /^#[\da-f]{6}$/i.test(value);
      return <div key={field} style={{display:'grid',gridTemplateColumns:'76px minmax(0,1fr)',gap:8}}><label>{label}<input aria-label={`Logo ${label}`} type="color" disabled={!editable} value={solid ? value : '#000000'} title={value === 'none' ? `无${label}；选择颜色可设置` : value || '多种颜色；选择颜色将统一'} style={{ opacity: solid ? 1 : 0.35 }} onChange={e => { if (e.target.value !== value) change({ [field]: e.target.value }); }} /></label><label>{field === 'fill' ? '填色色值' : '描边色值'}<input aria-label={`Logo ${field === 'fill' ? '填色色值' : '描边色值'}`} type="text" disabled={!editable} key={`${assetKey}-${currentTarget}-${field}-${value}`} defaultValue={value || ''} placeholder={ready ? '多种颜色（#rrggbb / none）' : '读取中…'} spellCheck={false} onChange={e => e.currentTarget.setCustomValidity('')} onBlur={e => commitHex(e.currentTarget, field)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }} /></label></div>;
    })}
    <label>描边宽度<input type="number" disabled={!editable} min="0" step=".1" key={`${assetKey}-${currentTarget}-${strokeWidth}`} defaultValue={strokeWidth ?? ''} placeholder="多个宽度" onBlur={e => { if (!e.target.value.trim()) return; const width = Number(e.target.value); if (Number.isFinite(width) && width >= 0 && width !== strokeWidth) change({ 'stroke-width': width }); }} /></label>
  </section>;
}
