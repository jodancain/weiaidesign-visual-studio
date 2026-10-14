'use client';
import { useState } from 'react';
import { capability } from '../../lib/image2/geometry';
import { imageAdjustmentRequest, imageAdjustments } from '../../lib/image2/adjustments';
import type { useLegacyImage2 } from '../../lib/image2/useLegacyImage2';

type Bridge = ReturnType<typeof useLegacyImage2>;
/** Folded controls inside the existing Elements dialog; no persistent canvas UI. */
export function LegacyImageAdjustments({ bridge, src, layerId, onError }: { bridge: Bridge; src: string; layerId?: string; onError: (message: string) => void }) {
  const [kind, setKind] = useState('brightness'), [values, setValues] = useState<Record<string, string>>({}), [working, setWorking] = useState(false);
  const choice = imageAdjustments.find(item => item.id === kind)!, target = bridge.getLayer(src, layerId);
  const status = capability(bridge.capabilities, choice.operation);
  const pixelTarget = target?.type === 'raster' || target?.type === 'text' && target.metadata?.fontConfirmed !== true;
  let cursor = target, locked = false, needsBake = false;
  const visited = new Set<string>();
  while (cursor && !visited.has(cursor.id)) {
    visited.add(cursor.id); locked ||= cursor.locked;
    if (bridge.rawDocument?.schemaVersion === 3) needsBake ||= Boolean(cursor.masks?.some(mask => mask.enabled) || cursor.effects?.some(effect => effect.enabled) || cursor.clipToLayerId);
    cursor = bridge.document?.layers.find(layer => layer.id === cursor?.parentId);
  }
  const hasEditMask = typeof target?.metadata?.editMaskAssetId === 'string';
  const disabled = working || bridge.busy || !pixelTarget || locked || needsBake || !status.available;
  return <details style={{ borderTop: '1px solid #e8e8ec', paddingTop: 10 }}>
    <summary>调色与滤镜（算法）</summary>
    <label>调整项目<select aria-label="算法调色与滤镜" value={kind} disabled={working} onChange={event => { setKind(event.target.value); setValues({}); }}>
      <optgroup label="调色">{imageAdjustments.filter(item => item.operation === 'adjust').map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</optgroup>
      <optgroup label="滤镜">{imageAdjustments.filter(item => item.operation === 'filter').map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</optgroup>
    </select></label>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: 8 }}>{choice.fields.map(field => <label key={`${kind}:${field.key}`}>{field.label}<input aria-label={`${choice.label}${field.label}`} type="number" min={field.min} max={field.max} step={field.step} disabled={working} value={values[field.key] ?? String(field.initial)} onChange={event => setValues(current => ({ ...current, [field.key]: event.target.value }))} /></label>)}</div>
    {hasEditMask && <label>选区内羽化（像素）<input aria-label="算法调整选区内羽化" type="number" min="0" max="256" step="1" disabled={working} value={values.feather ?? '0'} onChange={event => setValues(current => ({ ...current, feather: event.target.value }))} /></label>}
    <p>已有修改范围与保护范围时按该范围处理，否则处理整张图层。保留透明度，可在版本中撤销。</p>
    {!pixelTarget && <p>请选择位图；真实文字与 SVG 可直接编辑颜色。</p>}
    {locked && <p>请先解锁图层或父组。</p>}
    {needsBake && <p>此图层的显示蒙版、效果或剪贴关系需要显式烘焙；当前不会自动烘焙。</p>}
    {!status.available && <p role="status">{status.reason || '当前服务尚未接通此算法。'}</p>}
    <button className="ghostButton" type="button" disabled={disabled} onClick={() => {
      if (!target) return;
      let request: ReturnType<typeof imageAdjustmentRequest>;
      try { request = imageAdjustmentRequest(kind, values); } catch (error) { onError((error as Error).message); return; }
      setWorking(true);
      void bridge.submitOperation(request.operation, request.params, src, { layerId: target.id, mode: 'apply' }).then(job => bridge.waitJob(job)).catch(error => onError((error as Error).message)).finally(() => setWorking(false));
    }}>{working ? '正在处理…' : '应用算法调整'}</button>
  </details>;
}
