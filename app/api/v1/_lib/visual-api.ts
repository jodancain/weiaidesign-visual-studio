import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Buffer } from "node:buffer";
import { NextResponse } from "next/server";

type ReferenceImage = {
  buffer: Buffer;
  mimeType: string;
  filename: string;
};

type FetchJsonOptions = RequestInit & {
  timeoutMs?: number;
};

const env = process.env;

export const imageModel = env.IMAGE_OPENAI_MODEL || "gpt-image-1.5";
export const imageFallbackModels = (env.IMAGE_OPENAI_FALLBACK_MODELS || "gpt-image-1")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
export const imageGenerationModels = Array.from(new Set([imageModel, ...imageFallbackModels].filter(Boolean)));
export const imageTimeoutSeconds = Number(env.IMAGE_OPENAI_TIMEOUT_SECONDS || "300");
export const imageQuality = env.IMAGE_OPENAI_QUALITY || "low";
export const imageOutputFormat = env.IMAGE_OPENAI_OUTPUT_FORMAT || "jpeg";
export const imageOutputCompression = Number(env.IMAGE_OPENAI_OUTPUT_COMPRESSION || "70");
export const imageGenerationRetries = Math.max(1, Number(env.IMAGE_GENERATION_RETRIES || "3"));
export const imageGenerationConcurrency = Math.max(1, Number(env.IMAGE_GENERATION_CONCURRENCY || "1"));
export const imageOutputDir = env.IMAGE_OUTPUT_DIR || join(tmpdir(), "youngtuo-visual", "generated_images");

export function jsonCors(payload: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-headers", "authorization, content-type");
  headers.set("access-control-allow-methods", "GET,POST,PUT,HEAD,OPTIONS");
  return NextResponse.json(payload, { ...init, headers });
}

export function optionsResponse() {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization, content-type",
      "access-control-allow-methods": "GET,POST,PUT,HEAD,OPTIONS",
    },
  });
}

export function requireVideoToken(request: Request) {
  /* 默认开放访问（上游凭证均在服务端）；设 REQUIRE_ACCESS_TOKEN=1 时恢复门禁 */
  if (env.REQUIRE_ACCESS_TOKEN !== "1") return null;
  const token = env.VIDEO_API_TOKEN || "";
  if (!token) {
    return jsonCors({ detail: "VIDEO_API_TOKEN is not configured" }, { status: 503 });
  }
  if (request.headers.get("authorization") !== `Bearer ${token}`) {
    return jsonCors({ detail: "invalid or missing bearer token" }, { status: 401 });
  }
  return null;
}

function openAIConfig() {
  const baseUrl = (env.IMAGE_OPENAI_BASE_URL || "").replace(/\/+$/, "");
  const apiKey = env.IMAGE_OPENAI_API_KEY || env.OPENAI_API_KEY || "";
  if (!baseUrl || !apiKey) throw new Error("image generation config is missing");
  return { baseUrl, apiKey };
}

function imageSize(aspect: string) {
  if (aspect === "16:9" || aspect === "3:2") return "1536x1024";
  if (aspect === "1:1") return "1024x1024";
  return "1024x1536";
}

function imageExtension() {
  const value = String(imageOutputFormat || "png").toLowerCase();
  if (value === "jpeg") return "jpg";
  if (["jpg", "png", "webp"].includes(value)) return value;
  return "png";
}

function normalizeImageMime(mimeType: string) {
  const value = String(mimeType || "").split(";")[0].trim().toLowerCase();
  if (value === "image/jpg") return "image/jpeg";
  if (["image/png", "image/jpeg", "image/webp"].includes(value)) return value;
  return "image/png";
}

function mimeForFilename(filename: string) {
  const extension = filename.split(".").pop()?.toLowerCase() || "";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "webp") return "image/webp";
  return "image/png";
}

function apiBaseUrl(request: Request) {
  const configured = (env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  if (configured) return configured;
  const url = new URL(request.url);
  return `${url.origin}/api/v1`;
}

function imagePublicUrl(request: Request, imageId: string, filename: string) {
  return `${apiBaseUrl(request)}/generated-images/${encodeURIComponent(imageId)}/${encodeURIComponent(filename)}`;
}

/** Persist a generated/processed image buffer and return public URLs (GPU matting/segment etc.). */
export async function saveGeneratedImageBuffer(
  request: Request,
  buffer: Buffer,
  filenamePrefix: string,
  extension = "png",
) {
  const imageId = `img-${randomUUID()}`;
  const safePrefix = String(filenamePrefix || "image")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "image";
  const safeExt = String(extension || "png").replace(/[^a-z0-9]/gi, "").toLowerCase() || "png";
  const filename = `${safePrefix}.${safeExt}`;
  const runDir = join(imageOutputDir, imageId);
  await mkdir(runDir, { recursive: true });
  const outputPath = join(runDir, filename);
  await writeFile(outputPath, buffer);
  const publicUrl = imagePublicUrl(request, imageId, filename);
  return {
    image_id: imageId,
    public_url: publicUrl,
    download_url: publicUrl,
    output_path: outputPath,
    size: buffer.length,
    mime_type: mimeForFilename(filename),
  };
}

async function fetchJson(url: string, options: FetchJsonOptions = {}) {
  const timeoutMs = options.timeoutMs || 120000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  let text = "";
  try {
    response = await fetch(url, { ...options, signal: controller.signal });
    text = await response.text();
  } finally {
    clearTimeout(timer);
  }
  let payload: unknown = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${JSON.stringify(payload).slice(0, 1200)}`);
  }
  return payload as { data?: Array<{ b64_json?: string; url?: string }> };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function imagePayloadToBuffer(item: { b64_json?: string; url?: string }) {
  if (item.b64_json) return Buffer.from(item.b64_json, "base64");
  if (!item.url) throw new Error("image generation returned unsupported payload");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const response = await fetch(item.url, { signal: controller.signal });
    if (!response.ok) throw new Error(`image download failed: ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

function orderedImageModels(preferred = "") {
  const clean = preferred.trim();
  if (!clean) return imageGenerationModels;
  return Array.from(new Set([clean, ...imageGenerationModels]));
}

async function generateImage(prompt: string, aspect: string, outPath: string, qualityOverride = "", transparent = false, preferredModel = "") {
  const { baseUrl, apiKey } = openAIConfig();
  const models = orderedImageModels(preferredModel);
  let payload: { data?: Array<{ b64_json?: string; url?: string }> } | null = null;
  let lastError: unknown = null;
  let usedModel = "";
  for (let attempt = 1; attempt <= imageGenerationRetries; attempt += 1) {
    const model = models[Math.min(attempt - 1, models.length - 1)] || imageModel;
    try {
      payload = await fetchJson(`${baseUrl}/images/generations`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          prompt,
          size: imageSize(aspect),
          n: 1,
          ...((qualityOverride || imageQuality) ? { quality: qualityOverride || imageQuality } : {}),
          ...(transparent
            ? { output_format: "png" }
            : {
                ...(imageOutputFormat ? { output_format: imageOutputFormat } : {}),
                ...(imageOutputCompression > 0 ? { output_compression: imageOutputCompression } : {}),
              }),
        }),
        timeoutMs: imageTimeoutSeconds * 1000,
      });
      usedModel = model;
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      if (attempt < imageGenerationRetries) await sleep(Math.min(30000, 3000 * attempt * attempt));
    }
  }
  if (lastError) throw new Error(`image generation failed after ${imageGenerationRetries} attempt(s): ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  const item = payload?.data?.[0];
  if (!item) throw new Error("image generation returned no data");
  const buffer = await imagePayloadToBuffer(item);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, buffer);
  return { model: usedModel || imageModel, mimeType: normalizeImageMime(transparent ? "image/png" : `image/${imageOutputFormat || "png"}`), size: buffer.length, mode: "generation" };
}

async function editImageWithReference(prompt: string, aspect: string, outPath: string, references: ReferenceImage[], qualityOverride = "", transparent = false, preferredModel = "") {
  const { baseUrl, apiKey } = openAIConfig();
  const validRefs = references.filter((ref) => ref?.buffer?.length);
  if (!validRefs.length) throw new Error("reference image is empty");
  const models = orderedImageModels(preferredModel);
  let payload: { data?: Array<{ b64_json?: string; url?: string }> } | null = null;
  let lastError: unknown = null;
  let usedModel = "";
  let referenceMode: "multi" | "single_fallback" = validRefs.length > 1 ? "multi" : "single_fallback";
  for (let attempt = 1; attempt <= imageGenerationRetries; attempt += 1) {
    const model = models[Math.min(attempt - 1, models.length - 1)] || imageModel;
    try {
      const buildForm = (withFidelity: boolean, multi: boolean) => {
        const form = new FormData();
        form.append("model", model);
        form.append("prompt", prompt);
        form.append("size", imageSize(aspect));
        form.append("n", "1");
        if (withFidelity) form.append("input_fidelity", "high");
        if (qualityOverride || imageQuality) form.append("quality", qualityOverride || imageQuality);
        if (transparent) {
          form.append("output_format", "png");
        } else {
          if (imageOutputFormat) form.append("output_format", imageOutputFormat);
          if (imageOutputCompression > 0) form.append("output_compression", String(imageOutputCompression));
        }
        const refsToSend = multi && validRefs.length > 1 ? validRefs : [validRefs[0]];
        if (refsToSend.length > 1) {
          // OpenAI multi-image edits: repeat image[] field
          for (const ref of refsToSend) {
            form.append(
              "image[]",
              new Blob([new Uint8Array(ref.buffer)], { type: ref.mimeType || "image/png" }),
              ref.filename || "reference.png",
            );
          }
        } else {
          const source = refsToSend[0];
          form.append(
            "image",
            new Blob([new Uint8Array(source.buffer)], { type: source.mimeType || "image/png" }),
            source.filename || "reference.png",
          );
        }
        return form;
      };

      const postEdits = async (withFidelity: boolean, multi: boolean) =>
        fetchJson(`${baseUrl}/images/edits`, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}` },
          body: buildForm(withFidelity, multi),
          timeoutMs: imageTimeoutSeconds * 1000,
        });

      const canMulti = validRefs.length > 1;
      // Matrix: multi+fidelity → multi no fidelity (only if error mentions input_fidelity)
      //         → single+fidelity → single (multi→single on any 4xx / parse error)
      type EditStep = { multi: boolean; withFidelity: boolean };
      const runStep = async (step: EditStep) => {
        payload = await postEdits(step.withFidelity, step.multi);
        referenceMode = step.multi && canMulti ? "multi" : "single_fallback";
      };

      try {
        if (canMulti) {
          try {
            await runStep({ multi: true, withFidelity: true });
          } catch (multiFidErr) {
            const msg = multiFidErr instanceof Error ? multiFidErr.message : String(multiFidErr);
            if (/input_fidelity/i.test(msg)) {
              try {
                await runStep({ multi: true, withFidelity: false });
              } catch {
                // multi without fidelity also failed → fall through to single
                await runStep({ multi: false, withFidelity: true }).catch(async (singleFidErr) => {
                  const sMsg = singleFidErr instanceof Error ? singleFidErr.message : String(singleFidErr);
                  if (/input_fidelity/i.test(sMsg)) await runStep({ multi: false, withFidelity: false });
                  else throw singleFidErr;
                });
              }
            } else {
              // any multi failure (4xx / parse) → single path
              try {
                await runStep({ multi: false, withFidelity: true });
              } catch (singleFidErr) {
                const sMsg = singleFidErr instanceof Error ? singleFidErr.message : String(singleFidErr);
                if (/input_fidelity/i.test(sMsg)) await runStep({ multi: false, withFidelity: false });
                else throw singleFidErr;
              }
            }
          }
        } else {
          try {
            await runStep({ multi: false, withFidelity: true });
          } catch (singleFidErr) {
            const sMsg = singleFidErr instanceof Error ? singleFidErr.message : String(singleFidErr);
            if (/input_fidelity/i.test(sMsg)) await runStep({ multi: false, withFidelity: false });
            else throw singleFidErr;
          }
        }
      } catch (stepError) {
        throw stepError;
      }

      usedModel = model;
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      if (attempt < imageGenerationRetries) await sleep(Math.min(30000, 3000 * attempt * attempt));
    }
  }
  if (lastError) throw new Error(`image edit failed after ${imageGenerationRetries} attempt(s): ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  const resolved = payload as { data?: Array<{ b64_json?: string; url?: string }> } | null;
  const item = resolved?.data?.[0];
  if (!item) throw new Error("image edit returned no data");
  const buffer = await imagePayloadToBuffer(item);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, buffer);
  return {
    model: usedModel || imageModel,
    mimeType: normalizeImageMime(transparent ? "image/png" : `image/${imageOutputFormat || "png"}`),
    size: buffer.length,
    mode: "edit",
    referenceMode,
  };
}

function decodeImageBase64(value: unknown) {
  const raw = String(value || "").trim();
  const match = raw.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
  if (match) {
    return { buffer: Buffer.from(match[2], "base64"), mimeType: normalizeImageMime(match[1]) };
  }
  return { buffer: Buffer.from(raw, "base64"), mimeType: "image/png" };
}

function extractReferenceImages(payload: Record<string, unknown>) {
  const refs: ReferenceImage[] = [];
  const candidates: Array<Record<string, unknown>> = [];
  if (payload.image_b64) candidates.push({ b64: payload.image_b64, filename: payload.image_filename });
  if (Array.isArray(payload.reference_images)) {
    for (const item of payload.reference_images) {
      if (typeof item === "string") candidates.push({ b64: item });
      else if (item && typeof item === "object") candidates.push(item as Record<string, unknown>);
    }
  }
  for (const item of candidates.slice(0, 6)) {
    const raw = item.b64 || item.data_url || item.data || "";
    if (!raw) continue;
    const decoded = decodeImageBase64(raw);
    if (!decoded.buffer.length) continue;
    refs.push({
      buffer: decoded.buffer,
      mimeType: normalizeImageMime(String(item.mime_type || item.mimeType || decoded.mimeType)),
      filename: basename(String(item.filename || item.name || `reference-${refs.length + 1}.png`)),
    });
  }
  return refs;
}

/** Primary logo/mark deliverable (not incidental logo-on-poster wording). */
function isLogoMarkBrief(text: string) {
  return /(?:logo|标志|徽标|商标|字母标|品牌标|\bicon\b|\bmark\b|图标)/i.test(text);
}

function standaloneImagePrompt(payload: Record<string, unknown>, index: number, count: number) {
  const rawPrompt = String(payload.raw_prompt || "").trim();
  if (rawPrompt) {
    return count > 1
      ? `${rawPrompt}\nVariation ${index} of ${count}: keep the same core idea but change composition, staging, and detail.`
      : rawPrompt;
  }
  const prompt = String(payload.prompt || payload.image_prompt || payload.video_subject || "").trim();
  if (!prompt) return "";
  const style = String(payload.style || payload.visual_style || "").trim();
  const brand = String(payload.brand || payload.brand_kit || "").trim();
  const designMemory = String(payload.design_memory || "").trim();
  const format = String(payload.format || payload.asset_type || "").trim();
  const audience = String(payload.audience || "").trim();
  const negative = String(payload.negative_prompt || "").trim();
  const logoMark = isLogoMarkBrief(prompt) || isLogoMarkBrief(format);
  if (logoMark) {
    return [
      "Create one production-ready flat vector logo mark.",
      `Brief: ${prompt}`,
      style ? `Visual style: ${style}` : "",
      brand ? `Brand rules: ${brand}` : "",
      designMemory
        ? `Default personal design skill (mandatory unless the current brief explicitly overrides a specific rule; silence is not an override):\n${designMemory}`
        : "",
      format ? `Asset format: ${format}` : "Asset format: flat vector logo mark",
      audience ? `Audience: ${audience}` : "",
      "Spec: flat vector logo mark, solid single-color or limited flat colors, negative space, minimal geometry, smooth clean curves, generous whitespace, pure white background, centered composition.",
      "Do NOT use material, texture, lighting, shadows, 3D, gradient, photorealism, decorative ornament, or serif flourishes.",
      count > 1
        ? `Variation ${index} of ${count}: keep the same structural concept but change geometry, stroke weight, and negative-space treatment.`
        : "",
      "No watermark, no UI chrome, no extra logos unless specified.",
      negative ? `Avoid: ${negative}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }
  return [
    "Create one production-ready visual asset.",
    `Brief: ${prompt}`,
    style ? `Visual style: ${style}` : "",
    brand ? `Brand rules: ${brand}` : "",
    designMemory
      ? `Default personal design skill (mandatory unless the current brief explicitly overrides a specific rule; silence is not an override):\n${designMemory}`
      : "",
    format ? `Asset format: ${format}` : "",
    audience ? `Audience: ${audience}` : "",
    count > 1 ? `Variation ${index} of ${count}: keep the same core idea but change composition, staging, and detail.` : "",
    "Keep composition coherent, text legible when requested, no watermark, no UI chrome, no extra logos unless specified.",
    negative ? `Avoid: ${negative}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

async function mapLimit<T, R>(items: T[], limit: number, mapper: (item: T, index: number) => Promise<R>) {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

type ImageEditsResult =
  | { ok: true; imageB64: string; model: string }
  | { ok: false; detail: string };

/* True mask inpaint via OpenAI-compatible `images/edits` (mask: transparent = repaint). */
export async function tryImageEdits(params: {
  image: Buffer;
  mask: Buffer;
  prompt: string;
  size: string;
}): Promise<ImageEditsResult> {
  const { baseUrl, apiKey } = openAIConfig();
  const errors: string[] = [];

  async function postEdits(model: string, withFidelity: boolean) {
    const form = new FormData();
    form.append("model", model);
    form.append("image", new Blob([new Uint8Array(params.image)], { type: "image/png" }), "image.png");
    form.append("mask", new Blob([new Uint8Array(params.mask)], { type: "image/png" }), "mask.png");
    form.append("prompt", params.prompt);
    form.append("size", params.size);
    form.append("n", "1");
    if (withFidelity) form.append("input_fidelity", "high");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), imageTimeoutSeconds * 1000);
    try {
      const response = await fetch(`${baseUrl}/images/edits`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        signal: controller.signal,
      });
      const text = await response.text();
      return { response, text };
    } finally {
      clearTimeout(timer);
    }
  }

  for (const model of imageGenerationModels) {
    try {
      let response: Response;
      let text: string;
      try {
        ({ response, text } = await postEdits(model, true));
        if (!response.ok && /input_fidelity/i.test(text)) {
          ({ response, text } = await postEdits(model, false));
        }
      } catch (fidelityError) {
        const message = fidelityError instanceof Error ? fidelityError.message : String(fidelityError);
        if (!/input_fidelity/i.test(message)) throw fidelityError;
        ({ response, text } = await postEdits(model, false));
      }
      if (!response.ok) {
        errors.push(`${model}: HTTP ${response.status} ${text.slice(0, 160)}`);
        continue;
      }
      const parsed = JSON.parse(text) as { data?: Array<{ b64_json?: string; url?: string }> };
      const first = parsed.data?.[0];
      if (first?.b64_json) return { ok: true, imageB64: `data:image/png;base64,${first.b64_json}`, model };
      if (first?.url) {
        const imageResponse = await fetch(first.url);
        const buffer = Buffer.from(await imageResponse.arrayBuffer());
        return { ok: true, imageB64: `data:image/png;base64,${buffer.toString("base64")}`, model };
      }
      errors.push(`${model}: empty data`);
    } catch (error) {
      errors.push(`${model}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { ok: false, detail: errors.join(" | ") };
}

/* ---------- 异步图片任务：提交秒回 job_id，后台执行，轮询取结果（绕开 Cloudflare 100s 超时） ---------- */

const jobsDir = () => join(imageOutputDir, "_jobs");

async function writeJob(jobId: string, data: Record<string, unknown>) {
  await mkdir(jobsDir(), { recursive: true });
  await writeFile(join(jobsDir(), `${jobId}.json`), JSON.stringify(data));
}

export function startAsyncImageJob(run: () => Promise<Record<string, unknown>>) {
  const jobId = `ijob-${randomUUID()}`;
  void (async () => {
    await writeJob(jobId, { state: "running", started_at: Date.now() });
    try {
      const result = await run();
      await writeJob(jobId, { state: "done", result, finished_at: Date.now() });
    } catch (error) {
      await writeJob(jobId, {
        state: "failed",
        error: error instanceof Error ? error.message : String(error),
        finished_at: Date.now(),
      });
    }
  })();
  return jobId;
}

export async function readAsyncImageJob(jobId: string) {
  if (!/^ijob-[a-f0-9-]+$/.test(jobId)) return null;
  try {
    return JSON.parse(await readFile(join(jobsDir(), `${jobId}.json`), "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function createStandaloneImages(payload: Record<string, unknown>, request: Request) {
  const prompt = String(payload.prompt || payload.image_prompt || payload.video_subject || "").trim();
  if (!prompt) throw new Error("prompt is required");
  const aspect = String(payload.aspect_ratio || payload.aspect || payload.video_aspect || "1:1");
  const count = Math.max(1, Math.min(4, Number(payload.n || payload.count || payload.image_count || 1)));
  const qualityOverride = ["low", "medium", "high"].includes(String(payload.quality || "").toLowerCase())
    ? String(payload.quality).toLowerCase()
    : "";
  const transparent = String(payload.background || "") === "transparent";
  const preferredModel = String(payload.image_model || payload.model || "").trim();
  const imageId = `img-${randomUUID()}`;
  const runDir = join(imageOutputDir, imageId);
  await mkdir(runDir, { recursive: true });
  const references = extractReferenceImages(payload);
  const images: Array<Record<string, unknown>> = [];
  const errors: string[] = [];

  await mapLimit(
    Array.from({ length: count }, (_, index) => index + 1),
    Math.min(count, imageGenerationConcurrency),
    async (index) => {
      const filename = `image-${String(index).padStart(2, "0")}.${transparent ? "png" : imageExtension()}`;
      const outPath = join(runDir, filename);
      const imagePrompt = standaloneImagePrompt(payload, index, count);
      let referenceMode: string = references.length ? "edit" : "none";
      try {
        let result: { model: string; mimeType: string; size: number; mode: string; referenceMode?: string };
        if (references.length) {
          try {
            result = await editImageWithReference(imagePrompt, aspect, outPath, references, qualityOverride, transparent, preferredModel);
            referenceMode = result.referenceMode || (references.length > 1 ? "multi" : "single_fallback");
          } catch (error) {
            referenceMode = "fallback_generation";
            errors.push(`reference edit fallback for image-${index}: ${error instanceof Error ? error.message : String(error)}`);
            result = await generateImage(`${imagePrompt}\nUse the uploaded reference only as conceptual direction if unavailable to the model.`, aspect, outPath, qualityOverride, transparent, preferredModel);
          }
        } else {
          result = await generateImage(imagePrompt, aspect, outPath, qualityOverride, transparent, preferredModel);
        }
        const written = await stat(outPath);
        const publicUrl = imagePublicUrl(request, imageId, filename);
        images.push({
          id: `${imageId}-${index}`,
          image_id: imageId,
          index,
          filename,
          prompt: imagePrompt,
          aspect_ratio: aspect,
          model: result.model,
          mode: result.mode,
          reference_mode: referenceMode,
          mime_type: result.mimeType,
          size: written.size,
          public_url: publicUrl,
          download_url: publicUrl,
        });
      } catch (error) {
        errors.push(`image-${index}: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  images.sort((a, b) => Number(a.index || 0) - Number(b.index || 0));
  if (!images.length) throw new Error(errors.join("; ") || "no images generated");
  return {
    job_id: imageId,
    state: "complete",
    progress: 100,
    prompt,
    aspect_ratio: aspect,
    count,
    image_model: imageModel,
    image_fallback_models: imageFallbackModels,
    image_quality: imageQuality,
    image_output_format: imageOutputFormat,
    image_output_compression: imageOutputCompression,
    output_dir: runDir,
    reference_count: references.length,
    images,
    errors,
  };
}

export async function serveGeneratedImage(imageId: string, filename: string, method = "GET") {
  const safeImageId = basename(String(imageId || ""));
  const safeFilename = basename(String(filename || ""));
  if (!safeImageId || !safeFilename) return jsonCors({ detail: "generated image not found" }, { status: 404 });
  const imagePath = join(imageOutputDir, safeImageId, safeFilename);
  let body: Buffer;
  let written;
  try {
    written = await stat(imagePath);
    body = method === "HEAD" ? Buffer.alloc(0) : await readFile(imagePath);
  } catch {
    return jsonCors({ detail: "generated image not found" }, { status: 404 });
  }
  return new Response(method === "HEAD" ? null : new Uint8Array(body), {
    status: 200,
    headers: {
      "content-type": mimeForFilename(safeFilename),
      "content-length": String(written.size),
      "cache-control": "public, max-age=31536000, immutable",
      "access-control-allow-origin": "*",
      "x-robots-tag": "noindex",
    },
  });
}

export async function proxyLegacyApi(request: Request, path: string) {
  const baseUrl = (env.VIDEO_API_PROXY_BASE_URL || "").replace(/\/+$/, "");
  if (!baseUrl) {
    return jsonCors({ detail: "VIDEO_API_PROXY_BASE_URL is not configured on this deployment" }, { status: 503 });
  }
  const proxyToken = env.VIDEO_API_PROXY_TOKEN || env.VIDEO_API_TOKEN || "";
  const upstreamUrl = `${baseUrl}${path}`;
  const headers = new Headers(request.headers);
  if (proxyToken) headers.set("authorization", `Bearer ${proxyToken}`);
  headers.delete("host");
  const response = await fetch(upstreamUrl, {
    method: request.method,
    headers,
    body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.text(),
  });
  const body = response.body;
  const responseHeaders = new Headers(response.headers);
  responseHeaders.set("access-control-allow-origin", "*");
  return new Response(body, { status: response.status, headers: responseHeaders });
}
