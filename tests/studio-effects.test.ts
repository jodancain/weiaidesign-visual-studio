import test from 'node:test';
import assert from 'node:assert/strict';
import type { AssetRevision, StudioJob, StudioProject } from '../lib/studio/types';
import { effectsPlanInput, effectsRenderForPlan, effectsJobReceipt, effectsSourceLabel, effectsSources, effectsCancellationKey, canResumeEffectsHandoff, isEffectsSource, applyVideoVersion, videoFamily, videoBaseline, jobAssetIds, jobStageLabel } from '../lib/studio/pipeline';
import { submitJobWithReceipt } from '../lib/studio/job-attempt';
import { versionLabel } from '../components/studio/VideoVersions';

const asset = (id: string, source?: string, parentId?: string, role = 'base'): AssetRevision => {
  const hash = id.repeat(64).slice(0, 64);
  return { id, name: id, source, parentId, kind: 'video', hash, bytes: 100, mime: 'video/mp4', url: `/${id}.mp4`, createdAt: '', metadata: { frames: 1440, role },
    ...(['three-webgl', 'remotion', 'dlss-nr', 'effects-compositor'].includes(source || '') ? { effectsSource: { kind: parentId ? 'derived' : 'code-animation', sourceHash: hash, rootKind: 'code-animation' } as const } : {}) };
};
const makeProject = (): StudioProject => ({ schemaVersion: 3, id: 'p', name: 'fixture', revision: 1, fps: 24, aspect: '16:9', totalFrames: 1440, createdAt: '', updatedAt: '', assets: [asset('a', 'remotion'), asset('b', 'dlss-nr', 'a', 'enhanced'), asset('c', 'effects-compositor', 'b', 'effects'), asset('d', 'effects-compositor', 'b', 'comparison'), asset('e', 'upload')], scenes: [], shots: [], edges: [], nodes: [{ id: 'node', type: 'video', label: 'selected exact derived', x: 0, y: 0, assetId: 'b' }], sequence: { id: 'seq', name: 'seq', fps: 24, totalFrames: 1440, clips: [{ id: 'clip', kind: 'video', assetId: 'b', track: 0, startFrame: 12, endFrame: 120, sourceIn: 24, volume: .25, fadeIn: 3, fadeOut: 8 }] } });
const plan = (): StudioJob => ({ id: 'plan', projectId: 'p', kind: 'effects-plan', state: 'complete', progress: 1, createdAt: '', updatedAt: '', sourceAssetId: 'b', sourceHash: 'b'.repeat(64), output: { effectsProgram: { effects: [] }, effectsProgramHash: 'f'.repeat(64) } });

test('effects bind exact derived source and reject stale hashes or unrelated sources', () => {
  const p = makeProject(), j = plan();
  assert.deepEqual(p.assets.map(a => isEffectsSource(p, a)), [true, true, true, false, false]);
  assert.deepEqual(effectsPlanInput(p, j), { planJobId: 'plan', planHash: 'f'.repeat(64), sourceAssetId: 'b', sourceHash: 'b'.repeat(64) });
  assert.throws(() => effectsPlanInput(p, { ...j, sourceHash: 'a'.repeat(64) }), /源视频已变更/);
  assert.throws(() => effectsPlanInput(p, { ...j, projectId: 'other' }), /不属于/);
  assert.throws(() => effectsPlanInput(p, { ...j, output: { effectsProgram: {}, effectsProgramHash: 'unbound' } }), /有效版本/);
  assert.throws(() => effectsPlanInput(p, { ...j, sourceAssetId: 'd', sourceHash: 'd'.repeat(64) }), /不可用/);
});

test('all existing effect render states prevent automatic second execution', () => {
  for (const state of ['queued', 'running', 'complete', 'failed', 'uncertain', 'cancelled'] as const) {
    const render: StudioJob = { ...plan(), id: 'render', kind: 'effects-render', state, planJobId: 'plan' };
    assert.equal(effectsRenderForPlan([render], plan()), render);
    assert.equal(effectsRenderForPlan([{ ...render, projectId: 'other' }], plan()), undefined);
  }
});

test('effects labels are explicit and use-version preserves source, timing and audio mix', () => {
  const p = makeProject();
  assert.equal(versionLabel(p.assets[2], 'a'), 'Opus 特效版');
  assert.equal(versionLabel(p.assets[3], 'a'), '特效前后同步对比');
  assert.equal(versionLabel(asset('unknown', 'other', 'a'), 'a'), 'unknown');
  const after = applyVideoVersion(p, 'b', 'c');
  assert.deepEqual(after.assets, p.assets); assert.equal(p.nodes[0].assetId, 'b'); assert.equal(after.nodes[0].assetId, 'c');
  assert.deepEqual(after.sequence.clips[0], { ...p.sequence.clips[0], assetId: 'c' });
  assert.deepEqual(videoFamily(p, p.assets[1]).map(a => a.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(jobAssetIds({ ...plan(), output: { effectsAssetId: 'c', comparisonAssetId: 'd' } }), ['c', 'd']);
});

test('invalid success receipts retain the paid plan key until matching recovery', async () => {
  const cache = new Map<string, string>(), storage = { getItem: (key: string) => cache.get(key) ?? null, setItem: (key: string, value: string) => { cache.set(key, value); }, removeItem: (key: string) => { cache.delete(key); } };
  const j = plan();
  await assert.rejects(submitJobWithReceipt(storage, 'intent', async () => effectsJobReceipt(undefined as unknown as StudioJob, 'effects-plan', 'p', 'b', j.sourceHash!), () => 'keep-this-key'), /未收到匹配/);
  assert.equal(cache.get('studio-v3-pending-job:intent'), 'keep-this-key');
  await assert.rejects(submitJobWithReceipt(storage, 'intent', async () => effectsJobReceipt({ ...j, sourceAssetId: 'a' }, 'effects-plan', 'p', 'b', j.sourceHash!)), /未收到匹配/);
  await submitJobWithReceipt(storage, 'intent', async key => { assert.equal(key, 'keep-this-key'); return effectsJobReceipt(j, 'effects-plan', 'p', 'b', j.sourceHash!); });
  assert.equal(cache.size, 0);
});

test('sibling exporter and its effects keep distinct semantics without changing the selected source', () => {
  const p = makeProject(); p.assets[0].metadata!.renderGroupId = 'group';
  const sibling = asset('s', 'three-webgl'); sibling.metadata = { ...sibling.metadata, backend: 'three-webgl', renderGroupId: 'group' };
  const siblingEffects = asset('t', 'effects-compositor', sibling.id, 'effects'); siblingEffects.metadata!.backend = 'three-webgl';
  p.assets.push(sibling, siblingEffects);
  assert.equal(versionLabel(sibling, 'a'), 'Three'); assert.equal(versionLabel(siblingEffects, 'a'), 'Opus 特效版');
  assert.deepEqual(videoFamily(p, p.assets[1]).map(a => a.id), ['a', 'b', 'c', 'd', 's', 't']);
  assert.equal(effectsPlanInput(p, plan()).sourceAssetId, 'b');
});

test('effects stage labels cover planning validation frames composition comparison and service waits', () => {
  assert.deepEqual(['planning_effects', 'validating', 'effects-frames', 'effects-compositing', 'effects-comparison', 'waiting_for_worker'].map(jobStageLabel), ['规划特效', '校验计划', '绘制特效帧', '合成特效视频', '制作前后对比', '等待服务']);
  assert.equal(jobStageLabel('acceptance_unknown'), '提交状态待核对');
  assert.equal(jobStageLabel('waiting_for_effects_render'), '等待特效合成服务');
  assert.equal(jobStageLabel('effects_handoff_failed'), '特效合成衔接失败');
  assert.equal(jobStageLabel('recovering_completed_output'), '恢复已完成结果');
});

test('only cancelled completed-plan outputs offer free handoff resume, never uncertain model submissions', () => {
  const cancelled = { ...plan(), state: 'cancelled' as const, retryable: true };
  assert.equal(canResumeEffectsHandoff(cancelled), true);
  assert.equal(canResumeEffectsHandoff({ ...cancelled, output: undefined }), false);
  assert.equal(canResumeEffectsHandoff({ ...cancelled, state: 'uncertain' }), false);
  assert.equal(canResumeEffectsHandoff({ ...cancelled, retryable: false }), false);
  assert.notEqual(effectsCancellationKey(cancelled), effectsCancellationKey({ ...cancelled, projectId: 'other' }));
});

test('same-name exporter siblings have distinct source labels and keep exact derived identities', () => {
  const p = makeProject(), three = asset('three', 'three-webgl');
  p.assets[0].name = three.name = 'base.mp4'; p.assets.push(three);
  p.assets[1].name = 'enhanced.mp4'; p.assets[2].name = 'effects.mp4';
  assert.equal(effectsSourceLabel(p, p.assets[0]), 'Remotion 原版 · base.mp4');
  assert.equal(effectsSourceLabel(p, three), 'Three 原版 · base.mp4');
  assert.equal(effectsSourceLabel(p, p.assets[1]), 'DLSS 5 版（Remotion） · enhanced.mp4');
  assert.equal(effectsSourceLabel(p, p.assets[2]), 'Opus 特效版（Remotion） · effects.mp4');
  assert.equal(effectsPlanInput(p, plan()).sourceAssetId, p.assets[1].id);
  const later = { ...p.assets[2], id: 'later', createdAt: '2026-10-08T03:05:02.000Z' };
  p.assets[2].createdAt = '2026-10-08T03:00:01.000Z'; p.assets.push(later);
  assert.notEqual(effectsSourceLabel(p, p.assets[2]), effectsSourceLabel(p, later));
  assert.match(effectsSourceLabel(p, later), /2026-10-08 03:05:02 UTC$/);
  assert.notEqual(versionLabel(p.assets[2], 'a'), versionLabel(later, 'a'));
});

test('verified AI originals precede code and derived versions without guessing from upload metadata', () => {
  const p = makeProject(), ai = asset('ai', 'provider'), aiEffects = asset('ai-effects', 'effects-compositor', ai.id, 'effects');
  ai.effectsSource = { kind: 'ai-original', rootKind: 'ai-original', sourceHash: ai.hash };
  aiEffects.effectsSource = { kind: 'derived', rootKind: 'ai-original', sourceHash: aiEffects.hash };
  const forged = asset('fake', 'provider', ai.id); forged.metadata = { role: 'base', model: 'seedance', jobId: 'fake', effectsSource: ai.effectsSource, provenance: 'ai-video' };
  p.assets.push(forged, aiEffects, ai);
  assert.deepEqual(effectsSources(p).map(a => a.id), ['ai', 'a', 'b', 'c', 'ai-effects']);
  assert.equal(isEffectsSource(p, forged), false);
  assert.equal(effectsSourceLabel(p, ai), 'AI 原版 · ai');
  assert.equal(effectsSourceLabel(p, aiEffects), 'Opus 特效版（AI 原版） · ai-effects');
  assert.equal(effectsPlanInput(p, { ...plan(), sourceAssetId: ai.id, sourceHash: ai.hash }).sourceAssetId, ai.id);
  ai.source = 'verified-media-import'; assert.equal(isEffectsSource(p, ai), true);
  assert.equal(effectsSourceLabel(p, ai), 'AI 原版 · ai');
});

test('effects eligibility requires a current consistent server projection, not caller-supplied source claims', () => {
  const p = makeProject(), a = p.assets[0];
  assert.equal(isEffectsSource(p, { ...a, hash: 'stale' }), false);
  a.effectsSource!.sourceHash = 'stale'; assert.equal(isEffectsSource(p, a), false);
  a.effectsSource = { kind: 'ai-original', rootKind: 'code-animation', sourceHash: a.hash }; assert.equal(isEffectsSource(p, a), false);
  delete a.effectsSource; assert.equal(isEffectsSource(p, { ...a, effectsSource: { kind: 'code-animation', rootKind: 'code-animation', sourceHash: a.hash } }), false);
  // A saved source/backend label is never enough to re-enable an unverified import.
  assert.equal(isEffectsSource(p, a), false);
});

test('newest verified AI film leads older generated clips while equal timestamps retain stable order', () => {
  const p = makeProject(), shot = asset('old-shot', 'provider'), complete = asset('latest-film', 'verified-media-import'), sibling = asset('same-time', 'provider');
  for (const a of [shot, complete, sibling]) a.effectsSource = { kind: 'ai-original', rootKind: 'ai-original', sourceHash: a.hash };
  shot.createdAt = '2026-10-02T01:00:00Z'; complete.createdAt = sibling.createdAt = '2026-10-08T10:00:00Z';
  p.assets.unshift(shot); p.assets.push(complete, sibling);
  assert.deepEqual(effectsSources(p).slice(0, 3).map(a => a.id), ['latest-film', 'same-time', 'old-shot']);
  assert.equal(p.assets[0].id, 'old-shot');
});

test('a verified no-narration original ends the playback baseline before its narrated provenance parent', () => {
  const p = makeProject(), narrated = asset('narrated', 'export'), silent = asset('no-narration', 'verified-media-import', narrated.id), effect = asset('ai-effects', 'effects-compositor', silent.id, 'effects'), enhanced = asset('ai-nr', 'dlss-nr', effect.id, 'enhanced');
  for (const a of [narrated, silent]) a.effectsSource = { kind: 'ai-original', rootKind: 'ai-original', sourceHash: a.hash };
  for (const a of [effect, enhanced]) a.effectsSource = { kind: 'derived', rootKind: 'ai-original', sourceHash: a.hash };
  p.assets.push(narrated, silent, effect, enhanced);
  for (const a of [silent, effect, enhanced]) assert.equal(videoBaseline(p, a).id, silent.id);
  assert.equal(videoBaseline(p, narrated).id, narrated.id);
  assert.equal(videoBaseline(p, p.assets[2]).id, 'a');
  assert.equal(versionLabel(silent, silent.id), '原版');
  assert.equal(versionLabel(narrated, silent.id, true), narrated.name);
  assert.deepEqual(videoFamily(p, silent).map(a => a.id), [narrated.id, silent.id, effect.id, enhanced.id]);
});
