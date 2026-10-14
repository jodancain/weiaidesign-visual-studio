import test from 'node:test';
import assert from 'node:assert/strict';
import { ImageCommandQueue, applyDraft, type QueuedBatch, type QueueStorage } from '../lib/image2/queue';
import { localToDocument, documentToLocal, layerPixelPoint, capability } from '../lib/image2/geometry';
import type { ImageDocument, ImageLayer } from '../lib/image2/types';
import { groupLayerCommands, ungroupLayerCommands } from '../lib/image2/grouping';
import { orderedLayers, reorderSiblingCommands } from '../lib/image2/stacking';
import { imageAgentCapability, imageCapabilitiesForDocument, requireImageAgent } from '../lib/image2/agent-capabilities';
import { imageAdjustmentRequest, imageAdjustments } from '../lib/image2/adjustments';
import { professionalSvgContent, professionalSvgStyles, svgPaintPatch, svgHexPaintChange } from '../lib/image2/professional-svg-styles';
import { candidatePreviewAssets, candidatePreviewState } from '../lib/image2/candidate-preview';
import { elementPreviewSource } from '../lib/image2/element-preview';
import type { ImageJob } from '../lib/image2/types';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CandidateResult, LegacyImagePanels } from '../components/image2/LegacyImagePanels';

const layer = (patch: Partial<ImageLayer> = {}): ImageLayer => ({ id: 'a', type: 'raster', name: '原图', x: 0, y: 0, width: 100, height: 80, rotation: 0, opacity: 1, visible: true, locked: false, z: 0, ...patch });
const document = (): ImageDocument => ({ id: 'doc', name: '设计', schemaVersion: 2, revision: 3, width: 100, height: 80, layers: [layer()], assetIds: [], createdAt: 0, updatedAt: 0 });
class MemoryStorage implements QueueStorage {
  records = new Map<string, QueuedBatch>(); document?: ImageDocument;
  async list(id: string) { return [...this.records.values()].filter(batch => batch.documentId === id).sort((a, b) => a.createdAt - b.createdAt); }
  async put(batch: QueuedBatch) { this.records.set(batch.id, structuredClone(batch)); }
  async remove(id: string) { this.records.delete(id); }
  async saveDocument(value: ImageDocument) { this.document = structuredClone(value); }
}
test('queued edits advance the server revision, preserve user order, and are only drafts before ACK', async () => {
  const storage = new MemoryStorage(), requests: { baseRevision: number; commandId: string }[] = [];
  const queue = new ImageCommandQueue(storage, async (_id, body) => { requests.push(body); return { ...applyDraft(storage.document || document(), [{ ...body, id: body.commandId, documentId: 'doc', createdAt: 0, state: 'queued' }]), revision: body.baseRevision + 1 }; });
  await queue.enqueue('doc', [{ type: 'layer.update', layerId: 'a', patch: { name: '第一次' } }]);
  await queue.enqueue('doc', [{ type: 'layer.update', layerId: 'a', patch: { name: '中文 Logo' } }]);
  assert.equal(applyDraft(document(), await queue.pending('doc')).revision, 3);
  const result = await queue.flush(document(), () => {});
  assert.deepEqual(requests.map(request => request.baseRevision), [3, 4]);
  assert.equal(result.layers[0].name, '中文 Logo'); assert.equal(result.revision, 5); assert.equal((await queue.pending('doc')).length, 0);
});
test('an unknown HTTP outcome resumes with the same command id and frozen base revision', async () => {
  const storage = new MemoryStorage(), calls: { baseRevision: number; commandId: string }[] = [];
  const queue = new ImageCommandQueue(storage, async (_id, body) => { calls.push(body); if (calls.length === 1) throw new Error('network lost after acceptance'); return { ...document(), revision: 4 }; });
  await queue.enqueue('doc', [{ type: 'layer.update', layerId: 'a', patch: { x: 7 } }]);
  await assert.rejects(queue.flush(document(), () => {}), /network/);
  assert.equal((await queue.pending('doc')).length, 1);
  await queue.flush({ ...document(), revision: 4 }, () => {});
  assert.equal(calls[0].baseRevision, calls[1].baseRevision); assert.equal(calls[0].commandId, calls[1].commandId);
});
test('conflicts persist blocked work and stop later edits without overwriting the remote document', async () => {
  const storage = new MemoryStorage(); let calls = 0;
  const queue = new ImageCommandQueue(storage, async () => { calls++; throw Object.assign(new Error('revision conflict'), { status: 409 }); });
  await queue.enqueue('doc', [{ type: 'layer.update', layerId: 'a', patch: { fill: '#ff0000' } }]);
  await queue.enqueue('doc', [{ type: 'layer.remove', layerId: 'a' }]);
  await assert.rejects(queue.flush(document(), () => {}), /conflict/);
  assert.equal((await queue.pending('doc'))[0].state, 'blocked');
  await queue.flush({ ...document(), revision: 99 }, () => {}); assert.equal(calls, 1); assert.equal((await queue.pending('doc')).length, 2);
});
test('document pixels invert rotated nested parents and scale to the asset buffer', () => {
  const parent = layer({ id: 'parent', type: 'group', x: 120, y: 50, rotation: 90 });
  const child = layer({ id: 'child', parentId: parent.id, x: 20, y: 10, width: 200, height: 100, rotation: 30 });
  const layers = [parent, child], point = { x: 15, y: 23 }, world = localToDocument(point, child, layers);
  const local = documentToLocal(world, child, layers);
  assert.ok(Math.abs(local.x - point.x) < 1e-9); assert.ok(Math.abs(local.y - point.y) < 1e-9);
  const pixel = layerPixelPoint(world, child, layers, { width: 1000, height: 500 });
  assert.ok(Math.abs(pixel.x - 75) < 1e-9); assert.ok(Math.abs(pixel.y - 115) < 1e-9);
});
test('unavailable ML never appears enabled; runtime registry arrays are supported', () => {
  const caps = { operations: [{ name: 'matting', available: false, reason: 'GPU 未配置' }, { name: 'resize', available: true }] };
  assert.equal(capability(caps, 'matting').available, false); assert.equal(capability(caps, 'matting').reason, 'GPU 未配置');
  assert.equal(capability(caps, 'resize').available, true); assert.equal(capability(caps, 'inpaint').available, false);
});
test('an ACK render with a still-pending layer.add cannot duplicate the accepted layer', () => {
  const doc = document(), accepted = layer({ id: 'new', name: 'Logo' }); doc.layers.push(accepted);
  const draft = applyDraft(doc, [{ id: 'pending', documentId: doc.id, createdAt: 0, state: 'queued', commands: [{ type: 'layer.add', layer: accepted }] }]);
  assert.equal(draft.layers.filter(item => item.id === 'new').length, 1); assert.equal(draft.revision, doc.revision);
});
test('group and ungroup retain stable child identities, native content, and nested world transforms', () => {
  const doc = document();
  doc.layers = [layer({ id: 'parent', type: 'group', x: 100, y: 70, rotation: 40, opacity: .5 }),
    layer({ id: 'text', type: 'text', parentId: 'parent', x: 15, y: 22, rotation: 20, text: '中文', fontAssetId: 'font', z: 0 }),
    layer({ id: 'logo', type: 'vector', parentId: 'parent', x: -30, y: 10, rotation: -15, assetId: 'svg', z: 3 })];
  const before = localToDocument({ x: 8, y: 12 }, doc.layers[1], doc.layers);
  const grouped = applyDraft(doc, [{ id: 'g', documentId: doc.id, createdAt: 0, state: 'queued', commands: groupLayerCommands(doc, ['text', 'logo'], 'combined') }]);
  const after = localToDocument({ x: 8, y: 12 }, grouped.layers.find(item => item.id === 'text')!, grouped.layers);
  assert.ok(Math.abs(before.x - after.x) < 1e-8 && Math.abs(before.y - after.y) < 1e-8);
  assert.equal(grouped.layers.find(item => item.id === 'text')!.text, '中文'); assert.equal(grouped.layers.find(item => item.id === 'logo')!.assetId, 'svg');
  const split = applyDraft(grouped, [{ id: 'u', documentId: doc.id, createdAt: 1, state: 'queued', commands: ungroupLayerCommands(grouped, 'combined') }]);
  const restored = localToDocument({ x: 8, y: 12 }, split.layers.find(item => item.id === 'text')!, split.layers);
  assert.ok(Math.abs(before.x - restored.x) < 1e-8 && Math.abs(before.y - restored.y) < 1e-8);
  assert.equal(split.layers.find(item => item.id === 'text')!.opacity, 1); assert.equal(split.layers.find(item => item.id === 'text')!.fontAssetId, 'font');
});
test('nested z values cannot interleave with another root subtree; grouping and splitting preserve every overlap', () => {
  const doc = document(); doc.layers = [layer({ id: 'low', type: 'group', z: 4 }), layer({ id: 'high', type: 'group', z: 5 }),
    layer({ id: 'a', parentId: 'low', z: 100, opacity: .6 }), layer({ id: 'b', parentId: 'low', z: 101, opacity: .5 }),
    layer({ id: 'c', parentId: 'high', z: -300 })];
  const paint = (value: ImageDocument) => orderedLayers(value.layers).filter(item => item.type !== 'group').map(item => item.id);
  const pixel = (value: ImageDocument) => paint(value).reduce((rgba, id) => {
    const node = value.layers.find(item => item.id === id)!, color = ({ a: [255, 0, 0], b: [0, 255, 0], c: [0, 0, 255] } as Record<string, number[]>)[id];
    return color.map((channel, at) => channel * node.opacity + rgba[at] * (1 - node.opacity));
  }, [255, 255, 255]);
  assert.deepEqual(paint(doc), ['a', 'b', 'c']);
  const grouped = applyDraft(doc, [{ id: 'g', documentId: doc.id, createdAt: 0, state: 'queued', commands: groupLayerCommands(doc, ['a', 'b'], 'group') }]);
  const split = applyDraft(grouped, [{ id: 'u', documentId: doc.id, createdAt: 1, state: 'queued', commands: ungroupLayerCommands(grouped, 'group') }]);
  assert.deepEqual(paint(grouped), paint(doc)); assert.deepEqual(paint(split), paint(doc)); assert.deepEqual(pixel(grouped), pixel(doc)); assert.deepEqual(pixel(split), pixel(doc));
  const reordered = applyDraft(doc, [{ id: 'r', documentId: doc.id, createdAt: 2, state: 'queued', commands: reorderSiblingCommands(doc.layers, 'a', 1) }]);
  assert.deepEqual(paint(reordered), ['b', 'a', 'c']); assert.equal(reordered.layers.find(item => item.id === 'c')!.z, -300);
});
test('unsafe grouping rejects nonadjacent/cross-parent layers and splitting a composite opacity', () => {
  const doc = document(); doc.layers = [layer({ id: 'a', z: 0 }), layer({ id: 'b', z: 1 }), layer({ id: 'c', z: 2 }), layer({ id: 'group', type: 'group', z: 3, opacity: .5 }), layer({ id: 'child', parentId: 'group' })];
  assert.throws(() => groupLayerCommands(doc, ['a', 'c']), /相邻/);
  assert.throws(() => groupLayerCommands(doc, ['a', 'child']), /同一个组合/);
  assert.throws(() => ungroupLayerCommands(doc, 'group'), /整体透明度/);
});

test('professional chat requires an explicit CPU-only Agent contract, never legacy model readiness', () => {
  const legacy = { agent: { available: true, model: 'chat-a', models: ['chat-a'] } };
  assert.equal(imageAgentCapability(legacy, 2).available, true);
  assert.equal(imageAgentCapability(legacy, 3).available, false);
  assert.throws(() => requireImageAgent(legacy, 3), /算法设计助手尚未配置/);
  const available = { ...legacy, professional: { agent: { available: true, executionClasses: ['cpu'], model: 'chat-b', models: ['chat-b'], allowedOperations: ['resize', 'adjust', 'filter'], tools: ['image_operation', 'apply_commands'] } } };
  assert.equal(requireImageAgent(available, 3, 'chat-b').available, true);
  assert.throws(() => requireImageAgent(available, 3, 'chat-a'), /未配置/);
  assert.equal(imageAgentCapability({ professional: { agent: { ...available.professional.agent, executionClasses: ['cpu', 'generation'] } } }, 3).available, false);
  assert.equal(imageAgentCapability({ professional: { agent: { available: 'true', executionClasses: ['cpu'], allowedOperations: [] } } }, 3).available, false);
  assert.equal(imageAgentCapability({ professional: { agent: { available: false, reason: '对话服务离线', executionClasses: ['cpu'], allowedOperations: [] } } }, 3).reason, '对话服务离线');
});

test('homepage capability projection exposes professional chat models and only implemented CPU operations', () => {
  const caps = { agent: { available: true, models: ['legacy'] }, operations: [
    { operation: 'resize', available: true, executionClass: 'cpu' }, { operation: 'adjust', available: true, executionClass: 'cpu' },
    { operation: 'filter', available: true, executionClass: 'cpu' }, { operation: 'refine_mask', available: true, executionClass: 'cpu' },
    { operation: 'generate', available: true, executionClass: 'generation' }, { operation: 'segment', available: true, executionClass: 'vision' },
  ], professional: { agent: { available: true, executionClasses: ['cpu'], models: ['professional'], allowedOperations: ['resize', 'adjust', 'filter'] }, operations: [
    { operation: 'resize', available: true, executionClass: 'cpu' }, { operation: 'adjust', available: true, executionClass: 'cpu' }, { operation: 'filter', available: true, executionClass: 'cpu' },
    { operation: 'generate', available: true, executionClass: 'generation' }, { operation: 'segment', available: true, executionClass: 'vision' },
  ] } };
  assert.equal(imageCapabilitiesForDocument(caps, 2), caps);
  const effective = imageCapabilitiesForDocument(caps, 3);
  assert.deepEqual((effective.agent as { models: string[] }).models, ['professional']);
  for (const operation of ['resize', 'adjust', 'filter']) assert.equal(capability(effective, operation).available, true);
  for (const operation of ['refine_mask', 'generate', 'segment']) assert.equal(capability(effective, operation).available, false);
  assert.equal(capability(imageCapabilitiesForDocument({ operations: caps.operations }, 3), 'resize').available, false);
  assert.equal(caps.operations[4].available, true, 'capability projection must not mutate other documents');
});

test('all folded adjustment choices create explicit CPU operation requests without generated prompts', () => {
  for (const choice of imageAdjustments) {
    const request = imageAdjustmentRequest(choice.id, {});
    assert.equal(request.operation, choice.operation); assert.equal(request.params.kind, choice.id);
    assert.equal('prompt' in request.params, false);
  }
  assert.deepEqual(imageAdjustmentRequest('brightness', { value: '-30' }), { operation: 'adjust', params: { kind: 'brightness', value: -30 } });
  assert.deepEqual(imageAdjustmentRequest('invert', { value: 999 }), { operation: 'adjust', params: { kind: 'invert' } });
  assert.deepEqual(imageAdjustmentRequest('levels', { black: 15, white: 240, gamma: 1.4 }), { operation: 'adjust', params: { kind: 'levels', black: 15, white: 240, gamma: 1.4 } });
  assert.deepEqual(imageAdjustmentRequest('gaussian_blur', { radius: 1.5 }), { operation: 'filter', params: { kind: 'gaussian_blur', radius: 1.5 } });
  assert.deepEqual(imageAdjustmentRequest('median', { size: 7 }), { operation: 'filter', params: { kind: 'median', size: 7 } });
  assert.deepEqual(imageAdjustmentRequest('invert', { feather: '2' }), { operation: 'adjust', params: { kind: 'invert', feather: 2 } });
  for (const [kind, values] of [['brightness', { value: 101 }], ['exposure', { value: '' }], ['gamma', { value: 0 }], ['threshold', { value: 256 }], ['levels', { black: 100, white: 100 }], ['median', { size: 4 }]] as const) assert.throws(() => imageAdjustmentRequest(kind, values));
  assert.throws(() => imageAdjustmentRequest('generate', {}), /未注册/);
  assert.throws(() => imageAdjustmentRequest('brightness', { feather: -1 }), /羽化/);
});

test('legacy Logo stroke controls produce valid immutable v3 SVG paint content', async () => {
  const original = { '*': { fill: '#ff0000', 'stroke-width': 2 }, path1: { stroke: '#0000ff', strokeWidth: 1, 'stroke-width': 3 } };
  const styles = professionalSvgStyles(original);
  assert.deepEqual(styles, { '*': { fill: '#ff0000', strokeWidth: 2 }, path1: { stroke: '#0000ff', strokeWidth: 3 } });
  assert.equal(original.path1.strokeWidth, 1);
  const { validateContentJSON } = await import(new URL('../services/image2/domain-v3.mjs', import.meta.url).href);
  assert.doesNotThrow(() => validateContentJSON({ formatVersion: 1, kind: 'svg', sourceAssetId: 'source', fontAssetIds: [], pathStyles: styles }));
  assert.throws(() => validateContentJSON({ formatVersion: 1, kind: 'svg', sourceAssetId: 'source', fontAssetIds: [], pathStyles: original }), /unsupported path style/);
  assert.throws(() => professionalSvgStyles({ path1: null }), /无效/);
});

test('consecutive SVG paint edits retain registered source and font identities when the compact view lacks asset fields', async () => {
  const { validateContentJSON } = await import(new URL('../services/image2/domain-v3.mjs', import.meta.url).href);
  const original = { formatVersion: 1, kind: 'svg', sourceAssetId: 'original-svg', fontAssetIds: ['actual-font'] };
  const registered = ['original-svg', 'actual-font'];
  const width = professionalSvgContent(layer({ type: 'vector', contentId: 'before', metadata: { pathStyles: { path1: { 'stroke-width': 2 } } } }), original, registered);
  const color = professionalSvgContent(layer({ type: 'vector', contentId: 'width', metadata: { pathStyles: { path1: { strokeWidth: 2, stroke: '#ff0000' } } } }), width, registered);
  for (const content of [width, color]) {
    assert.equal(content.sourceAssetId, 'original-svg'); assert.deepEqual(content.fontAssetIds, ['actual-font']);
    assert.doesNotThrow(() => validateContentJSON(content));
  }
  assert.deepEqual(color.pathStyles, { path1: { strokeWidth: 2, stroke: '#ff0000' } });
  assert.deepEqual(width.pathStyles, { path1: { strokeWidth: 2 } });
  assert.equal('pathStyles' in original, false);
  assert.throws(() => professionalSvgContent(layer({ type: 'vector' }), undefined, registered), /原始素材尚未就绪/);
  assert.throws(() => professionalSvgContent(layer({ type: 'vector' }), original, ['actual-font']), /原始素材尚未就绪/);
  assert.throws(() => professionalSvgContent(layer({ type: 'vector' }), original, ['original-svg']), /实际字体引用尚未就绪/);
});

test('preserved SVG appearance cannot hide a successful-looking paint edit', () => {
  const original = { formatVersion: 1, kind: 'svg', sourceAssetId: 'original-svg', fontAssetIds: [], appearanceAssetId: 'preserved-pixels', pathStyles: { path1: { strokeWidth: 2 } } };
  const registered = ['original-svg', 'preserved-pixels'];
  const same = professionalSvgContent(layer({ type: 'vector' }), original, registered);
  assert.equal(same.appearanceAssetId, 'preserved-pixels');
  for (const patch of [{ fill: '#ff0000' }, { metadata: { pathStyles: { path1: { strokeWidth: 2, stroke: '#ff0000' } } } }]) {
    assert.throws(() => professionalSvgContent(layer({ type: 'vector', ...patch }), original, registered), /保留原始外观像素/);
  }
  assert.deepEqual(original.pathStyles, { path1: { strokeWidth: 2 } });
});

test('queued SVG paint deltas merge into the latest content without restoring earlier UI styles', () => {
  const initial = layer({ type: 'vector', metadata: { pathStyles: { path1: { fill: '#000000', strokeWidth: 1 }, path2: { fill: '#00ff00' } } } });
  // Both event handlers were created from the same original UI render. Only changed fields cross the queue.
  const first = { target: 'path1', paint: { fill: '#ff0000' } }, second = { target: 'path1', paint: { 'stroke-width': 2 } };
  const afterFill = { ...initial, ...svgPaintPatch(initial, first.target, first.paint) };
  const afterWidth = { ...afterFill, ...svgPaintPatch(afterFill, second.target, second.paint) };
  assert.deepEqual(afterWidth.metadata?.pathStyles, { path1: { fill: '#ff0000', strokeWidth: 2 }, path2: { fill: '#00ff00' } });
  const afterStroke = { ...afterWidth, ...svgPaintPatch(afterWidth, 'path1', { stroke: '#0000ff' }) };
  assert.deepEqual(afterStroke.metadata?.pathStyles, { path1: { fill: '#ff0000', strokeWidth: 2, stroke: '#0000ff' }, path2: { fill: '#00ff00' } });
  assert.deepEqual(initial.metadata?.pathStyles, { path1: { fill: '#000000', strokeWidth: 1 }, path2: { fill: '#00ff00' } });
  assert.deepEqual(svgPaintPatch(afterWidth, 'path1', { stroke: '#0000ff' }, 'css').metadata?.pathStyles, { path1: { fill: '#ff0000', 'stroke-width': 2, stroke: '#0000ff' }, path2: { fill: '#00ff00' } });
});

test('precise SVG color entry accepts only six-digit HEX and leaves unchanged values unsubmitted', () => {
  assert.equal(svgHexPaintChange(' #FF00aA ', '#20232b'), '#ff00aa');
  assert.equal(svgHexPaintChange('ff0000', '#20232b'), '#ff0000');
  assert.equal(svgHexPaintChange('#FF0000', '#ff0000'), undefined);
  for (const value of ['', '#fff', '#12345678', 'red', '#xyzxyz', 'url(data:)']) assert.throws(() => svgHexPaintChange(value, '#20232b'), /六位/);
});

test('professional candidates display the actual version-matched PNG preview and never immutable JSON content assets', () => {
  const job: ImageJob = { id: 'job', documentId: 'doc', kind: 'agent', state: 'complete', createdAt: 0, updatedAt: 0, output: { branchDocumentId: 'branch', revision: 3, previewRevision: 3, previewAssetId: 'actual-png', assetIds: ['content-json'] } };
  const branch = { ...document(), id: 'branch', schemaVersion: 3 as const };
  assert.deepEqual(candidatePreviewAssets(job, branch), ['actual-png']);
  assert.deepEqual(candidatePreviewAssets({ ...job, output: { assetIds: ['content-json'], previewUnavailable: 'RENDER_BUDGET' } }, branch), []);
  assert.deepEqual(candidatePreviewAssets({ ...job, output: { assetIds: ['content-json'] } }, branch), []);
  assert.deepEqual(candidatePreviewAssets({ ...job, kind: 'operation', output: { assetIds: ['png-a', 'png-a', null, 'png-b'] } }, document()), ['png-a', 'png-b']);
});

test('stale or unversioned preview images cannot be displayed or accepted through either surface', () => {
  const branch = { ...document(), id: 'branch', schemaVersion: 3 as const };
  const job: ImageJob = { id: 'job', documentId: 'doc', kind: 'agent', state: 'complete', createdAt: 0, updatedAt: 0, output: { branchDocumentId: branch.id, revision: 3, previewRevision: 3, previewAssetId: 'png' } };
  assert.deepEqual(candidatePreviewState(job, branch), { status: 'ready', assets: ['png'], canAccept: true });
  for (const patch of [{ previewStale: true }, { previewRevision: 2 }, { revision: 4 }, { branchDocumentId: 'foreign' }]) {
    const state = candidatePreviewState({ ...job, output: { ...job.output, ...patch } }, branch);
    assert.equal(state.status, 'stale'); assert.deepEqual(state.assets, []); assert.equal(state.canAccept, false);
  }
  assert.equal(candidatePreviewState(job, { ...branch, revision: 4 }).status, 'stale');
  for (const output of [{ previewAssetId: 'png' }, { ...job.output, previewRevision: undefined }, { ...job.output, previewUnavailable: 'failed' }]) {
    const state = candidatePreviewState({ ...job, output }, branch);
    assert.equal(state.status, 'unavailable'); assert.deepEqual(state.assets, []); assert.equal(state.canAccept, false);
  }
  assert.equal(candidatePreviewState(job).status, 'unavailable');
  assert.equal(candidatePreviewState({ ...job, state: 'running' }, branch).canAccept, false);
});

test('zero is a valid candidate preview and branch revision rather than missing evidence', () => {
  const branch = { ...document(), id: 'native-task-branch', schemaVersion: 3 as const, revision: 0 };
  const job: ImageJob = { id: 'agent-job', documentId: 'doc', kind: 'agent', state: 'complete', createdAt: 0, updatedAt: 0, output: { branchDocumentId: branch.id, revision: 0, previewRevision: 0, previewAssetId: 'frozen-preview' } };
  assert.deepEqual(candidatePreviewState(job, branch), { status: 'ready', assets: ['frozen-preview'], canAccept: true });
  assert.equal(candidatePreviewState({ ...job, output: { ...job.output, previewRevision: undefined } }, branch).canAccept, false);
  assert.equal(candidatePreviewState(job, { ...branch, revision: 1 }).canAccept, false);
});

test('a missing preview is empty only when the loaded branch proves there are no visible drawing layers', () => {
  const branch = { ...document(), id: 'branch', schemaVersion: 3 as const }, job: ImageJob = { id: 'job', documentId: 'doc', kind: 'agent', state: 'complete', createdAt: 0, updatedAt: 0, output: { branchDocumentId: 'branch', revision: 3 } };
  assert.equal(candidatePreviewState(job, branch).status, 'unavailable');
  assert.equal(candidatePreviewState(job).status, 'unavailable');
  const empty = candidatePreviewState(job, { ...branch, layers: [] });
  assert.equal(empty.status, 'empty'); assert.equal(empty.canAccept, false); assert.match(empty.message!, /版本 3/); assert.match(empty.message!, /透明 PNG/);
  assert.equal(candidatePreviewState({ ...job, output: { ...job.output, previewRevision: 3, previewAssetId: 'transparent-png' } }, { ...branch, layers: [] }).canAccept, true);
  assert.equal(candidatePreviewState(job, { ...branch, schemaVersion: 2, layers: [] }).canAccept, true, 'legacy manually created empty branches remain compatible');
  const hidden = { ...branch, layers: [layer({ id: 'parent', type: 'group', visible: false }), layer({ id: 'child', parentId: 'parent', visible: true })] };
  assert.equal(candidatePreviewState(job, hidden).status, 'empty');
  assert.equal(candidatePreviewState(job, { ...branch, layers: [layer({ id: 'child', parentId: 'missing' })] }).status, 'unavailable');
  assert.equal(candidatePreviewState({ ...job, output: { ...job.output, previewStale: true } }, { ...branch, layers: [] }).canAccept, false);
});

test('candidate card and Versions dialog both reject the same stale preview and allow a matched preview', () => {
  const branch = { ...document(), id: 'branch', schemaVersion: 3 as const }, main = { ...document(), schemaVersion: 3 as const };
  const matched: ImageJob = { id: 'job', documentId: main.id, kind: 'agent', state: 'complete', createdAt: 0, updatedAt: 0, output: { branchDocumentId: branch.id, revision: branch.revision, previewRevision: branch.revision, previewAssetId: 'actual-png' } };
  const markup = (job: ImageJob) => {
    const bridge = { document: main, rawDocument: main, capabilities: {}, branches: [branch], jobs: [job], revisions: [], busy: false, pendingCount: 0 } as unknown as Parameters<typeof LegacyImagePanels>[0]['bridge'];
    return [renderToStaticMarkup(createElement(CandidateResult, { bridge, job, onError: () => {} })), renderToStaticMarkup(createElement(LegacyImagePanels, { mode: 'versions', bridge, onError: () => {}, onClose: () => {} }))];
  };
  for (const html of markup({ ...matched, output: { ...matched.output, previewStale: true } })) {
    assert.match(html, /旧图已隐藏/); assert.match(html, /<button[^>]*disabled=""[^>]*>接受候选<\/button>/); assert.doesNotMatch(html, /src="[^"]*actual-png/);
  }
  for (const html of markup(matched)) assert.doesNotMatch(html, /<button[^>]*disabled=""[^>]*>接受候选<\/button>/);
});

test('Elements preview follows the fixed target through consecutive edits and undo without reusing its original URL', () => {
  const target = { layerId: 'a', src: 'data:image/png;base64,original' }, doc = document();
  doc.layers[0].assetId = 'original';
  const before = elementPreviewSource(doc, target);
  doc.layers[0].assetId = 'inverted'; doc.revision++;
  assert.equal(elementPreviewSource(doc, target), '/api/v3/image2/assets/inverted/content');
  doc.layers[0].assetId = 'adjusted'; doc.revision++;
  assert.equal(elementPreviewSource(doc, target), '/api/v3/image2/assets/adjusted/content');
  doc.layers[0].assetId = 'original'; doc.revision++;
  assert.equal(elementPreviewSource(doc, target), before);
  assert.equal(target.src, 'data:image/png;base64,original');
  doc.layers = [layer({ id: 'other', assetId: 'original' })];
  assert.equal(elementPreviewSource(doc, target), undefined, 'a removed target must not display a different layer or stale original');
  assert.equal(elementPreviewSource(null, { src: target.src }), target.src, 'unimported legacy canvas still has its original preview');
});
