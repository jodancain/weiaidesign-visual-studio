/** Manually aligned with services/image2/CONTRACT.md. Geometry is in source document pixels. */
export type LayerType = 'raster' | 'text' | 'vector' | 'group' | 'mask';
export interface ImageLayer {
  id: string; type: LayerType; name: string; x: number; y: number; width: number; height: number;
  rotation: number; opacity: number; visible: boolean; locked: boolean; z: number; parentId?: string | null;
  assetId?: string; maskAssetId?: string | null; sourceAssetId?: string;
  sourceRect?: { x: number; y: number; width: number; height: number } | number[];
  text?: string; fontAssetId?: string; fontFamily?: string; fontSize?: number; fontWeight?: number | string;
  fill?: string; stroke?: string; strokeWidth?: number; tracking?: number; lineHeight?: number;
  editability?: 'pixels' | 'text' | 'path'; metadata?: Record<string, unknown>;
}
export interface ImageDocument {
  id: string; name: string; schemaVersion: 2; revision: number; width: number; height: number;
  layers: ImageLayer[]; assetIds: string[]; createdAt: string | number; updatedAt: string | number;
  parentDocumentId?: string; baseRevision?: number; metadata?: Record<string, unknown>;
}
export type DocumentCommand =
  | { type: 'layer.add'; layer: ImageLayer }
  | { type: 'layer.update'; layerId: string; patch: Partial<ImageLayer> }
  | { type: 'layer.remove'; layerId: string }
  | { type: 'layer.reorder'; layerIds: string[] }
  | { type: 'document.update'; patch: { name?: string; width?: number; height?: number } };
export interface ImageAsset {
  id: string; documentId: string; name: string; mime: string; hash: string; bytes: number;
  width?: number; height?: number; createdAt: string | number; metadata?: Record<string, unknown>;
}
export interface ImageJob {
  id: string; documentId: string; kind: string;
  operation?: string;
  state: 'queued' | 'running' | 'complete' | 'failed' | 'uncertain' | 'cancelled' | 'awaiting_user';
  progress?: number; stage?: string; createdAt: string | number; updatedAt: string | number;
  output?: Record<string, unknown>; error?: string; retryable?: boolean;
  metrics?: { queueMs: number; executionMs: number; totalMs: number; generationCalls: number; llmCalls: number; visionCalls: number };
}
export interface Conversation { id: string; documentId: string; [key: string]: unknown }
export interface ConversationMessage {
  id: string; role: string; text?: string; content?: string; createdAt?: string | number;
  references?: Array<{ assetId?: string; layerId?: string; revision?: number }>;
}
export interface Capability { available: boolean; reason?: string; label?: string; executionClass?: string }
export type Capabilities = Record<string, Capability | unknown>;
export interface OperationRequest {
  documentId: string; baseRevision: number; operation: string; params?: Record<string, unknown>;
  inputs?: Array<{ role: string; assetId: string }>; targetLayerId?: string;
  idempotencyKey: string; mode?: 'apply' | 'candidate';
}
