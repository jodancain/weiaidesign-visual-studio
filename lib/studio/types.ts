/** Studio v3 wire contract. Time intervals are integer frames, end-exclusive. */
export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];
export type Transform = { position: Vec3; rotation: Quat; scale: Vec3 };
export type AssetKind = 'image' | 'video' | 'audio' | 'model' | 'bake';
/** Read-only gateway projection from persisted job/copy/import receipts, never upload metadata. */
export type EffectsSource = { kind: 'ai-original' | 'code-animation' | 'derived'; sourceHash: string; rootKind: 'ai-original' | 'code-animation' };
export type AssetRevision = {
  id: string; name: string; kind: AssetKind; mime: string; hash: string; url: string;
  bytes: number; createdAt: string; parentId?: string; source?: string;
  metadata?: Record<string, unknown>;
  effectsSource?: EffectsSource;
};
export type Keyframe = { frame: number; value: number | number[]; interpolation: 'linear' | 'hold' | 'smooth'; ease?: [number, number, number, number] };
export type AnimationTrack = {
  id: string; targetId: string; bone?: string; partId?: string;
  property: 'position' | 'rotation' | 'scale' | 'ikTarget' | 'weight' | 'visible' | 'focalLength' | 'morph';
  keys: Keyframe[]; muted?: boolean; locked?: boolean;
};
export type MotionClip = {
  id: string; targetId: string; clipName: string; startFrame: number; endFrame: number;
  sourceIn: number; speed: number; weight: number; fadeIn: number; fadeOut: number;
  mask: 'all' | 'upper' | 'lower'; additive?: boolean;
};
export type RigProfile = {
  id: string; bones: Record<string, string>;
  limits?: Record<string, { min: Vec3; max: Vec3 }>;
  chains: Array<{ id: string; target: Vec3; effector: string; links: string[]; enabled: boolean }>;
};
export type ScenePart = { id: string; transform: Transform; color?: string; visible: boolean; locked: boolean };
export type SceneObject = {
  id: string; name: string; kind: 'box' | 'sphere' | 'cylinder' | 'plane' | 'character' | 'model';
  transform: Transform; color: string; visible: boolean; locked: boolean;
  assetId?: string; parentId?: string; rig?: RigProfile; parts?: ScenePart[];
  bonePoses?: Record<string, Quat>; morphs?: Record<string, number>;
};
export type StudioCamera = { id: string; name: string; position: Vec3; target: Vec3; focalLength: number; sensorWidth: number };
export type StudioLight = { id: string; name: string; type: 'ambient' | 'directional' | 'point'; position: Vec3; intensity: number; color: string };
export type StudioScene = {
  id: string; name: string; revision: number; units: 'meters'; up: 'Y';
  objects: SceneObject[]; cameras: StudioCamera[]; activeCameraId: string;
  background: string; groundColor: string; showGround: boolean; exposure: number;
  lights?: StudioLight[];
  tracks: AnimationTrack[]; clips: MotionClip[];
  codeProgram?: import('./code-scene/schema').SceneProgram;
  codeProgramHash?: string; codeGenerationJobId?: string;
};
export type CanvasNode = { id: string; type: 'text' | 'image' | 'video' | 'audio' | 'subject' | 'shot' | 'director' | 'sequence'; x: number; y: number; label: string; text?: string; assetId?: string; modelAssetId?: string; objectId?: string; shotId?: string; sceneId?: string; groupId?: string; width?: number };
export type CanvasEdge = { id: string; source: string; target: string };
export type Shot = {
  id: string; name: string; sceneId: string; cameraId: string; startFrame: number; endFrame: number;
  generationMode?: 'image-to-video' | 'text-to-video';
  prompt: string; firstAssetId?: string; lastAssetId?: string; subjectIds: string[];
  dialogue?: string; overlay?: string; approval?: { hash: string; at: string };
  takes: Array<{ id: string; assetId: string; jobId: string; model: string; referenceMode: string }>;
  selectedTakeId?: string;
};
export type SequenceClip = {
  id: string; kind: 'video' | 'audio' | 'text'; track: number; startFrame: number; endFrame: number;
  assetId?: string; sourceIn: number; text?: string; volume: number; fadeIn: number; fadeOut: number;
  x?: number; y?: number; fontSize?: number; color?: string;
};
export type Sequence = { id: string; name: string; fps: 24; totalFrames: number; clips: SequenceClip[] };
export type StudioProject = {
  schemaVersion: 3; id: string; name: string; revision: number; createdAt: string; updatedAt: string;
  fps: 24; aspect: '16:9' | '9:16'; totalFrames: number;
  viewport?: { x: number; y: number; zoom: number };
  nodes: CanvasNode[]; edges: CanvasEdge[]; assets: AssetRevision[];
  scenes: StudioScene[]; shots: Shot[]; sequence: Sequence;
  access?: { readOnly: boolean; canCopy?: boolean };
};
export type SceneOp =
  | { type: 'object.add'; sceneId: string; object: SceneObject }
  | { type: 'object.remove'; sceneId: string; objectId: string }
  | { type: 'object.update'; sceneId: string; objectId: string; patch: Partial<SceneObject> }
  | { type: 'part.update'; sceneId: string; objectId: string; partId: string; patch: Partial<Omit<ScenePart, 'id'>> }
  | { type: 'camera.update'; sceneId: string; cameraId: string; patch: Partial<StudioCamera> }
  | { type: 'scene.update'; sceneId: string; patch: Partial<StudioScene> }
  | { type: 'track.set'; sceneId: string; track: AnimationTrack }
  | { type: 'track.remove'; sceneId: string; trackId: string }
  | { type: 'clip.set'; sceneId: string; clip: MotionClip }
  | { type: 'clip.remove'; sceneId: string; clipId: string };
export type StudioJob = {
  id: string; projectId: string; kind: 'generation' | 'export' | 'preview' | 'scene-generation' | 'render' | 'enhancement' | 'effects-plan' | 'effects-render' | 'trusted-media-import';
  state: 'queued' | 'running' | 'complete' | 'failed' | 'uncertain' | 'cancelled'; progress: number;
  createdAt: string; updatedAt: string; error?: string; outputAssetId?: string;
  stage?: string; stages?: StudioJobStage[]; outputRevision?: number; projectRevision?: number;
  retryable?: boolean; cancellable?: boolean; retryStage?: string; backend?: StudioRenderBackend; waitingReason?: string;
  sourceRevision?: number; outputAssetIds?: string[]; partialAssets?: Array<AssetRevision & { role?: string; backend?: StudioRenderBackend }>; renderGroupId?: string;
  sourceAssetId?: string; sourceHash?: string; planJobId?: string; planHash?: string; renderJobId?: string;
  cancellationTooLate?: boolean;
  output?: Record<string, unknown>;
};
export type StudioRenderBackend = 'three-webgl' | 'remotion';
export type StudioJobStage = { id: string; label?: string; state: StudioJob['state']; progress?: number; error?: string; outputAssetId?: string };
export type StudioServiceCapability = { available: boolean; reason?: string; model?: string };
export type StudioCapabilities = {
  video: boolean; blender: boolean; ffmpeg: boolean; llm: boolean; model: string; referenceMode: string;
  generationModes?: Array<'image-to-video' | 'text-to-video'>;
  sceneGeneration?: StudioServiceCapability; dlss?: StudioServiceCapability; effects?: StudioServiceCapability;
  renderers?: Partial<Record<StudioRenderBackend, StudioServiceCapability>>;
};
