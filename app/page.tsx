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
  loadSnapshot,
  useValue,
  type Editor,
  type TLAssetId,
  type TLShapeId,
  type TLShape,
} from "tldraw";
import "tldraw/tldraw.css";
import { designShapeUtils } from '../components/image2/DesignShapes';
import { professionalCanvasComponents, ProfessionalCanvasContext } from '../components/image2/ProfessionalCanvas';
import { LegacyImageAdjustments } from '../components/image2/LegacyImageAdjustments';
import { CraftToolsDialog } from '../components/image2/CraftToolsDialog';
import { elementPreviewSource } from '../lib/image2/element-preview';
import { LegacyImagePanels, CandidateResult, type LegacyImagePanel } from '../components/image2/LegacyImagePanels';
import { useLegacyImage2 } from '../lib/image2/useLegacyImage2';
import { assetUrl, Image2ApiError } from '../lib/image2/client';
import type { ImageJob } from '../lib/image2/types';
import { capability } from '../lib/image2/geometry';

/* ------------------------------------------------------------------ */
/* constants                                                           */
/* ------------------------------------------------------------------ */

const API_BASE = "/api/v1";


/** Full licensed Chinese font faces, versioned to replace the former incomplete subsets. */
const FONT_DRAW_URL = "/fonts/lxgw-wenkai.woff2?v=full-original-families-20261012";
const FONT_SANS_URL = "/fonts/source-han-sans.woff2?v=full-original-families-20261012";
const FONT_SERIF_URL = "/fonts/source-han-serif.woff2?v=full-original-families-20261012";
const FONT_MONO_URL = "/fonts/smiley-sans.woff2?v=full-original-families-20261012";
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

/** Every picture the agent may refer to in this conversation gets a stable global id (#1, #2 …).
 *  Per-turn "图一/图二" labels are resolved against this registry (Lovart numbers by attach order). */
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

const originalShapeVisibility = (shape: TLShape) => shape.meta.image2Hidden === true ? 'hidden' as const : 'inherit' as const;
const elementColours: Record<string, string> = {'红色':'#e03131','暗红色':'#8b1e2d','黑色':'#000000','白色':'#ffffff','蓝色':'#4263eb','绿色':'#099268','金色':'#d5a53a'};

export default function Home() {
  "use no memo"; // The tldraw editor is an imperative external store; its action closures are not compiler-pure.
  const [editor, setEditor] = useState<Editor | null>(null);
  const handleEditorMount = useCallback((instance: Editor) => setEditor(instance), []);

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

  const [quickEditDialog, setQuickEditDialog] = useState<{ open: boolean; src?: string; layerId?: string; mode?: "edit" | "erase" }>({ open: false });
  const [quickEditText, setQuickEditText] = useState("");
  const [elementDialog, setElementDialog] = useState<{ open: boolean; src?: string; layerId?: string }>({ open: false });
  const [elementTarget, setElementTarget] = useState("");
  const [elementOp, setElementOp] = useState<"recolor" | "remove" | "replace" | "free" | "layers" | "smart-split">("recolor");
  const [elementValue, setElementValue] = useState("");
  const [maskDialog, setMaskDialog] = useState<{ open: boolean; src?: string; layerId?: string }>({ open: false });
  const [maskBrush, setMaskBrush] = useState(36);
  const [maskMode, setMaskMode] = useState<'edit' | 'protect'>('edit');
  const [maskOperation, setMaskOperation] = useState('erase');
  const [maskColor, setMaskColor] = useState('#d1384b');
  const maskProtectRef = useRef<HTMLCanvasElement | null>(null);
  const [maskInstruction, setMaskInstruction] = useState("");
  const [maskHasPaint, setMaskHasPaint] = useState(false);
  const maskViewRef = useRef<HTMLCanvasElement | null>(null);
  const maskPaintRef = useRef<HTMLCanvasElement | null>(null);
  const maskImgRef = useRef<HTMLImageElement | null>(null);
  const maskDrawingRef = useRef(false);
  const [contextMenu, setContextMenu] = useState<{ open: boolean; x: number; y: number }>({ open: false, x: 0, y: 0 });
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const closeContextMenu = useCallback(() => {
    setContextMenu(current => current.open ? { open: false, x: 0, y: 0 } : current);
  }, []);
  useEffect(() => {
    if (!contextMenu.open) return;
    const isMenuTarget = (target: EventTarget | null) => target instanceof Node && contextMenuRef.current?.contains(target);
    // tldraw stops bubbling clicks. Capture outside input without swallowing it,
    // so the same click still selects a shape, focuses chat, or changes tools.
    const outside = (event: Event) => { if (!isMenuTarget(event.target)) closeContextMenu(); };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' || !isMenuTarget(event.target)) closeContextMenu();
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('contextmenu', outside, true);
    document.addEventListener('focusin', outside, true);
    document.addEventListener('keydown', key, true);
    document.addEventListener('wheel', closeContextMenu, { capture: true, passive: true });
    window.addEventListener('blur', closeContextMenu);
    window.addEventListener('resize', closeContextMenu);
    window.addEventListener('scroll', closeContextMenu, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('contextmenu', outside, true);
      document.removeEventListener('focusin', outside, true);
      document.removeEventListener('keydown', key, true);
      document.removeEventListener('wheel', closeContextMenu, true);
      window.removeEventListener('blur', closeContextMenu);
      window.removeEventListener('resize', closeContextMenu);
      window.removeEventListener('scroll', closeContextMenu, true);
    };
  }, [contextMenu.open, closeContextMenu]);
  const [brushColor, setBrushColor] = useState("black");
  const [brushSize, setBrushSize] = useState("m");
  const [textFont, setTextFont] = useState<"draw" | "sans" | "serif" | "mono">("draw");
  const [textColor, setTextColor] = useState("black");
  const [textSize, setTextSize] = useState("m");
  const [fontDialog, setFontDialog] = useState<{ open: boolean; src?: string; layerId?: string; preview?: string }>({ open: false });


  const [fontText, setFontText] = useState("");

  const [fontOriginal, setFontOriginal] = useState('');
  const [fontRect, setFontRect] = useState({ x: 0, y: 0, width: 100, height: 40 });
  const [fontAssetChoice, setFontAssetChoice] = useState('');
  const [fontExactSize, setFontExactSize] = useState(36);
  const [fontExactColor, setFontExactColor] = useState('#20232b');
  const [imagePanel, setImagePanelState] = useState<LegacyImagePanel>(null);
  const imagePanelEpoch = useRef(0);
  const setImagePanel = useCallback((mode: LegacyImagePanel) => { imagePanelEpoch.current++; setImagePanelState(mode); }, []);
  const renderedPanelEpoch = imagePanelEpoch.current;
  const [materialDialog, setMaterialDialog] = useState<{ open: boolean; a?: string; b?: string }>({ open: false });
  const [materialSwap, setMaterialSwap] = useState(false);
  const [materialNote, setMaterialNote] = useState("");
  const [exportMenu, setExportMenu] = useState(false);
  const [craftToolsOpen, setCraftToolsOpen] = useState(false);
  const [craftReview, setCraftReview] = useState<{ branchId: string; projectId?: string } | null>(null);
  const viewNativeCandidate = useCallback((branchId: string, projectId?: string) => { setImagePanel(null); setCraftReview({ branchId, projectId }); setCraftToolsOpen(true); }, [setImagePanel]);
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
  // Retained solely to display archived sessions and their old numbered context chips.
  const oaiHistoryRef = useRef<OaiMessage[]>([]);
  const imageRegistryRef = useRef<TurnImage[]>([]);
  const lastOutputsRef = useRef<number[]>([]);


  const attachmentsRef = useRef<ComposerAttachment[]>([]);
  const selectionRef = useRef(selection);
  const skipAutosaveRef = useRef(false);
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeProjectIdRef = useRef(activeProjectId);
  const projectNameRef = useRef(projectName);
  const editorRef = useRef<Editor | null>(null);
  const historyQueueRef = useRef(Promise.resolve());
  const image2 = useLegacyImage2({ editor, projectId: activeProjectId, projectName, onError: setError });
  const elementPreviewSrc = elementPreviewSource(image2.document, elementDialog);
  const image2Running = image2.jobs.some(job => job.state === 'queued' || job.state === 'running');
  const currentSyncStatus = image2.document
    ? image2.error || image2.hasDraftConflict ? 'error' : image2.busy || image2.pendingCount ? 'saving' : 'synced'
    : syncStatus;
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if(image2.rawDocument?.schemaVersion===3 && (event.metaKey || event.ctrlKey) && event.key.toLowerCase()==='g' && !target?.isContentEditable && !['INPUT','TEXTAREA','SELECT'].includes(target?.tagName || '')){
        closeContextMenu();event.preventDefault();event.stopImmediatePropagation();void image2.groupSelection(event.shiftKey).catch(error=>setError(error.message));return;
      }
      if (!image2.document || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'z' || target?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName || '')) return;
      closeContextMenu();
      event.preventDefault(); event.stopImmediatePropagation();
      const project = activeProjectId, direction = event.shiftKey ? 'redo' : 'undo';
      historyQueueRef.current = historyQueueRef.current.catch(() => {}).then(async () => {
        if (activeProjectIdRef.current !== project) return;
        try { await image2[direction](); } catch (error) { setError((error as Error).message); }
      });
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [activeProjectId, closeContextMenu, image2]);

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

  const saveCanvasToCloud = useCallback(async (opts?: {silent?: boolean}) => {
    setSyncStatus('saving');
    try { await image2.sync(); setSyncStatus('synced'); return true; }
    catch (error) { setSyncStatus('error'); if (!opts?.silent) { setError((error as Error).message); if (error instanceof Image2ApiError && error.code === 'legacy_import_required') setImagePanel('import'); } return false; }
  }, [image2, setImagePanel]);
  const restoreCanvasFromCloud = useCallback(async () => {
    setSyncStatus('saving');
    try {
      if (!image2.document) {
        const response = await fetch(`${API_BASE}/canvas-snapshots/${encodeURIComponent(activeProjectId)}`, {headers: authHeaders()});
        const value = await response.json() as {detail?: string; data?: {snapshot?: unknown; projectName?: string}};
        if (!response.ok || !value.data?.snapshot) throw new Error(value.detail || '旧云端工程没有可恢复快照');
        if (!editor) throw new Error('画布尚未就绪');
        loadSnapshot(editor.store, value.data.snapshot as Parameters<typeof loadSnapshot>[1]);
        if (value.data.projectName) renameActiveProject(value.data.projectName);
        setImagePanel('import'); setSyncStatus('local'); return true;
      }
      await image2.refresh(); setSyncStatus('synced'); return true;
    }
    catch (error) { setSyncStatus('error'); setError((error as Error).message); return false; }
  }, [activeProjectId, authHeaders, editor, image2, renameActiveProject, setImagePanel]);

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


      } else {
        setSessionId(uid());
        setMessages([]);


      }
      setContextChips([]);
    },
    [messages, sessionId],
  );

  const switchProject = useCallback(
    (id: string) => {
      closeContextMenu();
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
    [activeProjectId, bindSessionToProjectSwitch, closeContextMenu, pastSessions, projectName, projects],
  );

  const createProject = useCallback(() => {
    closeContextMenu();
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
  }, [activeProjectId, bindSessionToProjectSwitch, closeContextMenu, pastSessions, projectName, projects]);

  const deleteActiveProject = useCallback(() => {
    closeContextMenu();
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
  }, [activeProjectId, bindSessionToProjectSwitch, closeContextMenu, pastSessions, projectName, projects]);

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
      setQuickEditDialog({ open: true, src, layerId: image2.getLayer(src)?.id, mode: "edit" });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, elementDialog.open, fontDialog.open, image2, materialDialog.open, quickEditDialog.open]);

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
        if (shape.type !== 'image') {
          const layer = (shape.props as unknown as {layer?: {assetId?: string; type?: string}}).layer;
          if (layer?.assetId) images.push(assetUrl(layer.assetId));
          continue;
        }
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
    try { const value = await image2.export('png'); saveBlob(value.blob, value.name); }
    catch (error) { setError((error as Error).message); }
  }, [image2]);

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
          if (ids.length) { if(image2.rawDocument?.schemaVersion===3)await image2.duplicateLayers();else editor.duplicateShapes(ids, { x: 32, y: 32 }); }
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
        label: '撤销',
        run: async () => { if (image2.document) await image2.undo(); else editor?.undo(); },
      },
      {
        label: '重做',
        run: async () => { if (image2.document) await image2.redo(); else editor?.redo(); },
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
    [editor, exportCanvasPng, image2, placeImageOnCanvas],
  );

  const brushColors = ["black", "grey", "red", "orange", "yellow", "green", "blue", "violet"] as const;
  const brushColorHex = useMemo<Record<string, string>>(() => ({
    black: "#1d1d1d",
    grey: "#9fa8b2",
    red: "#e03131",
    orange: "#f76707",
    yellow: "#ffc034",
    green: "#099268",
    blue: "#4263eb",
    violet: "#ae3ec9",
  }), []);
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
      const urls = { draw: FONT_DRAW_URL, sans: FONT_SANS_URL, serif: FONT_SERIF_URL, mono: FONT_MONO_URL };
      void image2.applyFont(font, urls[font]).catch(error => setError(error.message));
    },
    [editor, image2],
  );

  const applyTextColor = useCallback(
    (color: string) => {
      if (!editor) return;
      setTextColor(color);
      editor.setStyleForNextShapes(DefaultColorStyle, color as never);
      editor.setStyleForSelectedShapes(DefaultColorStyle, color as never);
      if (image2.selectedLayer?.type === 'text') void image2.updateLayer(image2.selectedLayer.id, { fill: brushColorHex[color] }).catch(error => setError(error.message));
    },
    [editor, image2, brushColorHex],
  );

  const applyTextSize = useCallback(
    (size: string) => {
      if (!editor) return;
      setTextSize(size);
      editor.setStyleForNextShapes(DefaultSizeStyle, size as never);
      editor.setStyleForSelectedShapes(DefaultSizeStyle, size as never);
      if (image2.selectedLayer?.type === 'text') void image2.updateLayer(image2.selectedLayer.id, { fontSize: ({s: 18, m: 24, l: 36, xl: 48} as Record<string,number>)[size] || 24 }).catch(error => setError(error.message));
    },
    [editor, image2],
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
    closeContextMenu();
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

  const resultUrls = useCallback((job: ImageJob) => {
    const ids = Array.isArray(job.output?.assetIds) ? job.output.assetIds : job.output?.assetId ? [job.output.assetId] : [];
    return ids.map(id => assetUrl(String(id)));
  }, []);
  const doGenerateImages = useCallback(async (params: { prompt: string; aspect?: string; count?: number; quality?: string; refs?: string[]; kind?: string; transparent?: boolean; imageModel?: string; negativePrompt?: string; outputName?: string }) => {
    const document = await image2.sync();
    const inputs: Array<{role: string; assetId: string}> = [];
    for (const [index, src] of (params.refs || []).slice(0, 6).entries()) {
      // A history/reference URL identifies its original pixels, even after its canvas layer changes.
      const asset = await image2.resolveReference(src, document.id);
      inputs.push({ role: index ? 'reference' : 'base', assetId: asset.id });
    }
    const targetAspect = params.aspect || aspect;
    const dimensions = targetAspect === '16:9' || targetAspect === '3:2' ? { width: 1536, height: 1024 } : targetAspect === '9:16' || targetAspect === '2:3' ? { width: 1024, height: 1536 } : { width: 1024, height: 1024 };
    const completed = await image2.waitJob(await image2.submitOperation('generate', { prompt: [params.prompt, params.kind === 'agent' ? '' : brandText, designMemoryText, params.negativePrompt ? '避免：' + params.negativePrompt : ''].filter(Boolean).join('\n'), n: Math.min(4, params.count || count), quality: params.quality || 'medium', model: params.imageModel, ...dimensions, ...(params.transparent ? { background: 'transparent' } : {}) }, undefined, { documentId: document.id, inputs, mode: 'candidate' }));
    return resultUrls(completed);
  }, [aspect, brandText, count, designMemoryText, image2, resultUrls]);
  const doMaterialTransfer = useCallback(async (params: { target: string; material: string; instruction?: string }) => doGenerateImages({ prompt: '将参考材质用于目标图：' + (params.instruction || ''), refs: [params.target, params.material], count: 1, kind: 'material' }), [doGenerateImages]);
  const doImageEdit = useCallback(async (params: {src: string; instruction: string; kind: string; count?: number; transparent?: boolean}) => doGenerateImages({ prompt: params.instruction, refs: [params.src], count: params.count || 1, transparent: params.transparent, kind: params.kind }), [doGenerateImages]);
  const doGpuMatting = useCallback(async (src: string) => {
    const job = await image2.waitJob(await image2.submitOperation('matting', {}, src));
    return { urls: resultUrls(job), degraded: false as const };
  }, [image2, resultUrls]);
  const doGpuSegment = useCallback(async (src: string, layerId?: string) => {
    const job = await image2.waitJob(await image2.submitOperation('segment', {}, src, { layerId }));
    const ids = Array.isArray(job.output?.maskAssetIds) ? job.output.maskAssetIds : [];
    const urls = ids.map(id => assetUrl(String(id)));
    return { urls, count: urls.length, degraded: false as const };
  }, [image2]);
  /* ---------- 原图像素遮罩：算法与生成共用，保护优先 ---------- */

  const initMaskEditor = useCallback(async (src: string) => {
    const dataUrl = await srcToDataUrl(src);
    const img = await loadImage(dataUrl);
    maskImgRef.current = img;
    const paint = document.createElement("canvas");
    const scale = 1;
    paint.width = Math.round(img.naturalWidth * scale);
    paint.height = Math.round(img.naturalHeight * scale);
    maskPaintRef.current = paint;
    const protect = document.createElement('canvas'); protect.width = paint.width; protect.height = paint.height; maskProtectRef.current = protect;
    const layer = image2.getLayer(src);
    for (const [target, id] of [[paint, layer?.metadata?.editMaskAssetId], [protect, layer?.metadata?.protectMaskAssetId]] as const) {
      if (typeof id !== 'string') continue;
      const saved = await loadImage(assetUrl(id));
      if (saved.naturalWidth !== paint.width || saved.naturalHeight !== paint.height) throw new Error('已存遮罩与原图尺寸不一致');
      target.getContext('2d')?.drawImage(saved, 0, 0);
    }
    setMaskHasPaint(Boolean(layer?.metadata?.editMaskAssetId));
    const view = maskViewRef.current;
    if (!view) return;
    const viewW = Math.min(440, paint.width);
    view.width = viewW;
    view.height = Math.round((paint.height / paint.width) * viewW);
    const ctx = view.getContext("2d");
    if (ctx) {
      ctx.drawImage(img, 0, 0, view.width, view.height);
      for (const [range, color] of [[paint, '#f76d4a'], [protect, '#9875ff']] as const) {
        const overlay = document.createElement('canvas'); overlay.width = range.width; overlay.height = range.height;
        const ox = overlay.getContext('2d')!; ox.fillStyle = color; ox.fillRect(0, 0, overlay.width, overlay.height); ox.globalCompositeOperation = 'destination-in'; ox.drawImage(range, 0, 0);
        ctx.globalAlpha = .45; ctx.drawImage(overlay, 0, 0, view.width, view.height); ctx.globalAlpha = 1;
      }
    }
  }, [image2]);

  const redrawMaskView = useCallback(() => {
    const view = maskViewRef.current;
    const paint = maskPaintRef.current;
    const img = maskImgRef.current;
    if (!view || !paint || !img) return;
    const ctx = view.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, view.width, view.height);
    ctx.drawImage(img, 0, 0, view.width, view.height);
    for (const [range, color] of [[paint, '#f76d4a'], [maskProtectRef.current, '#9875ff']] as const) {
      if (!range) continue;
      const overlay = document.createElement('canvas'); overlay.width = range.width; overlay.height = range.height;
      const ox = overlay.getContext('2d')!; ox.fillStyle = color; ox.fillRect(0, 0, overlay.width, overlay.height); ox.globalCompositeOperation = 'destination-in'; ox.drawImage(range, 0, 0);
      ctx.globalAlpha = .45; ctx.drawImage(overlay, 0, 0, view.width, view.height); ctx.globalAlpha = 1;
    }
  }, []);

  const paintMaskAt = useCallback(
    (clientX: number, clientY: number) => {
      const view = maskViewRef.current;
      const paint = maskMode === "protect" ? maskProtectRef.current : maskPaintRef.current;
      if (!view || !paint) return;
      const rect = view.getBoundingClientRect();
      const scaleX = paint.width / rect.width;
      const scaleY = paint.height / rect.height;
      const ctx = paint.getContext("2d");
      if (!ctx) return;
      ctx.fillStyle = maskMode === "protect" ? "#9875ff" : "#fff";
      ctx.beginPath();
      ctx.arc((clientX - rect.left) * scaleX, (clientY - rect.top) * scaleY, (maskBrush / 2) * scaleX, 0, Math.PI * 2);
      ctx.fill();
      if (maskMode === "edit") setMaskHasPaint(true);
      redrawMaskView();
    },
    [maskBrush, maskMode, redrawMaskView],
  );

  const doMaskInpaint = useCallback(async (instruction: string) => {
    const src = maskDialog.src, paint = maskPaintRef.current, protect = maskProtectRef.current;
    if (!src || !paint || !protect) throw new Error('遮罩未初始化');
    const blob = (canvas: HTMLCanvasElement) => new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('遮罩保存失败')), 'image/png'));
    const editMask = await blob(paint), protectMask = await blob(protect);
    const target = image2.getLayer(src, maskDialog.layerId), backgroundOnly = target?.type === 'text' && target.metadata?.fontConfirmed !== true && ['repair', 'fill', 'inpaint'].includes(maskOperation);
    const job = await image2.waitJob(await image2.submitOperation(maskOperation, { ...(backgroundOnly ? {purpose: 'text_background'} : {}), ...(maskOperation === 'inpaint' ? { prompt: instruction || '自然补全指定区域' } : {}), ...(['recolor', 'fill'].includes(maskOperation) ? { color: maskColor } : {}) }, src, { layerId: maskDialog.layerId, editMask, protectMask, mode: maskOperation === 'inpaint' ? 'candidate' : 'apply' }));
    return resultUrls(job)[0] || src;
  }, [image2, maskColor, maskDialog.layerId, maskDialog.src, maskOperation, resultUrls]);
  /* ---------- 可视化拆层：矢量化按颜色分组 → 每层独立可拖拽 shape ---------- */
  const splitSelectedToLayers = useCallback(async (src: string, layerId?: string) => {
    const job = await image2.waitJob(await image2.submitOperation('restore_layers', {}, src, { layerId, mode: 'candidate' }));
    return Number(job.output?.layerCount || 0);
  }, [image2]);
  const exportSvgFile = useCallback(async () => { try { const value = await image2.export('svg'); saveBlob(value.blob, value.name); return true; } catch (error) { setError((error as Error).message); return false; } }, [image2]);
  const exportAiFile = useCallback(async () => { try { const value = await image2.export('pdf'); saveBlob(value.blob, value.name); return true; } catch (error) { setError((error as Error).message); return false; } }, [image2]);
  const vectorizeSrc = useCallback(async (src: string) => {
    const job = await image2.waitJob(await image2.submitOperation('trace', { preset: 'monochrome', pathomit: 0, blurradius: 0, ltres: .1, qtres: .1 }, src));
    return resultUrls(job)[0] || src;
  }, [image2, resultUrls]);
  const vectorizeSelected = useCallback(async () => { setImagePanel('vector'); return true; }, [setImagePanel]);

  /* --------------------------- agent loop --------------------------- */

  const sendToAgent = useCallback(async () => {
    const text = prompt.trim(), refs = [...attachmentsRef.current.map(item => item.src), ...selectionRef.current.images];
    if ((!text && !refs.length) || agentBusy) return;
    setAgentBusy(true); setError('');
    try {
      const requested = agentModelForText(text);
      const models = (image2.capabilities.agent as {models?: string[]} | undefined)?.models || [];
      const model = requested ? models.find(value => value === requested) || models.find(value => value.split('/').at(-1) === requested) : undefined;
      if (requested && !model) throw new Error(`所选对话模型 ${requested} 未配置，请选择可用模型或移除该模型标记。`);
      await image2.startRun([text || '请分析这些图片', designMemoryText, brandText].filter(Boolean).join('\n'), refs, model);
      setPrompt(''); setAttachments([]); setShowMentionMenu(false);
    } catch (error) { setError((error as Error).message); if (error instanceof Image2ApiError && error.code === 'legacy_import_required') setImagePanel('import'); } finally { setAgentBusy(false); }
  }, [agentBusy, brandText, designMemoryText, image2, prompt, setImagePanel]);

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
        if (err instanceof Image2ApiError && err.code === 'legacy_import_required') setImagePanel('import');
        setError(message);
        pushMessage({ role: "assistant", kind: "error", error: message });
      } finally {
        setBusy(false);
        setBusyLabel("");
      }
    },
    [busy, busyLabel, pushMessage, setImagePanel],
  );

  const generateVariation = useCallback(() => {
    const refs = selection.images.length ? selection.images : references, text = prompt.trim() || '生成同主题变体，保持风格一致';
    void runAction('生成变体', async () => {
      const urls = await doGenerateImages({ prompt: text, refs, count: 1, kind: 'variation' });
      pushMessage({ role: 'assistant', kind: '变体候选', images: urls, text: '请在候选卡片接受后继续修改。' });
    });
  }, [doGenerateImages, prompt, pushMessage, references, runAction, selection.images]);

  /* 打开改字：预览转 dataURL（修裂图）+ 视觉识别行字（Lovart Edit Text 式逐行编辑） */
  const initFontDialog = useCallback((src: string) => {
    setFontText(''); setFontOriginal('');
    setFontAssetChoice(''); setFontDialog({ open: true, src, layerId: image2.getLayer(src)?.id });
    const layer = image2.getLayer(src);
    if (layer?.type === 'text') {
      setFontOriginal(layer.text || ''); setFontText(String(layer.metadata?.desiredText ?? layer.text ?? '')); setFontExactSize(layer.fontSize || 36); setFontExactColor(layer.fill || '#20232b');
      setFontAssetChoice(layer.fontAssetId || '');
    }
    void loadImage(src).then(img => setFontRect({ x: 0, y: 0, width: img.naturalWidth, height: img.naturalHeight })).catch(error => setError(error.message));
  }, [image2]);
  const runFontRestyle = useCallback(() => {
    const src = fontDialog.src, text = fontText.trim(); if (!src || !text) return;
    void runAction('修改文字', async () => {
      const layer = image2.getLayer(src, fontDialog.layerId);
      if (layer?.type === 'text' && layer.metadata?.fontConfirmed === true) await image2.updateLayer(layer.id, { text, fontSize: fontExactSize, fill: fontExactColor });
      else {
        const font = image2.assets.find(asset => asset.id === fontAssetChoice) || await image2.defaultFont();
        await image2.confirmText(src, fontRect, fontOriginal, text, font, fontExactSize, fontExactColor, fontDialog.layerId);
      }
      setFontDialog({ open: false }); pushMessage({ role: 'assistant', kind: '修改文字', text: '已保存为真实文字层，后续改字、颜色和字号不调用生图。' });
    });
  }, [fontAssetChoice, fontDialog.layerId, fontDialog.src, fontExactColor, fontExactSize, fontOriginal, fontRect, fontText, image2, pushMessage, runAction]);

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
  const hasConversation = messages.length > 0 || image2.messages.length > 0 || image2.jobs.length > 0;
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
    if (url.startsWith('/api/v3/image2/')) { setError('2.0 结果已保存；请通过图层面板选择，或在候选卡片接受。'); return; }
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
        >
          <div className="tldrawHost">
            <ProfessionalCanvasContext.Provider value={{ document: image2.professionalDocument, onError: setError }}>
            <Tldraw
              key={activeProjectId}
              hideUi
              shapeUtils={designShapeUtils}
              getShapeVisibility={originalShapeVisibility}
              persistenceKey={persistenceKeyFor(activeProjectId)}
              assetUrls={FONT_ASSET_URLS}
              onMount={handleEditorMount}
              components={professionalCanvasComponents}
            />
            </ProfessionalCanvasContext.Provider>
          </div>

          {contextMenu.open ? (
            <div ref={contextMenuRef} className="contextMenu" style={{ left: contextMenu.x, top: contextMenu.y }}>
              {/* eslint-disable-next-line react-hooks/refs -- Mapping renders labels and click handlers; editor refs are read only when an action runs. */}
              {contextActions.map((action) => (
                <button
                  key={action.label}
                  type="button"
                  onClick={() => {
                    closeContextMenu();
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

          {toolId === "text" || image2.selectedLayer?.type === "text" ? (
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
                className={`syncStatusIcon ${currentSyncStatus}`}
                type="button"
                title={
                  currentSyncStatus === "synced"
                    ? `已保存到图片工程版本 ${image2.document?.revision ?? ''}`
                    : currentSyncStatus === "saving"
                      ? "正在保存图片工程，未提交的修改保存在本机草稿"
                      : currentSyncStatus === "error"
                        ? image2.hasDraftConflict ? "版本冲突，本地草稿已保留；请打开版本窗口处理" : "图片工程同步失败，点此重试"
                        : "当前为本地旧工程，使用升级功能前需确认导入"
                }
                aria-label="cloud sync status"
                onClick={() => {
                  void saveCanvasToCloud();
                }}
              >
                {currentSyncStatus === "synced" ? (
                  <CloudCheck size={15} />
                ) : currentSyncStatus === "saving" ? (
                  <Loader2 size={15} className="spin" />
                ) : currentSyncStatus === "error" ? (
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
                  <button type="button" className="exportMenuItem" onClick={() => { setExportMenu(false); setCraftReview(null); setCraftToolsOpen(true); }}>
                    <LayoutGrid size={14} /> 专业工具
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
                    <Download size={14} /> 导出 PDF（画布/选中）
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

          {busy || agentBusy || image2Running ? (
            <div className="floatingStatus">
              <Loader2 className="spin" size={14} />
              {busyLabel || (agentBusy || image2Running ? "后台任务进行中…" : "Generating…")}
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
                  setQuickEditDialog({ open: true, src: selection.images[0], layerId: image2.getLayer(selection.images[0])?.id, mode: "edit" });
                }}
              >
                <Wand2 size={14} />
                快改
                <kbd>Tab</kbd>
              </button>
              <button
                type="button"
                onClick={() => setImagePanel("upscale")}
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
                  setMaskInstruction(""); setMaskMode("edit"); setMaskOperation("erase");
                  setMaskDialog({ open: true, src, layerId: image2.getLayer(src)?.id });
                  setTimeout(() => void initMaskEditor(src).catch(error => setError(error.message)), 60);
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
                  setElementDialog({ open: true, src: selection.images[0], layerId: image2.getLayer(selection.images[0])?.id });
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
                PDF
              </button>
            </div>
          ) : null}

          <div className="bottomStatus">
            <button className="ghostIcon" type="button" aria-label="shapes">
              <Circle size={15} />
            </button>
            <button className="ghostIcon" type="button" aria-label="layers" onClick={() => { setImagePanel("layers"); void image2.ensureDocument().catch(() => {}); }}>
              <Layers size={15} />
            </button>
            <button className="ghostIcon" type="button" aria-label="search">
              <FileSearch size={15} />
            </button>
            <button className="ghostIcon" type="button" aria-label="versions" onClick={() => { setImagePanel("versions"); void image2.ensureDocument().catch(() => {}); }}>
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
              title="改字与真实字体编辑"
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
                if (message.role === 'assistant' && message.images?.some(url => image2.jobs.some(job => job.output?.branchDocumentId && resultUrls(job).includes(url)))) return null;
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
              {image2.messages.map(message => <div key={message.id} className={message.role === 'user' ? 'msgUser' : 'msgAssistant'}>{message.role !== 'user' && <div className="msgKind"><Sparkles size={12} /> Agent</div>}{renderAssistantText(String(message.text || message.content || ''))}</div>)}
              {image2.jobs.filter(job => job.output?.branchDocumentId || job.state === 'uncertain' || job.state === 'failed').map(job => <CandidateResult key={job.id} job={job} bridge={image2} onError={setError} onViewVersions={() => setImagePanel('versions')} onViewNativeCandidate={viewNativeCandidate} />)}
              {agentBusy || image2Running ? (
                <div className="msgAssistant msgAction">
                  <div className="msgKind">
                    <Loader2 className="spin" size={12} />
                    正在处理后台任务…
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
              <span>通过涂抹明确修改与保护范围，生成结果先进入候选</span>
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
                  setMaskMode('edit'); setMaskOperation(isErase ? 'repair' : 'inpaint'); setMaskInstruction(text); setMaskDialog({open: true, src, layerId: quickEditDialog.layerId});
                  setTimeout(() => void initMaskEditor(src).catch(error => setError(error.message)), 60);
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
            <div className="inlineOptions"><button className={maskMode === 'edit' ? 'on' : ''} onClick={() => setMaskMode('edit')}>修改范围</button><button className={maskMode === 'protect' ? 'on' : ''} onClick={() => setMaskMode('protect')}>保护范围</button></div>
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
                  const paint = maskMode === "protect" ? maskProtectRef.current : maskPaintRef.current;
                  paint?.getContext("2d")?.clearRect(0, 0, paint.width, paint.height);
                  if (maskMode === "edit") setMaskHasPaint(false);
                  redrawMaskView();
                }}
              >
                清除涂抹
              </button>
              <button className="ghostButton" type="button" onClick={() => {
                const src = maskDialog.src, layer = src ? image2.getLayer(src, maskDialog.layerId) : undefined;
                if (!layer) { setError('请先导入工程'); return; }
                void image2.updateLayer(layer.id, { metadata: {...layer.metadata, editMaskAssetId: null, protectMaskAssetId: null} }).then(() => {
                  for (const range of [maskPaintRef.current, maskProtectRef.current]) range?.getContext('2d')?.clearRect(0, 0, range.width, range.height);
                  setMaskHasPaint(false); redrawMaskView();
                }).catch(error => setError(error.message));
              }}>取消局部范围</button>
              {image2.rawDocument?.schemaVersion===3 && <button className="ghostButton" type="button" disabled={!maskHasPaint} onClick={()=>void (async()=>{
                const src=maskDialog.src,paint=maskPaintRef.current,protect=maskProtectRef.current,layer=src?image2.getLayer(src,maskDialog.layerId):undefined;
                if(!src||!paint||!protect||!layer)throw new Error('请选择原图并涂画范围');
                const toBlob=(canvas:HTMLCanvasElement)=>new Promise<Blob>((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(new Error('范围保存失败')),'image/png'));
                await image2.setMasks(src,await toBlob(paint),await toBlob(protect),layer.id);await image2.saveEditSelection(layer.id);setError('');
              })().catch(error=>setError(error.message))}>保存为选区</button>}
            </div>
            <label>处理方式<select aria-label="局部处理方式" value={maskOperation} onChange={event => setMaskOperation(event.target.value)}><option value="erase">擦除为透明（算法）</option><option value="repair">传统修补（算法）</option><option value="recolor">局部换色（算法）</option><option value="fill">局部填色（算法）</option><option value="inpaint">局部补画（生成模型）</option></select></label>
            {!capability(image2.capabilities, maskOperation).available && <p role="status">{capability(image2.capabilities, maskOperation).reason || '当前能力不可用'}</p>}
            {['recolor', 'fill'].includes(maskOperation) && <label>处理颜色<input aria-label="局部处理颜色" type="color" value={maskColor} onChange={event => setMaskColor(event.target.value)} /></label>}
            <label>
              生成补画指令（仅补画时使用）
              <input
                value={maskInstruction}
                onChange={(event) => setMaskInstruction(event.target.value)}
                placeholder="例如：在修改范围内补画一朵花" disabled={maskOperation !== "inpaint"}
              />
            </label>
            <div className="dialogFooter">
              <span>保护范围优先；修改区外保留原像素。补画先进入候选。</span>
              <button
                className="darkButton"
                type="button"
                disabled={!maskHasPaint || !capability(image2.capabilities, maskOperation).available}
                onClick={() => {
                  const instruction = maskInstruction;
                  setMaskDialog(current => ({ ...current, open: false }));
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
            {elementPreviewSrc ? (
              <div className="dialogPreview">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={elementPreviewSrc} alt="selected" />
              </div>
            ) : null}
            {elementOp !== "layers" && elementOp !== "smart-split" ? (
              <label>
                目标备注（像素范围以涂抹为准）
                <input
                  autoFocus
                  value={elementTarget}
                  onChange={(event) => setElementTarget(event.target.value)}
                  placeholder="例如：外圈圆环；请通过下方涂抹明确区域"
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
                    elementOp === "recolor" ? "例如：#8b1e2d" : elementOp === "replace" ? "例如：一枝樱花" : "例如：让它更立体、加投影"
                  }
                />
              </label>
            ) : null}
            {elementOp !== 'layers' && elementOp !== 'smart-split' && <button className="ghostButton" type="button" disabled={!elementPreviewSrc} onClick={() => {
              const src = elementPreviewSrc; if (!src) return;
              setElementDialog({open: false}); setMaskMode('edit'); setMaskOperation(elementOp === 'recolor' ? 'recolor' : elementOp === 'remove' ? 'erase' : 'inpaint');
              const colour = elementColours[elementValue.trim()] || elementValue.trim();
              if (/^#[0-9a-f]{6}$/i.test(colour)) setMaskColor(colour);
              setMaskInstruction(elementValue); setMaskDialog({open: true, src, layerId: elementDialog.layerId});
              setTimeout(() => void initMaskEditor(src).catch(error => setError(error.message)), 60);
            }}>涂抹修改 / 保护范围</button>}
            {!elementPreviewSrc && <p role="status">当前目标图层或素材暂不可用，请重新选择当前图层。</p>}
            {elementPreviewSrc && <LegacyImageAdjustments bridge={image2} src={elementPreviewSrc} layerId={elementDialog.layerId} onError={setError} />}
            <div className="dialogFooter">
              <span>
                {elementOp === "layers"
                  ? "OCR 与分割还原图层，保留未知字体和原始像素；先进入候选"
                  : elementOp === "smart-split"
                    ? "GPU 语义分割：输出 overlay/mask，失败不影响其他编辑"
                    : "换色与透明擦除直接执行算法；已有遮罩优先，否则处理整张图层"}
              </span>
              <button
                className="darkButton"
                type="button"
                disabled={
                  !elementPreviewSrc || (elementOp === "layers" || elementOp === "smart-split"
                    ? false
                    : elementOp !== "remove" && !elementValue.trim())
                }
                onClick={() => {
                  const src = elementPreviewSrc;
                  if (!src) return;
                  setElementDialog({ open: false });
                  if (elementOp === "smart-split") {
                    void runAction("智能拆层", async () => {
                      pushMessage({ role: "user", text: "智能拆层 / 语义分割" });
                      try {
                        const result = await doGpuSegment(src, elementDialog.layerId);
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
                            ? "分割服务暂不可用，当前图片已保留。"
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
                      const layerCount = await splitSelectedToLayers(src, elementDialog.layerId);
                      pushMessage({
                        role: "assistant",
                        kind: "拆分图层",
                        text: `候选已还原 ${layerCount} 个图层。未知字体和未识别内容保留原像素，接受后可继续修改。`,
                      });
                    });
                    return;
                  }
                  const value = elementValue.trim();
                  if (elementOp === 'replace' || elementOp === 'free') {
                    setMaskMode('edit'); setMaskOperation('inpaint'); setMaskInstruction(value); setMaskDialog({open: true, src, layerId: elementDialog.layerId});
                    setTimeout(() => void initMaskEditor(src).catch(error => setError(error.message)), 60); return;
                  }
                  void runAction('元素编辑', async () => {
                    const color = elementColours[value] || value;
                    if (elementOp === 'recolor' && !/^#[0-9a-f]{6}$/i.test(color)) throw new Error('请输入明确的六位颜色值，如 #8b1e2d。');
                    const layer = image2.getLayer(src, elementDialog.layerId);
                    if (elementTarget.trim() && !/^(全部|全图|整个图层|整张图片|整张图层|whole layer)$/i.test(elementTarget.trim()) && !layer?.metadata?.editMaskAssetId) throw new Error('请先涂抹目标修改范围；文字备注不会自动选取像素。');
                    if (layer?.type === 'vector' || layer?.type === 'text' && layer.metadata?.fontConfirmed === true) {
                      if (elementOp === 'recolor') await image2.updateLayer(layer.id, {fill:color});
                      else await image2.submitCommands([{type:'layer.remove',layerId:layer.id}]);
                      pushMessage({role:'assistant',kind:'元素编辑',text:'已直接修改独立图层，可在版本中撤销。'}); return;
                    }
                    const job = await image2.waitJob(await image2.submitOperation(elementOp === 'recolor' ? 'recolor' : 'erase', elementOp === 'recolor' ? {color} : {}, src, {layerId:elementDialog.layerId}));
                    pushMessage({ role: 'assistant', kind: '元素编辑', text: '已通过算法保存，可在版本中撤销。', images: resultUrls(job) });
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
            <p className="ocrHint">已确认的文字层可直接编辑。扁平图片首次改字需要明确原字区域和实际字体；复杂背景保留原像素等待修补。</p>
            <label>原文字内容<input aria-label="原文字内容" value={fontOriginal} onChange={event => setFontOriginal(event.target.value)} placeholder="用于保存识别信息，不自动猜测原字体" /></label>
            <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8}}>{(['x','y','width','height'] as const).map(field => <label key={field}>{({x: '区域 X', y: '区域 Y', width: '区域宽度', height: '区域高度'})[field]}<input aria-label={`文字区域 ${field}`} type="number" min={field === 'width' || field === 'height' ? 1 : 0} value={fontRect[field]} onChange={event => setFontRect(current => ({...current, [field]: Number(event.target.value)}))} /></label>)}</div>
            <label>新文字内容<input autoFocus aria-label="新文字内容" value={fontText} onChange={event => setFontText(event.target.value)} placeholder="例如：云东 AI 视觉" /></label>
            <label>确认实际字体<select aria-label="确认实际字体" value={fontAssetChoice} onChange={event => setFontAssetChoice(event.target.value)}><option value="">内置中文字体</option>{image2.assets.filter(asset => asset.metadata?.family).map(asset => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></label>
            <label>上传实际字体<input aria-label="改字上传字体" type="file" accept=".ttf,.otf,.woff,.woff2" onChange={event => {const file = event.target.files?.[0]; if (file) void image2.uploadFile(file, file.name, 'font').then(asset => setFontAssetChoice(asset.id)).catch(error => setError(error.message)); event.target.value='';}} /></label>
            <label>精确字号<input aria-label="精确字号" type="number" min="1" value={fontExactSize} onChange={event => setFontExactSize(Number(event.target.value))} /></label>
            <label>文字颜色<input aria-label="文字颜色" type="color" value={fontExactColor} onChange={event => setFontExactColor(event.target.value)} /></label>
            <div className="dialogFooter"><span>简单背景清底后转换为真实文字；后续修改不调用生图</span><button className="darkButton" type="button" disabled={!fontText.trim() || !fontRect.width || !fontRect.height} onClick={runFontRestyle}>清底并应用文字</button></div>
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

      <LegacyImagePanels mode={imagePanel} onClose={() => { if (imagePanelEpoch.current === renderedPanelEpoch) setImagePanel(null); }} bridge={image2} onError={setError} onViewNativeCandidate={viewNativeCandidate} />
      <CraftToolsDialog key={`${activeProjectId}:${craftReview?.branchId || image2.rawDocument?.id || 'new'}:${craftReview?.projectId || ''}`} open={craftToolsOpen} onClose={() => setCraftToolsOpen(false)} bridge={image2} documentIdOverride={craftReview?.branchId} initialProjectId={craftReview?.projectId} reviewOnly={!!craftReview} />
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
    export_ai: "导出 PDF",
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
