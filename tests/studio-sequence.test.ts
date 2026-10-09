import test from 'node:test';
import assert from 'node:assert/strict';
import { splitClip, trimClip, clipVolume } from '../lib/studio/sequence';
import type { SequenceClip } from '../lib/studio/types';

const clip: SequenceClip = { id: 'clip', kind: 'video', track: 0, startFrame: 58, endFrame: 116, assetId: 'asset', sourceIn: 24, volume: 0.8, fadeIn: 12, fadeOut: 6 };
test('split preserves source continuity and original outer fades', () => {
  const [left, right] = splitClip(clip, 80, 'second');
  assert.equal(left.endFrame, 80); assert.equal(right.startFrame, 80);
  assert.equal(right.sourceIn, 46); assert.equal(left.fadeIn, 12); assert.equal(right.fadeOut, 6);
  assert.equal(left.fadeOut, 0); assert.equal(right.fadeIn, 0);
  assert.throws(() => splitClip(clip, 116, 'bad'));
});
test('left trimming advances media source, moving does not', () => {
  assert.equal(trimClip(clip, 70, 116, 'left').sourceIn, 36);
  assert.equal(trimClip(clip, 70, 128, 'move').sourceIn, 24);
  assert.throws(() => trimClip(clip, 0, 116, 'left'));
});
test('preview envelope matches frame based fade plan', () => {
  assert.equal(clipVolume(clip, 58), 0);
  assert.equal(clipVolume(clip, 64), 0.4);
  assert.equal(clipVolume(clip, 80), 0.8);
  assert.equal(clipVolume(clip, 113), 0.4);
  assert.equal(clipVolume(clip, 116), 0);
});
