'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { DocumentCanvas } from './DocumentCanvas';
import { MaskEditor } from './MaskEditor';
import { VectorProperties } from './VectorProperties';
import { image2Api, assetUrl, listValue, unwrapDocument, uploadAsset, Image2ApiError } from '../../lib/image2/client';
import { ImageCommandQueue, applyDraft, type QueuedBatch } from '../../lib/image2/queue';
import { image2Storage, submissionStorage, cachedDocument, cachedDocuments } from '../../lib/image2/storage';
import { ImageSubmissionManager } from '../../lib/image2/submissions';
import { capability } from '../../lib/image2/geometry';
import { groupLayerCommands, ungroupLayerCommands } from '../../lib/image2/grouping';
import { orderedLayers, reorderSiblingCommands } from '../../lib/image2/stacking';
import { buildTemplate, templateNames, type TemplateKind } from '../../lib/image2/templates';
import type { Capabilities, Conversation, ConversationMessage, DocumentCommand, ImageAsset, ImageDocument, ImageJob, ImageLayer } from '../../lib/image2/types';
import './image2.css';

const activeStates = new Set(['queued', 'running', 'uncertain', 'awaiting_user']);
const blankLayer = (type: ImageLayer['type'], name: string): ImageLayer => ({ id: crypto.randomUUID(), type, name, x: 40, y: 40, width: 300, height: 100, rotation: 0, opacity: 1, visible: true, locked: false, z: 0 });
export default function ImageWorkspace() {
  'use no memo';
  const [documents, setDocuments] = useState<ImageDocument[]>([]), [document, setDocument] = useState<ImageDocument | null>(null), [pending, setPending] = useState<QueuedBatch[]>([]);
  const [capabilities, setCapabilities] = useState<Capabilities>({}), [assets, setAssets] = useState<ImageAsset[]>([]), [jobs, setJobs] = useState<ImageJob[]>([]), [branches, setBranches] = useState<ImageDocument[]>([]);
  const [selectedId, setSelectedId] = useState<string>(), [error, setError] = useState(''), [status, setStatus] = useState('正在打开工作台…'), [acting, setActing] = useState(false);
  const [pickedLayers, setPickedLayers] = useState<string[]>([]);
  const [submissionCount, setSubmissionCount] = useState(0);
  const [templateKind, setTemplateKind] = useState<TemplateKind>('poster');
  const [conversation, setConversation] = useState<Conversation | null>(null), [messages, setMessages] = useState<ConversationMessage[]>([]), [chat, setChat] = useState('');
  const [showMasks, setShowMasks] = useState(false), [maskRefs, setMaskRefs] = useState<Record<string, { edit: string; protect: string }>>({});
  const [maskPurpose, setMaskPurpose] = useState<'edit' | 'visibility'>('edit');
  const [operation, setOperation] = useState('resize'), [operationParams, setOperationParams] = useState<Record<string, string>>({ width: '2048', height: '2048', color: '#ffffff', tolerance: '20', degrees: '90', scale: '2', preset: 'logo', axis: 'horizontal', x: '0', y: '0', prompt: '' });
  const canonical = useRef<ImageDocument | null>(null), mounted = useRef(true), uploadRef = useRef<HTMLInputElement>(null), fontRef = useRef<HTMLInputElement>(null), importRef = useRef<HTMLInputElement>(null);
  const queue = useRef<ImageCommandQueue | null>(null);
  const submissions = useRef<ImageSubmissionManager | null>(null);
  if (submissions.current === null) submissions.current = new ImageSubmissionManager(submissionStorage, (path, body) => image2Api(path, body));
  if (queue.current === null) queue.current = new ImageCommandQueue(image2Storage, async (id, body) => unwrapDocument(await image2Api<ImageDocument | { document: ImageDocument }>(`/documents/${id}/commands`, body)));
  const recoverSubmissions = useCallback(async (id: string) => {
    try { await submissions.current!.recover(id, value => { const receipt = value as { job?: ImageJob }; if (receipt.job) setJobs(prev => [receipt.job!, ...prev.filter(job => job.id !== receipt.job!.id)]); }); }
    catch (err) { setError(`提交结果还未确认，原请求已保留：${(err as Error).message}`); }
    setSubmissionCount((await submissions.current!.pending(id)).length);
  }, []);
  const frozenSubmit = async <T,>(path: string, intent: Record<string, unknown>, body: Record<string, unknown>): Promise<T> => {
    try { return await submissions.current!.submit<T>(path, intent, body); }
    finally { setSubmissionCount((await submissions.current!.pending(String(intent.documentId))).length); }
  };
  const acceptDocument = useCallback((next: ImageDocument) => {
    if (!mounted.current) return;
    if (canonical.current && canonical.current.id !== next.id) return;
    if (canonical.current && canonical.current.revision > next.revision) return;
    canonical.current = next; setDocument(next); setDocuments(prev => [next, ...prev.filter(item => item.id !== next.id)]); void image2Storage.saveDocument(next);
  }, []);
  const updatePending = async (id: string) => { if (mounted.current && canonical.current?.id === id) setPending(await queue.current!.pending(id)); };
  const flush = useCallback(async () => {
    const current = canonical.current; if (!current) return;
    try { await queue.current!.flush(current, acceptDocument); setStatus('已保存'); } catch (err) { setError((err as Error).message); setStatus(err instanceof Image2ApiError && err.status === 409 ? '有版本冲突，本地修改已保留' : '本地修改已保留，联网后继续保存'); }
    await updatePending(current.id);
  }, [acceptDocument]);
  const submit = useCallback(async (commands: DocumentCommand[]) => {
    const current = canonical.current; if (!current || !commands.length) return;
    try { await queue.current!.enqueue(current.id, commands); await updatePending(current.id); setStatus('正在保存…'); await flush(); } catch (err) { setError((err as Error).message); }
  }, [flush]);
  const open = useCallback(async (id: string) => {
    setError(''); setSelectedId(undefined); setPickedLayers([]); setConversation(null); setMessages([]); canonical.current = null;
    try {
      const next = unwrapDocument(await image2Api<ImageDocument | { document: ImageDocument }>(`/documents/${id}`));
      canonical.current = next; setDocument(next); setDocuments(prev => [next, ...prev.filter(item => item.id !== next.id)]); localStorage.setItem('image2-document', id); await image2Storage.saveDocument(next); await updatePending(id);
      await queue.current!.flush(next, acceptDocument); await updatePending(id); await recoverSubmissions(id); setStatus('已保存');
    } catch (err) {
      if (!(err instanceof Image2ApiError) || err.status >= 500) { const cached = await cachedDocument(id); if (cached) { canonical.current = cached; setDocument(cached); await updatePending(id); } }
      setError((err as Error).message); setStatus('暂时无法连接，保留本地草稿');
    }
  }, [acceptDocument, recoverSubmissions]);
  const create = useCallback(async () => {
    try { const next = unwrapDocument(await image2Api<ImageDocument | { document: ImageDocument }>('/documents', { name: `设计 ${documents.length + 1}`, width: 1024, height: 1024 })); setDocuments(prev => [...prev, next]); await open(next.id); } catch (err) { setError((err as Error).message); }
  }, [documents.length, open]);
  useEffect(() => {
    mounted.current = true;
    void (async () => {
      try {
        const [list, caps] = await Promise.all([image2Api<ImageDocument[] | Record<string, unknown>>('/documents'), image2Api<Capabilities>('/capabilities')]);
        const docs = listValue<ImageDocument>(list, 'documents'); setDocuments(docs); setCapabilities(caps);
        const remembered = localStorage.getItem('image2-document'), first = docs.find(item => item.id === remembered) || docs[0];
        if (first) await open(first.id); else { setStatus('上传图片或添加文字开始'); }
      } catch (err) { setDocuments(await cachedDocuments()); setError((err as Error).message); setStatus('工作台服务暂不可用'); }
    })();
    const online = () => { void flush(); }; window.addEventListener('online', online);
    return () => { mounted.current = false; window.removeEventListener('online', online); };
  }, [open, flush]);
  useEffect(() => {
    if (!document?.id) return;
    const id = document.id; let cancelled = false, polling = false;
    const poll = async () => {
      if (polling) return; polling = true;
      try {
        const [doc, assetList, jobList, branchList, conversations] = await Promise.all([
          image2Api<ImageDocument | { document: ImageDocument }>(`/documents/${id}`), image2Api<ImageAsset[] | Record<string, unknown>>(`/documents/${id}/assets`),
          image2Api<ImageJob[] | Record<string, unknown>>(`/documents/${id}/jobs`), image2Api<ImageDocument[] | Record<string, unknown>>(`/documents/${id}/branches`),
          image2Api<Conversation[] | Record<string, unknown>>(`/conversations?documentId=${encodeURIComponent(id)}`),
        ]);
        if (cancelled || canonical.current?.id !== id) return;
        const next = unwrapDocument(doc); if (next.revision !== canonical.current.revision) acceptDocument(next);
        const nextAssets = listValue<ImageAsset>(assetList, 'assets'); setAssets(nextAssets); setJobs(listValue<ImageJob>(jobList, 'jobs')); setBranches(listValue<ImageDocument>(branchList, 'branches'));
        const list = listValue<Conversation>(conversations, 'conversations'), selected = list[0];
        if (selected) { setConversation(selected); const data = await image2Api<ConversationMessage[] | Record<string, unknown>>(`/conversations/${selected.id}/messages`); if (!cancelled) setMessages(listValue<ConversationMessage>(data, 'messages')); }
      } catch (err) { if (!cancelled) setStatus(`同步暂停：${(err as Error).message}`); } finally { polling = false; }
    };
    void poll(); const timer = setInterval(() => void poll(), 2500); return () => { cancelled = true; clearInterval(timer); };
  }, [document?.id, acceptDocument]);
  useEffect(() => {
    for (const asset of assets.filter(item => /font|woff|ttf|otf/.test(item.mime) || /\.(woff2?|ttf|otf)$/i.test(item.name))) {
      const family = `i2-${asset.id}`; if (documentFonts.has(family)) continue; documentFonts.add(family);
      new FontFace(family, `url("${assetUrl(asset.id)}")`).load().then(face => window.document.fonts.add(face)).catch(() => { documentFonts.delete(family); setError(`字体「${asset.name}」无法读取，请选择其他字体`); });
    }
  }, [assets]);
  const draft = useMemo(() => document ? applyDraft(document, pending) : null, [document, pending]);
  const selected = draft?.layers.find(layer => layer.id === selectedId), fonts = assets.filter(asset => /font|woff|ttf|otf/.test(asset.mime) || /\.(woff2?|ttf|otf)$/i.test(asset.name));
  const fontCandidates = (Array.isArray(selected?.metadata?.fontCandidates) ? selected.metadata.fontCandidates : [])
    .filter((item): item is { family: string; estimatedFontSize?: number } => !!item && typeof item === 'object' && typeof item.family === 'string').slice(0, 3);
  const busy = acting || pending.some(batch => batch.state === 'blocked');
  const act = async (fn: () => Promise<void>) => { setActing(true); setError(''); try {
    await flush(); const waiting = canonical.current ? await queue.current!.pending(canonical.current.id) : [];
    if (waiting.length) throw new Error('先保存或处理本地修改，再执行图片处理');
    // A server-side job may have completed since the last background poll.
    if (canonical.current) acceptDocument(unwrapDocument(await image2Api<ImageDocument | { document: ImageDocument }>(`/documents/${canonical.current.id}`)));
    await fn();
  } catch (err) { setError((err as Error).message); } finally { setActing(false); } };
  const upload = async (file: File, font = false) => {
    await act(async () => {
      let current = canonical.current;
      if (!current) { current = unwrapDocument(await image2Api<ImageDocument | { document: ImageDocument }>('/documents', { name: file.name, width: 1024, height: 1024 })); canonical.current = current; acceptDocument(current); }
      const asset = await uploadAsset(current.id, file, file.name, { role: font ? 'font' : /svg/i.test(file.type) ? 'logo' : 'source' });
      setAssets(prev => [...prev.filter(item => item.id !== asset.id), asset]); if (font) return;
      const first = current.layers.length === 0;
      const layer = { ...blankLayer(/svg/i.test(file.type) ? 'vector' : 'raster', file.name), x: first ? 0 : 40, y: first ? 0 : 40, width: asset.width || 1024, height: asset.height || 1024, assetId: asset.id, sourceAssetId: asset.id, ...(!/svg/i.test(file.type) && asset.width && asset.height ? { sourceRect: [0, 0, asset.width, asset.height] as [number, number, number, number] } : {}), z: current.layers.length, editability: /svg/i.test(file.type) ? 'path' as const : 'pixels' as const };
      await submit([...(first ? [{ type: 'document.update' as const, patch: { width: layer.width, height: layer.height } }] : []), { type: 'layer.add', layer }]); setSelectedId(layer.id);
    });
  };
  const runOperation = async (name = operation) => act(async () => {
    const current = canonical.current; if (!current) return;
    const target = current.layers.find(layer => layer.id === selectedId);
    if (!target && name !== 'generate') throw new Error('这个图层已发生变化，请重新选择要修改的图层');
    if (!capability(capabilities, name).available) throw new Error(capability(capabilities, name).reason || '功能不可用');
    const fields: Record<string, string[]> = { resize: ['width', 'height'], crop: ['x', 'y', 'width', 'height'], pad: ['width', 'height', 'color'], rotate: ['degrees'], flip: ['axis'], recolor: ['color'], fill: ['color'], repair: [], color_key: ['color', 'tolerance'], trace: ['preset'], super_resolution: ['scale'], inpaint: ['prompt'], generate: ['prompt'] };
    const params: Record<string, unknown> = {}; for (const field of fields[name] || []) params[field === 'color' && name === 'pad' ? 'fill' : field] = ['width', 'height', 'x', 'y', 'degrees', 'tolerance', 'scale'].includes(field) ? Number(operationParams[field]) : operationParams[field];
    if (name === 'recolor') params.preserveLuminance = true;
    if (target?.type === 'text' && target.assetId && target.metadata?.fontConfirmed !== true && ['prepare_text', 'repair', 'inpaint', 'fill'].includes(name)) params.purpose = 'text_background';
    const storedEdit = name === 'refine_mask' ? target?.metadata?.visibilityMaskAssetId : target?.metadata?.editMaskAssetId;
    const storedProtect = name === 'refine_mask' ? target?.metadata?.visibilityProtectMaskAssetId : target?.metadata?.protectMaskAssetId;
    const masks = target ? (name === 'refine_mask' ? undefined : maskRefs[target.id]) || (typeof storedEdit === 'string' && typeof storedProtect === 'string' ? { edit: storedEdit, protect: storedProtect } : undefined) : undefined;
    const inputs = [...(target?.assetId ? [{ role: 'base', assetId: target.assetId }] : []), ...(masks ? [{ role: 'edit_mask', assetId: masks.edit }, { role: 'protect_mask', assetId: masks.protect }] : [])];
    if (['inpaint', 'erase', 'repair', 'fill', 'refine_mask'].includes(name) && !masks) throw new Error('先选择修改和保护范围');
    const result = await frozenSubmit<{ job: ImageJob }>('/operations', { documentId: current.id, operation: name, targetLayerId: selectedId, params, masks }, { documentId: current.id, baseRevision: current.revision, targetLayerId: target?.id, operation: name, params, inputs, mode: ['restore_layers', 'generate', 'inpaint'].includes(name) ? 'candidate' : 'apply' });
    setJobs(prev => [result.job, ...prev]); setStatus('已开始处理，可以继续查看其他图层');
  });
  const sendChat = async () => act(async () => {
    const current = canonical.current; if (!current || !chat.trim()) return;
    let thread = conversation; if (!thread) { thread = await image2Api<Conversation>('/conversations', { documentId: current.id }); setConversation(thread); }
    const result = await frozenSubmit<{ job: ImageJob }>(`/conversations/${thread.id}/messages`, { documentId: current.id, conversationId: thread.id, text: chat.trim(), layerId: selected?.id }, { text: chat.trim(), references: selected ? [{ layerId: selected.id, assetId: selected.assetId, revision: current.revision }] : [] });
    setChat(''); setJobs(prev => [result.job, ...prev]); const data = await image2Api<ConversationMessage[] | Record<string, unknown>>(`/conversations/${thread.id}/messages`); setMessages(listValue<ConversationMessage>(data, 'messages'));
  });
  const patch = (value: Partial<ImageLayer>) => { if (selected) void submit([{ type: 'layer.update', layerId: selected.id, patch: value }]); };
  const builtInFont = async () => {
    const current = canonical.current!;
    const asset = await image2Api<ImageAsset>('/assets/default-font', { documentId: current.id });
    setAssets(prev => [...prev.filter(item => item.id !== asset.id), asset]); return asset;
  };
  const confirmFont = async (font: ImageAsset) => {
    let current = canonical.current!, target = current.layers.find(layer => layer.id === selectedId);
    if (!target) throw new Error('请选择要修改的文字图层');
    if (target.assetId && target.metadata?.fontConfirmed !== true && typeof target.metadata?.cleanBackgroundAssetId !== 'string') {
      if (!capability(capabilities, 'prepare_text').available) throw new Error('请先选择原字范围，清理原字背景后再确认字体');
      setStatus('正在清理原字背景…');
      const storedEdit = target.metadata?.editMaskAssetId, storedProtect = target.metadata?.protectMaskAssetId;
      const masks = maskRefs[target.id] || (typeof storedEdit === 'string' && typeof storedProtect === 'string' ? { edit: storedEdit, protect: storedProtect } : undefined);
      const result = await frozenSubmit<{ job: ImageJob }>('/operations', { documentId: current.id, operation: 'prepare_text', targetLayerId: target.id, masks }, { documentId: current.id, baseRevision: current.revision, operation: 'prepare_text', targetLayerId: target.id,
        inputs: [{ role: 'base', assetId: target.assetId }, ...(masks ? [{ role: 'edit_mask', assetId: masks.edit }, { role: 'protect_mask', assetId: masks.protect }] : [])],
        params: { purpose: 'text_background' }, mode: 'apply' });
      setJobs(prev => [result.job, ...prev.filter(job => job.id !== result.job.id)]);
      let completed = false;
      for (let attempt = 0; attempt < 120; attempt++) {
        const job = await image2Api<ImageJob>(`/jobs/${result.job.id}`);
        if (job.state === 'complete') { completed = true; break; }
        if (['failed', 'uncertain', 'cancelled', 'awaiting_user'].includes(job.state)) throw new Error(job.error || '原字背景还未清理，请选择范围后使用传统修补或局部补画');
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      if (!completed) throw new Error('文字背景仍在处理中；结果会保留，请稍后再确认字体');
      current = unwrapDocument(await image2Api<ImageDocument | { document: ImageDocument }>(`/documents/${current.id}`)); acceptDocument(current);
      target = current.layers.find(layer => layer.id === selectedId);
      if (!target || typeof target.metadata?.cleanBackgroundAssetId !== 'string') throw new Error('请先完成原字背景清理，保留原字形等待确认');
    }
    const commands: DocumentCommand[] = [];
    const metadata = { ...target.metadata };
    if (target.assetId && target.metadata?.fontConfirmed !== true && target.metadata?.backgroundDetached !== true && typeof target.metadata?.cleanBackgroundAssetId === 'string') {
      const background: ImageLayer = { id: crypto.randomUUID(), type: 'raster', name: `${target.name} · 文字背景`, x: target.x, y: target.y, width: target.width, height: target.height,
        rotation: target.rotation, opacity: target.opacity, visible: target.visible, locked: false, z: target.z - .01, ...(target.parentId ? { parentId: target.parentId } : {}),
        assetId: target.metadata.cleanBackgroundAssetId, sourceAssetId: target.sourceAssetId || target.assetId, metadata: { role: 'text_background', sourceTextLayerId: target.id } };
      commands.push({ type: 'layer.add', layer: background }); Object.assign(metadata, { backgroundDetached: true, backgroundLayerId: background.id });
    }
    commands.push({ type: 'layer.update', layerId: target.id, patch: { fontAssetId: font.id, fontFamily: String(font.metadata?.family || ''),
      text: String(target.metadata?.fontConfirmed === true ? target.text || '' : target.metadata?.desiredText ?? target.text ?? ''),
      metadata: { ...metadata, desiredText: null, fontConfirmed: true, fontStatus: 'confirmed' } } });
    await submit(commands);
  };
  const operationLabels: Record<string, string> = { resize: '调整像素尺寸', crop: '裁切', pad: '扩展画布', rotate: '旋转像素', flip: '翻转', recolor: '换色并保留明暗', erase: '清除为透明', repair: '传统修补', fill: '局部填色', prepare_text: '清理原字背景', refine_mask: '修正图层轮廓', color_key: '纯色去底', trace: '转为矢量', matting: '精细去底', segment: '识别对象', super_resolution: '超分辨率', restore_layers: '还原全部图层', inpaint: '局部补画', generate: '创作新图片' };
  return <main className="i2-workspace">
    <header className="i2-topbar"><Link href="/">← 视觉工作台</Link><strong>图片工作台 2.0</strong><span className="i2-save-status" role="status">{status}{pending.length ? ` · ${pending.length} 项本地修改` : ''}</span>
      {document?.parentDocumentId && <button onClick={() => void open(document.parentDocumentId!)}>返回主设计</button>}
      {submissionCount > 0 && <button onClick={() => { if (document) void recoverSubmissions(document.id); }}>恢复提交结果（{submissionCount}）</button>}
      <button onClick={() => void create()}>新设计</button><button onClick={() => uploadRef.current?.click()}>上传图片 / Logo</button><button onClick={() => fontRef.current?.click()}>上传字体</button><button onClick={() => importRef.current?.click()}>导入工程</button></header>
    {error && <div className="i2-error" role="alert">{error}<button onClick={() => setError('')}>关闭</button></div>}
    {pending.some(batch => batch.state === 'blocked') && <div className="i2-conflict"><span>主版本有变化，本地修改已保留。</span><button onClick={() => void flush()}>重试保存</button><button onClick={() => { if (window.confirm('放弃这些本地修改并重新打开主版本？')) void queue.current!.discard(document!.id).then(() => open(document!.id)); }}>放弃本地修改并刷新</button></div>}
    <div className="i2-body"><aside className="i2-layers">
      <label>设计<select aria-label="选择设计" value={document?.id || ''} onChange={e => void open(e.target.value)}><option value="" disabled>选择设计</option>{documents.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <div className="i2-panel-title"><strong>图层</strong><button disabled={!draft || busy} onClick={() => void act(async () => {
        const font = (capabilities.defaultFont as { available?: boolean } | undefined)?.available === false ? fonts[0] : await builtInFont();
        if (!font) throw new Error('请先上传一个中文字体，再添加文字');
        const layer = { ...blankLayer('text', '中文文字'), text: '在这里输入文字', fontAssetId: font.id, fontFamily: String(font.metadata?.family || ''), fontSize: 48, fill: '#20232b', metadata: { fontConfirmed: true }, editability: 'text' as const, z: draft!.layers.length }; await submit([{ type: 'layer.add', layer }]); setSelectedId(layer.id);
      })}>＋ 文字</button></div>
      <div className="i2-layer-list">{draft && orderedLayers(draft.layers).reverse().map(layer => <div key={layer.id} className={selectedId === layer.id ? 'i2-layer active' : 'i2-layer'} style={{ paddingLeft: layer.parentId ? 22 : 8 }}>
        <input type="checkbox" aria-label={`选入组合 ${layer.name}`} checked={pickedLayers.includes(layer.id)} disabled={layer.locked} onChange={e => setPickedLayers(prev => e.target.checked ? [...prev, layer.id] : prev.filter(id => id !== layer.id))} />
        <button className="i2-layer-name" onClick={() => setSelectedId(layer.id)}>{layer.type === 'text' ? '文' : layer.type === 'vector' ? '形' : '图'} · {layer.name}</button>
        <button aria-label={`${layer.name}${layer.visible ? '隐藏' : '显示'}`} onClick={() => void submit([{ type: 'layer.update', layerId: layer.id, patch: { visible: !layer.visible } }])}>{layer.visible ? '◉' : '○'}</button>
        <button aria-label={`${layer.name}${layer.locked ? '解锁' : '锁定'}`} onClick={() => void submit([{ type: 'layer.update', layerId: layer.id, patch: { locked: !layer.locked } }])}>{layer.locked ? '🔒' : '◇'}</button></div>)}</div>
      <div className="i2-row"><button disabled={busy || pickedLayers.length < 2} onClick={() => void act(async () => { const id = crypto.randomUUID(); await submit(groupLayerCommands(canonical.current!, pickedLayers, id)); setPickedLayers([]); setSelectedId(id); })}>编组所选图层</button><button disabled={busy || selected?.type !== 'group'} onClick={() => void act(async () => { await submit(ungroupLayerCommands(canonical.current!, selectedId!)); setSelectedId(undefined); })}>拆开组合</button></div>
      <section className="i2-templates"><strong>模板排版</strong><label>版式<select aria-label="模板版式" value={templateKind} onChange={e => setTemplateKind(e.target.value as TemplateKind)}>{Object.entries(templateNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <button disabled={!document || busy} onClick={() => void act(async () => {
          const current = canonical.current!;
          const font = (capabilities.defaultFont as { available?: boolean } | undefined)?.available === false ? fonts[0] : await builtInFont();
          if (!font) throw new Error('请先上传中文字体，再使用模板');
          const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${current.width}" height="${current.height}" viewBox="0 0 ${current.width} ${current.height}"><rect width="100%" height="100%" fill="#ffffff"/></svg>`;
          const paperAsset = await uploadAsset(current.id, new Blob([svg], { type: 'image/svg+xml' }), 'template-paper.svg', { role: 'template_background' });
          const ready = unwrapDocument(await image2Api<ImageDocument | { document: ImageDocument }>(`/documents/${current.id}`)); acceptDocument(ready);
          const commands = buildTemplate({ document: ready, selected: ready.layers.find(layer => layer.id === selectedId), font, kind: templateKind, paperAsset });
          await submit(commands); const group = commands.find(command => command.type === 'layer.add' && command.layer.type === 'group'); if (group?.type === 'layer.add') setSelectedId(group.layer.id);
          setStatus('模板已添加到画布右侧，可逐层编辑');
        })}>添加可编辑模板</button><p>使用现有图片、Logo 和实际字体，添加到画布右侧。</p></section>
      {draft && <section className="i2-document-properties"><strong>画布尺寸</strong><div className="i2-property-grid">{(['width', 'height'] as const).map(field => <label key={field}>{field === 'width' ? '画布宽' : '画布高'}<input key={`${draft.id}-${field}-${draft[field]}`} type="number" min="1" defaultValue={draft[field]} onBlur={e => { const value = Number(e.target.value); if (Number.isInteger(value) && value > 0 && value !== draft[field]) void submit([{ type: 'document.update', patch: { [field]: value } }]); }} /></label>)}</div></section>}
      <div className="i2-export"><strong>保存与导出</strong>{(['project', 'svg', 'pdf', 'png'] as const).map(format => <button key={format} disabled={!document || busy} onClick={() => void act(async () => { const current = canonical.current!; const result = await frozenSubmit<{ job: ImageJob }>('/exports', { documentId: current.id, format }, { documentId: current.id, format, baseRevision: current.revision }); setJobs(prev => [result.job, ...prev.filter(job => job.id !== result.job.id)]); })}>{format === 'project' ? '可编辑工程 ZIP' : format.toUpperCase()}</button>)}
        <div className="i2-row"><button disabled={!document || busy} onClick={() => void act(async () => acceptDocument(unwrapDocument(await image2Api(`/documents/${document!.id}/history`, { baseRevision: canonical.current!.revision, commandId: crypto.randomUUID(), direction: 'undo' }))))}>撤销</button><button disabled={!document || busy} onClick={() => void act(async () => acceptDocument(unwrapDocument(await image2Api(`/documents/${document!.id}/history`, { baseRevision: canonical.current!.revision, commandId: crypto.randomUUID(), direction: 'redo' }))))}>重做</button></div></div>
    </aside>
      <section className="i2-stage">{draft ? <DocumentCanvas document={draft} selectedId={selectedId} onSelect={setSelectedId} onCommands={commands => void submit(commands)} /> : <div className="i2-empty"><h1>先放一张图，再精确修改</h1><p>还原图层、改中文字、保留原版，继续完成你的设计。</p><button className="primary" onClick={() => uploadRef.current?.click()}>上传图片</button></div>}</section>
      <aside className="i2-details">{selected ? <><h2>{selected.name}</h2><label>图层名称<input key={`${selected.id}-name`} defaultValue={selected.name} onBlur={e => { if (e.target.value !== selected.name) patch({ name: e.target.value }); }} /></label>
        <label>图层类型<select aria-label="图层类型" disabled={['group', 'vector'].includes(selected.type) || (selected.type === 'text' && selected.metadata?.fontConfirmed === true)} value={selected.type} onChange={e => {
          const type = e.target.value as ImageLayer['type'];
          patch({ type, ...(type === 'text' && selected.type !== 'text' ? { text: selected.text || '', editability: 'text' as const, metadata: { ...selected.metadata, sourcePatchAssetId: selected.assetId, fontConfirmed: false, fontStatus: 'unknown' } } : {}) });
        }}><option value="raster">图片</option><option value="text">文字</option>{selected.type === 'vector' && <option value="vector">矢量 Logo</option>}{selected.type === 'group' && <option value="group">组合</option>}<option value="mask">辅助蒙版</option></select></label>
        <div className="i2-property-grid">{(['x', 'y', 'width', 'height', 'rotation', 'opacity'] as const).map(field => <label key={field}>{({ x: '横向位置', y: '纵向位置', width: '宽度', height: '高度', rotation: '角度', opacity: '不透明度' })[field]}<input key={`${selected.id}-${field}-${selected[field]}`} aria-label={field} type="number" disabled={field === 'opacity' && selected.type === 'group'} step={field === 'opacity' ? .1 : 1} defaultValue={selected[field]} onBlur={e => { const value = Number(e.target.value); if (Number.isFinite(value) && value !== selected[field]) patch({ [field]: value }); }} /></label>)}</div>
        {selected.type === 'group' && <p>组合的整体透明度暂不支持调整；各图片和文字可单独调整。</p>}
        <div className="i2-row"><button onClick={() => void act(async () => submit(reorderSiblingCommands(draft!.layers, selected.id, 1)))}>上移一层</button><button onClick={() => void act(async () => submit(reorderSiblingCommands(draft!.layers, selected.id, -1)))}>下移一层</button><button onClick={() => { void submit([{ type: 'layer.remove', layerId: selected.id }]); setSelectedId(undefined); }}>删除</button></div>
        {selected.type === 'text' && <section className="i2-text-properties"><h3>中文文字与字体</h3>{selected.metadata?.fontConfirmed !== true && <p>目前保留原字形。确认字体后，改字才会使用真实字体渲染。</p>}
          {selected.metadata?.fontConfirmed !== true && fontCandidates.length > 0 && <div aria-label="字体候选"><p>按字形尺寸拟合，原字体仍待确认。</p>{fontCandidates.map((candidate, index) => <p key={index}>{candidate.family}{Number.isFinite(candidate.estimatedFontSize) ? ` · 建议字号 ${candidate.estimatedFontSize}` : ''}</p>)}</div>}
          <textarea aria-label="文字内容" key={`${selected.id}-text-${selected.text}-${selected.metadata?.desiredText}`} defaultValue={String(selected.metadata?.fontConfirmed === true ? selected.text || '' : selected.metadata?.desiredText ?? selected.text ?? '')} onBlur={e => {
            if (selected.metadata?.fontConfirmed !== true) patch({ metadata: { ...selected.metadata, desiredText: e.target.value } });
            else if (e.target.value !== selected.text) patch({ text: e.target.value });
          }} />
          <label>字体<select aria-label="确认字体" disabled={busy} value={selected.fontAssetId || ''} onChange={e => { const font = fonts.find(item => item.id === e.target.value); if (font) void act(() => confirmFont(font)); }}><option value="">选择已上传字体</option>{fonts.map(font => <option key={font.id} value={font.id}>{font.name}</option>)}</select></label>
          <button disabled={busy || (capabilities.defaultFont as { available?: boolean } | undefined)?.available === false} onClick={() => void act(async () => confirmFont(await builtInFont()))}>使用内置中文字体</button>
          {(['fontSize', 'fontWeight', 'tracking', 'lineHeight', 'strokeWidth'] as const).map(field => <label key={field}>{({ fontSize: '字号', fontWeight: '字重', tracking: '字距', lineHeight: '行距倍数', strokeWidth: '描边宽度' })[field]}<input type="number" step={field === 'fontWeight' ? 100 : .1} key={`${selected.id}-${field}-${selected[field]}`} defaultValue={selected[field] || (field === 'fontSize' ? 24 : field === 'fontWeight' ? 400 : field === 'lineHeight' ? 1.2 : 0)} onBlur={e => patch({ [field]: Number(e.target.value) })} /></label>)}
          <label>描边颜色<input type="color" value={selected.stroke?.startsWith('#') ? selected.stroke : '#000000'} onChange={e => patch({ stroke: e.target.value, strokeWidth: selected.strokeWidth || 1 })} /></label>
        </section>}
        {selected.type === 'text' && <label>填色<input type="color" value={selected.fill?.startsWith('#') ? selected.fill : '#20232b'} onChange={e => patch({ fill: e.target.value })} /></label>}
        {selected.type === 'vector' && <VectorProperties key={selected.id} layer={selected} onPatch={patch} />}
        {selected.assetId && selected.type !== 'group' && !(selected.type === 'text' && selected.metadata?.fontConfirmed === true) && <section className="i2-operation-panel"><h3>修改图片</h3><button disabled={busy} onClick={() => void act(async () => { setMaskPurpose('edit'); setShowMasks(true); })}>选择修改 / 保护范围{maskRefs[selected.id] || selected.metadata?.editMaskAssetId ? ' ✓' : ''}</button>
          <button disabled={busy || !capability(capabilities, 'refine_mask').available} onClick={() => void act(async () => { setMaskPurpose('visibility'); setShowMasks(true); })}>修正图层轮廓</button>
          <select aria-label="图片处理" value={operation} onChange={e => setOperation(e.target.value)}>{Object.entries(operationLabels).filter(([name]) => name !== 'refine_mask').map(([name, label]) => <option key={name} value={name}>{label}</option>)}</select>
          {['resize', 'crop', 'pad'].includes(operation) && <div className="i2-property-grid">{['width', 'height', ...(operation === 'crop' ? ['x', 'y'] : [])].map(field => <label key={field}>{field === 'width' ? '像素宽' : field === 'height' ? '像素高' : field}<input type="number" value={operationParams[field]} onChange={e => setOperationParams(prev => ({ ...prev, [field]: e.target.value }))} /></label>)}</div>}
          {['resize', 'super_resolution'].includes(operation) && <p>更新图片像素，保留画布位置和尺寸。</p>}
          {['recolor', 'color_key', 'pad', 'fill'].includes(operation) && <input aria-label="处理颜色" type="color" value={operationParams.color} onChange={e => setOperationParams(prev => ({ ...prev, color: e.target.value }))} />}
          {operation === 'color_key' && <label>颜色容差<input type="number" min="0" max="255" value={operationParams.tolerance} onChange={e => setOperationParams(prev => ({ ...prev, tolerance: e.target.value }))} /></label>}
          {operation === 'rotate' && <label>角度<input type="number" value={operationParams.degrees} onChange={e => setOperationParams(prev => ({ ...prev, degrees: e.target.value }))} /></label>}
          {operation === 'flip' && <select value={operationParams.axis} onChange={e => setOperationParams(prev => ({ ...prev, axis: e.target.value }))}><option value="horizontal">左右翻转</option><option value="vertical">上下翻转</option></select>}
          {operation === 'super_resolution' && <select value={operationParams.scale} onChange={e => setOperationParams(prev => ({ ...prev, scale: e.target.value }))}><option value="2">2 倍超分辨率</option><option value="4">4 倍超分辨率</option></select>}
          {operation === 'trace' && <select value={operationParams.preset} onChange={e => setOperationParams(prev => ({ ...prev, preset: e.target.value }))}><option value="logo">Logo 轮廓</option><option value="monochrome">黑白网点</option><option value="color">保留颜色</option><option value="posterized2">简化色块</option></select>}
          {['inpaint', 'generate'].includes(operation) && <textarea aria-label="修改要求" placeholder="描述要修改的内容" value={operationParams.prompt} onChange={e => setOperationParams(prev => ({ ...prev, prompt: e.target.value }))} />}
          {!capability(capabilities, operation).available && <p className="i2-unavailable">{capability(capabilities, operation).reason || '此功能尚未配置'}</p>}
          <button className="primary" disabled={busy || !capability(capabilities, operation).available} onClick={() => void runOperation()}>{operationLabels[operation]}</button>
          <button disabled={busy || !capability(capabilities, 'restore_layers').available} onClick={() => void runOperation('restore_layers')}>自动还原整图图层</button>
        </section>}
      </> : <p>选择图层后修改位置、颜色、文字和图片。</p>}
        {!selected && document && <section className="i2-operation-panel"><h3>创作新图片</h3><textarea aria-label="新图片要求" value={operationParams.prompt} placeholder="描述你想创作的画面" onChange={e => setOperationParams(prev => ({ ...prev, prompt: e.target.value }))} /><button disabled={busy || !capability(capabilities, 'generate').available || !operationParams.prompt.trim()} onClick={() => void runOperation('generate')}>创作候选版本</button>{!capability(capabilities, 'generate').available && <p>{capability(capabilities, 'generate').reason}</p>}</section>}
        <section className="i2-candidates"><h3>候选版本</h3>{document?.parentDocumentId && <button className="primary" disabled={busy} onClick={() => void act(async () => { const branch = canonical.current!; const parent = unwrapDocument(await image2Api<ImageDocument | { document: ImageDocument }>(`/documents/${branch.parentDocumentId}`)); const accepted = unwrapDocument(await image2Api<ImageDocument | { document: ImageDocument }>(`/documents/${parent.id}/accept`, { branchDocumentId: branch.id, baseRevision: parent.revision, commandId: crypto.randomUUID() })); canonical.current = accepted; acceptDocument(accepted); })}>接受到主设计</button>}{branches.map(branch => <div key={branch.id}><span>{branch.name}</span><button onClick={() => void open(branch.id)}>查看</button><button disabled={busy} onClick={() => void act(async () => { const current = canonical.current!; acceptDocument(unwrapDocument(await image2Api(`/documents/${current.id}/accept`, { branchDocumentId: branch.id, baseRevision: current.revision, commandId: crypto.randomUUID() }))); })}>接受</button></div>)}</section>
        <section className="i2-jobs"><h3>处理进度</h3>{jobs.map(job => <article key={job.id}><strong>{operationLabels[job.operation || String((job.output?.metadata as Record<string, unknown> | undefined)?.operation || '') || job.kind] || ({ operation: '图片处理', export: '导出', agent: '连续改图' })[job.kind as 'operation' | 'export' | 'agent'] || '处理任务'}</strong><span>{({ queued: '等待中', running: '处理中', complete: '已完成', failed: '未完成', uncertain: '等待确认', cancelled: '已停止', awaiting_user: '需要你确认' })[job.state]}</span>{job.stage && job.state !== 'complete' && !['queued', 'complete', 'running'].includes(job.stage) && <small>{({ acceptance_unknown: '接收状态尚未确定', resuming: '恢复处理中', processing: '正在处理', asset_checkpointed: '结果已保存', preparing: '准备处理中', cancel_requested: '正在停止' })[job.stage as 'acceptance_unknown' | 'resuming' | 'processing' | 'asset_checkpointed' | 'preparing' | 'cancel_requested'] || '正在处理'}</small>}{job.error && <p>{job.error}</p>}
          {job.state === 'complete' && typeof job.output?.assetId === 'string' && <a href={assetUrl(job.output.assetId)} download={String(job.output.filename || 'design')}>下载结果</a>}
          {job.state === 'complete' && job.metrics && <small>耗时 {(job.metrics.totalMs / 1000).toFixed(1)} 秒 · 生成 {job.metrics.generationCalls} 次{job.metrics.queueMs >= 1000 ? ` · 等待 ${(job.metrics.queueMs / 1000).toFixed(1)} 秒` : ''}</small>}
          {job.operation === 'restore_layers' && job.output?.fonts === 'unknown' && <p>已保留原图像素；文字、字体和遮挡部分还需要确认。</p>}
          {activeStates.has(job.state) && <button onClick={() => void act(async () => { await image2Api(`/jobs/${job.id}/cancel`, {}); })}>停止</button>}
          {job.retryable && job.state === 'failed' && <button onClick={() => void act(async () => { await image2Api(`/jobs/${job.id}/retry`, { idempotencyKey: crypto.randomUUID() }); })}>重试</button>}</article>)}</section>
        <section className="i2-chat"><h3>设计助手</h3><div className="i2-messages">{messages.map(message => <p key={message.id} className={message.role === 'user' ? 'user' : ''}>{message.text || message.content}</p>)}</div>
          <textarea aria-label="设计助手输入" value={chat} placeholder="描述设计方向，或说明选中图层要改哪里" onChange={e => setChat(e.target.value)} />
          <button disabled={busy || !chat.trim() || !(capabilities.agent && (capabilities.agent as { available?: boolean }).available)} onClick={() => void sendChat()}>发送</button>
          {!(capabilities.agent && (capabilities.agent as { available?: boolean }).available) && <small>设计助手尚未配置；现有图层仍可直接编辑。</small>}
        </section>
      </aside></div>
    <input ref={uploadRef} hidden type="file" accept="image/*,.svg" onChange={e => { const file = e.target.files?.[0]; if (file) void upload(file); e.target.value = ''; }} />
    <input ref={fontRef} hidden type="file" accept=".ttf,.otf,.woff,.woff2" onChange={e => { const file = e.target.files?.[0]; if (file) void upload(file, true); e.target.value = ''; }} />
    <input ref={importRef} hidden type="file" accept=".zip" onChange={e => { const file = e.target.files?.[0]; if (file) void act(async () => { const { blobBase64 } = await import('../../lib/studio/client'); const next = unwrapDocument(await image2Api<ImageDocument | { document: ImageDocument }>('/imports/project', { data: await blobBase64(file) })); await open(next.id); }); e.target.value = ''; }} />
    {showMasks && selected?.assetId && <MaskEditor layer={selected} purpose={maskPurpose} onClose={() => setShowMasks(false)} onSave={async (edit, protect) => {
      await flush(); if ((await queue.current!.pending(canonical.current!.id)).length) throw new Error('请先处理本地修改，再保存范围');
      const current = unwrapDocument(await image2Api<ImageDocument | { document: ImageDocument }>(`/documents/${canonical.current!.id}`)); acceptDocument(current);
      const target = current.layers.find(layer => layer.id === selected.id); if (!target) throw new Error('这个图层已发生变化，请重新选择');
      const [editAsset, protectAsset] = await Promise.all([uploadAsset(current.id, edit, 'edit-mask.png', { role: maskPurpose === 'visibility' ? 'visibility_mask' : 'edit_mask', layerId: selected.id }), uploadAsset(current.id, protect, 'protect-mask.png', { role: 'protect_mask', layerId: selected.id })]);
      if (maskPurpose === 'edit') setMaskRefs(prev => ({ ...prev, [selected.id]: { edit: editAsset.id, protect: protectAsset.id } }));
      await submit([{ type: 'layer.update', layerId: selected.id, patch: { metadata: { ...target.metadata, ...(maskPurpose === 'visibility' ? { visibilityMaskAssetId: editAsset.id, visibilityProtectMaskAssetId: protectAsset.id } : { editMaskAssetId: editAsset.id, protectMaskAssetId: protectAsset.id }) } } }]);
      if ((await queue.current!.pending(current.id)).length) throw new Error('范围保存在本地；处理版本冲突后再继续');
      if (maskPurpose === 'visibility') await runOperation('refine_mask');
    }} />}
  </main>;
}
const documentFonts = new Set<string>();
