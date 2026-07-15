"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Clapperboard, ImagePlus, Loader2, Palette, X } from "lucide-react";

const API_BASE = "/api/v1";

type VideoJob = {
  id: string;
  subject: string;
  ts: number;
  state: "running" | "done" | "failed";
  url?: string;
  error?: string;
};

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

export default function VideoPage() {
  const [imageDataUrl, setImageDataUrl] = useState("");
  const [subject, setSubject] = useState("");
  const [aspect, setAspect] = useState<"16:9" | "9:16">("16:9");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [jobs, setJobs] = useState<VideoJob[]>([]);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const pollersRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    try {
      setJobs(JSON.parse(localStorage.getItem("videoJobs") || "[]"));
    } catch {
      setJobs([]);
    }
  }, []);

  useEffect(() => {
    localStorage.setItem("videoJobs", JSON.stringify(jobs.slice(0, 30)));
  }, [jobs]);

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

  const submit = useCallback(async () => {
    if (!imageDataUrl || !subject.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`${API_BASE}/image-videos`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          video_subject: subject.trim(),
          video_aspect: aspect,
          first_image_b64: imageDataUrl,
          video_clip_duration: 8,
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        detail?: string;
        data?: { image_job_id?: string; job_id?: string };
      } & { image_job_id?: string; job_id?: string };
      if (!response.ok) throw new Error(payload?.detail || `提交失败 ${response.status}`);
      const data = (payload.data || payload) as { image_job_id?: string; job_id?: string };
      const jobId = String(data.image_job_id || data.job_id || "");
      if (!jobId) throw new Error("视频任务创建失败：无 job id");
      setJobs((prev) => [{ id: jobId, subject: subject.trim(), ts: Date.now(), state: "running" as const }, ...prev]);
      pollJob(jobId);
      setSubject("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [aspect, busy, imageDataUrl, pollJob, subject]);

  return (
    <main className="videoPage">
      <header className="videoTop">
        <a className="logoBadge" href="/" title="回到图片工作台">
          <span>Lō</span>
        </a>
        <h1>
          <Clapperboard size={18} /> 图生视频
        </h1>
        <a className="videoNavLink" href="/">
          <Palette size={14} /> 图片工作台
        </a>
      </header>

      <section className="videoComposer">
        <div
          className="videoDrop"
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
          placeholder="描述视频运动与内容，例如：镜头缓慢推近，招牌上的字微微发光，树叶随风轻摆"
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
          <button className="darkButton" type="button" disabled={!imageDataUrl || !subject.trim() || busy} onClick={() => void submit()}>
            {busy ? <Loader2 className="spin" size={14} /> : null} 提交视频任务
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
              <strong>{job.subject}</strong>
              <span>
                {new Date(job.ts).toLocaleString("zh-CN", { hour12: false })} · {job.id.slice(0, 18)}
              </span>
            </div>
            {job.state === "running" ? (
              <p className="videoJobState running">
                <Loader2 className="spin" size={13} /> 生成中…
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
