"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ArrowUp,
  AudioLines,
  BookOpen,
  ChevronDown,
  Circle,
  Clapperboard,
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
  Zap,
} from "lucide-react";
import {
  AssetRecordType,
  DefaultColorStyle,
  DefaultSizeStyle,
  Tldraw,
  createShapeId,
  exportToBlob,
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
  | { id: string; role: "user"; text: string; ts: number }
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
type OaiMessage =
  | { role: "user" | "system"; content: string }
  | { role: "assistant"; content?: string | null; tool_calls?: OaiToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

type AgentSession = { id: string; title: string; ts: number; messages: ChatMessage[]; oai: OaiMessage[] };

function sessionTitleOf(messages: ChatMessage[]) {
  const first = messages.find((m) => m.role === "user") as { text?: string } | undefined;
  const text = (first?.text || "").replace(/\s+/g, " ").trim();
  if (!text) return "New chat";
  return text.length > 24 ? `${text.slice(0, 24)}…` : text;
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
/* page                                                                */
/* ------------------------------------------------------------------ */

export default function Home() {
  const [editor, setEditor] = useState<Editor | null>(null);

  const [token, setToken] = useState("");
  const [tokenLoaded, setTokenLoaded] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [style, setStyle] = useState(stylePresets[0]);
  const [aspect, setAspect] = useState("1:1");
  const [count, setCount] = useState(2);
  const [brand, setBrand] = useState("");
  const [audience, setAudience] = useState("");
  const [negativePrompt, setNegativePrompt] = useState("");
  const [references, setReferences] = useState<string[]>([]);

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
  const [elementOp, setElementOp] = useState<"recolor" | "remove" | "replace" | "free" | "layers">("recolor");
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
  const [fontDialog, setFontDialog] = useState<{ open: boolean; src?: string; preview?: string }>({ open: false });
  const [fontLines, setFontLines] = useState<Array<{ from: string; to: string }> | null>(null);
  const [fontOcr, setFontOcr] = useState<"idle" | "loading" | "done" | "failed">("idle");
  const [fontText, setFontText] = useState("");
  const [fontNote, setFontNote] = useState("");
  const [materialDialog, setMaterialDialog] = useState<{ open: boolean; a?: string; b?: string }>({ open: false });
  const [materialSwap, setMaterialSwap] = useState(false);
  const [materialNote, setMaterialNote] = useState("");
  const [exportMenu, setExportMenu] = useState(false);
  const [projectName, setProjectName] = useState("Untitled");

  const [countdown, setCountdown] = useState("00040000");

  const fileInputRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const placeCounter = useRef(0);
  const recognitionRef = useRef<{ stop: () => void } | null>(null);
  const oaiHistoryRef = useRef<OaiMessage[]>([]);
  const selectionRef = useRef(selection);

  useEffect(() => {
    selectionRef.current = selection;
  }, [selection]);

  /* ------------------------------ boot ------------------------------ */

  useEffect(() => {
    setToken(localStorage.getItem("videoApiToken") || "");
    setTokenLoaded(true);
    try {
      setHistory(JSON.parse(localStorage.getItem("lovartHistory") || "[]"));
    } catch {
      setHistory([]);
    }
    setProjectName(localStorage.getItem("lovartProjectName") || "Untitled");
    try {
      const saved = JSON.parse(localStorage.getItem("lovartSessions") || "[]") as AgentSession[];
      setPastSessions(saved);
      const last = saved[0];
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

  /* 会话持久化：当前会话始终占列表第一位（刷新后自动恢复） */
  useEffect(() => {
    if (!tokenLoaded) return;
    setPastSessions((prev) => {
      const rest = prev.filter((s) => s.id !== sessionId);
      const next = messages.length
        ? [{ id: sessionId, title: sessionTitleOf(messages), ts: Date.now(), messages, oai: oaiHistoryRef.current }, ...rest]
        : prev;
      localStorage.setItem("lovartSessions", JSON.stringify(next.slice(0, 20)));
      return next.slice(0, 20);
    });
  }, [messages, sessionId, tokenLoaded]);

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
    const timer = setInterval(() => setTick((v) => v + 1), 1000);
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

  const handleFiles = async (list: FileList | null) => {
    if (!list?.length) return;
    for (const file of Array.from(list).slice(0, 6)) {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("读取文件失败"));
        reader.readAsDataURL(file);
      });
      await placeImageOnCanvas(dataUrl, file.name);
      setReferences((prev) => [...prev, dataUrl].slice(-4));
    }
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

  const pushHistory = useCallback((entry: Omit<HistoryEntry, "id" | "ts">) => {
    setHistory((prev) => [{ id: uid(), ts: Date.now(), ...entry }, ...prev].slice(0, 60));
  }, []);

  type NewChatMessage =
    | { id?: string; role: "user"; text: string }
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
    }) => {
      const referenceImages = await Promise.all((params.refs || []).slice(0, 4).map((src) => srcToDataUrl(src)));
      const placeholderId = createPlaceholder("生成图片");
      try {
        const payload = await api<ImagesResult>("/images", {
          method: "POST",
          body: JSON.stringify({
            prompt: params.prompt,
            raw_prompt: params.kind === "agent" ? params.prompt : undefined,
            style: params.kind === "agent" ? undefined : style,
            brand: params.kind === "agent" ? undefined : brand,
            audience: params.kind === "agent" ? undefined : audience,
            negative_prompt: params.kind === "agent" ? undefined : negativePrompt,
            aspect_ratio: params.aspect || aspect,
            n: Math.max(1, Math.min(4, params.count || count)),
            ...(params.quality ? { quality: params.quality } : {}),
            ...(params.transparent ? { background: "transparent" } : {}),
            ...(referenceImages.length ? { reference_images: referenceImages } : {}),
          }),
        });
        const urls = (payload.data?.images || []).map((item) => String(item.public_url || "")).filter(Boolean);
        removePlaceholder(placeholderId);
        const targetAspect = params.aspect || aspect;
        for (const url of urls) {
          const cropped = targetAspect === "16:9" || targetAspect === "9:16" ? await cropToAspect(url, targetAspect) : url;
          await placeImageOnCanvas(cropped);
        }
        pushHistory({
          kind: params.kind === "agent" ? "agent-images" : "images",
          prompt: params.prompt,
          outputs: urls.map((url) => ({ url })),
        });
        return urls;
      } finally {
        removePlaceholder(placeholderId);
      }
    },
    [api, aspect, audience, brand, count, createPlaceholder, negativePrompt, placeImageOnCanvas, pushHistory, removePlaceholder, style],
  );

  const doFontRestyle = useCallback(
    async (params: { src: string; newText: string; note?: string; lineEdits?: Array<{ from: string; to: string }> }) => {
      const imageB64 = await srcToDataUrl(params.src);
      const placeholderId = createPlaceholder("同风格改字");
      try {
        const payload = await api<ImagesResult>("/font-restyle", {
          method: "POST",
          body: JSON.stringify({
            image_b64: imageB64,
            new_text: params.newText,
            style_note: params.note || "",
            ...(params.lineEdits?.length ? { line_edits: params.lineEdits } : {}),
            aspect_ratio: aspect,
            n: 1,
          }),
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
    [api, aspect, createPlaceholder, placeImageOnCanvas, pushHistory, removePlaceholder],
  );

  const doMaterialTransfer = useCallback(
    async (params: { target: string; material: string; instruction?: string }) => {
      const composite = await compositeTargetWithSwatch(await srcToDataUrl(params.target), await srcToDataUrl(params.material));
      const payload = await api<ImagesResult>("/material-transfer", {
        method: "POST",
        body: JSON.stringify({ image_b64: composite, instruction: params.instruction || "", aspect_ratio: aspect, n: 1 }),
      });
      const urls = (payload.data?.images || []).map((item) => String(item.public_url || "")).filter(Boolean);
      for (const url of urls) await placeImageOnCanvas(url, "material");
      pushHistory({ kind: "material-transfer", prompt: params.instruction || "材质复刻", outputs: urls.map((url) => ({ url })) });
      return urls;
    },
    [api, aspect, placeImageOnCanvas, pushHistory],
  );

  /* 指令式图片编辑：参考图 + 指令重绘（Quick Edit / Upscale / Remove BG / Eraser / Multi-Angles 共用管线） */
  const doImageEdit = useCallback(
    async (params: { src: string; instruction: string; kind: string; count?: number; transparent?: boolean }) => {
      const referenceImage = await srcToDataUrl(params.src);
      const placeholderId = createPlaceholder("修改图片");
      try {
        const payload = await api<ImagesResult>("/images", {
          method: "POST",
          body: JSON.stringify({
            prompt: `严格以参考图为基础重绘：${params.instruction}。除指令要求的修改外，主体、构图、风格、配色、文字内容全部保持与参考图一致。`,
            raw_prompt: `严格以参考图为基础重绘：${params.instruction}。除指令要求的修改外，主体、构图、风格、配色、文字内容全部保持与参考图一致。`,
            aspect_ratio: aspect,
            n: Math.max(1, Math.min(4, params.count || 1)),
            ...(params.transparent ? { background: "transparent" } : {}),
            reference_images: [referenceImage],
          }),
        });
        const urls = (payload.data?.images || []).map((item) => String(item.public_url || "")).filter(Boolean);
        removePlaceholder(placeholderId);
        for (const url of urls) await placeImageOnCanvas(url, params.kind);
        pushHistory({ kind: params.kind, prompt: params.instruction, outputs: urls.map((url) => ({ url })) });
        return urls;
      } finally {
        removePlaceholder(placeholderId);
      }
    },
    [api, aspect, createPlaceholder, placeImageOnCanvas, pushHistory, removePlaceholder],
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

  /* mask 外取原图、mask 内取重绘结果，边缘羽化 */
  const compositeByMask = useCallback((img: HTMLImageElement, result: HTMLImageElement, paint: HTMLCanvasElement) => {
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
  }, []);

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
        const payload = await api<{ image_b64?: string }>("/inpaint", {
          method: "POST",
          body: JSON.stringify({ image_b64: imageB64, mask_b64: maskB64, instruction: finalInstruction, size: "1024x1024" }),
        });
        const b64 = (payload.data as { image_b64?: string } | undefined)?.image_b64;
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
        const payload = await api<ImagesResult>("/images", {
          method: "POST",
          body: JSON.stringify({
            prompt: `参考图中红色半透明标记的区域需要重绘：${finalInstruction}。未标记区域保持与参考图完全一致。输出图中不得出现任何红色标记。`,
            raw_prompt: `参考图中红色半透明标记的区域需要重绘：${finalInstruction}。未标记区域保持与参考图完全一致。输出图中不得出现任何红色标记。`,
            aspect_ratio: w >= h ? (w === h ? "1:1" : "3:2") : "2:3",
            n: 1,
            reference_images: [annotated.toDataURL("image/png")],
          }),
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
    [api, compositeByMask, placeImageOnCanvas, pushHistory],
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

  const startImageToVideo = useCallback(
    async (params: { src: string; subject: string }) => {
      const imageB64 = await srcToDataUrl(params.src);
      const created = await api<{ image_job_id?: string; job_id?: string }>("/image-videos", {
        method: "POST",
        body: JSON.stringify({
          video_subject: params.subject,
          video_aspect: aspect === "16:9" || aspect === "3:2" ? "16:9" : "9:16",
          first_image_b64: imageB64,
          video_clip_duration: 8,
        }),
      });
      const createdData = (created.data || created) as { image_job_id?: string; job_id?: string };
      const jobId = String(createdData.image_job_id || createdData.job_id || "");
      if (!jobId) throw new Error("视频任务创建失败");
      void (async () => {
        for (let attempt = 0; attempt < 120; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 5000));
          try {
            const status = await api<Record<string, unknown>>(`/image-videos/${jobId}`);
            const data = (status.data || {}) as Record<string, unknown>;
            const drive = (data.drive_video as { webViewLink?: string } | undefined)?.webViewLink;
            const storage = (data.storage_video as { public_url?: string } | undefined)?.public_url;
            if (drive || storage) {
              const url = String(storage || drive);
              setVideoUrl(url);
              pushMessage({ role: "assistant", kind: "视频", videoUrl: url });
              pushHistory({ kind: "video", prompt: params.subject, outputs: [], videoUrl: url });
              return;
            }
            const state = String(data.state ?? "");
            if (state === "failed" || state === "error") {
              setError(String(data.error || "视频生成失败"));
              return;
            }
          } catch {
            /* transient poll error */
          }
        }
        setError("视频生成超时，可稍后在历史里重查");
      })();
      return jobId;
    },
    [api, aspect, pushHistory, pushMessage],
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

  const vectorizeSelected = useCallback(async () => {
    const src = selectionRef.current.images[0];
    if (!src) {
      setError("先选中一张图片再矢量化");
      return false;
    }
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
      return true;
    } finally {
      setBusy(false);
      setBusyLabel("");
    }
  }, [placeImageOnCanvas, pushHistory]);

  /* --------------------------- agent loop --------------------------- */

  const execAgentTool = useCallback(
    async (name: string, args: Record<string, unknown>) => {
      const sel = selectionRef.current;
      switch (name) {
        case "generate_images": {
          const urls = await doGenerateImages({
            prompt: String(args.prompt || ""),
            aspect: args.aspect ? String(args.aspect) : undefined,
            count: args.count ? Number(args.count) : 1,
            quality: args.quality ? String(args.quality) : undefined,
            transparent: Boolean(args.transparent_background),
            refs: args.use_selected_reference ? sel.images.slice(0, 2) : undefined,
            kind: "agent",
          });
          pushMessage({ role: "assistant", kind: "生成图片", images: urls });
          setContextChips(urls.slice(0, 2));
          return `已生成 ${urls.length} 张图并放到画布。链接：\n${urls.join("\n")}`;
        }
        case "restyle_lettering": {
          const src = sel.images[0];
          if (!src) return "失败：画布上没有选中的图片，请提醒用户先选中包含字体设计的图片。";
          const urls = await doFontRestyle({
            src,
            newText: String(args.new_text || ""),
            note: args.style_note ? String(args.style_note) : "",
          });
          pushMessage({ role: "assistant", kind: "同风格改字", images: urls });
          return `改字完成，已放到画布。链接：\n${urls.join("\n")}`;
        }
        case "transfer_material": {
          if (sel.images.length < 2) return "失败：需要同时选中两张图片（目标图案 + 材质样本），请提醒用户。";
          const swap = Boolean(args.swap);
          const target = swap ? sel.images[1] : sel.images[0];
          const material = swap ? sel.images[0] : sel.images[1];
          const urls = await doMaterialTransfer({ target, material, instruction: args.instruction ? String(args.instruction) : "" });
          pushMessage({ role: "assistant", kind: "材质复刻", images: urls });
          return `材质复刻完成，已放到画布。链接：\n${urls.join("\n")}`;
        }
        case "edit_selected_image": {
          const src = sel.images[0];
          if (!src) return "失败：画布上没有选中的图片，请提醒用户先选中要修改的图片。";
          const urls = await doImageEdit({ src, instruction: String(args.instruction || ""), kind: "quick-edit" });
          pushMessage({ role: "assistant", kind: "图片修改", images: urls });
          setContextChips(urls.slice(0, 2));
          return `修改完成，已放到画布。链接：\n${urls.join("\n")}`;
        }
        case "image_to_video": {
          const src = sel.images[0];
          if (!src) return "失败：画布上没有选中的图片，请提醒用户先选中。";
          const jobId = await startImageToVideo({ src, subject: String(args.subject || "让画面自然动起来") });
          return `视频任务已提交（job ${jobId}），完成后页面会弹出播放链接，无需等待。`;
        }
        case "vectorize_selected": {
          const ok = await vectorizeSelected();
          return ok ? "矢量化完成，SVG 已开始下载。" : "失败：画布上没有选中的图片。";
        }
        case "export_ai": {
          const ok = await exportAiFile();
          return ok ? ".ai 文件已开始下载（PDF 兼容，Illustrator 可直接打开）。" : "失败：画布上还没有内容。";
        }
        default:
          return `未知工具 ${name}`;
      }
    },
    [doFontRestyle, doGenerateImages, doMaterialTransfer, exportAiFile, pushMessage, startImageToVideo, vectorizeSelected],
  );

  const sendToAgent = useCallback(async () => {
    const text = prompt.trim();
    if (!text || agentBusy) return;
    if (!token) {
      setError("先在 Agent 面板里填 VIDEO_API_TOKEN");
      setShowAgentMenu(true);
      return;
    }
    setPrompt("");
    setShowMentionMenu(false);
    setError("");
    pushMessage({ role: "user", text });
    oaiHistoryRef.current.push({ role: "user", content: text });
    setAgentBusy(true);
    try {
      for (let round = 0; round < AGENT_MAX_ROUNDS; round += 1) {
        const sel = selectionRef.current;
        const rawResponse = await fetch("/api/agent-chat", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({
            messages: oaiHistoryRef.current,
            canvas_state: {
              selectedImageCount: sel.images.length,
              canvasShapeCount: shapeCount,
              lastGeneratedImages: contextChips,
              defaults: { style, aspect, count, brand, audience, negativePrompt },
            },
          }),
        });
        const response = (await rawResponse.json().catch(() => ({}))) as {
          detail?: string;
          data?: { message: { content?: string | null; tool_calls?: OaiToolCall[] } };
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
            result = `失败：${err instanceof Error ? err.message : String(err)}`;
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
  }, [agentBusy, api, aspect, audience, brand, contextChips, count, execAgentTool, negativePrompt, prompt, pushMessage, shapeCount, style, token]);

  /* --------------------------- ui handlers -------------------------- */

  const runAction = useCallback(
    async (label: string, fn: () => Promise<void>) => {
      if (busy) return;
      if (!token) {
        setError("先在 Agent 面板里填 VIDEO_API_TOKEN");
        setShowAgentMenu(true);
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
    [busy, pushMessage, token],
  );

  const generateVariation = useCallback(() => {
    const refs = selection.images.length ? selection.images : references;
    const text = prompt.trim() || "生成同主题变体，保持风格一致";
    void runAction("生成变体", async () => {
      pushMessage({ role: "user", text });
      const urls = await doGenerateImages({ prompt: text, refs, kind: "variation" });
      pushMessage({ role: "assistant", kind: "生成变体", images: urls });
    });
  }, [doGenerateImages, prompt, pushMessage, references, runAction, selection.images]);

  const sendSelectedToVideo = useCallback(() => {
    const src = selection.images[0];
    if (!src) {
      setError("先选中画布上的一张图片");
      return;
    }
    const subject = prompt.trim() || "让画面自然地动起来，镜头缓慢推进";
    void runAction("图生视频", async () => {
      pushMessage({ role: "user", text: `图生视频：${subject}` });
      const jobId = await startImageToVideo({ src, subject });
      pushMessage({ role: "assistant", kind: "视频任务", text: `已提交 job ${jobId}，完成后弹出链接` });
    });
  }, [prompt, pushMessage, runAction, selection.images, startImageToVideo]);

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
          const payload = await api<{ lines?: string[] }>("/ocr-lines", {
            method: "POST",
            body: JSON.stringify({ image_b64: preview.startsWith("data:") ? preview : await srcToDataUrl(src) }),
          });
          const lines = ((payload.data as { lines?: string[] } | undefined)?.lines || []).filter(Boolean);
          if (lines.length) {
            setFontLines(lines.map((line) => ({ from: line, to: line })));
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
    const edits = (fontLines || []).filter((line) => line.to.trim() && line.to.trim() !== line.from.trim());
    const text = fontText.trim();
    if (!src || (!text && !edits.length)) return;
    setFontDialog({ open: false });
    const summary = edits.length ? edits.map((line) => `“${line.from}”→“${line.to}”`).join("、") : `“${text}”`;
    void runAction("同风格改字", async () => {
      pushMessage({ role: "user", text: `同风格改字 → ${summary}` });
      const urls = await doFontRestyle({ src, newText: text, note: fontNote, lineEdits: edits });
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
            <Tldraw hideUi persistenceKey="lovart-visual-canvas-v3" onMount={(instance) => setEditor(instance)} />
          </div>

          {contextMenu.open ? (
            <div className="contextMenu" style={{ left: contextMenu.x, top: contextMenu.y }}>
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

          <div className="canvasTop">
            <div className="titleCluster">
              <button className="logoBadge" type="button" aria-label="home">
                <span>Lō</span>
              </button>
              <input
                className="titleInput"
                value={projectName}
                aria-label="project title"
                onChange={(event) => setProjectName(event.target.value)}
                onBlur={() => {
                  const name = projectName.trim() || "Untitled";
                  setProjectName(name);
                  localStorage.setItem("lovartProjectName", name);
                }}
              />
              <button className="ghostIcon" type="button" aria-label="theme">
                <Palette size={15} />
              </button>
              <button className="ghostIcon" type="button" aria-label="more" onClick={() => setExportMenu((v) => !v)}>
                <ChevronDown size={15} />
              </button>
              {exportMenu ? (
                <div className="exportMenu" onMouseLeave={() => setExportMenu(false)}>
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
                    const urls = await doImageEdit({
                      src: selection.images[0],
                      instruction: "完整保留主体，彻底移除全部背景，输出透明背景，主体边缘干净利落，主体本身完全不变",
                      kind: "remove-bg",
                      transparent: true,
                    });
                    pushMessage({ role: "assistant", kind: "去背景", images: urls });
                    setContextChips(urls.slice(0, 2));
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
              <button type="button" onClick={sendSelectedToVideo}>
                <Clapperboard size={14} />
                视频
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
            <button type="button" title="AI 图生视频" className="dockButton" onClick={sendSelectedToVideo}>
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
                  setMessages([]);
                  oaiHistoryRef.current = [];
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
                        {!message.done ? <span className="actionTimer">{formatElapsed(Date.now() - message.ts)}</span> : null}
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

            {contextChips.length ? (
              <div className="contextChips">
                {contextChips.map((url) => (
                  <span className="contextChip" key={url}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={url} alt="context" />
                    <button
                      type="button"
                      aria-label="remove context"
                      onClick={() => setContextChips((prev) => prev.filter((u) => u !== url))}
                    >
                      <X size={10} />
                    </button>
                  </span>
                ))}
                <em>已附为上下文，可直接追问续改</em>
              </div>
            ) : null}

            <div className="composer">
              {showMentionMenu ? (
                <div className="mentionMenu">
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
                  <button type="button" onClick={() => applyMention(brand ? `@品牌(${brand})` : "@品牌")}>
                    @品牌规则 <em>{brand ? brand.slice(0, 14) : "Agent 面板可配置"}</em>
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
              />
              <div className="composerFooter">
                <button className="ghostIcon" type="button" aria-label="add" onClick={() => fileInputRef.current?.click()}>
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
                      <label>
                        品牌
                        <input value={brand} onChange={(event) => setBrand(event.target.value)} placeholder="品牌关键词 / VI 规则" />
                      </label>
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
            {pastSessions.length ? (
              <div className="sessionList">
                {pastSessions.map((session) => (
                  <button
                    key={session.id}
                    type="button"
                    className={session.id === sessionId ? "sessionItem on" : "sessionItem"}
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
            {elementOp !== "layers" ? (
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
                ] as const
              ).map((op) => (
                <button key={op.id} type="button" className={elementOp === op.id ? "on" : ""} onClick={() => setElementOp(op.id)}>
                  {op.label}
                </button>
              ))}
            </div>
            {elementOp !== "remove" && elementOp !== "layers" ? (
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
              <span>{elementOp === "layers" ? "按颜色拆成独立图层，落画布后可单独拖动/删除" : "只动指定元素，其余保持原样"}</span>
              <button
                className="darkButton"
                type="button"
                disabled={
                  elementOp === "layers"
                    ? false
                    : !elementTarget.trim() || (elementOp !== "remove" && !elementValue.trim())
                }
                onClick={() => {
                  const src = elementDialog.src;
                  if (!src) return;
                  setElementDialog({ open: false });
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
                <Loader2 className="spin" size={13} /> 正在识别图中文字…
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
            {fontOcr === "failed" || fontOcr === "idle" ? (
              <label>
                新文字内容
                <input autoFocus value={fontText} onChange={(event) => setFontText(event.target.value)} placeholder="例如：云东 AI 视觉" />
              </label>
            ) : null}
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
                  fontOcr === "loading" ||
                  (fontOcr === "done" && fontLines
                    ? !fontLines.some((line) => line.to.trim() && line.to.trim() !== line.from.trim())
                    : !fontText.trim())
                }
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
    generate_images: "生成图片",
    restyle_lettering: "同风格改字",
    transfer_material: "材质复刻",
    edit_selected_image: "修改图片",
    image_to_video: "提交视频任务",
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
