import { image2Api } from './client';
import { blobBase64 } from '../studio/client';
import type { ImageAsset, ImageDocument, ImageLayer } from './types';
import { craftSubmissions } from './craft-submissions';

export interface CraftSchema {
  type?: string | string[]; title?: string; description?: string; default?: unknown; const?: unknown;
  enum?: unknown[]; properties?: Record<string, CraftSchema>; required?: string[]; items?: CraftSchema | CraftSchema[]; prefixItems?: CraftSchema[]; additionalItems?: boolean | CraftSchema;
  additionalProperties?: boolean | CraftSchema; oneOf?: CraftSchema[]; anyOf?: CraftSchema[]; $ref?: string;
  $defs?: Record<string, CraftSchema>; definitions?: Record<string, CraftSchema>;
  minimum?: number; maximum?: number; minItems?: number; maxItems?: number; minLength?: number; maxLength?: number;
  format?: string; readOnly?: boolean; 'x-craft-role'?: string;
}
export interface CraftCommand { id?: string; name: string; title?: string; description?: string; inputSchema?: CraftSchema; params?: unknown; schemaUnavailable?: boolean }
export interface CraftEngine { id: string; name: string; available: boolean; reason?: string; message?: string; commands: CraftCommand[]; tools?: CraftCommand[]; version?: string; sourceRevision?: string }
export interface CraftProject { id: string; documentId: string; engineId: string; name: string; revision: number; nativeAssetId?: string; lastJobId?: string; assetIds?: string[]; updatedAt?: string | number; latestOutput?: CraftJob['output']; importJobId?: string; pendingImportAssetId?: string }
export interface CraftProjectRequest { engineId: string; name: string; idempotencyKey: string; initialAssetId?: string }
export interface CraftOutputAsset extends Partial<ImageAsset> { id: string; role?: string; filename?: string }
export interface CraftJob {
  id: string; documentId: string; projectId: string; engineId?: string; state: string; progress?: number; stage?: string;
  error?: string; createdAt?: string | number; idempotencyKey?: string; accepted?: boolean; acceptedRevision?: number; baseRevision?: number;
  output?: { assets?: CraftOutputAsset[]; previewAssetId?: string; nativeAssetId?: string; candidateRevision?: number; accepted?: boolean; result?: unknown; state?: unknown; warnings?: string[] };
}
export interface CraftJobRequest { projectId: string; baseRevision: number; steps: Array<{ command: string; args: Record<string, unknown> }>; inputAssetIds: string[]; idempotencyKey: string }
export const craftPath = (documentId: string, suffix: string) => `/documents/${encodeURIComponent(documentId)}/craft/${suffix}`;
export const craftApi = {
  capabilities: (documentId: string) => image2Api<{ engines: CraftEngine[] }>(craftPath(documentId, 'capabilities')),
  projects: (documentId: string) => image2Api<CraftProject[]>(craftPath(documentId, 'projects')),
  revisions: (documentId: string, projectId: string) => image2Api<CraftProject[]>(craftPath(documentId, `projects/${encodeURIComponent(projectId)}/revisions`)),
  restore: (documentId: string, projectId: string, body: { revision: number; baseRevision: number; idempotencyKey: string }) => craftSubmissions.submit<CraftJob>(craftPath(documentId, `projects/${encodeURIComponent(projectId)}/restore`), documentId, { projectId }, body),
  createProject: (documentId: string, body: CraftProjectRequest) => craftSubmissions.submit<CraftProject>(craftPath(documentId, 'projects'), documentId, { engineId: body.engineId }, body),
  jobs: (documentId: string) => image2Api<CraftJob[]>(craftPath(documentId, 'jobs')),
  submit: (documentId: string, request: CraftJobRequest) => craftSubmissions.submit<CraftJob>(craftPath(documentId, 'jobs'), documentId, { projectId: request.projectId }, request),
  cancel: (documentId: string, jobId: string) => image2Api<CraftJob>(craftPath(documentId, `jobs/${encodeURIComponent(jobId)}/cancel`), {}),
  discard: (documentId: string, jobId: string) => image2Api<CraftJob>(craftPath(documentId, `jobs/${encodeURIComponent(jobId)}/discard`), {}),
  retry: (documentId: string, jobId: string, idempotencyKey: string) => craftSubmissions.submit<CraftJob>(craftPath(documentId, `jobs/${encodeURIComponent(jobId)}/retry`), documentId, { jobId }, { idempotencyKey }),
  accept: (documentId: string, jobId: string, baseRevision: number, idempotencyKey: string) => craftSubmissions.submit<CraftProject>(craftPath(documentId, `jobs/${encodeURIComponent(jobId)}/accept`), documentId, { jobId }, { baseRevision, idempotencyKey }),
  upload: async (documentId: string, file: Blob, name: string) => {
    if (file.size > 64 * 1024 * 1024) throw new Error('单个原生文件不能超过 64 MB');
    return image2Api<ImageAsset>(craftPath(documentId, 'assets'), { name, mime: file.type || 'application/octet-stream', data: await blobBase64(file) });
  },
};

export const craftCommandId = (command: CraftCommand) => command.id || command.name;
export const craftEngineCommands = (engine?: CraftEngine) => [...new Map([...(engine?.tools || []), ...(engine?.commands || [])].map(command => [craftCommandId(command), command])).values()];
export function craftCommonCommands(engine?: CraftEngine) {
  const commands = craftEngineCommands(engine), groups = [
    ['新建内容', ['doc_new', 'file.new', 'file.newProject', 'doc_create', 'new_document', 'new_session', 'new_presentation', 'new_drawing', 'new_workbook']],
    ['打开素材', ['doc_open', 'open_file', 'file.open', 'open_project', 'open_document', 'open_session', 'open_presentation', 'open', 'open_workbook', 'import_files', 'import_file', 'import_images', 'import_audio']],
    ['预览内容', ['render_preview', 'render_page', 'render_slide', 'render']],
    ['查看对象', ['doc_inspect', 'inspect_document', 'inspect_session', 'inspect_drawing', 'inspect_workbook']],
    ['导出文件', ['export', 'export_file', 'export_document', 'export_svg', 'export_png', 'doc_export', 'export_audio', 'export_mixdown', 'export_pdf', 'file.export']],
  ] as const;
  return groups.flatMap(([label, names]) => { const command = commands.find(item => (names as readonly string[]).includes(craftCommandId(item))); return command ? [{ label, command }] : []; });
}
export const craftJobRunning = (job: CraftJob) => ['queued', 'running', 'cancelling'].includes(job.state);
export const craftJobLabels: Record<string, string> = { queued: '等待执行', running: '正在执行', complete: '待接受', failed: '执行失败', uncertain: '结果待核实', cancelled: '已取消', cancelling: '正在取消', accepted: '已接受' };
export function craftJobStatus(job: CraftJob, reviewOnly = false): string {
  const accepted = job.accepted || job.output?.accepted || job.state === 'accepted';
  if (reviewOnly && (accepted || job.state === 'complete')) return '待整组接受';
  return accepted ? '已接受' : craftJobLabels[job.state] || job.state;
}
export const craftEngineLabels: Record<string, string> = { photocraft: '图片编辑', vectorcraft: '矢量绘图', filmcraft: '视频剪辑', lightcraft: '照片调色', pdfcraft: 'PDF 编辑', effectcraft: '合成特效', designcraft: '版式设计', figcraft: '界面设计', wordcraft: '文字文档', soundcraft: '音频编辑', deckcraft: '演示文稿', cadcraft: 'CAD 绘图', gridcraft: '电子表格' };
const fieldNames: Record<string, string> = { width: '宽度', height: '高度', name: '名称', text: '文字', title: '标题', x: '横向位置', y: '纵向位置', color: '颜色', fill: '填色', stroke: '描边', opacity: '不透明度', radius: '半径', angle: '角度', rotation: '旋转角度', format: '文件格式', quality: '质量', scale: '倍率', page: '页码', pages: '页面', start: '开始', end: '结束', duration: '时长', sample_rate: '采样率', layer_id: '图层编号', object_id: '对象编号', font_size: '字号', font_family: '字体', path: '文件', input: '输入文件', output: '输出文件', file: '文件', filename: '文件名' };
export function craftFieldLabel(name: string, schema: CraftSchema) { return schema.title || fieldNames[name] || name.replace(/[_-]/g, ' '); }
export function resolveCraftSchema(schema: CraftSchema, root: CraftSchema): CraftSchema {
  let result = schema; const visited = new Set<string>();
  while (result.$ref?.startsWith('#/') && !visited.has(result.$ref) && visited.size < 16) {
    visited.add(result.$ref); let value: unknown = root;
    for (const token of result.$ref.slice(2).split('/')) value = value && typeof value === 'object' ? (value as Record<string, unknown>)[token.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined;
    if (!value || typeof value !== 'object') return result;
    const { $ref: _ref, ...siblings } = result; result = { ...(value as CraftSchema), ...siblings };
  }
  if (Array.isArray(result.type)) return { ...result, type: undefined, oneOf: result.type.map(type => ({ ...result, type, default: undefined, oneOf: undefined, anyOf: undefined })) };
  return result;
}
export function craftDefaultValue(input: CraftSchema, root: CraftSchema = input, depth = 0): unknown {
  const schema = resolveCraftSchema(input, root);
  if (schema.readOnly || schema['x-craft-role'] === 'input-asset' || schema['x-craft-role'] === 'output') return undefined;
  if (schema.default !== undefined) return structuredClone(schema.default);
  if (schema.const !== undefined) return structuredClone(schema.const);
  if (depth > 8) return undefined;
  const alternatives = schema.oneOf || schema.anyOf;
  if (alternatives) return craftDefaultValue(alternatives.find(item => item.type !== 'null') || alternatives[0], root, depth + 1);
  if (schema.type === 'object' || schema.properties) return Object.fromEntries(Object.entries(schema.properties || {}).flatMap(([key, field]) => {
    if (field.readOnly || field['x-craft-role'] === 'output') return [];
    const value = craftDefaultValue(field, root, depth + 1);
    return value !== undefined && (field.default !== undefined || field.const !== undefined || schema.required?.includes(key)) ? [[key, value]] : [];
  }));
  return undefined;
}
export function craftSchemaMatches(input: CraftSchema, value: unknown, root: CraftSchema): boolean {
  const schema = resolveCraftSchema(input, root);
  if (value === undefined) return true;
  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value)) return false;
  if (schema.enum && !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) return false;
  if (schema.type === 'null') return value === null;
  if (schema.type === 'object' || schema.properties) return !!value && typeof value === 'object' && !Array.isArray(value) && Object.entries(schema.properties || {}).every(([key, child]) => child.const === undefined || JSON.stringify((value as Record<string, unknown>)[key]) === JSON.stringify(child.const));
  if (schema.type === 'array') return Array.isArray(value);
  if (schema.type === 'integer') return Number.isInteger(value);
  return !schema.type || typeof value === schema.type;
}
export function craftArrayItemSchema(schema: CraftSchema, index: number): CraftSchema {
  if (schema.prefixItems?.[index]) return schema.prefixItems[index];
  if (Array.isArray(schema.items)) return schema.items[index] || (typeof schema.additionalItems === 'object' ? schema.additionalItems : {});
  return schema.items || {};
}
export function craftCommandParameterHint(command: CraftCommand) {
  if (typeof command.params === 'string') return command.params;
  return command.schemaUnavailable || !command.inputSchema ? '上游未提供结构化参数，请参照操作说明填写高级参数，或通过聊天让助手调用。' : '';
}
export function craftProjectRequest(engine: CraftEngine, name: string, idempotencyKey: string, initialAssetId?: string, assets: ImageAsset[] = []): CraftProjectRequest {
  if (initialAssetId && !assets.some(asset => asset.id === initialAssetId && /\.craftbundle$/i.test(asset.name))) throw new Error('请选择已上传的 .craftbundle 工程包');
  return { engineId: engine.id, name: name.trim() || `${craftEngineLabels[engine.id] || engine.name}工程`, idempotencyKey, ...(initialAssetId ? { initialAssetId } : {}) };
}

export function cleanCraftArguments(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('请输入有效数字');
  if (Array.isArray(value)) return value.map(item => { if (item === undefined) throw new Error('请填完列表中的参数'); return cleanCraftArguments(item); });
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, cleanCraftArguments(item)]));
  return value;
}
export function parseCraftArgumentText(text: string): Record<string, unknown> {
  if (text.length > 128 * 1024) throw new Error('高级参数不能超过 128 KiB');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('高级参数不是有效的 JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('高级参数必须是 JSON 对象');
  return value as Record<string, unknown>;
}

/** Freeze both the revision and idempotency key before crossing the network. */
export function craftJobRequest(project: CraftProject, command: CraftCommand, args: Record<string, unknown>, inputAssetIds: string[], idempotencyKey: string): CraftJobRequest {
  return structuredClone({ projectId: project.id, baseRevision: project.revision, steps: [{ command: craftCommandId(command), args: cleanCraftArguments(args) as Record<string, unknown> }], inputAssetIds: [...new Set(inputAssetIds)], idempotencyKey });
}
export function craftPreviewAssets(job: CraftJob): CraftOutputAsset[] {
  const assets = job.output?.assets || [];
  return assets.filter(asset => ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml', 'application/pdf'].includes(asset.mime || '') || asset.mime?.startsWith('audio/') || asset.mime?.startsWith('video/'));
}
export function craftCandidateAcceptable(job: CraftJob, project?: CraftProject) {
  return !!project && job.projectId === project.id && job.state === 'complete' && !job.accepted && !job.output?.accepted && job.output?.candidateRevision === project.revision + 1 && (job.baseRevision === undefined || job.baseRevision === project.revision);
}
export function craftAgentProjects(output?: Record<string, unknown>): CraftProject[] {
  return Array.isArray(output?.craftProjects) ? output.craftProjects.filter((project): project is CraftProject => !!project && typeof project === 'object' && typeof project.id === 'string' && typeof project.documentId === 'string' && typeof project.engineId === 'string' && Number.isSafeInteger(project.revision)) : [];
}
export const craftNativeEvidenceKey = (projects: CraftProject[]) => JSON.stringify(projects.map(project => [project.id, project.documentId, project.revision, project.nativeAssetId, project.lastJobId]));
export function craftNativeReceiptMatches(project: CraftProject, job?: CraftJob) {
  return !!job && job.documentId === project.documentId && job.projectId === project.id && job.id === project.lastJobId && job.state === 'complete' && job.acceptedRevision === project.revision && job.output?.nativeAssetId === project.nativeAssetId && !!project.nativeAssetId;
}
export function craftCanvasExport(output: CraftOutputAsset) {
  return output.role === 'export' && ['image/png', 'image/svg+xml'].includes(output.mime || '');
}
export function craftCanvasLayer(document: ImageDocument, project: CraftProject, output: CraftOutputAsset, jobId: string, id: string, at: { x: number; y: number } = { x: 0, y: 0 }): ImageLayer {
  if (document.id !== project.documentId || !document.assetIds.includes(output.id)) throw new Error('结果素材尚未归属当前画布，请先接受原生候选并刷新。');
  if (output.role !== 'export') throw new Error('请先使用“导出文件”取得实际尺寸的 PNG 或 SVG，预览缩略图不能放回画布');
  if (!['image/png', 'image/svg+xml'].includes(output.mime || '')) throw new Error('仅支持将 PNG 或 SVG 导出结果放回画布');
  if (!Number.isSafeInteger(output.width) || !Number.isSafeInteger(output.height) || !output.width || !output.height || output.width <= 0 || output.height <= 0 || output.width > 32768 || output.height > 32768 || output.width * output.height > 100000000) throw new Error('结果尺寸尚未验证，请刷新后重试');
  const vector = output.mime === 'image/svg+xml';
  return { id, type: vector ? 'vector' : 'raster', name: `${project.name} · 导出快照`, assetId: output.id, sourceAssetId: output.id, x: at.x, y: at.y, width: output.width, height: output.height, rotation: 0, opacity: 1, visible: true, locked: false, z: document.layers.length, editability: vector ? 'path' : 'pixels', metadata: { craftProjectId: project.id, craftRevision: project.revision, craftJobId: jobId, craftOutputAssetId: output.id, craftEngineId: project.engineId, craftImportMode: 'export-snapshot' } };
}
