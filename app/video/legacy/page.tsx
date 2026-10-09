"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Clapperboard, ImagePlus, Loader2, Palette, Sparkles, X } from "lucide-react";

const API_BASE = "/api/v1";

type VideoJob = {
  id: string;
  subject: string;
  ts: number;
  state: "running" | "done" | "failed";
  url?: string;
  error?: string;
  /** "story" = keyframes rendered from the fixed Blender scene, then restyled */
  mode?: "image" | "story";
  keyframeSource?: string;
  shotSpecs?: Array<{ index: number; camera: string; pose_id: string; character_anchor: string }>;
  stage?: string;
};

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

export default function VideoPage() {
  const [imageDataUrl, setImageDataUrl] = useState("");
  const [subject, setSubject] = useState("");
  const [aspect, setAspect] = useState<"16:9" | "9:16">("16:9");
  const [mode, setMode] = useState<"image" | "story">("image");
  const [storyAvailable, setStoryAvailable] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [jobs, setJobs] = useState<VideoJob[]>([]);
  const [historyReady, setHistoryReady] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const pollersRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("videoJobs") || "[]");
      if (!Array.isArray(saved)) throw new Error('invalid history');
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Hydrate browser-only history after SSR so the initial server/client trees match.
      setJobs(saved);
      setHistoryReady(true);
    } catch {
      setJobs([]);
    }
  }, []);

  useEffect(() => {
    if (historyReady) localStorage.setItem("videoJobs", JSON.stringify(jobs.slice(0, 30)));
  }, [jobs, historyReady]);

  /* Story Mode is only offered when the upstream gateway reports a Blender worker */
  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch(`${API_BASE}/health`);
        const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        setStoryAvailable(Boolean(data.story_mode_available));
      } catch {
        setStoryAvailable(false);
      }
    })();
  }, []);

  const updateJob = useCallback((id: string, patch: Partial<VideoJob>) => {
    setJobs((prev) => prev.map((job) => (job.id === id ? { ...job, ...patch } : job)));
  }, []);

  const pollJob = useCallback(
    (jobId: string) => {
      if (pollersRef.current.has(jobId)) return;
      pollersRef.current.add(jobId);
      void (async () => {
        for (let attempt = 0; attempt < 150; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 5000));
          try {
            const response = await fetch(`${API_BASE}/image-videos/${jobId}`);
            const payload = (await response.json().catch(() => ({}))) as { data?: Record<string, unknown> };
            const data = (payload.data || payload || {}) as Record<string, unknown>;
            const drive = (data.drive_video as { webViewLink?: string } | undefined)?.webViewLink;
            const storage = (data.storage_video as { public_url?: string } | undefined)?.public_url;
            if (drive || storage) {
              updateJob(jobId, { state: "done", url: String(storage || drive) });
              return;
            }
            const state = String(data.state ?? "");
            const patch: Partial<VideoJob> = { stage: state || undefined };
            if (typeof data.keyframe_source === "string") patch.keyframeSource = data.keyframe_source;
            if (Array.isArray(data.shot_specs)) patch.shotSpecs = data.shot_specs as VideoJob["shotSpecs"];
            if (patch.stage || patch.keyframeSource || patch.shotSpecs) updateJob(jobId, patch);
            if (state === "failed" || state === "error") {
              updateJob(jobId, { state: "failed", error: String(data.error || "生成失败") });
              return;
            }
          } catch {
            /* transient */
          }
        }
        updateJob(jobId, { state: "failed", error: "轮询超时，任务可能仍在后台执行" });
      })();
    },
    [updateJob],
  );

  /* 恢复历史 running 任务的轮询 */
  useEffect(() => {
    for (const job of jobs) if (job.state === "running") pollJob(job.id);
  }, [jobs, pollJob]);

  const onPickFile = useCallback((file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setImageDataUrl(String(reader.result));
    reader.readAsDataURL(file);
  }, []);

  const story = mode === "story";
  const canSubmit = Boolean(subject.trim()) && !busy && (story || Boolean(imageDataUrl));

  const submit = useCallback(async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`${API_BASE}/image-videos`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          story
            ? { video_subject: subject.trim(), video_aspect: aspect, video_language: "zh-CN", story_mode: true, duration: 5 }
            : { video_subject: subject.trim(), video_aspect: aspect, first_image_b64: imageDataUrl, video_clip_duration: 8 },
        ),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        detail?: string;
        data?: { image_job_id?: string; job_id?: string };
      } & { image_job_id?: string; job_id?: string };
      if (!response.ok) throw new Error(payload?.detail || `提交失败 ${response.status}`);
      const data = (payload.data || payload) as { image_job_id?: string; job_id?: string };
      const jobId = String(data.image_job_id || data.job_id || "");
      if (!jobId) throw new Error("视频任务创建失败：无 job id");
      setJobs((prev) => [{ id: jobId, subject: subject.trim(), ts: Date.now(), state: "running" as const, mode }, ...prev]);
      pollJob(jobId);
      setSubject("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [aspect, canSubmit, imageDataUrl, mode, pollJob, story, subject]);

  return (
    <main className="videoPage">
      <header className="videoTop">
        <Link className="logoBadge" href="/" title="回到图片工作台">
          <span>Lō</span>
        </Link>
        <h1>
          <Clapperboard size={18} /> 图生视频
        </h1>
        <Link className="videoNavLink" href="/">
          <Palette size={14} /> 图片工作台
        </Link>
      </header>

      <section className="videoComposer">
        <div className="videoModeTabs" role="tablist" aria-label="视频模式">
          <button type="button" role="tab" aria-selected={mode === "image"} className={mode === "image" ? "on" : ""} onClick={() => setMode("image")}>
            <ImagePlus size={13} /> 图生视频
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "story"}
            className={mode === "story" ? "on" : ""}
            disabled={storyAvailable === false}
            title={storyAvailable === false ? "后端未配置 Blender 故事 worker" : "由固定 3D 场景摆姿势出关键帧，再重绘成写实并生成视频"}
            onClick={() => setMode("story")}
          >
            <Sparkles size={13} /> 故事模式
          </button>
        </div>

        {story ? (
          <div className="videoStoryHint">
            <p>不需要上传图片。写一句故事或情绪转折，AI 会从固定仓库场景里选<strong>镜头 · 姿势 · 站位</strong>渲出关键帧，重绘成写实后交给 Seedance 生成。</p>
            <em>例：一个独自练舞的年轻女孩，在空旷仓库里从犹豫到全力舒展的瞬间</em>
          </div>
        ) : null}

        <div
          className="videoDrop"
          hidden={story}
          onClick={() => fileRef.current?.click()}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            onPickFile(event.dataTransfer.files?.[0]);
          }}
        >
          {imageDataUrl ? (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={imageDataUrl} alt="first frame" />
              <button
                type="button"
                className="videoDropClear"
                onClick={(event) => {
                  event.stopPropagation();
                  setImageDataUrl("");
                }}
              >
                <X size={12} />
              </button>
            </>
          ) : (
            <div className="videoDropHint">
              <ImagePlus size={22} />
              <p>点击或拖入首帧图片</p>
              <em>在图片工作台生成的图可先导出 PNG 再拖到这里</em>
            </div>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(event) => onPickFile(event.target.files?.[0] || undefined)}
          />
        </div>

        <textarea
          value={subject}
          onChange={(event) => setSubject(event.target.value)}
          placeholder={
            story
              ? "描述故事与情绪转折，例如：她在仓库里先是迟疑收着动作，随后下定决心，身体完全打开"
              : "描述视频运动与内容，例如：镜头缓慢推近，招牌上的字微微发光，树叶随风轻摆"
          }
        />

        <div className="videoControls">
          <div className="videoAspect">
            {(["16:9", "9:16"] as const).map((value) => (
              <button
                key={value}
                type="button"
                className={aspect === value ? "on" : ""}
                onClick={() => setAspect(value)}
              >
                {value}
              </button>
            ))}
          </div>
          <button className="darkButton" type="button" disabled={!canSubmit} onClick={() => void submit()}>
            {busy ? <Loader2 className="spin" size={14} /> : null} {story ? "生成故事视频" : "提交视频任务"}
          </button>
        </div>
        {error ? <p className="videoError">{error}</p> : null}
        <p className="videoNote">视频由后台管线生成（约 3-10 分钟），提交后可离开页面，回来自动续查。</p>
      </section>

      <section className="videoJobs">
        {jobs.length === 0 ? <p className="videoEmpty">还没有视频任务</p> : null}
        {jobs.map((job) => (
          <article key={job.id} className="videoJobCard">
            <div className="videoJobMeta">
              <strong>
                {job.mode === "story" ? <span className="videoModeBadge"><Sparkles size={11} /> 故事</span> : null}
                {job.subject}
              </strong>
              <span>
                {new Date(job.ts).toLocaleString("zh-CN", { hour12: false })} · {job.id.slice(0, 18)}
              </span>
            </div>
            {job.shotSpecs?.length ? (
              <ul className="videoShotList">
                {job.shotSpecs.map((shot) => (
                  <li key={shot.index}>
                    <b>#{shot.index}</b> {shot.camera} · {shot.pose_id} · {shot.character_anchor}
                  </li>
                ))}
              </ul>
            ) : null}
            {job.keyframeSource ? (
              <p className="videoKeyframeSource">
                关键帧：{job.keyframeSource === "blender-greybox+gpt-restyle" ? "3D 灰模 + 重绘" : job.keyframeSource === "gpt-image-fallback" ? "已降级为文生图" : job.keyframeSource}
              </p>
            ) : null}
            {job.state === "running" ? (
              <p className="videoJobState running">
                <Loader2 className="spin" size={13} /> 生成中…{job.stage ? ` (${job.stage})` : ""}
              </p>
            ) : null}
            {job.state === "failed" ? <p className="videoJobState failed">{job.error || "失败"}</p> : null}
            {job.state === "done" && job.url ? (
              <video src={job.url} controls playsInline preload="metadata" />
            ) : null}
            {job.state === "done" && job.url ? (
              <a className="videoLink" href={job.url} target="_blank" rel="noreferrer">
                打开原始链接
              </a>
            ) : null}
          </article>
        ))}
      </section>
    </main>
  );
}
