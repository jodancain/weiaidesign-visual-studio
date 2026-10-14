import type { ImageLayer } from './types';

export function svgHexPaintChange(value: string, current: string): string | undefined {
  const normalized = value.trim().replace(/^#?/, '#').toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(normalized)) throw new Error('请输入六位 HEX 色值，例如 #ff0000');
  return normalized === current.toLowerCase() ? undefined : normalized;
}

/** Legacy SVG controls use CSS names; immutable v3 content uses typed JSON names. */
export function professionalSvgStyles(value: unknown): Record<string, Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('SVG 路径样式必须是对象');
  return Object.fromEntries(Object.entries(value).map(([id, entry]) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('SVG 路径样式无效');
    const style = { ...entry } as Record<string, unknown>;
    if ('stroke-width' in style) { style.strokeWidth = style['stroke-width']; delete style['stroke-width']; }
    return [id, style];
  }));
}

/** Apply just the user's changed paint fields to the latest accepted layer, not a captured UI snapshot. */
export function svgPaintPatch(layer: ImageLayer, target: string, paint: Record<string, unknown>, format: 'typed' | 'css' = 'typed'): Partial<ImageLayer> {
  const styles = professionalSvgStyles(layer.metadata?.pathStyles || {});
  const changed = professionalSvgStyles({ [target]: paint })[target];
  const effective = { ...styles['*'], ...styles[target] };
  if ('stroke' in changed && !('strokeWidth' in changed) && !Number(effective.strokeWidth)) changed.strokeWidth = 1;
  const merged = { ...styles, [target]: { ...styles[target], ...changed } };
  const pathStyles = format === 'typed' ? merged : Object.fromEntries(Object.entries(merged).map(([id, value]) => {
    const css = { ...value }; if ('strokeWidth' in css) { css['stroke-width'] = css.strokeWidth; delete css.strokeWidth; } return [id, css];
  }));
  return { metadata: { ...layer.metadata, pathStyles } };
}

/** A stale asset-list projection must not erase the immutable SVG source/font identities. */
export function professionalSvgContent(layer: ImageLayer, active: Record<string, unknown> | undefined, registeredAssetIds: readonly string[]) {
  const inherited = active?.formatVersion === 1 && active.kind === 'svg' ? active : undefined;
  const sourceAssetId = layer.assetId || inherited?.sourceAssetId;
  if (typeof sourceAssetId !== 'string' || !registeredAssetIds.includes(sourceAssetId)) throw new Error('SVG 原始素材尚未就绪，请刷新图层后重试；不会提交缺失来源的内容。');
  const fontAssetIds = layer.metadata?.svgFontAssetIds ?? inherited?.fontAssetIds ?? [];
  if (!Array.isArray(fontAssetIds) || !fontAssetIds.every(id => typeof id === 'string' && registeredAssetIds.includes(id))) throw new Error('SVG 实际字体引用尚未就绪，请刷新素材后重试。');
  const fill = layer.fill ?? inherited?.fill, styles = layer.metadata?.pathStyles ?? inherited?.pathStyles;
  const normalizedStyles = styles ? professionalSvgStyles(styles) : undefined;
  if (typeof inherited?.appearanceAssetId === 'string') {
    const comparable = (value: Record<string, Record<string, unknown>>) => JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([id, paint]) => [id, Object.entries(paint).sort(([a], [b]) => a.localeCompare(b))]));
    const changed = sourceAssetId !== inherited.sourceAssetId || fill !== inherited.fill || comparable(normalizedStyles || {}) !== comparable(professionalSvgStyles(inherited.pathStyles || {}));
    if (changed) throw new Error('此 SVG 正在保留原始外观像素；请先转换并确认字体与路径，再修改填色或描边。原外观已保留。');
  }
  return { formatVersion: 1, kind: 'svg', sourceAssetId, fontAssetIds: [...fontAssetIds],
    ...(typeof fill === 'string' ? { fill } : {}), ...(normalizedStyles ? { pathStyles: normalizedStyles } : {}),
    ...(typeof inherited?.appearanceAssetId === 'string' ? { appearanceAssetId: inherited.appearanceAssetId } : {}) };
}
