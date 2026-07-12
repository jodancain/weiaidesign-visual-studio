"use client";

import {
  Archive,
  BadgePlus,
  BookOpen,
  Box,
  ChevronDown,
  Circle,
  Clock3,
  Copy,
  Download,
  ExternalLink,
  FileSearch,
  Film,
  GitBranch,
  Hash,
  ImagePlus,
  Instagram,
  Layers,
  Lightbulb,
  Loader2,
  MapPin,
  MousePointer2,
  PanelRightOpen,
  Pencil,
  Play,
  Plus,
  SendHorizontal,
  Share2,
  Sparkles,
  Square,
  Type,
  Video,
  X,
  Zap,
} from "lucide-react";
import { ChangeEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";

type ApiEnvelope<T = unknown> = {
  status?: number;
  message?: string;
  data?: T;
  detail?: string;
};

type GeneratedImageAsset = {
  id: string;
  image_id?: string;
  index?: number;
  filename?: string;
  prompt?: string;
  aspect_ratio?: string;
  model?: string;
  mode?: string;
  reference_mode?: string;
  mime_type?: string;
  size?: number;
  public_url?: string;
  download_url?: string;
  data_url?: string;
  created_at?: string;
};

type ImageJob = {
  job_id?: string;
  state?: string;
  progress?: number;
  prompt?: string;
  aspect_ratio?: string;
  count?: number;
  image_model?: string;
  reference_count?: number;
  images?: GeneratedImageAsset[];
  errors?: string[];
};

type ImageVideoJob = {
  job_id?: string;
  state?: string;
  progress?: number;
  result_video_url?: string;
  storage_video?: {
    public_url?: string;
    download_url?: string;
  };
  drive_video?: {
    webViewLink?: string;
  };
  error?: string;
};

type ReferenceAsset = {
  id: string;
  name: string;
  dataUrl: string;
  mimeType: string;
  size: number;
};

type EventItem = {
  title: string;
  body: string;
  tone?: "good" | "dark";
};

const aspectOptions = ["1:1", "4:5", "9:16", "16:9", "3:2"] as const;
const countOptions = [1, 2, 4] as const;

const defaultCreativeBrief =
  "为一首中文 R&B 情歌生成 4 张 MV 关键画面：青森的风、错开的日本机票、韩国短暂靠近、门口花束和粉黄蓝三色希望。女主年轻清新，潮流穿搭，画面像雨后晴天。";

const stylePresets = [
  "清新电影感，明亮天空，细腻光影",
  "潮流动画，年轻角色，动作张力",
  "爱死机式未来质感，硬朗材质",
  "高端产品摄影，干净背景，强反光",
  "信息图/流程图，文字清楚，逻辑构图",
  "写实街拍，真实镜头，轻胶片色彩",
];

const skillChips = [
  {
    label: "Seedance 2.0 Video Creation",
    icon: Play,
    tone: "violet",
    prompt: "生成一组可用于图生视频的关键帧，人物要有明确动作，镜头运动丰富但不只推拉。",
  },
  {
    label: "One-shot Video",
    icon: Play,
    tone: "violet",
    prompt: "做一个单镜头短视频分镜：开场、动作、情绪转折和结尾都压缩在一个连续镜头里。",
  },
  {
    label: "Instagram Post",
    icon: Instagram,
    tone: "blue",
    prompt: "生成适合 Instagram 发布的高质感竖图，主体清晰，第一眼有传播钩子。",
  },
  {
    label: "Cross-Platform Repurposer",
    icon: BadgePlus,
    tone: "blue",
    prompt: "把同一个创意重构为多平台视觉资产，保留统一主视觉但改变构图比例。",
  },
  {
    label: "Logo Design",
    icon: Square,
    tone: "orange",
    prompt: "生成简洁现代的品牌标识方案，适合后续延展成视觉系统。",
  },
  {
    label: "UGC: Lifestyle Try-on",
    icon: Box,
    tone: "pink",
    prompt: "生成生活方式 UGC 试用/试穿画面，真实、年轻、像手机拍摄但审美高级。",
  },
  {
    label: "AI Stylist: High-Conversion Looks",
    icon: Sparkles,
    tone: "pink",
    prompt: "生成高转化穿搭/造型画面，人物年轻清爽，画面干净，商品和情绪都明确。",
  },
  {
    label: "All Skills",
    icon: BookOpen,
    tone: "gray",
    prompt: "打开全能创作模式：先理解目标，再生成可继续扩展的视觉方案。",
  },
] as const;

const apiBase = "/api/v1";
const publicApiBase = process.env.NEXT_PUBLIC_API_BASE ?? "https://weiaidesign.com/api/v1";

function unwrap<T>(payload: ApiEnvelope<T> | T): T {
  if (payload && typeof payload === "object" && "data" in payload) {
    return (payload as ApiEnvelope<T>).data as T;
  }
  return payload as T;
}

function formatBytes(value?: number) {
  if (!value) return "-";
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("file read failed"));
    reader.readAsDataURL(file);
  });
}

async function urlToDataUrl(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`图片读取失败：HTTP ${response.status}`);
  const blob = await response.blob();
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("blob read failed"));
    reader.readAsDataURL(blob);
  });
}

export default function Home() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [token, setToken] = useState("");
  const [prompt, setPrompt] = useState("");
  const [brand, setBrand] = useState("Youngtuo Visual，清新、年轻、有故事感，避免廉价网感。");
  const [audience, setAudience] = useState("小红书 / YouTube Shorts / MV 分镜制作");
  const [negativePrompt, setNegativePrompt] = useState("老男人、僵硬脸、糊脸、畸形手、廉价 3D、乱码文字、无关道具、水印");
  const [style, setStyle] = useState(stylePresets[0]);
  const [aspect, setAspect] = useState<(typeof aspectOptions)[number]>("9:16");
  const [count, setCount] = useState<(typeof countOptions)[number]>(4);
  const [references, setReferences] = useState<ReferenceAsset[]>([]);
  const [assets, setAssets] = useState<GeneratedImageAsset[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [events, setEvents] = useState<EventItem[]>([]);
  const [raw, setRaw] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [videoUrl, setVideoUrl] = useState("");
  const [showAgentMenu, setShowAgentMenu] = useState(false);

  const selectedAsset = useMemo(() => assets.find((item) => item.id === selectedId) ?? assets[0], [assets, selectedId]);
  const latestEvent = events[0];
  const effectivePrompt = prompt.trim() || defaultCreativeBrief;

  const composedPrompt = useMemo(
    () =>
      [
        effectivePrompt,
        `风格：${style}`,
        brand.trim() ? `品牌规则：${brand.trim()}` : "",
        audience.trim() ? `发布对象：${audience.trim()}` : "",
        "要求：主体清楚，构图有层次，画面细节丰富，适合继续做图生视频关键帧。",
      ]
        .filter(Boolean)
        .join("\n"),
    [effectivePrompt, style, brand, audience],
  );

  useEffect(() => {
    const savedToken = window.localStorage.getItem("videoApiToken");
    const savedAssets = window.localStorage.getItem("visualCanvasAssets");
    if (savedToken) setToken(savedToken);
    if (savedAssets) {
      try {
        const parsed = JSON.parse(savedAssets) as GeneratedImageAsset[];
        setAssets(parsed.slice(0, 24));
        setSelectedId(parsed[0]?.id ?? "");
      } catch {
        window.localStorage.removeItem("visualCanvasAssets");
      }
    }
  }, []);

  useEffect(() => {
    if (token) window.localStorage.setItem("videoApiToken", token);
  }, [token]);

  useEffect(() => {
    window.localStorage.setItem("visualCanvasAssets", JSON.stringify(assets.slice(0, 24)));
  }, [assets]);

  function pushEvent(item: EventItem) {
    setEvents((items) => [item, ...items].slice(0, 8));
  }

  async function api<T>(path: string, init: RequestInit = {}) {
    if (!token.trim()) throw new Error("需要在 Agent 设置里填写 VIDEO_API_TOKEN");
    const response = await fetch(`${apiBase}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token.trim()}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};
    setRaw(JSON.stringify(payload, null, 2));
    if (!response.ok) {
      throw new Error(payload.detail || payload.message || `HTTP ${response.status}`);
    }
    return unwrap<T>(payload);
  }

  async function runAction<T>(name: string, action: () => Promise<T>) {
    setBusy(name);
    setError("");
    try {
      return await action();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      pushEvent({ title: "请求失败", body: message, tone: "dark" });
      return null;
    } finally {
      setBusy("");
    }
  }

  async function handleFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []).filter((file) => file.type.startsWith("image/"));
    if (!files.length) return;
    const loaded = await Promise.all(
      files.slice(0, 10).map(async (file) => ({
        id: `${file.name}-${file.lastModified}-${file.size}`,
        name: file.name,
        mimeType: file.type || "image/png",
        size: file.size,
        dataUrl: await readFileAsDataUrl(file),
      })),
    );
    setReferences((items) => [...loaded, ...items].slice(0, 10));
    pushEvent({ title: "参考图已加入", body: loaded.map((item) => item.name).join(", "), tone: "good" });
    event.target.value = "";
  }

  async function generateImages(variation = false) {
    await runAction(variation ? "variation" : "images", async () => {
      const variationReference =
        variation && selectedAsset?.public_url
          ? [
              {
                filename: selectedAsset.filename || "selected-image.png",
                mime_type: selectedAsset.mime_type || "image/png",
                b64: await urlToDataUrl(selectedAsset.public_url),
              },
            ]
          : [];
      const data = await api<ImageJob>("/images", {
        method: "POST",
        body: JSON.stringify({
          prompt: variation && selectedAsset ? `${composedPrompt}\n基于选中图片继续重制：${selectedAsset.prompt ?? ""}` : composedPrompt,
          style: `${style}；自动选择最适合的 GPT Image 生成策略`,
          brand,
          audience,
          format: "Lovart-style AI workbench asset",
          negative_prompt: negativePrompt,
          aspect_ratio: aspect,
          n: variation ? 2 : count,
          reference_images: variationReference.length
            ? variationReference
            : references.map((item) => ({
                filename: item.name,
                mime_type: item.mimeType,
                b64: item.dataUrl,
              })),
        }),
      });
      const nextAssets = (data.images ?? []).map((item) => ({
        ...item,
        created_at: new Date().toISOString(),
      }));
      if (!nextAssets.length) throw new Error("没有返回图片");
      setAssets((items) => [...nextAssets, ...items].slice(0, 48));
      setSelectedId(nextAssets[0].id);
      pushEvent({
        title: variation ? "Variation ready" : "Images ready",
        body: `${nextAssets.length} 张 · ${data.image_model ?? "gpt-image"} · ${data.job_id ?? ""}`,
        tone: "good",
      });
    });
  }

  async function sendSelectedToVideo() {
    if (!selectedAsset?.public_url) {
      setError("请先选择一张已生成图片");
      return;
    }
    await runAction("video", async () => {
      const imageDataUrl = await urlToDataUrl(selectedAsset.public_url ?? "");
      const data = await api<ImageVideoJob>("/image-videos", {
        method: "POST",
        body: JSON.stringify({
          video_subject: effectivePrompt,
          prompt: effectivePrompt,
          video_language: "zh-CN",
          video_aspect: aspect,
          video_clip_duration: 8,
          duration: 8,
          total_duration_seconds: 8,
          paragraph_number: 1,
          image_count: 1,
          backend: "gemini",
          image_b64: imageDataUrl,
          first_frame_prompt: selectedAsset.prompt || composedPrompt,
          video_prompt: `${effectivePrompt}\n让人物和环境发生清晰动作，避免只有镜头推拉。`,
        }),
      });
      if (!data.job_id) throw new Error("视频任务未被接受");
      pushEvent({ title: "Video queued", body: data.job_id, tone: "good" });
      for (let index = 0; index < 120; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        const job = await api<ImageVideoJob>(`/image-videos/${encodeURIComponent(data.job_id)}`, { method: "GET" });
        if (job.state === "failed") throw new Error(job.error || "视频任务失败");
        if (job.state === "complete") {
          const url = job.drive_video?.webViewLink || job.storage_video?.public_url || job.storage_video?.download_url || job.result_video_url || "";
          setVideoUrl(url);
          pushEvent({ title: "Video ready", body: url || data.job_id, tone: "good" });
          break;
        }
        if (index % 6 === 0) {
          pushEvent({ title: `Video ${job.state ?? "queued"}`, body: `progress=${job.progress ?? 0}`, tone: "good" });
        }
      }
    });
  }

  async function copyText(value: string) {
    await navigator.clipboard.writeText(value);
    pushEvent({ title: "Copied", body: value, tone: "good" });
  }

  function removeReference(id: string) {
    setReferences((items) => items.filter((item) => item.id !== id));
  }

  function applySkill(promptPatch: string) {
    setPrompt((value) => `${value.trim()}\n${promptPatch}`.trim());
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void generateImages(false);
    }
  }

  return (
    <main className="lovartApp">
      <input ref={fileInputRef} className="hiddenInput" type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={handleFiles} />

      <section className="promoStrip" aria-label="promotion">
        <div className="countdown" aria-label="countdown">
          {["0", "0", ":", "0", "6", ":", "1", "3", ":", "5", "1"].map((item, index) =>
            item === ":" ? (
              <span className="countColon" key={`${item}-${index}`}>
                :
              </span>
            ) : (
              <span className="countTile" key={`${item}-${index}`}>
                {item}
              </span>
            ),
          )}
        </div>
        <p>🎉 Seedream 5.0 Pro is here! Get up to 30 days of unlimited generation, plus up to 50% off upgrades</p>
        <a href="https://weiaidesign.com/api/v1/openapi.json" target="_blank" rel="noreferrer">
          Upgrade Now
        </a>
      </section>

      <section className="workbench">
        <section className="canvasPane" aria-label="visual canvas">
          <header className="canvasTop">
            <div className="titleCluster">
              <button className="roundLogo" aria-label="workspace">
                <Clock3 size={17} />
              </button>
              <strong>Untitled</strong>
              <button className="ghostIcon" aria-label="play">
                <Play size={19} />
              </button>
              <ChevronDown className="tinyChevron" size={16} />
            </div>
            <div className="creditCluster">
              <Zap size={18} fill="currentColor" />
              <span>30</span>
              <button className="blueCredit" aria-label="credits">
                <Clock3 size={17} />
              </button>
            </div>
          </header>

          <div className={`canvasStage ${assets.length ? "filled" : ""}`}>
            {assets.length ? (
              <div className="assetBoard">
                {assets.map((asset) => {
                  const imageUrl = asset.public_url || asset.data_url || "";
                  return (
                    <article className={`assetCard ${selectedAsset?.id === asset.id ? "selected" : ""}`} key={asset.id}>
                      <button className="assetPreview" onClick={() => setSelectedId(asset.id)} aria-label="select generated image">
                        {imageUrl ? <img src={imageUrl} alt={asset.prompt || "generated visual"} /> : <span />}
                      </button>
                      <div className="assetMeta">
                        <span>{asset.aspect_ratio ?? aspect}</span>
                        <button onClick={() => asset.public_url && copyText(asset.public_url)} aria-label="copy image url">
                          <Copy size={15} />
                        </button>
                        <a href={asset.download_url || asset.public_url || "#"} target="_blank" rel="noreferrer" aria-label="open image">
                          <ExternalLink size={15} />
                        </a>
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : (
              <div className="blankHint">
                <span>Get started by typing your idea, or press</span>
                <kbd>C</kbd>
                <span>to chat</span>
              </div>
            )}

            {busy ? (
              <div className="floatingStatus">
                <Loader2 className="spin" size={16} />
                <span>{busy === "video" ? "Generating video..." : "Generating images..."}</span>
              </div>
            ) : latestEvent ? (
              <div className={`floatingStatus ${latestEvent.tone === "dark" ? "danger" : ""}`}>
                <Sparkles size={16} />
                <span>{latestEvent.title}</span>
              </div>
            ) : null}

            {selectedAsset ? (
              <div className="selectionDetails">
                <div>
                  <strong>{selectedAsset.model ?? "gpt-image"}</strong>
                  <span>
                    {selectedAsset.aspect_ratio ?? aspect} · {formatBytes(selectedAsset.size)}
                  </span>
                </div>
                {selectedAsset.public_url ? (
                  <a href={selectedAsset.download_url || selectedAsset.public_url} target="_blank" rel="noreferrer">
                    <Download size={16} />
                  </a>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className="bottomStatus">
            <button aria-label="status circle">
              <Circle size={21} />
            </button>
            <button aria-label="layers">
              <Layers size={21} />
            </button>
            <button aria-label="files">
              <FileSearch size={21} />
            </button>
            <button aria-label="branches">
              <GitBranch size={21} />
            </button>
            <span />
            <b>100%</b>
          </div>

          <nav className="toolDock" aria-label="canvas tools">
            <button className="active" title="Select">
              <MousePointer2 size={31} />
            </button>
            <button title="Pin">
              <MapPin size={25} />
            </button>
            <button title="Upload reference" onClick={() => fileInputRef.current?.click()}>
              <ImagePlus size={25} />
            </button>
            <button title="Grid">
              <Hash size={27} />
            </button>
            <button title="Frame">
              <Square size={26} />
            </button>
            <button title="Pencil">
              <Pencil size={25} />
            </button>
            <button title="Text">
              <Type size={27} />
            </button>
            <i />
            <button title="Generate variation" onClick={() => generateImages(true)} disabled={!selectedAsset || Boolean(busy)}>
              {busy === "variation" ? <Loader2 className="spin" size={24} /> : <ImagePlus size={25} />}
            </button>
            <button title="Image to video" onClick={sendSelectedToVideo} disabled={!selectedAsset || Boolean(busy)}>
              {busy === "video" ? <Loader2 className="spin" size={24} /> : <Video size={25} />}
            </button>
            <button className="notify" title="Generate images" onClick={() => generateImages(false)} disabled={Boolean(busy)}>
              {busy === "images" ? <Loader2 className="spin" size={24} /> : <BadgePlus size={25} />}
            </button>
          </nav>
        </section>

        <aside className="chatPane" aria-label="new chat">
          <header className="chatTop">
            <h1>New chat</h1>
            <div>
              <button aria-label="new">
                <BadgePlus size={20} />
              </button>
              <button aria-label="dropdown">
                <ChevronDown size={16} />
              </button>
              <button aria-label="share">
                <Share2 size={21} />
              </button>
              <button aria-label="open">
                <PanelRightOpen size={24} />
              </button>
            </div>
          </header>

          <section className="skillCenter" aria-label="Lovart skills">
            <h2>Try these Lovart Skills</h2>
            <div className="chipCloud">
              {skillChips.map((chip) => {
                const Icon = chip.icon;
                return (
                  <button key={chip.label} className={`skillChip ${chip.tone}`} onClick={() => applySkill(chip.prompt)}>
                    <Icon size={22} />
                    <span>{chip.label}</span>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="composerDock" aria-label="composer">
            <div className="proBanner">
              <span>
                <Sparkles size={17} fill="currentColor" />
              </span>
              <p>Go Pro. Unlock every model. Create faster.</p>
              <button aria-label="close">
                <X size={17} />
              </button>
            </div>
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={handleComposerKeyDown}
              placeholder='Start with an idea, or type "@" to mention'
            />
            <footer className="composerFooter">
              <button title="Add" onClick={() => fileInputRef.current?.click()}>
                <Plus size={25} />
              </button>
              <button title="Prompt library" onClick={() => copyText(`curl -X POST ${publicApiBase}/images`)}>
                <BookOpen size={25} />
              </button>
              <div className="agentWrap">
                <button className="agentButton" onClick={() => setShowAgentMenu((value) => !value)}>
                  <Clock3 size={23} />
                  <span>Agent</span>
                  <ChevronDown size={16} />
                </button>
                {showAgentMenu ? (
                  <div className="agentMenu">
                    <label>
                      <span>VIDEO_API_TOKEN</span>
                      <input type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="Bearer token" />
                    </label>
                    <label>
                      <span>Style</span>
                      <select value={style} onChange={(event) => setStyle(event.target.value)}>
                        {stylePresets.map((item) => (
                          <option key={item} value={item}>
                            {item}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="inlineOptions">
                      {aspectOptions.map((item) => (
                        <button key={item} className={aspect === item ? "active" : ""} onClick={() => setAspect(item)}>
                          {item}
                        </button>
                      ))}
                    </div>
                    <div className="inlineOptions small">
                      {countOptions.map((item) => (
                        <button key={item} className={count === item ? "active" : ""} onClick={() => setCount(item)}>
                          {item}
                        </button>
                      ))}
                    </div>
                    <label>
                      <span>Brand</span>
                      <input value={brand} onChange={(event) => setBrand(event.target.value)} />
                    </label>
                    <label>
                      <span>Audience</span>
                      <input value={audience} onChange={(event) => setAudience(event.target.value)} />
                    </label>
                    <label>
                      <span>Negative</span>
                      <input value={negativePrompt} onChange={(event) => setNegativePrompt(event.target.value)} />
                    </label>
                    {references.length ? (
                      <div className="referenceList">
                        {references.map((item) => (
                          <button key={item.id} onClick={() => removeReference(item.id)} title="Remove reference">
                            <img src={item.dataUrl} alt={item.name} />
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
              <span className="footerSpacer" />
              <button title="Ideas">
                <Lightbulb size={25} />
              </button>
              <button title="Assets">
                <Archive size={25} />
              </button>
              <button className="sendButton" title="Generate" onClick={() => generateImages(false)} disabled={Boolean(busy)}>
                {busy === "images" ? <Loader2 className="spin" size={25} /> : <SendHorizontal size={25} />}
              </button>
            </footer>
          </section>
        </aside>
      </section>

      {error ? <div className="errorToast">{error}</div> : null}
      {videoUrl ? (
        <a className="videoToast" href={videoUrl} target="_blank" rel="noreferrer">
          <Film size={17} />
          Open video result
        </a>
      ) : null}
      {raw ? <span className="rawReady" title={raw}>JSON</span> : null}
    </main>
  );
}
