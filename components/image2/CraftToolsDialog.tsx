'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, Loader2, RefreshCw, Shapes, X } from 'lucide-react';
import type { useLegacyImage2 } from '../../lib/image2/useLegacyImage2';
import type { ImageAsset, ImageDocument } from '../../lib/image2/types';
import { assetUrl, image2Api, Image2ApiError, unwrapDocument } from '../../lib/image2/client';
import { displayToolText } from '../../lib/image2/chat-projection';
import { acceptedCandidateRevision } from '../../lib/image2/candidate-preview';
import { craftSubmissions } from '../../lib/image2/craft-submissions';
import type { SubmissionAttempt } from '../../lib/image2/submissions';
import {
  craftApi, craftCandidateAcceptable, craftCommandId, craftCommonCommands, craftDefaultValue, craftEngineCommands, craftEngineLabels,
  craftFieldLabel, craftJobStatus, craftJobRequest, craftJobRunning, craftPreviewAssets, resolveCraftSchema,
  craftNativeEvidenceKey, craftNativeReceiptMatches, parseCraftArgumentText, craftSchemaMatches, craftArrayItemSchema, craftCommandParameterHint,
  craftCanvasLayer, craftCanvasExport, craftProjectRequest, type CraftCommand, type CraftEngine, type CraftJob, type CraftJobRequest, type CraftOutputAsset, type CraftProject, type CraftProjectRequest, type CraftSchema,
} from '../../lib/image2/craft-client';

type Bridge = ReturnType<typeof useLegacyImage2>;
const box = { border: '1px solid var(--line)', borderRadius: 12, padding: 12, marginTop: 12 };
const control = { padding: '8px 10px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--white)', width: '100%' };
const compact = { fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 };

function CraftAdvancedArguments({ value, onChange, onError, disabled, parameterHint }: { value: Record<string, unknown>; onChange: (value: Record<string, unknown>) => void; onError: (message: string) => void; disabled: boolean; parameterHint?: string }) {
  const [draft, setDraft] = useState<{ base: Record<string, unknown>; text: string }>();
  return <details style={{ marginTop: 12 }}><summary>高级参数</summary>{parameterHint && <><p style={compact}>上游参数说明</p><pre style={{ ...compact, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{parameterHint}</pre></>}<label>JSON 参数<textarea aria-label="专业工具高级参数" disabled={disabled} rows={8} style={{ ...control, resize: 'vertical', fontFamily: 'monospace' }} value={draft?.base === value ? draft.text : JSON.stringify(value, null, 2)} onChange={event => {
    const text = event.target.value;
    try { const next = parseCraftArgumentText(text); setDraft({ base: next, text }); onChange(next); onError(''); }
    catch (cause) { setDraft({ base: value, text }); onError((cause as Error).message); }
  }} /></label><p style={compact}>供熟悉该工具的人精确填写参数。文件使用已选素材引用或输出文件名，全部参数仍由工具校验。</p><button type="button" className="ghostButton" disabled={disabled} onClick={() => { setDraft(undefined); onError(''); }}>恢复已确认参数</button></details>;
}

/** All fields are derived from the running engine's discovered schema. No shell input is exposed. */
export function CraftSchemaField({ name, schema: source, root, value, onChange, assets, disabled = false, required = false, depth = 0 }: {
  name: string; schema: CraftSchema; root: CraftSchema; value: unknown; onChange: (value: unknown) => void;
  assets: ImageAsset[]; disabled?: boolean; required?: boolean; depth?: number;
}) {
  const schema = resolveCraftSchema(source, root), [variant, setVariant] = useState<number>(), [newKey, setNewKey] = useState('');
  if (schema.readOnly || schema.const !== undefined) return null;
  if (depth > 8) return <p role="alert">{craftFieldLabel(name, schema)} 的参数层级过深，请通过聊天按工具说明设置。</p>;
  const label = craftFieldLabel(name, schema), suffix = required ? ' *' : '';
  if (schema['x-craft-role'] === 'input-asset' || schema.format === 'asset') return <label>{label}{suffix}<select style={control} aria-label={label} disabled={disabled} value={value && typeof value === 'object' ? String((value as { assetId?: unknown }).assetId || '') : ''} onChange={event => onChange(event.target.value ? { assetId: event.target.value } : undefined)}><option value="">请选择已上传素材</option>{assets.map(asset => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></label>;
  if (schema['x-craft-role'] === 'output') return <label>{label}{suffix}<input aria-label={label} required={required} disabled={disabled} value={value && typeof value === 'object' ? String((value as { outputName?: unknown }).outputName || '') : ''} placeholder="例如：result.svg" onChange={event => onChange(event.target.value ? { outputName: event.target.value } : undefined)} /><small style={compact}>只填写文件名，生成文件将保存在工程中。</small></label>;
  const alternatives = schema.oneOf || schema.anyOf;
  if (alternatives?.length) {
    const choices = alternatives, inferred = choices.findIndex(item => craftSchemaMatches(item, value, root));
    const selected = variant !== undefined && choices[variant] && craftSchemaMatches(choices[variant], value, root) ? variant : Math.max(0, inferred);
    return <div style={box}><label>{label}{suffix}<select aria-label={`${label}类型`} style={control} disabled={disabled} value={selected} onChange={event => { const index = Number(event.target.value); setVariant(index); onChange(resolveCraftSchema(choices[index], root).type === 'null' ? null : craftDefaultValue(choices[index], root)); }}>{choices.map((item, index) => <option key={index} value={index}>{item.title || (item.type === 'null' ? '留空' : item.description || `方案 ${index + 1}`)}</option>)}</select></label><CraftSchemaField key={selected} name={name} schema={choices[selected]} root={root} value={value} onChange={onChange} assets={assets} disabled={disabled} required={required} depth={depth + 1} /></div>;
  }
  if (schema.type === 'null') return <p style={compact}>{label}已明确留空。</p>;
  if (schema.enum) return <label>{label}{suffix}<select style={control} aria-label={label} disabled={disabled} required={required} value={value === undefined ? '' : schema.enum.findIndex(item => JSON.stringify(item) === JSON.stringify(value))} onChange={event => onChange(event.target.value === '' ? undefined : schema.enum![Number(event.target.value)])}><option value="">请选择</option>{schema.enum.map((item, index) => <option key={index} value={index}>{item === null ? '留空' : typeof item === 'object' ? JSON.stringify(item) : String(item)}</option>)}</select>{schema.description && <small style={compact}>{schema.description}</small>}</label>;
  if (schema.type === 'object' || schema.properties) {
    if (value === undefined && !required) return <div style={box}><span>{label}（可选）</span><button type="button" className="ghostButton" disabled={disabled} onClick={() => onChange(craftDefaultValue(schema, root) || {})}>设置{label}</button></div>;
    const fields = schema.properties || {}, object = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const update = (key: string, next: unknown) => { const result = { ...object }; if (next === undefined) delete result[key]; else result[key] = next; onChange(result); };
    const extra = schema.additionalProperties && typeof schema.additionalProperties === 'object' ? schema.additionalProperties : { type: 'string' };
    return <fieldset disabled={disabled} style={{ ...box, minWidth: 0 }}><legend>{label}{suffix}</legend>{schema.description && <p style={compact}>{schema.description}</p>}{!required && <button type="button" className="ghostButton" onClick={() => onChange(undefined)}>不设置{label}</button>}{Object.entries(fields).map(([key, field]) => <CraftSchemaField key={key} name={key} schema={field} root={root} value={object[key]} onChange={next => update(key, next)} assets={assets} disabled={disabled} required={schema.required?.includes(key)} depth={depth + 1} />)}{schema.additionalProperties && <><div>{Object.keys(object).filter(key => !(key in fields)).map(key => <div key={key}><CraftSchemaField name={key} schema={extra} root={root} value={object[key]} onChange={next => update(key, next)} assets={assets} disabled={disabled} depth={depth + 1} /><button type="button" className="ghostButton" onClick={() => update(key, undefined)}>移除 {key}</button></div>)}</div><label>新增属性<input aria-label={`${label}新增属性`} value={newKey} onChange={event => setNewKey(event.target.value)} /></label><button type="button" className="ghostButton" disabled={!newKey.trim() || ['__proto__', 'constructor', 'prototype'].includes(newKey.trim()) || newKey.trim() in object} onClick={() => { update(newKey.trim(), craftDefaultValue(extra, root) ?? ''); setNewKey(''); }}>添加属性</button></>}</fieldset>;
  }
  if (schema.type === 'array') {
    const items = Array.isArray(value) ? value : [], maxItems = schema.maxItems ?? (Array.isArray(schema.items) && schema.additionalItems === false ? schema.items.length : 100);
    return <fieldset disabled={disabled} style={{ ...box, minWidth: 0 }}><legend>{label}{suffix}</legend>{schema.minItems !== undefined && <p style={compact}>至少 {schema.minItems} 项</p>}{!required && value !== undefined && <button type="button" className="ghostButton" onClick={() => onChange(undefined)}>不设置{label}</button>}{items.map((item, index) => <div key={index}><CraftSchemaField name={`${label} ${index + 1}`} schema={craftArrayItemSchema(schema, index)} root={root} value={item} onChange={next => onChange(items.map((old, at) => at === index ? next : old))} assets={assets} disabled={disabled} required depth={depth + 1} /><button type="button" className="ghostButton" disabled={items.length <= (schema.minItems || 0)} onClick={() => onChange(items.filter((_, at) => at !== index))}>移除第 {index + 1} 项</button></div>)}<button type="button" className="ghostButton" disabled={items.length >= Math.min(maxItems, 100)} onClick={() => onChange([...items, craftDefaultValue(craftArrayItemSchema(schema, items.length), root)])}>添加{label}</button></fieldset>;
  }
  if (schema.type === 'boolean') return <label>{label}{suffix}<select style={control} aria-label={label} disabled={disabled} required={required} value={value === undefined ? '' : value ? 'true' : 'false'} onChange={event => onChange(event.target.value === '' ? undefined : event.target.value === 'true')}><option value="">请选择</option><option value="true">是</option><option value="false">否</option></select></label>;
  const numeric = schema.type === 'number' || schema.type === 'integer';
  return <label>{label}{suffix}<input aria-label={label} type={numeric ? 'number' : 'text'} value={value === undefined || value === null ? '' : String(value)} min={schema.minimum} max={schema.maximum} step={schema.type === 'integer' ? 1 : numeric ? 'any' : undefined} minLength={schema.minLength} maxLength={schema.maxLength} disabled={disabled} required={required} onChange={event => onChange(event.target.value === '' ? undefined : numeric ? Number(event.target.value) : event.target.value)} placeholder={schema['x-craft-role'] === 'output' ? '例如：result.png' : undefined} />{schema.description && <small style={compact}>{schema.description}</small>}</label>;
}

export function CraftStructuredResult({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (value === undefined || value === null) return <span>—</span>;
  if (typeof value !== 'object') return <span style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{displayToolText(String(value)).slice(0, 4000)}</span>;
  if (depth > 5) return <span>更深层内容已保存在工程结果中。</span>;
  if (Array.isArray(value)) return <div>{value.slice(0, 100).map((item, index) => <div key={index} style={{ padding: '4px 0', borderBottom: '1px solid var(--line)' }}><CraftStructuredResult value={item} depth={depth + 1} /></div>)}{value.length > 100 && <p>显示前 100 项，共 {value.length} 项。</p>}</div>;
  return <dl style={{ display: 'grid', gridTemplateColumns: 'minmax(80px, 1fr) minmax(0, 3fr)', gap: '4px 10px', margin: '4px 0' }}>{Object.entries(value).slice(0, 100).flatMap(([key, item]) => [<dt key={`${key}:key`} style={{ color: 'var(--muted)', overflowWrap: 'anywhere' }}>{craftFieldLabel(key, {})}</dt>, <dd key={`${key}:value`} style={{ margin: 0, minWidth: 0 }}><CraftStructuredResult value={item} depth={depth + 1} /></dd>])}</dl>;
}

export function CraftResults({ job, onPlace, busy = false }: { job: CraftJob; onPlace?: (asset: CraftOutputAsset) => void; busy?: boolean }) {
  const previews = craftPreviewAssets(job), assets = job.output?.assets || [];
  return <>{previews.map(asset => <div key={asset.id} style={{ marginTop: 10 }}>
    {asset.mime?.startsWith('image/') ? <img src={assetUrl(asset.id)} alt={asset.name || '专业工具结果预览'} style={{ maxWidth: '100%', maxHeight: 300, objectFit: 'contain' }} /> // eslint-disable-line @next/next/no-img-element -- Immutable user asset previews, including SVG, must retain their original source.
      : asset.mime?.startsWith('video/') ? <video src={assetUrl(asset.id)} controls preload="metadata" style={{ width: '100%', maxHeight: 300 }} />
        : asset.mime?.startsWith('audio/') ? <audio src={assetUrl(asset.id)} controls preload="metadata" style={{ width: '100%' }} />
          : <a href={assetUrl(asset.id)} target="_blank" rel="noreferrer">预览 PDF</a>}
  </div>)}{assets.length > 0 && <div className="inlineOptions" style={{ marginTop: 10 }}>{assets.map(asset => <span key={asset.id}><a className="ghostButton" href={assetUrl(asset.id)} download={asset.filename || asset.name || '专业工具结果'}><Download size={13} /> {asset.name || asset.filename || (asset.role === 'native' ? '原生工程' : '结果文件')}</a>{onPlace && craftCanvasExport(asset) && <button type="button" className="ghostButton" disabled={busy} onClick={() => onPlace(asset)}>放回画布</button>}</span>)}</div>}{onPlace && <p style={compact}>{assets.some(craftCanvasExport) ? '放回画布的是导出快照，并保留原生工程引用；完整内容仍在对应专业工具中编辑。' : '使用“导出文件”取得实际尺寸的 PNG 或 SVG 后可放回画布；预览文件仅供查看。'}</p>}{(job.output?.state !== undefined || job.output?.result !== undefined) && <details style={{ marginTop: 10 }}><summary>对象与操作结果</summary><div style={{ fontSize: 12, maxHeight: 350, overflow: 'auto' }}><CraftStructuredResult value={job.output.state ?? job.output.result} /></div></details>}{job.output?.warnings?.length ? <details style={{ marginTop: 10 }}><summary>结果说明</summary>{job.output.warnings.map((warning, index) => <p key={index} style={compact}>{displayToolText(warning)}</p>)}</details> : null}</>;
}

/** The native candidate receipt, rather than an empty image PNG, is the preview evidence. */
export function CraftCandidateSummary({ branchId, projects, onOpen, onReady, accepted = false }: { branchId: string; projects: CraftProject[]; onOpen?: (branchId: string, projectId?: string) => void; onReady: (evidence: string) => void; accepted?: boolean }) {
  const [state, setState] = useState<{ key: string; jobs: CraftJob[]; error?: string }>();
  const evidence = craftNativeEvidenceKey(projects);
  useEffect(() => {
    let active = true;
    void Promise.all([craftApi.projects(branchId), craftApi.jobs(branchId)]).then(([liveProjects, jobs]) => {
      if (!active) return;
      const expected = JSON.parse(evidence) as Array<[string, string, number, string, string]>;
      const matched = expected.every(([id, documentId, revision, nativeAssetId, lastJobId]) => {
        const current = liveProjects.find(project => project.id === id);
        return documentId === branchId && current?.revision === revision && current.nativeAssetId === nativeAssetId && current.lastJobId === lastJobId && craftNativeReceiptMatches(current, jobs.find(job => job.id === lastJobId));
      });
      setState({ key: evidence, jobs, ...(matched ? {} : { error: '原生候选版本已变化或回执不完整，请刷新任务后核对。' }) }); onReady(matched ? evidence : '');
    }).catch(error => { if (active) { setState({ key: evidence, jobs: [], error: `原生候选暂不可读取：${(error as Error).message}` }); onReady(''); } });
    return () => { active = false; };
  }, [branchId, evidence, onReady]);
  const current = state?.key === evidence ? state : undefined;
  return <div aria-label={accepted ? '已保存的原生结果' : '原生工程候选'} style={{ marginTop: 10 }}><p>本次任务包含 {projects.length} 个{accepted ? '已保存的原生工程结果' : '原生工程候选'}。</p>{!current && <p role="status">正在核对原生工程版本与结果…</p>}{current?.error && <p role="alert">{displayToolText(current.error)}</p>}{projects.map(project => {
    const job = current?.jobs.find(item => item.id === project.lastJobId);
    return <div key={project.id} style={box}><strong>{project.name} · {craftEngineLabels[project.engineId] || project.engineId} · {accepted ? '任务分支版本' : '候选版本'} {project.revision}</strong>{current && !current.error && job && <CraftResults job={job} />}{onOpen && <button type="button" className="ghostButton" onClick={() => onOpen(branchId, project.id)}>{accepted ? '查看原生结果' : '查看原生候选'}</button>}</div>;
  })}</div>;
}

/** Reuses the original workbench modal and project menu; never embeds upstream application UI. */
export function CraftToolsDialog({ open, onClose, bridge, documentIdOverride, initialProjectId = '', reviewOnly = false }: { open: boolean; onClose: () => void; bridge: Bridge; documentIdOverride?: string; initialProjectId?: string; reviewOnly?: boolean }) {
  const documentId = documentIdOverride || bridge.rawDocument?.id;
  const [reviewDocument, setReviewDocument] = useState<ImageDocument>();
  const acceptedReview = reviewDocument?.id === documentId && acceptedCandidateRevision(reviewDocument) !== undefined;
  const [engines, setEngines] = useState<CraftEngine[]>([]), [projects, setProjects] = useState<CraftProject[]>([]), [jobs, setJobs] = useState<CraftJob[]>([]);
  const [engineId, setEngineId] = useState(''), [projectId, setProjectId] = useState(initialProjectId), [commandId, setCommandId] = useState('');
  const [projectName, setProjectName] = useState(''), [query, setQuery] = useState(''), [args, setArgs] = useState<Record<string, unknown>>({});
  const [initialAssetId, setInitialAssetId] = useState('');
  const [uploads, setUploads] = useState<ImageAsset[]>([]), [inputIds, setInputIds] = useState<string[]>([]);
  const [working, setWorking] = useState(''), [error, setError] = useState(''), [loaded, setLoaded] = useState(false);
  const [parameterError, setParameterError] = useState('');
  const [history, setHistory] = useState<{ projectId: string; entries: CraftProject[] }>(), [restoreRevision, setRestoreRevision] = useState('');
  const [recovery, setRecovery] = useState<SubmissionAttempt[]>([]);
  const [pendingRequest, setPendingRequest] = useState<CraftJobRequest | null>(null), [creationRequest, setCreationRequest] = useState<CraftProjectRequest | null>(null);
  const acceptRequests = useRef(new Map<string, { baseRevision: number; idempotencyKey: string }>());
  const scope = useRef(documentId), requestEpoch = useRef(0), dataSequence = useRef(0);
  const invalidateRequests = useCallback(() => { requestEpoch.current++; }, []);
  const engine = engines.find(item => item.id === engineId), project = projects.find(item => item.id === projectId);
  const commands = craftEngineCommands(engine), command = commands.find(item => craftCommandId(item) === commandId);
  const assets = [...new Map([...bridge.assets, ...uploads].map(asset => [asset.id, asset])).values()];
  const selectCommand = (item?: CraftCommand) => { setCommandId(item ? craftCommandId(item) : ''); setArgs(item ? craftDefaultValue(item.inputSchema || { type: 'object' }) as Record<string, unknown> || {} : {}); setParameterError(''); };
  const refresh = useCallback(async (withCapabilities = false) => {
    if (!documentId) return;
    const epoch = requestEpoch.current, sequence = ++dataSequence.current;
    const data = Promise.all([craftApi.projects(documentId), craftApi.jobs(documentId), craftSubmissions.pending(documentId)]).then(([nextProjects, nextJobs, attempts]) => {
      if (scope.current !== documentId || epoch !== requestEpoch.current || sequence !== dataSequence.current) return;
      setProjects(nextProjects); setJobs(nextJobs); setRecovery(attempts);
      if (initialProjectId) { const initial = nextProjects.find(item => item.id === initialProjectId); if (initial) setEngineId(initial.engineId); }
    });
    const capabilities = withCapabilities ? craftApi.capabilities(documentId).then(value => {
      if (scope.current !== documentId || epoch !== requestEpoch.current) return;
      setEngines(value.engines); setEngineId(current => current || value.engines.find(item => item.available)?.id || value.engines[0]?.id || ''); setLoaded(true);
    }) : Promise.resolve();
    const candidate = withCapabilities && reviewOnly ? image2Api<ImageDocument>(`/documents/${encodeURIComponent(documentId)}`).then(unwrapDocument).then(value => {
      if (scope.current === documentId && epoch === requestEpoch.current) setReviewDocument(value);
    }) : Promise.resolve();
    await Promise.all([data, capabilities, candidate]);
  }, [documentId, initialProjectId, reviewOnly]);
  useEffect(() => {
    scope.current = documentId;
    if (!open || !documentId) return;
    let active = true;
    const initial = setTimeout(() => { void refresh(true).catch(cause => { if (active) setError((cause as Error).message); }); }, 0);
    const timer = setInterval(() => { void refresh().catch(cause => { if (active) setError((cause as Error).message); }); }, 2000);
    return () => { active = false; invalidateRequests(); clearTimeout(initial); clearInterval(timer); };
  }, [open, documentId, refresh, invalidateRequests]);
  useEffect(() => () => { scope.current = undefined; }, []);
  useEffect(() => {
    if (!open || !documentId || !project?.id) return;
    let active = true;
    void craftApi.revisions(documentId, project.id).then(entries => { if (active) setHistory({ projectId: project.id, entries }); }).catch(cause => { if (active) setError((cause as Error).message); });
    return () => { active = false; };
  }, [open, documentId, project?.id, project?.revision]);
  useEffect(() => {
    if (!open) return;
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); onClose(); } };
    window.addEventListener('keydown', key, true); return () => window.removeEventListener('keydown', key, true);
  }, [open, onClose]);
  const act = async (label: string, task: () => Promise<unknown>) => {
    const current = documentId; setWorking(label); setError('');
    try { await task(); } catch (cause) { if (scope.current === current) setError((cause as Error).message); }
    finally { if (scope.current === current) setWorking(''); }
  };
  const submit = async () => {
    if (!documentId || !project || !command || parameterError || project.pendingImportAssetId) return;
    const request = pendingRequest || craftJobRequest(project, command, args, inputIds, crypto.randomUUID()); setPendingRequest(request);
    try { await craftApi.submit(documentId, request); if (scope.current === documentId) setPendingRequest(null); await refresh(); }
    catch (cause) { if (cause instanceof Image2ApiError && cause.status >= 400 && cause.status < 500 && ![408, 429].includes(cause.status)) setPendingRequest(null); throw cause; }
  };
  const placeOutput = async (asset: CraftOutputAsset, jobId: string) => {
    if (!project || reviewOnly) return;
    const document = await bridge.sync(); if (scope.current !== documentId) return;
    const existing = document.layers.find(layer => layer.metadata?.craftProjectId === project.id && layer.metadata.craftRevision === project.revision && layer.metadata.craftOutputAssetId === asset.id);
    if (existing) { bridge.selectLayer(existing.id); return; }
    const layer = craftCanvasLayer(document, project, asset, jobId, crypto.randomUUID(), { x: (bridge.selectedLayer?.x || 0) + 32, y: (bridge.selectedLayer?.y || 0) + 32 });
    await bridge.submitCommands([{ type: 'layer.add', layer }]); if (scope.current === documentId) bridge.selectLayer(layer.id);
  };
  if (!open) return null;
  const busy = !!working, freeze = busy || !!pendingRequest || !!creationRequest || recovery.length > 0, filtered = commands.filter(item => `${item.title || ''} ${item.description || ''} ${craftCommandId(item)}`.toLowerCase().includes(query.toLowerCase()));
  const operationBlocked = freeze || !!project?.pendingImportAssetId;
  const projectJobs = jobs.filter(job => job.projectId === projectId).slice().reverse();
  return <div className="modalScrim" onClick={onClose}>
    <div className="taskDialog" role="dialog" aria-modal="true" aria-label="专业工具" onClick={event => event.stopPropagation()} style={{ width: 740, maxHeight: '88vh', overflowY: 'auto' }}>
      <div className="drawerTop"><h2><Shapes size={16} /> 专业工具</h2><button type="button" className="ghostIcon" aria-label="关闭专业工具" onClick={onClose}><X size={16} /></button></div>
      <p style={compact}>{reviewOnly ? acceptedReview ? '本次任务已接受到主工程。这里保留当时的原生结果，继续编辑请从主工程打开专业工具。' : '查看本次 Agent 任务的原生工程候选。回到聊天结果接受整组候选后，图片与原生工程会一起保存。' : '图片、矢量、影音、文档和设计工具共用当前工程素材。操作先保存为候选，接受后更新对应的原生工程。'}</p>
      {!documentId ? <><p>先连接当前工程，再使用专业工具。</p>{bridge.needsImport && <p>导入会保留旧画布快照与对象位置。</p>}<button type="button" className="darkButton" disabled={busy} onClick={() => void act('连接工程', () => bridge.needsImport ? bridge.importCanvas() : bridge.ensureDocument())}>{bridge.needsImport ? '确认导入当前画布' : '连接当前工程'}</button></> : <>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}><p role="status" style={compact}>{loaded ? `${engines.filter(item => item.available).length} / ${engines.length} 个工具可用` : '正在读取工具能力…'}</p><button type="button" className="ghostButton" disabled={busy} onClick={() => void act('刷新能力', () => refresh(true))}><RefreshCw size={13} /> 刷新</button></div>
        {!reviewOnly && recovery.length > 0 && <div style={box}><p role="status">有 {recovery.length} 个请求尚未确认。恢复将使用已保存的原参数，不会重新创建同一任务。</p><button type="button" className="darkButton" disabled={busy} onClick={() => void act('恢复提交', async () => { for (const attempt of recovery) { await craftSubmissions.resume(attempt); if (scope.current !== documentId) return; } setPendingRequest(null); setCreationRequest(null); await refresh(); })}>恢复未确认请求</button></div>}
        <label>工具<select aria-label="专业工具类型" style={control} value={engineId} disabled={freeze || reviewOnly} onChange={event => { const next = engines.find(item => item.id === event.target.value); setEngineId(event.target.value); setProjectId(''); setRestoreRevision(''); setQuery(''); selectCommand(craftCommonCommands(next)[0]?.command); }}><option value="">请选择工具</option>{engines.map(item => <option key={item.id} value={item.id}>{craftEngineLabels[item.id.toLowerCase()] || item.name} · {item.name}{item.available ? '' : '（暂不可用）'}</option>)}</select></label>
        {engine && !engine.available && <p role="status">此工具暂不可用。{engine.message || engine.reason || '尚未配置。'}</p>}
        <label>原生工程<select aria-label="原生工程" style={control} value={projectId} disabled={freeze} onChange={event => { const next = projects.find(item => item.id === event.target.value); setProjectId(event.target.value); setRestoreRevision(''); if (next) setEngineId(next.engineId); }}><option value="">选择或新建工程</option>{projects.filter(item => item.engineId === engineId).map(item => <option key={item.id} value={item.id}>{item.name} · 版本 {item.revision}</option>)}</select></label>
        {!reviewOnly && <label>从工程包创建（可选）<select aria-label="从已上传工程包创建" style={control} value={initialAssetId} disabled={freeze} onChange={event => setInitialAssetId(event.target.value)}><option value="">创建空白工程</option>{assets.filter(asset => /\.craftbundle$/i.test(asset.name)).map(asset => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select><small style={compact}>可在下方“输入素材”上传 .craftbundle；其他原生格式使用“打开素材”。</small></label>}
        {!reviewOnly && <div className="inlineOptions"><input aria-label="新原生工程名称" value={projectName} disabled={freeze} onChange={event => setProjectName(event.target.value)} placeholder={engine ? `${craftEngineLabels[engine.id.toLowerCase()] || engine.name}工程` : '新工程名称'} style={{ flex: 1 }} /><button type="button" className="ghostButton" disabled={busy || !!pendingRequest || !engine?.available} onClick={() => void act('新建工程', async () => {
          const body = creationRequest || craftProjectRequest(engine!, projectName, crypto.randomUUID(), initialAssetId || undefined, assets); setCreationRequest(body);
          try { const next = await craftApi.createProject(documentId, body); if (scope.current !== documentId) return; setCreationRequest(null); setProjectId(next.id); setRestoreRevision(''); setInitialAssetId(''); const common = craftCommonCommands(engine); selectCommand(body.initialAssetId ? common.find(item => ['预览内容', '查看对象'].includes(item.label))?.command : common[0]?.command); await refresh(); }
          catch (cause) { if (cause instanceof Image2ApiError && cause.status >= 400 && cause.status < 500 && ![408, 429].includes(cause.status)) setCreationRequest(null); throw cause; }
        })}>{creationRequest ? '恢复新建请求' : initialAssetId ? '导入原生工程包' : '新建原生工程'}</button></div>}
        {project && <p style={compact}>{reviewOnly ? acceptedReview ? '已保存的原生结果' : '当前原生候选' : '当前原生工程'}：{project.name} · {reviewOnly ? acceptedReview ? '任务分支版本' : '候选版本' : '已接受版本'} {project.revision}{project.nativeAssetId && <> · <a href={assetUrl(project.nativeAssetId)} download>下载可续编工程包</a></>}</p>}
        {project?.pendingImportAssetId && <p role="status">工程包正在作为候选验证；请先核对并接受下方导入结果，再继续编辑。</p>}
        {project?.latestOutput && <details style={box}><summary>{reviewOnly ? acceptedReview ? '本次已保存结果' : '本次候选结果' : '当前已接受结果'}</summary><CraftResults job={{ id: project.lastJobId || project.id, documentId: project.documentId, projectId: project.id, state: 'complete', output: project.latestOutput }} busy={busy} onPlace={reviewOnly ? undefined : asset => void act('放回画布', () => placeOutput(asset, project.lastJobId || ''))} /></details>}
        {project && <details style={box}><summary>版本历史</summary>{history?.projectId === project.id ? <><label>历史版本<select aria-label="原生工程历史版本" style={control} value={restoreRevision} disabled={freeze || reviewOnly} onChange={event => setRestoreRevision(event.target.value)}><option value="">选择要恢复的版本</option>{history.entries.filter(entry => entry.nativeAssetId).map(entry => <option key={entry.revision} value={entry.revision}>版本 {entry.revision}{entry.revision === project.revision ? ' · 当前' : ''}</option>)}</select></label><p style={compact}>{reviewOnly ? acceptedReview ? '这些版本属于已保存的任务分支；主工程保留独立的后续编辑历史。' : '这些版本属于本次任务分支，回到聊天接受整组候选后才会保存到主工程。' : '恢复会先创建候选，接受后保存为一个新版本。'}</p>{!reviewOnly && <button type="button" className="ghostButton" disabled={freeze || restoreRevision === '' || Number(restoreRevision) === project.revision} onClick={() => void act('恢复历史版本', async () => { await craftApi.restore(documentId, project.id, { revision: Number(restoreRevision), baseRevision: project.revision, idempotencyKey: crypto.randomUUID() }); await refresh(); })}>恢复为候选</button>}</> : <p role="status">正在读取历史…</p>}</details>}
        {!reviewOnly && <><details style={box}><summary>输入素材 · 已选 {inputIds.length} 项</summary><p style={compact}>选择当前画布素材，或上传原生工程、音视频、图片、PDF、文档文件。</p>
          <div className="inlineOptions"><button type="button" className="ghostButton" disabled={freeze || !bridge.selectedLayer?.assetId} onClick={() => { const id = bridge.selectedLayer?.assetId; if (id) setInputIds(current => [...new Set([...current, id])]); }}>使用当前选中素材</button><label style={{ margin: 0 }}>上传素材<input type="file" aria-label="上传专业工具素材" disabled={freeze} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void act('上传素材', async () => { const asset = await craftApi.upload(documentId, file, file.name); if (scope.current !== documentId) return; setUploads(current => [...current.filter(item => item.id !== asset.id), asset]); setInputIds(current => [...new Set([...current, asset.id])]); }); }} /></label></div>
          {assets.map(asset => <label key={asset.id} style={{ flexDirection: 'row', alignItems: 'center' }}><input type="checkbox" disabled={freeze} checked={inputIds.includes(asset.id)} onChange={event => setInputIds(current => event.target.checked ? [...new Set([...current, asset.id])] : current.filter(id => id !== asset.id))} />{asset.name}</label>)}
        </details>
        <form onSubmit={event => { event.preventDefault(); void act(pendingRequest ? '恢复提交' : '提交操作', submit); }}>
          <div className="inlineOptions" style={{ marginTop: 12 }} aria-label="常用专业操作">{craftCommonCommands(engine).map(item => <button key={item.label} type="button" className={commandId === craftCommandId(item.command) ? 'darkButton' : 'ghostButton'} disabled={operationBlocked || !engine?.available || !project} onClick={() => selectCommand(item.command)}>{item.label}</button>)}</div>
          <details style={{ marginTop: 12 }}><summary>更多专业操作 · {commands.length} 项</summary>
          <label>查找操作<input aria-label="查找专业操作" disabled={freeze} value={query} onChange={event => setQuery(event.target.value)} placeholder="输入操作名称或关键词" /></label>
          <label>操作<select aria-label="专业工具操作" style={control} disabled={operationBlocked || !engine?.available || !project} value={commandId} onChange={event => selectCommand(commands.find(item => craftCommandId(item) === event.target.value))}><option value="">请选择操作</option>{filtered.map(item => <option key={craftCommandId(item)} value={craftCommandId(item)}>{item.title || item.description?.split(/[.\n]/)[0] || craftCommandId(item)}</option>)}</select></label>
          </details>
          {command && <><details style={{ marginTop: 8 }}><summary>操作说明</summary><p style={compact}>{command.description || craftCommandId(command)}</p></details>{craftCommandParameterHint(command) && !Object.keys(command.inputSchema?.properties || {}).length && <p style={compact}>此操作的参数说明位于高级参数中，可直接填写，或通过聊天让助手调用。</p>}<CraftSchemaField key={`${engineId}:${commandId}`} name={craftCommonCommands(engine).find(item => craftCommandId(item.command) === commandId)?.label || '操作参数'} schema={command.inputSchema || { type: 'object' }} root={command.inputSchema || { type: 'object' }} required value={args} onChange={value => { setArgs(value as Record<string, unknown>); setParameterError(''); }} assets={assets.filter(asset => inputIds.includes(asset.id))} disabled={operationBlocked} /><CraftAdvancedArguments key={`advanced:${engineId}:${commandId}`} value={args} onChange={setArgs} onError={setParameterError} disabled={operationBlocked} parameterHint={craftCommandParameterHint(command)} /></>}
          {parameterError && <p role="alert">{parameterError}</p>}
          <div className="dialogFooter"><span>{pendingRequest ? '上一请求尚未确认；恢复会沿用原参数与请求编号。' : '后台执行，关闭窗口后任务继续保存。'}</span><button type="submit" className="darkButton" disabled={busy || !project || !command || !engine?.available || !!parameterError || !!project.pendingImportAssetId}>{working ? <><Loader2 size={14} className="spin" /> {working}</> : pendingRequest ? '恢复提交' : '执行操作'}</button></div>
        </form></>}
        {project && <section aria-label="专业工具任务" style={{ marginTop: 18 }}><h3 style={{ fontSize: 14 }}>任务与候选</h3>{!projectJobs.length && <p style={compact}>此工程还没有执行记录。</p>}{projectJobs.map(job => <article key={job.id} style={box}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><strong>{craftJobStatus(job, reviewOnly && !acceptedReview)}</strong>{craftJobRunning(job) && <Loader2 size={14} className="spin" />}{typeof job.progress === 'number' && <span>{Math.round(job.progress <= 1 ? job.progress * 100 : job.progress)}%</span>}{!reviewOnly && craftJobRunning(job) && <button type="button" className="ghostButton" disabled={busy} onClick={() => void act('取消任务', async () => { await craftApi.cancel(documentId, job.id); await refresh(); })}>取消任务</button>}</div>
          {job.error && <p role="alert">{displayToolText(job.error)}</p>}<CraftResults job={job} busy={busy} onPlace={!reviewOnly && job.accepted && job.acceptedRevision === project.revision ? asset => void act('放回画布', () => placeOutput(asset, job.id)) : undefined} />
          {job.state === 'complete' && !job.accepted && job.baseRevision !== undefined && job.baseRevision !== project.revision && <p role="status">此候选基于旧版本，结果已保留供比较。</p>}
          {!reviewOnly && ['failed', 'cancelled'].includes(job.state) && !job.accepted && <button type="button" className="ghostButton" disabled={freeze || job.baseRevision !== project.revision} onClick={() => void act('重试任务', async () => { await craftApi.retry(documentId, job.id, crypto.randomUUID()); await refresh(); })}>重试原操作</button>}
          {!reviewOnly && job.state === 'complete' && !job.accepted && <button type="button" className="ghostButton" disabled={freeze} onClick={() => void act('放弃候选', async () => { await craftApi.discard(documentId, job.id); await refresh(); })}>放弃候选</button>}
          {!reviewOnly && craftCandidateAcceptable(job, project) && <button type="button" className="darkButton" disabled={busy} onClick={() => void act('接受候选', async () => { const request = acceptRequests.current.get(job.id) || { baseRevision: project.revision, idempotencyKey: crypto.randomUUID() }; acceptRequests.current.set(job.id, request); await craftApi.accept(documentId, job.id, request.baseRevision, request.idempotencyKey); await refresh(); })}>接受到原生工程</button>}
        </article>)}</section>}
      </>}
      {error && <p role="alert" style={{ marginTop: 12, color: 'var(--red, #a22)' }}>{displayToolText(error)}</p>}
    </div>
  </div>;
}
