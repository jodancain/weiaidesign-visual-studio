import type { AssetRevision, StudioJob, StudioProject, StudioRenderBackend } from './types';

export type ExportChoice = 'three' | 'remotion' | 'both';
export const renderBackends = (choice: ExportChoice): StudioRenderBackend[] => choice === 'both' ? ['three-webgl', 'remotion'] : [choice === 'remotion' ? 'remotion' : 'three-webgl'];
export const jobLabels: Record<StudioJob['kind'], string> = { generation: '镜头生成', export: '时间线成片', preview: '3D 预演', 'scene-generation': '代码场景', render: '场景成片', enhancement: 'DLSS 5 增强', 'effects-plan': 'Opus 特效计划', 'effects-render': '特效合成', 'trusted-media-import': '历史成片导入' };
export const jobStateLabels: Record<StudioJob['state'], string> = { queued: '排队中', running: '处理中', complete: '完成', failed: '失败', uncertain: '状态待核对', cancelled: '已取消' };
const stageLabels: Record<string, string> = {
  ...jobStateLabels, planning_effects: '规划特效', source_frames_ready: '源画面已准备', validating: '校验计划',
  repairing_effects: '修正特效计划', repair_pending: '等待计划校正', validation_failed: '计划校验未通过',
  'effects-frames': '绘制特效帧', 'effects-compositing': '合成特效视频', 'effects-comparison': '制作前后对比',
  waiting_for_worker: '等待服务', waiting_for_gpu: '等待渲染资源', waiting: '等待服务',
  waiting_for_effects_render: '等待特效合成服务', effects_handoff_failed: '特效合成衔接失败',
  recovering_completed_output: '恢复已完成结果',
  acceptance_unknown: '提交状态待核对', retry_pending: '等待恢复阶段', submitting: '提交任务',
  loading: '读取素材', encoding: '编码视频', compositing: '合成视频', cancelling: '正在取消',
};
export const jobStageLabel = (stage: string) => stageLabels[stage] || stage;

/** A failed later stage can still have usable outputs. Consume this stamp only after merge succeeds. */
export function jobOutputStamp(job: StudioJob): string | undefined {
  const out = job.output;
  if (!job.outputAssetId && !job.outputRevision && !job.projectRevision && !job.outputAssetIds?.length && !job.partialAssets?.length && !out && !['complete', 'failed', 'cancelled'].includes(job.state)) return;
  return JSON.stringify([job.state, job.outputRevision, job.projectRevision, job.outputAssetId, job.outputAssetIds, job.partialAssets, job.stages?.map(s => [s.id, s.state, s.outputAssetId]), out]);
}

export function jobAssetIds(job: StudioJob): string[] {
  const out = job.output || {}, ids = new Set<string>();
  if (job.outputAssetId) ids.add(job.outputAssetId);
  for (const id of job.outputAssetIds || []) ids.add(id);
  for (const asset of job.partialAssets || []) ids.add(asset.id);
  for (const key of ['originalAssetId', 'sourceAssetId', 'enhancedAssetId', 'effectsAssetId', 'comparisonAssetId', 'compareAssetId']) if (typeof out[key] === 'string') ids.add(out[key]);
  for (const id of Array.isArray(out.assetIds) ? out.assetIds : []) if (typeof id === 'string') ids.add(id);
  for (const stage of job.stages || []) if (stage.outputAssetId) ids.add(stage.outputAssetId);
  for (const result of Array.isArray(out.outputs) ? out.outputs : []) if (result && typeof result.assetId === 'string') ids.add(result.assetId);
  return [...ids];
}

export function sourceAssetId(asset: AssetRevision): string | undefined {
  return asset.parentId || (typeof asset.metadata?.sourceAssetId === 'string' ? asset.metadata.sourceAssetId : undefined);
}
export function isComparison(asset: AssetRevision): boolean {
  return asset.metadata?.role === 'comparison' || asset.metadata?.variant === 'comparison' || asset.metadata?.comparison === true || asset.metadata?.provenance === 'video-comparison';
}
export function originalVideo(project: Pick<StudioProject, 'assets'>, asset: AssetRevision): AssetRevision {
  const seen = new Set<string>();
  while (sourceAssetId(asset) && !seen.has(asset.id)) { seen.add(asset.id); const parent = project.assets.find(a => a.id === sourceAssetId(asset)); if (!parent) break; asset = parent; }
  return asset;
}
export function videoFamily(project: StudioProject, selected: AssetRevision): AssetRevision[] {
  const rootOf = (asset: AssetRevision) => originalVideo(project, asset).id;
  const root = rootOf(selected);
  const rootAsset = project.assets.find(asset => asset.id === root), group = rootAsset?.metadata?.renderGroupId;
  return project.assets.filter(asset => asset.kind === 'video' && asset.metadata?.role !== 'clean' && (rootOf(asset) === root || (typeof group === 'string' && project.assets.find(a => a.id === rootOf(asset))?.metadata?.renderGroupId === group)));
}

/** Only the gateway's hash-bound projection enables this UI. Upload metadata is not evidence. */
export function isEffectsSource(project: Pick<StudioProject, 'assets'>, asset: AssetRevision): boolean {
  if (asset.kind !== 'video' || isComparison(asset) || asset.metadata?.role === 'clean') return false;
  const current = project.assets.find(item => item.id === asset.id), verified = current?.effectsSource;
  return current?.hash === asset.hash && !!verified && verified.sourceHash === asset.hash
    && ['ai-original', 'code-animation', 'derived'].includes(verified.kind)
    && ['ai-original', 'code-animation'].includes(verified.rootKind)
    && (verified.kind === 'derived' || verified.kind === verified.rootKind);
}

export const effectsSourceGroups = [
  { kind: 'ai-original', label: 'AI 原版' },
  { kind: 'code-animation', label: '代码动画' },
  { kind: 'derived', label: '派生版本' },
] as const;

export function effectsSources(project: Pick<StudioProject, 'assets'>): AssetRevision[] {
  return effectsSourceGroups.flatMap(group => project.assets
    .filter(asset => isEffectsSource(project, asset) && asset.effectsSource?.kind === group.kind)
    .sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0)));
}

/** A verified audio remix is a playable original, even when its provenance has an older parent. */
export function videoBaseline(project: Pick<StudioProject, 'assets'>, selected: AssetRevision): AssetRevision {
  let current = selected;
  const seen = new Set<string>();
  while (!seen.has(current.id)) {
    seen.add(current.id);
    if (isEffectsSource(project, current) && current.effectsSource?.kind !== 'derived') return current;
    const parent = project.assets.find(asset => asset.id === sourceAssetId(current));
    if (!parent) break;
    current = parent;
  }
  return originalVideo(project, selected);
}

export function effectsCreatedLabel(asset: AssetRevision): string {
  const time = Date.parse(asset.createdAt);
  return Number.isFinite(time) ? ` · ${new Date(time).toISOString().slice(0, 19).replace('T', ' ')} UTC` : '';
}

/** Describe the exact selected version; ancestry is only used to label its exporter. */
export function effectsSourceLabel(project: Pick<StudioProject, 'assets'>, asset: AssetRevision): string {
  const root = originalVideo(project, asset);
  const verified = project.assets.find(item => item.id === asset.id)?.effectsSource;
  const ai = verified?.rootKind === 'ai-original';
  const exporter = root.source === 'three-webgl' ? 'Three' : root.source === 'remotion' ? 'Remotion' : undefined;
  const origin = ai ? '（AI 原版）' : exporter ? `（${exporter}）` : '';
  const version = asset.metadata?.role === 'effects' || asset.source === 'effects-compositor' ? `Opus 特效版${origin}`
    : asset.metadata?.role === 'enhanced' || asset.source === 'dlss-nr' ? `DLSS 5 版${origin}`
    : verified?.kind === 'ai-original' ? 'AI 原版' : verified?.kind === 'derived' ? `派生版本${origin}` : exporter ? `${exporter} 原版` : '代码动画原版';
  const created = asset.metadata?.role === 'effects' || asset.source === 'effects-compositor' ? effectsCreatedLabel(asset) : '';
  return `${version} · ${asset.name}${created}`;
}

export function effectsPlanInput(project: StudioProject, plan: StudioJob) {
  if (plan.projectId !== project.id || plan.kind !== 'effects-plan' || plan.state !== 'complete') throw new Error('特效计划尚未完成或不属于当前工程');
  const hash = plan.output?.effectsProgramHash;
  if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash) || !plan.output?.effectsProgram) throw new Error('特效计划缺少有效版本，请核对任务记录');
  const source = project.assets.find(asset => asset.id === plan.sourceAssetId);
  if (!source || source.hash !== plan.sourceHash || !isEffectsSource(project, source)) throw new Error('特效计划绑定的源视频已变更或不可用，请重新选择');
  return { planJobId: plan.id, planHash: hash, sourceAssetId: source.id, sourceHash: source.hash };
}

/** Any existing render, including uncertain/failed/cancelled, owns this plan. */
export function effectsRenderForPlan(jobs: StudioJob[], plan: StudioJob): StudioJob | undefined {
  return jobs.find(job => job.projectId === plan.projectId && job.kind === 'effects-render' && job.planJobId === plan.id);
}

export const effectsCancellationKey = (job: StudioJob) => `studio-v3-effects-cancel:${job.projectId}:${job.id}`;
export const canResumeEffectsHandoff = (job: StudioJob) => job.kind === 'effects-plan' && job.state === 'cancelled' && job.retryable === true && !!job.output?.effectsProgram;

/** Validate before releasing the persisted submission key, even after HTTP 200. */
export function effectsJobReceipt(value: StudioJob, kind: 'effects-plan' | 'effects-render', projectId: string, sourceAssetId: string, sourceHash: string, planJobId?: string, planHash?: string): StudioJob {
  if (!value || typeof value.id !== 'string' || !value.id || value.kind !== kind || value.projectId !== projectId || value.sourceAssetId !== sourceAssetId || value.sourceHash !== sourceHash || (kind === 'effects-render' && (value.planJobId !== planJobId || value.planHash !== planHash))) throw new Error('未收到匹配的特效任务回执；已保留请求编号，请查看任务记录或重试恢复');
  return value;
}

/** Replace only explicit references to the chosen original. Preserve cuts, audio, timing and every other asset. */
export function applyVideoVersion(project: StudioProject, originalId: string, versionId: string): StudioProject {
  const original = project.assets.find(a => a.id === originalId), version = project.assets.find(a => a.id === versionId);
  if (!original || original.kind !== 'video' || !version || version.kind !== 'video' || isComparison(version)) throw new Error('请选择此项目中的单画面视频版本');
  if (!videoFamily(project, original).some(a => a.id === version.id)) throw new Error('这两个视频不属于同一个来源版本');
  const next = structuredClone(project), frames = Number(version.metadata?.frames || Math.floor(Number(version.metadata?.duration || 0) * 24));
  for (const clip of next.sequence.clips) if (clip.assetId === originalId) {
    if (frames > 0 && clip.sourceIn + clip.endFrame - clip.startFrame > frames) throw new Error('此版本长度不足以保留现有剪辑，请先调整片段');
    clip.assetId = versionId;
  }
  for (const node of next.nodes) if (node.assetId === originalId) node.assetId = versionId;
  return next;
}
