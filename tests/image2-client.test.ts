import test from 'node:test';
import assert from 'node:assert/strict';
import { ImageCommandQueue, applyDraft, type QueuedBatch, type QueueStorage } from '../lib/image2/queue';
import { localToDocument, documentToLocal, layerPixelPoint, capability } from '../lib/image2/geometry';
import type { ImageDocument, ImageLayer } from '../lib/image2/types';
import { groupLayerCommands, ungroupLayerCommands } from '../lib/image2/grouping';
import { orderedLayers, reorderSiblingCommands } from '../lib/image2/stacking';

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
