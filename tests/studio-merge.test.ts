import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeProject, authoringEqual } from '../lib/studio/merge';
import type { StudioProject } from '../lib/studio/types';
const fixture = (): StudioProject => ({
  schemaVersion: 3, id: 'project', revision: 1, name: 'Story', createdAt: 'now', updatedAt: 'now', fps: 24, aspect: '16:9', totalFrames: 240,
  assets: [], edges: [], nodes: [{ id: 'node', type: 'text', x: 0, y: 0, label: 'Text', text: 'before' }],
  scenes: [{ id: 'scene', name: 'Stage', revision: 1, units: 'meters', up: 'Y', objects: [], cameras: [], activeCameraId: 'camera', background: '#000000', groundColor: '#000000', showGround: true, exposure: 1, tracks: [], clips: [] }],
  shots: [{ id: 'shot', name: 'Shot', sceneId: 'scene', cameraId: 'camera', startFrame: 0, endFrame: 240, prompt: 'before', subjectIds: [], takes: [] }],
  sequence: { id: 'sequence', name: 'Main', fps: 24, totalFrames: 240, clips: [] },
});
test('a completing generation preserves unsaved canvas edits and all server-owned media', () => {
  const base = fixture(), local = structuredClone(base), remote = structuredClone(base);
  local.nodes[0].x = 120; local.nodes[0].text = 'local draft'; remote.revision = 2; remote.updatedAt = 'later';
  remote.assets.push({ id: 'asset', name: 'shot.mp4', kind: 'video', mime: 'video/mp4', hash: 'hash', url: '/api/v3/assets/asset/content', bytes: 1, createdAt: 'later' });
  remote.shots[0].takes.push({ id: 'take', assetId: 'asset', jobId: 'job', model: 'model', referenceMode: 'first-frame' });
  remote.shots[0].approval = { hash: 'approved', at: 'now' };
  const merged = mergeProject(base, local, remote);
  assert.equal(merged.nodes[0].text, 'local draft'); assert.equal(merged.nodes[0].x, 120);
  assert.deepEqual(merged.assets, remote.assets); assert.deepEqual(merged.shots[0].takes, remote.shots[0].takes);
  assert.equal(merged.revision, 2); assert.equal(merged.shots[0].approval?.hash, 'approved');
  assert.equal(authoringEqual(merged, remote), false);
});
test('edits made while a save is in flight survive its older response', () => {
  const sent = fixture(), later = structuredClone(sent), saved = structuredClone(sent);
  later.nodes[0].text = 'typed during save'; saved.revision = 3; saved.scenes[0].revision = 2;
  const merged = mergeProject(sent, later, saved);
  assert.equal(merged.nodes[0].text, 'typed during save'); assert.equal(merged.scenes[0].revision, 2);
});
test('independent remote changes merge, conflicting edits and delete-versus-edit do not', () => {
  const base = fixture(), local = structuredClone(base), remote = structuredClone(base);
  local.nodes[0].text = 'local'; remote.shots[0].prompt = 'remote';
  assert.equal(mergeProject(base, local, remote).shots[0].prompt, 'remote');
  remote.nodes[0].text = 'remote'; assert.throws(() => mergeProject(base, local, remote), /冲突修改/);
  remote.nodes = []; assert.throws(() => mergeProject(base, local, remote), /冲突修改/);
});
test('background metadata alone is not an authored edit and removed approvals stay removed', () => {
  const base = fixture(); base.shots[0].approval = { hash: 'old', at: 'now' };
  const remote = structuredClone(base); remote.revision = 8; delete remote.shots[0].approval;
  assert.equal(authoringEqual(base, remote), true);
  assert.equal(mergeProject(base, base, remote).shots[0].approval, undefined);
});
