import type { CanvasKit } from 'canvaskit-wasm';
import type { Rect, RenderGraph } from './render-graph.mjs';
export type SoftwareOptions = { bounds?: Rect; pixelScale?: number; maxPixels?: number; maxWasmBytes?: number; background?: string; cancelled?: () => boolean };
export type SoftwareFrame = { pixels: Uint8Array; width: number; height: number; origin: { x: number; y: number }; engineVersion: 'canvaskit-0.42.0'; renderVersion: 'weiai-rg-1'; scratchPixels: number };
export function renderSoftware(engine: CanvasKit, graph: RenderGraph, options?: SoftwareOptions): Promise<SoftwareFrame>;
