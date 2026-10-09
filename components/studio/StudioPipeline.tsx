'use client';
import { useState } from 'react';
import { Box, Loader2, Sparkles, X } from 'lucide-react';
import type { AssetRevision, StudioCapabilities, StudioJob, StudioProject } from '../../lib/studio/types';
import { isComparison, isEffectsSource, effectsSources, effectsSourceGroups, effectsSourceLabel, canResumeEffectsHandoff, jobAssetIds, jobLabels, jobStateLabels, jobStageLabel, renderBackends, type ExportChoice } from '../../lib/studio/pipeline';
import type { FilmId } from '../../lib/studio/code-scene/schema';

export function SceneGenerationDialog({ capabilities, busy, onClose, onSubmit }: { capabilities: StudioCapabilities | null; busy: boolean; onClose: () => void; onSubmit: (film: FilmId, prompt: string) => Promise<void> }) {
  const [prompt, setPrompt] = useState('');
  const [film, setFilm] = useState<FilmId>('three-knocks');
  return <div className="studio-modal" role="dialog" aria-modal="true" aria-label="代码场景动画"><div className="studio-modal-card studio-code-dialog">
    <header><Box size={19} /><b>模式 3 · 代码动画</b><button onClick={onClose} aria-label="关闭代码场景"><X size={18} /></button></header>
    <div className="studio-code-body"><p>Claude Opus 5.5 根据故事模板安排镜头和节奏，创建可编辑的风格化 3D 场景。模型、镜头与动作只生成一次，随后可用 Three 或 Remotion 导出同一场景。</p>
      <label>故事模板<select aria-label="代码故事模板" value={film} onChange={e => setFilm(e.target.value as FilmId)}><option value="three-knocks">三下敲门</option><option value="borrow-sunshine">借你一块晴天</option><option value="last-seed-of-light">最后一颗光种</option></select></label>
      <label>镜头与节奏调整<textarea aria-label="代码场景描述" rows={6} value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="可留空保留故事；例如拉近关键动作、延缓递伞动作、调整机位与角色走位。" /></label>
      <small>将新建独立 60 秒工程，保留当前工程。支持这三个故事及其既定动作，每片 10 镜 × 6 秒。音轨默认无旁白；完成后可进入导演台编辑。</small>
      {!capabilities?.sceneGeneration?.available && <p role="status">{capabilities?.sceneGeneration?.reason || '正在检查代码场景服务…'}</p>}
    </div><footer><button className="studio-primary" disabled={busy || !capabilities?.sceneGeneration?.available} onClick={() => void onSubmit(film, prompt.trim() || '保留完整故事和动作，设计清楚连贯的镜头与节奏。')}>{busy ? <Loader2 className="spin" size={16} /> : <Sparkles size={16} />}生成可编辑场景</button></footer>
  </div></div>;
}

export function SceneRenderControls({ sceneId, project, capabilities, busy, onRender }: { sceneId: string; project: StudioProject; capabilities: StudioCapabilities | null; busy: boolean; onRender: (sceneId: string, choice: ExportChoice) => void }) {
  const [choice, setChoice] = useState<ExportChoice>('three');
  const supported = !!project.scenes.find(scene => scene.id === sceneId)?.codeProgram;
  const timingMatches = project.totalFrames === 1440 && project.aspect === '16:9';
  const unavailable = renderBackends(choice).map(backend => capabilities?.renderers?.[backend]).find(capability => !capability?.available);
  const available = supported && timingMatches && renderBackends(choice).every(backend => capabilities?.renderers?.[backend]?.available);
  return <div className="studio-scene-render"><label>导出工具<select aria-label="场景导出工具" value={choice} onChange={e => setChoice(e.target.value as ExportChoice)}><option value="three">Three · 默认</option><option value="remotion">Remotion</option><option value="both">同场景双导出</option></select></label><button className="studio-primary" disabled={busy || !available || project.access?.readOnly} onClick={() => onRender(sceneId, choice)}>渲染成片</button><small>{!supported ? '代码场景支持此导出；普通场景请使用导演台的烘焙预演。' : !timingMatches ? '此代码故事需要 60 秒、16:9 画幅，请还原工程设置。' : available ? '共享模型、镜头和动作；保留每个导出版本。' : unavailable?.reason || '渲染服务尚未就绪'}</small></div>;
}

export function PipelineJobDetail({ job, project, onView, onEnhance, onEffects, onContinueEffects, effectsRender, effectsPending, onRetry, onCancel, onDirector, onApply, canEnhance }: { job: StudioJob; project: StudioProject; onView: (asset: AssetRevision) => void; onEnhance: (asset: AssetRevision) => void; onEffects: (asset: AssetRevision) => void; onContinueEffects: (job: StudioJob) => void; effectsRender?: StudioJob; effectsPending?: boolean; onRetry: (job: StudioJob) => void; onCancel: (job: StudioJob) => void; onDirector: (id?: string) => void; onApply: (job: StudioJob) => void; canEnhance: boolean }) {
  const assets = jobAssetIds(job).flatMap(id => { const asset = project.assets.find(a => a.id === id); return asset && asset.metadata?.role !== 'clean' ? [asset] : []; });
  const sceneId = project.scenes.find(scene => scene.codeGenerationJobId === job.id)?.id || (typeof job.output?.sceneId === 'string' ? job.output.sceneId : undefined);
  const effectsSource = project.assets.find(asset => asset.id === job.sourceAssetId);
  return <><span>{jobLabels[job.kind] || job.kind}{job.backend && ` · ${job.backend === 'remotion' ? 'Remotion' : 'Three'}`}</span><small>{jobStateLabels[job.state]}{job.state === 'running' && ` ${Math.round(job.progress * 100)}%`}</small>
    {job.stage && <div className="studio-job-stage">阶段：{jobStageLabel(job.stage)}</div>}
    {job.stages?.map(stage => <div className="studio-job-stage" key={stage.id}>{jobStageLabel(stage.label || stage.id)} · {jobStateLabels[stage.state]}{stage.error && <span>{stage.error}</span>}</div>)}
    {job.waitingReason && <p>{job.waitingReason}</p>}
    {job.cancellationTooLate && <p>任务完成早于取消，已保留原任务结果。</p>}
    {job.error && <p>{job.error}</p>}
    {job.state === 'failed' && assets.length > 0 && <p>已完成阶段的素材已保留，可以直接查看。</p>}
    {sceneId && project.scenes.some(scene => scene.id === sceneId) && <button onClick={() => onDirector(sceneId)}>进入生成场景</button>}
    {job.kind === 'scene-generation' && job.state === 'complete' && !!job.output?.sceneProgram && !sceneId && <button disabled={project.access?.readOnly} onClick={() => onApply(job)}>应用到导演台</button>}
    {job.kind === 'effects-plan' && job.output?.effectsProgram != null && <EffectsPlanSummary program={job.output.effectsProgram} sourceName={effectsSource && effectsSourceLabel(project, effectsSource)} />}
    {job.kind === 'effects-plan' && job.state === 'complete' && <div className="studio-job-stage">{effectsRender ? `合成任务：${jobStateLabels[effectsRender.state]}` : job.renderJobId || job.output?.renderJobId ? '合成任务已创建，正在同步记录…' : effectsPending ? '计划已完成，正在提交合成…' : <button disabled={project.access?.readOnly} onClick={() => onContinueEffects(job)}>继续制作特效版</button>}</div>}
    {assets.map(asset => <div className="studio-job-output" key={asset.id}><span>{asset.name}</span>{asset.kind === 'video' && <><button onClick={() => onView(asset)}>查看版本</button><button disabled={!canEnhance || isComparison(asset)} onClick={() => onEnhance(asset)}>DLSS 5</button>{isEffectsSource(project, asset) && <button disabled={project.access?.readOnly} onClick={() => onEffects(asset)}>Opus 特效员</button>}</>}<a href={asset.url} download={asset.name}>下载</a></div>)}
    {canResumeEffectsHandoff(job) ? <button onClick={() => onRetry(job)}>恢复后续合成</button> : job.retryable && job.state === 'failed' && <button onClick={() => onRetry(job)}>恢复失败阶段</button>}
    {job.cancellable && (['queued', 'running'].includes(job.state) || job.kind === 'effects-plan' && job.state === 'complete') && <button onClick={() => onCancel(job)}>{job.kind === 'effects-plan' && job.state === 'complete' ? '取消后续合成' : '取消任务'}</button>}
  </>;
}

const effectsPresets = [
  { name: '柔光氛围', prompt: '加入克制的柔光辉光与暖色氛围，保留原画面主体、字幕和全部声音。' },
  { name: '能量光效', prompt: '在动作重点处加入短促的光晕和闪光，避免遮挡角色与字幕，不改变时长和声音。' },
  { name: '雨雾氛围', prompt: '加入轻柔的雨丝、薄雾和克制暗角，保留主体、字幕、原时长和音轨。' },
];

export function EffectsDialog({ project, initialAssetId, capabilities, busy, onClose, onSubmit }: { project: StudioProject; initialAssetId?: string; capabilities: StudioCapabilities | null; busy: boolean; onClose: () => void; onSubmit: (asset: AssetRevision, prompt: string) => Promise<void> }) {
  const eligible = effectsSources(project);
  // Keep the chosen hash frozen while the dialog is open. Background refreshes must
  // never silently substitute another version before submission.
  const [source, setSource] = useState<AssetRevision | undefined>(() => initialAssetId ? eligible.find(asset => asset.id === initialAssetId) : eligible[0]);
  const [prompt, setPrompt] = useState('');
  const current = project.assets.find(asset => asset.id === source?.id);
  const valid = !!source && current?.hash === source.hash && isEffectsSource(project, current);
  const canSubmit = valid && !!prompt.trim() && !busy && !project.access?.readOnly && !!capabilities?.effects?.available;
  return <div className="studio-modal" role="dialog" aria-modal="true" aria-label="模式 4 · Opus 特效员"><div className="studio-modal-card studio-code-dialog studio-effects-dialog">
    <header><Sparkles size={19} /><b>模式 4 · Opus 特效员</b><button onClick={onClose} aria-label="关闭特效员"><X size={18} /></button></header>
    <div className="studio-code-body"><p>为 AI 视频模型生成的成片添加后期特效。Claude Opus 5.5 根据选定原片编排效果，计划完成后自动合成新版本；也兼容代码动画。</p>
      <label>源视频版本<select aria-label="特效源视频" value={source?.id || ''} onChange={event => setSource(eligible.find(asset => asset.id === event.target.value))} disabled={busy}><option value="" disabled>选择 AI 原版或其他可信视频</option>{effectsSourceGroups.map(group => {
        const assets = eligible.filter(asset => asset.effectsSource?.kind === group.kind);
        return assets.length > 0 && <optgroup key={group.kind} label={group.label}>{assets.map(asset => <option key={asset.id} value={asset.id}>{effectsSourceLabel(project, asset)}</option>)}</optgroup>;
      })}</select></label>
      <small>默认优先 AI 原版；从素材或画布指定版本时保留你的选择。派生版本会继续叠加效果。</small>
      {source && <div className="studio-effects-source"><video controls playsInline preload="metadata" src={source.url} aria-label="特效源视频预览" /><small>使用此版本：{effectsSourceLabel(project, source)} · {Number(source.metadata?.frames || 0) > 0 ? `${Number(source.metadata?.frames)} 帧` : '保持源片帧长'}</small></div>}
      <div className="studio-effects-presets" role="group" aria-label="特效描述预设">{effectsPresets.map(preset => <button key={preset.name} disabled={busy} onClick={() => setPrompt(preset.prompt)}>{preset.name}</button>)}</div>
      <label>效果描述<textarea aria-label="特效描述" rows={4} maxLength={4000} value={prompt} onChange={event => setPrompt(event.target.value)} placeholder="描述哪些时段需要什么光效、色调或画面装饰…" /></label>
      <small>支持辉光、粒子、雨、雾、光环、光迹、暗角。保留所选源片、帧长与音轨，默认不加旁白、不覆盖剪辑。使用受控合成器，并非 Adobe After Effects，不提供自动抠像或目标追踪。</small>
      {!eligible.length && <p role="status">当前工程没有可验证来源的视频。请先生成 AI 视频，或打开含可信成片的工程；代码动画也可使用。</p>}
      {initialAssetId && !source && eligible.length > 0 && <p role="alert">指定的视频来源不可用，请明确选择另一个版本。</p>}
      {source && !valid && <p role="alert">源视频版本已变更，请重新选择后再提交。</p>}
      {project.access?.readOnly && <p role="status">此示例只读，请先复制为我的工程。</p>}
      {!capabilities?.effects?.available && <p role="status">{capabilities?.effects?.reason || '正在检查特效服务…'}</p>}
    </div><footer><span>计划与合成进度会保存在任务记录中。</span><button className="studio-primary" disabled={!canSubmit} onClick={() => { if (source) void onSubmit(source, prompt.trim()); }}>{busy ? <Loader2 className="spin" size={16} /> : <Sparkles size={16} />}制作特效版</button></footer>
  </div></div>;
}

export function EffectsPlanSummary({ program, sourceName }: { program: unknown; sourceName?: string }) {
  const data = program && typeof program === 'object' ? program as Record<string, unknown> : {};
  const effects = Array.isArray(data.layers) ? data.layers : [];
  const names: Record<string, string> = { glow: '辉光', particles: '粒子', rain: '雨', fog: '雾', ring: '光环', 'light-trail': '光迹', vignette: '暗角' };
  return <details className="studio-effects-plan"><summary>结构化特效计划 · {effects.length} 层</summary>{sourceName && <div>源版本：{sourceName}</div>}{Number.isInteger(data.totalFrames) && <div>{Number(data.totalFrames)} 帧 · 24 fps · {(Number(data.totalFrames) / 24).toFixed(2)} 秒</div>}<ul>{effects.map((effect, index) => { const item = effect && typeof effect === 'object' ? effect as Record<string, unknown> : {}; return <li key={index}><b>{names[String(item.type)] || String(item.type || '效果')}</b>{Number.isInteger(item.startFrame) && Number.isInteger(item.endFrame) && <span> · {(Number(item.startFrame) / 24).toFixed(2)}–{(Number(item.endFrame) / 24).toFixed(2)} 秒（止帧不含）</span>}{typeof item.description === 'string' && <div>{item.description}</div>}</li>; })}</ul><small>保护底部字幕区域；源视频、帧长与音轨保持。</small></details>;
}
