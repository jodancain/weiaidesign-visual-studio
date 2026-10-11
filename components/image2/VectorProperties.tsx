'use client';
import { useEffect, useState } from 'react';
import { assetUrl } from '../../lib/image2/client';
import type { ImageLayer } from '../../lib/image2/types';
export function VectorProperties({ layer, onPatch }: { layer: ImageLayer; onPatch: (patch: Partial<ImageLayer>) => void }) {
  const [paths, setPaths] = useState<string[]>([]), [target, setTarget] = useState('*');
  useEffect(() => {
    if (!layer.assetId) return; let active = true;
    fetch(assetUrl(layer.assetId)).then(response => response.text()).then(markup => {
      const doc = new DOMParser().parseFromString(markup, 'image/svg+xml'), counters: Record<string, number> = {};
      const ids = Array.from(doc.querySelectorAll('path,polygon,rect,circle,ellipse,line,polyline')).map(element => {
        const tag = element.localName, index = counters[tag] || 0; counters[tag] = index + 1; return element.id || `${tag}-${index}`;
      }); if (active) setPaths(ids);
    }).catch(() => { if (active) setPaths([]); }); return () => { active = false; };
  }, [layer.assetId]);
  const styles = layer.metadata?.pathStyles as Record<string, Record<string, unknown>> | undefined;
  const paint = { ...styles?.['*'], ...styles?.[target] };
  const change = (value: Record<string, unknown>) => onPatch({ metadata: { ...layer.metadata, pathStyles: { ...styles, [target]: { ...styles?.[target], ...value } } } });
  return <section className="i2-text-properties"><h3>Logo 轮廓</h3><label>修改范围<select aria-label="Logo 路径" value={target} onChange={e => setTarget(e.target.value)}><option value="*">整个图形</option>{paths.map(id => <option key={id} value={id}>{id}</option>)}</select></label>
    <label>填色<input aria-label="Logo 填色" type="color" value={String(paint.fill || '#20232b')} onChange={e => change({ fill: e.target.value })} /></label>
    <label>描边<input aria-label="Logo 描边" type="color" value={String(paint.stroke || '#20232b')} onChange={e => change({ stroke: e.target.value, 'stroke-width': paint['stroke-width'] || 1 })} /></label>
    <label>描边宽度<input type="number" min="0" step=".1" key={`${target}-${paint['stroke-width']}`} defaultValue={Number(paint['stroke-width'] || 0)} onBlur={e => { const width = Number(e.target.value); if (width >= 0) change({ 'stroke-width': width }); }} /></label>
  </section>;
}
