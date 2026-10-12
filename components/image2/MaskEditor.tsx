'use client';
import { useEffect, useRef, useState } from 'react';
import { assetUrl } from '../../lib/image2/client';
import { maskPixelsForCanvas, savedMaskReferences, visibilityBackdrop } from '../../lib/image2/masks';
import type { ImageLayer } from '../../lib/image2/types';

/** The drawing buffer is the original asset size, independent of CSS size, zoom, or parent rotation. */
export function MaskEditor({ layer, onSave, onClose, onClearRanges, purpose = 'edit' }: { layer: ImageLayer; onSave: (edit: Blob, protect: Blob) => Promise<void>; onClose: () => void; onClearRanges?: () => Promise<void>; purpose?: 'edit' | 'visibility' }) {
  const view = useRef<HTMLCanvasElement>(null), edit = useRef<HTMLCanvasElement | null>(null), protect = useRef<HTMLCanvasElement | null>(null), image = useRef<HTMLImageElement | null>(null);
  const drawing = useRef(false), [mode, setMode] = useState<'edit' | 'protect'>('edit'), [brush, setBrush] = useState(24), [error, setError] = useState(''), [saving, setSaving] = useState(false), [ready, setReady] = useState(false);
  const [hideBrush, setHideBrush] = useState(false);
  const stored = savedMaskReferences(layer, purpose), source = purpose === 'visibility' ? visibilityBackdrop(layer) : undefined;
  const savedEdit = stored.edit, savedProtect = stored.protect, backdropAssetId = source?.assetId, backdropRect = JSON.stringify(source?.rect);
  const redraw = () => {
    const canvas = view.current, img = image.current; if (!canvas || !img || !edit.current || !protect.current) return;
    const ctx = canvas.getContext('2d')!; ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.drawImage(img, 0, 0);
    for (const [mask, color] of [[edit.current, '#f76d4a'], [protect.current, '#6953e6']] as const) {
      const overlay = document.createElement('canvas'); overlay.width = canvas.width; overlay.height = canvas.height;
      const ox = overlay.getContext('2d')!; ox.fillStyle = color; ox.fillRect(0, 0, overlay.width, overlay.height);
      ox.globalCompositeOperation = 'destination-in'; ox.drawImage(mask, 0, 0);
      ctx.globalAlpha = .42; ctx.drawImage(overlay, 0, 0); ctx.globalAlpha = 1;
    }
  };
  useEffect(() => {
    let active = true;
    queueMicrotask(() => { if (active) { setReady(false); setError(''); } });
    const img = new Image(); img.onload = async () => {
      try {
      let backdrop = img;
      if (backdropAssetId && backdropRect) {
          const original = new Image(); original.src = assetUrl(backdropAssetId); await original.decode();
          const [x, y, width, height] = JSON.parse(backdropRect) as number[];
          if (![x, y, width, height].every(Number.isInteger) || x < 0 || y < 0 || width < 1 || height < 1 || x + width > original.naturalWidth || y + height > original.naturalHeight) throw new Error('可恢复裁片与当前图片不一致，请重新打开图层');
          const crop = document.createElement('canvas'); crop.width = img.naturalWidth; crop.height = img.naturalHeight;
          crop.getContext('2d')!.drawImage(original, x, y, width, height, 0, 0, crop.width, crop.height);
          backdrop = new Image(); backdrop.src = crop.toDataURL('image/png'); await backdrop.decode();
      }
      if (!active) return;
      image.current = backdrop;
      for (const target of [edit, protect]) { const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; target.current = c; }
      if (purpose === 'visibility') {
        const ctx = edit.current!.getContext('2d')!; ctx.drawImage(img, 0, 0); const data = ctx.getImageData(0, 0, img.naturalWidth, img.naturalHeight);
        for (let i = 0; i < data.data.length; i += 4) data.data[i] = data.data[i + 1] = data.data[i + 2] = 255;
        ctx.putImageData(data, 0, 0);
      }
      for (const [target, assetId] of [[edit, purpose === 'edit' ? savedEdit : undefined], [protect, savedProtect]] as const) {
        if (!assetId) continue;
        const persisted = new Image(); persisted.src = assetUrl(assetId); await persisted.decode();
        if (!active) return;
        const canvas = target.current!, ctx = canvas.getContext('2d')!;
        if (persisted.naturalWidth !== canvas.width || persisted.naturalHeight !== canvas.height) throw new Error('已保存的范围与当前图片尺寸不一致；请取消局部范围后重新选择');
        ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.drawImage(persisted, 0, 0);
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
        data.data.set(maskPixelsForCanvas(data.data, canvas.width, canvas.height, img.naturalWidth, img.naturalHeight)); ctx.putImageData(data, 0, 0);
      }
      if (view.current) { view.current.width = img.naturalWidth; view.current.height = img.naturalHeight; redraw(); setReady(true); }
      } catch (err) { if (active) { setReady(false); setError(`范围读取未完成，原范围已保留：${(err as Error).message}`); } }
    }; img.onerror = () => { if (active) setError('原图读取失败，请重新打开'); }; img.src = assetUrl(layer.assetId!);
    return () => { active = false; };
  }, [layer.assetId, backdropAssetId, backdropRect, savedEdit, savedProtect, purpose]);
  const paint = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = view.current, mask = mode === 'edit' ? edit.current : protect.current; if (!ready || saving || !canvas || !mask) return;
    const bounds = canvas.getBoundingClientRect(), x = (event.clientX - bounds.left) * canvas.width / bounds.width, y = (event.clientY - bounds.top) * canvas.height / bounds.height;
    const ctx = mask.getContext('2d')!; ctx.globalCompositeOperation = purpose === 'visibility' && mode === 'edit' && hideBrush ? 'destination-out' : 'source-over'; ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x, y, brush * canvas.width / bounds.width / 2, 0, Math.PI * 2); ctx.fill(); ctx.globalCompositeOperation = 'source-over'; redraw();
  };
  const blob = (canvas: HTMLCanvasElement) => new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('遮罩保存失败')), 'image/png'));
  return <div className="i2-modal-backdrop"><section className="i2-modal" role="dialog" aria-label="修改和保护范围">
    <header><h2>{purpose === 'visibility' ? '修正图层轮廓' : '选择修改和保护范围'}</h2><button onClick={onClose}>关闭</button></header>
    <p>{purpose === 'visibility' ? '橙色是保留的原始像素；画笔可补回或隐藏轮廓，紫色保护当前像素。' : '橙色是要修改的区域，紫色是必须保留的区域；保护范围始终优先。'}</p>
    <div className="i2-row"><button className={mode === 'edit' ? 'active' : ''} onClick={() => setMode('edit')}>{purpose === 'visibility' ? '图层轮廓' : '修改范围'}</button><button className={mode === 'protect' ? 'active' : ''} onClick={() => setMode('protect')}>保护范围</button>
      {purpose === 'visibility' && <><button className={!hideBrush ? 'active' : ''} onClick={() => { setHideBrush(false); setMode('edit'); }}>补回像素</button><button className={hideBrush ? 'active' : ''} onClick={() => { setHideBrush(true); setMode('edit'); }}>隐藏像素</button></>}
      <label>画笔 <input aria-label="遮罩画笔尺寸" type="range" min="2" max="100" value={brush} onChange={e => setBrush(Number(e.target.value))} /></label>
      <button disabled={!ready || saving} onClick={() => { const canvas = mode === 'edit' ? edit.current : protect.current; canvas?.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height); redraw(); }}>清空当前范围</button>
      {purpose === 'edit' && onClearRanges && <button disabled={saving} onClick={async () => { setSaving(true); try { await onClearRanges(); onClose(); } catch (err) { setError((err as Error).message); } finally { setSaving(false); } }}>取消局部范围</button>}</div>
    <canvas ref={view} className="i2-mask-canvas" onPointerDown={e => { drawing.current = true; e.currentTarget.setPointerCapture(e.pointerId); paint(e); }} onPointerMove={e => { if (drawing.current) paint(e); }} onPointerUp={() => { drawing.current = false; }} />
    {error && <p role="alert">{error}</p>}
    <footer><button className="primary" disabled={saving || !ready} onClick={async () => { setSaving(true); try { await onSave(await blob(edit.current!), await blob(protect.current!)); onClose(); } catch (err) { setError((err as Error).message); } finally { setSaving(false); } }}>保存范围</button></footer>
  </section></div>;
}
