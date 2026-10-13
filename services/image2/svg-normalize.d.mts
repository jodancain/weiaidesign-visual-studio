export interface SvgDrawingNode { id: string; tag: string; originalId?: string; legacyIds: string[]; }
export interface SvgNormalizeOptions {
  scope?: string; width?: number; height?: number; fallbackWidth?: number; fallbackHeight?: number;
  styles?: Record<string, Record<string, unknown>>; fill?: string; preserveAspectRatio?: string; responsive?: boolean;
}
export interface SvgNormalizeResult {
  svg: string; width: number; height: number; viewBox: [number, number, number, number];
  drawingNodes: SvgDrawingNode[]; legacyAliases: Record<string, string | null>; warnings: string[];
}
export function normalizeSvg(markup: string, options?: SvgNormalizeOptions): SvgNormalizeResult;
export function inspectDrawingNodes(markup: string, options?: SvgNormalizeOptions): SvgDrawingNode[];
