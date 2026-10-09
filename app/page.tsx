"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ArrowUp,
  AudioLines,
  BookOpen,
  Brain,
  ChevronDown,
  Circle,
  Clapperboard,
  Cloud,
  CloudCheck,
  CloudOff,
  CloudUpload,
  Copy,
  Download,
  FileSearch,
  GitBranch,
  Hash,
  History,
  Images,
  Layers,
  LayoutGrid,
  Lightbulb,
  Loader2,
  MapPin,
  MousePointer2,
  Palette,
  PanelRightOpen,
  Pencil,
  Plus,
  Share2,
  Sparkles,
  Spline,
  SquarePen,
  SquarePlay,
  Squircle,
  Store,
  Type,
  Wand2,
  X,
  Network,
  Zap,
} from "lucide-react";
import {
  AssetRecordType,
  DefaultColorStyle,
  DefaultFontStyle,
  DefaultSizeStyle,
  Tldraw,
  createShapeId,
  exportToBlob,
  getSnapshot,
  loadSnapshot,
  toRichText,
  useValue,
  type Editor,
  type TLAssetId,
  type TLShapeId,
} from "tldraw";
import "tldraw/tldraw.css";

/* ------------------------------------------------------------------ */
/* constants                                                           */
/* ------------------------------------------------------------------ */

const API_BASE = "/api/v1";
const AGENT_MAX_ROUNDS = 6;

/** Chinese OFL fonts (subset woff2) mapped onto all 16 tldraw font slots. */
const FONT_DRAW_URL = "/fonts/lxgw-wenkai.woff2";
const FONT_SANS_URL = "/fonts/source-han-sans.woff2";
const FONT_SERIF_URL = "/fonts/source-han-serif.woff2";
const FONT_MONO_URL = "/fonts/smiley-sans.woff2";
const FONT_ASSET_URLS = {
  fonts: {
    tldraw_draw: FONT_DRAW_URL,
    tldraw_draw_bold: FONT_DRAW_URL,
    tldraw_draw_italic: FONT_DRAW_URL,
    tldraw_draw_italic_bold: FONT_DRAW_URL,
    tldraw_sans: FONT_SANS_URL,
    tldraw_sans_bold: FONT_SANS_URL,
    tldraw_sans_italic: FONT_SANS_URL,
    tldraw_sans_italic_bold: FONT_SANS_URL,
    tldraw_serif: FONT_SERIF_URL,
    tldraw_serif_bold: FONT_SERIF_URL,
    tldraw_serif_italic: FONT_SERIF_URL,
    tldraw_serif_italic_bold: FONT_SERIF_URL,
    tldraw_mono: FONT_MONO_URL,
    tldraw_mono_bold: FONT_MONO_URL,
    tldraw_mono_italic: FONT_MONO_URL,
    tldraw_mono_italic_bold: FONT_MONO_URL,
  },
} as const;

type BrandKit = {
  name: string;
  palette: string[];
  styleWords: string;
  logoRef: string;
  fontHint: string;
};

const EMPTY_BRAND_KIT: BrandKit = { name: "", palette: [], styleWords: "", logoRef: "", fontHint: "" };

type DesignMemory = {
  enabled: boolean;
  profile: string;
  brands: string;
  visualStyle: string;
  logoRules: string;
  collaborationRules: string;
  workflow: string;
  avoid: string;
  updatedAt: number;
};

const DESIGN_MEMORY_STORAGE_KEY = "weiaiDesignMemoryV1";
const EMPTY_DESIGN_MEMORY: DesignMemory = {
  enabled: false,
  profile: "",
  brands: "",
  visualStyle: "",
  logoRules: "",
  collaborationRules: "",
  workflow: "",
  avoid: "",
  updatedAt: 0,
};

function normalizeDesignMemory(raw: unknown): DesignMemory {
  const value = raw && typeof raw === "object" ? (raw as Partial<DesignMemory>) : {};
  return {
    enabled: Boolean(value.enabled),
    profile: String(value.profile || "").slice(0, 4000),
    brands: String(value.brands || "").slice(0, 4000),
    visualStyle: String(value.visualStyle || "").slice(0, 4000),
    logoRules: String(value.logoRules || "").slice(0, 4000),
    collaborationRules: String(value.collaborationRules || "").slice(0, 4000),
    workflow: String(value.workflow || "").slice(0, 4000),
    avoid: String(value.avoid || "").slice(0, 4000),
    updatedAt: Number(value.updatedAt) || 0,
  };
}

function designMemoryToPromptText(memory: DesignMemory): string {
  if (!memory.enabled) return "";
  const sections = [
    memory.profile.trim() ? `设计身份与目标：${memory.profile.trim()}` : "",
    memory.brands.trim() ? `品牌与项目：${memory.brands.trim()}` : "",
    memory.visualStyle.trim() ? `长期视觉偏好：${memory.visualStyle.trim()}` : "",
    memory.logoRules.trim() ? `Logo 规则：${memory.logoRules.trim()}` : "",
    memory.collaborationRules.trim() ? `联名与规范：${memory.collaborationRules.trim()}` : "",
    memory.workflow.trim() ? `创作与交付习惯：${memory.workflow.trim()}` : "",
    memory.avoid.trim() ? `长期避免项：${memory.avoid.trim()}` : "",
  ].filter(Boolean);
  if (!sections.length) return "";
  return [
    "【默认个人设计 Skill】",
    ...sections,
    "以上是默认必须遵守的设计规范。未提及不代表取消；只有用户在本次任务中明确要求修改或偏离某条规则时，才覆盖对应规则。品牌专属规则仅在任务涉及该品牌时启用。",
  ].join("\n");
}

function brandKitToPromptText(kit: BrandKit): string {
  const parts: string[] = [];
  if (kit.name.trim()) parts.push(`品牌名：${kit.name.trim()}`);
  if (kit.palette.length) parts.push(`色板：${kit.palette.join(", ")}`);
  if (kit.styleWords.trim()) parts.push(`风格词：${kit.styleWords.trim()}`);
  if (kit.fontHint.trim()) parts.push(`字体气质：${kit.fontHint.trim()}`);
  return parts.join("；");
}

async function resizeImageDataUrl(src: string, maxEdge = 512): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
      const w = Math.max(1, Math.round((img.naturalWidth || 1) * scale));
      const h = Math.max(1, Math.round((img.naturalHeight || 1) * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        resolve(src);
        return;
      }
      ctx.drawImage(img, 0, 0, w, h);
      try {
        resolve(canvas.toDataURL("image/jpeg", 0.85));
      } catch {
        resolve(src);
      }
    };
    img.onerror = () => reject(new Error("logo resize failed"));
    img.src = src;
  });
}

const stylePresets = [
  "极简高级留白",
  "潮流插画",
  "3D 渲染",
  "胶片摄影",
  "国风水墨",
  "赛博霓虹",
  "手绘水彩",
  "品牌 VI 平面",
];

const aspectOptions = ["1:1", "3:2", "2:3", "16:9", "9:16"];

const skillChips: Array<{ label: string; icon: React.ReactNode; prompt: string }> = [
  {
    label: "Seedance 2.0 Video Creation",
    icon: <SquarePlay size={16} color="#8b6fff" />,
    prompt: "为这个主题创作一支电影感短视频分镜：",
  },
  {
    label: "One-shot Video",
    icon: <SquarePlay size={16} color="#8b6fff" />,
    prompt: "一镜到底运动镜头，主体连续动作，背景流动：",
  },
  {
    label: "Instagram Post",
    icon: <Images size={16} color="#2f8bed" />,
    prompt: "设计一张 Instagram 帖子主视觉，1:1，主标题醒目，留出文案位：",
  },
  {
    label: "Cross-Platform Repurposer",
    icon: <Images size={16} color="#2f8bed" />,
    prompt: "把同一主视觉改编成多平台尺寸（横版/竖版/方版），保持视觉一致：",
  },
  {
    label: "Logo Design",
    icon: <LayoutGrid size={16} color="#f5a623" />,
    prompt: "设计一个现代简约 logo，矢量感强、单色可用、留白充分：",
  },
  {
    label: "UGC: Lifestyle Try-on",
    icon: <Store size={16} color="#ff4f92" />,
    prompt: "生成真实感 UGC 生活方式试穿照片，自然光、手机质感：",
  },
  {
    label: "AI Stylist: High-Conversion Looks",
    icon: <Store size={16} color="#ff4f92" />,
    prompt: "生成高转化电商穿搭图：模特全身、背景干净、服饰细节清晰：",
  },
  { label: "All Skills", icon: <BookOpen size={16} color="#8e929b" />, prompt: "" },
];

type CanvasTool = { id: string; title: string; icon: React.ReactNode; tool?: string; action?: string };

type HistoryOutput = { url: string };
type HistoryEntry = {
  id: string;
  ts: number;
  kind: string;
  prompt: string;
  outputs: HistoryOutput[];
  videoUrl?: string;
  error?: string;
};

type ChatMessage =
  | { id: string; role: "user"; text: string; images?: string[]; ts: number }
  | {
      id: string;
      role: "assistant";
      kind: string;
      text?: string;
      images?: string[];
      videoUrl?: string;
      error?: string;
      ts: number;
    }
  | { id: string; role: "action"; label: string; done: boolean; ts: number };

type OaiToolCall = { id: string; type?: string; function: { name: string; arguments: string } };
type OaiContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "low" | "high" | "auto" } };
type OaiMessage =
  | { role: "user" | "system"; content: string | OaiContentPart[] }
  | { role: "assistant"; content?: string | null; tool_calls?: OaiToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

/** Every picture the agent may refer to in this conversation gets a stable global id (#1, #2 …).
 *  Per-turn "图一/图二" labels are resolved against this registry (Lovart numbers by attach order). */
type TurnImageSource = "attached" | "selected" | "last_output" | "output";
type TurnImage = {
  id: number;
  src: string;
  label: string;
  source: TurnImageSource;
  width: number;
  height: number;
  turn: number;
};

type ComposerAttachment = { id: string; src: string; name: string; width: number; height: number };

/* Image parts are only needed live; persisted sessions keep the text so history stays small. */
function stripOaiImages(history: OaiMessage[]): OaiMessage[] {
  return history.map((message) => {
    if (message.role !== "user" || typeof message.content === "string") return message;
    const parts = message.content;
    const text = parts.map((part) => (part.type === "text" ? part.text : "")).filter(Boolean).join("\n");
    const imageCount = parts.filter((part) => part.type === "image_url").length;
    return { role: "user", content: imageCount ? `${text}\n（本轮附带 ${imageCount} 张图片，已省略）` : text };
  });
}

/** Nearest supported aspect for a base image; mirrors aspectFromDimensions on the server. */
function aspectFromSize(width: number, height: number) {
  if (!width || !height) return "1:1";
  const ratio = width / height;
  if (ratio >= 1.6) return "16:9";
  if (ratio >= 1.2) return "3:2";
  if (ratio > 0.83) return "1:1";
  if (ratio > 0.62) return "2:3";
  return "9:16";
}

const CN_ORDINALS = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
function cnOrdinal(index: number) {
  return CN_ORDINALS[index] || String(index + 1);
}

/** Downscale for the vision LLM (tokens) — keeps alpha for PNG sources so cut-outs don't turn black. */
async function downscaleForVision(src: string, maxEdge = 768): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
      const w = Math.max(1, Math.round((img.naturalWidth || 1) * scale));
      const h = Math.max(1, Math.round((img.naturalHeight || 1) * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        resolve(src);
        return;
      }
      ctx.drawImage(img, 0, 0, w, h);
      try {
        resolve(src.startsWith("data:image/png") ? canvas.toDataURL("image/png") : canvas.toDataURL("image/jpeg", 0.82));
      } catch {
        resolve(src);
      }
    };
    img.onerror = () => resolve(src);
    img.src = src;
  });
}

type DesignPlan = {
  title: string;
  summary: string;
  action: "generate" | "edit" | "restyle_text" | "material" | "video" | "vectorize" | "export" | "answer";
  decisions: string[];
  finalPrompt: string;
  negativePrompt: string;
  imageModelHint?: "gpt-image-2" | "seedream-4-5";
  imageModelConfidence?: number;
  brandCompliant?: boolean | null;
};

const DESIGN_PLAN_ACTIONS = new Set<DesignPlan["action"]>([
  "generate",
  "edit",
  "restyle_text",
  "material",
  "video",
  "vectorize",
  "export",
  "answer",
]);

function normalizeDesignPlan(raw: unknown, fallbackBrief: string): DesignPlan {
  const value = raw && typeof raw === "object" ? (raw as Partial<DesignPlan>) : {};
  const action = DESIGN_PLAN_ACTIONS.has(value.action as DesignPlan["action"])
    ? (value.action as DesignPlan["action"])
    : "generate";
  const decisions = Array.isArray(value.decisions)
    ? value.decisions.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 6)
    : [];
  return {
    title: String(value.title || "前置设计方案").trim().slice(0, 40),
    summary: String(value.summary || "已结合对话上下文、画布与默认设计规范整理执行方向。").trim().slice(0, 800),
    action,
    decisions: decisions.length >= 3
      ? decisions
      : ["锁定当前任务目标与交付用途", "遵守默认设计 Skill 与相关品牌规范", "明确构图、配色、文字和材质光影", "排除长期避免项后再执行"],
    finalPrompt: String(value.finalPrompt || fallbackBrief).trim().slice(0, 12000),
    negativePrompt: String(value.negativePrompt || "").trim().slice(0, 3000),
    imageModelHint: value.imageModelHint === "gpt-image-2" || value.imageModelHint === "seedream-4-5" ? value.imageModelHint : undefined,
    imageModelConfidence: typeof value.imageModelConfidence === "number" ? value.imageModelConfidence : undefined,
    brandCompliant: typeof value.brandCompliant === "boolean" ? value.brandCompliant : null,
  };
}

function designPlanToVisibleText(plan: DesignPlan) {
  const modelNote = plan.imageModelHint
    ? `模型推荐：${plan.imageModelHint === "seedream-4-5" ? "Seedream（风格化）" : "GPT-Image-2（精确/写实）"}${
        plan.imageModelConfidence != null ? ` · 置信度 ${Math.round(plan.imageModelConfidence * 100)}%` : ""
      }`
    : "";
  const brandNote = plan.brandCompliant === false ? "⚠️ 品牌合规校验未通过，已在扩写时重新对齐色板/风格词。" : "";
  return [
    plan.summary,
    ...plan.decisions.map((decision, index) => `${index + 1}. ${decision}`),
    modelNote,
    brandNote,
    plan.action === "answer" ? "本轮只确认设计方向，不调用生成工具。" : "执行方向已锁定，下一步按此方案调用工具。",
  ]
    .filter(Boolean)
    .join("\n");
}

function agentModelForText(text: string) {
  if (/@Sonnet-5/i.test(text)) return "claude-sonnet-5";
  if (/@GPT-5\.5/i.test(text)) return "gpt-5.5";
  if (/@Kimi/i.test(text)) return "kimi-k2.7-code";
  return undefined;
}

type AgentSession = {
  id: string;
  title: string;
  ts: number;
  messages: ChatMessage[];
  oai: OaiMessage[];
  /** Owning project; missing on legacy sessions → treated as default */
  projectId?: string;
};

function sessionTitleOf(messages: ChatMessage[]) {
  const first = messages.find((m) => m.role === "user") as { text?: string } | undefined;
  const text = (first?.text || "").replace(/\s+/g, " ").trim();
  if (!text) return "New chat";
  return text.length > 24 ? `${text.slice(0, 24)}…` : text;
}

/* projectId helpers use literal "default" — DEFAULT_PROJECT_ID const is declared later */
function sessionProjectIdOf(session: Pick<AgentSession, "projectId"> | null | undefined): string {
  const id = String(session?.projectId || "").trim();
  return id || "default";
}

function normalizeAgentSessions(raw: unknown): AgentSession[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s): s is AgentSession => Boolean(s && typeof s === "object" && typeof (s as AgentSession).id === "string"))
    .map((s) => ({
      id: String(s.id),
      title: String(s.title || "New chat"),
      ts: Number(s.ts) || Date.now(),
      messages: Array.isArray(s.messages) ? s.messages : [],
      oai: Array.isArray(s.oai) ? stripOaiImages(s.oai as OaiMessage[]) : [],
      projectId: sessionProjectIdOf(s),
    }));
}

function sessionsForProject(sessions: AgentSession[], projectId: string): AgentSession[] {
  const pid = projectId || "default";
  return sessions.filter((s) => sessionProjectIdOf(s) === pid);
}

/* assistant 文本渲染：3 行以上编号列表升级为 Lovart 式任务清单卡 */
function renderAssistantText(text: string) {
  const lines = text.split("\n");
  const numbered = lines.filter((line) => /^\s*\d+[.、)]\s*/.test(line));
  if (numbered.length < 3) return <p className="msgText">{text}</p>;
  const intro = lines.filter((line) => !/^\s*\d+[.、)]\s*/.test(line) && line.trim()).join("\n");
  return (
    <div>
      {intro ? <p className="msgText">{intro}</p> : null}
      <ol className="msgChecklist">
        {numbered.map((line, index) => (
          <li key={index}>{line.replace(/^\s*\d+[.、)]\s*/, "")}</li>
        ))}
      </ol>
    </div>
  );
}

function formatElapsed(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

/* ------------------------------------------------------------------ */
/* small helpers                                                       */
/* ------------------------------------------------------------------ */

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("图片加载失败"));
    img.src = src;
  });
}

async function srcToDataUrl(src: string): Promise<string> {
  if (src.startsWith("data:")) return src;
  const response = await fetch(src);
  const blob = await response.blob();
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("读取图片失败"));
    reader.readAsDataURL(blob);
  });
}

/** OCR line with optional normalized bbox [x0,y0,x1,y1] in 0–1000. */
type FontLineEdit = { from: string; to: string; box?: [number, number, number, number] };

/** Expand normalized 0–1000 box by 8% of its size on each side, clamp to [0,1000]. */
function expandBoxNorm(box: [number, number, number, number], padRatio = 0.08): [number, number, number, number] {
  const [x0, y0, x1, y1] = box;
  const padX = Math.max(4, (x1 - x0) * padRatio);
  const padY = Math.max(4, (y1 - y0) * padRatio);
  return [
    Math.max(0, Math.min(1000, x0 - padX)),
    Math.max(0, Math.min(1000, y0 - padY)),
    Math.max(0, Math.min(1000, x1 + padX)),
    Math.max(0, Math.min(1000, y1 + padY)),
  ];
}

/** Paint canvas: opaque white rects over changed-line bboxes (for composite + OpenAI mask). */
function paintCanvasFromBoxes(w: number, h: number, boxes: Array<[number, number, number, number]>) {
  const paint = document.createElement("canvas");
  paint.width = w;
  paint.height = h;
  const ctx = paint.getContext("2d");
  if (!ctx) throw new Error("canvas unavailable");
  for (const raw of boxes) {
    const [x0, y0, x1, y1] = expandBoxNorm(raw);
    const px = (x0 / 1000) * w;
    const py = (y0 / 1000) * h;
    const pw = ((x1 - x0) / 1000) * w;
    const ph = ((y1 - y0) / 1000) * h;
    ctx.fillStyle = "rgba(255,0,0,1)";
    ctx.fillRect(px, py, Math.max(1, pw), Math.max(1, ph));
  }
  return paint;
}

function inpaintSizeFor(w: number, h: number) {
  if (w === h) return "1024x1024";
  if (w > h) return "1536x1024";
  return "1024x1536";
}

/** mask 外取原图、mask 内取重绘结果，边缘羽化（paint 上非透明区 = 重绘区） */
function compositeByMask(img: HTMLImageElement, result: HTMLImageElement, paint: HTMLCanvasElement) {
  const w = paint.width;
  const h = paint.height;
  const comp = document.createElement("canvas");
  comp.width = w;
  comp.height = h;
  const ctx = comp.getContext("2d");
  if (!ctx) throw new Error("canvas unavailable");
  ctx.drawImage(img, 0, 0, w, h);
  const layer = document.createElement("canvas");
  layer.width = w;
  layer.height = h;
  const lctx = layer.getContext("2d");
  if (!lctx) throw new Error("canvas unavailable");
  lctx.drawImage(result, 0, 0, w, h);
  lctx.globalCompositeOperation = "destination-in";
  lctx.filter = "blur(6px)";
  lctx.drawImage(paint, 0, 0, w, h);
  ctx.drawImage(layer, 0, 0);
  return comp.toDataURL("image/png");
}

/* 纯色背景转透明：四角种子 flood fill，只抠与边缘连通的背景（relay 不支持原生 alpha，白底生成 + 客户端抠图） */
async function solidBackgroundToAlpha(src: string): Promise<string> {
  const dataUrl = src.startsWith("data:") ? src : await srcToDataUrl(src);
  const img = await loadImage(dataUrl);
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return dataUrl;
  ctx.drawImage(img, 0, 0);
  const imageData = ctx.getImageData(0, 0, w, h);
  const px = imageData.data;
  const corners = [
    [0, 0],
    [w - 1, 0],
    [0, h - 1],
    [w - 1, h - 1],
  ];
  let br = 0;
  let bgc = 0;
  let bb = 0;
  for (const [x, y] of corners) {
    const i = (y * w + x) * 4;
    br += px[i];
    bgc += px[i + 1];
    bb += px[i + 2];
  }
  br /= 4;
  bgc /= 4;
  bb /= 4;
  const tolSq = 52 * 52;
  const matches = (i: number) => {
    const dr = px[i] - br;
    const dg = px[i + 1] - bgc;
    const db = px[i + 2] - bb;
    return dr * dr + dg * dg + db * db < tolSq;
  };
  const visited = new Uint8Array(w * h);
  const stack: number[] = [];
  for (const [x, y] of corners) {
    const idx = y * w + x;
    if (!visited[idx] && matches(idx * 4)) {
      visited[idx] = 1;
      stack.push(idx);
    }
  }
  while (stack.length) {
    const idx = stack.pop() as number;
    px[idx * 4 + 3] = 0;
    const x = idx % w;
    const y = (idx / w) | 0;
    if (x > 0) {
      const n = idx - 1;
      if (!visited[n] && matches(n * 4)) {
        visited[n] = 1;
        stack.push(n);
      }
    }
    if (x < w - 1) {
      const n = idx + 1;
      if (!visited[n] && matches(n * 4)) {
        visited[n] = 1;
        stack.push(n);
      }
    }
    if (y > 0) {
      const n = idx - w;
      if (!visited[n] && matches(n * 4)) {
        visited[n] = 1;
        stack.push(n);
      }
    }
    if (y < h - 1) {
      const n = idx + w;
      if (!visited[n] && matches(n * 4)) {
        visited[n] = 1;
        stack.push(n);
      }
    }
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL("image/png");
}

/* 居中裁切到精确比例（gpt-image 只有 1:1/3:2/2:3 三种原生 size，16:9/9:16 由此保证真比例） */
async function cropToAspect(src: string, aspect: string): Promise<string> {
  const [aw, ah] = aspect.split(":").map(Number);
  if (!aw || !ah) return src;
  const dataUrl = src.startsWith("data:") ? src : await srcToDataUrl(src);
  const img = await loadImage(dataUrl);
  const target = aw / ah;
  const current = img.naturalWidth / img.naturalHeight;
  if (Math.abs(current - target) / target < 0.02) return src;
  let w = img.naturalWidth;
  let h = img.naturalHeight;
  if (current > target) w = Math.round(h * target);
  else h = Math.round(w / target);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return src;
  ctx.drawImage(img, (img.naturalWidth - w) / 2, (img.naturalHeight - h) / 2, w, h, 0, 0, w, h);
  return canvas.toDataURL("image/png");
}

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function compositeTargetWithSwatch(targetSrc: string, materialSrc: string) {
  const [target, material] = await Promise.all([loadImage(targetSrc), loadImage(materialSrc)]);
  const height = 1024;
  const targetWidth = Math.max(320, Math.round(target.width * (height / target.height)));
  const stripWidth = Math.round(height * 0.28);
  const canvas = document.createElement("canvas");
  canvas.width = targetWidth + stripWidth;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas unavailable");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(target, 0, 0, targetWidth, height);
  const scale = Math.max(stripWidth / material.width, height / material.height);
  const mw = material.width * scale;
  const mh = material.height * scale;
  ctx.drawImage(material, targetWidth + (stripWidth - mw) / 2, (height - mh) / 2, mw, mh);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(targetWidth - 3, 0, 6, height);
  return canvas.toDataURL("image/png");
}

const uid = () => Math.random().toString(36).slice(2, 10);

/* ------------------------------------------------------------------ */
/* multi-project canvas metadata (localStorage)                        */
/* ------------------------------------------------------------------ */

type ProjectMeta = { id: string; name: string; ts: number };

const DEFAULT_PROJECT_ID = "default";
const DEFAULT_PERSISTENCE_KEY = "lovart-visual-canvas-v3";
const PROJECTS_STORAGE_KEY = "lovartProjects";
const ACTIVE_PROJECT_STORAGE_KEY = "lovartActiveProjectId";
const LEGACY_PROJECT_NAME_KEY = "lovartProjectName";

function persistenceKeyFor(projectId: string): string {
  return projectId === DEFAULT_PROJECT_ID ? DEFAULT_PERSISTENCE_KEY : `lovart-canvas-${projectId}`;
}

function defaultProjectList(name = "Untitled"): ProjectMeta[] {
  return [{ id: DEFAULT_PROJECT_ID, name, ts: Date.now() }];
}

function readProjectsFromStorage(): { projects: ProjectMeta[]; activeId: string; name: string } {
  const legacyName = (() => {
    try {
      return localStorage.getItem(LEGACY_PROJECT_NAME_KEY) || "Untitled";
    } catch {
      return "Untitled";
    }
  })();
  let projects: ProjectMeta[] = [];
  try {
    const raw = JSON.parse(localStorage.getItem(PROJECTS_STORAGE_KEY) || "null");
    if (Array.isArray(raw)) {
      projects = raw
        .filter((p): p is ProjectMeta => p && typeof p === "object" && typeof p.id === "string")
        .map((p) => ({
          id: String(p.id).slice(0, 40),
          name: String(p.name || "Untitled").trim() || "Untitled",
          ts: Number(p.ts) || Date.now(),
        }));
    }
  } catch {
    projects = [];
  }
  if (!projects.length) {
    projects = defaultProjectList(legacyName);
    try {
      localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(projects));
    } catch {
      /* ignore */
    }
  }
  if (!projects.some((p) => p.id === DEFAULT_PROJECT_ID)) {
    projects = [{ id: DEFAULT_PROJECT_ID, name: legacyName, ts: Date.now() }, ...projects];
  }
  let activeId = DEFAULT_PROJECT_ID;
  try {
    activeId = localStorage.getItem(ACTIVE_PROJECT_STORAGE_KEY) || DEFAULT_PROJECT_ID;
  } catch {
    activeId = DEFAULT_PROJECT_ID;
  }
  if (!projects.some((p) => p.id === activeId)) activeId = DEFAULT_PROJECT_ID;
  try {
    localStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, activeId);
  } catch {
    /* ignore */
  }
  const active = projects.find((p) => p.id === activeId) || projects[0];
  return { projects, activeId, name: active?.name || legacyName };
}

function writeProjectsToStorage(projects: ProjectMeta[], activeId: string) {
  try {
    localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(projects));
    localStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, activeId);
    const active = projects.find((p) => p.id === activeId);
    if (active) localStorage.setItem(LEGACY_PROJECT_NAME_KEY, active.name);
  } catch {
    /* ignore quota / private mode */
  }
}

/* ------------------------------------------------------------------ */
/* page                                                                */
/* ------------------------------------------------------------------ */

export default function Home() {
  "use no memo"; // The tldraw editor is an imperative external store; its action closures are not compiler-pure.
  const [editor, setEditor] = useState<Editor | null>(null);

  const [token, setToken] = useState("");
  const [tokenLoaded, setTokenLoaded] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [style, setStyle] = useState(stylePresets[0]);
  const [aspect, setAspect] = useState("1:1");
  const [count, setCount] = useState(2);
  const [brandKit, setBrandKit] = useState<BrandKit>(EMPTY_BRAND_KIT);
  const [designMemory, setDesignMemory] = useState<DesignMemory>(EMPTY_DESIGN_MEMORY);
  const [designMemoryDraft, setDesignMemoryDraft] = useState<DesignMemory>(EMPTY_DESIGN_MEMORY);
  const [showDesignMemory, setShowDesignMemory] = useState(false);
  const [audience, setAudience] = useState("");
  const [negativePrompt, setNegativePrompt] = useState("");
  const [references, setReferences] = useState<string[]>([]);
  const brandText = useMemo(() => brandKitToPromptText(brandKit), [brandKit]);
  const designMemoryText = useMemo(() => designMemoryToPromptText(designMemory), [designMemory]);

  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState("");
  const [agentBusy, setAgentBusy] = useState(false);
  const [error, setError] = useState("");
  const [videoUrl, setVideoUrl] = useState("");

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [pastSessions, setPastSessions] = useState<AgentSession[]>([]);
  const [sessionId, setSessionId] = useState(() => uid());
  const [showHistory, setShowHistory] = useState(false);
  const [showAgentMenu, setShowAgentMenu] = useState(false);
  const [showProBanner, setShowProBanner] = useState(true);
  const [showVoiceTip, setShowVoiceTip] = useState(false);
  const [showMentionMenu, setShowMentionMenu] = useState(false);
  const [showSkillsLib, setShowSkillsLib] = useState(false);
  const [listening, setListening] = useState(false);
  const [contextChips, setContextChips] = useState<string[]>([]);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [composerDragOver, setComposerDragOver] = useState(false);
  const [tick, setTick] = useState(0);

  const [zoomPct, setZoomPct] = useState(100);
  const toolId = useValue("toolId", () => editor?.getCurrentToolId() ?? "select", [editor]);
  const [gridOn, setGridOn] = useState(false);
  const [shapeCount, setShapeCount] = useState(0);
  const [selection, setSelection] = useState<{
    ids: TLShapeId[];
    images: string[];
    box: { x: number; y: number; w: number; h: number } | null;
  }>({ ids: [], images: [], box: null });

  const [quickEditDialog, setQuickEditDialog] = useState<{ open: boolean; src?: string; mode?: "edit" | "erase" }>({ open: false });
  const [quickEditText, setQuickEditText] = useState("");
  const [elementDialog, setElementDialog] = useState<{ open: boolean; src?: string }>({ open: false });
  const [elementTarget, setElementTarget] = useState("");
  const [elementOp, setElementOp] = useState<"recolor" | "remove" | "replace" | "free" | "layers" | "smart-split">("recolor");
  const [elementValue, setElementValue] = useState("");
  const [maskDialog, setMaskDialog] = useState<{ open: boolean; src?: string }>({ open: false });
  const [maskBrush, setMaskBrush] = useState(36);
  const [maskInstruction, setMaskInstruction] = useState("");
  const [maskHasPaint, setMaskHasPaint] = useState(false);
  const maskViewRef = useRef<HTMLCanvasElement | null>(null);
  const maskPaintRef = useRef<HTMLCanvasElement | null>(null);
  const maskImgRef = useRef<HTMLImageElement | null>(null);
  const maskDrawingRef = useRef(false);
  const [contextMenu, setContextMenu] = useState<{ open: boolean; x: number; y: number }>({ open: false, x: 0, y: 0 });
  const [brushColor, setBrushColor] = useState("black");
  const [brushSize, setBrushSize] = useState("m");
  const [textFont, setTextFont] = useState<"draw" | "sans" | "serif" | "mono">("draw");
  const [textColor, setTextColor] = useState("black");
  const [textSize, setTextSize] = useState("m");
  const [fontDialog, setFontDialog] = useState<{ open: boolean; src?: string; preview?: string }>({ open: false });
  const [fontLines, setFontLines] = useState<FontLineEdit[] | null>(null);
  const [fontOcr, setFontOcr] = useState<"idle" | "loading" | "done" | "failed">("idle");
  const [fontText, setFontText] = useState("");
  const [fontNote, setFontNote] = useState("");
  const [materialDialog, setMaterialDialog] = useState<{ open: boolean; a?: string; b?: string }>({ open: false });
  const [materialSwap, setMaterialSwap] = useState(false);
  const [materialNote, setMaterialNote] = useState("");
  const [exportMenu, setExportMenu] = useState(false);
  const [projects, setProjects] = useState<ProjectMeta[]>(() => defaultProjectList());
  const [activeProjectId, setActiveProjectId] = useState(DEFAULT_PROJECT_ID);
  const [projectName, setProjectName] = useState("Untitled");
  /** local = only browser; saving = cloud PUT in flight; synced = last cloud save ok; error = last save failed */
  const [syncStatus, setSyncStatus] = useState<"local" | "saving" | "synced" | "error">("local");

  const [countdown, setCountdown] = useState("00040000");

  const fileInputRef = useRef<HTMLInputElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const placeCounter = useRef(0);
  const recognitionRef = useRef<{ stop: () => void } | null>(null);
  const oaiHistoryRef = useRef<OaiMessage[]>([]);
  const currentPlanRef = useRef<DesignPlan | null>(null);
  const imageRegistryRef = useRef<TurnImage[]>([]);
  const lastOutputsRef = useRef<number[]>([]);
  const turnCounterRef = useRef(0);
  const attachmentsRef = useRef<ComposerAttachment[]>([]);
  const selectionRef = useRef(selection);
  const skipAutosaveRef = useRef(false);
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeProjectIdRef = useRef(activeProjectId);
  const projectNameRef = useRef(projectName);
  const editorRef = useRef<Editor | null>(null);

  useEffect(() => {
    selectionRef.current = selection;
  }, [selection]);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => {
    activeProjectIdRef.current = activeProjectId;
  }, [activeProjectId]);

  useEffect(() => {
    projectNameRef.current = projectName;
  }, [projectName]);

  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  const authHeaders = useCallback((): HeadersInit => {
    const headers: HeadersInit = { "content-type": "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    return headers;
  }, [token]);

  const renameActiveProject = useCallback(
    (rawName: string) => {
      const name = rawName.trim() || "Untitled";
      setProjectName(name);
      setProjects((prev) => {
        const next = prev.map((p) => (p.id === activeProjectId ? { ...p, name, ts: Date.now() } : p));
        writeProjectsToStorage(next, activeProjectId);
        return next;
      });
    },
    [activeProjectId],
  );

  const saveCanvasToCloud = useCallback(
    async (opts?: { silent?: boolean }) => {
      const ed = editorRef.current;
      const projectId = activeProjectIdRef.current;
      if (!ed) {
        if (!opts?.silent) setError("画布尚未就绪");
        return false;
      }
      let snapshot: ReturnType<typeof getSnapshot>;
      try {
        snapshot = getSnapshot(ed.store);
      } catch (error) {
        if (!opts?.silent) setError(error instanceof Error ? error.message : "无法读取画布快照");
        return false;
      }
      setSyncStatus("saving");
      try {
        const res = await fetch(`${API_BASE}/canvas-snapshots/${encodeURIComponent(projectId)}`, {
          method: "PUT",
          headers: authHeaders(),
          body: JSON.stringify({
            snapshot,
            projectName: projectNameRef.current,
          }),
        });
        const json = (await res.json().catch(() => ({}))) as { detail?: string };
        if (!res.ok) throw new Error(json.detail || `保存失败 HTTP ${res.status}`);
        setSyncStatus("synced");
        if (!opts?.silent) setError("");
        return true;
      } catch (error) {
        setSyncStatus("error");
        if (!opts?.silent) setError(error instanceof Error ? error.message : "云端保存失败");
        return false;
      }
    },
    [authHeaders],
  );

  const restoreCanvasFromCloud = useCallback(async () => {
    const ed = editorRef.current;
    const projectId = activeProjectIdRef.current;
    if (!ed) {
      setError("画布尚未就绪");
      return false;
    }
    if (!window.confirm("从云端恢复将覆盖当前画布内容，继续？")) return false;
    setSyncStatus("saving");
    try {
      const res = await fetch(`${API_BASE}/canvas-snapshots/${encodeURIComponent(projectId)}`, {
        method: "GET",
        headers: authHeaders(),
      });
      const json = (await res.json().catch(() => ({}))) as {
        detail?: string;
        data?: { snapshot?: unknown; projectName?: string | null };
      };
      if (!res.ok) throw new Error(json.detail || `恢复失败 HTTP ${res.status}`);
      const snapshot = json.data?.snapshot;
      if (!snapshot || typeof snapshot !== "object") throw new Error("云端快照为空或格式无效");
      skipAutosaveRef.current = true;
      loadSnapshot(ed.store, snapshot as Parameters<typeof loadSnapshot>[1]);
      if (json.data?.projectName) renameActiveProject(String(json.data.projectName));
      setSyncStatus("synced");
      setError("");
      window.setTimeout(() => {
        skipAutosaveRef.current = false;
      }, 1500);
      return true;
    } catch (error) {
      setSyncStatus("error");
      setError(error instanceof Error ? error.message : "云端恢复失败");
      return false;
    }
  }, [authHeaders, renameActiveProject]);

  // 60s debounced autosave when document changes
  useEffect(() => {
    if (!editor) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- A newly attached external editor starts a new autosave subscription.
    setSyncStatus("local");
    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    const unlisten = editor.store.listen(
      () => {
        if (skipAutosaveRef.current) return;
        setSyncStatus((prev) => (prev === "saving" ? prev : "local"));
        if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
        autosaveTimerRef.current = setTimeout(() => {
          autosaveTimerRef.current = null;
          void saveCanvasToCloud({ silent: true }).then((ok) => {
            if (!ok) {
              // silent retry once after 15s
              window.setTimeout(() => {
                void saveCanvasToCloud({ silent: true });
              }, 15_000);
            }
          });
        }, 60_000);
      },
      { scope: "document" },
    );
    return () => {
      unlisten();
      if (autosaveTimerRef.current) {
        clearTimeout(autosaveTimerRef.current);
        autosaveTimerRef.current = null;
      }
    };
  }, [editor, activeProjectId, saveCanvasToCloud]);

  /**
   * Save current chat under leaving project, then restore target project's latest session (or empty).
   * Must run in the same event-handler turn as setActiveProjectId so React batches final state
   * (avoids stamping old messages with the new projectId).
   */
  const bindSessionToProjectSwitch = useCallback(
    (fromProjectId: string, toProjectId: string, prevSessions: AgentSession[]) => {
      let next = prevSessions;
      if (messages.length) {
        const rest = prevSessions.filter((s) => s.id !== sessionId);
        next = [
          {
            id: sessionId,
            projectId: fromProjectId || DEFAULT_PROJECT_ID,
            title: sessionTitleOf(messages),
            ts: Date.now(),
            messages,
            oai: oaiHistoryRef.current,
          },
          ...rest,
        ];
      }
      next = normalizeAgentSessions(next).slice(0, 40);
      try {
        localStorage.setItem("lovartSessions", JSON.stringify(next));
      } catch {
        /* ignore quota */
      }
      setPastSessions(next);

      const forTarget = sessionsForProject(next, toProjectId);
      // Prefer latest for target that is not the session we just left empty-bound
      const last = forTarget.find((s) => s.messages?.length) || forTarget[0];
      if (last?.messages?.length) {
        setSessionId(last.id);
        setMessages(last.messages);
        oaiHistoryRef.current = last.oai || [];
        imageRegistryRef.current = [];
        lastOutputsRef.current = [];
        turnCounterRef.current = 0;
      } else {
        setSessionId(uid());
        setMessages([]);
        oaiHistoryRef.current = [];
        imageRegistryRef.current = [];
        lastOutputsRef.current = [];
        turnCounterRef.current = 0;
      }
      setContextChips([]);
    },
    [messages, sessionId],
  );

  const switchProject = useCallback(
    (id: string) => {
      if (id === activeProjectId) {
        setExportMenu(false);
        return;
      }
      // Flush title edit for the leaving project before remount.
      const leavingName = projectName.trim() || "Untitled";
      const leavingProjectId = activeProjectId;
      setProjects((prev) => {
        const next = prev.map((p) => (p.id === activeProjectId ? { ...p, name: leavingName, ts: Date.now() } : p));
        writeProjectsToStorage(next, id);
        return next;
      });
      // Session first, then project id — same turn, batched.
      bindSessionToProjectSwitch(leavingProjectId, id, pastSessions);
      setEditor(null);
      setSelection({ ids: [], images: [], box: null });
      setShapeCount(0);
      setSyncStatus("local");
      setActiveProjectId(id);
      const target = projects.find((p) => p.id === id);
      setProjectName(target?.name || "Untitled");
      setExportMenu(false);
    },
    [activeProjectId, bindSessionToProjectSwitch, pastSessions, projectName, projects],
  );

  const createProject = useCallback(() => {
    const id = uid().replace(/[^a-z0-9-]/gi, "").toLowerCase() || `p${Date.now().toString(36)}`;
    const name = `项目 ${projects.length + 1}`;
    const entry: ProjectMeta = { id, name, ts: Date.now() };
    const leavingProjectId = activeProjectId;
    const next = [...projects.map((p) => (p.id === activeProjectId ? { ...p, name: projectName.trim() || "Untitled" } : p)), entry];
    writeProjectsToStorage(next, id);
    setProjects(next);
    bindSessionToProjectSwitch(leavingProjectId, id, pastSessions);
    setEditor(null);
    setSelection({ ids: [], images: [], box: null });
    setShapeCount(0);
    setSyncStatus("local");
    setActiveProjectId(id);
    setProjectName(name);
    setExportMenu(false);
  }, [activeProjectId, bindSessionToProjectSwitch, pastSessions, projectName, projects]);

  const deleteActiveProject = useCallback(() => {
    if (activeProjectId === DEFAULT_PROJECT_ID) {
      window.alert("默认项目不可删除");
      return;
    }
    if (projects.length <= 1) {
      window.alert("至少保留一个项目");
      return;
    }
    if (!window.confirm(`删除项目「${projectName}」？画布本地数据不会自动清理，仅从列表移除。`)) return;
    const leavingProjectId = activeProjectId;
    const next = projects.filter((p) => p.id !== activeProjectId);
    const fallback = next.find((p) => p.id === DEFAULT_PROJECT_ID) || next[0];
    writeProjectsToStorage(next, fallback.id);
    setProjects(next);
    bindSessionToProjectSwitch(leavingProjectId, fallback.id, pastSessions);
    setEditor(null);
    setSelection({ ids: [], images: [], box: null });
    setShapeCount(0);
    setSyncStatus("local");
    setActiveProjectId(fallback.id);
    setProjectName(fallback.name);
    setExportMenu(false);
  }, [activeProjectId, bindSessionToProjectSwitch, pastSessions, projectName, projects]);

  /* ------------------------------ boot ------------------------------ */

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Browser-only persisted state is hydrated after the server-matching first render.
    setToken(localStorage.getItem("videoApiToken") || "");
    setTokenLoaded(true);
    try {
      setHistory(JSON.parse(localStorage.getItem("lovartHistory") || "[]"));
    } catch {
      setHistory([]);
    }
    const bootProjects = readProjectsFromStorage();
    setProjects(bootProjects.projects);
    setActiveProjectId(bootProjects.activeId);
    setProjectName(bootProjects.name);
    writeProjectsToStorage(bootProjects.projects, bootProjects.activeId);
    try {
      const savedKit = JSON.parse(localStorage.getItem("lovartBrandKit") || "null") as BrandKit | null;
      if (savedKit && typeof savedKit === "object") {
        setBrandKit({
          name: String(savedKit.name || ""),
          palette: Array.isArray(savedKit.palette) ? savedKit.palette.map(String).filter(Boolean).slice(0, 6) : [],
          styleWords: String(savedKit.styleWords || ""),
          logoRef: String(savedKit.logoRef || ""),
          fontHint: String(savedKit.fontHint || ""),
        });
      }
    } catch {
      /* ignore corrupt brand kit */
    }
    try {
      const savedMemory = normalizeDesignMemory(JSON.parse(localStorage.getItem(DESIGN_MEMORY_STORAGE_KEY) || "null"));
      setDesignMemory(savedMemory);
      setDesignMemoryDraft(savedMemory);
    } catch {
      setDesignMemory(EMPTY_DESIGN_MEMORY);
      setDesignMemoryDraft(EMPTY_DESIGN_MEMORY);
    }
    try {
      const saved = normalizeAgentSessions(JSON.parse(localStorage.getItem("lovartSessions") || "[]"));
      // migrate-write so legacy sessions without projectId stick as "default"
      try {
        localStorage.setItem("lovartSessions", JSON.stringify(saved.slice(0, 40)));
      } catch {
        /* ignore */
      }
      setPastSessions(saved);
      const forActive = sessionsForProject(saved, bootProjects.activeId);
      const last = forActive[0];
      if (last?.messages?.length) {
        setSessionId(last.id);
        setMessages(last.messages);
        oaiHistoryRef.current = last.oai || [];
        imageRegistryRef.current = [];
        lastOutputsRef.current = [];
        turnCounterRef.current = 0;
      }
    } catch {
      setPastSessions([]);
    }
    if (!localStorage.getItem("lovartVoiceTipSeen")) setShowVoiceTip(true);
    let target = Number(localStorage.getItem("lovartPromoEnd") || 0);
    if (!target || target < Date.now()) {
      target = Date.now() + 4 * 24 * 3600 * 1000 + 13 * 60000;
      localStorage.setItem("lovartPromoEnd", String(target));
    }
    const tick = () => {
      const left = Math.max(0, target - Date.now());
      const d = Math.floor(left / 86400000);
      const h = Math.floor((left % 86400000) / 3600000);
      const m = Math.floor((left % 3600000) / 60000);
      const s = Math.floor((left % 60000) / 1000);
      setCountdown([d, h, m, s].map((v) => String(v).padStart(2, "0")).join(""));
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (tokenLoaded) localStorage.setItem("videoApiToken", token);
  }, [token, tokenLoaded]);

  useEffect(() => {
    localStorage.setItem("lovartHistory", JSON.stringify(history.slice(0, 60)));
  }, [history]);

  /* 会话持久化：当前会话带 projectId，始终靠前（刷新后按项目恢复） */
  useEffect(() => {
    if (!tokenLoaded) return;
    setPastSessions((prev) => {
      const rest = prev.filter((s) => s.id !== sessionId);
      const next = messages.length
        ? [
            {
              id: sessionId,
              projectId: activeProjectId || DEFAULT_PROJECT_ID,
              title: sessionTitleOf(messages),
              ts: Date.now(),
              messages,
              oai: oaiHistoryRef.current,
            },
            ...rest,
          ]
        : prev;
      const normalized = normalizeAgentSessions(next).slice(0, 40);
      try {
        localStorage.setItem("lovartSessions", JSON.stringify(normalized));
      } catch {
        /* ignore */
      }
      return normalized;
    });
  }, [activeProjectId, messages, sessionId, tokenLoaded]);

  /* Tab 快捷键：选中图片时打开 Quick Edit（Lovart 同款） */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (quickEditDialog.open || elementDialog.open || fontDialog.open || materialDialog.open) return;
      const src = selectionRef.current.images[0];
      if (!src || busy) return;
      event.preventDefault();
      setQuickEditText("");
      setQuickEditDialog({ open: true, src, mode: "edit" });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, elementDialog.open, fontDialog.open, materialDialog.open, quickEditDialog.open]);

  /* 进度计时器：有进行中任务时每秒刷新 */
  useEffect(() => {
    const active = agentBusy || busy || messages.some((m) => m.role === "action" && !m.done);
    if (!active) return;
    const timer = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [agentBusy, busy, messages]);

  useEffect(() => {
    messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  /* ----------------------- tldraw reactive state -------------------- */

  useEffect(() => {
    if (!editor) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      setZoomPct(Math.round(editor.getZoomLevel() * 100));
      setGridOn(Boolean(editor.getInstanceState().isGridMode));
      setShapeCount(editor.getCurrentPageShapeIds().size);
      const shapes = editor.getSelectedShapes();
      const ids = shapes.map((s) => s.id);
      const images: string[] = [];
      for (const shape of shapes) {
        if (shape.type !== "image") continue;
        const assetId = (shape.props as { assetId?: string }).assetId;
        if (!assetId) continue;
        const asset = editor.getAsset(assetId as TLAssetId);
        const src = (asset?.props as { src?: string } | undefined)?.src;
        if (src) images.push(src);
      }
      let box: { x: number; y: number; w: number; h: number } | null = null;
      if (ids.length) {
        const maybe = (
          editor as unknown as { getSelectionRotatedScreenBounds?: () => { x: number; y: number; w: number; h: number } | undefined }
        ).getSelectionRotatedScreenBounds?.();
        if (maybe) box = { x: maybe.x, y: maybe.y, w: maybe.w, h: maybe.h };
      }
      setSelection({ ids, images, box });
    };
    update();
    const unlisten = editor.store.listen(
      () => {
        if (!raf) raf = requestAnimationFrame(update);
      },
      { scope: "all" },
    );
    return () => {
      unlisten();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [editor]);

  /* ------------------------- keyboard: C to chat -------------------- */

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "c" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      event.preventDefault();
      composerRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* ------------------------------ canvas ---------------------------- */

  const placeImageOnCanvas = useCallback(
    async (src: string, name = "generated") => {
      if (!editor) return;
      let width = 1024;
      let height = 1024;
      try {
        const img = await loadImage(src);
        width = img.naturalWidth || width;
        height = img.naturalHeight || height;
      } catch {
        /* keep defaults */
      }
      const displayWidth = 360;
      const displayHeight = Math.round((height / width) * displayWidth);
      const assetId = AssetRecordType.createId();
      editor.createAssets([
        {
          id: assetId,
          typeName: "asset",
          type: "image",
          props: {
            name,
            src,
            w: width,
            h: height,
            mimeType: src.startsWith("data:image/svg")
              ? "image/svg+xml"
              : src.startsWith("data:image/png")
                ? "image/png"
                : "image/jpeg",
            isAnimated: false,
          },
          meta: {},
        },
      ]);
      const center = editor.getViewportPageBounds().center;
      const slot = placeCounter.current;
      placeCounter.current += 1;
      const shapeId = createShapeId();
      editor.createShape({
        id: shapeId,
        type: "image",
        x: center.x - displayWidth / 2 + (slot % 2) * (displayWidth + 24) - displayWidth / 2,
        y: center.y - displayHeight / 2 + Math.floor(slot % 4 / 2) * (displayHeight + 24) + Math.floor(slot / 4) * 40,
        props: { assetId, w: displayWidth, h: displayHeight },
      });
      editor.select(shapeId);
      return shapeId;
    },
    [editor],
  );

  /* dev-only 测试钩子：E2E 验证时向画布注入图片 */
  useEffect(() => {
    if (process.env.NODE_ENV !== "development") return;
    (window as unknown as Record<string, unknown>).__studioPlaceImage = placeImageOnCanvas;
  }, [placeImageOnCanvas]);

  /* 画布/选中导出 PNG（Lovart 分享同款产物） */
  const exportCanvasPng = useCallback(async () => {
    if (!editor) return;
    const selected = editor.getSelectedShapeIds();
    const ids = selected.length ? selected : [...editor.getCurrentPageShapeIds()];
    if (!ids.length) {
      setError("画布是空的，先生成或放一些内容");
      return;
    }
    /* 按内容尺寸动态限流：最长边 ≤4096px，防止大画布导出撑爆渲染进程 */
    const bounds = selected.length ? editor.getSelectionPageBounds() : editor.getCurrentPageBounds();
    const maxSide = Math.max(bounds?.w || 1024, bounds?.h || 1024);
    const scale = Math.min(2, Math.max(0.2, 4096 / maxSide));
    const blob = await exportToBlob({ editor, ids, format: "png", opts: { scale, background: true } });
    saveBlob(blob, `${(projectName || "canvas").replace(/\s+/g, "-")}.png`);
  }, [editor, projectName]);

  /* 右键菜单动作 */
  const contextActions = useMemo(
    () => [
      {
        label: "粘贴图片",
        run: async () => {
          try {
            const items = await navigator.clipboard.read();
            for (const item of items) {
              const type = item.types.find((t) => t.startsWith("image/"));
              if (!type) continue;
              const blob = await item.getType(type);
              const dataUrl = await new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result));
                reader.onerror = () => reject(new Error("读取剪贴板失败"));
                reader.readAsDataURL(blob);
              });
              await placeImageOnCanvas(dataUrl, "pasted");
              return;
            }
            setError("剪贴板里没有图片");
          } catch {
            setError("无法读取剪贴板（浏览器权限）");
          }
        },
      },
      {
        label: "复制所选",
        run: async () => {
          if (!editor) return;
          const ids = editor.getSelectedShapeIds();
          if (ids.length) editor.duplicateShapes(ids, { x: 32, y: 32 });
        },
      },
      {
        label: "删除所选",
        run: async () => {
          if (!editor) return;
          const ids = editor.getSelectedShapeIds();
          if (ids.length) editor.deleteShapes(ids);
        },
      },
      {
        label: "全选",
        run: async () => editor?.selectAll(),
      },
      {
        label: "导出 PNG",
        run: async () => exportCanvasPng(),
      },
      {
        label: "缩放至适配",
        run: async () => editor?.zoomToFit(),
      },
      {
        label: "100%",
        run: async () => editor?.resetZoom(),
      },
    ],
    [editor, exportCanvasPng, placeImageOnCanvas],
  );

  const brushColors = ["black", "grey", "red", "orange", "yellow", "green", "blue", "violet"] as const;
  const brushColorHex: Record<string, string> = {
    black: "#1d1d1d",
    grey: "#9fa8b2",
    red: "#e03131",
    orange: "#f76707",
    yellow: "#ffc034",
    green: "#099268",
    blue: "#4263eb",
    violet: "#ae3ec9",
  };
  const brushSizes = [
    { id: "s", label: "细" },
    { id: "m", label: "中" },
    { id: "l", label: "粗" },
    { id: "xl", label: "特粗" },
  ] as const;

  const applyBrushColor = useCallback(
    (color: string) => {
      if (!editor) return;
      setBrushColor(color);
      editor.setStyleForNextShapes(DefaultColorStyle, color as never);
    },
    [editor],
  );

  const applyBrushSize = useCallback(
    (size: string) => {
      if (!editor) return;
      setBrushSize(size);
      editor.setStyleForNextShapes(DefaultSizeStyle, size as never);
    },
    [editor],
  );

  const applyTextFont = useCallback(
    (font: "draw" | "sans" | "serif" | "mono") => {
      if (!editor) return;
      setTextFont(font);
      editor.setStyleForNextShapes(DefaultFontStyle, font);
      editor.setStyleForSelectedShapes(DefaultFontStyle, font);
    },
    [editor],
  );

  const applyTextColor = useCallback(
    (color: string) => {
      if (!editor) return;
      setTextColor(color);
      editor.setStyleForNextShapes(DefaultColorStyle, color as never);
      editor.setStyleForSelectedShapes(DefaultColorStyle, color as never);
    },
    [editor],
  );

  const applyTextSize = useCallback(
    (size: string) => {
      if (!editor) return;
      setTextSize(size);
      editor.setStyleForNextShapes(DefaultSizeStyle, size as never);
      editor.setStyleForSelectedShapes(DefaultSizeStyle, size as never);
    },
    [editor],
  );

  const persistBrandKit = useCallback((next: BrandKit) => {
    setBrandKit(next);
    try {
      localStorage.setItem("lovartBrandKit", JSON.stringify(next));
    } catch {
      /* quota / private mode — keep in-memory only */
    }
  }, []);

  const saveDesignMemory = useCallback(() => {
    const next = normalizeDesignMemory({ ...designMemoryDraft, updatedAt: Date.now() });
    setDesignMemory(next);
    try {
      localStorage.setItem(DESIGN_MEMORY_STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* private mode — keep in-memory only */
    }
    setShowDesignMemory(false);
  }, [designMemoryDraft]);

  const onBrandLogoUpload = useCallback(
    async (file: File | null) => {
      if (!file) return;
      const reader = new FileReader();
      const dataUrl = await new Promise<string>((resolve, reject) => {
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("logo read failed"));
        reader.readAsDataURL(file);
      });
      let logoRef = dataUrl;
      try {
        logoRef = await resizeImageDataUrl(dataUrl, 512);
      } catch {
        logoRef = dataUrl;
      }
      const next = { ...brandKit, logoRef };
      try {
        localStorage.setItem("lovartBrandKit", JSON.stringify(next));
        persistBrandKit(next);
      } catch {
        // retry without logo if quota exceeded
        const without = { ...brandKit, logoRef: "" };
        try {
          localStorage.setItem("lovartBrandKit", JSON.stringify(without));
        } catch {
          /* ignore */
        }
        persistBrandKit({ ...brandKit, logoRef });
      }
    },
    [brandKit, persistBrandKit],
  );

  const dockTools: CanvasTool[] = [
    { id: "select", title: "选择", icon: <MousePointer2 size={19} />, tool: "select" },
    { id: "note", title: "标注", icon: <MapPin size={19} />, tool: "note" },
    { id: "upload", title: "上传图片", icon: <ImageUpIcon />, action: "upload" },
    { id: "grid", title: "网格", icon: <Hash size={19} />, action: "grid" },
    { id: "frame", title: "画板", icon: <Squircle size={19} />, tool: "frame" },
    { id: "draw", title: "画笔", icon: <Pencil size={19} />, tool: "draw" },
    { id: "text", title: "文字", icon: <Type size={19} />, tool: "text" },
  ];

  const handleDockTool = (item: CanvasTool) => {
    if (!editor) return;
    if (item.tool) {
      editor.setCurrentTool(item.tool);
      return;
    }
    if (item.action === "upload") fileInputRef.current?.click();
    if (item.action === "grid") editor.updateInstanceState({ isGridMode: !editor.getInstanceState().isGridMode });
  };

  /* Lovart 同款：从对话框上传的图既进画布，也按顺序挂到当前消息上（图一/图二…） */
  const addAttachmentFiles = useCallback(
    async (files: File[]) => {
      for (const file of files.slice(0, 6)) {
        if (!file.type.startsWith("image/")) continue;
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(new Error("读取文件失败"));
          reader.readAsDataURL(file);
        });
        let width = 0;
        let height = 0;
        try {
          const img = await loadImage(dataUrl);
          width = img.naturalWidth || 0;
          height = img.naturalHeight || 0;
        } catch {
          /* dimensions optional */
        }
        setAttachments((prev) => [...prev, { id: uid(), src: dataUrl, name: file.name || "image", width, height }].slice(-6));
        setReferences((prev) => [...prev, dataUrl].slice(-4));
      }
    },
    [],
  );

  const handleFiles = async (list: FileList | null) => {
    if (!list?.length) return;
    const files = Array.from(list).slice(0, 6);
    await addAttachmentFiles(files);
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("读取文件失败"));
        reader.readAsDataURL(file);
      });
      await placeImageOnCanvas(dataUrl, file.name);
    }
    editor?.selectNone();
  };

  /* ------------------------------- api ------------------------------ */

  const api = useCallback(
    async <T,>(path: string, init: RequestInit = {}) => {
      const response = await fetch(`${API_BASE}${path}`, {
        ...init,
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(init.headers || {}),
        },
      });
      const payload = (await response.json().catch(() => ({}))) as { detail?: string; data?: T } & Record<string, unknown>;
      if (!response.ok) throw new Error(payload?.detail || `请求失败 ${response.status}`);
      return payload;
    },
    [token],
  );

  /* 长耗时图片操作走异步任务：提交秒回 + 轮询（每个 HTTP 请求都短，绕开 Cloudflare 100s/524 超时） */
  const apiAsyncImages = useCallback(
    async <T = ImagesResult>(path: string, body: Record<string, unknown>) => {
      const submitted = await api<{ job_id?: string }>(path, {
        method: "POST",
        body: JSON.stringify({ ...body, async: true }),
      });
      const jobId = (submitted.data as { job_id?: string } | undefined)?.job_id;
      if (!jobId) throw new Error("任务提交失败：无 job id");
      for (let attempt = 0; attempt < 200; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        const status = await api<{ state?: string; result?: T; error?: string }>(`/image-jobs/${jobId}`);
        const data = (status.data || {}) as { state?: string; result?: T; error?: string };
        if (data.state === "done") return { data: data.result } as { data?: T };
        if (data.state === "failed") throw new Error(data.error || "生成失败");
      }
      throw new Error("生成超时（10 分钟），请稍后在历史里重试");
    },
    [api],
  );

  const pushHistory = useCallback((entry: Omit<HistoryEntry, "id" | "ts">) => {
    setHistory((prev) => [{ id: uid(), ts: Date.now(), ...entry }, ...prev].slice(0, 60));
  }, []);

  type NewChatMessage =
    | { id?: string; role: "user"; text: string; images?: string[] }
    | { id?: string; role: "assistant"; kind: string; text?: string; images?: string[]; videoUrl?: string; error?: string }
    | { id?: string; role: "action"; label: string; done: boolean };

  const pushMessage = useCallback((message: NewChatMessage) => {
    const id = message.id || uid();
    setMessages((prev) => [...prev, { ...message, id, ts: Date.now() } as ChatMessage]);
    return id;
  }, []);

  type ImagesResult = { images?: Array<{ public_url?: string }> };

  /* ------------------------- action kernels ------------------------- */

  /* 生成中画布占位骨架（Lovart 同款：完成后替换为成品图） */
  const createPlaceholder = useCallback(
    (label: string) => {
      if (!editor) return null;
      const id = createShapeId();
      const center = editor.getViewportPageBounds().center;
      editor.createShape({
        id,
        type: "geo",
        x: center.x - 210,
        y: center.y - 210,
        props: { geo: "rectangle", w: 420, h: 420, dash: "dashed", color: "grey", fill: "semi", richText: toRichText(`⏳ ${label}中…`) },
      });
      return id;
    },
    [editor],
  );

  const removePlaceholder = useCallback(
    (id: TLShapeId | null) => {
      if (editor && id) {
        try {
          editor.deleteShapes([id]);
        } catch {
          /* shape 可能已被用户删除 */
        }
      }
    },
    [editor],
  );

  const doGenerateImages = useCallback(
    async (params: {
      prompt: string;
      aspect?: string;
      count?: number;
      quality?: string;
      refs?: string[];
      kind?: string;
      transparent?: boolean;
      imageModel?: string;
      negativePrompt?: string;
      outputName?: string;
    }) => {
      const refs = [...(params.refs || [])];
      // Direct gen: append brand logo as extra reference when present
      if (params.kind !== "agent" && brandKit.logoRef) refs.push(brandKit.logoRef);
      const referenceImages = await Promise.all(refs.slice(0, 6).map((src) => srcToDataUrl(src)));
      const placeholderId = createPlaceholder(params.outputName || "生成图片");
      try {
        const effectivePrompt = params.transparent
          ? `${params.prompt}。背景为纯白色（#FFFFFF）纯净平涂，无阴影无渐变，主体边缘干净利落`
          : params.prompt;
        const brandLine = params.kind === "agent" ? undefined : brandText || undefined;
        const payload = await apiAsyncImages<ImagesResult & { policy_fallback?: boolean; error_kind?: string }>("/images", {
            prompt: effectivePrompt,
            raw_prompt: params.kind === "agent" ? effectivePrompt : undefined,
            style: params.kind === "agent" ? undefined : style,
            brand: brandLine,
            design_memory: params.kind === "agent" ? undefined : designMemoryText || undefined,
            audience: params.kind === "agent" ? undefined : audience,
            negative_prompt: params.negativePrompt || (params.kind === "agent" ? undefined : negativePrompt),
            aspect_ratio: params.aspect || aspect,
            n: Math.max(1, Math.min(4, params.count || (params.kind === "agent" ? 1 : count))),
            ...(params.quality ? { quality: params.quality } : {}),
            ...(params.imageModel ? { image_model: params.imageModel } : {}),
            ...(params.transparent ? { background: "transparent" } : {}),
            ...(referenceImages.length ? { reference_images: referenceImages } : {}),
            /* 非 agent 的直出路径保留旧行为：参考编辑失败时退化为文生图 */
            ...(params.kind !== "agent" ? { allow_generation_fallback: true } : {}),
          });
        const urls = (payload.data?.images || []).map((item) => String(item.public_url || "")).filter(Boolean);
        removePlaceholder(placeholderId);
        const targetAspect = params.aspect || aspect;
        for (const url of urls) {
          let finalSrc = targetAspect === "16:9" || targetAspect === "9:16" ? await cropToAspect(url, targetAspect) : url;
          if (params.transparent) finalSrc = await solidBackgroundToAlpha(finalSrc);
          await placeImageOnCanvas(finalSrc, params.outputName || "generated");
        }
        pushHistory({
          kind: params.kind === "agent" ? "agent-images" : "images",
          prompt: params.prompt,
          outputs: urls.map((url) => ({ url })),
        });
        if (payload.data?.policy_fallback) {
          pushMessage({ role: "assistant", kind: "模型切换", text: "默认图像模型的安全审核拦截了这次请求，已自动改用备用图像模型完成。" });
        }
        return urls;
      } finally {
        removePlaceholder(placeholderId);
      }
    },
    [apiAsyncImages, aspect, audience, brandKit.logoRef, brandText, count, createPlaceholder, designMemoryText, negativePrompt, placeImageOnCanvas, pushHistory, pushMessage, removePlaceholder, style],
  );

  const doFontRestyle = useCallback(
    async (params: {
      src: string;
      newText: string;
      note?: string;
      lineEdits?: FontLineEdit[];
      /** When true and every edited line has a bbox, use mask-local inpaint (partial line edit). */
      useLocalMask?: boolean;
    }) => {
      const imageB64 = await srcToDataUrl(params.src);
      const placeholderId = createPlaceholder("同风格改字");
      try {
        const edits = params.lineEdits || [];
        const boxedEdits = edits.filter(
          (line) => line.box && line.box.length === 4 && line.to.trim() && line.to.trim() !== line.from.trim(),
        );
        // Partial-line + bbox → mask inpaint (non-text area stays pixel-identical after composite)
        if (params.useLocalMask && boxedEdits.length && boxedEdits.length === edits.length) {
          const img = await loadImage(imageB64);
          const w = img.naturalWidth || img.width;
          const h = img.naturalHeight || img.height;
          const paint = paintCanvasFromBoxes(
            w,
            h,
            boxedEdits.map((line) => line.box as [number, number, number, number]),
          );
          const base = document.createElement("canvas");
          base.width = w;
          base.height = h;
          base.getContext("2d")?.drawImage(img, 0, 0, w, h);
          const baseB64 = base.toDataURL("image/png");
          // OpenAI mask: transparent = repaint
          const openaiMask = document.createElement("canvas");
          openaiMask.width = w;
          openaiMask.height = h;
          const mctx = openaiMask.getContext("2d");
          if (!mctx) throw new Error("canvas unavailable");
          mctx.fillStyle = "#000";
          mctx.fillRect(0, 0, w, h);
          mctx.globalCompositeOperation = "destination-out";
          mctx.drawImage(paint, 0, 0);
          const maskB64 = openaiMask.toDataURL("image/png");
          const instructionParts = boxedEdits.map(
            (line) => `把此区域内的文字「${line.from}」替换为「${line.to}」`,
          );
          const instruction = [
            instructionParts.join("；") + "。",
            "逐笔画沿用原字体设计（骨架、笔画粗细、材质、颜色、描边、投影）。",
            "区域外保持原样，不得改变背景与未遮罩区域的任何像素。",
            params.note ? `补充：${params.note}` : "",
          ]
            .filter(Boolean)
            .join("");

          let resultImg: HTMLImageElement | null = null;
          try {
            const payload = await apiAsyncImages<{ image_b64?: string }>("/inpaint", {
              image_b64: baseB64,
              mask_b64: maskB64,
              instruction,
              size: inpaintSizeFor(w, h),
            });
            const b64 = payload.data?.image_b64;
            if (b64) resultImg = await loadImage(b64);
          } catch {
            /* fall through to whole-image path */
          }
          if (resultImg) {
            const composed = compositeByMask(img, resultImg, paint);
            removePlaceholder(placeholderId);
            await placeImageOnCanvas(composed, `font-local-${boxedEdits.map((l) => l.to).join("-").slice(0, 40)}`);
            pushHistory({
              kind: "font-restyle-local",
              prompt: boxedEdits.map((l) => `${l.from}→${l.to}`).join("、"),
              outputs: [{ url: composed }],
            });
            return [composed];
          }
          // inpaint failed → fall through to full-image font-restyle
        }

        const payload = await apiAsyncImages("/font-restyle", {
          image_b64: imageB64,
          new_text: params.newText,
          style_note: params.note || "",
          ...(edits.length
            ? { line_edits: edits.map(({ from, to }) => ({ from, to })) }
            : {}),
          aspect_ratio: aspect,
          n: 1,
        });
        const urls = (payload.data?.images || []).map((item) => String(item.public_url || "")).filter(Boolean);
        removePlaceholder(placeholderId);
        for (const url of urls) await placeImageOnCanvas(url, `font-${params.newText || "line-edit"}`);
        pushHistory({ kind: "font-restyle", prompt: params.newText || "逐行改字", outputs: urls.map((url) => ({ url })) });
        return urls;
      } finally {
        removePlaceholder(placeholderId);
      }
    },
    [apiAsyncImages, aspect, createPlaceholder, placeImageOnCanvas, pushHistory, removePlaceholder],
  );

  const doMaterialTransfer = useCallback(
    async (params: { target: string; material: string; instruction?: string }) => {
      const composite = await compositeTargetWithSwatch(await srcToDataUrl(params.target), await srcToDataUrl(params.material));
      const payload = await apiAsyncImages("/material-transfer", {
        image_b64: composite,
        instruction: params.instruction || "",
        aspect_ratio: aspect,
        n: 1,
      });
      const urls = (payload.data?.images || []).map((item) => String(item.public_url || "")).filter(Boolean);
      for (const url of urls) await placeImageOnCanvas(url, "material");
      pushHistory({ kind: "material-transfer", prompt: params.instruction || "材质复刻", outputs: urls.map((url) => ({ url })) });
      return urls;
    },
    [apiAsyncImages, aspect, placeImageOnCanvas, pushHistory],
  );

  /* 指令式图片编辑：参考图 + 指令重绘（Quick Edit / Upscale / Remove BG / Eraser / Multi-Angles 共用管线） */
  const doImageEdit = useCallback(
    async (params: { src: string; instruction: string; kind: string; count?: number; transparent?: boolean }) => {
      const referenceImage = await srcToDataUrl(params.src);
      const placeholderId = createPlaceholder("修改图片");
      try {
        const payload = await apiAsyncImages("/images", {
            prompt: `严格以参考图为基础重绘：${params.instruction}。除指令要求的修改外，主体、构图、风格、配色、文字内容全部保持与参考图一致。`,
            raw_prompt: `严格以参考图为基础重绘：${params.instruction}。除指令要求的修改外，主体、构图、风格、配色、文字内容全部保持与参考图一致。`,
            aspect_ratio: aspect,
            n: Math.max(1, Math.min(4, params.count || 1)),
            ...(params.transparent ? { background: "transparent" } : {}),
            reference_images: [referenceImage],
          });
        const urls = (payload.data?.images || []).map((item) => String(item.public_url || "")).filter(Boolean);
        removePlaceholder(placeholderId);
        const placed: string[] = [];
        for (const url of urls) {
          const finalSrc = params.transparent ? await solidBackgroundToAlpha(url) : url;
          await placeImageOnCanvas(finalSrc, params.kind);
          placed.push(finalSrc);
        }
        pushHistory({ kind: params.kind, prompt: params.instruction, outputs: urls.map((url) => ({ url })) });
        return placed;
      } finally {
        removePlaceholder(placeholderId);
      }
    },
    [apiAsyncImages, aspect, createPlaceholder, placeImageOnCanvas, pushHistory, removePlaceholder],
  );

  /* GPU 专业抠图（BiRefNet）；503/失败时降级到 doImageEdit remove-bg */
  const doGpuMatting = useCallback(
    async (src: string) => {
      const imageB64 = await srcToDataUrl(src);
      const placeholderId = createPlaceholder("GPU 抠图");
      try {
        const payload = await apiAsyncImages<{
          image?: { public_url?: string; has_alpha?: boolean };
          backend?: string;
        }>("/matting", { image_b64: imageB64 });
        const url = String(payload.data?.image?.public_url || "").trim();
        if (!url) throw new Error("GPU 抠图未返回图片");
        removePlaceholder(placeholderId);
        await placeImageOnCanvas(url, "remove-bg-gpu");
        pushHistory({ kind: "remove-bg-gpu", prompt: "GPU BiRefNet matting", outputs: [{ url }] });
        return { urls: [url], degraded: false as const };
      } catch (error) {
        removePlaceholder(placeholderId);
        const message = error instanceof Error ? error.message : String(error);
        // 503 / not configured / network → fall back to GPT remove-bg path
        if (/503|not configured|GPU ComfyUI|fetch failed|Failed to fetch|timed out|超时/i.test(message)) {
          const urls = await doImageEdit({
            src,
            instruction: "完整保留主体，把背景替换为纯白色（#FFFFFF）纯净平涂，无阴影无渐变，主体边缘干净利落，主体本身完全不变",
            kind: "remove-bg",
            transparent: true,
          });
          return { urls, degraded: true as const };
        }
        throw error;
      }
    },
    [apiAsyncImages, createPlaceholder, doImageEdit, placeImageOnCanvas, pushHistory, removePlaceholder],
  );

  /* GPU 语义拆层（SAM2）；失败时不破坏原有拆分图层能力 */
  const doGpuSegment = useCallback(
    async (src: string) => {
      const imageB64 = await srcToDataUrl(src);
      const placeholderId = createPlaceholder("智能拆层");
      try {
        const payload = await apiAsyncImages<{
          segments?: Array<{ id?: string; cutout_url?: string | null; mask_url?: string | null }>;
          overlay_url?: string | null;
          backend?: string;
        }>("/segment", { image_b64: imageB64, max_segments: 8 });
        const data = payload.data || {};
        const urls: string[] = [];
        if (data.overlay_url) urls.push(String(data.overlay_url));
        for (const segment of data.segments || []) {
          const cutout = String(segment.cutout_url || "").trim();
          const mask = String(segment.mask_url || "").trim();
          if (cutout && !urls.includes(cutout)) urls.push(cutout);
          else if (mask && !urls.includes(mask)) urls.push(mask);
        }
        const unique = Array.from(new Set(urls.filter(Boolean)));
        if (!unique.length) throw new Error("GPU 拆层未返回图层");
        removePlaceholder(placeholderId);
        for (const url of unique.slice(0, 8)) {
          await placeImageOnCanvas(url, "segment-gpu");
        }
        pushHistory({
          kind: "segment-gpu",
          prompt: "GPU SAM2 segment",
          outputs: unique.map((url) => ({ url })),
        });
        return { urls: unique, count: unique.length, degraded: false as const };
      } catch (error) {
        removePlaceholder(placeholderId);
        throw error;
      }
    },
    [apiAsyncImages, createPlaceholder, placeImageOnCanvas, pushHistory, removePlaceholder],
  );

  /* ---------- 真 mask inpaint：edits 优先，降级为参考图重绘；两条路径都做像素级合成（mask 外原图无损） ---------- */

  const initMaskEditor = useCallback(async (src: string) => {
    const dataUrl = await srcToDataUrl(src);
    const img = await loadImage(dataUrl);
    maskImgRef.current = img;
    const paint = document.createElement("canvas");
    const scale = Math.min(1, 1024 / Math.max(img.naturalWidth, img.naturalHeight));
    paint.width = Math.round(img.naturalWidth * scale);
    paint.height = Math.round(img.naturalHeight * scale);
    maskPaintRef.current = paint;
    setMaskHasPaint(false);
    const view = maskViewRef.current;
    if (!view) return;
    const viewW = Math.min(440, paint.width);
    view.width = viewW;
    view.height = Math.round((paint.height / paint.width) * viewW);
    const ctx = view.getContext("2d");
    if (ctx) ctx.drawImage(img, 0, 0, view.width, view.height);
  }, []);

  const redrawMaskView = useCallback(() => {
    const view = maskViewRef.current;
    const paint = maskPaintRef.current;
    const img = maskImgRef.current;
    if (!view || !paint || !img) return;
    const ctx = view.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, view.width, view.height);
    ctx.drawImage(img, 0, 0, view.width, view.height);
    ctx.globalAlpha = 0.45;
    ctx.drawImage(paint, 0, 0, view.width, view.height);
    ctx.globalAlpha = 1;
  }, []);

  const paintMaskAt = useCallback(
    (clientX: number, clientY: number) => {
      const view = maskViewRef.current;
      const paint = maskPaintRef.current;
      if (!view || !paint) return;
      const rect = view.getBoundingClientRect();
      const scaleX = paint.width / rect.width;
      const scaleY = paint.height / rect.height;
      const ctx = paint.getContext("2d");
      if (!ctx) return;
      ctx.fillStyle = "rgba(255,0,0,1)";
      ctx.beginPath();
      ctx.arc((clientX - rect.left) * scaleX, (clientY - rect.top) * scaleY, (maskBrush / 2) * scaleX, 0, Math.PI * 2);
      ctx.fill();
      setMaskHasPaint(true);
      redrawMaskView();
    },
    [maskBrush, redrawMaskView],
  );

  const doMaskInpaint = useCallback(
    async (instruction: string) => {
      const img = maskImgRef.current;
      const paint = maskPaintRef.current;
      if (!img || !paint) throw new Error("遮罩未初始化");
      const w = paint.width;
      const h = paint.height;
      /* 归一化底图 PNG */
      const base = document.createElement("canvas");
      base.width = w;
      base.height = h;
      base.getContext("2d")?.drawImage(img, 0, 0, w, h);
      const imageB64 = base.toDataURL("image/png");
      /* OpenAI 语义 mask：涂抹区透明=重绘 */
      const openaiMask = document.createElement("canvas");
      openaiMask.width = w;
      openaiMask.height = h;
      const mctx = openaiMask.getContext("2d");
      if (!mctx) throw new Error("canvas unavailable");
      mctx.fillStyle = "#000";
      mctx.fillRect(0, 0, w, h);
      mctx.globalCompositeOperation = "destination-out";
      mctx.drawImage(paint, 0, 0);
      const maskB64 = openaiMask.toDataURL("image/png");
      const finalInstruction = instruction.trim() || "移除遮罩区域内的内容，按周围内容自然补全";

      let resultImg: HTMLImageElement | null = null;
      let engine = "images/edits";
      try {
        const payload = await apiAsyncImages<{ image_b64?: string }>("/inpaint", {
          image_b64: imageB64,
          mask_b64: maskB64,
          instruction: finalInstruction,
          size: "1024x1024",
        });
        const b64 = payload.data?.image_b64;
        if (b64) resultImg = await loadImage(b64);
      } catch {
        /* relay 不支持 edits → 降级参考图重绘 */
      }
      if (!resultImg) {
        engine = "reference-repaint";
        const annotated = document.createElement("canvas");
        annotated.width = w;
        annotated.height = h;
        const actx = annotated.getContext("2d");
        if (!actx) throw new Error("canvas unavailable");
        actx.drawImage(img, 0, 0, w, h);
        actx.globalAlpha = 0.45;
        actx.drawImage(paint, 0, 0);
        actx.globalAlpha = 1;
        const payload = await apiAsyncImages("/images", {
          prompt: `参考图中红色半透明标记的区域需要重绘：${finalInstruction}。未标记区域保持与参考图完全一致。输出图中不得出现任何红色标记。`,
          raw_prompt: `参考图中红色半透明标记的区域需要重绘：${finalInstruction}。未标记区域保持与参考图完全一致。输出图中不得出现任何红色标记。`,
          aspect_ratio: w >= h ? (w === h ? "1:1" : "3:2") : "2:3",
          n: 1,
          reference_images: [annotated.toDataURL("image/png")],
        });
        const url = (payload.data?.images || []).map((item) => String(item.public_url || "")).find(Boolean);
        if (!url) throw new Error("重绘失败：无输出");
        resultImg = await loadImage(await srcToDataUrl(url));
      }
      const composed = compositeByMask(img, resultImg, paint);
      await placeImageOnCanvas(composed, "inpaint");
      pushHistory({ kind: `inpaint(${engine})`, prompt: finalInstruction, outputs: [] });
      return composed;
    },
    [apiAsyncImages, placeImageOnCanvas, pushHistory],
  );

  /* ---------- 可视化拆层：矢量化按颜色分组 → 每层独立可拖拽 shape ---------- */
  const splitSelectedToLayers = useCallback(
    async (src: string) => {
      const dataUrl = await srcToDataUrl(src);
      const mod = (await import("imagetracerjs")) as unknown as {
        default: { imageToSVG: (url: string, cb: (svg: string) => void, preset?: string) => void };
      };
      const svg = await new Promise<string>((resolve) => mod.default.imageToSVG(dataUrl, resolve, "posterized2"));
      const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
      const root = doc.documentElement;
      const width = root.getAttribute("width") || "1024";
      const height = root.getAttribute("height") || "1024";
      const viewBox = root.getAttribute("viewBox") || `0 0 ${width} ${height}`;
      const groups = new Map<string, string[]>();
      for (const path of Array.from(doc.querySelectorAll("path"))) {
        const fill = `${path.getAttribute("fill") || "none"}/${path.getAttribute("opacity") || "1"}`;
        const markup = path.outerHTML;
        groups.set(fill, [...(groups.get(fill) || []), markup]);
      }
      /* 按内容量排序，最多 8 层（其余并入最后一层），跳过近全透明组 */
      const sorted = [...groups.entries()]
        .filter(([key]) => !key.endsWith("/0"))
        .sort((a, b) => b[1].join("").length - a[1].join("").length);
      const kept = sorted.slice(0, 8);
      const rest = sorted.slice(8).flatMap(([, paths]) => paths);
      if (rest.length && kept.length) kept[kept.length - 1][1].push(...rest);
      let placed = 0;
      for (const [, paths] of kept) {
        const layerSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${viewBox}">${paths.join("")}</svg>`;
        const layerUrl = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(layerSvg)))}`;
        await placeImageOnCanvas(layerUrl, "layer");
        placed += 1;
      }
      pushHistory({ kind: "split-layers", prompt: `拆分为 ${placed} 个图层`, outputs: [] });
      return placed;
    },
    [placeImageOnCanvas, pushHistory],
  );

  /* --------------------------- vector export ------------------------ */

  const getExportSvg = useCallback(async () => {
    if (!editor) return null;
    const selected = editor.getSelectedShapeIds();
    const ids = selected.length ? selected : [...editor.getCurrentPageShapeIds()];
    if (!ids.length) {
      setError("画布上还没有内容");
      return null;
    }
    return await editor.getSvgString(ids, { background: false, padding: 24, scale: 1 });
  }, [editor]);

  const exportSvgFile = useCallback(async () => {
    const result = await getExportSvg();
    if (!result) return false;
    saveBlob(new Blob([result.svg], { type: "image/svg+xml" }), "studio-canvas.svg");
    return true;
  }, [getExportSvg]);

  const exportAiFile = useCallback(async () => {
    const result = await getExportSvg();
    if (!result) return false;
    setBusy(true);
    setBusyLabel("导出 .ai");
    try {
      const { jsPDF } = await import("jspdf");
      await import("svg2pdf.js");
      const element = new DOMParser().parseFromString(result.svg, "image/svg+xml").documentElement;
      const pdf = new jsPDF({
        unit: "pt",
        format: [result.width, result.height],
        orientation: result.width >= result.height ? "landscape" : "portrait",
      });
      await (
        pdf as unknown as { svg: (el: Element, opts: Record<string, number>) => Promise<unknown> }
      ).svg(element, { x: 0, y: 0, width: result.width, height: result.height });
      saveBlob(pdf.output("blob"), "studio-canvas.ai");
      return true;
    } finally {
      setBusy(false);
      setBusyLabel("");
    }
  }, [getExportSvg]);

  const vectorizeSrc = useCallback(
    async (src: string) => {
      setBusy(true);
      setBusyLabel("矢量化");
      try {
        const dataUrl = await srcToDataUrl(src);
        const mod = (await import("imagetracerjs")) as unknown as {
          default: { imageToSVG: (url: string, cb: (svg: string) => void, preset?: string) => void };
        };
        const svg = await new Promise<string>((resolve) => mod.default.imageToSVG(dataUrl, resolve, "posterized2"));
        saveBlob(new Blob([svg], { type: "image/svg+xml" }), "studio-vectorized.svg");
        /* 同时以矢量 asset 落画布，可无损缩放 */
        const svgDataUrl = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
        await placeImageOnCanvas(svgDataUrl, "vectorized");
        pushHistory({ kind: "vectorize", prompt: "位图矢量化（已下载 + 落画布）", outputs: [] });
        return svgDataUrl;
      } finally {
        setBusy(false);
        setBusyLabel("");
      }
    },
    [placeImageOnCanvas, pushHistory],
  );

  const vectorizeSelected = useCallback(async () => {
    const src = selectionRef.current.images[0];
    if (!src) {
      setError("先选中一张图片再矢量化");
      return false;
    }
    await vectorizeSrc(src);
    return true;
  }, [vectorizeSrc]);

  /* --------------------------- agent loop --------------------------- */

  /* ---- image registry: stable #ids for every picture the agent can point at ---- */

  const registerImage = useCallback(
    async (src: string, source: TurnImageSource, label: string, turn: number, size?: { width: number; height: number }) => {
      const existing = imageRegistryRef.current.find((item) => item.src === src);
      if (existing) return existing;
      let width = size?.width || 0;
      let height = size?.height || 0;
      if (!width || !height) {
        try {
          const img = await loadImage(src);
          width = img.naturalWidth || 0;
          height = img.naturalHeight || 0;
        } catch {
          /* dimensions optional */
        }
      }
      const entry: TurnImage = { id: imageRegistryRef.current.length + 1, src, label, source, width, height, turn };
      imageRegistryRef.current = [...imageRegistryRef.current, entry];
      return entry;
    },
    [],
  );

  const imageById = useCallback((value: unknown): TurnImage | null => {
    const id = Number(value);
    if (!Number.isFinite(id)) return null;
    return imageRegistryRef.current.find((item) => item.id === id) || null;
  }, []);

  /** Outputs of a tool become "上一版成品" and the default subject of the next turn (Lovart chip behaviour). */
  const registerOutputs = useCallback(
    async (urls: string[], name: string) => {
      const turn = turnCounterRef.current;
      const entries: TurnImage[] = [];
      for (const [index, url] of urls.entries()) {
        const label = urls.length > 1 ? `成品·${name}·${index + 1}` : `成品·${name}`;
        entries.push(await registerImage(url, "output", label, turn));
      }
      if (entries.length) lastOutputsRef.current = entries.map((entry) => entry.id);
      setContextChips(urls.slice(0, 2));
      return entries;
    },
    [registerImage],
  );

  /** Resolve this turn's pictures in Lovart order: composer attachments → selected canvas images → last output. */
  const collectTurnImages = useCallback(async () => {
    const turn = turnCounterRef.current;
    const seen = new Set<string>();
    const result: Array<{ entry: TurnImage; ordinal: number }> = [];
    let ordinal = 0;
    for (const attachment of attachmentsRef.current) {
      if (seen.has(attachment.src)) continue;
      seen.add(attachment.src);
      const entry = await registerImage(attachment.src, "attached", `第${turn}轮·图${cnOrdinal(ordinal)}`, turn, attachment);
      result.push({ entry, ordinal });
      ordinal += 1;
    }
    for (const src of selectionRef.current.images) {
      if (seen.has(src)) continue;
      seen.add(src);
      const known = imageRegistryRef.current.find((item) => item.src === src);
      const entry = known || (await registerImage(src, "selected", `第${turn}轮·图${cnOrdinal(ordinal)}（画布选中）`, turn));
      result.push({ entry, ordinal });
      ordinal += 1;
    }
    if (!result.length) {
      for (const id of lastOutputsRef.current) {
        const entry = imageRegistryRef.current.find((item) => item.id === id);
        if (entry && !seen.has(entry.src)) {
          seen.add(entry.src);
          result.push({ entry, ordinal: -1 });
        }
      }
    }
    return result;
  }, [registerImage]);

  const buildAgentCanvasState = useCallback(
    (plan?: DesignPlan) => {
      const sel = selectionRef.current;
      const registry = imageRegistryRef.current.slice(-30);
      return {
        selectedImageCount: sel.images.length,
        canvasShapeCount: shapeCount,
        currentTurn: turnCounterRef.current,
        images: registry.map((item) => ({
          id: item.id,
          label: item.label,
          source: item.source,
          turn: item.turn,
          width: item.width,
          height: item.height,
          aspect: aspectFromSize(item.width, item.height),
        })),
        lastOutputIds: lastOutputsRef.current,
        defaults: { style, aspect, count, brand: brandText, audience, negativePrompt },
        brand_kit:
          brandKit.name || brandKit.palette.length || brandKit.styleWords || brandKit.fontHint || brandKit.logoRef
            ? {
                name: brandKit.name,
                palette: brandKit.palette,
                styleWords: brandKit.styleWords,
                fontHint: brandKit.fontHint,
                hasLogo: Boolean(brandKit.logoRef),
              }
            : undefined,
        design_memory: designMemoryText
          ? {
              mode: "default_skill",
              overridePolicy: "Only an explicit instruction in the current request may override the corresponding rule; silence is not an override.",
              profile: designMemory.profile,
              brands: designMemory.brands,
              visualStyle: designMemory.visualStyle,
              logoRules: designMemory.logoRules,
              collaborationRules: designMemory.collaborationRules,
              workflow: designMemory.workflow,
              avoid: designMemory.avoid,
            }
          : undefined,
        design_plan: plan
          ? {
              title: plan.title,
              action: plan.action,
              summary: plan.summary,
              decisions: plan.decisions,
              finalPrompt: plan.finalPrompt,
              negativePrompt: plan.negativePrompt,
            }
          : undefined,
      };
    },
    [aspect, audience, brandKit, brandText, count, designMemory, designMemoryText, negativePrompt, shapeCount, style],
  );

  const requestDesignPlan = useCallback(
    async (sourceText: string) => {
      const rawResponse = await fetch("/api/agent-chat", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({
          mode: "plan",
          messages: oaiHistoryRef.current,
          model: agentModelForText(sourceText),
          canvas_state: buildAgentCanvasState(),
        }),
      });
      const response = (await rawResponse.json().catch(() => ({}))) as {
        detail?: string;
        data?: { plan?: unknown };
      };
      if (!rawResponse.ok) throw new Error(response?.detail || `前置设计规划失败 ${rawResponse.status}`);
      if (!response.data?.plan) throw new Error("前置设计规划未返回方案");
      return normalizeDesignPlan(response.data.plan, sourceText);
    },
    [buildAgentCanvasState, token],
  );

  const lastUserTextOf = useCallback(() => {
    const last = [...oaiHistoryRef.current].reverse().find((m) => m.role === "user") as { content?: unknown } | undefined;
    const content = last?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return (content as OaiContentPart[]).map((part) => (part.type === "text" ? part.text : "")).join("\n");
    }
    return "";
  }, []);

  const imageModelFromMentions = useCallback(
    (text: string, hint?: unknown) => {
      const explicit = String(hint || "").trim();
      if (/@Image-2\b/i.test(text)) return "gpt-image-2";
      if (/@Image-1\.5/i.test(text)) return "gpt-image-1.5";
      if (/@Seedream/i.test(text)) return "seedream-4-5";
      if (["gpt-image-2", "gpt-image-1.5", "seedream-4-5"].includes(explicit)) return explicit;
      return currentPlanRef.current?.imageModelHint;
    },
    [],
  );

  const qualityFromMentions = (text: string, requested?: unknown, fallback = "medium") => {
    if (/@高画质/.test(text)) return "high";
    if (/@中画质/.test(text)) return "medium";
    if (/@低画质/.test(text)) return "low";
    const value = String(requested || "").toLowerCase();
    return ["low", "medium", "high"].includes(value) ? value : fallback;
  };

  const toolFailure = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const kind = /content_policy|content policy|policy violation|moderation|safety/i.test(message) ? "content_policy" : "upstream";
    return `失败（error_kind=${kind}）：${message.slice(0, 600)}`;
  };

  const execAgentTool = useCallback(
    async (name: string, args: Record<string, unknown>) => {
      const sel = selectionRef.current;
      const lastUserText = lastUserTextOf();
      const resolveSrc = (value: unknown, fallbackToSelection = true) => {
        const entry = imageById(value);
        if (entry) return entry;
        const lastOutput = lastOutputsRef.current
          .map((id) => imageRegistryRef.current.find((item) => item.id === id))
          .find(Boolean);
        if (fallbackToSelection && sel.images[0]) {
          const known = imageRegistryRef.current.find((item) => item.src === sel.images[0]);
          if (known) return known;
        }
        return lastOutput || null;
      };
      switch (name) {
        case "edit_images": {
          const base = resolveSrc(args.base_image);
          if (!base) return "失败：找不到主图。请让用户先附上要修改的图片（对话框 + 号或直接粘贴），或在画布上选中它。";
          const refIds = Array.isArray(args.reference_images) ? args.reference_images : [];
          const refs = refIds
            .map((id) => imageById(id))
            .filter((entry): entry is TurnImage => Boolean(entry && entry.id !== base.id));
          const requestedAspect = String(args.aspect || "auto");
          const targetAspect = aspectOptions.includes(requestedAspect) ? requestedAspect : aspectFromSize(base.width, base.height);
          const requestedCount = Number(args.count);
          const outputName = String(args.output_name || "").trim() || "编辑图片";
          const urls = await doGenerateImages({
            prompt: String(args.prompt || ""),
            aspect: targetAspect,
            count: Number.isFinite(requestedCount) && requestedCount > 0 ? Math.min(4, requestedCount) : 1,
            quality: qualityFromMentions(lastUserText, args.quality, "medium"),
            refs: [base.src, ...refs.map((entry) => entry.src)],
            transparent: Boolean(args.transparent_background),
            imageModel: imageModelFromMentions(lastUserText, args.model_hint),
            kind: "agent",
            outputName,
          });
          const entries = await registerOutputs(urls, outputName);
          pushMessage({ role: "assistant", kind: outputName, images: urls });
          return `已完成 ${outputName}：生成 ${urls.length} 张，成品编号 ${entries.map((entry) => `#${entry.id}`).join("、")}，画幅 ${targetAspect}，主图 #${base.id}${
            refs.length ? `，参考图 ${refs.map((entry) => `#${entry.id}`).join("、")}` : ""
          }。链接：\n${urls.join("\n")}`;
        }
        case "generate_images": {
          const refIds = Array.isArray(args.reference_images) ? args.reference_images : [];
          const refs = refIds.map((id) => imageById(id)).filter((entry): entry is TurnImage => Boolean(entry));
          const agentRefs = [...refs.map((entry) => entry.src), ...(brandKit.logoRef ? [brandKit.logoRef] : [])];
          /* Logo mark floor: prompt rules ask high/count=3; soft-enforce if model omits them. */
          const logoMarkBrief = /(?:logo|标志|徽标|商标|字母标|品牌标|\bicon\b|\bmark\b|图标)/i.test(
            `${lastUserText}\n${String(args.prompt || "")}`,
          );
          const requestedCount = args.count != null ? Number(args.count) : NaN;
          const genCount = logoMarkBrief
            ? Math.max(3, Math.min(4, Number.isFinite(requestedCount) && requestedCount > 0 ? requestedCount : 3))
            : Number.isFinite(requestedCount) && requestedCount > 0
              ? Math.min(4, requestedCount)
              : 1;
          const outputName = String(args.output_name || "").trim() || "生成图片";
          const urls = await doGenerateImages({
            imageModel: imageModelFromMentions(lastUserText, args.model_hint),
            prompt: String(args.prompt || ""),
            aspect: args.aspect && aspectOptions.includes(String(args.aspect)) ? String(args.aspect) : "1:1",
            count: genCount,
            quality: qualityFromMentions(lastUserText, args.quality, logoMarkBrief ? "high" : "medium"),
            negativePrompt: args.negative_prompt ? String(args.negative_prompt) : undefined,
            transparent: Boolean(args.transparent_background),
            refs: agentRefs.length ? agentRefs : undefined,
            kind: "agent",
            outputName,
          });
          const entries = await registerOutputs(urls, outputName);
          pushMessage({ role: "assistant", kind: outputName, images: urls });
          return `已生成 ${urls.length} 张并放到画布，成品编号 ${entries.map((entry) => `#${entry.id}`).join("、")}。链接：\n${urls.join("\n")}`;
        }
        case "remove_background": {
          const target = resolveSrc(args.image);
          if (!target) return "失败：找不到要去底的图片，请让用户附图或选中。";
          const { urls, degraded } = await doGpuMatting(target.src);
          const entries = await registerOutputs(urls, "去底");
          pushMessage({ role: "assistant", kind: degraded ? "去底（重绘降级）" : "去底", images: urls });
          return `已去底：成品编号 ${entries.map((entry) => `#${entry.id}`).join("、")}${degraded ? "（GPU 抠图不可用，已用重绘去底）" : "（透明 PNG）"}。链接：\n${urls.join("\n")}`;
        }
        case "upscale_image": {
          const target = resolveSrc(args.image);
          if (!target) return "失败：找不到要放大的图片，请让用户附图或选中。";
          const scale = Number(args.scale) === 4 ? 4 : 2;
          const urls = await doGenerateImages({
            prompt: `高清放大 ${scale} 倍：以参考图为唯一基础，提升分辨率与细节清晰度（边缘更锐利、纹理更清楚、无噪点无模糊），内容、构图、姿势、颜色、线条、文字全部与原图完全一致，不新增、不删除、不重绘任何元素。`,
            aspect: aspectFromSize(target.width, target.height),
            count: 1,
            quality: "high",
            refs: [target.src],
            kind: "agent",
            outputName: `高清放大${scale}x`,
          });
          const entries = await registerOutputs(urls, `高清放大${scale}x`);
          pushMessage({ role: "assistant", kind: `高清放大 ${scale}x`, images: urls });
          return `已高清放大 ${scale} 倍：成品编号 ${entries.map((entry) => `#${entry.id}`).join("、")}。链接：\n${urls.join("\n")}`;
        }
        case "vectorize_image":
        case "vectorize_selected": {
          const target = resolveSrc(args.image);
          if (!target) return "失败：找不到要矢量化的图片，请让用户附图或选中。";
          const svgSrc = await vectorizeSrc(target.src);
          const entry = await registerImage(svgSrc, "output", "成品·矢量SVG", turnCounterRef.current, { width: target.width, height: target.height });
          pushMessage({ role: "assistant", kind: "矢量化", text: `已转成矢量 SVG（成品 #${entry.id}），文件已开始下载并放到画布。` });
          return `矢量化完成：成品编号 #${entry.id}，SVG 已下载并放到画布。矢量化只提取描边轮廓，颗粒纹理会被平滑为纯色路径。`;
        }
        case "restyle_lettering": {
          const target = resolveSrc(args.image);
          if (!target) return "失败：找不到包含字体设计的图片，请让用户附图或选中。";
          const urls = await doFontRestyle({
            src: target.src,
            newText: String(args.new_text || ""),
            note: args.style_note ? String(args.style_note) : "",
          });
          const entries = await registerOutputs(urls, "同风格改字");
          pushMessage({ role: "assistant", kind: "同风格改字", images: urls });
          return `改字完成，成品编号 ${entries.map((entry) => `#${entry.id}`).join("、")}。链接：\n${urls.join("\n")}`;
        }
        case "transfer_material": {
          const targetEntry = imageById(args.target_image);
          const materialEntry = imageById(args.material_image);
          const target = targetEntry?.src || sel.images[0];
          const material = materialEntry?.src || sel.images[1];
          if (!target || !material) return "失败：需要两张图（目标图案 + 材质样本），请让用户附上两张或同时选中两张。";
          const urls = await doMaterialTransfer({ target, material, instruction: args.instruction ? String(args.instruction) : "" });
          const entries = await registerOutputs(urls, "材质复刻");
          pushMessage({ role: "assistant", kind: "材质复刻", images: urls });
          return `材质复刻完成，成品编号 ${entries.map((entry) => `#${entry.id}`).join("、")}。链接：\n${urls.join("\n")}`;
        }
        case "edit_selected_image": {
          /* legacy alias kept for older sessions */
          const target = resolveSrc(undefined);
          if (!target) return "失败：画布上没有选中的图片，请提醒用户先附图或选中要修改的图片。";
          const urls = await doGenerateImages({
            prompt: `严格以参考图为基础重绘：${String(args.instruction || "")}。除指令要求的修改外，主体、构图、风格、配色、文字内容全部保持与参考图一致。`,
            aspect: aspectFromSize(target.width, target.height),
            count: 1,
            quality: "medium",
            refs: [target.src],
            kind: "agent",
            outputName: "修改图片",
          });
          const entries = await registerOutputs(urls, "修改图片");
          pushMessage({ role: "assistant", kind: "图片修改", images: urls });
          return `修改完成，成品编号 ${entries.map((entry) => `#${entry.id}`).join("、")}。链接：\n${urls.join("\n")}`;
        }
        case "image_to_video": {
          return "视频功能已迁移到独立页面 /video（画布右上角「视频」入口，或直接打开 /video）。请明确告诉用户：去 /video 上传首帧图并描述运动即可提交图生视频任务；本对话无法直接提交视频 job。";
        }
        case "export_ai": {
          const ok = await exportAiFile();
          return ok ? ".ai 文件已开始下载（PDF 兼容，Illustrator 可直接打开）。" : "失败：画布上还没有内容。";
        }
        default:
          return `未知工具 ${name}`;
      }
    },
    [brandKit.logoRef, doFontRestyle, doGenerateImages, doGpuMatting, doMaterialTransfer, exportAiFile, imageById, imageModelFromMentions, lastUserTextOf, pushMessage, registerImage, registerOutputs, vectorizeSrc],
  );

  const sendToAgent = useCallback(async () => {
    const text = prompt.trim();
    const hasAttachments = attachmentsRef.current.length > 0;
    if ((!text && !hasAttachments) || agentBusy) return;
    const requestedModel = agentModelForText(text);
    setPrompt("");
    setShowMentionMenu(false);
    setError("");
    turnCounterRef.current += 1;
    setAgentBusy(true);
    try {
      const turnImages = await collectTurnImages();
      const attachedOrSelected = turnImages.filter((item) => item.ordinal >= 0);
      const defaultSubjects = turnImages.filter((item) => item.ordinal < 0);
      const userText = text || "（仅附图，无文字）";
      const thumbs = await Promise.all(attachedOrSelected.map((item) => downscaleForVision(item.entry.src, 160)));
      pushMessage({ role: "user", text: userText, images: thumbs });
      setAttachments([]);

      /* Lovart 同款图序说明：正文 + 括注（图一=#7 …），再附图片本身给视觉模型 */
      const mappingNote = attachedOrSelected.length
        ? `（本轮附图 ${attachedOrSelected.length} 张：${attachedOrSelected
            .map((item) => `图${cnOrdinal(item.ordinal)}=#${item.entry.id}${item.entry.source === "selected" ? "（画布选中）" : ""}`)
            .join("，")}）`
        : defaultSubjects.length
          ? `（本轮未附新图；默认操作对象为上一版成品 ${defaultSubjects.map((item) => `#${item.entry.id}`).join("、")}）`
          : "";
      const visionParts: OaiContentPart[] = [];
      for (const item of turnImages) {
        visionParts.push({ type: "image_url", image_url: { url: await downscaleForVision(item.entry.src, 768) } });
      }
      const userContent: string | OaiContentPart[] = visionParts.length
        ? [{ type: "text", text: `${userText}\n${mappingNote}` }, ...visionParts]
        : userText;
      oaiHistoryRef.current.push({ role: "user", content: userContent });

      /* 带图 = 编辑/续改流程：直接执行（Lovart 不为改图出方案）。无图的从零生成才走前置设计规划。 */
      let plan: DesignPlan | null = null;
      if (!turnImages.length) {
        const planActionId = pushMessage({ role: "action", label: "design_plan", done: false });
        try {
          plan = await requestDesignPlan(text);
        } catch (planError) {
          setMessages((prev) => prev.filter((message) => message.id !== planActionId));
          throw planError;
        }
        currentPlanRef.current = plan;
        setMessages((prev) => prev.map((message) => (message.id === planActionId && message.role === "action" ? { ...message, done: true } : message)));
        const visiblePlan = designPlanToVisibleText(plan);
        pushMessage({ role: "assistant", kind: "前置设计方案", text: visiblePlan });
        oaiHistoryRef.current.push({ role: "assistant", content: visiblePlan });
      } else {
        currentPlanRef.current = null;
      }

      for (let round = 0; (!plan || plan.action !== "answer") && round < AGENT_MAX_ROUNDS; round += 1) {
        const rawResponse = await fetch("/api/agent-chat", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({
            mode: "execute",
            messages: oaiHistoryRef.current,
            model: requestedModel,
            canvas_state: buildAgentCanvasState(plan || undefined),
          }),
        });
        const response = (await rawResponse.json().catch(() => ({}))) as {
          detail?: string;
          data?: { message: { content?: string | null; tool_calls?: OaiToolCall[] }; model?: string };
        };
        if (!rawResponse.ok) throw new Error(response?.detail || `Agent 请求失败 ${rawResponse.status}`);
        const assistant = response.data?.message;
        if (!assistant) throw new Error("Agent 未返回内容");
        const toolCalls = assistant.tool_calls || [];
        oaiHistoryRef.current.push({ role: "assistant", content: assistant.content ?? null, tool_calls: toolCalls.length ? toolCalls : undefined });
        const content = String(assistant.content || "").trim();
        if (content) pushMessage({ role: "assistant", kind: "Agent", text: content });
        if (!toolCalls.length) break;
        for (const call of toolCalls) {
          const actionId = uid();
          pushMessage({ id: actionId, role: "action", label: call.function.name, done: false });
          let result = "";
          try {
            const args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
            result = await execAgentTool(call.function.name, args);
          } catch (err) {
            result = toolFailure(err);
          }
          setMessages((prev) => prev.map((m) => (m.id === actionId && m.role === "action" ? { ...m, done: true } : m)));
          oaiHistoryRef.current.push({ role: "tool", tool_call_id: call.id, content: result });
        }
      }
      const original = "Youngtuo Visual Studio | AI 视觉生成工作台";
      document.title = "✅ Task Complete!";
      setTimeout(() => {
        document.title = original;
      }, 5000);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      pushMessage({ role: "assistant", kind: "error", error: message });
    } finally {
      setAgentBusy(false);
    }
  }, [agentBusy, buildAgentCanvasState, collectTurnImages, execAgentTool, prompt, pushMessage, requestDesignPlan, token]);

  /* --------------------------- ui handlers -------------------------- */

  const runAction = useCallback(
    async (label: string, fn: () => Promise<void>) => {
      if (busy) {
        setError(`「${busyLabel || "上一个任务"}」仍在进行中，请稍候`);
        return;
      }
      setBusy(true);
      setBusyLabel(label);
      setError("");
      try {
        await fn();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        pushMessage({ role: "assistant", kind: "error", error: message });
      } finally {
        setBusy(false);
        setBusyLabel("");
      }
    },
    [busy, busyLabel, pushMessage],
  );

  const generateVariation = useCallback(() => {
    const refs = selection.images.length ? selection.images : references;
    const text = prompt.trim() || "生成同主题变体，保持风格一致";
    const actionKind = selection.images.length ? "生成变体" : "生成图片";
    void runAction(actionKind, async () => {
      pushMessage({ role: "user", text });
      oaiHistoryRef.current.push({ role: "user", content: text });
      const planActionId = pushMessage({ role: "action", label: "design_plan", done: false });
      let plan: DesignPlan;
      try {
        plan = await requestDesignPlan(text);
      } catch (planError) {
        setMessages((prev) => prev.filter((message) => message.id !== planActionId));
        throw planError;
      }
      setMessages((prev) => prev.map((message) => (message.id === planActionId && message.role === "action" ? { ...message, done: true } : message)));
      const visiblePlan = designPlanToVisibleText(plan);
      pushMessage({ role: "assistant", kind: "前置设计方案", text: visiblePlan });
      oaiHistoryRef.current.push({ role: "assistant", content: visiblePlan });
      const urls = await doGenerateImages({
        prompt: plan.finalPrompt || text,
        negativePrompt: plan.negativePrompt,
        refs,
        kind: "variation",
        imageModel: plan.imageModelHint,
      });
      pushMessage({ role: "assistant", kind: actionKind, images: urls });
      oaiHistoryRef.current.push({ role: "assistant", content: `已按前置设计方案完成${actionKind}，生成 ${urls.length} 张图片。` });
    });
  }, [doGenerateImages, prompt, pushMessage, references, requestDesignPlan, runAction, selection.images]);

  /* 打开改字：预览转 dataURL（修裂图）+ 视觉识别行字（Lovart Edit Text 式逐行编辑） */
  const initFontDialog = useCallback(
    (src: string) => {
      setFontText("");
      setFontNote("");
      setFontLines(null);
      setFontOcr("loading");
      setFontDialog({ open: true, src });
      void (async () => {
        let preview = src;
        try {
          preview = await srcToDataUrl(src);
          setFontDialog((prev) => (prev.open && prev.src === src ? { ...prev, preview } : prev));
        } catch {
          /* keep original src */
        }
        try {
          const payload = await api<{
            lines?: string[];
            line_boxes?: Array<{ text?: string; box?: number[] }>;
          }>("/ocr-lines", {
            method: "POST",
            body: JSON.stringify({ image_b64: preview.startsWith("data:") ? preview : await srcToDataUrl(src) }),
          });
          const data = (payload.data || {}) as {
            lines?: string[];
            line_boxes?: Array<{ text?: string; box?: number[] }>;
          };
          const boxes = Array.isArray(data.line_boxes) ? data.line_boxes : [];
          const fromBoxes: FontLineEdit[] = [];
          for (const item of boxes) {
            const text = String(item.text || "").trim();
            if (!text) continue;
            const b = item.box;
            const entry: FontLineEdit = { from: text, to: text };
            if (Array.isArray(b) && b.length >= 4) {
              entry.box = [Number(b[0]), Number(b[1]), Number(b[2]), Number(b[3])];
            }
            fromBoxes.push(entry);
          }
          const lines = (data.lines || []).filter(Boolean);
          const mapped: FontLineEdit[] =
            fromBoxes.length > 0
              ? fromBoxes
              : lines.map((line) => ({ from: line, to: line }));
          if (mapped.length) {
            setFontLines(mapped);
            setFontOcr("done");
          } else {
            setFontOcr("failed");
          }
        } catch {
          setFontOcr("failed");
        }
      })();
    },
    [api],
  );

  const runFontRestyle = useCallback(() => {
    const src = fontDialog.src;
    const allLines = fontLines || [];
    const edits = allLines.filter((line) => line.to.trim() && line.to.trim() !== line.from.trim());
    const text = fontText.trim();
    if (!src || (!text && !edits.length)) return;
    setFontDialog({ open: false });
    // Partial line edits (not whole-image replace) + every edit has bbox → local mask path
    const isPartialLineEdit =
      edits.length > 0 &&
      !text &&
      allLines.length > edits.length &&
      edits.every((line) => line.box && line.box.length === 4);
    const summary = edits.length ? edits.map((line) => `“${line.from}”→“${line.to}”`).join("、") : `“${text}”`;
    void runAction("同风格改字", async () => {
      pushMessage({ role: "user", text: `同风格改字 → ${summary}${isPartialLineEdit ? "（局部 mask）" : ""}` });
      const urls = await doFontRestyle({
        src,
        newText: text,
        note: fontNote,
        lineEdits: edits,
        useLocalMask: isPartialLineEdit,
      });
      pushMessage({ role: "assistant", kind: "同风格改字", images: urls });
      setContextChips(urls.slice(0, 2));
    });
  }, [doFontRestyle, fontDialog.src, fontLines, fontNote, fontText, pushMessage, runAction]);

  const runMaterialTransfer = useCallback(() => {
    const first = materialDialog.a;
    const second = materialDialog.b;
    if (!first || !second) return;
    const target = materialSwap ? second : first;
    const material = materialSwap ? first : second;
    setMaterialDialog({ open: false });
    void runAction("材质复刻", async () => {
      pushMessage({ role: "user", text: `材质复刻${materialNote ? `：${materialNote}` : ""}` });
      const urls = await doMaterialTransfer({ target, material, instruction: materialNote });
      pushMessage({ role: "assistant", kind: "材质复刻", images: urls });
    });
  }, [doMaterialTransfer, materialDialog.a, materialDialog.b, materialNote, materialSwap, pushMessage, runAction]);

  /* ------------------------------ voice ----------------------------- */

  const toggleVoice = useCallback(() => {
    if (listening) {
      recognitionRef.current?.stop();
      return;
    }
    const globalWindow = window as unknown as {
      webkitSpeechRecognition?: new () => unknown;
      SpeechRecognition?: new () => unknown;
    };
    const Ctor = globalWindow.SpeechRecognition || globalWindow.webkitSpeechRecognition;
    if (!Ctor) {
      setError("当前浏览器不支持语音输入");
      return;
    }
    const recognition = new Ctor() as {
      lang: string;
      interimResults: boolean;
      continuous: boolean;
      onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
      onend: (() => void) | null;
      onerror: (() => void) | null;
      start: () => void;
      stop: () => void;
    };
    recognition.lang = "zh-CN";
    recognition.interimResults = false;
    recognition.continuous = true;
    recognition.onresult = (event) => {
      const chunks: string[] = [];
      for (let i = 0; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (result.isFinal) chunks.push(result[0].transcript);
      }
      if (chunks.length) setPrompt((prev) => `${prev}${prev ? " " : ""}${chunks.join(" ")}`);
    };
    recognition.onend = () => setListening(false);
    recognition.onerror = () => setListening(false);
    recognitionRef.current = recognition;
    recognition.start();
    setListening(true);
  }, [listening]);

  /* ------------------------------ derived --------------------------- */

  const selectedImageCount = selection.images.length;
  const composerHasText = prompt.trim().length > 0;
  const countdownTiles = useMemo(() => countdown.split(""), [countdown]);
  const hasConversation = messages.length > 0;
  /* Canvas selection rides along as extra numbered attachments (after explicit ones), minus duplicates. */
  const selectionAttachments = useMemo(() => {
    const attached = new Set(attachments.map((item) => item.src));
    return selection.images.filter((src) => !attached.has(src));
  }, [attachments, selection.images]);

  const applySkill = (chip: { label: string; prompt: string }) => {
    if (!chip.prompt) {
      setShowSkillsLib(true);
      return;
    }
    setPrompt((prev) => (prev ? `${prev}\n${chip.prompt}` : chip.prompt));
    composerRef.current?.focus();
  };

  const applyMention = (text: string) => {
    setPrompt((prev) => `${prev.replace(/@$/, "")}${text} `);
    setShowMentionMenu(false);
    composerRef.current?.focus();
  };

  const restoreHistoryImage = async (url: string) => {
    await placeImageOnCanvas(url, "history");
    setShowHistory(false);
  };

  if (!tokenLoaded) return <main className="lovartApp" />;

  /* ------------------------------ render ---------------------------- */

  return (
    <main className="lovartApp">
      {/* promo strip */}
      <header className="promoStrip">
        <div className="countdown" aria-label="promo countdown">
          {countdownTiles.map((digit, index) => (
            <span key={index} className="countGroup">
              <span className="countTile">{digit}</span>
              {index % 2 === 1 && index < 7 ? <span className="countColon">:</span> : null}
            </span>
          ))}
        </div>
        <p>🎉Seedream 5.0 Pro is here! Get up to 30 days of unlimited generation, plus up to 50% off upgrades</p>
        <button className="upgradeLink" type="button">
          Upgrade Now
        </button>
      </header>

      <div className="workbench">
        {/* canvas */}
        <section
          className="canvasPane"
          aria-label="infinite canvas"
          onContextMenuCapture={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setContextMenu({ open: true, x: event.clientX, y: event.clientY });
          }}
          onClick={() => {
            if (contextMenu.open) setContextMenu({ open: false, x: 0, y: 0 });
          }}
        >
          <div className="tldrawHost">
            <Tldraw
              key={activeProjectId}
              hideUi
              persistenceKey={persistenceKeyFor(activeProjectId)}
              assetUrls={FONT_ASSET_URLS}
              onMount={(instance) => setEditor(instance)}
            />
          </div>

          {contextMenu.open ? (
            <div className="contextMenu" style={{ left: contextMenu.x, top: contextMenu.y }}>
              {/* eslint-disable-next-line react-hooks/refs -- Mapping renders labels and click handlers; editor refs are read only when an action runs. */}
              {contextActions.map((action) => (
                <button
                  key={action.label}
                  type="button"
                  onClick={() => {
                    setContextMenu({ open: false, x: 0, y: 0 });
                    void action.run();
                  }}
                >
                  {action.label}
                </button>
              ))}
            </div>
          ) : null}

          {toolId === "draw" ? (
            <div className="brushBar">
              {brushColors.map((color) => (
                <button
                  key={color}
                  type="button"
                  title={color}
                  className={brushColor === color ? "brushSwatch on" : "brushSwatch"}
                  style={{ background: brushColorHex[color] }}
                  onClick={() => applyBrushColor(color)}
                />
              ))}
              <i className="dockDivider" />
              {brushSizes.map((size) => (
                <button
                  key={size.id}
                  type="button"
                  className={brushSize === size.id ? "brushSizeBtn on" : "brushSizeBtn"}
                  onClick={() => applyBrushSize(size.id)}
                >
                  {size.label}
                </button>
              ))}
            </div>
          ) : null}

          {toolId === "text" ? (
            <div className="brushBar textBar">
              {(
                [
                  { id: "draw" as const, label: "文楷", family: "tldraw_draw" },
                  { id: "sans" as const, label: "黑体", family: "tldraw_sans" },
                  { id: "serif" as const, label: "宋体", family: "tldraw_serif" },
                  { id: "mono" as const, label: "得意", family: "tldraw_mono" },
                ] as const
              ).map((font) => (
                <button
                  key={font.id}
                  type="button"
                  className={textFont === font.id ? "textFontBtn on" : "textFontBtn"}
                  style={{ fontFamily: font.family }}
                  title={font.label}
                  onClick={() => applyTextFont(font.id)}
                >
                  {font.label}
                </button>
              ))}
              <i className="dockDivider" />
              {brushColors.map((color) => (
                <button
                  key={`text-${color}`}
                  type="button"
                  title={color}
                  className={textColor === color ? "brushSwatch on" : "brushSwatch"}
                  style={{ background: brushColorHex[color] }}
                  onClick={() => applyTextColor(color)}
                />
              ))}
              <i className="dockDivider" />
              {brushSizes.map((size) => (
                <button
                  key={`text-size-${size.id}`}
                  type="button"
                  className={textSize === size.id ? "brushSizeBtn on" : "brushSizeBtn"}
                  onClick={() => applyTextSize(size.id)}
                >
                  {size.label}
                </button>
              ))}
            </div>
          ) : null}

          <div className="canvasTop">
            <div className="titleCluster">
              <button className="logoBadge" type="button" aria-label="home">
                <span>Lō</span>
              </button>
              <input
                ref={titleInputRef}
                className="titleInput"
                value={projectName}
                aria-label="project title"
                onChange={(event) => setProjectName(event.target.value)}
                onBlur={() => renameActiveProject(projectName)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    (event.target as HTMLInputElement).blur();
                  }
                }}
              />
              <button
                className={`syncStatusIcon ${syncStatus}`}
                type="button"
                title={
                  syncStatus === "synced"
                    ? "已同步到云端"
                    : syncStatus === "saving"
                      ? "正在保存到云端…"
                      : syncStatus === "error"
                        ? "云端同步失败，点此重试"
                        : "仅本地（变更后约 60s 自动保存）"
                }
                aria-label="cloud sync status"
                onClick={() => {
                  void saveCanvasToCloud();
                }}
              >
                {syncStatus === "synced" ? (
                  <CloudCheck size={15} />
                ) : syncStatus === "saving" ? (
                  <Loader2 size={15} className="spin" />
                ) : syncStatus === "error" ? (
                  <CloudOff size={15} />
                ) : (
                  <Cloud size={15} />
                )}
              </button>
              <button className="ghostIcon" type="button" aria-label="theme">
                <Palette size={15} />
              </button>
              <button className="ghostIcon" type="button" aria-label="projects and export" onClick={() => setExportMenu((v) => !v)}>
                <ChevronDown size={15} />
              </button>
              <a className="videoEntry" href="/video" title="图生视频（独立页面）">
                <Clapperboard size={14} /> 视频
              </a>
              <a className="videoEntry" href="/ontology" title="本体视频法 · 需求→本体→锚图→人审→出片">
                <Network size={14} /> 本体
              </a>
              {exportMenu ? (
                <div className="exportMenu" onMouseLeave={() => setExportMenu(false)}>
                  <div className="exportMenuSection">项目</div>
                  {projects.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className={p.id === activeProjectId ? "exportMenuItem active" : "exportMenuItem"}
                      onClick={() => switchProject(p.id)}
                    >
                      {p.name}
                      {p.id === activeProjectId ? " · 当前" : ""}
                    </button>
                  ))}
                  <button type="button" className="exportMenuItem" onClick={createProject}>
                    <Plus size={14} /> 新建项目
                  </button>
                  <button
                    type="button"
                    className="exportMenuItem"
                    onClick={() => {
                      setExportMenu(false);
                      requestAnimationFrame(() => {
                        titleInputRef.current?.focus();
                        titleInputRef.current?.select();
                      });
                    }}
                  >
                    <SquarePen size={14} /> 重命名
                  </button>
                  <button type="button" className="exportMenuItem danger" onClick={deleteActiveProject}>
                    <X size={14} /> 删除当前项目
                  </button>
                  <div className="exportMenuDivider" />
                  <div className="exportMenuSection">云同步</div>
                  <button
                    type="button"
                    onClick={() => {
                      setExportMenu(false);
                      void saveCanvasToCloud();
                    }}
                  >
                    <CloudUpload size={14} /> 保存到云端
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setExportMenu(false);
                      void restoreCanvasFromCloud();
                    }}
                  >
                    <Cloud size={14} /> 从云端恢复
                  </button>
                  <div className="exportMenuDivider" />
                  <div className="exportMenuSection">导出</div>
                  <button
                    type="button"
                    onClick={() => {
                      setExportMenu(false);
                      void exportCanvasPng();
                    }}
                  >
                    <Download size={14} /> 导出 PNG（画布/选中）
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setExportMenu(false);
                      void exportAiFile();
                    }}
                  >
                    <Download size={14} /> 导出 .ai（Illustrator）
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setExportMenu(false);
                      void exportSvgFile();
                    }}
                  >
                    <Download size={14} /> 导出 SVG
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setExportMenu(false);
                      void vectorizeSelected();
                    }}
                  >
                    <Spline size={14} /> 选中图片矢量化
                  </button>
                </div>
              ) : null}
            </div>
            <div className="creditCluster">
              <span className="creditPill">
                <Zap size={14} />
                30
              </span>
              <button className="avatar" type="button" aria-label="account">
                Lō
              </button>
            </div>
          </div>

          {shapeCount === 0 ? (
            <div className="blankHint">
              <p>
                Get started by typing your idea, or press <kbd>C</kbd> to chat
              </p>
            </div>
          ) : null}

          {busy || agentBusy ? (
            <div className="floatingStatus">
              <Loader2 className="spin" size={14} />
              {busyLabel || (agentBusy ? "Agent 思考中…" : "Generating…")}
            </div>
          ) : null}

          {/* selection context bar（Lovart 同款排布） */}
          {selection.box && selectedImageCount > 0 && !busy ? (
            <div
              className="selectionBar"
              style={{
                left: selection.box.x + selection.box.w / 2,
                top: Math.min(
                  typeof window === "undefined" ? 9999 : window.innerHeight - 64,
                  selection.box.y + selection.box.h + 18,
                ),
              }}
            >
              <button
                type="button"
                onClick={() => {
                  setQuickEditText("");
                  setQuickEditDialog({ open: true, src: selection.images[0], mode: "edit" });
                }}
              >
                <Wand2 size={14} />
                快改
                <kbd>Tab</kbd>
              </button>
              <button
                type="button"
                onClick={() =>
                  void runAction("高清增强", async () => {
                    pushMessage({ role: "user", text: "Upscale 高清增强" });
                    const urls = await doImageEdit({
                      src: selection.images[0],
                      instruction: "以更高分辨率和更丰富细节重绘，增强锐度、纹理与质感，画面内容完全不变",
                      kind: "upscale",
                    });
                    pushMessage({ role: "assistant", kind: "高清增强", images: urls });
                    setContextChips(urls.slice(0, 2));
                  })
                }
              >
                <Sparkles size={14} />
                高清
              </button>
              <button
                type="button"
                onClick={() =>
                  void runAction("去除背景", async () => {
                    pushMessage({ role: "user", text: "Remove BG 去除背景" });
                    const result = await doGpuMatting(selection.images[0]);
                    if (result.degraded) {
                      pushMessage({
                        role: "assistant",
                        kind: "去背景",
                        text: "GPU 抠图暂不可用，已用普通方案处理",
                        images: result.urls,
                      });
                    } else {
                      pushMessage({ role: "assistant", kind: "去背景", images: result.urls });
                    }
                    setContextChips(result.urls.slice(0, 2));
                  })
                }
              >
                <Squircle size={14} />
                去底
              </button>
              <button
                type="button"
                onClick={() => {
                  const src = selection.images[0];
                  setMaskInstruction("");
                  setMaskDialog({ open: true, src });
                  setTimeout(() => void initMaskEditor(src), 60);
                }}
              >
                <X size={14} />
                消除
              </button>
              <button
                type="button"
                onClick={() => {
                  setElementTarget("");
                  setElementOp("recolor");
                  setElementValue("");
                  setElementDialog({ open: true, src: selection.images[0] });
                }}
              >
                <Layers size={14} />
                元素
              </button>
              <button
                type="button"
                onClick={() => initFontDialog(selection.images[0])}
              >
                <Type size={14} />
                改字
              </button>
              <button
                type="button"
                onClick={() =>
                  void runAction("多角度", async () => {
                    pushMessage({ role: "user", text: "Multi-Angles 多角度视图" });
                    const urls = await doImageEdit({
                      src: selection.images[0],
                      instruction: "生成同一主体的不同视角版本（如侧面 45 度或俯视），主体、材质、风格保持一致",
                      kind: "multi-angle",
                      count: 2,
                    });
                    pushMessage({ role: "assistant", kind: "多角度", images: urls });
                    setContextChips(urls.slice(0, 2));
                  })
                }
              >
                <Copy size={14} />
                多角度
              </button>
              <button type="button" onClick={generateVariation}>
                <Wand2 size={14} />
                变体
              </button>
              <button
                type="button"
                onClick={() => {
                  if (selectedImageCount < 2) {
                    setError("材质复刻需要同时选中两张图：目标图 + 材质图");
                    return;
                  }
                  setMaterialSwap(false);
                  setMaterialNote("");
                  setMaterialDialog({ open: true, a: selection.images[0], b: selection.images[1] });
                }}
              >
                <Layers size={14} />
                材质
              </button>
              <button type="button" onClick={() => void vectorizeSelected()}>
                <Spline size={14} />
                矢量
              </button>
              <button type="button" onClick={() => void exportAiFile()}>
                <Download size={14} />
                .ai
              </button>
            </div>
          ) : null}

          <div className="bottomStatus">
            <button className="ghostIcon" type="button" aria-label="shapes">
              <Circle size={15} />
            </button>
            <button className="ghostIcon" type="button" aria-label="layers">
              <Layers size={15} />
            </button>
            <button className="ghostIcon" type="button" aria-label="search">
              <FileSearch size={15} />
            </button>
            <button className="ghostIcon" type="button" aria-label="versions">
              <GitBranch size={15} />
            </button>
            <i className="statusDivider" />
            <span className="zoomLabel">{zoomPct}%</span>
          </div>

          {/* tool dock */}
          <nav className="toolDock" aria-label="canvas tools">
            {dockTools.map((item) => (
              <button
                key={item.id}
                type="button"
                title={item.title}
                className={
                  item.tool && toolId === item.tool
                    ? "dockButton active"
                    : item.action === "grid" && gridOn
                      ? "dockButton active"
                      : "dockButton"
                }
                onClick={() => handleDockTool(item)}
              >
                {item.icon}
              </button>
            ))}
            <i className="dockDivider" />
            <button type="button" title="AI 生成图片（选中图片=生成变体）" className="dockButton" onClick={generateVariation}>
              <span className="aiGlyph">
                <ImageUpIcon />
                <Sparkles size={9} className="aiSpark" />
              </span>
            </button>
            <button type="button" title="AI 图生视频（独立页面）" className="dockButton" onClick={() => { window.location.href = "/video"; }}>
              <span className="aiGlyph">
                <SquarePlay size={19} />
                <Sparkles size={9} className="aiSpark" />
              </span>
            </button>
            <button
              type="button"
              title="AI 同风格改字"
              className="dockButton notify"
              onClick={() => {
                if (!selection.images[0]) {
                  setError("先选中画布上包含字体设计的图片");
                  return;
                }
                initFontDialog(selection.images[0]);
              }}
            >
              <span className="aiGlyph">
                <Type size={19} />
                <Sparkles size={9} className="aiSpark" />
              </span>
            </button>
          </nav>
        </section>

        {/* chat panel */}
        <aside className="chatPane" aria-label="new chat">
          <div className="chatTop">
            <h1 title={sessionTitleOf(messages)}>{sessionTitleOf(messages)}</h1>
            <div className="chatTopActions">
              <button
                className="ghostIcon"
                type="button"
                aria-label="new chat"
                onClick={() => {
                  // Flush current non-empty session under active project, then empty chat for same project.
                  if (messages.length) {
                    setPastSessions((prev) => {
                      const rest = prev.filter((s) => s.id !== sessionId);
                      const next = normalizeAgentSessions([
                        {
                          id: sessionId,
                          projectId: activeProjectId || DEFAULT_PROJECT_ID,
                          title: sessionTitleOf(messages),
                          ts: Date.now(),
                          messages,
                          oai: oaiHistoryRef.current,
                        },
                        ...rest,
                      ]).slice(0, 40);
                      try {
                        localStorage.setItem("lovartSessions", JSON.stringify(next));
                      } catch {
                        /* ignore */
                      }
                      return next;
                    });
                  }
                  setMessages([]);
                  oaiHistoryRef.current = [];
                  imageRegistryRef.current = [];
                  lastOutputsRef.current = [];
                  turnCounterRef.current = 0;
                  setSessionId(uid());
                  setContextChips([]);
                }}
              >
                <SquarePen size={16} />
              </button>
              <button className="ghostIcon" type="button" aria-label="history" onClick={() => setShowHistory(true)}>
                <History size={16} />
              </button>
              <button className="ghostIcon" type="button" aria-label="share" onClick={() => void exportCanvasPng()}>
                <Share2 size={16} />
              </button>
              <button className="ghostIcon" type="button" aria-label="collapse">
                <PanelRightOpen size={16} />
              </button>
            </div>
          </div>

          {!hasConversation ? (
            <section className="skillCenter" aria-label="Lovart skills">
              <h2>Try these Studio Skills</h2>
              <div className="chipCloud">
                {skillChips.map((chip) => (
                  <button key={chip.label} className="skillChip" type="button" onClick={() => applySkill(chip)}>
                    <span className="chipIcon">{chip.icon}</span>
                    <span>{chip.label}</span>
                  </button>
                ))}
              </div>
            </section>
          ) : (
            <div className="messages" ref={messagesRef}>
              {messages.map((message) => {
                if (message.role === "user") {
                  return (
                    <div className="msgUser" key={message.id}>
                      {message.images?.length ? (
                        <div className="msgUserImages">
                          {message.images.map((src, index) => (
                            <span className="msgUserImage" key={`${message.id}-${index}`}>
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={src} alt={`图${cnOrdinal(index)}`} />
                              <em>图{cnOrdinal(index)}</em>
                            </span>
                          ))}
                        </div>
                      ) : null}
                      {message.text}
                    </div>
                  );
                }
                if (message.role === "action") {
                  void tick;
                  return (
                    <div className="msgAssistant msgAction" key={message.id}>
                      <div className="msgKind">
                        {message.done ? <Sparkles size={12} /> : <Loader2 className="spin" size={12} />}
                        {message.done ? `${actionLabel(message.label)} · 完成` : `正在${actionLabel(message.label)}…`}
                        {!message.done ? <span className="actionTimer">{formatElapsed(Math.max(0, tick - message.ts))}</span> : null}
                      </div>
                      {!message.done ? <div className="actionSkeleton" /> : null}
                    </div>
                  );
                }
                return (
                  <div className="msgAssistant" key={message.id}>
                    <div className="msgKind">
                      <Sparkles size={12} />
                      {message.kind}
                    </div>
                    {message.text ? renderAssistantText(message.text) : null}
                    {message.error ? <p className="msgError">{message.error}</p> : null}
                    {message.images?.length ? (
                      <div className="msgImages">
                        {message.images.map((url) => (
                          <span className="msgImageWrap" key={url}>
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={url} alt="generated" onClick={() => void restoreHistoryImage(url)} />
                            <button
                              type="button"
                              aria-label="download"
                              onClick={(event) => {
                                event.stopPropagation();
                                void (async () => {
                                  const dataUrl = await srcToDataUrl(url);
                                  const link = document.createElement("a");
                                  link.href = dataUrl;
                                  link.download = "studio-image.png";
                                  link.click();
                                })();
                              }}
                            >
                              <Download size={12} />
                            </button>
                          </span>
                        ))}
                      </div>
                    ) : null}
                    {message.videoUrl ? (
                      <a className="msgVideo" href={message.videoUrl} target="_blank" rel="noreferrer">
                        <SquarePlay size={14} /> 打开生成的视频
                      </a>
                    ) : null}
                  </div>
                );
              })}
              {agentBusy ? (
                <div className="msgAssistant msgAction">
                  <div className="msgKind">
                    <Loader2 className="spin" size={12} />
                    Agent 正在工作…
                  </div>
                </div>
              ) : null}
            </div>
          )}

          <section className="composerDock" aria-label="composer">
            {showProBanner ? (
              <div className="proBanner">
                <span className="proDot">
                  <Sparkles size={11} />
                </span>
                <span>Go Pro. Unlock every model. Create faster.</span>
                <button type="button" aria-label="close" onClick={() => setShowProBanner(false)}>
                  <X size={13} />
                </button>
              </div>
            ) : null}

            {attachments.length || selectionAttachments.length ? (
              <div className="attachStrip" aria-label="本轮附图">
                {attachments.map((item, index) => (
                  <span className="attachChip" key={item.id} title={item.name}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={item.src} alt={item.name} />
                    <em>图{cnOrdinal(index)}</em>
                    <button
                      type="button"
                      aria-label="remove attachment"
                      onClick={() => setAttachments((prev) => prev.filter((a) => a.id !== item.id))}
                    >
                      <X size={10} />
                    </button>
                  </span>
                ))}
                {selectionAttachments.map((src, index) => (
                  <span className="attachChip selected" key={`sel-${index}`} title="画布选中的图片，会作为附图一起发送">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={src} alt="selected" />
                    <em>图{cnOrdinal(attachments.length + index)} · 选中</em>
                  </span>
                ))}
                <small>按「图一 / 图二…」指代，例如「图二参考图一，其他不变」</small>
              </div>
            ) : contextChips.length ? (
              <div className="contextChips">
                {contextChips.map((url) => (
                  <span className="contextChip" key={url}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={url} alt="context" />
                    <button
                      type="button"
                      aria-label="remove context"
                      onClick={() => {
                        setContextChips((prev) => prev.filter((u) => u !== url));
                        lastOutputsRef.current = lastOutputsRef.current.filter((id) => imageRegistryRef.current.find((item) => item.id === id)?.src !== url);
                      }}
                    >
                      <X size={10} />
                    </button>
                  </span>
                ))}
                <em>上一版成品已附为上下文，直接说改哪里即可续改</em>
              </div>
            ) : null}

            <div
              className={composerDragOver ? "composer dragOver" : "composer"}
              onDragOver={(event) => {
                if (Array.from(event.dataTransfer.types).includes("Files")) {
                  event.preventDefault();
                  setComposerDragOver(true);
                }
              }}
              onDragLeave={() => setComposerDragOver(false)}
              onDrop={(event) => {
                const files = Array.from(event.dataTransfer.files || []).filter((file) => file.type.startsWith("image/"));
                if (!files.length) return;
                event.preventDefault();
                setComposerDragOver(false);
                void addAttachmentFiles(files);
              }}
            >
              {showMentionMenu ? (
                <div className="mentionMenu">
                  <div className="mentionGroup">生图模型</div>
                  <button type="button" onClick={() => applyMention("@Image-2")}>
                    @Image-2 <em>GPT-Image-2 · 最新</em>
                  </button>
                  <button type="button" onClick={() => applyMention("@Image-1.5")}>
                    @Image-1.5 <em>稳定</em>
                  </button>
                  <button type="button" onClick={() => applyMention("@Seedream")}>
                    @Seedream <em>风格化/插画强</em>
                  </button>
                  <div className="mentionGroup">对话模型</div>
                  <button type="button" onClick={() => applyMention("@Sonnet-5")}>
                    @Sonnet-5 <em>默认 · 最强规划</em>
                  </button>
                  <button type="button" onClick={() => applyMention("@GPT-5.5")}>
                    @GPT-5.5 <em>中文强</em>
                  </button>
                  <button type="button" onClick={() => applyMention("@Kimi")}>
                    @Kimi <em>K2.7 长上下文</em>
                  </button>
                  <div className="mentionGroup">画质</div>
                  <button type="button" onClick={() => applyMention("@高画质")}>
                    @高画质 <em>high</em>
                  </button>
                  <button type="button" onClick={() => applyMention("@中画质")}>
                    @中画质 <em>medium</em>
                  </button>
                  <button type="button" onClick={() => applyMention("@低画质")}>
                    @低画质 <em>low</em>
                  </button>
                  <div className="mentionGroup">Brand Kit</div>
                  <button type="button" onClick={() => applyMention(brandText ? `@品牌(${brandText})` : "@品牌")}>
                    @品牌规则 <em>{brandText ? brandText.slice(0, 14) : "Agent 面板可配置"}</em>
                  </button>
                </div>
              ) : null}
              <textarea
                ref={composerRef}
                value={prompt}
                placeholder='Start with an idea, or type "@" to mention'
                onChange={(event) => {
                  setPrompt(event.target.value);
                  setShowMentionMenu(event.target.value.endsWith("@"));
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void sendToAgent();
                  }
                }}
                onPaste={(event) => {
                  const files = Array.from(event.clipboardData?.files || []).filter((file) => file.type.startsWith("image/"));
                  if (!files.length) return;
                  event.preventDefault();
                  void addAttachmentFiles(files);
                }}
              />
              <div className="composerFooter">
                <button className="ghostIcon" type="button" aria-label="add" title="附图（也可直接粘贴 / 拖入）" onClick={() => fileInputRef.current?.click()}>
                  <Plus size={17} />
                </button>
                <button
                  className="ghostIcon"
                  type="button"
                  aria-label="prompt library"
                  onClick={() =>
                    navigator.clipboard.writeText(
                      `curl -X POST ${location.origin}${API_BASE}/images -H "Authorization: Bearer <token>" -H "Content-Type: application/json" -d '{"prompt":"..."}'`,
                    )
                  }
                >
                  <BookOpen size={16} />
                </button>
                <div className="agentWrap">
                  <button className="agentPill" type="button" onClick={() => setShowAgentMenu((v) => !v)}>
                    <span className="agentFace">☺</span>
                    Agent
                    <ChevronDown size={13} />
                  </button>
                  {showAgentMenu ? (
                    <div className="agentMenu">
                      <label>
                        VIDEO_API_TOKEN
                        <input type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="Bearer token" />
                      </label>
                      <label>
                        风格
                        <select value={style} onChange={(event) => setStyle(event.target.value)}>
                          {stylePresets.map((preset) => (
                            <option key={preset}>{preset}</option>
                          ))}
                        </select>
                      </label>
                      <div className="inlineLabel">画幅</div>
                      <div className="inlineOptions">
                        {aspectOptions.map((option) => (
                          <button key={option} type="button" className={aspect === option ? "on" : ""} onClick={() => setAspect(option)}>
                            {option}
                          </button>
                        ))}
                      </div>
                      <div className="inlineLabel">数量</div>
                      <div className="inlineOptions small">
                        {[1, 2, 3, 4].map((value) => (
                          <button key={value} type="button" className={count === value ? "on" : ""} onClick={() => setCount(value)}>
                            {value}
                          </button>
                        ))}
                      </div>
                      <button
                        className="designMemoryEntry"
                        data-testid="design-memory-open"
                        type="button"
                        onClick={() => {
                          setDesignMemoryDraft(designMemory);
                          setShowAgentMenu(false);
                          setShowDesignMemory(true);
                        }}
                      >
                        <span className="designMemoryIcon">
                          <Brain size={16} />
                        </span>
                        <span className="designMemoryEntryText">
                          <strong>个人设计 Skill</strong>
                          <em>{designMemoryText ? "默认执行" : designMemory.enabled ? "空白" : "未启用"}</em>
                        </span>
                        <span className={designMemoryText ? "designMemoryState on" : "designMemoryState"}>
                          {designMemoryText ? "ON" : "OFF"}
                        </span>
                      </button>
                      <div className="inlineLabel">Brand Kit</div>
                      <label>
                        品牌名
                        <input
                          value={brandKit.name}
                          onChange={(event) => persistBrandKit({ ...brandKit, name: event.target.value })}
                          placeholder="品牌名称"
                        />
                      </label>
                      <label>
                        风格词
                        <input
                          value={brandKit.styleWords}
                          onChange={(event) => persistBrandKit({ ...brandKit, styleWords: event.target.value })}
                          placeholder="极简 / 国潮 / 科技感"
                        />
                      </label>
                      <label>
                        字体气质
                        <input
                          value={brandKit.fontHint}
                          onChange={(event) => persistBrandKit({ ...brandKit, fontHint: event.target.value })}
                          placeholder="衬线优雅 / 无衬线现代"
                        />
                      </label>
                      <div className="inlineLabel">色板（≤6）</div>
                      <div className="brandPalette">
                        {brandKit.palette.map((hex, index) => (
                          <button
                            key={`${hex}-${index}`}
                            type="button"
                            className="brandSwatch"
                            style={{ background: hex }}
                            title={`${hex}（点击删除）`}
                            onClick={() =>
                              persistBrandKit({ ...brandKit, palette: brandKit.palette.filter((_, i) => i !== index) })
                            }
                          />
                        ))}
                        {brandKit.palette.length < 6 ? (
                          <label className="brandAddColor" title="添加颜色">
                            +
                            <input
                              type="color"
                              value="#4263eb"
                              onChange={(event) => {
                                const hex = event.target.value.toUpperCase();
                                if (brandKit.palette.includes(hex)) return;
                                persistBrandKit({ ...brandKit, palette: [...brandKit.palette, hex].slice(0, 6) });
                              }}
                            />
                          </label>
                        ) : null}
                      </div>
                      <div className="inlineLabel">Logo 参考图</div>
                      <div className="brandLogoRow">
                        {brandKit.logoRef ? (
                          <div className="referenceThumb">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={brandKit.logoRef} alt="brand logo" />
                            <button type="button" onClick={() => persistBrandKit({ ...brandKit, logoRef: "" })}>
                              <X size={10} />
                            </button>
                          </div>
                        ) : null}
                        <label className="brandLogoUpload">
                          {brandKit.logoRef ? "更换" : "上传 Logo"}
                          <input
                            type="file"
                            accept="image/*"
                            hidden
                            onChange={(event) => void onBrandLogoUpload(event.target.files?.[0] || null)}
                          />
                        </label>
                      </div>
                      <label>
                        受众
                        <input value={audience} onChange={(event) => setAudience(event.target.value)} placeholder="目标人群" />
                      </label>
                      <label>
                        避免
                        <input value={negativePrompt} onChange={(event) => setNegativePrompt(event.target.value)} placeholder="不想出现的元素" />
                      </label>
                      {references.length ? (
                        <div className="referenceList">
                          {references.map((ref, index) => (
                            <div key={index} className="referenceThumb">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={ref} alt="reference" />
                              <button type="button" onClick={() => setReferences((prev) => prev.filter((_, i) => i !== index))}>
                                <X size={10} />
                              </button>
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
                <span className="composerSpacer" />
                <button className="ghostIcon" type="button" aria-label="ideas" onClick={() => applySkill(skillChips[0])}>
                  <Lightbulb size={16} />
                </button>
                <button className="ghostIcon" type="button" aria-label="assets" onClick={() => setShowHistory(true)}>
                  <Archive size={16} />
                </button>
                <button
                  className={composerHasText ? "sendButton" : listening ? "sendButton listening" : "sendButton idle"}
                  type="button"
                  aria-label={composerHasText ? "send" : "voice"}
                  onClick={() => (composerHasText ? void sendToAgent() : toggleVoice())}
                >
                  {composerHasText ? <ArrowUp size={16} /> : <AudioLines size={16} />}
                </button>
              </div>
            </div>
          </section>
        </aside>
      </div>

      {/* hidden upload input */}
      <input
        ref={fileInputRef}
        className="hiddenInput"
        type="file"
        accept="image/*"
        multiple
        onChange={(event) => {
          void handleFiles(event.target.files);
          event.target.value = "";
        }}
      />

      {/* history drawer */}
      {showHistory ? (
        <div className="drawerScrim" onClick={() => setShowHistory(false)}>
          <div className="historyDrawer" onClick={(event) => event.stopPropagation()}>
            <div className="drawerTop">
              <h2>
                <History size={16} /> 会话与生成历史
              </h2>
              <button className="ghostIcon" type="button" onClick={() => setShowHistory(false)}>
                <X size={16} />
              </button>
            </div>
            {sessionsForProject(pastSessions, activeProjectId).length ? (
              <div className="sessionList" data-project-id={activeProjectId}>
                {sessionsForProject(pastSessions, activeProjectId).map((session) => (
                  <button
                    key={session.id}
                    type="button"
                    className={session.id === sessionId ? "sessionItem on" : "sessionItem"}
                    data-session-id={session.id}
                    data-project-id={sessionProjectIdOf(session)}
                    onClick={() => {
                      setSessionId(session.id);
                      setMessages(session.messages);
                      oaiHistoryRef.current = session.oai || [];
                      imageRegistryRef.current = [];
                      lastOutputsRef.current = [];
                      turnCounterRef.current = 0;
                      setShowHistory(false);
                    }}
                  >
                    <strong>{session.title}</strong>
                    <span>
                      {new Date(session.ts).toLocaleString("zh-CN", { hour12: false })} · {session.messages.length} 条
                    </span>
                  </button>
                ))}
              </div>
            ) : null}
            {history.length === 0 ? <p className="drawerEmpty">还没有生成记录</p> : null}
            <div className="historyList">
              {history.map((entry) => (
                <div className="historyItem" key={entry.id}>
                  <div className="historyMeta">
                    <span className={`kindBadge k-${entry.kind}`}>{entry.kind}</span>
                    <time>{new Date(entry.ts).toLocaleString("zh-CN", { hour12: false })}</time>
                  </div>
                  <p className="historyPrompt">“{entry.prompt}”</p>
                  {entry.outputs.length ? (
                    <div className="historyOutputs">
                      {entry.outputs.map((output) => (
                        /* eslint-disable-next-line @next/next/no-img-element */
                        <img
                          key={output.url}
                          src={output.url}
                          alt="output"
                          onClick={() => void restoreHistoryImage(output.url)}
                          title="点击放回画布"
                        />
                      ))}
                    </div>
                  ) : null}
                  {entry.videoUrl ? (
                    <a className="msgVideo" href={entry.videoUrl} target="_blank" rel="noreferrer">
                      <SquarePlay size={13} /> 视频链接
                    </a>
                  ) : null}
                  <div className="historyActions">
                    <button
                      type="button"
                      onClick={() => {
                        setPrompt(entry.prompt);
                        setShowHistory(false);
                        composerRef.current?.focus();
                      }}
                    >
                      <Copy size={12} /> 回填 prompt
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      {/* private, browser-local design memory */}
      {showDesignMemory ? (
        <div className="modalScrim" onClick={() => setShowDesignMemory(false)}>
          <section
            className="taskDialog designMemoryDialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="design-memory-title"
            onClick={(event) => event.stopPropagation()}
          >
            <button className="dialogClose" type="button" aria-label="关闭设计记忆" onClick={() => setShowDesignMemory(false)}>
              <X size={16} />
            </button>
            <header className="designMemoryHeader">
              <span className="designMemoryIcon large">
                <Brain size={19} />
              </span>
              <div>
                <h2 id="design-memory-title">个人设计 Skill</h2>
                <p>当前浏览器 · 默认执行</p>
              </div>
              <label className="designMemoryToggle">
                <input
                  data-testid="design-memory-enabled"
                  type="checkbox"
                  checked={designMemoryDraft.enabled}
                  onChange={(event) => setDesignMemoryDraft((prev) => ({ ...prev, enabled: event.target.checked }))}
                />
                <span aria-hidden="true" />
                启用
              </label>
            </header>

            <div className="designMemoryGrid">
              <label>
                设计身份
                <textarea
                  data-testid="design-memory-profile"
                  value={designMemoryDraft.profile}
                  onChange={(event) => setDesignMemoryDraft((prev) => ({ ...prev, profile: event.target.value }))}
                />
              </label>
              <label>
                品牌与项目
                <textarea
                  data-testid="design-memory-brands"
                  value={designMemoryDraft.brands}
                  onChange={(event) => setDesignMemoryDraft((prev) => ({ ...prev, brands: event.target.value }))}
                />
              </label>
              <label>
                视觉偏好
                <textarea
                  data-testid="design-memory-style"
                  value={designMemoryDraft.visualStyle}
                  onChange={(event) => setDesignMemoryDraft((prev) => ({ ...prev, visualStyle: event.target.value }))}
                />
              </label>
              <label>
                Logo 规则
                <textarea
                  data-testid="design-memory-logo"
                  value={designMemoryDraft.logoRules}
                  onChange={(event) => setDesignMemoryDraft((prev) => ({ ...prev, logoRules: event.target.value }))}
                />
              </label>
              <label>
                联名规范
                <textarea
                  data-testid="design-memory-collaboration"
                  value={designMemoryDraft.collaborationRules}
                  onChange={(event) => setDesignMemoryDraft((prev) => ({ ...prev, collaborationRules: event.target.value }))}
                />
              </label>
              <label>
                创作习惯
                <textarea
                  data-testid="design-memory-workflow"
                  value={designMemoryDraft.workflow}
                  onChange={(event) => setDesignMemoryDraft((prev) => ({ ...prev, workflow: event.target.value }))}
                />
              </label>
              <label className="designMemoryWide">
                避免项
                <textarea
                  data-testid="design-memory-avoid"
                  value={designMemoryDraft.avoid}
                  onChange={(event) => setDesignMemoryDraft((prev) => ({ ...prev, avoid: event.target.value }))}
                />
              </label>
            </div>

            <div className="dialogFooter designMemoryFooter">
              <button className="ghostButton" type="button" onClick={() => setDesignMemoryDraft(EMPTY_DESIGN_MEMORY)}>
                清空
              </button>
              <button className="darkButton" data-testid="design-memory-save" type="button" onClick={saveDesignMemory}>
                保存
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {/* voice mode dialog */}
      {showVoiceTip ? (
        <div className="modalScrim">
          <div className="voiceDialog">
            <button
              className="dialogClose"
              type="button"
              aria-label="Close"
              onClick={() => {
                setShowVoiceTip(false);
                localStorage.setItem("lovartVoiceTipSeen", "1");
              }}
            >
              <X size={16} />
            </button>
            <div className="voiceIllustration">
              <AudioLines size={44} />
            </div>
            <h2>Create with Voice Mode</h2>
            <p>
              Hold C or press C + Space to speak your idea. Currently supports image generation and editing only. Voice mode is
              also available in the chat panel.
            </p>
            <div className="dialogFooter">
              <span>1 / 1</span>
              <button
                className="darkButton"
                type="button"
                onClick={() => {
                  setShowVoiceTip(false);
                  localStorage.setItem("lovartVoiceTipSeen", "1");
                }}
              >
                Got it
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* quick edit / eraser dialog */}
      {quickEditDialog.open ? (
        <div className="modalScrim" onClick={() => setQuickEditDialog({ open: false })}>
          <div className="taskDialog" onClick={(event) => event.stopPropagation()}>
            <div className="drawerTop">
              <h2>
                {quickEditDialog.mode === "erase" ? <X size={16} /> : <Wand2 size={16} />}
                {quickEditDialog.mode === "erase" ? " 消除元素" : " Quick Edit 快改"}
              </h2>
              <button className="ghostIcon" type="button" onClick={() => setQuickEditDialog({ open: false })}>
                <X size={16} />
              </button>
            </div>
            {quickEditDialog.src ? (
              <div className="dialogPreview">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={quickEditDialog.src} alt="selected" />
              </div>
            ) : null}
            <label>
              {quickEditDialog.mode === "erase" ? "要移除的元素" : "修改指令"}
              <input
                autoFocus
                value={quickEditText}
                onChange={(event) => setQuickEditText(event.target.value)}
                placeholder={quickEditDialog.mode === "erase" ? "例如：右下角的水印文字" : "例如：把背景换成夜景霓虹"}
              />
            </label>
            <div className="dialogFooter">
              <span>{quickEditDialog.mode === "erase" ? "移除元素后自然补全背景" : "只改指令部分，其余保持原样"}</span>
              <button
                className="darkButton"
                type="button"
                disabled={!quickEditText.trim()}
                onClick={() => {
                  const src = quickEditDialog.src;
                  const text = quickEditText.trim();
                  const isErase = quickEditDialog.mode === "erase";
                  if (!src || !text) return;
                  setQuickEditDialog({ open: false });
                  void runAction(isErase ? "消除元素" : "快改", async () => {
                    pushMessage({ role: "user", text: `${isErase ? "消除" : "快改"}：${text}` });
                    const urls = await doImageEdit({
                      src,
                      instruction: isErase ? `移除图中的「${text}」，移除处按周围内容自然补全，其余全部不变` : text,
                      kind: isErase ? "eraser" : "quick-edit",
                    });
                    pushMessage({ role: "assistant", kind: isErase ? "消除" : "快改", images: urls });
                    setContextChips(urls.slice(0, 2));
                  });
                }}
              >
                执行
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* mask inpaint dialog */}
      {maskDialog.open ? (
        <div className="modalScrim" onClick={() => setMaskDialog({ open: false })}>
          <div className="taskDialog maskDialog" onClick={(event) => event.stopPropagation()}>
            <div className="drawerTop">
              <h2>
                <X size={16} /> 消除 · 涂抹要移除的区域
              </h2>
              <button className="ghostIcon" type="button" onClick={() => setMaskDialog({ open: false })}>
                <X size={16} />
              </button>
            </div>
            <canvas
              ref={maskViewRef}
              className="maskCanvas"
              onPointerDown={(event) => {
                maskDrawingRef.current = true;
                (event.target as HTMLElement).setPointerCapture(event.pointerId);
                paintMaskAt(event.clientX, event.clientY);
              }}
              onPointerMove={(event) => {
                if (maskDrawingRef.current) paintMaskAt(event.clientX, event.clientY);
              }}
              onPointerUp={() => {
                maskDrawingRef.current = false;
              }}
            />
            <div className="maskControls">
              <label className="maskSlider">
                笔刷 {maskBrush}px
                <input
                  type="range"
                  min={12}
                  max={80}
                  value={maskBrush}
                  onChange={(event) => setMaskBrush(Number(event.target.value))}
                />
              </label>
              <button
                type="button"
                className="ghostButton"
                onClick={() => {
                  const paint = maskPaintRef.current;
                  paint?.getContext("2d")?.clearRect(0, 0, paint.width, paint.height);
                  setMaskHasPaint(false);
                  redrawMaskView();
                }}
              >
                清除涂抹
              </button>
            </div>
            <label>
              指令（可选）
              <input
                value={maskInstruction}
                onChange={(event) => setMaskInstruction(event.target.value)}
                placeholder="默认：移除并按周围内容自然补全；也可写“换成一朵花”"
              />
            </label>
            <div className="dialogFooter">
              <span>涂抹区外的像素 100% 保持原图</span>
              <button
                className="darkButton"
                type="button"
                disabled={!maskHasPaint}
                onClick={() => {
                  const instruction = maskInstruction;
                  setMaskDialog({ open: false });
                  void runAction("局部消除", async () => {
                    pushMessage({ role: "user", text: `局部消除${instruction ? `：${instruction}` : ""}` });
                    const composed = await doMaskInpaint(instruction);
                    pushMessage({ role: "assistant", kind: "局部消除", images: [composed] });
                  });
                }}
              >
                执行
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* edit elements dialog */}
      {elementDialog.open ? (
        <div className="modalScrim" onClick={() => setElementDialog({ open: false })}>
          <div className="taskDialog" onClick={(event) => event.stopPropagation()}>
            <div className="drawerTop">
              <h2>
                <Layers size={16} /> Edit Elements 元素编辑
              </h2>
              <button className="ghostIcon" type="button" onClick={() => setElementDialog({ open: false })}>
                <X size={16} />
              </button>
            </div>
            {elementDialog.src ? (
              <div className="dialogPreview">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={elementDialog.src} alt="selected" />
              </div>
            ) : null}
            {elementOp !== "layers" && elementOp !== "smart-split" ? (
              <label>
                目标元素
                <input
                  autoFocus
                  value={elementTarget}
                  onChange={(event) => setElementTarget(event.target.value)}
                  placeholder="例如：外圈金色圆环 / 中间的茶杯图形"
                />
              </label>
            ) : null}
            <div className="inlineLabel">操作</div>
            <div className="inlineOptions">
              {(
                [
                  { id: "recolor", label: "改颜色" },
                  { id: "remove", label: "移除" },
                  { id: "replace", label: "替换为" },
                  { id: "free", label: "自由指令" },
                  { id: "layers", label: "拆分图层" },
                  { id: "smart-split", label: "智能拆层" },
                ] as const
              ).map((op) => (
                <button key={op.id} type="button" className={elementOp === op.id ? "on" : ""} onClick={() => setElementOp(op.id)}>
                  {op.label}
                </button>
              ))}
            </div>
            {elementOp !== "remove" && elementOp !== "layers" && elementOp !== "smart-split" ? (
              <label>
                {elementOp === "recolor" ? "目标颜色" : elementOp === "replace" ? "替换成什么" : "指令"}
                <input
                  value={elementValue}
                  onChange={(event) => setElementValue(event.target.value)}
                  placeholder={
                    elementOp === "recolor" ? "例如：暗红色" : elementOp === "replace" ? "例如：一枝樱花" : "例如：让它更立体、加投影"
                  }
                />
              </label>
            ) : null}
            <div className="dialogFooter">
              <span>
                {elementOp === "layers"
                  ? "按颜色拆成独立图层，落画布后可单独拖动/删除"
                  : elementOp === "smart-split"
                    ? "GPU 语义分割：输出 overlay/mask，失败不影响其他编辑"
                    : "只动指定元素，其余保持原样"}
              </span>
              <button
                className="darkButton"
                type="button"
                disabled={
                  elementOp === "layers" || elementOp === "smart-split"
                    ? false
                    : !elementTarget.trim() || (elementOp !== "remove" && !elementValue.trim())
                }
                onClick={() => {
                  const src = elementDialog.src;
                  if (!src) return;
                  setElementDialog({ open: false });
                  if (elementOp === "smart-split") {
                    void runAction("智能拆层", async () => {
                      pushMessage({ role: "user", text: "智能拆层 / 语义分割" });
                      try {
                        const result = await doGpuSegment(src);
                        pushMessage({
                          role: "assistant",
                          kind: "智能拆层",
                          text: `已拆出 ${result.count} 个分割结果（overlay/mask），可在画布上单独编辑。`,
                          images: result.urls.slice(0, 4),
                        });
                        setContextChips(result.urls.slice(0, 2));
                      } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        pushMessage({
                          role: "assistant",
                          kind: "智能拆层",
                          text: /503|not configured|GPU/i.test(message)
                            ? "GPU 拆层暂不可用，可改用「拆分图层」颜色方案。"
                            : `智能拆层失败：${message}`,
                          error: message,
                        });
                      }
                    });
                    return;
                  }
                  if (elementOp === "layers") {
                    void runAction("拆分图层", async () => {
                      pushMessage({ role: "user", text: "拆分图层" });
                      const layerCount = await splitSelectedToLayers(src);
                      pushMessage({
                        role: "assistant",
                        kind: "拆分图层",
                        text: `已拆分为 ${layerCount} 个可独立编辑的矢量图层，直接在画布上拖动即可分离。`,
                      });
                    });
                    return;
                  }
                  const target = elementTarget.trim();
                  const value = elementValue.trim();
                  if (!target) return;
                  const instruction =
                    elementOp === "recolor"
                      ? `把「${target}」的颜色改为${value}`
                      : elementOp === "remove"
                        ? `移除「${target}」，移除处按周围内容自然补全`
                        : elementOp === "replace"
                          ? `把「${target}」替换为${value}，风格与整体一致`
                          : `针对「${target}」：${value}`;
                  void runAction("元素编辑", async () => {
                    pushMessage({ role: "user", text: `元素编辑：${instruction}` });
                    const urls = await doImageEdit({ src, instruction, kind: "edit-elements" });
                    pushMessage({ role: "assistant", kind: "元素编辑", images: urls });
                    setContextChips(urls.slice(0, 2));
                  });
                }}
              >
                执行
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* all skills panel */}
      {showSkillsLib ? (
        <div className="modalScrim" onClick={() => setShowSkillsLib(false)}>
          <div className="taskDialog skillsLib" onClick={(event) => event.stopPropagation()}>
            <div className="drawerTop">
              <h2>
                <BookOpen size={16} /> All Skills
              </h2>
              <button className="ghostIcon" type="button" onClick={() => setShowSkillsLib(false)}>
                <X size={16} />
              </button>
            </div>
            <div className="skillsGrid">
              {skillChips
                .filter((chip) => chip.prompt)
                .map((chip) => (
                  <button
                    key={chip.label}
                    type="button"
                    className="skillCard"
                    onClick={() => {
                      setShowSkillsLib(false);
                      applySkill(chip);
                    }}
                  >
                    <span className="chipIcon">{chip.icon}</span>
                    <strong>{chip.label}</strong>
                    <span className="skillDesc">{chip.prompt}</span>
                  </button>
                ))}
            </div>
          </div>
        </div>
      ) : null}

      {/* font restyle dialog */}
      {fontDialog.open ? (
        <div className="modalScrim" onClick={() => setFontDialog({ open: false })}>
          <div className="taskDialog" onClick={(event) => event.stopPropagation()}>
            <div className="drawerTop">
              <h2>
                <Type size={16} /> 同风格改字
              </h2>
              <button className="ghostIcon" type="button" onClick={() => setFontDialog({ open: false })}>
                <X size={16} />
              </button>
            </div>
            {fontDialog.preview || fontDialog.src ? (
              <div className="dialogPreview">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={fontDialog.preview || fontDialog.src} alt="reference lettering" />
              </div>
            ) : null}
            {fontOcr === "loading" ? (
              <p className="ocrHint">
                <Loader2 className="spin" size={13} /> 正在识别图中文字…（也可直接在下方输入，不必等待）
              </p>
            ) : null}
            {fontOcr === "done" && fontLines ? (
              <div className="fontLines">
                <div className="inlineLabel">编辑文字（改哪行填哪行，其余保持原样）</div>
                {fontLines.map((line, index) => (
                  <input
                    key={index}
                    value={line.to}
                    className={line.to.trim() !== line.from.trim() ? "changed" : ""}
                    onChange={(event) =>
                      setFontLines((prev) =>
                        prev ? prev.map((item, i) => (i === index ? { ...item, to: event.target.value } : item)) : prev,
                      )
                    }
                  />
                ))}
              </div>
            ) : null}
            <label>
              {fontOcr === "done" && fontLines ? "或整体替换为（可选，优先用上面的逐行编辑）" : "新文字内容"}
              <input autoFocus value={fontText} onChange={(event) => setFontText(event.target.value)} placeholder="例如：云东 AI 视觉" />
            </label>
            <label>
              补充说明（可选）
              <input value={fontNote} onChange={(event) => setFontNote(event.target.value)} placeholder="例如：保持金属质感和描边" />
            </label>
            <div className="dialogFooter">
              <span>保持原字体的骨架 / 笔画 / 质感 / 颜色</span>
              <button
                className="darkButton"
                type="button"
                disabled={
                  !fontText.trim() && !(fontLines || []).some((line) => line.to.trim() && line.to.trim() !== line.from.trim())
                }
                title="改动上方任意一行，或在输入框填写新文字"
                onClick={runFontRestyle}
              >
                生成
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* material transfer dialog */}
      {materialDialog.open ? (
        <div className="modalScrim" onClick={() => setMaterialDialog({ open: false })}>
          <div className="taskDialog" onClick={(event) => event.stopPropagation()}>
            <div className="drawerTop">
              <h2>
                <Layers size={16} /> 材质复刻
              </h2>
              <button className="ghostIcon" type="button" onClick={() => setMaterialDialog({ open: false })}>
                <X size={16} />
              </button>
            </div>
            <div className="materialPair">
              <figure>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={materialSwap ? materialDialog.b : materialDialog.a} alt="target" />
                <figcaption>目标图案</figcaption>
              </figure>
              <button className="swapButton" type="button" onClick={() => setMaterialSwap((v) => !v)} title="交换目标/材质">
                ⇄
              </button>
              <figure>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={materialSwap ? materialDialog.a : materialDialog.b} alt="material" />
                <figcaption>材质样本</figcaption>
              </figure>
            </div>
            <label>
              补充说明（可选）
              <input value={materialNote} onChange={(event) => setMaterialNote(event.target.value)} placeholder="例如：把布料纹理铺满整个图形" />
            </label>
            <div className="dialogFooter">
              <span>把材质样本的纹理迁移到目标图案上</span>
              <button className="darkButton" type="button" onClick={runMaterialTransfer}>
                开始复刻
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* toasts */}
      {error ? (
        <div className="errorToast" role="alert">
          {error}
          <button type="button" aria-label="dismiss" onClick={() => setError("")}>
            <X size={13} />
          </button>
        </div>
      ) : null}
      {videoUrl && !busy ? (
        <a className="videoToast" href={videoUrl} target="_blank" rel="noreferrer">
          <SquarePlay size={14} /> 视频已生成，点此打开
        </a>
      ) : null}
    </main>
  );
}

function actionLabel(name: string) {
  const labels: Record<string, string> = {
    design_plan: "分析需求并制定方案",
    generate_images: "生成图片",
    restyle_lettering: "同风格改字",
    transfer_material: "材质复刻",
    edit_images: "编辑图片",
    edit_selected_image: "修改图片",
    remove_background: "去底抠图",
    upscale_image: "高清放大",
    image_to_video: "提交视频任务",
    vectorize_image: "矢量化",
    vectorize_selected: "矢量化",
    export_ai: "导出 .ai",
  };
  return labels[name] || `执行 ${name}`;
}

function ImageUpIcon() {
  return (
    <svg
      width="19"
      height="19"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M10.3 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10" />
      <path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
      <circle cx="9" cy="9" r="2" />
      <path d="m14 19 3-3 3 3" />
      <path d="M17 22v-6" />
    </svg>
  );
}
