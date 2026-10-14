import type { ImageDocument, ImageJob } from './types';

export interface CandidatePreviewState {
  status: 'ready' | 'stale' | 'unavailable' | 'empty' | 'accepted';
  assets: string[]; canAccept: boolean; message?: string;
}
const revision = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
/** A consumed native-only branch can leave the main image revision unchanged. Trust its server receipt. */
export function acceptedCandidateRevision(branch?: ImageDocument): number | undefined {
  const metadata = branch?.metadata;
  return branch?.parentDocumentId && metadata?.acceptedIntoDocumentId === branch.parentDocumentId && typeof metadata.acceptedAt === 'string' && metadata.acceptedAt
    ? revision(metadata.acceptedRevision) : undefined;
}
/** Visibility is positive evidence of no drawable layers, not a guess from a missing PNG. */
function hasVisibleDrawing(branch: ImageDocument): boolean | undefined {
  for (const layer of branch.layers) {
    if (layer.type === 'group' || layer.type === 'mask') continue;
    let cursor: typeof layer | undefined = layer, visible = true;
    const visited = new Set<string>();
    while (cursor) {
      if (visited.has(cursor.id) || typeof cursor.visible !== 'boolean' || !Number.isFinite(cursor.opacity)) return undefined;
      visited.add(cursor.id); visible &&= cursor.visible && cursor.opacity > 0;
      if (!cursor.parentId) break;
      const parent = branch.layers.find(item => item.id === cursor!.parentId);
      if (!parent || parent.type !== 'group') return undefined;
      cursor = parent;
    }
    if (visible) return true;
  }
  return false;
}

/** Both acceptance surfaces use the same frozen-preview/version evidence. */
export function candidatePreviewState(job?: ImageJob, branch?: ImageDocument): CandidatePreviewState {
  const output = job?.output || {}, preview = typeof output.previewAssetId === 'string' && output.previewAssetId ? output.previewAssetId : undefined;
  const previewRevision = revision(output.previewRevision), outputRevision = revision(output.revision), branchRevision = revision(branch?.revision);
  const branchId = output.branchDocumentId || output.candidateDocumentId;
  const acceptedRevision = acceptedCandidateRevision(branch);
  if (acceptedRevision !== undefined && (!job || job.documentId === branch?.parentDocumentId) && branchId === branch?.id) return { status: 'accepted', assets: preview ? [preview] : [], canAccept: false, message: `已接受到主工程（图片版本 ${acceptedRevision}）${Array.isArray(output.craftProjects) && output.craftProjects.length ? '，原生工程已一并保存' : ''}。` };
  const running = job?.state === 'queued' || job?.state === 'running';
  const canAccept = Boolean(branch) && !running;
  const differentBranch = branch && typeof branchId === 'string' && branchId !== branch.id;
  const differentOutput = previewRevision !== undefined && outputRevision !== undefined && previewRevision !== outputRevision;
  const differentLiveRevision = branchRevision !== undefined && (previewRevision !== undefined && previewRevision !== branchRevision || outputRevision !== undefined && outputRevision !== branchRevision);
  if (output.previewStale === true || differentBranch || differentOutput || differentLiveRevision) {
    return { status: 'stale', assets: [], canAccept: false, message: '候选预览与当前候选版本不一致。旧图已隐藏，请刷新状态并核对当前版本后再接受。' };
  }
  if (output.previewUnavailable) return { status: 'unavailable', assets: [], canAccept: false, message: '当前能力无法生成候选画面预览。候选图层与任务已保留，预览核对完成前不能接受。' };
  if (preview) {
    if (!branch || previewRevision === undefined || outputRevision === undefined) return { status: 'unavailable', assets: [], canAccept: false, message: '候选预览缺少当前版本依据。请刷新状态，取得匹配的版本与预览后再接受。' };
    return { status: 'ready', assets: [preview], canAccept };
  }
  if (branch && hasVisibleDrawing(branch) === false) return { status: 'empty', assets: [], canAccept: branch.schemaVersion === 3 ? false : canAccept, message: `已读取候选版本 ${branch.revision}，当前没有可见绘制图层。${branch.schemaVersion === 3 ? '仍需此版本的透明 PNG 预览，核对完成前不能接受。' : ''}` };
  // v3 drawing content is JSON or raw source data; neither is a composited candidate preview.
  if (branch?.schemaVersion === 3 || output.previewRevision !== undefined) return { status: 'unavailable', assets: [], canAccept: false, message: '候选画面预览尚未就绪。图层与任务已保留，请刷新状态后核对。' };
  const values = Array.isArray(output.assetIds) ? output.assetIds : typeof output.assetId === 'string' ? [output.assetId] : branch?.layers.filter(layer => layer.visible && layer.assetId && layer.type !== 'mask').map(layer => layer.assetId).slice(-4) || [];
  const assets = [...new Set(values.filter((id): id is string => typeof id === 'string' && id.length > 0))];
  return assets.length ? { status: 'ready', assets, canAccept } : { status: 'unavailable', assets: [], canAccept: false, message: '候选预览尚未就绪，请刷新状态后核对。' };
}

export function candidatePreviewAssets(job: ImageJob, branch?: ImageDocument): string[] { return candidatePreviewState(job, branch).assets; }
