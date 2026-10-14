'use client';
import { useEffect, useRef, useState } from 'react';
import { exportToBlob, getSnapshot, loadSnapshot, Mat, type Editor, type TLAssetId, type TLShape } from 'tldraw';
import { image2Api, assetUrl, listValue, unwrapDocument, uploadAsset, Image2ApiError } from './client';
import { ImageCommandQueue, applyDraft } from './queue';
import { ImageSubmissionManager } from './submissions';
import { image2Storage, submissionStorage, cachedDocument } from './storage';
import { capability } from './geometry';
import { legacyDraftStorage, createLegacyCanvasDraft, classifyLegacyDraft, readLegacyDocumentDraft, removeLegacyDocumentDraft, type LegacyCanvasDraft } from './legacy-drafts';
import { LegacyDocumentMutationManager, getMutationsStorage, LEGACY_MUTATION_PREFIX } from './legacy-mutations';
import { legacyColors, legacyFontSizes, legacyFontUrls, legacyFontVersion, layerShapeId, plainRichText, projectLegacyDocument, shapeFingerprint } from './legacy-projection';
import { ProfessionalMigrationManager, MIGRATION_PREFIX } from './professional-migration';
import { asProfessional, applyProfessionalCommands, worldBounds, deriveWorldDelta, duplicateProfessionalLayerCommands, groupProfessionalLayerCommands, ungroupProfessionalLayerCommands, worldMatrix, multiplyMatrix } from './professional-model';
import { professionalLegacyView, projectProfessionalDocument, migratedProjectionResidueIds } from './professional-projection';
import { professionalSvgContent, svgPaintPatch } from './professional-svg-styles';
import { imageCapabilitiesForDocument, requireImageAgent } from './agent-capabilities';
import { candidatePreviewState } from './candidate-preview';
import { parseLayerReference } from './layer-references';
import { canvasParentLayerId, canvasShapesParentFirst } from './native-shape-order';
import { createImageFontLoader, ImageFontLoadError } from './font-loader';
import { createImageFontSession, type ImageFontSession, type ImageFontLoadState } from './font-session';
import { LegacyBindingInitialization, legacyCreationKey, findPendingLegacyCreation, recoverOrCreateLegacyDocument, assertLegacyRecoveryCanvas } from './legacy-binding';
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
  const initialization = useRef(new LegacyBindingInitialization());
  const [savedProjectDocuments, setSavedProjectDocuments] = useState<ImageDocument[]>([]);
  const commandEdits = useRef<Promise<void>>(Promise.resolve());
  const [fontStates, setFontStates] = useState<Record<string, ImageFontLoadState>>({});
  const fontSession = useRef<ImageFontSession<FontFace> | null>(null);
  if (!fontSession.current) fontSession.current = createImageFontSession({
    loader: createImageFontLoader(),
    createFace: (asset, bytes) => new FontFace(`i2-${asset.id}`, bytes, { weight: String(asset.metadata?.weight || 400) }).load(),
    addFace: face => { window.document.fonts.add(face); },
    deleteFace: face => { window.document.fonts.delete(face); },
    onStateChange: setFontStates,
  });
  const clearFonts = () => fontSession.current!.clear();
  const editGeneration = useRef(0), canvasDraft = useRef<LegacyCanvasDraft | undefined>(undefined), draftConflict = useRef(false);
  const [hasDraftConflict, setHasDraftConflict] = useState(false);
  const [professionalDocument, setProfessionalDocument] = useState<ImageDocument | null>(null);
  const [rawDocument,setRawDocument] = useState<ImageDocument | null>(null);
  const contentPayloads = useRef<Record<string, Record<string, unknown>>>({}), loadedContents = useRef(new Map<string, string>());
  const migration = useRef<ProfessionalMigrationManager | null>(null);
  if (!migration.current) migration.current = new ProfessionalMigrationManager(submissionStorage, (path, body) => image2Api(path, body));
  const viewDocument = (next: ImageDocument) => next.schemaVersion === 3 ? professionalLegacyView(next, contentPayloads.current) : next;
  const scope = () => ({ generation: epoch.current, projectId: state.current.projectId, documentId: canonical.current?.id });
  const assertScope = (captured: ReturnType<typeof scope>) => { if (epoch.current !== captured.generation || state.current.projectId !== captured.projectId || (captured.documentId && canonical.current?.id !== captured.documentId)) throw new Error('已切换工程，旧工程任务与草稿保留'); };
  const queue = useRef<ImageCommandQueue | null>(null), submissions = useRef<ImageSubmissionManager | null>(null), mutations = useRef<LegacyDocumentMutationManager | null>(null);
  if (!queue.current) queue.current = new ImageCommandQueue(image2Storage, async (id, body) => unwrapDocument(await image2Api(`/documents/${id}/commands`, body)));
  if (!submissions.current) submissions.current = new ImageSubmissionManager({ ...submissionStorage, list: async () => (await submissionStorage.list()).filter(attempt => !attempt.intent.startsWith(LEGACY_MUTATION_PREFIX) && !attempt.intent.startsWith(MIGRATION_PREFIX)) }, (path, body) => image2Api(path, body));
  if (!mutations.current) mutations.current = new LegacyDocumentMutationManager(getMutationsStorage(), (path, body) => image2Api(path, body));
  const report = (err: unknown) => { const text = err instanceof Error ? err.message : String(err); setError(text); state.current.onError?.(text); };
  const project = (next: ImageDocument, reconcileLegacyProjection = false) => {
    if (!state.current.editor) return;
    projecting.current = true;
    try { state.current.editor.store.mergeRemoteChanges(() => next.schemaVersion === 3 ? projectProfessionalDocument(state.current.editor!, next, fingerprints.current, contentPayloads.current, { reconcileLegacyProjection: reconcileLegacyProjection && !dirty.current && !canvasDraft.current }) : projectLegacyDocument(state.current.editor!, next, fingerprints.current)); }
    finally { projecting.current = false; }
    for (const layer of viewDocument(next).layers) if (layer.assetId) {
      aliases.current.set(assetUrl(layer.assetId), layer.id);
      const original = layer.metadata?.legacyRecord as TLShape | undefined;
      const originalId = (original?.props as { assetId?: TLAssetId } | undefined)?.assetId;
      const originalAsset = originalId ? state.current.editor.getAsset(originalId) : undefined;
      const src = (originalAsset?.props as { src?: string } | undefined)?.src; if (src) aliases.current.set(src, layer.id);
    }
    setSelectedId(state.current.editor.getOnlySelectedShape()?.meta.image2LayerId as string | undefined);
  };
  const accept = (next: ImageDocument, render = true, reconcileLegacyProjection = false) => {
    if (canonical.current && canonical.current.id !== next.id) return;
    if (canonical.current && canonical.current.revision > next.revision) return;
    canonical.current = next; setRawDocument(next); setDocument(viewDocument(next)); setProfessionalDocument(next.schemaVersion === 3 ? next : null); void image2Storage.saveDocument(next);
    if (next.schemaVersion === 3) void loadContents(next).catch(report);
    if (render) project(next, reconcileLegacyProjection);
  };
  async function loadContents(next: ImageDocument) {
    const captured = scope(); let changed = false;
    const used=new Set([...next.layers.flatMap(layer=>[layer.contentId,...(layer.masks || []).map(mask=>mask.contentId)]),...(next.savedSelections || []).map(selection=>selection.contentId)]);
    for (const descriptor of (next.contentAssets || []).filter(content=>used.has(content.id))) {
      if (['raster','tiles'].includes(descriptor.kind) || loadedContents.current.get(descriptor.id) === descriptor.assetId) continue;
      const response = await fetch(assetUrl(descriptor.assetId));
      if (!response.ok) throw new Error('内容资产暂不可读取');
      if (!response.headers.get('content-type')?.includes('json')) { if(descriptor.kind==='svg'){contentPayloads.current[descriptor.id]={formatVersion:1,kind:'svg',sourceAssetId:descriptor.assetId,fontAssetIds:[]};changed=true;}loadedContents.current.set(descriptor.id, descriptor.assetId); continue; }
      const payload = await response.json(); assertScope(captured);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('内容资产格式无效');
      contentPayloads.current[descriptor.id] = payload; loadedContents.current.set(descriptor.id,descriptor.assetId); changed = true;
    }
    if (changed && canonical.current?.id === next.id) { setDocument(viewDocument(canonical.current)); if (!dirty.current) project(canonical.current); }
  }
  const updateAssets = (list: ImageAsset[]) => {
    currentAssets.current = list; setAssets(list);
    const documentId = canonical.current?.id;
    if (!documentId) return;
    fontSession.current!.bind(documentId);
    for (const asset of list.filter(fontFile)) {
      const captured = scope();
      void fontSession.current!.load(asset).catch(err => {
        if (err instanceof ImageFontLoadError && err.code === 'font_cancelled') return;
        if (epoch.current !== captured.generation || state.current.projectId !== captured.projectId || canonical.current?.id !== captured.documentId) return;
        report(new Error(`字体 ${asset.name} 加载失败：${err instanceof Error ? err.message : '字体暂不可读取'}`));
      });
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
    fontSession.current!.bind(next.id);
    canonical.current = next; dirty.current = false; aliases.current.clear(); fingerprints.current.clear(); fontCache.current.clear(); contentPayloads.current = {}; loadedContents.current.clear();
    localStorage.setItem(mapKey(projectId), next.id); setNeedsImport(false);
    let draft = await readLegacyDocumentDraft(legacyDraftStorage, projectId, next.id); assertScope({ ...captured, documentId: undefined });
    canvasDraft.current = draft;
    const waiting = await queue.current!.pending(next.id);
    assertScope({ ...captured, documentId: next.id });
    let queueConflict = waiting.some(batch => batch.state === 'blocked');
    try { await queue.current!.flush(next, doc => { assertScope({ ...captured, documentId: next.id }); accept(doc, false); }); }
    catch (err) { if (err instanceof Image2ApiError && err.status === 409) { queueConflict = true; report(err); } else throw err; }
    assertScope({ ...captured, documentId: next.id });
    const live = canonical.current!;
    if (live.schemaVersion === 3) await loadContents(live);
    accept(live, true, !draft && !queueConflict && !waiting.length);
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
      const migratedResidue = live.schemaVersion === 3 && migratedProjectionResidueIds(live, state.current.editor!.getCurrentPageShapes()).length > 0;
      if (queueConflict || migratedResidue || (disposition === 'revision_conflict' && !waiting.length)) { draftConflict.current = true; setHasDraftConflict(true); report(new Error(migratedResidue ? '本地草稿包含升级前对象，已完整保留；请在版本窗口另存草稿或采用服务器版本，避免覆盖当前修改' : '服务器已有新版本；原画布草稿已保留，请在版本窗口另存草稿或采用服务器版本')); }
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
    clearFonts();
    const generation = ++epoch.current; canonical.current = null; conversation.current = null; syncPromise.current = null; commandEdits.current = Promise.resolve();
    queueMicrotask(() => { if (generation === epoch.current) { setDocument(null); setRawDocument(null); setProfessionalDocument(null); setAssets([]); setJobs([]); setBranches([]); setMessages([]); setRevisions([]); setSavedProjectDocuments([]); setNeedsImport(false); setHasDraftConflict(false); } });
    dirty.current = false; canvasDraft.current = undefined; draftConflict.current = false; fingerprints.current.clear(); aliases.current.clear();
    void initialization.current.begin({ editor, projectId }, async () => {
      try {
        const caps = await image2Api<Capabilities>('/capabilities'); if (generation !== epoch.current) return; setCapabilities(caps);
        const id = localStorage.getItem(mapKey(projectId));
        const pendingCreation = localStorage.getItem(legacyCreationKey(projectId));
        if (pendingCreation) {
          const all = listValue(await image2Api<ImageDocument[]>('/documents'), 'documents');
          if (generation !== epoch.current || state.current.projectId !== projectId) return;
          const recovered = findPendingLegacyCreation(all, projectId, pendingCreation);
          if (!recovered || (id && id !== recovered.id)) throw new Error('新建工程的结果尚待确认，原绑定已保留；请稍后重新连接，不会重复新建');
          await bind(recovered); if (generation !== epoch.current) return;
          localStorage.removeItem(legacyCreationKey(projectId)); return;
        }
        if (id) { const next = unwrapDocument(await image2Api<ImageDocument>(`/documents/${id}`)); if (generation === epoch.current) { await bind(next); if (next.schemaVersion === 2) await migration.current!.recover(id, adoptProfessionalCopy); } }
        else {
          const all = listValue(await image2Api<ImageDocument[]>('/documents'), 'documents');
          if (generation !== epoch.current || state.current.projectId !== projectId) return;
          const matching = all.filter(doc => !doc.parentDocumentId && doc.metadata?.legacyProjectId === projectId && doc.metadata?.legacyImportComplete === true);
          if (matching.length > 1) { setSavedProjectDocuments(matching); throw new Error('此项目有多个已保存文档，请在版本窗口核对后选择，不会自动新建或覆盖'); }
          const found = matching[0];
          if (found) await bind(found); else setNeedsImport(editor.getCurrentPageShapes().length > 0);
        }
      } catch (err) {
        if (generation !== epoch.current) return;
        const id = localStorage.getItem(mapKey(projectId)); if (id) { const cache = await cachedDocument(id); if (generation !== epoch.current || state.current.projectId !== projectId) return; if (cache) { const pending = await queue.current!.pending(id); if (generation !== epoch.current || state.current.projectId !== projectId) return; canonical.current = cache; setDocument(cache); setPendingCount(pending.length); } }
        report(err);
        throw err;
      }
    }).catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    const scheduleSync = () => { clearTimeout(timer);timer=setTimeout(()=>{
      // Native composition and strokes must finish before replacing their interaction record.
      if(canonical.current?.schemaVersion===3&&(editor.getEditingShapeId() || editor.inputs.isPointing))return;
      void sync().catch(report);
    },300); };
    const unlisten = editor.store.listen(() => {
      if (projecting.current) return;
      const shapes = editor.getCurrentPageShapes();
      if (canonical.current && shapes.length === fingerprints.current.size && shapes.every(shape => fingerprints.current.get(shape.id) === shapeFingerprint(shape))) return;
      dirty.current = true; editGeneration.current++;
      if (!canonical.current) { setNeedsImport(editor.getCurrentPageShapes().length > 0); return; }
      const draft = createLegacyCanvasDraft({ projectId, documentId: canonical.current.id, baseRevision: canonical.current.revision, snapshot: { ...getSnapshot(editor.store).document } });
      canvasDraft.current = draft; void legacyDraftStorage.put(draft).catch(report);
      if (canonical.current.schemaVersion === 3) {
        try { const commands=proxyTransformCommands(canonical.current, editor); if(commands.length)setProfessionalDocument(applyProfessionalCommands(asProfessional(canonical.current),commands)); }
        catch (err) { report(err); }
      }
      scheduleSync();
    }, { source: 'user', scope: 'document' });
    let wasEditing=!!editor.getEditingShapeId();
    const selection = editor.store.listen(() => {const editing=!!editor.getEditingShapeId();if(wasEditing&&!editing&&dirty.current)scheduleSync();wasEditing=editing;setSelectedId(editor.getOnlySelectedShape()?.meta.image2LayerId as string | undefined);}, { scope: 'session' });
    const pointerFinished=()=>{if(canonical.current?.schemaVersion===3&&dirty.current)scheduleSync();};
    window.addEventListener('pointerup',pointerFinished);window.addEventListener('pointercancel',pointerFinished);
    const online = () => { if (canonical.current) void sync().then(refresh).catch(report); };
    window.addEventListener('online', online);
    let polling = false;
    const poll = setInterval(() => { if (!canonical.current || polling) return; polling = true; void refresh().catch(report).finally(() => { polling = false; }); }, 2000);
    const invalidate = () => { epoch.current++; initialization.current.clear(); clearFonts(); };
    return () => { invalidate(); clearTimeout(timer); clearInterval(poll); unlisten(); selection(); window.removeEventListener('online', online);window.removeEventListener('pointerup',pointerFinished);window.removeEventListener('pointercancel',pointerFinished); };
    // The adapter is scoped to the original project; long-lived callbacks read current refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, projectId]);

  async function ensureDocument() {
    const captured = scope();
    const editor = state.current.editor; if (!editor) throw new Error('画布还未加载');
    return initialization.current.ensure({ editor, projectId: captured.projectId }, () => canonical.current, async () => {
      assertScope(captured);
      const key = legacyCreationKey(captured.projectId);
      return recoverOrCreateLegacyDocument({ projectId: captured.projectId,
        pending: () => localStorage.getItem(key), mark: id => localStorage.setItem(key, id), clear: () => localStorage.removeItem(key),
        lookup: async () => { const all = listValue(await image2Api<ImageDocument[]>('/documents'), 'documents'); assertScope(captured); return all; },
        create: async creationId => {
          if (editor.getCurrentPageShapes().length) { localStorage.removeItem(key); setNeedsImport(true); throw new Image2ApiError('请先在图层窗口确认导入原工程，再使用升级功能', 409, 'legacy_import_required'); }
          const next = unwrapDocument(await image2Api<ImageDocument>('/documents', { name: state.current.projectName, width: 1024, height: 1024, metadata: { legacyProjectId: captured.projectId, legacyImportComplete: true, legacyCreationId: creationId } }));
          assertScope(captured); return next;
        },
        bind: async next => { assertScope(captured); await bind(next); assertScope({ ...captured, documentId: next.id }); },
      });
    });
  }

  async function findSavedProjectDocuments() {
    const captured = scope();
    const all = listValue(await image2Api<ImageDocument[]>('/documents'), 'documents'); assertScope(captured);
    setSavedProjectDocuments(all.filter(doc => !doc.parentDocumentId && doc.metadata?.legacyProjectId === captured.projectId && doc.metadata?.legacyImportComplete === true));
  }
  async function openSavedProjectDocument(id: string) {
    const captured = scope(), version = editGeneration.current, ed = state.current.editor;
    if (!ed || !savedProjectDocuments.some(doc => doc.id === id)) throw new Error('请先查找并核对要打开的文档');
    const unchanged = () => { assertScope(captured); assertLegacyRecoveryCanvas(Boolean(canonical.current), ed.getCurrentPageShapes().length); if (editGeneration.current !== version || dirty.current || canvasDraft.current || draftConflict.current || localStorage.getItem(legacyCreationKey(captured.projectId))) throw new Error('当前工程有草稿或待确认请求，已完整保留；请先处理后再切换文档'); };
    await initialization.current.ready({ editor: ed, projectId: captured.projectId }).catch(() => {});
    unchanged();
    for (const documentId of new Set([canonical.current?.id, id].filter((value): value is string => Boolean(value)))) {
      const [draft, commands, pendingSubmissions, pendingMutations] = await Promise.all([readLegacyDocumentDraft(legacyDraftStorage, captured.projectId, documentId), queue.current!.pending(documentId), submissions.current!.pending(documentId), mutations.current!.pending(documentId)]);
      unchanged(); if (draft || commands.length || pendingSubmissions.length || pendingMutations.length) throw new Error('文档有保留草稿或待确认请求，未切换或清除任何记录');
    }
    const next = unwrapDocument(await image2Api<ImageDocument>(`/documents/${id}`)); unchanged();
    if (next.parentDocumentId || next.metadata?.legacyProjectId !== captured.projectId || next.metadata?.legacyImportComplete !== true) throw new Error('文档不属于当前项目');
    // This is an explicit local binding choice. Server documents and all history/assets stay intact.
    projecting.current = true;
    try { ed.store.mergeRemoteChanges(() => ed.run(() => ed.deleteShapes([...ed.getCurrentPageShapeIds()]), { history: 'ignore', ignoreShapeLock: true })); }
    finally { projecting.current = false; }
    // A previously ambiguous lookup is resolved only by this explicit selection.
    await initialization.current.begin({ editor: ed, projectId: captured.projectId }, async () => { canonical.current = null; await bind(next); });
  }
  async function rawUpload(file: Blob, name: string, role = 'source', metadata: Record<string, unknown> = {}, inputs?:Array<{role:string;assetId:string;hash?:string}>) {
    const live = canonical.current!, captured = scope(); const asset = await uploadAsset(live.id, file, name, { role, ...metadata },inputs); assertScope(captured);
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
    const parentId = canvasParentLayerId(shape, ed.getCurrentPageId(), staged, canonical.current!.layers, layerShapeId);
    const geometry = ed.getShapeGeometry(shape).bounds, pageBounds = ed.getShapePageBounds(shape.id)!;
    const base = { ...(previous || emptyLayer('raster', shape.type)), x: shape.x, y: shape.y, width: Number(props.w || geometry.width), height: Number(props.h || geometry.height), rotation: shape.rotation * 180 / Math.PI,
      opacity: shape.opacity, locked: shape.isLocked, visible: shape.meta.image2Hidden !== true, parentId,
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
    let nativeSvgSourceAssetId: string | undefined;
    try {
      if (!svg) throw new Error('SVG 导出不可用');
      const xml = new DOMParser().parseFromString(svg.svg, 'image/svg+xml'), root = xml.documentElement;
      const inverse = Mat.From(Mat.Inverse(ed.getShapePageTransform(shape)));
      // tldraw exports page-space matrices and cumulative opacity. Remove both before reusing the real local layer tree.
      for (const node of Array.from(root.children)) if (node.localName === 'g' && node.hasAttribute('transform')) node.removeAttribute('opacity');
      const contents = Array.from(root.childNodes).map(node => new XMLSerializer().serializeToString(node)).join('');
      const localSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${geometry.width}" height="${geometry.height}" viewBox="${geometry.x} ${geometry.y} ${geometry.width} ${geometry.height}"><g transform="${inverse.toCssString()}">${contents}</g></svg>`;
      proxy = await rawUpload(new Blob([localSvg], { type: 'image/svg+xml' }), `${shape.type}.svg`, 'native_projection');
      nativeSvgSourceAssetId = proxy.id;
      if (proxy.metadata?.requiresFont) throw new Image2ApiError('原生对象中的复杂文字保留当前像素外观', 422, 'SVG_FONT_REQUIRED');
    }
    catch (err) {
      // Generated native-shape SVG may require an appearance-preserving bitmap
      // projection. Authentication, conflicts and network/service errors still stop.
      if (!(err instanceof Image2ApiError) || (err.status !== 400 && !(err.status === 422 && err.code?.startsWith('SVG_')))) throw err;
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
      metadata: { ...base.metadata, ...(!vector && nativeSvgSourceAssetId ? { nativeSvgSourceAssetId } : {}), ...(shape.type === 'text' ? { nativeProjection: true, nativeTextFormat: 'preserved', fontStatus: 'mixed_styles_preserved', recognizedText: plainRichText(props.richText) } : {}), legacyProxyAssetId: proxy.id, legacyProxyOrigin: { x: localX, y: localY }, legacyProxySize: { width: geometry.width, height: geometry.height } } };
  }
  function proxyTransformCommands(live: ImageDocument, ed: Editor): DocumentCommand[] {
    const raw = asProfessional(live), commands: DocumentCommand[] = [];
    const changed = new Set(live.layers.filter(layer => { const shape = ed.getShape(layerShapeId(layer)); return shape?.type === 'design-proxy' && fingerprints.current.get(shape.id) !== shapeFingerprint(shape); }).map(layer => layer.id));
    for (const layer of live.layers) {
      if (!changed.has(layer.id)) continue;
      let parent = live.layers.find(item => item.id === layer.parentId), inherited = false;
      while (parent) { if (changed.has(parent.id)) { inherited = true; break; } parent = live.layers.find(item => item.id === parent!.parentId); }
      if (inherited) continue;
      const shape = ed.getShape(layerShapeId(layer))!;
      const deltaWorld = deriveWorldDelta({ ...worldBounds(raw, layer.id), rotation: 0 }, {x:shape.x,y:shape.y,rotation:shape.rotation,props:shape.props as {w:number;h:number}});
      commands.push({type:'layer.transformWorld',layerIds:[layer.id],deltaWorld});
    }
    return commands;
  }
  async function contentForLegacyLayer(layer: ImageLayer, canvasSource?: { shapeId: string; shapeType: string; documentId: unknown; layerId: unknown }) {
    if (layer.type === 'group') return { commands: [] as DocumentCommand[], contentId: undefined, bounds: {x:0,y:0,width:layer.width,height:layer.height} };
    const captured = scope(), live = canonical.current!;
    if (layer.contentId && live.contentAssets?.some(content => content.id === layer.contentId && !['raster','tiles'].includes(content.kind)) && !contentPayloads.current[layer.contentId]) { await loadContents(live); assertScope(captured); }
    const active = layer.contentId ? contentPayloads.current[layer.contentId] : undefined;
    let svg: ReturnType<typeof professionalSvgContent> | undefined;
    try { svg = layer.type === 'vector' ? professionalSvgContent(layer, active, canonical.current!.assetIds) : undefined; }
    catch (err) {
      if (process.env.NODE_ENV !== 'production') {
        const descriptor = live.contentAssets?.find(content => content.id === layer.contentId);
        console.error('[image2:svg-reference]', JSON.stringify({ documentId: live.id, revision: live.revision, canvasSource, layerId: layer.id, contentId: layer.contentId,
          layerAssetId: layer.assetId, layerAssetRegistered: Boolean(layer.assetId && live.assetIds.includes(layer.assetId)), descriptor,
          descriptorUsedBy: live.layers.filter(item => item.contentId === layer.contentId).map(item => item.id), activeKind: active?.kind, activeSourceAssetId: active?.sourceAssetId,
          activeSourceRegistered: typeof active?.sourceAssetId === 'string' && live.assetIds.includes(active.sourceAssetId) }));
      }
      throw err;
    }
    const sourceId = svg?.sourceAssetId || layer.assetId || (active?.kind === 'preservedText' && typeof active.assetId === 'string' ? active.assetId : undefined);
    let source = currentAssets.current.find(asset => asset.id === sourceId);
    if (sourceId && !source) {
      const owned = listValue(await image2Api<ImageAsset[]>(`/documents/${live.id}/assets`), 'assets'); assertScope(captured);
      updateAssets(owned); source = owned.find(asset => asset.id === sourceId);
    }
    if (sourceId && (!source || !canonical.current!.assetIds.includes(sourceId))) throw new Error('图层原始素材尚未就绪，请刷新后重试；原内容保留。');
    if (svg && source?.mime !== 'image/svg+xml') throw new Error('SVG 来源必须是原始 SVG 文件，不能使用内容 JSON 或旧位图替代。');
    const descriptorId = crypto.randomUUID(); let asset = source;
    let kind: 'raster' | 'svg' | 'text' | 'preservedText' = layer.type === 'vector' ? 'svg' : layer.type === 'text' ? layer.metadata?.fontConfirmed === true || layer.fontAssetId && !layer.assetId ? 'text' : 'preservedText' : 'raster';
    let payload: Record<string, unknown> | undefined;
    if (kind === 'svg') payload = svg;
    if (kind === 'text') {
      if (!layer.fontAssetId) throw new Error('真实文字需要实际字体文件');
      payload = {formatVersion:1,kind,mode:'legacy-lines',text:layer.text || '',fontAssetId:layer.fontAssetId,fontSize:layer.fontSize || 24,fill:layer.fill || '#20232b',tracking:layer.tracking || 0,lineHeight:layer.lineHeight || 1.2,stroke:layer.stroke || 'none',strokeWidth:layer.strokeWidth || 0};
    }
    if (kind === 'preservedText') payload = {formatVersion:1,kind,assetId:source?.id,text:layer.text || '',desiredText:layer.metadata?.desiredText,fontStatus:'unknown',status:source?'preserved':'unavailable',originalStyle:{fontSize:layer.fontSize,fill:layer.fill}};
    if (payload) {
      const references=[...(source?[{role:'source',assetId:source.id,hash:source.hash}]:[]),...(layer.fontAssetId?[{role:'font',assetId:layer.fontAssetId}]:[]),...(Array.isArray(payload.fontAssetIds)?payload.fontAssetIds.filter((id):id is string=>typeof id==='string').map(assetId=>({role:'font',assetId})):[])];
      asset = await rawUpload(new Blob([JSON.stringify(payload)],{type:'application/vnd.weiai.image2-content+json'}), `${layer.name}.image2-content.json`,'content',{},references);
    }
    if (!asset) throw new Error('图层源素材缺失；不会自动补跑');
    if (payload) contentPayloads.current[descriptorId] = payload;
    const content = {id:descriptorId,kind,assetId:asset.id,formatVersion:1 as const};
    const bounds = {x:0,y:0,width:kind === 'text' ? layer.width : source?.width || layer.width,height:kind === 'text' ? layer.height : source?.height || layer.height};
    return {commands:[{type:'content.add',content} as DocumentCommand],contentId:content.id,bounds};
  }
  async function convertLegacyLayer(layer: ImageLayer, canvasSource?: { shapeId: string; shapeType: string; documentId: unknown; layerId: unknown }) {
    if(layer.matrix&&(layer.masks?.some(mask=>mask.enabled)||layer.effects?.some(effect=>effect.enabled)||layer.clipToLayerId))throw new Error('此对象含有独立蒙版、效果或剪贴，请通过图层复制和矩阵排版保留外观；原图层未改');
    const content = await contentForLegacyLayer(layer, canvasSource), theta = layer.rotation * Math.PI / 180;
    const sx = layer.width / Math.max(1,content.bounds.width), sy = layer.height / Math.max(1,content.bounds.height);
    const metadata = {...layer.metadata}; delete metadata.pathStyles; delete metadata.svgFontAssetIds;
    const raw = {id:layer.id,type:layer.type,name:layer.name,parentId:layer.parentId || undefined,z:layer.z,visible:layer.visible,locked:layer.locked,opacity:layer.opacity,localBounds:content.bounds,
      matrix:[Math.cos(theta)*sx,Math.sin(theta)*sx,-Math.sin(theta)*sy,Math.cos(theta)*sy,layer.x,layer.y],blendMode:'normal',compositeMode:'isolated',masks:[],effects:[],...(content.contentId?{contentId:content.contentId}:{}),metadata};
    return { commands:[...content.commands,{type:'layer.add',layer:raw as unknown as ImageLayer} as DocumentCommand],layer:raw as unknown as ImageLayer };
  }
  async function syncProfessionalCanvas(live: ImageDocument, ed: Editor) {
    const commands = proxyTransformCommands(live,ed), present = new Set(ed.getCurrentPageShapeIds());
    const missing = new Set(live.layers.filter(layer => !present.has(layerShapeId(layer))).map(layer=>layer.id));
    for (const layer of live.layers) if (missing.has(layer.id) && (!layer.parentId || !missing.has(layer.parentId))) commands.push({type:'layer.remove',layerId:layer.id});
    const all = ed.getCurrentPageShapes().sort((a,b)=>String(a.index).localeCompare(String(b.index))), staged = new Map<string,ImageLayer>();
    const newProxies=all.filter(shape=>shape.type==='design-proxy'&&!live.layers.some(layer=>layerShapeId(layer)===shape.id)),duplicateSources=new Set(newProxies.map(shape=>String(shape.meta.image2LayerId || '')));
    for (const shape of canvasShapesParentFirst(all, ed.getCurrentPageId())) {
      if (shape.type === 'design-proxy') {
        if(!newProxies.includes(shape))continue;
        const source=live.layers.find(layer=>layer.id===shape.meta.image2LayerId);
        if(!source)throw new Error('粘贴的图层属于另一工程，请使用原生工程导入或原素材');
        let parent=live.layers.find(layer=>layer.id===source.parentId),ancestorCopied=false;
        while(parent){if(duplicateSources.has(parent.id)){ancestorCopied=true;break;}parent=live.layers.find(layer=>layer.id===parent!.parentId);}
        if(ancestorCopied)continue;
        const before={...worldBounds(asProfessional(live),source.id),rotation:0},after={x:shape.x,y:shape.y,rotation:shape.rotation,props:shape.props as {w:number;h:number}};
        commands.push(...duplicateProfessionalLayerCommands(live,[source.id],deriveWorldDelta(before,after)).commands);continue;
      }
      const previous = viewDocument(live).layers.find(layer=>layerShapeId(layer)===shape.id);
      const legacy = await layerForShape(shape,previous,staged); staged.set(shape.id,legacy);
      if (previous) commands.push({type:'layer.remove',layerId:previous.id});
      const converted = await convertLegacyLayer({...legacy,z:all.findIndex(item=>item.id===shape.id)}, { shapeId: shape.id, shapeType: shape.type, documentId: shape.meta.image2DocumentId, layerId: shape.meta.image2LayerId }); commands.push(...converted.commands);
    }
    return commands;
  }
  async function sync(): Promise<ImageDocument> {
    if (syncPromise.current) return syncPromise.current;
    const invocation = scope();
    const task = (async () => {
      await ensureDocument(); assertScope(invocation); if (draftConflict.current) throw new Error('服务器版本与本地草稿冲突；请在版本窗口处理，未覆盖服务器');
      const captured = scope(), version = editGeneration.current, capturedDraft = canvasDraft.current, ed = state.current.editor!;
      if(canonical.current?.schemaVersion===3&&(ed.getEditingShapeId() || ed.inputs.isPointing))throw new Image2ApiError('请先结束文字输入或当前拖动，画布草稿已保留',409,'canvas_edit_in_progress');
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
      if (live.schemaVersion === 3) commands.push(...await syncProfessionalCanvas(live,ed));
      else {
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
      }
      if (state.current.projectName !== canonical.current!.name) commands.push({ type: 'document.update', patch: { name: state.current.projectName } });
      if (commands.length) { await queue.current!.enqueue(live.id, commands); assertScope(captured); }
      await queue.current!.flush(canonical.current!, next => { assertScope(captured); accept(next, false); });
      assertScope(captured);
      const remainingCommands = await queue.current!.pending(live.id); assertScope(captured); setPendingCount(remainingCommands.length);
      const saved = canonical.current!;
      dirty.current = editGeneration.current !== version;
      if (!dirty.current) {
        if(saved.schemaVersion===3){
          const nativeIds=saved.layers.flatMap(layer=>typeof layer.metadata?.legacyShapeId==='string'?[layer.metadata.legacyShapeId]:[]).filter(id=>{const shape=ed.getShape(id as TLShape['id']);return shape&&shape.type!=='design-proxy';}) as TLShape['id'][];
          if(nativeIds.length){projecting.current=true;try{ed.store.mergeRemoteChanges(()=>ed.run(()=>ed.deleteShapes(nativeIds),{history:'ignore',ignoreShapeLock:true}));}finally{projecting.current=false;}}
        }
        project(saved);
        setError('');
        if (capturedDraft) { await removeLegacyDocumentDraft(legacyDraftStorage, captured.projectId, capturedDraft); assertScope(captured); if (canvasDraft.current?.savedAt === capturedDraft.savedAt) canvasDraft.current = undefined; }
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
    const raw = canonical.current; if (!raw) return; const doc = viewDocument(raw);
    const selected = state.current.editor?.getOnlySelectedShape();
    if (layerId) return doc.layers.find(layer => layer.id === layerId);
    const reference = src ? parseLayerReference(src, window.location.origin) : undefined;
    if (reference) return reference.documentId === doc.id ? doc.layers.find(layer => layer.id === reference.layerId) : undefined;
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
  async function submitCommands(commands: DocumentCommand[] | (() => DocumentCommand[])) {
    if (Array.isArray(commands) && !commands.length) return;
    const captured = scope(), frozen = Array.isArray(commands) ? structuredClone(commands) : commands;
    const task = commandEdits.current.catch(() => {}).then(async () => {
      assertScope(captured); await sync(); assertScope(captured);
      const live = canonical.current!;
      if (live.schemaVersion === 3) { await loadContents(live); assertScope(captured); }
      const requested = typeof frozen === 'function' ? frozen() : frozen;
      const acceptedCommands = live.schemaVersion === 3 ? await adaptProfessionalCommands(requested) : requested;
      assertScope(captured); await queue.current!.enqueue(live.id, acceptedCommands);
      try { await queue.current!.flush(live, next => { assertScope(captured); accept(next); }); }
      finally { setPendingCount((await queue.current!.pending(live.id)).length); }
    });
    commandEdits.current = task.then(() => {}, () => {});
    return task;
  }
  async function adaptProfessionalCommands(commands: DocumentCommand[]) {
    const result: DocumentCommand[] = [];
    for (const command of commands) {
      if (command.type === 'layer.add' && (!command.layer.matrix || 'x' in command.layer || 'width' in command.layer)) { result.push(...(await convertLegacyLayer(command.layer)).commands); continue; }
      if (command.type !== 'layer.update') { result.push(command); continue; }
      const live = canonical.current!, old = getLayer(undefined,command.layerId), raw = live.layers.find(layer=>layer.id===command.layerId);
      if (!old || !raw) throw new Error('图层不存在');
      const patch = command.patch, direct: Partial<ImageLayer> = {};
      for (const key of ['name','visible','locked','opacity','z','parentId','matrix','localBounds','blendMode','compositeMode','clipToLayerId','masks','effects'] as const) if (key in patch) (direct as Record<string,unknown>)[key] = patch[key];
      if (patch.metadata) { const metadata={...patch.metadata}; delete metadata.pathStyles; delete metadata.svgFontAssetIds; direct.metadata=metadata; }
      const contentFields=['assetId','type','text','fontAssetId','fontSize','fill','stroke','strokeWidth','tracking','lineHeight'];
      const contentChange=contentFields.some(key=>key in patch) || patch.metadata && ('pathStyles' in patch.metadata || 'svgFontAssetIds' in patch.metadata || 'desiredText' in patch.metadata);
      if (contentChange && old.type !== 'group') {
        const merged={...old,...patch,metadata:{...old.metadata,...patch.metadata}};
        if (old.type==='text' && old.metadata?.fontConfirmed!==true && (patch.fontAssetId || patch.text) && merged.metadata?.fontConfirmed!==true) throw new Error('原字形裁片需先清底并确认字体，不能把识别信息当作画面修改');
        const content=await contentForLegacyLayer(merged); result.push(...content.commands);
        direct.contentId=content.contentId;
        if (patch.type) direct.type=patch.type;
        if (patch.assetId) direct.localBounds=content.bounds;
      }
      if (!patch.matrix && ['x','y','width','height','rotation'].some(key=>key in patch)) {
        const before={...worldBounds(asProfessional(live),raw.id),rotation:0};
        const after={...before,...Object.fromEntries(['x','y','width','height'].filter(key=>key in patch).map(key=>[key,(patch as Record<string,unknown>)[key]])),rotation:Number(patch.rotation || 0)*Math.PI/180};
        result.push({type:'layer.transformWorld',layerIds:[raw.id],deltaWorld:deriveWorldDelta(before,after)});
      }
      if(direct.type && direct.type!==raw.type){const replacement={...raw,...direct};delete direct.type;result.push({type:'layer.remove',layerId:raw.id},{type:'layer.add',layer:replacement});}
      else {delete direct.type;if (Object.keys(direct).length) result.push({type:'layer.update',layerId:raw.id,patch:direct});}
    }
    return result;
  }
  async function adoptProfessionalCopy(result: import('./professional-migration').MigrationResult) {
    const captured=scope(), ed=state.current.editor;
    if (!ed) throw new Error('画布未加载，复制回执已保留');
    if(canonical.current?.id!==result.sourceDocumentId&&canonical.current?.id!==result.document.id)throw new Error('已切换工程，升级副本和原回执保留');
    if (dirty.current || draftConflict.current || (await queue.current!.pending(canonical.current!.id)).length) throw new Error('复制副本已保存；本地新增编辑尚未确认，请保存后恢复升级');
    assertScope(captured);
    localStorage.setItem(mapKey(state.current.projectId),result.document.id);
    projecting.current=true;
    try { ed.store.mergeRemoteChanges(()=>ed.run(()=>ed.deleteShapes([...ed.getCurrentPageShapeIds()]),{history:'ignore',ignoreShapeLock:true})); }
    finally { projecting.current=false; }
    canonical.current=null; await bind(result.document);
  }
  async function migrateProfessional() {
    const captured=scope();
    setBusy(true);
    try { await sync();assertScope(captured); const live=canonical.current!; if(live.schemaVersion===3)return live; const result=await migration.current!.migrate(live,async result=>{assertScope(captured);await adoptProfessionalCopy(result);}); return result.document; }
    finally { setBusy(false); }
  }
  async function openOriginalDocument() {
    await sync();const live=canonical.current!,source=live.metadata?.professionalSource as {documentId?:string}|undefined;
    if(!source?.documentId)throw new Error('原工程在此设备不可用，请导入原工程包；不会重新生成');
    const captured=scope(),original=unwrapDocument(await image2Api<ImageDocument>(`/documents/${source.documentId}`));assertScope(captured);
    projecting.current=true;try{state.current.editor!.store.mergeRemoteChanges(()=>state.current.editor!.run(()=>state.current.editor!.deleteShapes([...state.current.editor!.getCurrentPageShapeIds()]),{history:'ignore',ignoreShapeLock:true}));}finally{projecting.current=false;}
    canonical.current=null;await bind(original);
  }
  async function newProfessionalDocument() {
    const captured=scope();await ensureDocument();assertScope(captured);await sync();assertScope(captured);const live=canonical.current!;
    if(live.layers.length)throw new Error('当前画布已有内容，请使用复制升级以保留工程');
    const next=unwrapDocument(await image2Api<ImageDocument>('/documents',{schemaVersion:3,name:state.current.projectName,width:live.width,height:live.height,resolution:{dpiX:300,dpiY:300,unit:'px'},metadata:{legacyProjectId:state.current.projectId,legacyImportComplete:true,professionalSource:{documentId:live.id,revision:live.revision}}}));
    assertScope(captured);
    canonical.current=null;await bind(next);return next;
  }
  async function duplicateLayers(layerIds?:string[]) {
    const captured=scope();await sync();assertScope(captured); const live=canonical.current!;
    const ids=layerIds || state.current.editor!.getSelectedShapeIds().map(id=>live.layers.find(layer=>layerShapeId(layer)===id)?.id).filter((id):id is string=>!!id);
    if(live.schemaVersion!==3){state.current.editor?.duplicateShapes(state.current.editor.getSelectedShapeIds(),{x:32,y:32});return;}
    const copy=duplicateProfessionalLayerCommands(live,ids,[1,0,0,1,32,32]);
    await submitCommands(copy.commands);if(copy.newLayerIds[0])selectLayer(copy.newLayerIds[0]);
  }
  async function groupSelection(ungroup=false) {
    const captured=scope();await sync();assertScope(captured);const live=canonical.current!;
    const selected=state.current.editor!.getSelectedShapeIds().map(id=>live.layers.find(layer=>layerShapeId(layer)===id)?.id).filter((id):id is string=>!!id);
    if(live.schemaVersion!==3)throw new Error('请在图层弹窗管理原工程的编组');
    if(ungroup){if(selected.length!==1)throw new Error('请选择一个组');await submitCommands(ungroupProfessionalLayerCommands(live,selected[0]));}
    else{const id=crypto.randomUUID();await submitCommands(groupProfessionalLayerCommands(live,selected,id));selectLayer(id);}
  }
  async function saveEditSelection(layerId:string,name='编辑范围') {
    const captured=scope();await sync();assertScope(captured);const live=canonical.current!,layer=live.layers.find(item=>item.id===layerId);
    if(live.schemaVersion!==3 || !layer?.localBounds)throw new Error('保存选区需要矩阵工程');
    const assetId=layer.metadata?.editMaskAssetId,asset=currentAssets.current.find(item=>item.id===assetId);
    if(!asset?.width || !asset.height)throw new Error('请先保存修改范围');
    const content={id:crypto.randomUUID(),kind:'raster' as const,assetId:asset.id,formatVersion:1 as const},b=layer.localBounds;
    const matrix=multiplyMatrix(worldMatrix(live,layerId),[b.width/asset.width,0,0,b.height/asset.height,b.x,b.y]);
    await submitCommands([{type:'content.add',content},{type:'selection.upsert',selection:{id:crypto.randomUUID(),name,contentId:content.id,matrix,channel:'luminance',inverted:false,density:1,featherPx:0}}]);
  }
  async function uploadFile(file: Blob, name: string, role = 'source') { const captured = scope(); await sync(); assertScope(captured); return rawUpload(file, name, role); }
  async function resolveReference(src: string, documentId: string) {
    const captured = scope();
    if (canonical.current?.id !== documentId) throw new Error('已切换工程，旧工程任务与草稿保留');
    const reference = parseLayerReference(src, window.location.origin);
    if (reference && reference.documentId !== documentId) throw new Error('选中图层来自其他工程，请重新选择；历史素材链接仍可作为原图引用');
    const immutable = immutableSourceId(src), existing = immutable ? currentAssets.current.find(a => a.id === immutable) : undefined;
    if (existing) return existing;
    const bytes = await sourceBlob(src); assertScope(captured);
    return rawUpload(bytes, reference ? `图层参考-r${reference.revision}.png` : '参考图片', 'reference', reference ? { referenceKind: 'rendered_layer_appearance', sourceDocumentId: reference.documentId, sourceLayerId: reference.layerId, sourceRevision: reference.revision } : undefined);
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
    const status = capability(imageCapabilitiesForDocument(capabilities, canonical.current!.schemaVersion), operation);
    if (!status.available) throw new Error(status.reason || '功能尚未配置');
    const pending = await submissions.current!.pending(canonical.current!.id);
    for (const attempt of pending) {
      const result = await submissions.current!.resume<{ job: ImageJob }>(attempt); assertScope(captured);
      setJobs(prev => [result.job, ...prev.filter(job => job.id !== result.job.id)]);
    }
    // Recover the frozen submission first. A new mask/reference/model is a new
    // intent even when its operation and text match; never label old output as it.
    if (pending.length) { await refresh(); throw new Error('已恢复上一次提交，本次参数尚未执行；请在版本窗口查看原任务后重新操作'); }
    if (canonical.current!.schemaVersion===3 && ['generate','inpaint','restore_layers','remove_background','matting','refine_mask','segment','super_resolution'].includes(operation)) throw new Error('v3 专用模型与生成链路尚未验收；保留原工程可继续原有任务，不会回退重绘');
    if (options.editMask && target) { await setMasks(assetUrl(target.assetId!), options.editMask, options.protectMask, target.id); assertScope(captured); target = getLayer(undefined,target.id); }
    const live = canonical.current!, regional = ['recolor', 'erase', 'fill', 'repair', 'adjust', 'filter', 'inpaint', 'refine_mask'].includes(operation);
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
    if (canonical.current!.schemaVersion===3) {
      const source=currentAssets.current.find(asset=>asset.id===target!.assetId), raw=canonical.current!.layers.find(layer=>layer.id===target!.id)!;
      if(!source?.width || !source.height || !Object.values(rect).every(Number.isInteger) || rect.x<0 || rect.y<0 || rect.width<=0 || rect.height<=0 || rect.x+rect.width>source.width || rect.y+rect.height>source.height)throw new Error('改字范围必须在原图像素边界内');
      const alreadyPatch=target.metadata?.sourceImageLayerId || target.metadata?.sourcePatchAssetId;
      let patchId=raw.id;
      if(!alreadyPatch) {
        patchId=crypto.randomUUID(); const copy={...raw,id:patchId,name:oldText || '待确认文字',z:Math.max(0,...canonical.current!.layers.map(layer=>layer.z))+1,metadata:{sourceImageLayerId:raw.id,fontStatus:'unknown',desiredText:newText}};
        await submitCommands([{type:'layer.add',layer:copy}]);
        await waitJob(await submitOperation('crop',rect,undefined,{layerId:patchId}));
      }
      let patch=canonical.current!.layers.find(layer=>layer.id===patchId)!;
      if(canonical.current!.contentAssets?.find(content=>content.id===patch.contentId)?.kind==='raster'){
        const visible=getLayer(undefined,patchId)!;
        const payload={formatVersion:1,kind:'preservedText' as const,assetId:visible.assetId,text:oldText,desiredText:newText,fontStatus:'unknown',status:'preserved',originalStyle:{fontSize:size,fill:color}};
        const asset=await rawUpload(new Blob([JSON.stringify(payload)],{type:'application/vnd.weiai.image2-content+json'}),'待确认文字.image2-content.json','content',{},[{role:'source',assetId:visible.assetId!}]);
        const content={id:crypto.randomUUID(),kind:'preservedText' as const,assetId:asset.id,formatVersion:1 as const};contentPayloads.current[content.id]=payload;
        const preserved={...patch,type:'text' as const,contentId:content.id,metadata:{...patch.metadata,sourcePatchAssetId:visible.assetId,fontConfirmed:false,fontStatus:'unknown',desiredText:newText}};
        await submitCommands([{type:'content.add',content},{type:'layer.remove',layerId:patchId},{type:'layer.add',layer:preserved}]);
        patch=canonical.current!.layers.find(layer=>layer.id===patchId)!;
      }
      if(typeof patch.metadata?.cleanBackgroundAssetId!=='string')await waitJob(await submitOperation('prepare_text',{purpose:'text_background'},undefined,{layerId:patchId}));
      patch=canonical.current!.layers.find(layer=>layer.id===patchId)!;
      const backgroundId=patch.metadata?.cleanBackgroundAssetId;
      if(typeof backgroundId!=='string')throw new Error('背景复杂，需先传统修补或局部补画；原图像素保留');
      face ||= await defaultFont();
      const groupId=crypto.randomUUID(), textId=crypto.randomUUID(), backgroundLayerId=crypto.randomUUID(), bounds=patch.localBounds!;
      const backgroundContent={id:crypto.randomUUID(),kind:'raster' as const,assetId:backgroundId,formatVersion:1 as const};
      const legacyText={...emptyLayer('text',newText || '文字'),width:bounds.width,height:bounds.height,text:newText,fontAssetId:face.id,fontSize:size,fill:color,metadata:{fontConfirmed:true,fontStatus:'confirmed',backgroundDetached:true}};
      const text=await convertLegacyLayer(legacyText);
      const textRaw={...text.layer,id:textId,parentId:groupId,z:1,matrix:[1,0,0,1,bounds.x,bounds.y] as ImageLayer['matrix']};
      const commands:DocumentCommand[]=[...text.commands.filter(command=>command.type==='content.add'),{type:'content.add',content:backgroundContent},{type:'layer.remove',layerId:patchId},
        {type:'layer.add',layer:{id:groupId,type:'group',name:'可编辑文字与清底',parentId:patch.parentId,z:patch.z,visible:true,locked:false,opacity:patch.opacity,matrix:patch.matrix,localBounds:bounds,blendMode:'normal',compositeMode:'isolated',masks:patch.masks || [],effects:patch.effects || [],metadata:{sourceImageLayerId:raw.id}} as unknown as ImageLayer},
        {type:'layer.add',layer:{id:backgroundLayerId,type:'raster',name:'原字清底背景',parentId:groupId,z:0,visible:true,locked:false,opacity:1,matrix:[1,0,0,1,0,0],localBounds:bounds,contentId:backgroundContent.id} as ImageLayer},
        {type:'layer.add',layer:textRaw}];
      await submitCommands(commands); selectLayer(textId); await refresh(); return;
    }
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
    requireImageAgent(capabilities, live.schemaVersion, model);
    if (!conversation.current) { const thread = await image2Api<Conversation>('/conversations', { documentId: live.id }); assertScope(captured); conversation.current = thread; }
    const references: Array<{ assetId?: string; layerId?: string; revision: number }> = [];
    for (const src of referenceSrcs) {
      const appearance = parseLayerReference(src, window.location.origin);
      if (appearance) {
        if (appearance.documentId !== live.id) throw new Error('选中图层来自其他工程，请重新选择');
        references.push({ layerId: appearance.layerId, revision: appearance.revision });
        continue;
      }
      const immutable = immutableSourceId(src);
      const existing = immutable ? currentAssets.current.find(a => a.id === immutable) : undefined;
      let asset = existing;
      if (!asset) { const bytes = await sourceBlob(src); assertScope(captured); asset = await rawUpload(bytes, '对话参考.png', 'reference'); assertScope(captured); }
      references.push({ assetId: asset.id, revision: live.revision });
    }
    const selected = getLayer(); if (selected && !referenceSrcs.length) references.push({ layerId: selected.id, revision: live.revision });
    const intent = { documentId: live.id, conversationId: conversation.current.id, text, references, model };
    const result = await submissions.current!.submit<{ job: ImageJob }>(`/conversations/${conversation.current.id}/messages`, intent, { text, references, model }); assertScope(captured); await refresh(); return result.job;
  }
  async function acceptCandidate(branchId: string) {
    const captured = scope(); await sync(); assertScope(captured); const live = canonical.current!;
    // Unknown accepted submissions must recover their frozen body before checking a new preview.
    const pending = await mutations.current!.pending(live.id); assertScope(captured);
    if (pending.length) {
      const sameAccept = pending.some(attempt => attempt.path.endsWith('/accept') && attempt.body.branchDocumentId === branchId);
      await mutations.current!.recover(live.id, next => { assertScope(captured); accept(next); });
      assertScope(captured); await refresh();
      if (sameAccept) return;
      throw new Error('已恢复上一次工程修改，本次候选尚未接受；请核对当前版本后重新操作。');
    }
    const [branchValue, jobsValue] = await Promise.all([
      image2Api<ImageDocument>(`/documents/${branchId}`), image2Api<ImageJob[]>(`/documents/${live.id}/jobs`),
    ]); assertScope(captured);
    const latestBranch = unwrapDocument(branchValue), latestJobs = listValue(jobsValue, 'jobs');
    if (latestBranch.parentDocumentId !== live.id) throw new Error('候选不属于当前工程，原图层与任务保留。');
    setJobs(latestJobs); setBranches(current => current.map(branch => branch.id === latestBranch.id ? latestBranch : branch));
    const job = latestJobs.find(item => item.output?.branchDocumentId === branchId || item.output?.candidateDocumentId === branchId);
    const preview = candidatePreviewState(job, latestBranch);
    if (!preview.canAccept) throw new Image2ApiError(preview.message || '候选仍在执行或等待当前版本预览，请完成核对后再接受。', 409, 'candidate_preview_not_ready');
    try {
      const next = await mutations.current!.submit(`/documents/${live.id}/accept`, { documentId: live.id, branchId }, { baseRevision: live.revision, branchDocumentId: branchId, branchRevision: latestBranch.revision }); assertScope(captured); accept(next); await refresh();
    } catch (error) {
      if (error instanceof Image2ApiError && ['candidate_revision_required','candidate_revision_conflict','candidate_preview_required','candidate_preview_stale'].includes(error.code || '')) { assertScope(captured); await refresh().catch(report); }
      throw error;
    }
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
    if (draft) await removeLegacyDocumentDraft(legacyDraftStorage, captured.projectId, draft); assertUnchanged();
    await queue.current!.discard(live.id); assertUnchanged(); canvasDraft.current = undefined; dirty.current = false; draftConflict.current = false; setHasDraftConflict(false);
    accept(fresh); await refresh();
  }
  async function saveDraftAsProject() {
    const draft = canvasDraft.current; if (!draft) throw new Error('没有待保存的画布草稿');
    const live = canonical.current!, captured = scope(), name = state.current.projectName;
    // Keep all current assets available. No existing main document is edited or overwritten.
    const fresh = unwrapDocument(await image2Api<ImageDocument>('/documents', { ...(live.schemaVersion===3?{schemaVersion:3,contentAssets:live.contentAssets,renderVersion:live.renderVersion,requiredFeatures:live.requiredFeatures,workingColor:live.workingColor,resolution:live.resolution,artboards:live.artboards,guides:live.guides,savedSelections:live.savedSelections}:{}),name: `${name} 草稿`, width: live.width, height: live.height, layers: live.layers, assetIds: live.assetIds,
      metadata: { ...live.metadata, legacyProjectId: captured.projectId, recoveredDraftOf: live.id } })); assertScope(captured);
    canonical.current = fresh; dirty.current = true; draftConflict.current = false; setHasDraftConflict(false); canvasDraft.current = undefined;
    const savedScope = { ...captured, documentId: fresh.id };
    await sync(); assertScope(savedScope); await removeLegacyDocumentDraft(legacyDraftStorage, captured.projectId, draft); assertScope(savedScope); localStorage.setItem(mapKey(captured.projectId), fresh.id); await refresh();
  }
  const effectiveCapabilities = imageCapabilitiesForDocument(capabilities, document?.schemaVersion);
  return { document, rawDocument, professionalDocument, assets, fontStates, jobs, branches, messages, capabilities:effectiveCapabilities, revisions, error, busy, needsImport, pendingCount, selectedLayer: document?.layers.find(l => l.id === selectedId),migrateProfessional,duplicateLayers,groupSelection,saveEditSelection,openOriginalDocument,newProfessionalDocument,
    ensureDocument, savedProjectDocuments, findSavedProjectDocuments, openSavedProjectDocument, importCanvas, sync, refresh, getLayer, submitCommands, updateLayer: (id: string, patch: Partial<ImageLayer>) => submitCommands([{ type: 'layer.update', layerId: id, patch }]),
    updateVectorPaint: (id: string, target: string, paint: Record<string, unknown>) => {
      const changed = structuredClone(paint);
      return submitCommands(() => { const current = getLayer(undefined, id); if (!current || current.type !== 'vector') throw new Error('SVG 图层已不存在，请重新选择'); return [{ type: 'layer.update', layerId: id, patch: svgPaintPatch(current, target, changed, canonical.current!.schemaVersion === 3 ? 'typed' : 'css') }]; });
    },
    submitOperation, waitJob, setMasks, uploadFile, resolveReference, defaultFont, applyFont, confirmText, startRun, acceptCandidate, export: exportDocument, importPackage, addFile, selectLayer,
    hasDraftConflict, useServerVersion, saveDraftAsProject,
    undo: () => history('undo'), redo: () => history('redo'), cancelJob: async (id: string) => { await image2Api(`/jobs/${id}/cancel`, {}); await refresh(); } };
}
