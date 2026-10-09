'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Timeline, type TimelineState } from '@xzdarcy/react-timeline-editor';
import { Pause, Play, Scissors, SkipBack, SkipForward, Trash2, Type, Volume2, ZoomIn, ZoomOut } from 'lucide-react';
import type { AssetRevision, Sequence, SequenceClip } from '../../lib/studio/types';
import { frameTime, studioId } from '../../lib/studio/client';
import { clipVolume, splitClip, trimClip } from '../../lib/studio/sequence';
import '@xzdarcy/react-timeline-editor/dist/react-timeline-editor.css';

type Props = { sequence: Sequence; assets: AssetRevision[]; frame: number; playing: boolean; minimumFrames?: number; onFrame: (frame: number) => void; onPlaying: (playing: boolean) => void; onChange: (sequence: Sequence) => void; onError: (error: unknown) => void };
export default function SequenceTimeline({ sequence, assets, frame, playing, minimumFrames = 1, onFrame, onPlaying, onChange, onError }: Props) {
  const timeline = useRef<TimelineState>(null);
  const [selected, setSelected] = useState<string>();
  const [scaleWidth, setScaleWidth] = useState(96);
  const selectedClip = sequence.clips.find(c => c.id === selected);
  const trackIds = useMemo(() => Array.from(new Set([0, 1, 2, ...sequence.clips.map(c => c.track)])).sort((a, b) => a - b), [sequence.clips]);
  const rows = useMemo(() => trackIds.map(track => ({ id: String(track), actions: sequence.clips.filter(c => c.track === track).map(c => ({ id: c.id, start: c.startFrame / 24, end: c.endFrame / 24, effectId: c.kind, selected: c.id === selected })) })), [sequence.clips, trackIds, selected]);
  useEffect(() => { timeline.current?.setTime(frame / 24); }, [frame]);
  const update = (id: string, patch: Partial<SequenceClip>) => onChange({ ...sequence, clips: sequence.clips.map(c => c.id === id ? { ...c, ...patch } : c) });
  const modifySpan = (id: string, start: number, end: number, side: 'left' | 'right' | 'move') => {
    const clip = sequence.clips.find(c => c.id === id);
    if (!clip) return;
    try {
      const next = trimClip(clip, start * 24, end * 24, side);
      if (next.endFrame > sequence.totalFrames) throw new Error('片段超出成片总时长，请先调整总帧数');
      update(id, next);
    } catch (error) { onError(error); }
  };
  return <section className="studio-timeline" aria-label="成片时间线">
    <header className="studio-timeline-bar">
      <b>成片时间线</b><span className="studio-timecode">{frameTime(frame)} / {frameTime(sequence.totalFrames)}</span>
      <button title="第一帧" onClick={() => { onPlaying(false); onFrame(0); }}><SkipBack size={15} /></button>
      <button title={playing ? '暂停' : '播放'} onClick={() => { if (!playing && frame >= sequence.totalFrames - 1) onFrame(0); onPlaying(!playing); }}>{playing ? <Pause size={16} /> : <Play size={16} />}</button>
      <button title="最后一帧" onClick={() => { onPlaying(false); onFrame(sequence.totalFrames - 1); }}><SkipForward size={15} /></button>
      <button disabled={!selectedClip} title="在播放头分割" onClick={() => { if (!selectedClip) return; try { onChange({ ...sequence, clips: sequence.clips.flatMap(c => c.id === selectedClip.id ? splitClip(c, frame, studioId()) : [c]) }); } catch (error) { onError(error); } }}><Scissors size={16} /></button>
      <button disabled={!selectedClip} title="移除片段" onClick={() => { onChange({ ...sequence, clips: sequence.clips.filter(c => c.id !== selected) }); setSelected(undefined); }}><Trash2 size={15} /></button>
      <button onClick={() => { const id = studioId(); onChange({ ...sequence, clips: [...sequence.clips, { id, kind: 'text', track: 2, startFrame: frame, endFrame: Math.min(sequence.totalFrames, frame + 72), sourceIn: 0, text: '输入画面文字', volume: 1, fadeIn: 0, fadeOut: 0, x: 0.5, y: 0.82, fontSize: 48, color: '#ffffff' }] }); setSelected(id); }}><Type size={15} /> 文字</button>
      <span className="studio-spacer" />
      <label>总帧数 <input aria-label="成片总帧数" type="number" min={minimumFrames} max={86400} defaultValue={sequence.totalFrames} key={sequence.totalFrames} onBlur={e => { const value = Number(e.target.value); const lower = Math.max(minimumFrames, 1, ...sequence.clips.map(c => c.endFrame)); if (!Number.isInteger(value) || value < lower) { e.target.value = String(sequence.totalFrames); onError(new Error(`总帧数至少为 ${lower}，请先裁短已有镜头与动画`)); return; } onChange({ ...sequence, totalFrames: value }); if (frame >= value) onFrame(value - 1); }} /></label>
      <button title="缩小时间线" onClick={() => setScaleWidth(w => Math.max(36, w - 24))}><ZoomOut size={15} /></button>
      <button title="放大时间线" onClick={() => setScaleWidth(w => Math.min(240, w + 24))}><ZoomIn size={15} /></button>
    </header>
    <div className="studio-timeline-body">
      <div className="studio-track-labels"><span>24 fps</span>{trackIds.map(t => <div key={t}>{t === 0 ? '画面' : t === 1 ? '声音' : t === 2 ? '文字' : `轨道 ${t + 1}`}</div>)}</div>
      <Timeline ref={timeline} editorData={rows} effects={{ video: { id: 'video', name: '视频' }, audio: { id: 'audio', name: '音频' }, text: { id: 'text', name: '文字' } }} scale={1} scaleSplitCount={24} scaleWidth={scaleWidth} minScaleCount={Math.max(5, Math.ceil(sequence.totalFrames / 24) + 1)} maxScaleCount={Math.max(5, Math.ceil(sequence.totalFrames / 24) + 1)} rowHeight={38} gridSnap dragLine autoScroll style={{ width: '100%', height: Math.max(165, trackIds.length * 38 + 42) }}
        onCursorDrag={time => { onPlaying(false); onFrame(Math.max(0, Math.min(sequence.totalFrames - 1, Math.round(time * 24)))); }}
        onClickTimeArea={time => { onPlaying(false); onFrame(Math.max(0, Math.min(sequence.totalFrames - 1, Math.round(time * 24)))); return true; }}
        onClickActionOnly={(_, { action }) => setSelected(action.id)}
        onActionMoveEnd={({ action, start, end }) => modifySpan(action.id, start, end, 'move')}
        onActionResizeEnd={({ action, start, end, dir }) => modifySpan(action.id, start, end, dir)}
        onChange={() => { /* Domain changes are committed by the move/resize transaction. */ }}
        getActionRender={action => { const clip = sequence.clips.find(c => c.id === action.id)!; const asset = assets.find(a => a.id === clip.assetId); return <div className={`studio-clip studio-clip-${clip.kind}`} title={asset?.name || clip.text}>{clip.kind === 'audio' && <Volume2 size={12} />}<span>{clip.text || asset?.name || '素材'}</span></div>; }} />
    </div>
    {selectedClip && <div className="studio-clip-inspector">
      <label>轨道 <input type="number" min={0} max={15} value={selectedClip.track} onChange={e => update(selectedClip.id, { track: Math.max(0, Math.round(Number(e.target.value))) })} /></label>
      <label>入点 <input type="number" min={0} value={selectedClip.sourceIn} onChange={e => update(selectedClip.id, { sourceIn: Math.max(0, Math.round(Number(e.target.value))) })} /></label>
      {selectedClip.kind !== 'text' && <><label>音量 <input type="number" min={0} max={1} step={0.05} value={selectedClip.volume} onChange={e => update(selectedClip.id, { volume: Math.max(0, Math.min(1, Number(e.target.value))) })} /></label><label>淡入帧 <input type="number" min={0} value={selectedClip.fadeIn} onChange={e => update(selectedClip.id, { fadeIn: Math.max(0, Number(e.target.value)) })} /></label><label>淡出帧 <input type="number" min={0} value={selectedClip.fadeOut} onChange={e => update(selectedClip.id, { fadeOut: Math.max(0, Number(e.target.value)) })} /></label></>}
      {selectedClip.kind === 'text' && <><textarea aria-label="画面文字" value={selectedClip.text} onChange={e => update(selectedClip.id, { text: e.target.value })} /><label>字号 <input type="number" min={8} value={selectedClip.fontSize || 48} onChange={e => update(selectedClip.id, { fontSize: Number(e.target.value) })} /></label><label>横向 <input type="number" min={0} max={1} step={0.05} value={selectedClip.x ?? 0.5} onChange={e => update(selectedClip.id, { x: Number(e.target.value) })} /></label><label>纵向 <input type="number" min={0} max={1} step={0.05} value={selectedClip.y ?? 0.82} onChange={e => update(selectedClip.id, { y: Number(e.target.value) })} /></label><input aria-label="文字颜色" type="color" value={selectedClip.color || '#ffffff'} onChange={e => update(selectedClip.id, { color: e.target.value })} /></>}
    </div>}
  </section>;
}

function TimedMedia({ clip, asset, frame, playing, audioOnly }: { clip: SequenceClip; asset: AssetRevision; frame: number; playing: boolean; audioOnly?: boolean }) {
  const media = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  useEffect(() => {
    const element = media.current;
    if (!element) return;
    const time = (clip.sourceIn + frame - clip.startFrame) / 24;
    const sync = () => { if (Math.abs(element.currentTime - time) > (playing ? 2 / 24 : 0.001)) element.currentTime = Math.max(0, time); element.volume = clipVolume(clip, frame); if (playing) void element.play().catch(() => {}); else element.pause(); };
    sync(); element.addEventListener('loadedmetadata', sync, { once: true });
    return () => element.removeEventListener('loadedmetadata', sync);
  }, [clip, frame, playing]);
  return audioOnly ? <audio ref={media} src={asset.url} preload="auto" /> : <video ref={media} src={asset.url} playsInline preload="auto" />;
}
export function SequencePreview({ sequence, assets, frame, playing, aspect }: { sequence: Sequence; assets: AssetRevision[]; frame: number; playing: boolean; aspect: string }) {
  const active = sequence.clips.filter(c => c.startFrame <= frame && c.endFrame > frame).sort((a, b) => a.track - b.track);
  const video = active.filter(c => c.kind === 'video').at(-1);
  const asset = assets.find(a => a.id === video?.assetId);
  return <div className="studio-sequence-preview" style={{ aspectRatio: aspect.replace(':', '/') }}>
    {video && asset ? <TimedMedia key={video.id} clip={video} asset={asset} frame={frame} playing={playing} /> : <div className="studio-preview-empty">此帧尚未放入视频素材</div>}
    {active.filter(c => c.kind === 'audio').map(c => { const a = assets.find(a => a.id === c.assetId); return a ? <TimedMedia key={c.id} clip={c} asset={a} frame={frame} playing={playing} audioOnly /> : null; })}
    {active.filter(c => c.kind === 'text').map(c => <div key={c.id} className="studio-text-overlay" style={{ left: `${(c.x ?? 0.5) * 100}%`, top: `${(c.y ?? 0.82) * 100}%`, color: c.color || '#fff', fontSize: `${(c.fontSize || 48) / (aspect === '9:16' ? 7.2 : 12.8)}cqw` }}>{c.text}</div>)}
  </div>;
}
