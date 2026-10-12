'use client';
import { useEffect, useState } from 'react';
import { BaseBoxShapeUtil, HTMLContainer, Rectangle2d, T, type TLBaseShape, type TLResizeInfo, resizeBox } from 'tldraw';
import { assetUrl } from '../../lib/image2/client';
import type { ImageLayer } from '../../lib/image2/types';

type DesignShape = TLBaseShape<'design-text' | 'design-vector' | 'source-mask' | 'design-group', { w: number; h: number; layer: ImageLayer }>;
const props = { w: T.number, h: T.number, layer: T.jsonValue };
export function safeSvg(markup: string, fill?: string, pathStyles?: Record<string, Record<string, unknown>>, scope = 'i2-vector') {
  const doc = new DOMParser().parseFromString(markup, 'image/svg+xml');
  if (doc.querySelector('parsererror') || doc.documentElement.localName !== 'svg') throw new Error('SVG 格式无效');
  doc.documentElement.setAttribute('id', scope);
  const counters: Record<string, number> = {};
  for (const element of Array.from(doc.querySelectorAll('*'))) {
    if (['script', 'foreignObject', 'iframe', 'object', 'embed'].includes(element.localName)) { element.remove(); continue; }
    if (element.localName === 'style') {
      // Preserve ordinary SVG class paint without allowing CSS to style the workspace itself.
      const allowed = new Set(['fill', 'stroke', 'stroke-width', 'opacity', 'fill-opacity', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'fill-rule', 'clip-rule', 'color', 'stop-color', 'stop-opacity']);
      element.textContent = Array.from((element.textContent || '').matchAll(/([^{}]+)\{([^{}]*)\}/g)).map(match => {
        if (/[@]|expression|javascript:/i.test(match[0]) || Array.from(match[0].matchAll(/url\(([^)]*)\)/gi)).some(url => !url[1].trim().replace(/^['"]|['"]$/g, '').startsWith('#'))) return '';
        const declarations = match[2].split(';').filter(part => allowed.has(part.split(':')[0].trim())).join(';');
        const selectors = match[1].split(',').filter(selector => /^[\w\s.#>:+\-\[\]="']+$/.test(selector.trim())).map(selector => `#${scope} ${selector.trim()}`);
        return declarations && selectors.length ? `${selectors.join(',')}{${declarations}}` : '';
      }).join('\n'); continue;
    }
    for (const attr of Array.from(element.attributes)) {
      const externalUrl = Array.from(attr.value.matchAll(/url\(([^)]*)\)/gi)).some(url => !url[1].trim().replace(/^['"]|['"]$/g, '').startsWith('#'));
      if (/^on/i.test(attr.name) || ((attr.name === 'href' || attr.name === 'xlink:href') && !attr.value.startsWith('#')) || externalUrl || /javascript:/i.test(attr.value)) element.removeAttribute(attr.name);
    }
    if (['path', 'polygon', 'rect', 'circle', 'ellipse', 'line', 'polyline'].includes(element.localName)) {
      const tag = element.localName, index = counters[tag] || 0; counters[tag] = index + 1;
      const id = element.id || `${tag}-${index}`, paint: Record<string, unknown> = { ...(fill ? { fill } : {}), ...pathStyles?.['*'], ...pathStyles?.[id] };
      for (const key of ['fill', 'stroke', 'stroke-width']) if (paint[key] !== undefined) {
        element.setAttribute(key, String(paint[key]));
        if (element.hasAttribute('style')) element.setAttribute('style', element.getAttribute('style')!.split(';').filter(part => part.split(':')[0].trim() !== key).join(';'));
        (element as SVGElement).style.setProperty(key, String(paint[key]), 'important');
      }
    }
  }
  // Two uploaded Logos often reuse paint0/clip0. Keep those resources local to this layer.
  const ids = new Map(Array.from(doc.querySelectorAll('[id]')).map((element, index) => [element.id, `${scope}_${index}`]));
  const references = (value: string) => value.replace(/url\(\s*(['"]?)#([^\s)'";]+)\1\s*\)/gi, (_all, quote: string, id: string) => `url(${quote}#${ids.get(id) || id}${quote})`);
  for (const element of Array.from(doc.querySelectorAll('*'))) {
    for (const attribute of Array.from(element.attributes)) {
      if (attribute.name === 'id') element.setAttribute('id', ids.get(attribute.value) || attribute.value);
      else if ((attribute.name === 'href' || attribute.name === 'xlink:href') && attribute.value.startsWith('#')) element.setAttribute(attribute.name, `#${ids.get(attribute.value.slice(1)) || attribute.value.slice(1)}`);
      else element.setAttribute(attribute.name, references(attribute.value));
    }
    if (element.localName === 'style') element.textContent = (element.textContent || '').replace(/([^{}]+)\{([^{}]*)\}/g, (_all, selectors: string, declarations: string) => `${selectors.replace(/#([\w-]+)/g, (_match, id: string) => `#${ids.get(id) || id}`)}{${references(declarations)}}`);
  }
  doc.documentElement.setAttribute('width', '100%'); doc.documentElement.setAttribute('height', '100%'); doc.documentElement.setAttribute('preserveAspectRatio', 'none');
  return new XMLSerializer().serializeToString(doc.documentElement);
}
function VectorLayer({ layer }: { layer: ImageLayer }) {
  const [svg, setSvg] = useState(''), [error, setError] = useState('');
  useEffect(() => {
    if (!layer.assetId) return;
    let active = true;
    fetch(assetUrl(layer.assetId)).then(async response => { if (!response.ok) throw new Error('矢量文件不可用'); return response.text(); })
      .then(text => { if (active) { setSvg(safeSvg(text, layer.fill, layer.metadata?.pathStyles as Record<string, Record<string, unknown>> | undefined, `i2-vector-${layer.id}`)); setError(''); } }).catch(err => { if (active) setError(err.message); });
    return () => { active = false; };
  }, [layer.id, layer.assetId, layer.fill, layer.metadata?.pathStyles]);
  return svg ? <div className="i2-svg" style={{ width: '100%', height: '100%' }} dangerouslySetInnerHTML={{ __html: svg }} /> : <span>{error || '读取图形…'}</span>;
}
function RenderLayer({ layer }: { layer: ImageLayer }) {
  if (layer.metadata?.presentationArtboard) return <div style={{ width: '100%', height: '100%', background: '#fff', border: '1px solid #dadce3', boxShadow: '0 3px 14px #0000000c' }} />;
  if (layer.type === 'group') return null;
  const sourcePatch = layer.type === 'text' && layer.metadata?.fontConfirmed !== true && layer.assetId;
  if (layer.type === 'vector') return <VectorLayer layer={layer} />;
  if (layer.type === 'text' && !sourcePatch) return <svg width="100%" height="100%" viewBox={`0 0 ${layer.width} ${layer.height}`} style={{ overflow: 'visible' }}>
    {layer.metadata?.backgroundDetached !== true && typeof layer.metadata?.cleanBackgroundAssetId === 'string' && <image href={assetUrl(layer.metadata.cleanBackgroundAssetId)} width={layer.width} height={layer.height} preserveAspectRatio="none" />}
    <text x="0" y={layer.fontSize || 24} fill={layer.fill || '#20232b'} stroke={layer.stroke} strokeWidth={layer.strokeWidth || 0}
      fontFamily={layer.fontAssetId ? `i2-${layer.fontAssetId}` : layer.fontFamily || 'sans-serif'} fontSize={layer.fontSize || 24}
      fontWeight={layer.fontWeight || 400} letterSpacing={layer.tracking || 0} style={{ paintOrder: 'stroke fill', fontSynthesis: 'none' }}>
      {(layer.text || '').split('\n').map((line, index) => <tspan key={index} x="0" dy={index ? (layer.fontSize || 24) * (layer.lineHeight || 1.2) : 0}>{line}</tspan>)}
    </text>
  </svg>;
  if (!layer.assetId) return <div className="i2-layer-placeholder">{layer.name}</div>;
  // Immutable pixel assets must not be resampled by Next's image optimizer.
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={assetUrl(layer.assetId)} alt={layer.name} draggable={false} style={{ width: '100%', height: '100%', objectFit: 'fill',
    ...(layer.maskAssetId ? { maskImage: `url("${assetUrl(layer.maskAssetId)}")`, maskSize: '100% 100%', maskMode: 'luminance' as const } : {}) }} />;
}
abstract class DesignShapeBase extends BaseBoxShapeUtil<DesignShape> {
  static props = props;
  getDefaultProps(): DesignShape['props'] { return { w: 100, h: 100, layer: { id: '', type: 'raster', name: '', x: 0, y: 0, width: 100, height: 100, rotation: 0, opacity: 1, visible: true, locked: false, z: 0 } }; }
  getGeometry(shape: DesignShape) { return new Rectangle2d({ width: shape.props.w, height: shape.props.h, isFilled: true }); }
  component(shape: DesignShape) { return <HTMLContainer style={{ width: shape.props.w, height: shape.props.h }}><RenderLayer layer={shape.props.layer} /></HTMLContainer>; }
  indicator(shape: DesignShape) { return <rect width={shape.props.w} height={shape.props.h} />; }
  onResize(shape: DesignShape, info: TLResizeInfo<DesignShape>) { return resizeBox(shape, info); }
}
export class DesignTextShapeUtil extends DesignShapeBase { static type = 'design-text' as const; }
export class DesignVectorShapeUtil extends DesignShapeBase { static type = 'design-vector' as const; }
export class SourceMaskShapeUtil extends DesignShapeBase { static type = 'source-mask' as const; }
/** Native tldraw groups normalize child bounds; document groups must retain canonical pixel coordinates. */
export class DesignGroupShapeUtil extends DesignShapeBase { static type = 'design-group' as const; }
export const designShapeUtils = [DesignTextShapeUtil, DesignVectorShapeUtil, SourceMaskShapeUtil, DesignGroupShapeUtil];
