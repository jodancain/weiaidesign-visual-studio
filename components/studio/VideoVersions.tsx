'use client';
import { useEffect, useRef, useState } from 'react';
import { Download, X } from 'lucide-react';
import type { AssetRevision } from '../../lib/studio/types';
import { isComparison, videoBaseline, sourceAssetId, effectsCreatedLabel } from '../../lib/studio/pipeline';

export function versionLabel(asset: AssetRevision, sourceId: string, historicalAncestor = false) {
  if (historicalAncestor) return asset.name;
  if (isComparison(asset)) return asset.metadata?.effectsProgramHash || asset.source === 'effects-compositor' ? `特效前后同步对比${effectsCreatedLabel(asset)}` : '同步并排对比';
  if (asset.id === sourceId) return '原版';
  if (asset.metadata?.role === 'effects' || asset.source === 'effects-compositor') return `Opus 特效版${effectsCreatedLabel(asset)}`;
  if (asset.metadata?.role === 'enhanced' || asset.source === 'dlss-nr') return 'DLSS 5 实验版';
  if (asset.metadata?.backend === 'remotion') return 'Remotion';
  if (asset.metadata?.backend === 'three-webgl') return 'Three';
  return String(asset.metadata?.label || asset.name);
}

export default function VideoVersions({ assets, sourceId, onClose, onUse }: { assets: AssetRevision[]; sourceId: string; onClose: () => void; onUse: (asset: AssetRevision) => void }) {
  const [selectedId, setSelectedId] = useState(sourceId);
  const originalId = assets.find(asset => asset.id === sourceId) ? videoBaseline({ assets }, assets.find(asset => asset.id === sourceId)!).id : sourceId;
  const ancestors = new Set<string>([originalId]);
  let ancestor = assets.find(asset => asset.id === originalId);
  while (ancestor) {
    const parentId = sourceAssetId(ancestor), parent = assets.find(asset => asset.id === parentId);
    if (!parent || ancestors.has(parent.id)) break;
    ancestors.add(parent.id); ancestor = parent;
  }
  ancestors.delete(originalId);
  const label = (asset: AssetRevision) => versionLabel(asset, originalId, ancestors.has(asset.id));
  const [loading, setLoading] = useState(true), [error, setError] = useState('');
  const media = useRef<HTMLVideoElement>(null);
  const pending = useRef<{ time: number; resume: boolean; revision: number } | null>({ time: 0, resume: false, revision: 0 });
  const revision = useRef(0), timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selected = assets.find(asset => asset.id === selectedId) || assets[0];
  useEffect(() => {
    timer.current = setTimeout(() => { setLoading(false); setError('载入超过 60 秒，请重试当前版本或切回原版。'); }, 60_000);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [selectedId]);
  if (!selected) return null;
  const matches = () => media.current?.currentSrc === new URL(selected.url, location.href).href;
  const finish = () => {
    const video = media.current, intent = pending.current;
    if (!video || !intent || !matches() || video.seeking || video.readyState < 2 || Math.abs(video.currentTime - intent.time) > .15) return;
    pending.current = null; if (timer.current) clearTimeout(timer.current); setLoading(false);
    if (intent.resume) void video.play().catch(() => { if (intent.revision === revision.current) setError('已保留播放位置，请点击播放继续。'); });
  };
  const select = (asset: AssetRevision) => {
    const video = media.current;
    pending.current = { time: pending.current?.time ?? video?.currentTime ?? 0, resume: pending.current?.resume ?? (!!video && !video.paused && !video.ended), revision: ++revision.current };
    video?.pause(); setLoading(true); setError('');
    if (asset.id === selectedId) { if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => { setLoading(false); setError('载入超过 60 秒，请重试或切回原版。'); }, 60_000); video?.load(); }
    else setSelectedId(asset.id);
  };
  return <div className="studio-modal" role="dialog" aria-modal="true" aria-label="视频版本对比"><div className="studio-modal-card studio-player-modal studio-version-player">
    <header><b>视频版本</b><button aria-label="关闭版本对比" onClick={onClose}><X size={18} /></button></header>
    <div className="studio-version-buttons" role="group" aria-label="选择视频版本">{assets.map(asset => <button key={asset.id} aria-pressed={asset.id === selected.id} onClick={() => select(asset)}>{label(asset)}</button>)}</div>
    <video ref={media} src={selected.url} playsInline controls preload="auto" aria-label={label(selected)} aria-busy={loading}
      onLoadedMetadata={() => { const video = media.current; if (!video || !pending.current || !matches()) return; pending.current.time = Math.min(Math.max(0, pending.current.time), Math.max(0, video.duration - 1 / 24)); video.currentTime = pending.current.time; finish(); }}
      onSeeked={finish} onCanPlay={finish}
      onError={() => { if (!matches()) return; if (timer.current) clearTimeout(timer.current); setLoading(false); setError('此版本暂时无法播放，可重新选择重试，或切回原版。'); }} />
    <div className="studio-version-status" role="status">{loading ? '正在载入并恢复播放位置…' : isComparison(selected) ? '单条视频同步对照 · 不会替换项目画幅' : selected.name}</div>
    {error && <p className="studio-version-error" role="alert">{error}</p>}
    <footer><span>后期处理可能改变风格；源视频始终保留，使用版本前不改剪辑。</span><a href={selected.url} download={selected.name}><Download size={15} />下载当前版本</a>{!isComparison(selected) && selected.id !== sourceId && <button className="studio-primary" onClick={() => onUse(selected)}>使用此版本</button>}</footer>
  </div></div>;
}
