import type { SequenceClip } from './types';

export function splitClip(clip: SequenceClip, frame: number, rightId: string): SequenceClip[] {
  if (!Number.isInteger(frame) || frame <= clip.startFrame || frame >= clip.endFrame) throw new Error('请把播放头放在片段内部');
  const offset = frame - clip.startFrame;
  return [
    { ...clip, endFrame: frame, fadeOut: 0 },
    { ...clip, id: rightId, startFrame: frame, sourceIn: clip.sourceIn + offset, fadeIn: 0 },
  ];
}

export function trimClip(clip: SequenceClip, startFrame: number, endFrame: number, side: 'left' | 'right' | 'move'): SequenceClip {
  const start = Math.max(0, Math.round(startFrame));
  const end = Math.max(start + 1, Math.round(endFrame));
  const sourceIn = side === 'left' ? clip.sourceIn + start - clip.startFrame : clip.sourceIn;
  if (sourceIn < 0) throw new Error('已到素材起点，不能继续向前裁切');
  return { ...clip, startFrame: start, endFrame: end, sourceIn, fadeIn: Math.min(clip.fadeIn, end - start), fadeOut: Math.min(clip.fadeOut, end - start) };
}

export function clipVolume(clip: SequenceClip, frame: number): number {
  if (frame < clip.startFrame || frame >= clip.endFrame) return 0;
  const incoming = clip.fadeIn > 0 ? Math.min(1, (frame - clip.startFrame) / clip.fadeIn) : 1;
  const outgoing = clip.fadeOut > 0 ? Math.min(1, (clip.endFrame - frame) / clip.fadeOut) : 1;
  return Math.max(0, Math.min(1, clip.volume * incoming * outgoing));
}
