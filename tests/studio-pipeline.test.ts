import test from 'node:test';
import assert from 'node:assert/strict';
import type { AssetRevision, StudioJob, StudioProject } from '../lib/studio/types';
import { isComparison, jobAssetIds, jobOutputStamp, renderBackends, applyVideoVersion, videoFamily } from '../lib/studio/pipeline';
import { mergeProject } from '../lib/studio/merge';

const asset = (id: string, parentId?: string, metadata = {}): AssetRevision => ({ id, parentId, name: id, kind: 'video', hash: id, mime: 'video/mp4', url: `/api/v3/assets/${id}/content`, bytes: 100, createdAt: '2026-10-02', metadata: { frames: 1440, ...metadata } });
const project = (): StudioProject => ({ schemaVersion: 3, id: 'p', name: 'fixture', revision: 1, fps: 24, totalFrames: 1440, aspect: '16:9', createdAt: '', updatedAt: '', nodes: [{ id: 'n', type: 'video', x: 0, y: 0, label: 'original', assetId: 'original' }], edges: [], scenes: [], shots: [], assets: [asset('original'), asset('enhanced', 'original'), asset('comparison', 'original', { role: 'comparison' }), asset('other')], sequence: { id: 's', name: 's', fps: 24, totalFrames: 1440, clips: [{ id: 'c', assetId: 'original', kind: 'video', track: 0, startFrame: 200, endFrame: 344, sourceIn: 48, volume: .15, fadeIn: 12, fadeOut: 4 }, { id: 'other-c', assetId: 'other', kind: 'video', track: 0, startFrame: 400, endFrame: 544, sourceIn: 0, volume: 1, fadeIn: 0, fadeOut: 0 }] } });

test('failed later stage refreshes partial outputs and a later recovery has a distinct stamp', () => {
  const job: StudioJob = { id: 'j', projectId: 'p', kind: 'render', state: 'running', progress: .2, createdAt: '', updatedAt: '' };
  assert.equal(jobOutputStamp(job), undefined);
  job.state = 'failed'; job.outputAssetIds = ['render']; job.partialAssets = [{ ...asset('render'), role: 'original', backend: 'three-webgl' }];
  const failed = jobOutputStamp(job); assert.ok(failed); assert.deepEqual(jobAssetIds(job), ['render']);
  job.state = 'complete'; job.outputAssetIds.push('enhanced');
  assert.notEqual(jobOutputStamp(job), failed); assert.deepEqual(jobAssetIds(job), ['render', 'enhanced']);
  assert.deepEqual(renderBackends('both'), ['three-webgl', 'remotion']);
});

test('using a version preserves original, clip range, source in, mixing and unrelated media', () => {
  const before = project(), after = applyVideoVersion(before, 'original', 'enhanced');
  assert.equal(before.nodes[0].assetId, 'original'); assert.equal(after.nodes[0].assetId, 'enhanced');
  assert.deepEqual(after.assets, before.assets);
  assert.deepEqual(after.sequence.clips[0], { ...before.sequence.clips[0], assetId: 'enhanced' });
  assert.deepEqual(after.sequence.clips[1], before.sequence.clips[1]);
  assert.throws(() => applyVideoVersion(before, 'original', 'other'), /同一个来源/);
  assert.throws(() => applyVideoVersion(before, 'original', 'comparison'), /单画面/);
  before.assets[1].metadata!.frames = 100;
  assert.throws(() => applyVideoVersion(before, 'original', 'enhanced'), /长度不足/);
});

test('same-scene render group includes both exporters and their derived versions without merging unrelated videos', () => {
  const p = project(); p.assets[0].metadata!.renderGroupId = 'group'; p.assets.push(asset('remotion', undefined, { renderGroupId: 'group' }), asset('remotion-enhanced', 'remotion'));
  assert.deepEqual(videoFamily(p, p.assets[0]).map(a => a.id), ['original', 'enhanced', 'comparison', 'remotion', 'remotion-enhanced']);
  assert.equal(isComparison(p.assets[2]), true);
});

test('partial job assets survive an unrelated local draft merge and readonly access remains server-owned', () => {
  const base = project(), local = structuredClone(base), remote = structuredClone(base);
  local.nodes[0].label = 'my unsaved label'; remote.assets.push(asset('partial', 'original')); remote.revision = 2;
  remote.access = { readOnly: true, canCopy: true }; local.access = { readOnly: false };
  const result = mergeProject(base, local, remote);
  assert.equal(result.nodes[0].label, 'my unsaved label'); assert.equal(result.assets.at(-1)?.id, 'partial'); assert.equal(result.access?.readOnly, true);
});

 test('server scene revision zero remains zero after merging a background task result', () => {
  const base = project(); base.scenes = [{ id: 'new', name: 'new', revision: 0, units: 'meters', up: 'Y', objects: [], cameras: [], activeCameraId: '', background: '#111111', groundColor: '#111111', showGround: false, exposure: 1, tracks: [], clips: [] }];
  const remote = structuredClone(base); remote.assets.push(asset('extra'));
  assert.equal(mergeProject(base, base, remote).scenes[0].revision, 0);
});
