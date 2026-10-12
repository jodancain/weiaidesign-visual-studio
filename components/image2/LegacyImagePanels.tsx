'use client';
import { useState } from 'react';
import { Download, GitBranch, Layers, Loader2, X } from 'lucide-react';
import type { useLegacyImage2 } from '../../lib/image2/useLegacyImage2';
import { assetUrl } from '../../lib/image2/client';
import { groupLayerCommands, ungroupLayerCommands } from '../../lib/image2/grouping';
import { reorderSiblingCommands } from '../../lib/image2/stacking';
import type { ImageLayer } from '../../lib/image2/types';
import { VectorProperties } from './VectorProperties';
import { capability } from '../../lib/image2/geometry';
import { buildTemplate, templateNames, type TemplateKind } from '../../lib/image2/templates';

export type LegacyImagePanel = 'layers' | 'versions' | 'import' | 'upscale' | 'vector' | null;
type Bridge = ReturnType<typeof useLegacyImage2>;
const layerLabels = { raster: '图片', text: '文字', vector: 'SVG', group: '组', mask: '遮罩' };
const fieldLabels = { x: '横向位置', y: '纵向位置', width: '宽度', height: '高度', rotation: '角度', opacity: '不透明度', fontSize: '字号', tracking: '字距', lineHeight: '行距', strokeWidth: '描边宽度' };

/** These dialogs reuse the original workbench styles and do not occupy canvas space when closed. */
export function LegacyImagePanels({ mode, onClose, bridge, onError, onResult }: {
  mode: LegacyImagePanel; onClose: () => void; bridge: Bridge; onError: (message: string) => void;
  onResult?: (jobId: string) => void;
}) {
  const [working, setWorking] = useState(false), [picked, setPicked] = useState<string[]>([]);
  const [upscaleKind, setUpscaleKind] = useState('resize'), [scale, setScale] = useState(2), [traceMode, setTraceMode] = useState('detail');
  const [pixelOperation, setPixelOperation] = useState('resize');
  const [pixelParams, setPixelParams] = useState({ width: 512, height: 512, x: 0, y: 0, degrees: 90, color: '#ffffff', tolerance: 32, axis: 'horizontal' });
  const [templateKind, setTemplateKind] = useState<TemplateKind>('poster');
  const act = async (fn: () => Promise<unknown>) => {
    setWorking(true); try { await fn(); } catch (error) { onError((error as Error).message); } finally { setWorking(false); }
  };
  if (!mode) return null;
  const doc = bridge.document, selected = bridge.selectedLayer;
  const busy = working || bridge.busy;
  const upscaleStatus = capability(bridge.capabilities, upscaleKind);
  const patch = (changes: Partial<ImageLayer>) => selected && void act(() => bridge.updateLayer(selected.id, changes));
  const title = { layers: '图层', versions: '版本与候选', import: '导入当前画布', upscale: '高清', vector: '矢量化' }[mode];
  return <div className="modalScrim" onClick={onClose}>
    <div className="taskDialog" role="dialog" aria-label={title} onClick={event => event.stopPropagation()} style={{ maxHeight: '85vh', overflowY: 'auto' }}>
      <div className="drawerTop"><h2>{mode === 'versions' ? <GitBranch size={16} /> : <Layers size={16} />}{title}</h2><button className="ghostIcon" type="button" aria-label="关闭" onClick={onClose}><X size={16} /></button></div>
      {mode === 'import' || (!doc && bridge.needsImport) ? <>
        <p>当前画布还使用旧工程。导入后，画布位置、原始对象和旧快照都会保留，图片编辑将使用 2.0 的图层与版本。</p>
        <p>缺失素材会保留说明，未知状态的旧生成任务不会自动重投。</p>
        <div className="dialogFooter"><span>导入完成后重新执行刚才的操作</span><button className="darkButton" disabled={busy} onClick={() => void act(async () => { await bridge.importCanvas(); onClose(); })}>确认导入当前画布</button></div>
      </> : mode === 'layers' ? <>
        <div className="inlineOptions">
          <button disabled={busy} onClick={() => void act(async () => {
            const current = await bridge.ensureDocument(), font = await bridge.defaultFont();
            const id = crypto.randomUUID();
            await bridge.submitCommands([{ type: 'layer.add', layer: { id, type: 'text', name: '文字', x: selected?.x || 0, y: selected?.y || 0, width: 320, height: 100, rotation: 0, opacity: 1, visible: true, locked: false, z: current.layers.length, text: '在这里输入文字', fontAssetId: font.id, fontFamily: String(font.metadata?.family || ''), fontSize: 40, fill: '#20232b', editability: 'text', metadata: { fontConfirmed: true } } }]);
            bridge.selectLayer(id);
          })}>＋ 文字</button>
          <label style={{ margin: 0 }}>上传 SVG / 图片<input aria-label="上传 SVG / 图片" type="file" accept="image/*,.svg" disabled={busy} onChange={event => { const file = event.target.files?.[0]; if (file) void act(() => bridge.addFile(file)); event.target.value = ''; }} /></label>
          <label style={{ margin: 0 }}>上传字体<input aria-label="上传字体" type="file" accept=".ttf,.otf,.woff,.woff2" disabled={busy} onChange={event => { const file = event.target.files?.[0]; if (file) void act(() => bridge.uploadFile(file, file.name, 'font')); event.target.value = ''; }} /></label>
        </div>
        {doc?.layers.length ? <div aria-label="工程图层" style={{ display: 'grid', gap: 6, margin: '12px 0' }}>{[...doc.layers].sort((a, b) => b.z - a.z).map(layer => <div key={layer.id} style={{ display: 'flex', alignItems: 'center', gap: 6, paddingLeft: layer.parentId ? 18 : 0 }}>
          <input type="checkbox" aria-label={`组合 ${layer.name}`} checked={picked.includes(layer.id)} disabled={layer.locked || busy} onChange={event => setPicked(current => event.target.checked ? [...current, layer.id] : current.filter(id => id !== layer.id))} />
          <button className={selected?.id === layer.id ? 'darkButton' : 'ghostButton'} style={{ flex: 1, textAlign: 'left' }} onClick={() => bridge.selectLayer(layer.id)}>{layerLabels[layer.type]} · {layer.name}</button>
          <button className="ghostButton" aria-label={`${layer.name}${layer.visible ? '隐藏' : '显示'}`} disabled={busy} onClick={() => void act(() => bridge.updateLayer(layer.id, { visible: !layer.visible }))}>{layer.visible ? '◉' : '○'}</button>
          <button className="ghostButton" aria-label={`${layer.name}${layer.locked ? '解锁' : '锁定'}`} disabled={busy} onClick={() => void act(() => bridge.updateLayer(layer.id, { locked: !layer.locked }))}>{layer.locked ? '🔒' : '◇'}</button>
        </div>)}</div> : <p>画布上还没有图层。</p>}
        <div className="inlineOptions"><button disabled={!doc || busy || picked.length < 2} onClick={() => void act(async () => { await bridge.submitCommands(groupLayerCommands(bridge.document!, picked, crypto.randomUUID())); setPicked([]); })}>编组所选</button><button disabled={!doc || busy || selected?.type !== 'group'} onClick={() => void act(() => bridge.submitCommands(ungroupLayerCommands(bridge.document!, selected!.id)))}>拆开组合</button></div>
        <label>模板版式<select aria-label="模板版式" value={templateKind} onChange={event => setTemplateKind(event.target.value as TemplateKind)}>{Object.entries(templateNames).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <button className="ghostButton" disabled={busy} onClick={() => void act(async () => {
          await bridge.ensureDocument(); const font = await bridge.defaultFont();
          const current = await bridge.sync();
          const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${current.width}" height="${current.height}"><rect width="100%" height="100%" fill="#ffffff"/></svg>`;
          const paper = await bridge.uploadFile(new Blob([svg], {type:'image/svg+xml'}), '模板底板.svg', 'template_background');
          const ready = await bridge.sync();
          const commands = buildTemplate({document:ready, selected: bridge.getLayer(), font, kind: templateKind, paperAsset:paper});
          for (const command of commands) if (command.type === 'layer.add' && command.layer.metadata?.copiedFromLayerId) {
            const metadata = {...command.layer.metadata}; delete metadata.legacyShapeId; delete metadata.legacyRecord; command.layer.metadata = metadata;
          }
          await bridge.submitCommands(commands); const group = commands.find(command => command.type === 'layer.add' && command.layer.type === 'group'); if (group?.type === 'layer.add') bridge.selectLayer(group.layer.id);
        })}>添加可编辑模板</button><p>使用现有图片、Logo 和实际字体排版，不调用生成模型。</p>
        {selected && <div style={{ borderTop: '1px solid #e8e8ec', marginTop: 14, paddingTop: 12 }}>
          {selected.metadata?.nativeTextFormat === 'preserved' && <p>原文字包含混合样式，当前保留原画布对象和格式，并通过原始裁片保留外观。独立调整字体、颜色或字号前，需要明确转换为真实文字层并重新确认字体与排版。</p>}
          <label>图层名称<input key={`${selected.id}-name-${selected.name}`} aria-label="图层名称" defaultValue={selected.name} onBlur={event => { if (event.target.value !== selected.name) patch({ name: event.target.value }); }} /></label>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>{(['x', 'y', 'width', 'height', 'rotation', 'opacity'] as const).map(field => <label key={field}>{fieldLabels[field]}<input key={`${selected.id}-${field}-${selected[field]}`} aria-label={fieldLabels[field]} type="number" step={field === 'opacity' ? .1 : 1} defaultValue={selected[field]} disabled={busy || (field === 'opacity' && selected.type === 'group')} onBlur={event => { const value = Number(event.target.value); if (Number.isFinite(value) && value !== selected[field]) patch({ [field]: value }); }} /></label>)}</div>
          <div className="inlineOptions"><button disabled={busy} onClick={() => void act(() => bridge.submitCommands(reorderSiblingCommands(doc!.layers, selected.id, 1)))}>上移一层</button><button disabled={busy} onClick={() => void act(() => bridge.submitCommands(reorderSiblingCommands(doc!.layers, selected.id, -1)))}>下移一层</button><button disabled={busy} onClick={() => void act(() => bridge.submitCommands([{ type: 'layer.remove', layerId: selected.id }]))}>删除图层</button></div>
          {selected.type === 'text' && <>
            {selected.metadata?.fontConfirmed !== true && <p>当前显示原字形裁片。识别文字是待校正信息，确认字体与清底后才会改动画面。</p>}
            <label>文字内容<textarea aria-label="文字内容" key={`${selected.id}-${selected.text}-${selected.metadata?.desiredText}`} defaultValue={String(selected.metadata?.fontConfirmed === true ? selected.text || '' : selected.metadata?.desiredText ?? selected.text ?? '')} onBlur={event => patch(selected.metadata?.fontConfirmed === true ? { text: event.target.value } : { metadata: { ...selected.metadata, desiredText: event.target.value } })} /></label>
            <label>实际字体<select aria-label="实际字体" value={selected.fontAssetId || ''} disabled={busy || selected.metadata?.fontConfirmed !== true} onChange={event => { const font = bridge.assets.find(asset => asset.id === event.target.value); if (font) patch({ fontAssetId: font.id, fontFamily: String(font.metadata?.family || ''), fontWeight: Number(font.metadata?.weight) || 400 }); }}><option value="">待确认</option>{bridge.assets.filter(asset => asset.metadata?.family).map(font => <option key={font.id} value={font.id}>{font.name}</option>)}</select></label>
            {selected.metadata?.fontConfirmed !== true && <div className="inlineOptions"><button disabled={busy} onClick={() => void act(async () => bridge.waitJob(await bridge.submitOperation('prepare_text', { purpose: 'text_background' }, undefined, {layerId: selected.id})))}>清理原字背景</button><button disabled={busy} onClick={() => void act(async () => { if (!selected.assetId) throw new Error('原字裁片缺失'); const asset = bridge.assets.find(item => item.id === selected.assetId); await bridge.confirmText(assetUrl(selected.assetId), {x: 0, y: 0, width: asset?.width || Math.round(selected.width), height: asset?.height || Math.round(selected.height)}, selected.text || '', String(selected.metadata?.desiredText ?? selected.text ?? ''), await bridge.defaultFont(), selected.fontSize || 36, selected.fill || '#20232b'); })}>确认内置字体并应用</button></div>}
            {(['fontSize', 'tracking', 'lineHeight', 'strokeWidth'] as const).map(field => <label key={field}>{fieldLabels[field]}<input key={`${selected.id}-${field}-${selected[field]}`} aria-label={fieldLabels[field]} type="number" step=".1" defaultValue={selected[field] || (field === 'fontSize' ? 40 : field === 'lineHeight' ? 1.2 : 0)} onBlur={event => patch({ [field]: Number(event.target.value) })} /></label>)}
            <p>字重由实际字体文件决定。</p><label>描边颜色<input aria-label="描边颜色" type="color" value={selected.stroke?.startsWith('#') ? selected.stroke : '#000000'} onChange={event => patch({ stroke: event.target.value, strokeWidth: selected.strokeWidth || 1 })} /></label>
          </>}
          {(selected.type === 'text' || selected.type === 'vector') && <label>填色<input aria-label="图层填色" type="color" value={selected.fill?.startsWith('#') ? selected.fill : '#20232b'} onChange={event => patch({ fill: event.target.value })} /></label>}
          {selected.type === 'vector' && <><VectorProperties key={selected.id} layer={selected} onPatch={patch} /><p>保留原始 SVG 路径身份，缩放与导出沿用原文件。</p></>}
          {selected.assetId && !['group', 'vector'].includes(selected.type) && !(selected.type === 'text' && selected.metadata?.fontConfirmed === true) && <>
            <label>像素处理<select aria-label="像素处理" value={pixelOperation} onChange={event => setPixelOperation(event.target.value)}><option value="resize">插值调整尺寸</option><option value="crop">裁切</option><option value="pad">填边</option><option value="rotate">旋转像素</option><option value="flip">翻转像素</option><option value="color_key">纯色去底</option><option value="prepare_text">清理原字背景</option></select></label>
            {['resize', 'crop', 'pad'].includes(pixelOperation) && <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:8}}>{(['width','height', ...(pixelOperation === 'crop' ? ['x','y'] : [])] as const).map(field => <label key={field}>{field}<input aria-label={`处理 ${field}`} type="number" value={pixelParams[field as 'width'|'height'|'x'|'y']} onChange={event => setPixelParams(current => ({...current, [field]: Number(event.target.value)}))} /></label>)}</div>}
            {pixelOperation === 'rotate' && <label>像素旋转角度<input aria-label="像素旋转角度" type="number" value={pixelParams.degrees} onChange={event => setPixelParams(current => ({...current,degrees:Number(event.target.value)}))} /></label>}
            {pixelOperation === 'flip' && <label>翻转方向<select aria-label="翻转方向" value={pixelParams.axis} onChange={event => setPixelParams(current => ({...current,axis:event.target.value}))}><option value="horizontal">水平</option><option value="vertical">垂直</option></select></label>}
            {['pad','color_key'].includes(pixelOperation) && <label>处理颜色<input aria-label="像素处理颜色" type="color" value={pixelParams.color} onChange={event => setPixelParams(current => ({...current,color:event.target.value}))} /></label>}
            {pixelOperation === 'color_key' && <label>颜色容差<input aria-label="颜色容差" type="number" min="0" max="255" value={pixelParams.tolerance} onChange={event => setPixelParams(current => ({...current,tolerance:Number(event.target.value)}))} /></label>}
            <p>处理整张当前图层。文字与矢量独立编辑；尺寸插值不恢复缺失细节。</p>
            <button className="ghostButton" disabled={busy} onClick={() => void act(async () => { const params = ['resize','crop','pad'].includes(pixelOperation) ? {width:pixelParams.width,height:pixelParams.height,...(pixelOperation==='crop'?{x:pixelParams.x,y:pixelParams.y}:{}),...(pixelOperation==='pad'?{fill:pixelParams.color}:{})} : pixelOperation==='rotate'?{degrees:pixelParams.degrees}:pixelOperation==='flip'?{axis:pixelParams.axis}:pixelOperation==='color_key'?{color:pixelParams.color,tolerance:pixelParams.tolerance}:{purpose:'text_background'}; await bridge.waitJob(await bridge.submitOperation(pixelOperation,params,undefined,{layerId:selected.id})); })}>执行像素处理</button>
          </>}
        </div>}
        <div className="dialogFooter"><span>服务端版本 {doc?.revision ?? '—'}{bridge.pendingCount ? ` · ${bridge.pendingCount} 项本地草稿` : ''}</span><button className="darkButton" disabled={busy} onClick={() => void act(() => bridge.sync())}>保存画布</button></div>
      </> : mode === 'versions' ? <>
        <div className="inlineOptions"><button disabled={busy || !doc} onClick={() => void act(() => bridge.undo())}>撤销</button><button disabled={busy || !doc} onClick={() => void act(() => bridge.redo())}>重做</button><button disabled={busy} onClick={() => void act(() => bridge.refresh())}>刷新状态</button></div>
        <p>当前版本 {doc?.revision ?? '—'}。候选接受前不会覆盖主工程。</p>
        {bridge.hasDraftConflict && <div role="alert"><p>主工程已有新版本。本地画布草稿已保留，请选择保留方式。</p><div className="inlineOptions"><button disabled={busy} onClick={() => void act(() => bridge.saveDraftAsProject())}>另存本地草稿</button><button disabled={busy} onClick={() => void act(() => bridge.useServerVersion())}>采用服务器版本</button></div></div>}
        {bridge.branches.map(branch => {
          const job = bridge.jobs.find(job => job.output?.branchDocumentId === branch.id), running = job && ['queued','running'].includes(job.state), partial = job && ['uncertain','failed','cancelled','awaiting_user'].includes(job.state);
          return <div key={branch.id} style={{ padding: '10px 0', borderTop: '1px solid #e8e8ec' }}><strong>{branch.name}</strong><p>基于版本 {branch.baseRevision} · {branch.layers.length} 图层{running ? ' · 任务仍在执行' : partial ? ' · 任务未完成，已有产物保留' : ''}</p><button className="darkButton" disabled={busy || !!running} onClick={() => void act(() => bridge.acceptCandidate(branch.id))}>{partial ? '接受已有产物' : '接受候选'}</button></div>;
        })}
        {bridge.jobs.map(job => <div key={job.id} style={{ padding: '8px 0', borderTop: '1px solid #e8e8ec' }}><strong>{job.operation || job.kind}</strong> · {job.state}<p>{job.error || job.stage || '结果已记录'}</p>{job.state === 'uncertain' && <p>提交状态未知，已停止自动重投。</p>}{['queued','running'].includes(job.state) && <button className="ghostButton" disabled={busy} onClick={() => void act(() => bridge.cancelJob(job.id))}>取消任务</button>}</div>)}
        {bridge.revisions.map((revision, index) => <p key={String(revision.revision ?? index)}>版本 {String(revision.revision ?? index)} · {String(revision.createdAt || '')}</p>)}
        <div className="inlineOptions"><button disabled={busy || !doc} onClick={() => void act(async () => { const value = await bridge.export('project'); const link = document.createElement('a'); link.href = URL.createObjectURL(value.blob); link.download = value.name; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000); })}>导出原生工程</button><label>导入原生工程<input aria-label="导入原生工程" type="file" accept=".zip" disabled={busy} onChange={event => { const file = event.target.files?.[0]; if (file) void act(() => bridge.importPackage(file)); event.target.value = ''; }} /></label></div>
      </> : mode === 'upscale' ? <>
        <div className="inlineOptions"><button className={upscaleKind === 'resize' ? 'on' : ''} onClick={() => setUpscaleKind('resize')}>尺寸放大</button><button className={upscaleKind === 'super_resolution' ? 'on' : ''} onClick={() => setUpscaleKind('super_resolution')}>细节超分</button><button className={upscaleKind === 'generate' ? 'on' : ''} onClick={() => setUpscaleKind('generate')}>AI 高清重绘</button></div>
        <label>倍率<select aria-label="放大倍率" value={scale} onChange={event => setScale(Number(event.target.value))}><option value={2}>2×</option><option value={4}>4×</option></select></label>
        <p>{upscaleKind === 'resize' ? '采用插值增加像素尺寸，不声称恢复缺失细节。' : upscaleKind === 'super_resolution' ? '使用专用 Real-ESRGAN；真实文字与矢量 Logo 保持独立。' : '会调用生成模型，结果先进入候选，可能改变纹理和细节。'}</p>
        {!upscaleStatus.available && <p role="status">{upscaleStatus.reason || '当前能力不可用'}</p>}
        {(selected?.type === 'vector' || selected?.type === 'text' && selected.metadata?.fontConfirmed === true) && <p>文字和矢量图层可直接调整尺寸，无需像素放大。</p>}
        <div className="dialogFooter"><span>{upscaleKind === 'generate' ? '接受后添加为新的候选图层' : '保留画布位置与显示尺寸'}</span><button className="darkButton" disabled={busy || !upscaleStatus.available || selected?.type === 'vector' || selected?.type === 'text' && selected.metadata?.fontConfirmed === true} onClick={() => void act(async () => {
          const layer = bridge.getLayer(); if (!layer?.assetId) throw new Error('请先选中图片');
          const source = bridge.assets.find(asset => asset.id === layer.assetId), width = source?.width, height = source?.height;
          if (!width || !height) throw new Error('原图尺寸尚未读取');
          const params = upscaleKind === 'resize' ? { width: width * scale, height: height * scale } : upscaleKind === 'super_resolution' ? { scale } : { prompt: '高清重绘当前图片，尽量保留构图、主体与配色', width: width * scale, height: height * scale };
          const job = await bridge.submitOperation(upscaleKind, params, undefined, { layerId: layer.id, mode: upscaleKind === 'generate' ? 'candidate' : 'apply' }); onResult?.(job.id); onClose();
        })}>执行</button></div>
      </> : <>
        <div className="inlineOptions"><button className={traceMode === 'detail' ? 'on' : ''} onClick={() => setTraceMode('detail')}>保网点 / 线稿</button><button className={traceMode === 'color' ? 'on' : ''} onClick={() => setTraceMode('color')}>彩色描摹</button></div>
        <p>直接描摹原像素，不预先生成平涂图。保细节模式保留小路径、细孔和网点。</p>
        <div className="dialogFooter"><span>结果是可编辑 SVG 图层</span><button className="darkButton" disabled={busy} onClick={() => void act(async () => { const job = await bridge.submitOperation('trace', traceMode === 'detail' ? { preset: 'monochrome', pathomit: 0, blurradius: 0, ltres: .1, qtres: .1 } : { preset: 'color', pathomit: 0, blurradius: 0 }); onResult?.(job.id); onClose(); })}>执行</button></div>
      </>}
      {busy && <p role="status"><Loader2 size={13} className="spin" /> 保存中…</p>}
    </div>
  </div>;
}

export function CandidateResult({ bridge, job, onError }: { bridge: Bridge; job: Bridge['jobs'][number]; onError: (message: string) => void }) {
  const branchId = String(job.output?.branchDocumentId || job.output?.candidateDocumentId || '');
  const branch = bridge.branches.find(branch => branch.id === branchId);
  const assets = (Array.isArray(job.output?.assetIds) ? job.output.assetIds : job.output?.assetId ? [job.output.assetId] : branch?.layers.filter(layer => layer.visible && layer.assetId && layer.type !== 'mask').map(layer => layer.assetId).slice(-4) || []) as string[];
  return <div className="msgAssistant"><div className="msgKind">{job.kind === 'agent' ? 'Agent 任务' : '图片结果'} · {job.state === 'complete' ? branchId ? '候选预览' : '完成' : job.state}</div>
    {job.error && <p className="msgError">{job.error}</p>}
    {assets.length > 0 && <div className="msgImages">{assets.map(id => <span className="msgImageWrap" key={id}>
      {/* eslint-disable-next-line @next/next/no-img-element -- Show immutable source pixels without image resampling. */}
      <img src={assetUrl(id)} alt="候选结果" /><button type="button" aria-label="download" onClick={() => void (async () => {
        try { const response = await fetch(assetUrl(id)); if (!response.ok) throw new Error('候选文件暂不可读取'); const blob = await response.blob(), link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `图片候选.${blob.type === 'image/svg+xml' ? 'svg' : 'png'}`; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000); }
        catch (error) { onError((error as Error).message); }
      })()}><Download size={12} /></button></span>)}</div>}
    {branchId && job.state === 'complete' && bridge.branches.some(branch => branch.id === branchId) && <button className="darkButton" onClick={() => void bridge.acceptCandidate(branchId).catch(error => onError(error.message))}>接受候选</button>}
  </div>;
}
