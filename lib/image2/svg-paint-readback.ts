import { normalizeSvg, type SvgNormalizeOptions } from '../../services/image2/svg-normalize.mjs';

export interface SvgPaint { fill?: string; stroke?: string; strokeWidth?: number }
export interface SvgPathPaint extends SvgPaint { id: string }

/** Browser computed colors use rgb(); keep none/gradients/alpha paints truthful. */
export function svgPaintValue(value: string): string {
  const text = value.trim();
  if (text.toLowerCase() === 'none') return 'none';
  const short = /^#([\da-f])([\da-f])([\da-f])$/i.exec(text);
  if (short) return `#${short.slice(1).map(channel => channel.repeat(2)).join('')}`.toLowerCase();
  if (/^#[\da-f]{6}$/i.test(text)) return text.toLowerCase();
  const rgb = /^rgba?\(\s*(\d+(?:\.\d+)?)\s*[, ]\s*(\d+(?:\.\d+)?)\s*[, ]\s*(\d+(?:\.\d+)?)(?:\s*[,/]\s*(\d+(?:\.\d+)?))?\s*\)$/i.exec(text);
  if (rgb && (rgb[4] === undefined || Number(rgb[4]) === 1) && rgb.slice(1, 4).every(value => Number.isInteger(Number(value)) && Number(value) <= 255)) return `#${rgb.slice(1, 4).map(value => Number(value).toString(16).padStart(2, '0')).join('')}`;
  return text;
}

/** Undefined means mixed/unresolved, never a made-up default paint. */
export function commonSvgPaint(paths: SvgPathPaint[], target: string): SvgPaint {
  const selected = target === '*' ? paths : paths.filter(path => path.id === target);
  if (!selected.length) return {};
  const paint: SvgPaint = {};
  for (const key of ['fill', 'stroke', 'strokeWidth'] as const) {
    const value = selected[0][key];
    if (value !== undefined && selected.every(path => path[key] === value)) Object.assign(paint, { [key]: value });
  }
  return paint;
}

/** Read the browser's actual SVG cascade, including inherited group and CSS
 * paint. The normalized temporary SVG is isolated from application CSS and
 * removed synchronously; this never changes the source or the visible canvas. */
export function readSvgPaints(markup: string, options: SvgNormalizeOptions = {}): SvgPathPaint[] {
  const styles = Object.fromEntries(Object.entries(options.styles || {}).map(([id, paint]) => {
    const css = { ...paint }; if (css.strokeWidth !== undefined) { css['stroke-width'] = css.strokeWidth; delete css.strokeWidth; }
    return [id, css];
  }));
  const normalized = normalizeSvg(markup, { ...options, styles, scope: `i2-paint-${crypto.randomUUID()}` });
  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = `all:initial;position:fixed;left:0;top:0;width:${normalized.width}px;height:${normalized.height}px;visibility:hidden;pointer-events:none;contain:strict;color:#000000`;
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = normalized.svg;
  try {
    document.body.append(host);
    const elements = new Map([...shadow.querySelectorAll<SVGElement>('[data-i2-canonical-id]')].map(element => [element.getAttribute('data-i2-canonical-id'), element]));
    return normalized.drawingNodes.filter(node => !['image', 'use'].includes(node.tag)).map(node => {
      const element = elements.get(node.id); if (!element) throw new Error('SVG 路径身份无法读取');
      const style = getComputedStyle(element), width = /^\d+(?:\.\d+)?(?:px)?$/.test(style.strokeWidth) ? Number.parseFloat(style.strokeWidth) : undefined;
      return { id: node.id, fill: svgPaintValue(style.fill), stroke: svgPaintValue(style.stroke), ...(width === undefined ? {} : { strokeWidth: width }) };
    });
  } finally { host.remove(); }
}
