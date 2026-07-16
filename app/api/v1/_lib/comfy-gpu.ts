import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

const env = process.env;

export const gpuComfyBaseUrl = (env.GPU_COMFY_BASE_URL || "").replace(/\/+$/, "");
export const gpuComfyToken = env.GPU_COMFY_TOKEN || "";
export const gpuComfyTimeoutSeconds = Math.max(15, Number(env.GPU_COMFY_TIMEOUT_SECONDS || "120"));
export const gpuComfyPollIntervalMs = Math.max(500, Number(env.GPU_COMFY_POLL_INTERVAL_MS || "1500"));
export const gpuComfyPollAttempts = Math.max(10, Number(env.GPU_COMFY_POLL_ATTEMPTS || "120"));

const MAX_REMOTE_IMAGE_BYTES = 12 * 1024 * 1024;

export function isGpuComfyConfigured() {
  return Boolean(gpuComfyBaseUrl);
}

export function gpuComfyHostOnly() {
  if (!gpuComfyBaseUrl) return "";
  try {
    return new URL(gpuComfyBaseUrl).host;
  } catch {
    return "invalid-url";
  }
}

function gpuHeaders(extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  if (gpuComfyToken) {
    headers.set("authorization", `Bearer ${gpuComfyToken}`);
    headers.set("x-comfy-token", gpuComfyToken);
  }
  return headers;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeErrorText(text: string) {
  return String(text || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 800);
}

async function fetchComfy(path: string, init: RequestInit & { timeoutMs?: number } = {}) {
  if (!gpuComfyBaseUrl) {
    const err = new Error("GPU ComfyUI is not configured (GPU_COMFY_BASE_URL)") as Error & { status?: number };
    err.status = 503;
    throw err;
  }
  const timeoutMs = init.timeoutMs || gpuComfyTimeoutSeconds * 1000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${gpuComfyBaseUrl}${path}`, {
      ...init,
      headers: gpuHeaders(init.headers),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      const err = new Error(`ComfyUI ${response.status}: ${sanitizeErrorText(text)}`) as Error & { status?: number };
      err.status = response.status >= 500 ? 502 : response.status;
      throw err;
    }
    if (!text) return {};
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return { raw: text };
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      const err = new Error(`ComfyUI request timed out after ${timeoutMs}ms`) as Error & { status?: number };
      err.status = 504;
      throw err;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function decodeImageInput(value: unknown): { buffer: Buffer; mimeType: string } | null {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const match = raw.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
  if (match) {
    const buffer = Buffer.from(match[2], "base64");
    if (!buffer.length) return null;
    return { buffer, mimeType: match[1].toLowerCase() === "image/jpg" ? "image/jpeg" : match[1].toLowerCase() };
  }
  if (/^[A-Za-z0-9+/=\s]+$/.test(raw) && raw.replace(/\s+/g, "").length > 80) {
    const buffer = Buffer.from(raw.replace(/\s+/g, ""), "base64");
    if (buffer.length > 32) return { buffer, mimeType: "image/png" };
  }
  return null;
}

export async function resolveImageBuffer(payload: Record<string, unknown>): Promise<{ buffer: Buffer; mimeType: string }> {
  const fromB64 = decodeImageInput(payload.image_b64 || payload.image || payload.data_url);
  if (fromB64) return fromB64;

  const imageUrl = String(payload.image_url || payload.url || "").trim();
  if (!imageUrl) {
    const err = new Error("image_b64 or image_url is required") as Error & { status?: number };
    err.status = 400;
    throw err;
  }
  let parsed: URL;
  try {
    parsed = new URL(imageUrl);
  } catch {
    const err = new Error("image_url is invalid") as Error & { status?: number };
    err.status = 400;
    throw err;
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    const err = new Error("image_url must be http(s)") as Error & { status?: number };
    err.status = 400;
    throw err;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(imageUrl, { signal: controller.signal, redirect: "follow" });
    if (!response.ok) {
      const err = new Error(`failed to download image_url: ${response.status}`) as Error & { status?: number };
      err.status = 400;
      throw err;
    }
    const contentType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (contentType && !contentType.startsWith("image/")) {
      const err = new Error(`image_url content-type not allowed: ${contentType || "unknown"}`) as Error & { status?: number };
      err.status = 400;
      throw err;
    }
    const lengthHeader = Number(response.headers.get("content-length") || "0");
    if (lengthHeader > MAX_REMOTE_IMAGE_BYTES) {
      const err = new Error("image_url exceeds 12MB limit") as Error & { status?: number };
      err.status = 400;
      throw err;
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_REMOTE_IMAGE_BYTES) {
      const err = new Error("image_url exceeds 12MB limit") as Error & { status?: number };
      err.status = 400;
      throw err;
    }
    if (!buffer.length) {
      const err = new Error("image_url returned empty body") as Error & { status?: number };
      err.status = 400;
      throw err;
    }
    const mimeType = contentType.startsWith("image/")
      ? contentType === "image/jpg"
        ? "image/jpeg"
        : contentType
      : "image/png";
    return { buffer, mimeType };
  } finally {
    clearTimeout(timer);
  }
}

function extensionForMime(mimeType: string) {
  if (mimeType.includes("jpeg") || mimeType.includes("jpg")) return "jpg";
  if (mimeType.includes("webp")) return "webp";
  return "png";
}

async function uploadImage(buffer: Buffer, mimeType: string, filenamePrefix: string) {
  const form = new FormData();
  const filename = `${filenamePrefix}-${randomUUID().slice(0, 8)}.${extensionForMime(mimeType)}`;
  form.append("image", new Blob([new Uint8Array(buffer)], { type: mimeType || "image/png" }), filename);
  form.append("overwrite", "true");
  const payload = await fetchComfy("/upload/image", {
    method: "POST",
    body: form,
    timeoutMs: 60000,
  });
  const name = String(payload.name || payload.filename || "").trim();
  if (!name) throw new Error("ComfyUI upload did not return image name");
  return {
    name,
    subfolder: String(payload.subfolder || ""),
    type: String(payload.type || "input"),
  };
}

type ComfyImageRef = { filename: string; subfolder?: string; type?: string };

function collectOutputImages(historyEntry: Record<string, unknown>): ComfyImageRef[] {
  const outputs = (historyEntry.outputs || {}) as Record<string, { images?: ComfyImageRef[] }>;
  const images: ComfyImageRef[] = [];
  for (const node of Object.values(outputs)) {
    if (!node?.images?.length) continue;
    for (const image of node.images) {
      if (image?.filename) images.push(image);
    }
  }
  return images;
}

async function waitForPrompt(promptId: string) {
  for (let attempt = 0; attempt < gpuComfyPollAttempts; attempt += 1) {
    const history = (await fetchComfy(`/history/${encodeURIComponent(promptId)}`, {
      timeoutMs: 30000,
    })) as Record<string, Record<string, unknown>>;
    const entry = history[promptId];
    if (entry) {
      const status = (entry.status || {}) as { completed?: boolean; status_str?: string; messages?: unknown };
      if (status.status_str === "error") {
        throw new Error(`ComfyUI prompt failed: ${sanitizeErrorText(JSON.stringify(status.messages || status))}`);
      }
      const images = collectOutputImages(entry);
      if (status.completed === true || images.length) {
        return { entry, images };
      }
    }
    await sleep(gpuComfyPollIntervalMs);
  }
  throw new Error(`ComfyUI prompt timed out after ${gpuComfyPollAttempts} polls`);
}

async function downloadView(image: ComfyImageRef) {
  const params = new URLSearchParams({
    filename: image.filename,
    subfolder: image.subfolder || "",
    type: image.type || "output",
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const response = await fetch(`${gpuComfyBaseUrl}/view?${params.toString()}`, {
      headers: gpuHeaders(),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`ComfyUI view failed: ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const mimeType = (response.headers.get("content-type") || "image/png").split(";")[0].trim() || "image/png";
    return { buffer, mimeType, filename: image.filename };
  } finally {
    clearTimeout(timer);
  }
}

async function runWorkflow(promptGraph: Record<string, unknown>) {
  const submitted = await fetchComfy("/prompt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: promptGraph }),
    timeoutMs: 60000,
  });
  const promptId = String(submitted.prompt_id || "").trim();
  if (!promptId) {
    const nodeErrors = submitted.node_errors ? JSON.stringify(submitted.node_errors).slice(0, 600) : "";
    throw new Error(`ComfyUI did not accept prompt${nodeErrors ? `: ${nodeErrors}` : ""}`);
  }
  return waitForPrompt(promptId);
}

function mattingPrompt(imageName: string) {
  return {
    "1": {
      class_type: "LoadImage",
      inputs: { image: imageName },
    },
    "2": {
      class_type: "BiRefNetRMBG",
      inputs: {
        image: ["1", 0],
        model: "BiRefNet-general",
        mask_blur: 0,
        mask_offset: 0,
        invert_output: false,
        refine_foreground: false,
        background: "Alpha",
        background_color: "#222222",
      },
    },
    "3": {
      class_type: "SaveImage",
      inputs: {
        images: ["2", 0],
        filename_prefix: "matting_out",
      },
    },
  };
}

function segmentPrompt(imageName: string, maxSegments: number) {
  const points = Math.max(8, Math.min(24, Math.round(8 + maxSegments)));
  return {
    "1": {
      class_type: "LoadImage",
      inputs: { image: imageName },
    },
    "2": {
      class_type: "DownloadAndLoadSAM2Model",
      inputs: {
        model: "sam2.1_hiera_small.safetensors",
        segmentor: "automaskgenerator",
        device: "cuda",
        precision: "fp16",
      },
    },
    "3": {
      class_type: "Sam2AutoSegmentation",
      inputs: {
        sam2_model: ["2", 0],
        image: ["1", 0],
        points_per_side: points,
        points_per_batch: 32,
        pred_iou_thresh: 0.6,
        stability_score_thresh: 0.8,
        stability_score_offset: 1.0,
        mask_threshold: 0.0,
        crop_n_layers: 0,
        box_nms_thresh: 0.7,
        crop_nms_thresh: 0.7,
        crop_overlap_ratio: 0.34,
        crop_n_points_downscale_factor: 1,
        min_mask_region_area: 0.0,
        use_m2m: false,
        keep_model_loaded: false,
      },
    },
    "4": {
      class_type: "SaveImage",
      inputs: {
        images: ["3", 1],
        filename_prefix: "segment_overlay",
      },
    },
    "5": {
      class_type: "MaskToImage",
      inputs: {
        mask: ["3", 0],
      },
    },
    "6": {
      class_type: "SaveImage",
      inputs: {
        images: ["5", 0],
        filename_prefix: "segment_mask",
      },
    },
  };
}

export async function runComfyMatting(image: { buffer: Buffer; mimeType: string }) {
  const uploaded = await uploadImage(image.buffer, image.mimeType, "matting");
  const { images } = await runWorkflow(mattingPrompt(uploaded.name));
  const matting = images.find((item) => /matting/i.test(item.filename)) || images[0];
  if (!matting) throw new Error("ComfyUI matting produced no images");
  const file = await downloadView(matting);
  return {
    ...file,
    backend: "comfyui-birefnet",
  };
}

export async function runComfySegment(image: { buffer: Buffer; mimeType: string }, maxSegments = 8) {
  const uploaded = await uploadImage(image.buffer, image.mimeType, "segment");
  const { images } = await runWorkflow(segmentPrompt(uploaded.name, maxSegments));
  if (!images.length) throw new Error("ComfyUI segment produced no images");

  const overlays = images.filter((item) => /overlay/i.test(item.filename));
  const masks = images.filter((item) => /mask/i.test(item.filename));
  const rest = images.filter((item) => !overlays.includes(item) && !masks.includes(item));

  const downloaded = await Promise.all(images.map(async (ref) => ({ ref, file: await downloadView(ref) })));
  const overlay = downloaded.find((item) => /overlay/i.test(item.ref.filename)) || downloaded[0];
  const maskItems = downloaded.filter((item) => /mask/i.test(item.ref.filename));
  const cutouts = downloaded.filter((item) => !/overlay|mask/i.test(item.ref.filename));

  return {
    backend: "comfyui-sam2",
    overlay: overlay?.file || null,
    masks: maskItems.map((item) => item.file),
    cutouts: cutouts.map((item) => item.file),
    all: downloaded.map((item) => item.file),
    max_segments: maxSegments,
    // retained for debugging without dumping huge payloads
    output_names: images.map((item) => item.filename),
    overlay_count: overlays.length,
    mask_count: masks.length,
    extra_count: rest.length,
  };
}
