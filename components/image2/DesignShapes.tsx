'use client';
import { useEffect, useMemo, useState } from 'react';
import { BaseBoxShapeUtil, HTMLContainer, Rectangle2d, T, type TLBaseShape, type TLResizeInfo, resizeBox } from 'tldraw';
import { assetUrl } from '../../lib/image2/client';
import type { ImageLayer } from '../../lib/image2/types';
import { normalizeSvg } from '../../services/image2/svg-normalize.mjs';

type DesignShape = TLBaseShape<'design-text' | 'design-vector' | 'source-mask' | 'design-group' | 'design-proxy', { w: number; h: number; layer: ImageLayer }>;
const props = { w: T.number, h: T.number, layer: T.jsonValue };
export function safeSvg(markup: string, fill?: string, pathStyles?: Record<string, Record<string, unknown>>, scope = 'i2-vector', sourceSize?: { width?: number; height?: number }) {
  return normalizeSvg(markup, { scope, fill, styles: pathStyles, responsive: true, preserveAspectRatio: 'none', fallbackWidth: sourceSize?.width, fallbackHeight: sourceSize?.height }).svg;
}

function VectorLayer({ layer }: { layer: ImageLayer }) {
  const sourceWidth = Number(layer.metadata?.intrinsicWidth) || Number(layer.metadata?.pixelWidth) || undefined;
  const sourceHeight = Number(layer.metadata?.intrinsicHeight) || Number(layer.metadata?.pixelHeight) || undefined;
  const assetKey = JSON.stringify([layer.id, layer.assetId]);
  const pathStylesJson = JSON.stringify(layer.metadata?.pathStyles || {});
  const [loaded, setLoaded] = useState({ key: '', markup: '', error: '' });
  useEffect(() => {
    if (!layer.assetId) return;
    let active = true;
    fetch(assetUrl(layer.assetId)).then(async response => { if (!response.ok) throw new Error('矢量文件不可用'); return response.text(); })
      .then(markup => { if (active) setLoaded({ key: assetKey, markup, error: '' }); })
      .catch(err => { if (active) setLoaded({ key: assetKey, markup: '', error: err.message }); });
    return () => { active = false; };
  }, [assetKey, layer.assetId]);
  // Immutable source bytes stay cached while paint controls change locally.
  const rendered = useMemo(() => {
    if (loaded.key !== assetKey || !loaded.markup) return { svg: '', error: loaded.error };
    try {
      return { svg: safeSvg(loaded.markup, layer.fill, JSON.parse(pathStylesJson) as Record<string, Record<string, unknown>>, `i2-vector-${layer.id}`, { width: sourceWidth, height: sourceHeight }), error: '' };
    } catch (error) { return { svg: '', error: error instanceof Error ? error.message : '矢量文件不可用' }; }
  }, [assetKey, loaded, layer.id, layer.fill, pathStylesJson, sourceWidth, sourceHeight]);
  // An old fetch or failed replacement must never display another asset as this layer.
  if (!layer.assetId) return <span>矢量素材缺失，请重新选择本地素材</span>;
  if (loaded.key !== assetKey) return <span>读取图形…</span>;
  return rendered.svg ? <div className="i2-svg" style={{ width: '100%', height: '100%' }} dangerouslySetInnerHTML={{ __html: rendered.svg }} /> : <span>{rendered.error || '矢量文件不可用'}</span>;
}

function LayerContent({ layer }: { layer: ImageLayer }) {
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
  return <img src={assetUrl(layer.assetId)} alt={layer.name} draggable={false} style={{ width: '100%', height: '100%', objectFit: 'fill' }} />;
}
function RenderLayer({ layer }: { layer: ImageLayer }) {
  if (layer.type === 'group') return null;
  // The display mask applies equally to pixels, text and vector contents.
  return <div className="i2-layer-content" style={{ width: '100%', height: '100%',
    ...(layer.maskAssetId ? { maskImage: `url("${assetUrl(layer.maskAssetId)}")`, maskSize: '100% 100%', maskMode: 'luminance' as const } : {}) }}><LayerContent layer={layer} /></div>;
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
/** The shared software renderer paints v3. These boxes only carry interaction geometry. */
export class DesignProxyShapeUtil extends DesignShapeBase {
  static type = 'design-proxy' as const;
  component(shape: DesignShape) { return <HTMLContainer style={{ width: shape.props.w, height: shape.props.h, pointerEvents: 'none' }} />; }
}
export const designShapeUtils = [DesignTextShapeUtil, DesignVectorShapeUtil, SourceMaskShapeUtil, DesignGroupShapeUtil, DesignProxyShapeUtil];
