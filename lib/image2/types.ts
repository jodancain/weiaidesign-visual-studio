/** Manually aligned with services/image2/CONTRACT.md. Geometry is in source document pixels. */
export type LayerType = 'raster' | 'text' | 'vector' | 'group' | 'mask' | 'adjustment';
export type Matrix2D = [number, number, number, number, number, number];
export interface ContentDescriptor { id: string; kind: 'raster' | 'svg' | 'vector' | 'text' | 'preservedText' | 'tiles'; assetId: string; formatVersion: 1 }
export interface LayerMask { id: string; kind: 'raster' | 'vector'; contentId: string; channel: 'alpha' | 'luminance'; coordinateSpace: 'layerLocal' | 'document'; matrix: Matrix2D; linked: boolean; enabled: boolean; inverted: boolean; density: number; featherPx: number }
export interface LayerEffect { id: string; type: string; enabled: boolean; params: Record<string, unknown> }
export interface ImageLayer {
  id: string; type: LayerType; name: string; x: number; y: number; width: number; height: number;
  rotation: number; opacity: number; visible: boolean; locked: boolean; z: number; parentId?: string | null;
  assetId?: string; maskAssetId?: string | null; sourceAssetId?: string;
  sourceRect?: { x: number; y: number; width: number; height: number } | number[];
  text?: string; fontAssetId?: string; fontFamily?: string; fontSize?: number; fontWeight?: number | string;
  fill?: string; stroke?: string; strokeWidth?: number; tracking?: number; lineHeight?: number;
  editability?: 'pixels' | 'text' | 'path'; metadata?: Record<string, unknown>;
  contentId?: string; localBounds?: {x:number;y:number;width:number;height:number}; matrix?: Matrix2D;
  blendMode?: string; compositeMode?: 'isolated' | 'passthrough'; clipToLayerId?: string;
  masks?: LayerMask[]; effects?: LayerEffect[];
}
export interface ImageDocument {
  id: string; name: string; schemaVersion: 2 | 3; revision: number; width: number; height: number;
  layers: ImageLayer[]; assetIds: string[]; createdAt: string | number; updatedAt: string | number;
  parentDocumentId?: string; baseRevision?: number; metadata?: Record<string, unknown>;
  contentAssets?: ContentDescriptor[]; renderVersion?: string; requiredFeatures?: string[];
  resolution?: {dpiX:number;dpiY:number;unit:'px'|'mm'|'in'};
  workingColor?: {space:'srgb';bitDepth:8;alphaEncoding:'straight'};
  artboards?: Array<{id:string;name:string;bounds:{x:number;y:number;width:number;height:number};background?:string;visible:boolean}>;
  guides?: Array<{id:string;axis:'x'|'y';position:number;locked:boolean;visible:boolean;artboardId?:string}>;
  savedSelections?: Array<{id:string;name:string;contentId:string;matrix:Matrix2D;channel:'alpha'|'luminance';inverted:boolean;density:number;featherPx:number}>;
}
export type DocumentCommand =
  | { type: 'layer.add'; layer: ImageLayer }
  | { type: 'layer.update'; layerId: string; patch: Partial<ImageLayer> }
  | { type: 'layer.remove'; layerId: string }
  | { type: 'layer.reorder'; layerIds: string[] }
  | { type: 'document.update'; patch: { name?: string; width?: number; height?: number; resolution?: ImageDocument['resolution']; metadata?: Record<string, unknown> } }
  | { type: 'content.add'; content: ContentDescriptor }
  | { type: 'layer.content'; layerId:string;contentId:string;localBounds?:ImageLayer['localBounds'] }
  | { type: 'layer.transformWorld'; layerIds:string[];deltaWorld:Matrix2D }
  | { type:'mask.upsert';layerId:string;mask:LayerMask }
  | { type:'mask.remove';layerId:string;maskId:string }
  | { type:'mask.reorder';layerId:string;maskIds:string[] }
  | { type:'guide.upsert';guide:NonNullable<ImageDocument['guides']>[number] }
  | { type:'guide.remove';guideId:string }
  | { type:'artboard.upsert';artboard:NonNullable<ImageDocument['artboards']>[number] }
  | { type:'artboard.remove';artboardId:string }
  | { type:'selection.upsert';selection:NonNullable<ImageDocument['savedSelections']>[number] }
  | { type:'selection.remove';selectionId:string };
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
