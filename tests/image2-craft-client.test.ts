import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CraftResults, CraftSchemaField, CraftStructuredResult } from '../components/image2/CraftToolsDialog';
import { cleanCraftArguments, craftAgentProjects, craftArrayItemSchema, craftCandidateAcceptable, craftCanvasLayer, craftCommandParameterHint, craftCommonCommands, craftDefaultValue, craftEngineCommands, craftJobRequest, craftNativeEvidenceKey, craftNativeReceiptMatches, craftPath, craftPreviewAssets, craftProjectRequest, craftSchemaMatches, parseCraftArgumentText, resolveCraftSchema, type CraftEngine, type CraftJob, type CraftProject, type CraftSchema } from '../lib/image2/craft-client';
import { CraftSubmissionManager } from '../lib/image2/craft-submissions';
import type { SubmissionAttempt, SubmissionStorage } from '../lib/image2/submissions';
import type { ImageAsset, ImageDocument } from '../lib/image2/types';
import { CandidateResult } from '../components/image2/LegacyImagePanels';
import { acceptedCandidateRevision, candidatePreviewState } from '../lib/image2/candidate-preview';

class MemoryStorage implements SubmissionStorage {
  records = new Map<string, SubmissionAttempt>();
  async getOrCreate(proposed: SubmissionAttempt) { const record = this.records.get(proposed.intent); if (record) return structuredClone(record); this.records.set(proposed.intent, structuredClone(proposed)); return structuredClone(proposed); }
  async remove(intent: string) { this.records.delete(intent); }
  async list() { return [...this.records.values()].map(value => structuredClone(value)); }
}
const project: CraftProject = { id: 'native-project', documentId: 'image-document', name: '中文图案', engineId: 'vectorcraft', revision: 7 };
const job: CraftJob = { id: 'job', documentId: project.documentId, projectId: project.id, state: 'complete', output: { candidateRevision: 8, assets: [] } };

test('native form keeps schema defaults, required references and constants while excluding server-owned output defaults', () => {
  const schema: CraftSchema = { type: 'object', required: ['width', 'paint', 'source'], properties: { width: { type: 'integer', minimum: 1, default: 800 }, paint: { $ref: '#/$defs/paint' }, source: { type: 'string', 'x-craft-role': 'input-asset' }, output: { type: 'string', default: '/tmp/unsafe', 'x-craft-role': 'output' }, hidden: { const: 'native' }, optional: { type: 'string' } }, $defs: { paint: { type: 'object', required: ['color'], properties: { color: { type: 'string', default: '#ff0000' } } } } };
  assert.deepEqual(craftDefaultValue(schema), { width: 800, paint: { color: '#ff0000' }, hidden: 'native' });
  assert.equal(resolveCraftSchema({ $ref: '#/$defs/paint' }, schema).type, 'object');
});

test('both discovered direct tools and registered commands are exposed without duplicates or invented commands', () => {
  const engine: CraftEngine = { id: 'vectorcraft', name: 'VectorCraft', available: true, tools: [{ name: 'render_preview' }, { name: 'draw.rect', title: 'old' }], commands: [{ id: 'draw.rect', name: 'draw.rect', title: 'Rectangle' }] };
  assert.deepEqual(craftEngineCommands(engine).map(item => item.name), ['render_preview', 'draw.rect']);
  assert.equal(craftEngineCommands(engine)[1].title, 'Rectangle');
  assert.deepEqual(craftEngineCommands(), []);
  assert.deepEqual(craftCommonCommands(engine).map(item => item.label), ['预览内容']);
  assert.equal(craftCommonCommands(engine)[0].command.name, 'render_preview');
});

test('empty native form parameters are omitted without inventing zero, null, false or an enum choice', () => {
  assert.deepEqual(craftDefaultValue({ type: 'object', required: ['width', 'enabled', 'format'], properties: { width: { type: 'number' }, enabled: { type: 'boolean' }, format: { type: 'string', enum: ['pdf', 'png'] } } }), {});
  assert.deepEqual(cleanCraftArguments({ width: undefined, nested: { height: undefined, x: 0 }, enabled: false, text: '' }), { nested: { x: 0 }, enabled: false, text: '' });
  assert.throws(() => cleanCraftArguments([undefined]), /列表/); assert.throws(() => cleanCraftArguments({ width: NaN }), /有效数字/);
});

test('advanced parameter editor accepts bounded JSON objects only and does not parse shell text', () => {
  assert.deepEqual(parseCraftArgumentText('{"text":"中文","source":{"assetId":"owned"},"output":{"outputName":"result.svg"}}'), { text: '中文', source: { assetId: 'owned' }, output: { outputName: 'result.svg' } });
  for (const text of ['[]', 'null', '1', '$(command)', '{invalid}']) assert.throws(() => parseCraftArgumentText(text), /JSON/);
  assert.throws(() => parseCraftArgumentText(' '.repeat(128 * 1024 + 1)), /128 KiB/);
  assert.equal(craftCommandParameterHint({ name: 'file.new', params: '{"width":1..300000=1920}' }), '{"width":1..300000=1920}');
  assert.match(craftCommandParameterHint({ name: 'unknown', schemaUnavailable: true }), /未提供结构化参数/);
});

test('schema form distinguishes unset/false, handles nullable numbers, enum values and chained local refs', () => {
  const render = (schema: CraftSchema, value: unknown, root: CraftSchema = schema, required = true) => renderToStaticMarkup(createElement(CraftSchemaField, { name: '参数', schema, root, required, value, onChange: () => {}, assets: [] }));
  const unset = render({ type: 'boolean' }, undefined), explicitFalse = render({ type: 'boolean' }, false);
  assert.match(unset, /value="" selected/); assert.match(explicitFalse, /value="false" selected/); assert.match(unset, /required=""/);
  assert.match(render({ type: 'string', enum: ['png', 'pdf'] }, 'pdf'), /value="1" selected/);
  const nullable: CraftSchema = { type: ['integer', 'null'] };
  assert.match(render(nullable, 8), /type="number"/); assert.match(render(nullable, null), /已明确留空/); assert.equal(craftSchemaMatches({ type: 'integer' }, 1.5, {}), false);
  const root: CraftSchema = { $defs: { one: { $ref: '#/$defs/two' }, two: { type: 'number', minimum: 3 } } };
  assert.equal(resolveCraftSchema({ $ref: '#/$defs/one' }, root).minimum, 3); assert.match(render({ $ref: '#/$defs/one' }, 5, root), /type="number"/);
});

test('optional nested objects do not impose hidden required controls, and tuple arrays retain per-index schema', () => {
  const schema: CraftSchema = { type: 'object', required: ['width'], properties: { width: { type: 'number' } } };
  const absent = renderToStaticMarkup(createElement(CraftSchemaField, { name: '裁切', schema, root: schema, value: undefined, onChange: () => {}, assets: [], required: false }));
  assert.match(absent, /设置裁切/); assert.doesNotMatch(absent, /required=""/);
  const present = renderToStaticMarkup(createElement(CraftSchemaField, { name: '裁切', schema, root: schema, value: {}, onChange: () => {}, assets: [], required: false }));
  assert.match(present, /不设置裁切/); assert.match(present, /required=""/);
  const tuple: CraftSchema = { type: 'array', items: [{ type: 'integer' }, { type: 'string' }], additionalItems: false };
  assert.equal(craftArrayItemSchema(tuple, 0).type, 'integer'); assert.equal(craftArrayItemSchema(tuple, 1).type, 'string');
  const rendered = renderToStaticMarkup(createElement(CraftSchemaField, { name: '坐标', schema: tuple, root: tuple, value: [10, '标签'], onChange: () => {}, assets: [] }));
  assert.match(rendered, /type="number"/); assert.match(rendered, /value="标签"/); assert.match(rendered, /disabled=""[^>]*>添加坐标/);
});

test('native request freezes its selected revision, schema args and source assets independently from later edits', () => {
  const live = structuredClone(project), args = { fill: '#ff0000', source: { assetId: 'input-a' } };
  const request = craftJobRequest(live, { name: 'draw.rect' }, args, ['input-a', 'input-a'], 'stable-key');
  live.revision = 9; args.fill = '#000000'; args.source.assetId = 'input-b';
  assert.equal(request.baseRevision, 7); assert.equal(request.steps[0].args.fill, '#ff0000'); assert.deepEqual(request.steps[0].args.source, { assetId: 'input-a' }); assert.deepEqual(request.inputAssetIds, ['input-a']);
  assert.equal(craftPath('doc/a', 'projects'), '/documents/doc%2Fa/craft/projects');
});

test('lost native HTTP acknowledgement survives manager restart with the same body and key, never the advanced revision', async () => {
  const storage = new MemoryStorage(), received: unknown[] = [];
  const transport = async (_path: string, body: Record<string, unknown>) => { received.push(structuredClone(body)); if (received.length === 1) throw new Error('lost after accept'); return { id: 'persisted-job' }; };
  const first = new CraftSubmissionManager(storage, transport), body = craftJobRequest(project, { name: 'draw.rect' }, { width: 60 }, [], 'stable-key');
  await assert.rejects(first.submit('/native/jobs', project.documentId, { projectId: project.id }, body), /lost/);
  const restored = new CraftSubmissionManager(storage, transport);
  assert.equal((await restored.pending(project.documentId)).length, 1); assert.equal((await restored.pending('other-owner-doc')).length, 0);
  await restored.submit('/native/jobs', project.documentId, { projectId: project.id }, { ...body, baseRevision: 999, idempotencyKey: 'new-key' });
  assert.deepEqual(received[1], received[0]); assert.equal((await restored.pending(project.documentId)).length, 0);
});

test('native pending queue retains malformed receipts and rate limits but releases a definitive validation rejection', async () => {
  for (const status of [undefined, 429, 408, 422]) {
    const storage = new MemoryStorage(), manager = new CraftSubmissionManager(storage, async () => { if (status) throw Object.assign(new Error('server rejected'), { status }); return { ok: true }; });
    await assert.rejects(manager.submit('/native/projects', project.documentId, { engineId: 'vectorcraft' }, { idempotencyKey: 'one' }));
    assert.equal((await manager.pending(project.documentId)).length, status === 422 ? 0 : 1);
  }
});

test('native acceptance requires a completed candidate belonging to the selected project and never accepts twice', () => {
  assert.equal(craftCandidateAcceptable(job, project), true);
  for (const changed of [{ ...job, state: 'running' }, { ...job, accepted: true }, { ...job, projectId: 'elsewhere' }, { ...job, output: {} }, { ...job, output: { ...job.output, accepted: true } }]) assert.equal(craftCandidateAcceptable(changed, project), false);
  assert.equal(craftCandidateAcceptable(job, { ...project, revision: 8 }), false);
});

test('Agent native candidate evidence ties each exact project revision to an accepted job and checkpoint', () => {
  const native = { ...project, lastJobId: job.id, nativeAssetId: 'checkpoint' }, receipt = { ...job, acceptedRevision: project.revision, output: { ...job.output, nativeAssetId: 'checkpoint' } };
  assert.equal(craftNativeReceiptMatches(native, receipt), true);
  assert.equal(craftNativeReceiptMatches(native, { ...receipt, acceptedRevision: 8 }), false);
  assert.equal(craftNativeReceiptMatches(native, { ...receipt, documentId: 'another-document' }), false);
  assert.equal(craftNativeReceiptMatches(native, { ...receipt, output: { ...receipt.output, nativeAssetId: 'old' } }), false);
  assert.notEqual(craftNativeEvidenceKey([native]), craftNativeEvidenceKey([{ ...native, revision: 8 }]));
  assert.equal(craftAgentProjects({ craftProjects: [native, null, { id: 'fake' }] }).length, 1);
});

test('native-only Agent card requires its real native receipt before acceptance and hides empty image preview', () => {
  const branch = { id: 'branch', schemaVersion: 3, revision: 2, layers: [] }, native = { ...project, documentId: branch.id, lastJobId: 'native-job', nativeAssetId: 'checkpoint' };
  const props = { bridge: { branches: [branch] }, job: { id: 'agent-job', state: 'complete', kind: 'agent', output: { branchDocumentId: branch.id, revision: 2, previewRevision: 2, previewAssetId: 'transparent-png', craftProjects: [native] } }, onError: () => {}, onViewNativeCandidate: () => {} } as unknown as Parameters<typeof CandidateResult>[0];
  const html = renderToStaticMarkup(createElement(CandidateResult, props));
  assert.match(html, /本次任务包含 1 个原生工程候选/); assert.match(html, /查看原生候选/); assert.match(html, /disabled=""[^>]*>接受候选/); assert.doesNotMatch(html, /assets\/transparent-png\/content/);
});

test('a native-only zero-revision task does not present the inherited canvas as its edited result', () => {
  const branch = { id: 'branch', schemaVersion: 3, revision: 0, layers: [{ id: 'inherited', type: 'raster', visible: true, opacity: 1 }] };
  const native = { ...project, documentId: branch.id, lastJobId: 'native-job', nativeAssetId: 'checkpoint' };
  const props = { bridge: { branches: [branch] }, job: { id: 'agent-job', state: 'complete', kind: 'agent', output: { branchDocumentId: branch.id, revision: 0, previewRevision: 0, previewAssetId: 'inherited-canvas', craftProjects: [native] } }, onError: () => {}, onViewNativeCandidate: () => {} } as unknown as Parameters<typeof CandidateResult>[0];
  const html = renderToStaticMarkup(createElement(CandidateResult, props));
  assert.match(html, /查看原生候选/); assert.doesNotMatch(html, /assets\/inherited-canvas\/content/);
});

test('native-only whole acceptance uses the server receipt even when the main image revision stays unchanged', () => {
  const branch = { id: 'branch', parentDocumentId: 'image-document', schemaVersion: 3, revision: 0, layers: [], metadata: { acceptedAt: '2026-10-14T11:11:04Z', acceptedRevision: 18, acceptedIntoDocumentId: 'image-document' } } as unknown as ImageDocument;
  const native = { ...project, documentId: branch.id, lastJobId: 'native-job', nativeAssetId: 'checkpoint' };
  const props = { bridge: { branches: [branch] }, job: { id: 'agent-job', documentId: 'image-document', state: 'complete', kind: 'agent', output: { branchDocumentId: branch.id, revision: 0, previewRevision: 0, previewAssetId: 'inherited-canvas', craftProjects: [native] } }, onError: () => {}, onViewVersions: () => {}, onViewNativeCandidate: () => {} } as unknown as Parameters<typeof CandidateResult>[0];
  assert.equal(acceptedCandidateRevision(branch), 18);
  assert.equal(acceptedCandidateRevision({ ...branch, metadata: { ...branch.metadata, acceptedIntoDocumentId: 'another-document' } }), undefined);
  assert.equal(candidatePreviewState(props.job, branch).status, 'accepted');
  assert.equal(candidatePreviewState(props.job, branch).canAccept, false);
  const html = renderToStaticMarkup(createElement(CandidateResult, props));
  assert.match(html, /已接受到主工程（图片版本 18）/); assert.match(html, /查看原生结果/);
  assert.doesNotMatch(html, /缺少当前版本依据|查看版本|>接受候选<|assets\/inherited-canvas\/content/);
});

test('asset form fields only select owned uploaded asset IDs and output filenames, not machine paths', () => {
  const asset = { id: 'asset-id', name: 'Logo.svg', documentId: project.documentId } as ImageAsset;
  const source = renderToStaticMarkup(createElement(CraftSchemaField, { name: 'source', schema: { type: 'string', 'x-craft-role': 'input-asset' }, root: {}, value: { assetId: asset.id }, onChange: () => {}, assets: [asset] }));
  assert.match(source, /value="asset-id" selected/); assert.match(source, /Logo.svg/); assert.doesNotMatch(source, /type="text"/);
  const output = renderToStaticMarkup(createElement(CraftSchemaField, { name: 'output', schema: { type: 'string', 'x-craft-role': 'output' }, root: {}, value: { outputName: '中文结果.svg' }, onChange: () => {}, assets: [] }));
  assert.match(output, /中文结果.svg/); assert.match(output, /只填写文件名/); assert.doesNotMatch(output, /\[object Object\]/);
});

test('native outputs preview only validated media MIME; opaque files remain downloads and structured values are escaped', () => {
  const value: CraftJob = { ...job, output: { ...job.output, assets: [{ id: 'image', name: '预览.png', mime: 'image/png' }, { id: 'opaque', name: '工程.svg', mime: 'application/octet-stream' }, { id: 'html', name: '页面.html', mime: 'text/html' }], result: { title: '<script>bad()</script>', cell: '中文标题' } } };
  assert.deepEqual(craftPreviewAssets(value).map(asset => asset.id), ['image']);
  const html = renderToStaticMarkup(createElement(CraftResults, { job: value }));
  assert.match(html, /assets\/image\/content/); assert.doesNotMatch(html, /<img[^>]+assets\/opaque/); assert.doesNotMatch(html, /<iframe|<script>/); assert.match(html, /&lt;script&gt;/); assert.match(html, /中文标题/);
  const many = renderToStaticMarkup(createElement(CraftStructuredResult, { value: Array.from({ length: 120 }, (_, index) => index) })); assert.match(many, /显示前 100 项，共 120 项/);
});

test('putting native exports on the original canvas preserves immutable pixels/paths and native provenance', () => {
  const document = { id: project.documentId, layers: [], assetIds: ['source'], schemaVersion: 3 } as unknown as ImageDocument;
  const source = { id: 'source', role: 'export', mime: 'image/png', width: 300, height: 200 };
  const layer = craftCanvasLayer(document, project, source, 'native-job', 'layer', { x: 120, y: 40 });
  assert.equal(layer.assetId, source.id); assert.equal(layer.sourceAssetId, source.id); assert.equal(layer.width, 300); assert.equal(layer.height, 200); assert.equal(layer.x, 120);
  assert.deepEqual(layer.metadata, { craftProjectId: project.id, craftRevision: 7, craftJobId: 'native-job', craftOutputAssetId: 'source', craftEngineId: 'vectorcraft', craftImportMode: 'export-snapshot' });
  assert.match(layer.name, /导出快照/);
  const svg = craftCanvasLayer(document, project, { ...source, mime: 'image/svg+xml' }, 'native-job', 'svg-layer'); assert.equal(svg.type, 'vector'); assert.equal(svg.editability, 'path');
  assert.throws(() => craftCanvasLayer({ ...document, id: 'other' }, project, source, 'job', 'layer'), /归属/);
  assert.throws(() => craftCanvasLayer(document, project, { ...source, mime: 'application/octet-stream' }, 'job', 'layer'), /PNG 或 SVG/);
  for (const width of [undefined, NaN, Infinity, -1, 0, 1.5, 32769]) assert.throws(() => craftCanvasLayer(document, project, { ...source, width }, 'job', 'layer'), /尺寸尚未验证/);
  const nativeSvg = craftCanvasLayer(document, project, { ...source, mime: 'image/svg+xml', width: 256, height: 192 }, 'native-svg-job', 'svg-256');
  assert.deepEqual([nativeSvg.width, nativeSvg.height], [256, 192]); assert.equal(nativeSvg.type, 'vector');
  for (const role of ['preview', 'native', undefined]) assert.throws(() => craftCanvasLayer(document, project, { ...source, role }, 'job', 'layer'), /预览缩略图不能放回画布/);
});

test('native preview thumbnails remain visible but only actual PNG/SVG exports can be placed on the canvas', () => {
  const thumbnail = { id: 'thumb', name: 'preview.png', role: 'preview', mime: 'image/png', width: 1024, height: 768 };
  const previewJob = { ...job, output: { assets: [thumbnail] } };
  const html = renderToStaticMarkup(createElement(CraftResults, { job: previewJob, onPlace: () => {} }));
  assert.match(html, /<img[^>]+assets\/thumb\/content/); assert.match(html, /download="preview.png"/);
  assert.doesNotMatch(html, /<button[^>]*>放回画布<\/button>/); assert.match(html, /使用“导出文件”取得实际尺寸/);
  const output = { ...thumbnail, id: 'full', name: 'poster.png', role: 'export', width: 4000, height: 3000 };
  const exported = renderToStaticMarkup(createElement(CraftResults, { job: { ...job, output: { assets: [thumbnail, output, { ...output, id: 'svg', name: 'poster.svg', mime: 'image/svg+xml' }, { ...output, id: 'opaque', mime: 'application/octet-stream' }] } }, onPlace: () => {} }));
  assert.equal((exported.match(/<button[^>]*>放回画布<\/button>/g) || []).length, 2);
});

test('native version restoration also recovers the frozen historical revision after a lost receipt', async () => {
  const storage = new MemoryStorage(), received: unknown[] = [];
  const transport = async (_path: string, body: Record<string, unknown>) => { received.push(structuredClone(body)); if (received.length === 1) throw new Error('restore receipt lost'); return { id: 'restoration-candidate' }; };
  const first = new CraftSubmissionManager(storage, transport), body = { revision: 2, baseRevision: 7, idempotencyKey: 'restore-once' };
  await assert.rejects(first.submit('/native/projects/project/restore', project.documentId, { projectId: project.id }, body));
  const restarted = new CraftSubmissionManager(storage, transport); await restarted.submit('/native/projects/project/restore', project.documentId, { projectId: project.id }, { revision: 3, baseRevision: 8, idempotencyKey: 'new-restore' });
  assert.deepEqual(received[1], body); assert.equal((await restarted.pending(project.documentId)).length, 0);
});

test('bundle import uses an uploaded asset and preserves that exact source after a lost creation receipt', async () => {
  const engine: CraftEngine = { id: 'vectorcraft', name: 'VectorCraft', available: true, commands: [] };
  const bundle = { id: 'uploaded-bundle', name: '海报.craftbundle', mime: 'application/octet-stream' } as ImageAsset;
  const empty = craftProjectRequest(engine, ' ', 'empty-key');
  assert.deepEqual(empty, { engineId: engine.id, name: '矢量绘图工程', idempotencyKey: 'empty-key' });
  assert.throws(() => craftProjectRequest(engine, '海报', 'key', 'missing', [bundle]), /已上传/);
  assert.throws(() => craftProjectRequest(engine, '海报', 'key', bundle.id, [{ ...bundle, name: '海报.svg' }]), /craftbundle/);
  const body = craftProjectRequest(engine, '  可续编海报  ', 'import-once', bundle.id, [bundle]);
  assert.equal(body.name, '可续编海报'); assert.equal(body.initialAssetId, bundle.id);
  const storage = new MemoryStorage(), received: unknown[] = [];
  const transport = async (_path: string, request: Record<string, unknown>) => { received.push(structuredClone(request)); if (received.length === 1) throw new Error('import receipt lost'); return { id: 'import-project', importJobId: 'verification-job', pendingImportAssetId: bundle.id }; };
  await assert.rejects(new CraftSubmissionManager(storage, transport).submit('/native/projects', project.documentId, { engineId: engine.id }, body));
  const restarted = new CraftSubmissionManager(storage, transport);
  const imported = await restarted.submit<CraftProject>('/native/projects', project.documentId, { engineId: engine.id }, empty);
  assert.deepEqual(received[1], body); assert.equal(imported.pendingImportAssetId, bundle.id); assert.equal(imported.importJobId, 'verification-job');
  assert.equal((await restarted.pending(project.documentId)).length, 0);
});
