import type { ImageDocument, ImageLayer } from './types';
export interface Point { x: number; y: number }
export function localToDocument(point: Point, layer: ImageLayer, layers: ImageLayer[]): Point {
  const angle = layer.rotation * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
  const parentPoint = { x: layer.x + point.x * c - point.y * s, y: layer.y + point.x * s + point.y * c };
  const parent = layers.find(item => item.id === layer.parentId);
  return parent ? localToDocument(parentPoint, parent, layers) : parentPoint;
}
export function documentToLocal(point: Point, layer: ImageLayer, layers: ImageLayer[]): Point {
  const parent = layers.find(item => item.id === layer.parentId);
  const parentPoint = parent ? documentToLocal(point, parent, layers) : point;
  const angle = -layer.rotation * Math.PI / 180, dx = parentPoint.x - layer.x, dy = parentPoint.y - layer.y;
  return { x: dx * Math.cos(angle) - dy * Math.sin(angle), y: dx * Math.sin(angle) + dy * Math.cos(angle) };
}
export function layerPixelPoint(point: Point, layer: ImageLayer, layers: ImageLayer[], asset: { width: number; height: number }): Point {
  const local = documentToLocal(point, layer, layers);
  return { x: local.x * asset.width / layer.width, y: local.y * asset.height / layer.height };
}
export function orderedLayers(document: ImageDocument) { return [...document.layers].sort((a, b) => a.z - b.z); }
export function capability(value: unknown, operation: string): { available: boolean; reason?: string } {
  if (!value || typeof value !== 'object') return { available: false, reason: '服务能力尚未就绪' };
  const source = value as Record<string, unknown>;
  const operations = source.operations || source.capabilities || source;
  const raw = Array.isArray(operations) ? operations.find(item => typeof item === 'object' && (item.operation === operation || item.name === operation)) : (operations as Record<string, unknown>)[operation];
  if (raw === true) return { available: true };
  if (raw && typeof raw === 'object') { const item = raw as Record<string, unknown>; return { available: item.available === true || item.enabled === true, reason: String(item.reason || item.error || '') || undefined }; }
  return { available: false, reason: '此功能尚未配置' };
}
