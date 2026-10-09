'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { ReactFlow, ReactFlowProvider, Background, BackgroundVariant, Controls, MiniMap, Handle, Position, useReactFlow, type Node, type NodeProps, type NodeChange, type Edge, type Connection } from '@xyflow/react';
import { ArrowLeft, ArrowUp, AudioLines, Box, Check, ChevronDown, Clapperboard, Download, FileText, Film, Folder, Image as ImageIcon, Layers, Loader2, Maximize2, MessageCircle, MoreHorizontal, Plus, Redo2, Save, Search, Sparkles, Trash2, Type, Undo2, Upload, UserRound, X } from 'lucide-react';
import type { AssetKind, AssetRevision, CanvasNode, SceneOp, Shot, StudioCapabilities, StudioJob, StudioProject } from '../../lib/studio/types';
import { blobBase64, frameTime, studioApi, studioId, StudioApiError } from '../../lib/studio/client';
import { authoringEqual, mergeProject } from '../../lib/studio/merge';
import { submitJobWithReceipt } from '../../lib/studio/job-attempt';
import { placeCanvasCard } from '../../lib/studio/canvas-placement';
import { isComparison, isEffectsSource, effectsPlanInput, effectsRenderForPlan, effectsJobReceipt, effectsCancellationKey, canResumeEffectsHandoff, jobOutputStamp, renderBackends, applyVideoVersion, videoFamily, type ExportChoice } from '../../lib/studio/pipeline';
import SequenceTimeline, { SequencePreview } from './SequenceTimeline';
import VideoVersions from './VideoVersions';
import { EffectsDialog, PipelineJobDetail, SceneGenerationDialog, SceneRenderControls } from './StudioPipeline';
import type { DirectorAIContext } from './director/DirectorPanel';
import type { FilmId, SceneProgram } from '../../lib/studio/code-scene/schema';
import '@xyflow/react/dist/style.css';
import './studio.css';

const DirectorPanel = dynamic(() => import('./director/DirectorPanel'), { ssr: false, loading: () => <div className="studio-loading"><Loader2 className="spin" />正在打开 3D 导演台…</div> });
type CardData = { card: CanvasNode; asset?: AssetRevision; shot?: Shot; project: StudioProject; openDirector: (sceneId?: string) => void };
type MediaNode = Node<CardData, 'media'>;
type CaptureReference = { projectId: string; nodeId: string; assetId: string; assetHash: string; name: string; sceneId: string; sceneRevision: number; cameraId: string; frame: number; mode: 'static' | 'dynamic' };
function captureReferenceError(project: StudioProject, reference: CaptureReference): string | undefined {
  const node = project.nodes.find(item => item.id === reference.nodeId), asset = project.assets.find(item => item.id === reference.assetId), metadata = asset?.metadata;
  if (project.id !== reference.projectId || !node || node.type !== 'image' || node.assetId !== reference.assetId || node.shotId || asset?.kind !== 'image' || asset.hash !== reference.assetHash) return '引用截图或图片节点已变更，请重新选择截图后再编辑。';
  if (!metadata || metadata.provenance !== 'three-scene-capture' || metadata.sceneId !== reference.sceneId || metadata.sceneRevision !== reference.sceneRevision || metadata.cameraId !== reference.cameraId || metadata.frame !== reference.frame || metadata.mode !== reference.mode) return '引用截图的场景映射已失效，请重新截图后再编辑。';
  if (metadata.aspect !== project.aspect) return '项目画幅与引用截图不一致，请重新截图后再编辑。';
  const scene = project.scenes.find(item => item.id === reference.sceneId);
  if (!scene || scene.revision !== reference.sceneRevision) return '引用截图对应的场景已变更，请重新截图后再编辑。';
  if (!scene.cameras.some(camera => camera.id === reference.cameraId) || !Array.isArray(metadata.objectIds) || metadata.objectIds.some(id => !scene.objects.some(object => object.id === id))) return '引用截图的相机或对象映射已失效，请重新截图后再编辑。';
}
const kindLabels: Record<CanvasNode['type'], string> = { text: '文本', image: '图片', video: '视频', audio: '音频', subject: '主体', shot: '镜头', director: '导演台', sequence: '时间线' };
const kindIcons = { text: Type, image: ImageIcon, video: Film, audio: AudioLines, subject: UserRound, shot: Clapperboard, director: Box, sequence: Layers };

function MediaCard({ data, selected }: NodeProps<MediaNode>) {
  const { card, asset, shot } = data;
  const Icon = kindIcons[card.type];
  const scene = data.project.scenes.find(s => s.id === (card.sceneId || shot?.sceneId));
  return <article className={`studio-card ${selected ? 'is-selected' : ''} type-${card.type}`}>
    <Handle type="target" position={Position.Left} />
    <div className="studio-card-label"><Icon size={13} /><span>{card.label}</span>{shot?.approval && <Check size={13} className="studio-approved" />}</div>
    {asset?.kind === 'image' && <img className="studio-card-image" src={asset.url} alt={asset.name} draggable={false} />}
    {asset?.kind === 'video' && <video className="studio-card-image nodrag" src={asset.url} controls preload="metadata" />}
    {asset?.kind === 'audio' && <div className="studio-audio-card"><AudioLines size={36} /><audio className="nodrag" src={asset.url} controls preload="metadata" /></div>}
    {card.type === 'text' && <p className="studio-card-text">{card.text || '双击编辑文本或创作想法'}</p>}
    {card.type === 'director' && <button className="studio-scene-card nodrag" onClick={() => data.openDirector(card.sceneId)}><div className="studio-scene-grid"><Box size={58} strokeWidth={0.8} /></div><b>{scene?.name || '三维场景'}</b><span>{scene?.objects.length || 0} 个对象 · {scene?.cameras.length || 0} 个机位</span><span className="studio-scene-enter">进入导演台 <Maximize2 size={12} /></span></button>}
    {card.type === 'sequence' && <div className="studio-sequence-card"><Layers size={32} /><b>{frameTime(data.project.sequence.totalFrames)}</b><span>{data.project.sequence.clips.length} 个片段 · 24 fps</span></div>}
    {!asset && ['image', 'video', 'audio', 'subject'].includes(card.type) && <div className="studio-empty-media"><Icon size={34} strokeWidth={1} /><span>{card.type === 'subject' ? '选择身份图与 3D 角色' : '从资产库选择或上传'}</span></div>}
    {card.type === 'shot' && <><div className="studio-shot-badge">{shot ? `${frameTime(shot.startFrame)} — ${frameTime(shot.endFrame)}` : '新镜头'}</div>{!asset && <div className="studio-empty-media"><Clapperboard size={30} strokeWidth={1} /><span>在导演台确定构图</span></div>}<p className="studio-card-text">{shot?.prompt || '选择镜头，编写画面与动作'}</p><div className="studio-card-footer">{shot?.takes.length || 0} 个候选<span>{shot?.approval ? '脚本已确认' : '待确认脚本'}</span></div></>}
    <Handle type="source" position={Position.Right} />
  </article>;
}
const nodeTypes = { media: MediaCard };

export default function StudioWorkspace() { return <ReactFlowProvider><Workspace /></ReactFlowProvider>; }

function Workspace() {
  const [project, setProject] = useState<StudioProject | null>(null);
  const current = useRef<StudioProject | null>(null);
  const serverBase = useRef<StudioProject | null>(null);
  const serverRevision = useRef(0);
  const localVersion = useRef(0);
  const dirty = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saving = useRef<Promise<void> | null>(null);
  const projectLoad = useRef(0);
  const [saveState, setSaveState] = useState('已保存');
  const [projects, setProjects] = useState<Array<{ id: string; name: string; updatedAt: string }>>([]);
  const [capabilities, setCapabilities] = useState<StudioCapabilities | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const lockDepth = useRef(0);
  const [locked, setLocked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [nodeMeasurements, setNodeMeasurements] = useState<{ projectId: string; byId: Record<string, { width: number; height: number }> }>({ projectId: '', byId: {} });
  const [directorScene, setDirectorScene] = useState<string>();
  const [directorView, setDirectorView] = useState<{ cameraId: string; mode: 'static' | 'dynamic'; shotView: boolean }>();
  const [directorCapture, setDirectorCapture] = useState<CaptureReference>();
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [assetLibrary, setAssetLibrary] = useState(false);
  const [projectMenu, setProjectMenu] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [chat, setChat] = useState<Array<{ role: 'user' | 'assistant'; text: string }>>([]);
  const [prompt, setPrompt] = useState('');
  const [assetSearch, setAssetSearch] = useState('');
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [jobs, setJobs] = useState<StudioJob[]>([]);
  const [review, setReview] = useState<{ html: string; shots: Array<{ shotId: string; hash: string }> } | null>(null);
  const [sceneGenerationOpen, setSceneGenerationOpen] = useState(false);
  const generationDraft = useRef<{ projectId: string; film: FilmId } | null>(null);
  const openSceneGeneration = () => { generationDraft.current = null; setSceneGenerationOpen(true); };
  const [versionAssetId, setVersionAssetId] = useState<string>();
  const [effectsDialog, setEffectsDialog] = useState<{ projectId: string; assetId?: string }>();
  const effectsAttempts = useRef(new Set<string>());
  const effectsSubmitting = useRef(false);
  const [effectsPending, setEffectsPending] = useState<string>();
  const clipboard = useRef<{ projectId: string; nodes: CanvasNode[]; edges: StudioProject['edges']; shots: Shot[] } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const flow = useReactFlow<MediaNode>();
  const showError = useCallback((value: unknown) => { setError(value instanceof Error ? value.message : String(value)); }, []);
  const onCanvasSelection = useCallback(({ nodes }: { nodes: MediaNode[] }) => {
    const ids = nodes.map(node => node.id);
    setSelectedIds(previous => previous.length === ids.length && previous.every((id, i) => id === ids[i]) ? previous : ids);
  }, []);

  const acceptServer = useCallback((value: StudioProject) => {
    if (current.current?.id !== value.id) projectLoad.current += 1;
    current.current = value; serverBase.current = structuredClone(value); serverRevision.current = value.revision; dirty.current = false;
    setProject(value); setLoading(false); setSaveState('已保存'); localStorage.setItem('studio-v3-last-project', value.id);
    localStorage.removeItem(`studio-v3-draft:${value.id}`);
    const url = new URL(location.href);
    if (url.searchParams.get('project') !== value.id) {
      url.searchParams.set('project', value.id);
      history.replaceState(null, '', url);
    }
  }, []);

  const flush = useCallback(async () => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    if (saving.current) await saving.current;
    if (!dirty.current || !current.current) return;
    const work = async () => {
      while (dirty.current && current.current) {
        const snapshot = structuredClone(current.current);
        const version = localVersion.current;
        dirty.current = false; setSaveState('保存中…');
        try {
          let saved: StudioProject;
          try { saved = await studioApi<StudioProject>(`/projects/${snapshot.id}`, { baseRevision: serverRevision.current, project: snapshot }, 'PUT'); }
          catch (error) {
            if (!(error instanceof StudioApiError) || error.status !== 409 || !serverBase.current) throw error;
            const remote = await studioApi<StudioProject>(`/projects/${snapshot.id}`);
            const rebased = mergeProject(serverBase.current, snapshot, remote);
            saved = await studioApi<StudioProject>(`/projects/${snapshot.id}`, { baseRevision: remote.revision, project: rebased }, 'PUT');
          }
          serverRevision.current = saved.revision;
          if (localVersion.current === version) acceptServer(saved);
          else if (current.current) { current.current = mergeProject(snapshot, current.current, saved); serverBase.current = structuredClone(saved); setProject(current.current); }
        } catch (e) { dirty.current = true; setSaveState('保存失败 · 草稿已保留'); localStorage.setItem(`studio-v3-draft:${snapshot.id}`, JSON.stringify(current.current?.id === snapshot.id ? current.current : snapshot)); throw e; }
      }
      setSaveState('已保存');
    };
    const task = work(); saving.current = task;
    try { await task; } finally { if (saving.current === task) saving.current = null; }
  }, [acceptServer]);

  const edit = useCallback((change: (value: StudioProject) => StudioProject) => {
    if (!current.current) return;
    if (current.current.access?.readOnly) { showError(new Error('此示例为只读，请先复制为我的工程')); return; }
    const next = change(structuredClone(current.current));
    current.current = next; localVersion.current += 1; dirty.current = true; setProject(next); setSaveState('未保存');
    localStorage.setItem(`studio-v3-draft:${next.id}`, JSON.stringify(next));
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void flush().catch(showError), 700);
  }, [flush, showError]);

  const onCanvasNodesChange = useCallback((changes: NodeChange<MediaNode>[]) => {
    const p = current.current;
    if (!p) return;
    // ReactFlow is controlled: accept selection changes as local presentation
    // state so an explicitly clicked video remains the Mode 4 source.
    const selection = changes.filter(change => change.type === 'select' && p.nodes.some(node => node.id === change.id));
    if (selection.length) setSelectedIds(previous => {
      const next = new Set(previous);
      for (const change of selection) if (change.type === 'select') { if (change.selected) next.add(change.id); else next.delete(change.id); }
      const ids = [...next];
      return previous.length === ids.length && previous.every((id, index) => id === ids[index]) ? previous : ids;
    });
    // Controlled ReactFlow nodes must retain ResizeObserver measurements across
    // selection/server updates. They are presentation state, never project edits.
    if (changes.some(change => change.type === 'dimensions')) setNodeMeasurements(previous => {
      let byId = previous.projectId === p.id ? previous.byId : {};
      for (const change of changes) {
        if (change.type !== 'dimensions' || !change.dimensions || !p.nodes.some(node => node.id === change.id)) continue;
        const { width, height } = change.dimensions;
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || (byId[change.id]?.width === width && byId[change.id]?.height === height)) continue;
        byId = { ...byId, [change.id]: { width, height } };
      }
      return previous.projectId === p.id && previous.byId === byId ? previous : { projectId: p.id, byId };
    });
    const removed = new Set(changes.filter(c => c.type === 'remove').map(c => c.id));
    const positions = changes.filter(c => c.type === 'position' && c.position && p.nodes.some(n => n.id === c.id && (n.x !== c.position!.x || n.y !== c.position!.y)));
    if (!removed.size && !positions.length) return;
    edit(next => {
      next.nodes = next.nodes.filter(n => !removed.has(n.id));
      next.edges = next.edges.filter(e => !removed.has(e.source) && !removed.has(e.target));
      const translated = new Map<string, { x: number; y: number }>();
      for (const change of positions) {
        if (change.type !== 'position' || !change.position) continue;
        const old = p.nodes.find(n => n.id === change.id);
        if (!old) continue;
        translated.set(old.id, change.position);
        if (old.groupId) for (const sibling of p.nodes.filter(n => n.groupId === old.groupId)) {
          if (!positions.some(c => 'id' in c && c.id === sibling.id)) translated.set(sibling.id, { x: sibling.x + change.position.x - old.x, y: sibling.y + change.position.y - old.y });
        }
      }
      next.nodes = next.nodes.map(n => translated.has(n.id) ? { ...n, ...translated.get(n.id)! } : n);
      return next;
    });
  }, [edit]);

  const loadProject = useCallback(async (id: string) => {
    const request = ++projectLoad.current;
    await flush();
    if (request !== projectLoad.current) return;
    let value: StudioProject;
    try { value = await studioApi<StudioProject>(`/projects/${id}`); }
    catch (error) { if (request === projectLoad.current) throw error; return; }
    if (request !== projectLoad.current) return;
    const draft = localStorage.getItem(`studio-v3-draft:${id}`);
    acceptServer(value); setSelectedIds([]); setJobs([]); setFrame(0); setPlaying(false); setProjectMenu(false);
    if (draft && !value.access?.readOnly) { try { const parsed = JSON.parse(draft) as StudioProject; localStorage.setItem(`studio-v3-recovered:${id}`, draft); if (parsed.revision === value.revision) { edit(() => parsed); setNotice('已恢复上次未保存的本地草稿'); } else setNotice('检测到旧草稿，已保留恢复副本；当前显示服务器版本。'); } catch { /* Invalid local drafts do not replace a valid server project. */ } }
  }, [flush, acceptServer, edit]);

  const refreshList = useCallback(async () => setProjects(await studioApi(`/projects`)), []);
  const importOldBrowserVideos = async () => {
    const raw = localStorage.getItem('videoJobs');
    const videoJobs = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(videoJobs) || !videoJobs.length) { setNotice('此浏览器没有旧版视频记录'); return; }
    await flush();
    const imported = await studioApi<StudioProject>('/projects/import', { videoJobs, name: '导入本机旧视频记录' });
    acceptServer(imported); setSelectedIds([]); setProjectMenu(false); await refreshList();
    setNotice('旧记录已只读导入；媒体下载失败会保留在画布说明中');
  };


  useEffect(() => {
    let active = true;
    const startup = projectLoad.current;
    // A slow or offline renderer must not hold the user's saved workspace hostage.
    void studioApi<StudioCapabilities>('/capabilities').then(caps => { if (active) setCapabilities(caps); }).catch(error => { if (active) showError(error); });
    void studioApi<Array<{ id: string; name: string; updatedAt: string }>>('/projects').then(async list => {
      if (!active) return;
      setProjects(list);
      if (startup !== projectLoad.current) return;
      const id = new URLSearchParams(location.search).get('project') || localStorage.getItem('studio-v3-last-project');
      if (id && list.some(p => p.id === id)) await loadProject(id);
      else if (list[0]) await loadProject(list[0].id);
    }).catch(error => { if (active) showError(error); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; projectLoad.current += 1; };
  }, [loadProject, showError]);

  useEffect(() => { const handler = (event: BeforeUnloadEvent) => { if (dirty.current || saving.current) { event.preventDefault(); event.returnValue = ''; } }; window.addEventListener('beforeunload', handler); return () => window.removeEventListener('beforeunload', handler); }, []);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 7000); return () => clearTimeout(timer); }, [notice]);
  useEffect(() => {
    if (!playing || !project) return;
    const start = performance.now(); const startFrame = frame; let raf = 0;
    const tick = (time: number) => { const next = startFrame + Math.floor((time - start) / (1000 / 24)); if (next >= project.sequence.totalFrames) { setFrame(project.sequence.totalFrames - 1); setPlaying(false); } else { setFrame(next); raf = requestAnimationFrame(tick); } };
    raf = requestAnimationFrame(tick); return () => cancelAnimationFrame(raf);
    // A single absolute clock drives the viewport, timeline and media preview.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, project?.sequence.totalFrames]);
  useEffect(() => {
    if (!project?.id || project.access?.readOnly) return;
    let live = true; let timer: ReturnType<typeof setTimeout>;
    const consumed = new Map<string, string>();
    const poll = async () => {
      try {
        const list = await studioApi<StudioJob[]>(`/projects/${project.id}/jobs`);
        if (!live) return;
        setJobs(list);
        const finished = list.filter(j => { const stamp = jobOutputStamp(j); return stamp && consumed.get(j.id) !== stamp; });
        if (finished.length && !lockDepth.current) {
          if (saving.current) await saving.current;
          const remote = await studioApi<StudioProject>(`/projects/${project.id}`);
          if (live && !lockDepth.current && remote.revision >= serverRevision.current && current.current?.id === remote.id && serverBase.current) {
            const merged = mergeProject(serverBase.current, current.current, remote);
            const hasDraft = !authoringEqual(merged, remote);
            serverBase.current = structuredClone(remote); serverRevision.current = remote.revision;
            current.current = merged; dirty.current = hasDraft; setProject(merged);
            if (hasDraft) await flush();
            finished.forEach(j => { const stamp = jobOutputStamp(j); if (stamp) consumed.set(j.id, stamp); });
          }
        }
      } catch (error) { if (error instanceof Error && error.message.includes('冲突修改')) showError(error); /* Transient polling errors retry without replacing local drafts. */ }
      if (live) timer = setTimeout(poll, 2500);
    };
    void poll(); return () => { live = false; clearTimeout(timer); };
  }, [project?.id, project?.access?.readOnly, flush, showError]);

  const withLock = async <T,>(fn: () => Promise<T>): Promise<T> => { lockDepth.current += 1; setLocked(true); try { return await fn(); } finally { lockDepth.current -= 1; setLocked(lockDepth.current > 0); } };
  const run = async (fn: () => Promise<void>) => { setBusy(true); setError(''); try { await withLock(fn); } catch (e) { showError(e); } finally { setBusy(false); } };
  const createProject = (demo: boolean) => run(async () => { await flush(); acceptServer(await studioApi('/projects', { name: demo ? '屋顶 · 三人行动' : '未命名项目', demo })); setSelectedIds([]); setFrame(0); setProjectMenu(false); await refreshList(); setTimeout(() => void flow.fitView({ padding: 0.25 }), 250); });
  const openDirector = useCallback((id?: string, cameraId?: string) => { const scene = id || current.current?.scenes.find(scene => scene.codeProgram)?.id || current.current?.scenes[0]?.id; if (scene) { setDirectorCapture(undefined); setDirectorView(cameraId ? { cameraId, mode: 'dynamic', shotView: true } : undefined); setDirectorScene(scene); setPlaying(false); } }, []);
  const editCapture = (nodeId: string, assetId: string) => run(async () => {
    await flush(); const p = current.current!, node = p.nodes.find(item => item.id === nodeId), asset = p.assets.find(item => item.id === assetId);
    if (!node || node.type !== 'image' || node.assetId !== assetId || node.shotId || asset?.kind !== 'image') throw new Error('请选择仍绑定这张截图的图片节点后再编辑');
    const metadata = asset.metadata || {};
    const scene = p.scenes.find(s => s.id === metadata.sceneId);
    if (!scene || metadata.sceneRevision !== scene.revision) throw new Error('这张灰模截图对应的场景已变更。请在导演台重新截图后再圈选，避免修改错误对象。');
    if (!scene.cameras.some(c => c.id === metadata.cameraId) || !Number.isInteger(metadata.frame) || Number(metadata.frame) < 0 || Number(metadata.frame) >= p.totalFrames || !['static', 'dynamic'].includes(String(metadata.mode))) throw new Error('截图缺少有效的相机、帧或模式信息，请重新截图');
    if (!Array.isArray(metadata.objectIds) || metadata.objectIds.some(id => !scene.objects.some(o => o.id === id))) throw new Error('截图对象映射失效，请重新截图');
    const reference: CaptureReference = { projectId: p.id, nodeId, assetId, assetHash: asset.hash, name: asset.name, sceneId: scene.id, sceneRevision: scene.revision, cameraId: String(metadata.cameraId), frame: Number(metadata.frame), mode: metadata.mode === 'static' ? 'static' : 'dynamic' };
    const invalid = captureReferenceError(p, reference); if (invalid) throw new Error(invalid);
    setDirectorCapture(reference); setDirectorView({ cameraId: reference.cameraId, mode: reference.mode, shotView: true }); setFrame(reference.frame); setPlaying(false); setDirectorScene(scene.id);
  });

  const addNode = (type: CanvasNode['type'], assetId?: string) => {
    if (!current.current) return;
    const id = studioId(); const position = flow.screenToFlowPosition({ x: window.innerWidth * 0.43, y: window.innerHeight * 0.4 });
    const measured = new Map(flow.getNodes().map(node => [node.id, node.measured]));
    edit(p => {
      const placed = placeCanvasCard(position, p.nodes.map(node => ({ x: node.x, y: node.y, width: measured.get(node.id)?.width || node.width || 264, height: measured.get(node.id)?.height || 440 })));
      const card: CanvasNode = { id, type, ...placed, label: kindLabels[type], assetId };
      if (type === 'director' || type === 'subject') card.sceneId = p.scenes[0]?.id;
      if (type === 'shot') { const shotId = studioId(); const scene = p.scenes[0]; const startFrame = Math.min(p.totalFrames - 1, p.shots.at(-1)?.endFrame || 0); const shot: Shot = { id: shotId, name: `镜头 ${p.shots.length + 1}`, sceneId: scene.id, cameraId: scene.activeCameraId, startFrame, endFrame: Math.min(p.totalFrames, startFrame + 96), prompt: '', subjectIds: [], takes: [] }; p.shots.push(shot); card.shotId = shotId; card.label = shot.name; }
      p.nodes.push(card); return p;
    });
    setSelectedIds([id]);
    if (type === 'sequence') setTimelineOpen(true);
  };

  const uploadAsset = async (blob: Blob, name: string, kind?: AssetKind, metadata?: Record<string, unknown>) => withLock(async () => {
    await flush();
    const p = current.current; if (!p) throw new Error('请先创建项目'); if (p.access?.readOnly) throw new Error('请先复制为我的工程');
    const resolvedKind = kind || (blob.type.startsWith('video/') ? 'video' : blob.type.startsWith('audio/') ? 'audio' : /\.(glb|gltf)$/i.test(name) ? 'model' : 'image');
    const result = await studioApi<{ asset: AssetRevision; project: StudioProject }>(`/projects/${p.id}/assets`, { name, kind: resolvedKind, mime: blob.type || (resolvedKind === 'model' ? 'model/gltf-binary' : 'application/octet-stream'), base64: await blobBase64(blob), metadata });
    acceptServer(result.project); return result.asset;
  });
  const uploadFiles = async (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      if (file.size > 64 * 1024 * 1024) throw new Error(`${file.name} 超过 64 MB，请使用较小的代理素材`);
      if (!/^(image|audio|video)\//.test(file.type) && !/\.glb$/i.test(file.name)) throw new Error('支持图片、视频、音频和 GLB 模型');
      const asset = await uploadAsset(file, file.name);
      if (asset.kind !== 'model') addNode(asset.kind as CanvasNode['type'], asset.id);
      else { setAssetLibrary(true); setNotice('模型已入库，可在导演台中添加'); }
      await flush();
    }
  };
  const onCommand = async (ops: SceneOp[]) => withLock(async () => { if (current.current?.access?.readOnly) throw new Error('请先复制为我的工程'); await flush(); const p = current.current!; acceptServer(await studioApi(`/projects/${p.id}/commands`, { baseRevision: p.revision, commandId: studioId(), ops })); });
  const onHistory = (direction: 'undo' | 'redo') => run(async () => { await flush(); const p = current.current!; acceptServer(await studioApi(`/projects/${p.id}/history`, { baseRevision: p.revision, direction })); });
  const ai = async (text: string, context?: DirectorAIContext) => withLock(async () => {
    if (!text.trim()) return;
    if (current.current?.access?.readOnly) throw new Error('请先复制为我的工程');
    await flush(); const p = current.current!;
    let referenceNodeIds = context ? [] : selectedIds;
    if (context && directorCapture) {
      const invalid = captureReferenceError(p, directorCapture); if (invalid) throw new Error(invalid);
      const metadata = p.assets.find(asset => asset.id === directorCapture.assetId)!.metadata!;
      if (context.selectionIds.some(id => !(metadata.objectIds as string[]).includes(id))) throw new Error('所选对象不在引用截图的对象映射中，请重新截图后再编辑。');
      if (context.partSelection?.some(part => !Array.isArray(metadata.partIds) || !metadata.partIds.some(mapped => mapped?.objectId === part.objectId && mapped?.partId === part.partId))) throw new Error('所选部件不在引用截图的部件映射中，请重新截图后再编辑。');
      if (directorScene !== directorCapture.sceneId || context.frame !== directorCapture.frame || context.mode !== directorCapture.mode || context.cameraId !== directorCapture.cameraId || !context.shotView) throw new Error('当前帧、模式或机位与引用截图不一致。请回到截图状态或重新截图。');
      referenceNodeIds = [directorCapture.nodeId];
    }
    setChat(c => [...c, { role: 'user', text }]);
    const result = await studioApi<{ project: StudioProject; message: string }>(`/projects/${p.id}/ai`, { baseRevision: p.revision, prompt: text, sceneId: directorScene || p.scenes[0]?.id, selectionIds: context?.selectionIds || [], partSelection: context?.partSelection || [], selectedNodeIds: referenceNodeIds, frame: context?.frame ?? frame, mode: context?.mode || 'static', scope: context ? 'scene' : 'storyboard', ...(context ? { cameraId: context.cameraId, shotView: context.shotView } : {}) });
    acceptServer(result.project); setChat(c => [...c, { role: 'assistant', text: result.message }]);
  });
  const showReview = () => run(async () => { await flush(); setReview(await studioApi(`/projects/${current.current!.id}/review`)); setPlaying(false); });
  const approveReview = () => run(async () => { if (!review) return; await flush(); for (const item of review.shots) acceptServer(await studioApi(`/projects/${current.current!.id}/shots/${item.shotId}/approve`, { hash: item.hash })); setNotice('已确认这版脚本，可以逐镜生成'); setReview(null); });
  const generateShot = (shot: Shot) => run(async () => { await flush(); const p = current.current!; const fresh = p.shots.find(s => s.id === shot.id)!; if (!fresh.approval) { setReview(await studioApi(`/projects/${p.id}/review`)); return; } const approvalHash = fresh.approval.hash; const job = await submitJobWithReceipt(localStorage, `${p.id}:${shot.id}:${approvalHash}`, key => studioApi<StudioJob>(`/projects/${p.id}/shots/${shot.id}/generate`, { idempotencyKey: key, approvalHash })); setJobs(j => [job, ...j]); setNotice('镜头已提交，可继续编辑其他镜头'); });
  const exportSequence = () => run(async () => { await flush(); const p = current.current!; const job = await studioApi<StudioJob>(`/projects/${p.id}/exports`, { idempotencyKey: studioId(), sequenceId: p.sequence.id }); setJobs(j => [job, ...j]); setNotice('成片导出已排队'); });
  const addToSequence = (asset: AssetRevision, shot?: Shot) => {
    if (!['video', 'audio'].includes(asset.kind)) return;
    if (isComparison(asset)) { setVersionAssetId(asset.id); setNotice('并排对比用于检查版本，请选择单画面版本加入时间线'); return; }
    edit(p => { const start = shot?.startFrame ?? frame; const duration = Number(asset.metadata?.duration || 0); const available = duration > 0 ? Math.floor(duration * 24) : p.totalFrames - start; const end = Math.min(p.sequence.totalFrames, shot?.endFrame ?? start + available); if (shot) p.sequence.clips = p.sequence.clips.filter(c => !(c.kind === 'video' && c.track === 0 && c.startFrame < shot.endFrame && c.endFrame > shot.startFrame)); p.sequence.clips.push({ id: studioId(), kind: asset.kind as 'video' | 'audio', track: asset.kind === 'audio' ? 1 : 0, startFrame: start, endFrame: end, sourceIn: 0, assetId: asset.id, volume: 1, fadeIn: 0, fadeOut: 0 }); return p; }); setTimelineOpen(true);
  };
  const addJob = (job: StudioJob) => setJobs(list => [job, ...list.filter(item => item.id !== job.id)]);
  const enhance = (asset: AssetRevision) => run(async () => {
    await flush(); const p = current.current!;
    const source = p.assets.find(item => item.id === asset.id);
    if (p.access?.readOnly) throw new Error('请先复制为我的工程');
    if (!source || source.kind !== 'video' || source.hash !== asset.hash || isComparison(source)) throw new Error('请选择当前项目中未变更的单画面视频');
    addJob(await submitJobWithReceipt(localStorage, `${p.id}:enhance:${source.id}:${source.hash}`, idempotencyKey => studioApi<StudioJob>(`/projects/${p.id}/enhancements`, { baseRevision: p.revision, sourceAssetId: source.id, sourceHash: source.hash, idempotencyKey })));
    setNotice('DLSS 5 增强已排队，原视频和剪辑保持不变');
  });
  const openEffects = (asset?: AssetRevision) => {
    const p = current.current;
    if (!p) { setNotice('请先打开 AI 成片或代码动画所在的工程'); return; }
    const selected = selectedIds.length === 1 ? p.assets.find(item => item.id === p.nodes.find(node => node.id === selectedIds[0])?.assetId && item.kind === 'video') : undefined;
    setEffectsDialog({ projectId: p.id, assetId: asset?.id || selected?.id });
  };
  const planEffects = (asset: AssetRevision, text: string) => run(async () => {
    await flush(); const p = current.current!;
    if (p.id !== effectsDialog?.projectId || p.access?.readOnly) throw new Error('请在源视频所属的可编辑工程中制作特效');
    const source = p.assets.find(item => item.id === asset.id);
    if (!source || source.hash !== asset.hash || !isEffectsSource(p, source)) throw new Error('请选择当前工程中来源可信且未变更的单画面视频');
    const prompt = text.trim(); if (!prompt) throw new Error('请描述需要的后期效果');
    const job = await submitJobWithReceipt(localStorage, `${p.id}:effects-plan:${source.id}:${source.hash}:${prompt}`, async idempotencyKey => effectsJobReceipt(await studioApi<StudioJob>(`/projects/${p.id}/effects-plans`, { baseRevision: p.revision, sourceAssetId: source.id, sourceHash: source.hash, prompt, idempotencyKey }), 'effects-plan', p.id, source.id, source.hash));
    addJob(job); setEffectsDialog(undefined); setNotice('Opus 特效计划已排队，完成后自动合成，源视频保持不变');
  });
  const continueEffects = useCallback(async (plan: StudioJob) => {
    if (effectsSubmitting.current) return;
    effectsSubmitting.current = true; setEffectsPending(plan.id);
    lockDepth.current += 1; setLocked(true);
    try {
      await flush(); const p = current.current;
      if (!p || p.id !== plan.projectId || p.access?.readOnly) throw new Error('请先打开此特效计划所属的可编辑工程');
      if (effectsRenderForPlan(jobs, plan)) return;
      const input = effectsPlanInput(p, plan);
      const job = await submitJobWithReceipt(localStorage, `${p.id}:effects-render:${input.planJobId}:${input.planHash}:${input.sourceHash}`, async idempotencyKey => effectsJobReceipt(await studioApi<StudioJob>(`/projects/${p.id}/effects-renders`, { baseRevision: p.revision, ...input, idempotencyKey }), 'effects-render', p.id, input.sourceAssetId, input.sourceHash, input.planJobId, input.planHash));
      localStorage.removeItem(effectsCancellationKey(plan));
      if (current.current?.id === p.id) setJobs(list => [job, ...list.filter(item => item.id !== job.id)]);
      setNotice('特效合成已排队，完成后可对比并选择使用；当前剪辑保持不变');
    } catch (error) { showError(error); }
    finally { effectsSubmitting.current = false; setEffectsPending(undefined); lockDepth.current -= 1; setLocked(lockDepth.current > 0); }
  }, [flush, jobs, showError]);
  useEffect(() => {
    if (!project || project.access?.readOnly || locked || !capabilities?.effects?.available) return;
    const plan = jobs.find(job => job.projectId === project.id && job.kind === 'effects-plan' && job.state === 'complete' && !job.renderJobId && !job.output?.renderJobId && !localStorage.getItem(effectsCancellationKey(job)) && !effectsRenderForPlan(jobs, job) && !effectsAttempts.current.has(job.id));
    if (!plan) return;
    // One automatic submission attempt per mounted session. A lost response keeps
    // its durable key; manual continuation or reload can safely recover it.
    effectsAttempts.current.add(plan.id);
    void continueEffects(plan);
  }, [project, jobs, locked, capabilities?.effects?.available, continueEffects]);
  const generateScene = (film: FilmId, text: string) => run(async () => {
    await flush();
    // Each deliberate creation owns a new template. A failed POST retries against
    // that same project and persisted request key, never the previous user's edit.
    if (!generationDraft.current || generationDraft.current.film !== film || generationDraft.current.projectId !== current.current?.id) {
      const names = { 'three-knocks': '三下敲门', 'borrow-sunshine': '借你一块晴天', 'last-seed-of-light': '最后一颗光种' };
      const created = await studioApi<StudioProject>('/projects', { name: `${names[film]} · 代码场景`, demo: false });
      generationDraft.current = { projectId: created.id, film }; acceptServer(created); setJobs([]); setSelectedIds([]); setFrame(0);
    }
    let p = current.current!;
    if (p.totalFrames !== 1440 || p.aspect !== '16:9') {
      const template = { ...p, totalFrames: 1440, aspect: '16:9' as const, sequence: { ...p.sequence, totalFrames: 1440, name: '60 秒成片' } };
      p = await studioApi<StudioProject>(`/projects/${p.id}`, { baseRevision: p.revision, project: template }, 'PUT'); acceptServer(p);
    }
    await refreshList();
    addJob(await submitJobWithReceipt(localStorage, `${p.id}:scene:${film}:${text.trim()}`, idempotencyKey => studioApi<StudioJob>(`/projects/${p.id}/scene-generations`, { baseRevision: p.revision, film, prompt: text.trim(), idempotencyKey })));
    setSceneGenerationOpen(false); setNotice('代码场景已排队，完成后请应用到导演台，再选择导出工具');
  });
  const applySceneJob = (job: StudioJob) => run(async () => {
    await flush(); const p = current.current!;
    if (job.projectId !== p.id || job.kind !== 'scene-generation' || job.state !== 'complete' || !job.output?.sceneProgram) throw new Error('此场景任务尚未完成，或不属于当前工程');
    const existing = p.scenes.find(scene => scene.codeGenerationJobId === job.id);
    if (existing) { openDirector(existing.id); return; }
    const { compileSceneProgram } = await import('../../lib/studio/code-scene');
    const scene = compileSceneProgram(job.output.sceneProgram as SceneProgram);
    const result = await submitJobWithReceipt(localStorage, `${p.id}:apply-scene:${job.id}`, commandId => studioApi<{ project: StudioProject; sceneId: string }>(`/projects/${p.id}/scene-generations/${job.id}/apply`, { baseRevision: p.revision, commandId, scene }));
    acceptServer(result.project); setFrame(0); openDirector(result.sceneId); setNotice('场景已应用，可编辑角色、动作与镜头；支持一次撤销');
  });
  const renderScene = (sceneId: string, choice: ExportChoice) => run(async () => {
    await flush(); const p = current.current!, scene = p.scenes.find(s => s.id === sceneId);
    if (p.access?.readOnly) throw new Error('请先复制为我的工程');
    if (!scene?.codeProgram) throw new Error('请选择已应用到导演台的代码场景');
    const backends = renderBackends(choice);
    const result = await submitJobWithReceipt(localStorage, `${p.id}:render:${sceneId}:${scene.revision}:${backends.join(',')}`, idempotencyKey => studioApi<{ jobs: StudioJob[]; renderGroupId: string }>(`/projects/${p.id}/renders`, { baseRevision: p.revision, sceneId, sceneRevision: scene.revision, backends, ...(scene.codeGenerationJobId ? { sceneGenerationJobId: scene.codeGenerationJobId } : {}), idempotencyKey }));
    result.jobs.forEach(addJob); setNotice(backends.length === 2 ? '同一场景的两种导出已排队，将分别保留结果' : '场景成片已排队');
  });
  const retryJob = (job: StudioJob) => run(async () => {
    const resumeEffects = canResumeEffectsHandoff(job);
    if (!job.retryable || job.state !== 'failed' && !resumeEffects) throw new Error('此任务不能自动重试，请先核对任务状态');
    const result = await submitJobWithReceipt(localStorage, `retry:${job.projectId}:${job.id}:${job.updatedAt}`, async idempotencyKey => { const value = await studioApi<StudioJob>(`/jobs/${job.id}/retry`, { idempotencyKey }); if (value?.id !== job.id || value.projectId !== job.projectId || value.kind !== job.kind) throw new Error('未收到匹配的恢复任务回执，请核对任务记录'); return value; });
    if (resumeEffects) { effectsAttempts.current.add(job.id); localStorage.removeItem(effectsCancellationKey(job)); }
    addJob(result); setNotice(resumeEffects ? '已恢复同一计划的后续合成，不会重新请求模型' : '已恢复失败阶段，已完成的结果继续保留');
  });
  const cancelJob = (job: StudioJob) => run(async () => {
    // Record intent before networking: an interrupted response or reload must not
    // make the browser automatically start the stage the user just cancelled.
    if (job.kind === 'effects-plan') { localStorage.setItem(effectsCancellationKey(job), '1'); effectsAttempts.current.add(job.id); }
    addJob(await studioApi<StudioJob>(`/jobs/${job.id}/cancel`, {})); setNotice('取消请求已发送');
  });
  const copyDemo = () => run(async () => { const p = current.current!; acceptServer(await studioApi(`/projects/${p.id}/copy`, {})); setJobs([]); setSelectedIds([]); await refreshList(); setNotice('已创建属于此浏览器的工程副本，原示例保持不变'); });
  const copySelection = useCallback(() => {
    const p = current.current; if (!p) return;
    const selected = p.nodes.filter(n => selectedIds.includes(n.id));
    clipboard.current = structuredClone({ projectId: p.id, nodes: selected, edges: p.edges.filter(e => selectedIds.includes(e.source) && selectedIds.includes(e.target)), shots: p.shots.filter(shot => selected.some(n => n.shotId === shot.id)) });
  }, [selectedIds]);
  const pasteSelection = useCallback(() => {
    const copied = clipboard.current;
    if (!copied?.nodes.length) return;
    if (copied.projectId !== current.current?.id) { setNotice('请在原项目内粘贴；跨项目素材请重新导入'); return; }
    const ids = new Map(copied.nodes.map(n => [n.id, studioId()]));
    const shotIds = new Map(copied.shots.map(s => [s.id, studioId()]));
    const groups = new Map(copied.nodes.filter(n => n.groupId).map(n => [n.groupId!, studioId()]));
    edit(p => {
      for (const shot of copied.shots) p.shots.push({ ...structuredClone(shot), id: shotIds.get(shot.id)!, name: `${shot.name} 副本`, approval: undefined, takes: [], selectedTakeId: undefined });
      for (const n of copied.nodes) p.nodes.push({ ...structuredClone(n), id: ids.get(n.id)!, shotId: n.shotId ? shotIds.get(n.shotId) : undefined, x: n.x + 40, y: n.y + 40, label: `${n.label} 副本`, groupId: n.groupId ? groups.get(n.groupId) : undefined });
      for (const e of copied.edges) p.edges.push({ id: studioId(), source: ids.get(e.source)!, target: ids.get(e.target)! });
      return p;
    }); setSelectedIds([...ids.values()]);
  }, [edit]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (lockDepth.current || (e.target as HTMLElement)?.closest('input,textarea,[contenteditable="true"]') || directorScene) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c') { e.preventDefault(); copySelection(); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'v') { e.preventDefault(); pasteSelection(); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void flush().catch(showError); }
      if (e.key === 'Escape') { setSelectedIds([]); setPreviewOpen(false); setPlaying(false); }
    };
    const paste = (e: ClipboardEvent) => { if ((e.target as HTMLElement)?.closest('input,textarea,[contenteditable="true"]') || directorScene || !current.current) return; if (e.clipboardData?.files.length) { e.preventDefault(); void run(() => uploadFiles(e.clipboardData!.files)); } };
    window.addEventListener('keydown', key); window.addEventListener('paste', paste);
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('paste', paste); };
  });

  useEffect(() => {
    if (!project?.id) return;
    const viewport = current.current?.viewport;
    let second = 0; const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => { if (viewport) void flow.setViewport(viewport); else void flow.fitView({ padding: 0.2 }); }); });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
    // Restore view only on project switch; dragging does not reset the view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);

  const nodes = useMemo<MediaNode[]>(() => project?.nodes.map(card => {
    const shot = project.shots.find(s => s.id === card.shotId);
    const asset = project.assets.find(a => a.id === (card.assetId || shot?.firstAssetId));
    return { id: card.id, type: 'media', position: { x: card.x, y: card.y }, selected: selectedIds.includes(card.id), width: card.width || 264, measured: nodeMeasurements.projectId === project.id ? nodeMeasurements.byId[card.id] : undefined, data: { card, asset, shot, project, openDirector }, style: { width: card.width || 264 }, className: card.groupId ? 'studio-grouped-node' : undefined };
  }) || [], [project, selectedIds, openDirector, nodeMeasurements]);
  const edges = useMemo<Edge[]>(() => project?.edges.map(e => ({ ...e, type: 'smoothstep', animated: false, style: { stroke: '#5d6878', strokeWidth: 1.4 } })) || [], [project?.edges]);
  const selectedCard = project?.nodes.find(n => n.id === selectedIds[0]);
  const selectedShot = project?.shots.find(s => s.id === selectedCard?.shotId);
  const selectedAsset = project?.assets.find(a => a.id === selectedCard?.assetId);
  const runningJobs = jobs.filter(j => ['queued', 'running'].includes(j.state));
  const versionSource = project?.assets.find(asset => asset.id === versionAssetId);
  const versionAssets = project && versionSource ? videoFamily(project, versionSource) : [];

  return <main className="studio-root" inert={locked} aria-busy={locked}>
    <header className="studio-topbar">
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- Full workspace navigation must retain the beforeunload unsaved-draft guard. */}
      <a href="/" className="studio-brand" aria-label="返回生图工作台"><Sparkles size={26} fill="currentColor" /></a>
      <button className="studio-project-trigger" onClick={() => setProjectMenu(!projectMenu)}>{project?.name || '视频工作台'}<ChevronDown size={15} /></button>
      <span className="studio-version">3.0</span>{project && <select aria-label="画面比例" className="studio-aspect" value={project.aspect} onChange={e => edit(p => ({ ...p, aspect: e.target.value as StudioProject['aspect'] }))}><option value="16:9">16:9</option><option value="9:16">9:16</option></select>}
      {project && <><span className="studio-save-status"><span className={saveState !== '已保存' ? 'pending' : ''} />{saveState}</span><div className="studio-top-actions"><button title="撤销" disabled={busy} onClick={() => onHistory('undo')}><Undo2 size={16} /></button><button title="重做" disabled={busy} onClick={() => onHistory('redo')}><Redo2 size={16} /></button><button disabled={busy} onClick={() => void run(flush)}><Save size={15} /></button><button onClick={() => setTimelineOpen(!timelineOpen)} className={timelineOpen ? 'active' : ''}><Layers size={16} />时间线</button><button onClick={showReview} disabled={busy}><FileText size={16} />审核脚本</button><button onClick={() => { setPreviewOpen(true); setPlaying(false); }}><Film size={16} />预览</button><button onClick={openSceneGeneration} disabled={busy} title="模式 3 · 代码动画"><Box size={16} />模式 3 · 代码动画</button><button onClick={() => openEffects()} disabled={busy} title="模式 4 · Opus 特效员"><Sparkles size={16} />模式 4 · Opus 特效员</button><button className="studio-primary" onClick={exportSequence} disabled={busy || project.access?.readOnly}><Download size={16} />导出</button></div></>}
      {!project && <span className="studio-top-hint">创意，从一个画面开始</span>}
    </header>
    {projectMenu && <div className="studio-project-menu"><p className="studio-muted">工程归属于此浏览器；清除网站数据会丢失匿名访问身份。</p>{project && <label className="studio-project-rename">项目名称<input aria-label="项目名称" value={project.name} onChange={e => edit(p => ({ ...p, name: e.target.value }))} /></label>}<button onClick={() => void createProject(false)}><Plus size={15} />新建空白项目</button><button onClick={() => void createProject(true)}><Clapperboard size={15} />打开三人五镜示例</button>{projects.map(p => <button key={p.id} onClick={() => void run(() => loadProject(p.id))}><Folder size={15} />{p.name}{p.id === project?.id && <Check size={14} />}</button>)}<button onClick={() => importInput.current?.click()}><Upload size={15} />导入旧本体 / 视频记录</button><button data-action="import-browser-history" onClick={() => void run(importOldBrowserVideos)}><Film size={15} />导入本机旧视频记录</button><a href="/video/legacy"><ArrowLeft size={15} />旧版视频记录</a></div>}
    {project?.access?.readOnly && <div className="studio-readonly" role="status">这是公开示例，原工程仅供查看。{project.access.canCopy && <button onClick={copyDemo}>复制为我的工程</button>}</div>}
    {error && <div className="studio-toast studio-error" role="alert"><span>{error}</span><button onClick={() => setError('')}><X size={15} /></button></div>}
    {notice && <div className="studio-toast" role="status"><Check size={15} />{notice}<button onClick={() => setNotice('')}><X size={15} /></button></div>}
    {loading ? <div className="studio-loading"><Loader2 className="spin" size={22} />正在载入工作区…</div> : !project ? <div className="studio-welcome"><div className="studio-welcome-glow" /><span className="studio-eyebrow">WEIAI · VIDEO STUDIO</span><h1>你好，今天想要创造什么？</h1><p>从灵感到分镜，从三维预演到你的下一部作品。</p><div className="studio-welcome-modes"><button className="active">分镜生成</button><button onClick={openSceneGeneration}>模式 3 · 代码动画</button><button onClick={() => openEffects()}>模式 4 · Opus 特效员</button><button onClick={() => void createProject(false)}>画布</button></div><div className="studio-welcome-composer"><textarea placeholder="写下想法、剧本，或从示例开始创作…" value={prompt} onChange={e => setPrompt(e.target.value)} /><div><span><Sparkles size={17} />Agent 模式</span><span>24 fps · 可编辑 3D 导演台</span><button className="studio-send" disabled={busy} aria-label="创建视频项目" onClick={() => void run(async () => { acceptServer(await studioApi('/projects', { name: prompt.trim().slice(0, 32) || '未命名项目', demo: false })); await refreshList(); if (prompt.trim()) { setChatOpen(true); await ai(prompt); setPrompt(''); } })}><ArrowUp size={21} /></button></div></div><div className="studio-start-options"><button disabled={busy} onClick={() => void createProject(true)}><Box size={19} /><b>三人行动 · 五镜示例</b><span>进入场景，体验人物与机位编辑</span></button><button disabled={busy} onClick={() => void createProject(false)}><Plus size={19} /><b>空白画布</b><span>上传素材，自由组织你的故事</span></button></div></div> : <>
      <div className={`studio-work-area ${timelineOpen ? 'with-timeline' : ''}`} onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }} onDrop={e => { if (e.dataTransfer.files.length) { e.preventDefault(); void run(() => uploadFiles(e.dataTransfer.files)); } }}>
        <nav className="studio-tool-rail" aria-label="新建节点">{(['text', 'image', 'video', 'audio', 'sequence', 'subject', 'director'] as CanvasNode['type'][]).map(kind => { const Icon = kindIcons[kind]; return <button key={kind} title={kindLabels[kind]} aria-label={kindLabels[kind]} onClick={() => kind === 'director' ? openDirector() : kind === 'sequence' ? setTimelineOpen(!timelineOpen) : addNode(kind)}><Icon size={22} strokeWidth={1.65} /><span>{kindLabels[kind]}</span>{kind === 'director' && <small>3D</small>}</button>; })}<hr /><button title="资产库" onClick={() => setAssetLibrary(!assetLibrary)}><Folder size={22} /><span>资产库</span></button><button title="上传" onClick={() => input.current?.click()}><Upload size={22} /><span>上传</span></button></nav>
        <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView={!project.viewport} defaultViewport={project.viewport} fitViewOptions={{ padding: 0.2 }} minZoom={0.15} maxZoom={2} selectionOnDrag panOnDrag={[1, 2]} deleteKeyCode={['Backspace', 'Delete']} multiSelectionKeyCode={['Meta', 'Control', 'Shift']} selectionKeyCode="Shift"
          onMoveEnd={(event, viewport) => { if (event) edit(p => ({ ...p, viewport })); }}
          onNodesChange={onCanvasNodesChange}
          onSelectionChange={onCanvasSelection}
          onNodeDoubleClick={(_, n) => { if (n.data.card.type === 'director') openDirector(n.data.card.sceneId); else if (n.data.card.type === 'sequence') { setTimelineOpen(true); setPreviewOpen(true); } else setSelectedIds([n.id]); }}
          onEdgesDelete={deleted => edit(p => ({ ...p, edges: p.edges.filter(e => !deleted.some(d => d.id === e.id)) }))}
          onConnect={(connection: Connection) => { if (!connection.source || !connection.target || connection.source === connection.target) return; edit(p => ({ ...p, edges: [...p.edges, { id: studioId(), source: connection.source, target: connection.target }] })); }}
          onPaneClick={() => setSelectedIds([])}>
          <Background variant={BackgroundVariant.Dots} color="#3a3d44" gap={28} size={1} /><Controls showInteractive={false} position="bottom-left" /><MiniMap position="bottom-left" pannable zoomable nodeColor="#56677d" maskColor="rgba(13,15,18,.75)" />
        </ReactFlow>
        {!project.nodes.length && <div className="studio-canvas-empty"><Sparkles size={26} /><h2>开启创作，即刻成片</h2><p>从左侧添加素材，或把文件拖到画布</p><button onClick={() => addNode('shot')}><Plus size={15} />新建镜头</button></div>}
        <button className="studio-add-shot" onClick={() => addNode('shot')}><Plus size={14} />新建镜头</button>
        {selectedIds.length > 1 && <div className="studio-selection-actions"><span>已选 {selectedIds.length} 项</span><button onClick={() => { const groupId = studioId(); edit(p => ({ ...p, nodes: p.nodes.map(n => selectedIds.includes(n.id) ? { ...n, groupId } : n) })); }}>编组</button><button onClick={() => edit(p => ({ ...p, nodes: p.nodes.map(n => selectedIds.includes(n.id) ? { ...n, groupId: undefined } : n) }))}>解除编组</button><button onClick={copySelection}>复制</button><button onClick={pasteSelection}>粘贴</button></div>}
        {selectedCard && !assetLibrary && !chatOpen && <aside className="studio-inspector"><header><b>{kindLabels[selectedCard.type]}属性</b><button onClick={() => setSelectedIds([])}><X size={16} /></button></header><label>名称<input value={selectedCard.label} onChange={e => edit(p => ({ ...p, nodes: p.nodes.map(n => n.id === selectedCard.id ? { ...n, label: e.target.value } : n) }))} /></label>{selectedCard.type === 'text' && <label>文本<textarea rows={10} value={selectedCard.text || ''} onChange={e => edit(p => ({ ...p, nodes: p.nodes.map(n => n.id === selectedCard.id ? { ...n, text: e.target.value } : n) }))} /></label>}
          {selectedCard.type !== 'text' && <label>关联素材<select value={selectedCard.assetId || ''} onChange={e => edit(p => ({ ...p, nodes: p.nodes.map(n => n.id === selectedCard.id ? { ...n, assetId: e.target.value || undefined } : n) }))}><option value="">未指定</option>{project.assets.filter(a => selectedCard.type !== 'subject' || a.kind === 'image').map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>}
          {selectedCard.type === 'subject' && <><label>对应场景<select value={selectedCard.sceneId || ''} onChange={e => edit(p => ({ ...p, nodes: p.nodes.map(n => n.id === selectedCard.id ? { ...n, sceneId: e.target.value || undefined, objectId: undefined } : n) }))}><option value="">未指定</option>{project.scenes.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label><label>对应角色 / 对象<select value={selectedCard.objectId || ''} onChange={e => edit(p => ({ ...p, nodes: p.nodes.map(n => n.id === selectedCard.id ? { ...n, objectId: e.target.value || undefined } : n) }))}><option value="">未指定</option>{project.scenes.find(s => s.id === selectedCard.sceneId)?.objects.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}</select></label><label>3D 资产<select value={selectedCard.modelAssetId || ''} onChange={e => edit(p => ({ ...p, nodes: p.nodes.map(n => n.id === selectedCard.id ? { ...n, modelAssetId: e.target.value || undefined } : n) }))}><option value="">使用场景内置角色</option>{project.assets.filter(a => a.kind === 'model').map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label></>}
          {selectedShot && <ShotInspector shot={selectedShot} project={project} capabilities={capabilities} busy={busy} onChange={patch => edit(p => ({ ...p, shots: p.shots.map(s => s.id === selectedShot.id ? { ...s, ...patch } : s) }))} onDirector={() => { setFrame(selectedShot.startFrame); openDirector(selectedShot.sceneId, selectedShot.cameraId); }} onReview={showReview} onGenerate={() => generateShot(selectedShot)} onUse={(asset) => addToSequence(asset, selectedShot)} />}
          {selectedCard.type === 'image' && selectedAsset?.metadata?.provenance === 'three-scene-capture' && <button className="studio-primary" onClick={() => editCapture(selectedCard.id, selectedAsset.id)}><Box size={15} />回到此帧圈选 3D 对象</button>}
          {selectedCard.type === 'director' && selectedCard.sceneId && <SceneRenderControls sceneId={selectedCard.sceneId} project={project} capabilities={capabilities} busy={busy} onRender={renderScene} />}
          {selectedAsset?.kind === 'video' && <>{isEffectsSource(project, selectedAsset) && <button disabled={busy || project.access?.readOnly} onClick={() => openEffects(selectedAsset)}>模式 4 · Opus 特效员</button>}<button onClick={() => setVersionAssetId(selectedAsset.id)}>查看版本 / 同步对比</button><button disabled={busy || !capabilities?.dlss?.available || project.access?.readOnly || isComparison(selectedAsset)} title={capabilities?.dlss?.reason} onClick={() => enhance(selectedAsset)}>DLSS 5 增强</button>{!capabilities?.dlss?.available && <small>{capabilities?.dlss?.reason || '增强服务尚未就绪'}</small>}</>}
          {selectedAsset && ['video', 'audio'].includes(selectedAsset.kind) && <button className="studio-primary" onClick={() => addToSequence(selectedAsset)}><Plus size={15} />加入当前时间线</button>}
          <button className="studio-danger" onClick={() => { edit(p => ({ ...p, nodes: p.nodes.filter(n => !selectedIds.includes(n.id)), edges: p.edges.filter(e => !selectedIds.includes(e.source) && !selectedIds.includes(e.target)) })); setSelectedIds([]); }}><Trash2 size={15} />移除画布节点</button>
        </aside>}
        {assetLibrary && <aside className="studio-inspector studio-library"><header><b>项目资产</b><button onClick={() => setAssetLibrary(false)}><X size={16} /></button></header><div className="studio-search"><Search size={14} /><input placeholder="搜索素材" value={assetSearch} onChange={e => setAssetSearch(e.target.value)} /></div><button onClick={() => input.current?.click()}><Upload size={15} />上传素材</button><div className="studio-library-grid">{project.assets.filter(a => a.metadata?.role !== 'clean' && a.name.toLowerCase().includes(assetSearch.toLowerCase())).map(asset => <div className="studio-asset-tile" key={asset.id}>{asset.kind === 'image' ? <img src={asset.url} alt={asset.name} /> : asset.kind === 'video' ? <video src={asset.url} preload="metadata" /> : <div>{asset.kind === 'audio' ? <AudioLines size={27} /> : <Box size={27} />}</div>}<b title={asset.name}>{asset.name}</b><small>{asset.kind} · {Math.ceil(asset.bytes / 1024)} KB</small><div className="studio-asset-actions">{['image', 'audio', 'video'].includes(asset.kind) && <button onClick={() => addNode(asset.kind as CanvasNode['type'], asset.id)}>放入画布</button>}{['audio', 'video'].includes(asset.kind) && <button onClick={() => addToSequence(asset)}>放入时间线</button>}<a href={asset.url} download={asset.name}>下载</a>{asset.kind === 'video' && <>{isEffectsSource(project, asset) && <button disabled={busy || project.access?.readOnly} onClick={() => openEffects(asset)}>Opus 特效员</button>}<button onClick={() => setVersionAssetId(asset.id)}>版本对比</button><button disabled={!capabilities?.dlss?.available || busy || project.access?.readOnly || isComparison(asset)} title={capabilities?.dlss?.reason} onClick={() => enhance(asset)}>DLSS 5</button></>}</div></div>)}</div>{!project.assets.length && <p className="studio-muted">上传素材，或在导演台截图创建关键帧。</p>}</aside>}
        {chatOpen && <aside className="studio-chat"><header><Sparkles size={18} /><b>创作助手</b><button onClick={() => setChatOpen(false)}><X size={16} /></button></header><div className="studio-chat-messages">{!chat.length && <div className="studio-chat-intro"><Sparkles size={30} /><h3>把想法变成镜头</h3><p>描述故事，或选中画布素材让我参考。进入导演台后，还可以圈选对象修改白模。</p></div>}{chat.map((m, i) => <div className={`studio-chat-message ${m.role}`} key={i}>{m.text}</div>)}</div><div className="studio-chat-composer">{selectedIds.length > 0 && <small>引用 {selectedIds.length} 个选中节点</small>}<textarea placeholder="例如：把这个故事拆成五个镜头…" value={prompt} onChange={e => setPrompt(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void run(async () => { await ai(prompt); setPrompt(''); }); } }} /><div><span>{capabilities?.llm ? 'Agent 已连接' : '模型服务未配置'}</span><button className="studio-send" aria-label="发送给创作助手" disabled={busy || !prompt.trim()} onClick={() => void run(async () => { await ai(prompt); setPrompt(''); })}>{busy ? <Loader2 className="spin" size={18} /> : <ArrowUp size={18} />}</button></div></div></aside>}
        {!chatOpen && <button className="studio-chat-toggle" onClick={() => { setChatOpen(true); setAssetLibrary(false); }}><Sparkles size={18} />与 AI 对话</button>}
      </div>
      {timelineOpen && <SequenceTimeline sequence={project.sequence} assets={project.assets} minimumFrames={Math.max(1, ...project.shots.map(s => s.endFrame), ...project.scenes.flatMap(s => [...s.clips.map(c => c.endFrame), ...s.tracks.flatMap(t => t.keys.map(k => k.frame + 1))]))} frame={frame} playing={playing} onFrame={setFrame} onPlaying={setPlaying} onChange={sequence => edit(p => ({ ...p, totalFrames: sequence.totalFrames, sequence }))} onError={showError} />}
      {jobs.length > 0 && <div className="studio-jobs"><details><summary>{runningJobs.length ? <Loader2 className="spin" size={13} /> : <Check size={13} />}{runningJobs.length ? `${runningJobs.length} 个任务进行中` : '生成与导出记录'}<ChevronDown size={13} /></summary><div>{jobs.slice(0, 12).map(job => <div className="studio-job" key={job.id}><PipelineJobDetail job={job} project={project} onView={asset => setVersionAssetId(asset.id)} onEnhance={enhance} onEffects={openEffects} onContinueEffects={continueEffects} effectsRender={effectsRenderForPlan(jobs, job)} effectsPending={effectsPending === job.id} onRetry={retryJob} onCancel={cancelJob} onDirector={openDirector} onApply={applySceneJob} canEnhance={!!capabilities?.dlss?.available && !project.access?.readOnly} />{typeof job.output?.warning === 'string' && <p className="studio-job-warning">{job.output.warning}</p>}{job.kind === 'generation' && job.output && <GenerationReceipt output={job.output} assets={project.assets} />}<ArchiveReceipt output={job.output} />{job.outputAssetId && project.assets.find(a => a.id === job.outputAssetId) && <a href={project.assets.find(a => a.id === job.outputAssetId)!.url} target="_blank" rel="noreferrer">播放 / 下载</a>}</div>)}</div></details></div>}
    </>}
    {previewOpen && project && <div className="studio-modal"><div className="studio-modal-card studio-player-modal"><header><b>成片预览</b><span>{frameTime(frame)} / {frameTime(project.sequence.totalFrames)}</span><button onClick={() => { setPreviewOpen(false); setPlaying(false); }}><X size={18} /></button></header><SequencePreview sequence={project.sequence} assets={project.assets} frame={frame} playing={playing} aspect={project.aspect} /><footer><button onClick={() => { if (frame >= project.sequence.totalFrames - 1) setFrame(0); setPlaying(!playing); }}>{playing ? '暂停' : '播放'}</button><input aria-label="成片播放头" type="range" min={0} max={project.sequence.totalFrames - 1} value={frame} onChange={e => { setPlaying(false); setFrame(Number(e.target.value)); }} /><button onClick={exportSequence}><Download size={15} />导出 MP4</button></footer></div></div>}
    {review && <div className="studio-modal"><div className="studio-modal-card studio-review-modal"><header><b>HTML 脚本预览</b><span>确认后才能提交视频生成</span><button onClick={() => setReview(null)}><X size={18} /></button></header><iframe title="待确认脚本" srcDoc={review.html} sandbox="allow-same-origin" /><footer><span>确认绑定当前场景、参考帧和镜头内容。</span><button onClick={() => setReview(null)}>返回修改</button><button className="studio-primary" disabled={busy} onClick={approveReview}><Check size={15} />确认这版脚本</button></footer></div></div>}
    {directorScene && project && <div className="studio-director-modal"><DirectorPanel project={project} sceneId={directorScene} renderControls={project.scenes.find(scene => scene.id === directorScene)?.codeProgram ? <SceneRenderControls sceneId={directorScene} project={project} capabilities={capabilities} busy={busy} onRender={renderScene} /> : undefined} initialShotView={directorView?.shotView} initialCameraId={directorView?.cameraId} initialMode={directorView?.mode} captureReference={directorCapture ? { ...directorCapture, invalidReason: captureReferenceError(project, directorCapture) } : undefined} frame={frame} playing={playing} onFrameChange={setFrame} onPlayingChange={setPlaying} onCommand={onCommand} onHistory={onHistory} onClose={() => { setDirectorScene(undefined); setDirectorView(undefined); setDirectorCapture(undefined); setPlaying(false); }} onAI={(text, context) => ai(text, context)} onImportAsset={async ({ blob, name, metadata }) => uploadAsset(blob, name, 'model', metadata)} onCapture={async ({ blob, name, metadata }) => withLock(async () => { const asset = await uploadAsset(blob, name, 'image', metadata); addNode('image', asset.id); await flush(); setNotice('关键帧已放入画布，可关联到镜头首尾帧'); })} onBake={async ({ blob, name, landmarks, metadata }) => withLock(async () => { const asset = await uploadAsset(blob, name, 'bake', { ...metadata, sceneId: directorScene }); await flush(); const p = current.current!; const job = await studioApi<StudioJob>(`/projects/${p.id}/previews`, { idempotencyKey: studioId(), sceneId: directorScene, bakedAssetId: asset.id, frameStart: Number(metadata?.frameStart ?? 0), frameEnd: Number(metadata?.frameEnd ?? p.totalFrames), resolution: p.aspect === '16:9' ? [960, 540] : [540, 960], landmarks }); setJobs(j => [job, ...j]); setNotice('3D 预演已提交 Blender 渲染'); })} /></div>}
    {effectsDialog && project && effectsDialog.projectId === project.id && <EffectsDialog key={`${project.id}:${effectsDialog.assetId || "choose"}`} project={project} initialAssetId={effectsDialog.assetId} capabilities={capabilities} busy={busy} onClose={() => setEffectsDialog(undefined)} onSubmit={planEffects} />}
    {sceneGenerationOpen && <SceneGenerationDialog capabilities={capabilities} busy={busy} onClose={() => setSceneGenerationOpen(false)} onSubmit={generateScene} />}
    {versionSource && project && <VideoVersions key={`${project.id}:${versionSource.id}`} assets={versionAssets} sourceId={versionSource.id} onClose={() => setVersionAssetId(undefined)} onUse={asset => { try { const p = current.current!; if (p.access?.readOnly) throw new Error('请先复制为我的工程'); if (p.nodes.some(n => n.assetId === versionSource.id) || p.sequence.clips.some(c => c.assetId === versionSource.id)) edit(value => applyVideoVersion(value, versionSource.id, asset.id)); else addNode('video', asset.id); setNotice('已使用所选版本，原视频资产仍保留'); setVersionAssetId(undefined); } catch (error) { showError(error); } }} />}
    <input hidden ref={input} type="file" multiple accept="image/*,video/*,audio/*,.glb" onChange={e => { if (e.target.files) void run(() => uploadFiles(e.target.files!)); e.target.value = ''; }} />
    <input hidden ref={importInput} type="file" accept="application/json,.json" onChange={e => { const file = e.target.files?.[0]; if (file) void run(async () => { await flush(); const value = JSON.parse(await file.text()); acceptServer(await studioApi('/projects/import', Array.isArray(value) ? { videoJobs: value, name: file.name } : value.videoJobs || value.ontology ? { ...value, name: value.name || file.name } : { ontology: value, name: file.name })); await refreshList(); }); e.target.value = ''; }} />
  </main>;
}

function ShotInspector({ shot, project, capabilities, busy, onChange, onDirector, onReview, onGenerate, onUse }: { shot: Shot; project: StudioProject; capabilities: StudioCapabilities | null; busy: boolean; onChange: (patch: Partial<Shot>) => void; onDirector: () => void; onReview: () => void; onGenerate: () => void; onUse: (asset: AssetRevision) => void }) {
  const scene = project.scenes.find(s => s.id === shot.sceneId);
  const textOnly = shot.generationMode === 'text-to-video';
  const textSupported = capabilities?.generationModes?.includes('text-to-video') === true;
  return <><div className="studio-field-row"><label>起帧<input type="number" min={0} value={shot.startFrame} onChange={e => onChange({ startFrame: Math.round(Number(e.target.value)) })} /></label><label>止帧<input type="number" min={1} value={shot.endFrame} onChange={e => onChange({ endFrame: Math.round(Number(e.target.value)) })} /></label></div><label>机位<select value={shot.cameraId} onChange={e => onChange({ cameraId: e.target.value })}>{scene?.cameras.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label><label>镜头主体<select aria-label="镜头主体" multiple value={shot.subjectIds} onChange={e => onChange({ subjectIds: Array.from(e.target.selectedOptions).map(o => o.value) })}>{scene?.objects.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}</select></label><button onClick={onDirector}><Box size={16} />打开此镜头导演台</button><label>画面与运动<textarea rows={5} value={shot.prompt} onChange={e => onChange({ prompt: e.target.value })} /></label><label>生成方式<select aria-label="生成方式" value={shot.generationMode || 'image-to-video'} onChange={e => onChange({ generationMode: e.target.value as Shot['generationMode'], firstAssetId: undefined, lastAssetId: undefined })}><option value="image-to-video">图生视频 · 首帧参考</option><option value="text-to-video" disabled={!textSupported}>文生视频 · 从文字创建</option></select></label>{textOnly ? <div className="studio-capability-note">仅发送文字描述，由模型创建画面与角色。不会发送项目中的人物图片；跨镜外貌需检查。{!textSupported && '当前生成服务暂不支持此模式。'}</div> : (['firstAssetId', 'lastAssetId'] as const).map(key => <label key={key}>{key === 'firstAssetId' ? '首帧参考' : '尾帧目标'}<select value={shot[key] || ''} onChange={e => onChange({ [key]: e.target.value || undefined })}><option value="">未选择</option>{project.assets.filter(a => a.kind === 'image').map(a => <option value={a.id} key={a.id}>{a.name}</option>)}</select></label>)}<label>对白计划<textarea rows={2} value={shot.dialogue || ''} onChange={e => onChange({ dialogue: e.target.value })} /></label><label>画面文字计划<textarea rows={2} value={shot.overlay || ''} onChange={e => onChange({ overlay: e.target.value })} /></label><div className="studio-capability-note">生成接口的参考条件以任务回执为准。对白和动作需要成片验收。</div><button onClick={onReview}><FileText size={15} />查看并确认脚本</button><button className="studio-primary" disabled={busy || (textOnly ? !textSupported : !shot.firstAssetId)} onClick={onGenerate}><Sparkles size={15} />{shot.approval ? '生成这个镜头' : '确认脚本后生成'}</button>{shot.takes.map(take => { const asset = project.assets.find(a => a.id === take.assetId); return asset ? <div className="studio-take" key={take.id}><video controls src={asset.url} preload="metadata" /><small>{take.model} · {take.referenceMode}</small><button onClick={() => { onChange({ selectedTakeId: take.id }); onUse(asset); }}>使用此候选并放入时间线</button></div> : null; })}</>;
}

function GenerationReceipt({ output, assets }: { output: Record<string, unknown>; assets: AssetRevision[] }) {
  const references = (Array.isArray(output.references) ? output.references : []) as Array<{ assetId: string; role: string; hash: string }>;
  const ignored = (Array.isArray(output.ignoredReferences) ? output.ignoredReferences : []) as Array<{ assetId: string }>;
  const parameters = (output.parameters || {}) as Record<string, unknown>;
  return <details className="studio-generation-receipt"><summary>实际生成条件</summary><p>模型：{output.modelReported ? String(output.model) : `${String(output.requestedModel || output.model || '未知')}（供应商未回报实际型号）`}</p><p>{output.referenceMode === 'text_only' ? '文生视频 · 无图片输入' : output.referenceMode === 'first_last_frame' ? '首尾帧参考' : '仅首帧参考'} · {String(parameters.aspect || '')} · 生成 {String(parameters.providerDuration || '—')} 秒 / 剪辑 {Number(parameters.requestedFrames || 0)} 帧</p>{references.map(ref => { const asset = assets.find(a => a.id === ref.assetId); return asset ? <a key={`${ref.role}-${ref.assetId}`} href={asset.url} target="_blank" rel="noreferrer"><img src={asset.url} alt={ref.role === 'last' ? '实际发送尾帧' : '实际发送首帧'} /><span>{ref.role === 'last' ? '尾帧' : '首帧'} · {asset.name}</span></a> : <p key={ref.assetId}>{ref.assetId}</p>; })}{ignored.length > 0 && <p>尾帧目标未发送到此模型，不能作为动作控制保证。</p>}{typeof output.prompt === 'string' && <pre>{output.prompt}</pre>}</details>;
}
function ArchiveReceipt({ output }: { output?: Record<string, unknown> }) {
  const archive = output?.archive as { state?: string; publicUrl?: string; error?: string } | undefined;
  if (!archive || archive.state === 'unconfigured') return null;
  return <p className="studio-archive-status">归档：{({ pending: '等待归档', running: '归档中', complete: '已完成', failed: '暂未完成，本地文件可下载' } as Record<string, string>)[archive.state || ''] || archive.state}{archive.state === 'complete' && archive.publicUrl && <a href={archive.publicUrl} target="_blank" rel="noreferrer">打开归档</a>}</p>;
}
