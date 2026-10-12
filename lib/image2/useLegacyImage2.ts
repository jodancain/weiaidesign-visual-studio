'use client';
import { useEffect, useRef, useState } from 'react';
import { exportToBlob, getSnapshot, loadSnapshot, Mat, type Editor, type TLAssetId, type TLShape } from 'tldraw';
import { image2Api, assetUrl, listValue, unwrapDocument, uploadAsset, Image2ApiError } from './client';
import { ImageCommandQueue, applyDraft } from './queue';
import { ImageSubmissionManager } from './submissions';
import { image2Storage, submissionStorage, cachedDocument } from './storage';
import { capability } from './geometry';
import { legacyDraftStorage, createLegacyCanvasDraft, classifyLegacyDraft, type LegacyCanvasDraft } from './legacy-drafts';
import { LegacyDocumentMutationManager, getMutationsStorage, LEGACY_MUTATION_PREFIX } from './legacy-mutations';
import { legacyColors, legacyFontSizes, legacyFontUrls, legacyFontVersion, layerShapeId, plainRichText, projectLegacyDocument, shapeFingerprint } from './legacy-projection';
import type { Capabilities, Conversation, ConversationMessage, DocumentCommand, ImageAsset, ImageDocument, ImageJob, ImageLayer } from './types';

interface Options { editor: Editor | null; projectId: string; projectName: string; onError?: (text: string) => void }
export interface LegacyOperationOptions { documentId?: string; layerId?: string; editMask?: Blob; protectMask?: Blob; inputs?: Array<{ role: string; assetId: string }>; mode?: 'apply' | 'candidate' }
const mapKey = (project: string) => `image2-original-project:${project}`;
const emptyLayer = (type: ImageLayer['type'], name: string): ImageLayer => ({ id: crypto.randomUUID(), type, name, x: 0, y: 0, width: 100, height: 100, rotation: 0, opacity: 1, visible: true, locked: false, z: 0 });
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const fontFile = (asset: ImageAsset) => /font|woff|ttf|otf/.test(asset.mime);
function hasRichTextMarks(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const node = value as { marks?: unknown[]; content?: unknown[]; type?: string };
  return Boolean(node.marks?.length) || node.type === 'hardBreak' || (node.content || []).some(hasRichTextMarks);
}
async function sourceBlob(src: string) { const result = await fetch(src); if (!result.ok) throw new Error('原素材无法读取，请重新上传原图；不会重新生成'); return result.blob(); }
function immutableSourceId(src: string) {
  try { const url = new URL(src, window.location.origin); return url.origin === window.location.origin ? /^\/api\/v3\/image2\/assets\/([^/]+)\/content$/.exec(url.pathname)?.[1] : undefined; } catch { return undefined; }
}

/** Original UI adapter. Server documents are authoritative; native canvas records remain editable. */
export function useLegacyImage2({ editor, projectId, projectName, onError }: Options) {
  const [document, setDocument] = useState<ImageDocument | null>(null), [assets, setAssets] = useState<ImageAsset[]>([]), [jobs, setJobs] = useState<ImageJob[]>([]), [branches, setBranches] = useState<ImageDocument[]>([]);
  const [messages, setMessages] = useState<ConversationMessage[]>([]), [capabilities, setCapabilities] = useState<Capabilities>({}), [revisions, setRevisions] = useState<Array<ImageDocument & { kind?: string }>>([]);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [needsImport, setNeedsImport] = useState(false), [pendingCount, setPendingCount] = useState(0), [selectedId, setSelectedId] = useState<string>();
  const state = useRef({ editor, projectId, projectName, onError }); state.current = { editor, projectId, projectName, onError };
  const canonical = useRef<ImageDocument | null>(null), currentAssets = useRef<ImageAsset[]>([]), conversation = useRef<Conversation | null>(null), epoch = useRef(0), projecting = useRef(false), dirty = useRef(false);
  const fingerprints = useRef(new Map<string, string>()), aliases = useRef(new Map<string, string>()), fontCache = useRef(new Map<string, ImageAsset>()), syncPromise = useRef<Promise<ImageDocument> | null>(null);
  const creatingDocument = useRef<Promise<ImageDocument> | null>(null);
  const loadedFonts = useRef(new Set<string>());
  const editGeneration = useRef(0), canvasDraft = useRef<LegacyCanvasDraft | undefined>(undefined), draftConflict = useRef(false);
  const [hasDraftConflict, setHasDraftConflict] = useState(false);
  const scope = () => ({ generation: epoch.current, projectId: state.current.projectId, documentId: canonical.current?.id });
  const assertScope = (captured: ReturnType<typeof scope>) => { if (epoch.current !== captured.generation || state.current.projectId !== captured.projectId || (captured.documentId && canonical.current?.id !== captured.documentId)) throw new Error('已切换工程，旧工程任务与草稿保留'); };
  const queue = useRef<ImageCommandQueue | null>(null), submissions = useRef<ImageSubmissionManager | null>(null), mutations = useRef<LegacyDocumentMutationManager | null>(null);
  if (!queue.current) queue.current = new ImageCommandQueue(image2Storage, async (id, body) => unwrapDocument(await image2Api(`/documents/${id}/commands`, body)));
  if (!submissions.current) submissions.current = new ImageSubmissionManager({ ...submissionStorage, list: async () => (await submissionStorage.list()).filter(attempt => !attempt.intent.startsWith(LEGACY_MUTATION_PREFIX)) }, (path, body) => image2Api(path, body));
  if (!mutations.current) mutations.current = new LegacyDocumentMutationManager(getMutationsStorage(), (path, body) => image2Api(path, body));
  const report = (err: unknown) => { const text = err instanceof Error ? err.message : String(err); setError(text); state.current.onError?.(text); };
  const project = (next: ImageDocument) => {
    if (!state.current.editor) return;
    projecting.current = true;
    try { state.current.editor.store.mergeRemoteChanges(() => projectLegacyDocument(state.current.editor!, next, fingerprints.current)); }
    finally { projecting.current = false; }
    for (const layer of next.layers) if (layer.assetId) {
      aliases.current.set(assetUrl(layer.assetId), layer.id);
      const original = layer.metadata?.legacyRecord as TLShape | undefined;
      const originalId = (original?.props as { assetId?: TLAssetId } | undefined)?.assetId;
      const originalAsset = originalId ? state.current.editor.getAsset(originalId) : undefined;
      const src = (originalAsset?.props as { src?: string } | undefined)?.src; if (src) aliases.current.set(src, layer.id);
    }
    setSelectedId(state.current.editor.getOnlySelectedShape()?.meta.image2LayerId as string | undefined);
  };
  const accept = (next: ImageDocument, render = true) => {
    if (canonical.current && canonical.current.id !== next.id) return;
    if (canonical.current && canonical.current.revision > next.revision) return;
    canonical.current = next; setDocument(next); void image2Storage.saveDocument(next);
    if (render) project(next);
  };
  const updateAssets = (list: ImageAsset[]) => {
    currentAssets.current = list; setAssets(list);
    for (const asset of list.filter(fontFile)) {
      const name = `i2-${asset.id}`;
      if (loadedFonts.current.has(name)) continue; loadedFonts.current.add(name);
      void new FontFace(name, `url("${assetUrl(asset.id)}")`, { weight: String(asset.metadata?.weight || 400) }).load().then(face => window.document.fonts.add(face)).catch(() => { loadedFonts.current.delete(name); report(new Error(`字体 ${asset.name} 加载失败`)); });
    }
  };
  async function refresh() {
    const live = canonical.current; if (!live) return;
    const generation = epoch.current;
    const values = await Promise.all([
      image2Api<ImageDocument>(`/documents/${live.id}`), image2Api<ImageAsset[]>(`/documents/${live.id}/assets`), image2Api<ImageJob[]>(`/documents/${live.id}/jobs`),
      image2Api<ImageDocument[]>(`/documents/${live.id}/branches`), image2Api<Conversation[]>(`/conversations?documentId=${live.id}`), image2Api<Array<ImageDocument & { kind?: string }>>(`/documents/${live.id}/revisions`),
    ]);
    if (generation !== epoch.current || canonical.current?.id !== live.id) return;
    const waiting = await queue.current!.pending(live.id); setPendingCount(waiting.length);
    if (generation !== epoch.current || canonical.current?.id !== live.id) return;
    // Polls never overwrite an unsaved canvas edit or a blocked offline draft.
    if (!dirty.current && !waiting.length && !syncPromise.current) accept(unwrapDocument(values[0]));
    updateAssets(listValue(values[1], 'assets')); setJobs(listValue(values[2], 'jobs')); setBranches(listValue(values[3], 'branches')); setRevisions(listValue(values[5], 'revisions'));
    const thread = listValue(values[4], 'conversations')[0];
    if (thread) { conversation.current = thread; const data = await image2Api<ConversationMessage[]>(`/conversations/${thread.id}/messages`); if (generation === epoch.current) setMessages(listValue(data, 'messages')); }
    if (generation === epoch.current && !dirty.current && !waiting.length && !draftConflict.current) setError('');
  }
  async function bind(next: ImageDocument) {
    const captured = scope(), projectId = state.current.projectId;
    canonical.current = next; dirty.current = false; aliases.current.clear(); fingerprints.current.clear(); fontCache.current.clear();
    localStorage.setItem(mapKey(projectId), next.id); setNeedsImport(false);
    let draft = await legacyDraftStorage.read(projectId); assertScope({ ...captured, documentId: undefined });
    const waiting = await queue.current!.pending(next.id);
    assertScope({ ...captured, documentId: next.id });
    let queueConflict = waiting.some(batch => batch.state === 'blocked');
    try { await queue.current!.flush(next, doc => { assertScope({ ...captured, documentId: next.id }); accept(doc, false); }); }
    catch (err) { if (err instanceof Image2ApiError && err.status === 409) { queueConflict = true; report(err); } else throw err; }
    assertScope({ ...captured, documentId: next.id });
    const live = canonical.current!;
    accept(live);
    dirty.current = state.current.editor!.getCurrentPageShapes().some(shape => !live.layers.some(layer => layerShapeId(layer) === shape.id));
    canvasDraft.current = draft; draftConflict.current = false; setHasDraftConflict(false);
    if (!draft && queueConflict) {
      const baseline = new Map(fingerprints.current);
      const pending = await queue.current!.pending(next.id); assertScope({ ...captured, documentId: next.id });
      project(applyDraft(live, pending)); fingerprints.current = baseline;
      draft = createLegacyCanvasDraft({ projectId, documentId: next.id, baseRevision: waiting[0]?.submittedRevision ?? next.revision, snapshot: { ...getSnapshot(state.current.editor!.store).document } });
      canvasDraft.current = draft; await legacyDraftStorage.put(draft);
    }
    assertScope({ ...captured, documentId: next.id });
    if (draft && draft.documentId === next.id) {
      // Restore native objects after building the canonical baseline. Conflicts keep both versions without overwriting the server.
      projecting.current = true; try { loadSnapshot(state.current.editor!.store, { document: draft.snapshot } as Parameters<typeof loadSnapshot>[1]); } finally { projecting.current = false; }
      dirty.current = true;
      const disposition = classifyLegacyDraft(draft, live);
      if (queueConflict || (disposition === 'revision_conflict' && !waiting.length)) { draftConflict.current = true; setHasDraftConflict(true); report(new Error('服务器已有新版本；原画布草稿已保留，请在版本窗口另存草稿或采用服务器版本')); }
    }
    await submissions.current!.recover(next.id, value => { assertScope({ ...captured, documentId: next.id }); const job = (value as { job?: ImageJob }).job; if (job) setJobs(prev => [job, ...prev.filter(item => item.id !== job.id)]); });
    assertScope({ ...captured, documentId: next.id });
    await mutations.current!.recover(next.id, doc => { assertScope({ ...captured, documentId: next.id }); accept(doc, !dirty.current); });
    assertScope({ ...captured, documentId: next.id });
    await refresh();
    // A create call may itself be awaited by sync; scheduling avoids a bind -> sync -> create cycle.
    if (dirty.current && !draftConflict.current) queueMicrotask(() => { if (epoch.current === captured.generation && state.current.projectId === projectId && canonical.current?.id === next.id) void sync().catch(report); });
  }
  useEffect(() => {
    if (!editor) return;
    const generation = ++epoch.current; canonical.current = null; conversation.current = null; syncPromise.current = null; creatingDocument.current = null;
    queueMicrotask(() => { if (generation === epoch.current) { setDocument(null); setAssets([]); setJobs([]); setBranches([]); setMessages([]); setRevisions([]); setNeedsImport(false); setHasDraftConflict(false); } });
    dirty.current = false; canvasDraft.current = undefined; draftConflict.current = false; fingerprints.current.clear(); aliases.current.clear();
    void (async () => {
      try {
        const caps = await image2Api<Capabilities>('/capabilities'); if (generation !== epoch.current) return; setCapabilities(caps);
        const id = localStorage.getItem(mapKey(projectId));
        if (id) { const next = unwrapDocument(await image2Api<ImageDocument>(`/documents/${id}`)); if (generation === epoch.current) await bind(next); }
        else {
          const all = listValue(await image2Api<ImageDocument[]>('/documents'), 'documents');
          if (generation !== epoch.current || state.current.projectId !== projectId) return;
          const found = all.find(doc => !doc.parentDocumentId && doc.metadata?.legacyProjectId === projectId && doc.metadata?.legacyImportComplete === true);
          if (found) await bind(found); else setNeedsImport(editor.getCurrentPageShapes().length > 0);
        }
      } catch (err) {
        if (generation !== epoch.current) return;
        const id = localStorage.getItem(mapKey(projectId)); if (id) { const cache = await cachedDocument(id); if (generation !== epoch.current || state.current.projectId !== projectId) return; if (cache) { const pending = await queue.current!.pending(id); if (generation !== epoch.current || state.current.projectId !== projectId) return; canonical.current = cache; setDocument(cache); setPendingCount(pending.length); } }
        report(err);
      }
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unlisten = editor.store.listen(() => {
      if (projecting.current) return;
      const shapes = editor.getCurrentPageShapes();
      if (canonical.current && shapes.length === fingerprints.current.size && shapes.every(shape => fingerprints.current.get(shape.id) === shapeFingerprint(shape))) return;
      dirty.current = true; editGeneration.current++;
      if (!canonical.current) { setNeedsImport(editor.getCurrentPageShapes().length > 0); return; }
      const draft = createLegacyCanvasDraft({ projectId, documentId: canonical.current.id, baseRevision: canonical.current.revision, snapshot: { ...getSnapshot(editor.store).document } });
      canvasDraft.current = draft; void legacyDraftStorage.put(draft).catch(report);
      clearTimeout(timer); timer = setTimeout(() => void sync().catch(report), 300);
    }, { source: 'user', scope: 'document' });
    const selection = editor.store.listen(() => setSelectedId(editor.getOnlySelectedShape()?.meta.image2LayerId as string | undefined), { scope: 'session' });
    const online = () => { if (canonical.current) void sync().then(refresh).catch(report); };
    window.addEventListener('online', online);
    let polling = false;
    const poll = setInterval(() => { if (!canonical.current || polling) return; polling = true; void refresh().catch(report).finally(() => { polling = false; }); }, 2000);
    const invalidate = () => { epoch.current++; };
    return () => { invalidate(); clearTimeout(timer); clearInterval(poll); unlisten(); selection(); window.removeEventListener('online', online); };
    // The adapter is scoped to the original project; long-lived callbacks read current refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, projectId]);

  async function ensureDocument() {
    if (canonical.current) return canonical.current;
    if (creatingDocument.current) return creatingDocument.current;
    const captured = scope();
    const editor = state.current.editor; if (!editor) throw new Error('画布还未加载');
    if (editor.getCurrentPageShapes().length) { setNeedsImport(true); throw new Image2ApiError('请先在图层窗口确认导入原工程，再使用升级功能', 409, 'legacy_import_required'); }
    const request = (async () => { const next = unwrapDocument(await image2Api<ImageDocument>('/documents', { name: state.current.projectName, width: 1024, height: 1024, metadata: { legacyProjectId: state.current.projectId, legacyImportComplete: true } })); assertScope(captured); await bind(next); return next; })();
    creatingDocument.current = request;
    try { return await request; } finally { if (creatingDocument.current === request) creatingDocument.current = null; }
  }
  async function rawUpload(file: Blob, name: string, role = 'source', metadata: Record<string, unknown> = {}) {
    const live = canonical.current!, captured = scope(); const asset = await uploadAsset(live.id, file, name, { role, ...metadata }); assertScope(captured);
    updateAssets([...currentAssets.current.filter(a => a.id !== asset.id), asset]);
    const next = unwrapDocument(await image2Api<ImageDocument>(`/documents/${live.id}`)); assertScope(captured); accept(next, false); return asset;
  }
  async function font(slot: string, url = legacyFontUrls[slot]) {
    const captured = scope();
    const key = `${canonical.current!.id}:${legacyFontVersion}:${url}`, cached = fontCache.current.get(key); if (cached) return cached;
    const existing = currentAssets.current.find(a => fontFile(a) && a.metadata?.legacyFontUrl === url && a.metadata?.legacyFontVersion === legacyFontVersion);
    if (existing) { fontCache.current.set(key, existing); return existing; }
    const response = await fetch(url); if (!response.ok) throw new Error('原界面字体文件读取失败');
    const path = new URL(url, window.location.origin).pathname;
    const bytes = await response.arrayBuffer(); assertScope(captured); const asset = await rawUpload(new Blob([bytes], { type: path.endsWith('.woff2') ? 'font/woff2' : 'font/ttf' }), path.split('/').pop()!, 'font', { legacyFontSlot: slot, legacyFontUrl: url, legacyFontVersion }); assertScope(captured); fontCache.current.set(key, asset); return asset;
  }
  async function layerForShape(shape: TLShape, previous?: ImageLayer, staged = new Map<string, ImageLayer>()): Promise<ImageLayer> {
    const captured = scope(), ed = state.current.editor!, props = shape.props as Record<string, unknown>;
    const parentLayer = staged.get(shape.parentId) || canonical.current!.layers.find(layer => layerShapeId(layer) === shape.parentId);
    const geometry = ed.getShapeGeometry(shape).bounds, pageBounds = ed.getShapePageBounds(shape.id)!;
    const base = { ...(previous || emptyLayer('raster', shape.type)), x: shape.x, y: shape.y, width: Number(props.w || geometry.width), height: Number(props.h || geometry.height), rotation: shape.rotation * 180 / Math.PI,
      opacity: shape.opacity, locked: shape.isLocked, visible: shape.meta.image2Hidden !== true, parentId: parentLayer?.type === 'group' ? parentLayer.id : undefined,
      metadata: { ...previous?.metadata, legacyShapeId: shape.id, ...(!shape.type.startsWith('design-') && shape.type !== 'source-mask' ? { legacyRecord: structuredClone(shape) } : {}) } };
    if (shape.type.startsWith('design-') || shape.type === 'source-mask') {
      const layer = props.layer as ImageLayer;
      const id = previous?.id || (canonical.current!.layers.some(l => l.id === layer.id) ? crypto.randomUUID() : layer.id);
      return { ...layer, id, x: base.x, y: base.y, width: base.width, height: base.height, rotation: base.rotation, opacity: base.opacity, locked: base.locked, visible: base.visible, parentId: base.parentId,
        metadata: { ...layer.metadata, legacyShapeId: shape.id } };
    }
    if (shape.type === 'image') {
      const asset = ed.getAsset(props.assetId as TLAssetId), src = (asset?.props as { src?: string; name?: string } | undefined)?.src;
      if (!src) throw new Error('画布素材缺失，保留原快照；请补充原文件');
      const knownId = immutableSourceId(src), known = knownId ? currentAssets.current.find(a => a.id === knownId) : previous?.assetId && aliases.current.get(src) === previous.id ? currentAssets.current.find(a => a.id === previous.assetId) : undefined;
      let image = known;
      if (!image) { const bytes = await sourceBlob(src); assertScope(captured); image = await rawUpload(bytes, (asset?.props as { name?: string })?.name || '原图.png'); }
      if (!image) throw new Error('图片资产尚未读取，请刷新后继续'); aliases.current.set(src, base.id);
      return { ...base, type: image.mime === 'image/svg+xml' ? 'vector' : 'raster', assetId: image.id, sourceAssetId: previous?.sourceAssetId || image.id,
        name: previous?.name || image.name, editability: image.mime === 'image/svg+xml' ? 'path' : 'pixels', metadata: { ...base.metadata, pixelWidth: image.width, pixelHeight: image.height },
        ...(image.mime === 'image/svg+xml' ? {} : { sourceRect: previous?.sourceRect || [0, 0, image.width!, image.height!] }) };
    }
    if (shape.type === 'text' && !hasRichTextMarks(props.richText) && (!props.textAlign || props.textAlign === 'start')) {
      const slot = String(props.font || 'draw'), face = await font(slot);
      return { ...base, type: 'text', text: plainRichText(props.richText) || String(props.text || ''), fontAssetId: face.id, fontFamily: String(face.metadata?.family || ''), fontWeight: Number(face.metadata?.weight || 400),
        fontSize: (legacyFontSizes[String(props.size)] || 24) * Number(props.scale || 1), fill: legacyColors[String(props.color)] || '#1d1d1d', lineHeight: 1.35, tracking: 0, editability: 'text',
        metadata: { ...base.metadata, nativeText: true, nativeFontAssetId: face.id, fontConfirmed: true, legacyFontSlot: slot, fontStatus: 'confirmed' } };
    }
    if (shape.type === 'group' || shape.type === 'frame') return { ...base, type: 'group', ...(shape.type === 'frame' ? { metadata: { ...base.metadata, nativeFrame: true, frameClip: true } } : {}) };
    // Native draw/geo/arrow/frame remain native and editable. Their deterministic export projection uses SVG, with a bitmap remnant for unsupported SVG markup.
    const svg = await ed.getSvgString([shape.id], { background: false, padding: 0 });
    assertScope(captured);
    let proxy: ImageAsset;
    try {
      if (!svg) throw new Error('SVG 导出不可用');
      const xml = new DOMParser().parseFromString(svg.svg, 'image/svg+xml'), root = xml.documentElement;
      const inverse = Mat.From(Mat.Inverse(ed.getShapePageTransform(shape)));
      // tldraw exports page-space matrices and cumulative opacity. Remove both before reusing the real local layer tree.
      for (const node of Array.from(root.children)) if (node.localName === 'g' && node.hasAttribute('transform')) node.removeAttribute('opacity');
      const contents = Array.from(root.childNodes).map(node => new XMLSerializer().serializeToString(node)).join('');
      const localSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${geometry.width}" height="${geometry.height}" viewBox="${geometry.x} ${geometry.y} ${geometry.width} ${geometry.height}"><g transform="${inverse.toCssString()}">${contents}</g></svg>`;
      proxy = await rawUpload(new Blob([localSvg], { type: 'image/svg+xml' }), `${shape.type}.svg`, 'native_projection');
    }
    catch (err) {
      if (!(err instanceof Image2ApiError) || err.status !== 400) throw err;
      const png = await exportToBlob({ editor: ed, ids: [shape.id], format: 'png', opts: { background: false, padding: 0, scale: 1 } });
      const image = new Image(), objectUrl = URL.createObjectURL(png);
      try {
        image.src = objectUrl; await image.decode();
        const canvas = window.document.createElement('canvas'); canvas.width = Math.max(1, Math.ceil(geometry.width)); canvas.height = Math.max(1, Math.ceil(geometry.height));
        const ctx = canvas.getContext('2d')!, inverse = Mat.From(Mat.Inverse(ed.getShapePageTransform(shape)));
        ctx.setTransform(inverse.a, inverse.b, inverse.c, inverse.d, inverse.e - geometry.x, inverse.f - geometry.y);
        ctx.drawImage(image, pageBounds.x, pageBounds.y, pageBounds.width, pageBounds.height); ctx.resetTransform();
        let opacity = shape.opacity, parent = ed.getShape(shape.parentId as TLShape['id']);
        while (parent) { opacity *= parent.opacity; parent = ed.getShape(parent.parentId as TLShape['id']); }
        if (opacity > 0 && opacity < 1) {
          const raw = ctx.getImageData(0, 0, canvas.width, canvas.height);
          for (let i = 3; i < raw.data.length; i += 4) raw.data[i] = Math.min(255, Math.round(raw.data[i] / opacity));
          ctx.putImageData(raw, 0, 0);
        }
        const localPng = await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('原对象像素导出失败')), 'image/png'));
        assertScope(captured); proxy = await rawUpload(localPng, `${shape.type}.png`, 'native_projection');
      } finally { URL.revokeObjectURL(objectUrl); }
    }
    const vector = proxy.mime === 'image/svg+xml', angle = shape.rotation, localX = shape.x + geometry.x * Math.cos(angle) - geometry.y * Math.sin(angle), localY = shape.y + geometry.x * Math.sin(angle) + geometry.y * Math.cos(angle);
    return { ...base, type: vector ? 'vector' : 'raster', x: localX, y: localY, width: geometry.width, height: geometry.height, rotation: shape.rotation * 180 / Math.PI, parentId: base.parentId,
      assetId: proxy.id, name: previous?.name || shape.type, editability: vector ? 'path' : 'pixels',
      metadata: { ...base.metadata, ...(shape.type === 'text' ? { nativeProjection: true, nativeTextFormat: 'preserved', fontStatus: 'mixed_styles_preserved', recognizedText: plainRichText(props.richText) } : {}), legacyProxyAssetId: proxy.id, legacyProxyOrigin: { x: localX, y: localY }, legacyProxySize: { width: geometry.width, height: geometry.height } } };
  }
  async function sync(): Promise<ImageDocument> {
    if (syncPromise.current) return syncPromise.current;
    const invocation = scope();
    const task = (async () => {
      await ensureDocument(); assertScope(invocation); if (draftConflict.current) throw new Error('服务器版本与本地草稿冲突；请在版本窗口处理，未覆盖服务器');
      const captured = scope(), version = editGeneration.current, capturedDraft = canvasDraft.current, ed = state.current.editor!;
      await queue.current!.flush(canonical.current!, next => { assertScope(captured); accept(next, false); });
      assertScope(captured);
      const waiting = await queue.current!.pending(canonical.current!.id); setPendingCount(waiting.length);
      if (waiting.length) throw new Error('本地编辑与服务器版本冲突，草稿已保留，请先在版本窗口处理');
      const fresh = unwrapDocument(await image2Api<ImageDocument>(`/documents/${canonical.current!.id}`)); assertScope(captured);
      if (fresh.revision > canonical.current!.revision) {
        if (dirty.current) { draftConflict.current = true; setHasDraftConflict(true); throw new Error('服务器已有新版本，本地画布草稿已保留，请在版本窗口处理'); }
        accept(fresh);
      }
      const commands: DocumentCommand[] = [], present = new Set(ed.getCurrentPageShapeIds());
      const live = canonical.current!;
      for (const layer of live.layers) if (!present.has(layerShapeId(layer)) && (!layer.parentId || present.has(layerShapeId(live.layers.find(l => l.id === layer.parentId)!)))) commands.push({ type: 'layer.remove', layerId: layer.id });
      const all = ed.getCurrentPageShapes().sort((a, b) => String(a.index).localeCompare(String(b.index)));
      const staged = new Map<string, ImageLayer>(), remaining = [...all];
      while (remaining.length) {
        const at = remaining.findIndex(s => !all.some(p => p.id === s.parentId) || staged.has(s.parentId));
        if (at < 0) throw new Error('画布分组存在循环，原草稿已保留');
        const shape = remaining.splice(at, 1)[0], z = all.findIndex(s => s.id === shape.id);
        const previous = live.layers.find(layer => layerShapeId(layer) === shape.id);
        if (previous && fingerprints.current.get(shape.id) === shapeFingerprint(shape)) { staged.set(shape.id, previous); continue; }
        const layer = await layerForShape(shape, previous, staged); assertScope(captured); layer.z = z; staged.set(shape.id, layer);
        if (previous) { const { id: _id, ...patch } = layer; void _id; commands.push({ type: 'layer.update', layerId: previous.id, patch }); }
        else commands.push({ type: 'layer.add', layer });
      }
      if (state.current.projectName !== canonical.current!.name) commands.push({ type: 'document.update', patch: { name: state.current.projectName } });
      if (commands.length) { await queue.current!.enqueue(live.id, commands); assertScope(captured); }
      await queue.current!.flush(canonical.current!, next => { assertScope(captured); accept(next, false); });
      assertScope(captured);
      const remainingCommands = await queue.current!.pending(live.id); assertScope(captured); setPendingCount(remainingCommands.length);
      const saved = canonical.current!;
      dirty.current = editGeneration.current !== version;
      if (!dirty.current) {
        project(saved);
        setError('');
        if (capturedDraft) { await legacyDraftStorage.remove(captured.projectId, capturedDraft); assertScope(captured); if (canvasDraft.current?.savedAt === capturedDraft.savedAt) canvasDraft.current = undefined; }
      }
      return saved;
    })();
    syncPromise.current = task;
    let saved: ImageDocument; try { saved = await task; } finally { if (syncPromise.current === task) syncPromise.current = null; }
    assertScope(invocation);
    return dirty.current ? sync() : saved;
  }
  async function importCanvas() {
    if (canonical.current) {
      await sync();
      if (canonical.current.metadata?.legacyImportComplete !== true) await submitCommands([{ type: 'document.update', patch: { metadata: { ...canonical.current.metadata, legacyImportComplete: true } } }]);
      localStorage.setItem(mapKey(state.current.projectId), canonical.current.id); setNeedsImport(false); return canonical.current;
    }
    const ed = state.current.editor; if (!ed) throw new Error('画布还未加载'); setBusy(true);
    try {
      const snapshot = getSnapshot(ed.store).document;
      // The snapshot retains identities and native objects; image bytes live in immutable assets, not duplicated data URLs.
      const safeSnapshot = structuredClone(snapshot);
      for (const value of Object.values(safeSnapshot.store)) if ((value as { typeName?: string }).typeName === 'asset') {
        const asset = value as { props: { src?: string } }; if (asset.props.src?.startsWith('data:')) asset.props.src = '[immutable asset mapping]';
      }
      const captured = scope();
      const next = unwrapDocument(await image2Api<ImageDocument>('/documents', { name: state.current.projectName, width: 1024, height: 1024, metadata: { legacyProjectId: state.current.projectId, legacySnapshot: safeSnapshot, legacyImportComplete: false } })); assertScope(captured);
      canonical.current = next; fingerprints.current.clear(); dirty.current = true;
      await sync(); await submitCommands([{ type: 'document.update', patch: { metadata: { ...canonical.current!.metadata, legacyImportComplete: true } } }]); localStorage.setItem(mapKey(state.current.projectId), next.id); setNeedsImport(false); await refresh(); return canonical.current!;
    } catch (err) { report(err); throw err; } finally { setBusy(false); }
  }
  function getLayer(src?: string, layerId?: string) {
    const doc = canonical.current; if (!doc) return;
    const selected = state.current.editor?.getOnlySelectedShape();
    if (layerId) return doc.layers.find(layer => layer.id === layerId);
    const selectedLayer = selected ? doc.layers.find(layer => layerShapeId(layer) === selected.id) : undefined;
    if (!src) return selectedLayer;
    if (selectedLayer?.assetId && (src === assetUrl(selectedLayer.assetId) || src.endsWith(assetUrl(selectedLayer.assetId)))) return selectedLayer;
    const selectedOriginal = selectedLayer?.metadata?.legacyRecord as TLShape | undefined;
    const selectedOriginalAssetId = (selectedOriginal?.props as { assetId?: TLAssetId } | undefined)?.assetId;
    const selectedOriginalAsset = selectedOriginalAssetId ? state.current.editor?.getAsset(selectedOriginalAssetId) : undefined;
    if (selectedLayer && (selectedOriginalAsset?.props as { src?: string })?.src === src) return selectedLayer;
    const id = aliases.current.get(src) || doc.layers.find(layer => layer.assetId && (src === assetUrl(layer.assetId) || src.endsWith(assetUrl(layer.assetId))))?.id;
    if (id) return doc.layers.find(layer => layer.id === id);
    if (src && selected) { const id = (selected.props as { assetId?: TLAssetId }).assetId; const a = id ? state.current.editor?.getAsset(id) : undefined; if ((a?.props as { src?: string })?.src === src) return doc.layers.find(layer => layerShapeId(layer) === selected.id); }
    return undefined;
  }
  async function submitCommands(commands: DocumentCommand[]) {
    if (!commands.length) return; const captured = scope(); await sync(); assertScope(captured); const live = canonical.current!;
    await queue.current!.enqueue(live.id, commands);
    try { await queue.current!.flush(live, next => { assertScope(captured); accept(next); }); }
    finally { setPendingCount((await queue.current!.pending(live.id)).length); }
  }
  async function uploadFile(file: Blob, name: string, role = 'source') { const captured = scope(); await sync(); assertScope(captured); return rawUpload(file, name, role); }
  async function resolveReference(src: string, documentId: string) {
    const captured = scope();
    if (canonical.current?.id !== documentId) throw new Error('已切换工程，旧工程任务与草稿保留');
    const immutable = immutableSourceId(src), existing = immutable ? currentAssets.current.find(a => a.id === immutable) : undefined;
    if (existing) return existing;
    const bytes = await sourceBlob(src); assertScope(captured);
    return rawUpload(bytes, '参考图片', 'reference');
  }
  async function defaultFont() {
    const captured = scope(); await sync(); assertScope(captured); const id = canonical.current!.id;
    const asset = await image2Api<ImageAsset>('/assets/default-font', { documentId: id }); assertScope(captured);
    updateAssets([...currentAssets.current, asset]); const next = unwrapDocument(await image2Api<ImageDocument>(`/documents/${id}`)); assertScope(captured); accept(next, false); return asset;
  }
  async function setMasks(src: string, edit: Blob, protect?: Blob, layerId?: string) {
    const captured = scope(); await sync(); assertScope(captured); const layer = getLayer(src, layerId); if (!layer) throw new Error('请选择原图图层');
    const e = await rawUpload(edit, 'edit-mask.png', 'edit_mask');
    const p = protect ? await rawUpload(protect, 'protect-mask.png', 'protect_mask') : undefined;
    await submitCommands([{ type: 'layer.update', layerId: layer.id, patch: { metadata: { ...layer.metadata, editMaskAssetId: e.id, ...(p ? { protectMaskAssetId: p.id } : {}) } } }]);
  }
  async function submitOperation(operation: string, params: Record<string, unknown> = {}, src?: string, options: LegacyOperationOptions = {}) {
    if (options.documentId && canonical.current?.id !== options.documentId) throw new Error('已切换工程，旧工程任务与草稿保留');
    const captured = scope(); await sync(); assertScope(captured); let target = operation === 'generate' && !options.layerId ? undefined : getLayer(src, options.layerId);
    if (!target && operation !== 'generate') throw new Error('请选择要处理的图层');
    const status = capability(capabilities, operation);
    if (!status.available) throw new Error(status.reason || '功能尚未配置');
    const pending = await submissions.current!.pending(canonical.current!.id);
    for (const attempt of pending) {
      const result = await submissions.current!.resume<{ job: ImageJob }>(attempt); assertScope(captured);
      setJobs(prev => [result.job, ...prev.filter(job => job.id !== result.job.id)]);
    }
    // Recover the frozen submission first. A new mask/reference/model is a new
    // intent even when its operation and text match; never label old output as it.
    if (pending.length) { await refresh(); throw new Error('已恢复上一次提交，本次参数尚未执行；请在版本窗口查看原任务后重新操作'); }
    if (options.editMask && target) { await setMasks(assetUrl(target.assetId!), options.editMask, options.protectMask, target.id); assertScope(captured); target = canonical.current!.layers.find(l => l.id === target!.id); }
    const live = canonical.current!, regional = ['recolor', 'erase', 'fill', 'repair', 'inpaint', 'refine_mask'].includes(operation);
    const inputs = [...(target?.assetId ? [{ role: 'base', assetId: target.assetId }] : []), ...(options.inputs || [])];
    const edit = target?.metadata?.editMaskAssetId, protect = target?.metadata?.protectMaskAssetId;
    if (regional && typeof edit === 'string') inputs.push({ role: 'edit_mask', assetId: edit });
    if (regional && typeof protect === 'string') inputs.push({ role: 'protect_mask', assetId: protect });
    if (['erase', 'repair', 'fill', 'inpaint'].includes(operation) && !inputs.some(i => i.role === 'edit_mask')) throw new Error('请先选择修改范围和保护范围');
    const intent = { documentId: live.id, operation, targetLayerId: target?.id, params, inputs, mode: options.mode || (['generate', 'inpaint', 'restore_layers'].includes(operation) ? 'candidate' : 'apply') };
    const result = await submissions.current!.submit<{ job: ImageJob }>('/operations', intent, { ...intent, baseRevision: live.revision }); assertScope(captured); setJobs(prev => [result.job, ...prev.filter(j => j.id !== result.job.id)]); return result.job;
  }
  async function waitJob(jobOrId: ImageJob | string) {
    const captured = scope(), id = typeof jobOrId === 'string' ? jobOrId : jobOrId.id;
    for (let i = 0; i < 240; i++) {
      const job = await image2Api<ImageJob>(`/jobs/${id}`); assertScope(captured); setJobs(prev => [job, ...prev.filter(item => item.id !== id)]);
      if (job.state === 'complete') {
        await refresh();
        // A multistage edit must use the applied output revision even when a background poll coincided with a local sync.
        await sync(); return job;
      }
      if (['failed', 'uncertain', 'cancelled', 'awaiting_user'].includes(job.state)) throw new Error(job.error || ({ uncertain: '供应商提交状态未知，任务已保存，不会自动重复提交', awaiting_user: '需要确认处理范围或补充配置', cancelled: '任务已停止', failed: '处理失败' } as Record<string, string>)[job.state]);
      await pause(250);
    }
    throw new Error('任务仍在后台处理中，可以在版本窗口继续查看');
  }
  async function applyFont(slot: string, url: string) {
    if (!canonical.current) return; const captured = scope(); await sync(); assertScope(captured); const selected = getLayer(); if (!selected || selected.type !== 'text') return;
    const face = await font(slot, url); await submitCommands([{ type: 'layer.update', layerId: selected.id, patch: { fontAssetId: face.id, fontFamily: String(face.metadata?.family || ''), fontWeight: Number(face.metadata?.weight || 400), metadata: { ...selected.metadata, legacyFontSlot: slot, nativeFontAssetId: face.id } } }]);
  }
  async function confirmText(src: string, rect: { x: number; y: number; width: number; height: number }, oldText: string, newText: string, face?: ImageAsset, size = 32, color = '#1d1d1d', layerId?: string) {
    const captured = scope(); await sync(); assertScope(captured); let target = getLayer(src, layerId); if (!target?.assetId) throw new Error('请选择要改字的图片');
    if (!(target.type === 'text' && target.metadata?.fontConfirmed !== true)) {
      const source = currentAssets.current.find(a => a.id === target!.assetId)!;
      if (!source || !Object.values(rect).every(Number.isInteger) || rect.width <= 0 || rect.height <= 0 || rect.x < 0 || rect.y < 0 || rect.x + rect.width > source.width! || rect.y + rect.height > source.height!) throw new Error('文字范围必须在原图像素边界内');
      const sx = target.width / source.width!, sy = target.height / source.height!;
      // The crop processor applies source-pixel offsets in this full canvas
      // frame. Pre-offsetting the temporary layer would move the text twice.
      const patch = { ...emptyLayer('raster', oldText || '待确认文字'), assetId: target.assetId, sourceAssetId: target.sourceAssetId || target.assetId, sourceRect: [0, 0, source.width!, source.height!], x: target.x, y: target.y, width: target.width, height: target.height, rotation: target.rotation, parentId: target.parentId, z: Math.max(...canonical.current!.layers.map(l => l.z)) + 1, metadata: { sourceImageLayerId: target.id } } as ImageLayer;
      await submitCommands([{ type: 'layer.add', layer: patch }]);
      await waitJob(await submitOperation('crop', rect, undefined, { layerId: patch.id })); assertScope(captured);
      target = canonical.current!.layers.find(l => l.id === patch.id)!;
      await submitCommands([{ type: 'layer.update', layerId: target.id, patch: { type: 'text', width: rect.width * sx, height: rect.height * sy, text: oldText, editability: 'text', metadata: { ...target.metadata, sourcePatchAssetId: target.assetId, fontConfirmed: false, fontStatus: 'unknown', desiredText: newText } } }]);
      target = canonical.current!.layers.find(l => l.id === patch.id)!;
    }
    if (!target.metadata?.cleanBackgroundAssetId) await waitJob(await submitOperation('prepare_text', { purpose: 'text_background' }, undefined, { layerId: target.id })); assertScope(captured);
    target = canonical.current!.layers.find(l => l.id === target!.id)!;
    face ||= await defaultFont();
    const metadata = { ...target.metadata, fontConfirmed: true, fontStatus: 'confirmed', desiredText: newText, backgroundDetached: true };
    const commands: DocumentCommand[] = [];
    if (typeof target.metadata?.cleanBackgroundAssetId !== 'string') throw new Error('背景复杂，请先选择范围进行传统修补或局部补画；原文字像素保留');
    if (!target.metadata.backgroundDetached) {
      const background = { ...emptyLayer('raster', '原字清底背景'), x: target.x, y: target.y, width: target.width, height: target.height, rotation: target.rotation, parentId: target.parentId, z: target.z,
        assetId: target.metadata.cleanBackgroundAssetId as string, editability: 'pixels' as const, metadata: { role: 'text_background', textLayerId: target.id } };
      commands.push({ type: 'layer.add', layer: background }); (metadata as Record<string, unknown>).backgroundLayerId = background.id;
    }
    commands.push({ type: 'layer.update', layerId: target.id, patch: { text: newText, fontAssetId: face.id, fontFamily: String(face.metadata?.family || ''), fontWeight: Number(face.metadata?.weight || 400), fontSize: size, fill: color, z: target.z + 1, metadata } });
    await submitCommands(commands); selectLayer(target.id); await refresh();
  }
  async function startRun(text: string, referenceSrcs: string[] = [], model?: string) {
    const captured = scope(); await sync(); assertScope(captured); const live = canonical.current!;
    const pending = await submissions.current!.pending(live.id);
    if (pending.length) {
      await submissions.current!.recover(live.id, value => { assertScope(captured); const job = (value as { job?: ImageJob }).job; if (job) setJobs(prev => [job, ...prev.filter(item => item.id !== job.id)]); }); assertScope(captured);
      await refresh(); throw new Error('已恢复上一次提交，本次消息与参考尚未发送；请在版本窗口查看原任务后重新发送');
    }
    if (!conversation.current) { const thread = await image2Api<Conversation>('/conversations', { documentId: live.id }); assertScope(captured); conversation.current = thread; }
    const references: Array<{ assetId?: string; layerId?: string; revision: number }> = [];
    for (const src of referenceSrcs) {
      const immutable = immutableSourceId(src);
      const layer = getLayer(src);
      const existing = immutable ? currentAssets.current.find(a => a.id === immutable) : undefined;
      let asset = existing;
      if (!asset) { const bytes = await sourceBlob(src); assertScope(captured); asset = await rawUpload(bytes, '对话参考.png', 'reference'); assertScope(captured); }
      references.push({ assetId: asset.id, ...(layer?.assetId === asset.id ? { layerId: layer.id } : {}), revision: live.revision });
    }
    const selected = getLayer(); if (selected && !referenceSrcs.length) references.push({ layerId: selected.id, assetId: selected.assetId, revision: live.revision });
    const intent = { documentId: live.id, conversationId: conversation.current.id, text, references, model };
    const result = await submissions.current!.submit<{ job: ImageJob }>(`/conversations/${conversation.current.id}/messages`, intent, { text, references, model }); assertScope(captured); await refresh(); return result.job;
  }
  async function acceptCandidate(branchId: string) {
    const captured = scope(); await sync(); assertScope(captured); const live = canonical.current!; const next = await mutations.current!.submit(`/documents/${live.id}/accept`, { documentId: live.id, branchId }, { baseRevision: live.revision, branchDocumentId: branchId }); assertScope(captured); accept(next); await refresh();
  }
  async function history(direction: 'undo' | 'redo') {
    const captured = scope(); await sync(); assertScope(captured); const live = canonical.current!; const next = await mutations.current!.submit(`/documents/${live.id}/history`, { documentId: live.id, direction }, { baseRevision: live.revision, direction }); assertScope(captured); accept(next); await refresh();
  }
  async function exportDocument(format: 'png' | 'svg' | 'pdf' | 'project') {
    const captured = scope(); await sync(); assertScope(captured); const live = canonical.current!, ed = state.current.editor!;
    const ids = ed.getSelectedShapeIds().length ? ed.getSelectedShapeIds() : [...ed.getCurrentPageShapeIds()];
    const selected = new Set(ids), boxes = ids.map(id => ed.getShapePageBounds(id)).filter(b => !!b);
    if (!boxes.length) throw new Error('画布没有可导出的对象');
    const x = Math.min(...boxes.map(b => b.x)), y = Math.min(...boxes.map(b => b.y));
    const bounds = { x, y, width: Math.max(1, Math.ceil(Math.max(...boxes.map(b => b.maxX)) - x)), height: Math.max(1, Math.ceil(Math.max(...boxes.map(b => b.maxY)) - y)) };
    const layerIds = live.layers.filter(l => selected.has(layerShapeId(l))).map(l => l.id);
    const exportScope = format === 'project' ? {} : { layerIds, bounds }, intent = { documentId: live.id, format, revision: live.revision, ...exportScope };
    const receipt = await submissions.current!.submit<{ job: ImageJob }>('/exports', intent, { ...intent, baseRevision: live.revision }); const job = await waitJob(receipt.job);
    if (typeof job.output?.assetId !== 'string') throw new Error('导出文件还未保存'); return { blob: await sourceBlob(assetUrl(job.output.assetId)), name: String(job.output.filename || `${live.name}.${format === 'project' ? 'zip' : format}`) };
  }
  async function importPackage(file: File) {
    const captured = scope(), editor = state.current.editor!;
    const data = await new Promise<string>((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1]); r.onerror = reject; r.readAsDataURL(file); });
    assertScope(captured); const result = await image2Api<{ document: ImageDocument }>('/imports/project', { data }); assertScope(captured); canonical.current = null;
    const ed = editor; projecting.current = true; try { ed.store.mergeRemoteChanges(() => ed.run(() => ed.deleteShapes([...ed.getCurrentPageShapeIds()]), { history: 'ignore', ignoreShapeLock: true })); } finally { projecting.current = false; }
    await bind(unwrapDocument(result));
  }
  async function addFile(file: File) {
    const captured = scope(), ed = state.current.editor!; const asset = await uploadFile(file, file.name); assertScope(captured); const point = ed.getViewportPageBounds().center;
    const layer = { ...emptyLayer(asset.mime === 'image/svg+xml' ? 'vector' : 'raster', file.name), x: point.x, y: point.y, width: asset.width || 200, height: asset.height || 200, assetId: asset.id, sourceAssetId: asset.id, z: canonical.current!.layers.length, editability: asset.mime === 'image/svg+xml' ? 'path' as const : 'pixels' as const };
    await submitCommands([{ type: 'layer.add', layer }]); selectLayer(layer.id); return layer;
  }
  function selectLayer(id: string) {
    const layer = canonical.current?.layers.find(l => l.id === id), ed = state.current.editor;
    if (layer && ed) {
      const shapeId = layerShapeId(layer); ed.select(shapeId);
      const bounds = ed.getShapePageBounds(shapeId), viewport = ed.getViewportPageBounds();
      if (bounds && (bounds.maxX < viewport.x || bounds.x > viewport.maxX || bounds.maxY < viewport.y || bounds.y > viewport.maxY)) ed.zoomToBounds(bounds, { targetZoom: ed.getZoomLevel(), animation: { duration: 0 } });
    }
    setSelectedId(id);
  }
  async function useServerVersion() {
    const live = canonical.current; if (!live) return;
    const captured = scope(), version = editGeneration.current, draft = canvasDraft.current;
    const fresh = unwrapDocument(await image2Api<ImageDocument>(`/documents/${live.id}`)); assertScope(captured);
    const assertUnchanged = () => { assertScope(captured); if (editGeneration.current !== version) throw new Error('操作期间画布新增编辑，草稿已保留，请重新选择版本'); };
    assertUnchanged();
    if (draft) await legacyDraftStorage.remove(captured.projectId, draft); assertUnchanged();
    await queue.current!.discard(live.id); assertUnchanged(); canvasDraft.current = undefined; dirty.current = false; draftConflict.current = false; setHasDraftConflict(false);
    accept(fresh); await refresh();
  }
  async function saveDraftAsProject() {
    const draft = canvasDraft.current; if (!draft) throw new Error('没有待保存的画布草稿');
    const live = canonical.current!, captured = scope(), name = state.current.projectName;
    // Keep all current assets available. No existing main document is edited or overwritten.
    const fresh = unwrapDocument(await image2Api<ImageDocument>('/documents', { name: `${name} 草稿`, width: live.width, height: live.height, layers: live.layers, assetIds: live.assetIds,
      metadata: { ...live.metadata, legacyProjectId: captured.projectId, recoveredDraftOf: live.id } })); assertScope(captured);
    canonical.current = fresh; dirty.current = true; draftConflict.current = false; setHasDraftConflict(false); canvasDraft.current = undefined;
    const savedScope = { ...captured, documentId: fresh.id };
    await sync(); assertScope(savedScope); await legacyDraftStorage.remove(captured.projectId, draft); assertScope(savedScope); localStorage.setItem(mapKey(captured.projectId), fresh.id); await refresh();
  }
  return { document, assets, jobs, branches, messages, capabilities, revisions, error, busy, needsImport, pendingCount, selectedLayer: document?.layers.find(l => l.id === selectedId),
    ensureDocument, importCanvas, sync, refresh, getLayer, submitCommands, updateLayer: (id: string, patch: Partial<ImageLayer>) => submitCommands([{ type: 'layer.update', layerId: id, patch }]),
    submitOperation, waitJob, setMasks, uploadFile, resolveReference, defaultFont, applyFont, confirmText, startRun, acceptCandidate, export: exportDocument, importPackage, addFile, selectLayer,
    hasDraftConflict, useServerVersion, saveDraftAsProject,
    undo: () => history('undo'), redo: () => history('redo'), cancelJob: async (id: string) => { await image2Api(`/jobs/${id}/cancel`, {}); await refresh(); } };
}
