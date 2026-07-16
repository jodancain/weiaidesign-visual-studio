import { Buffer } from "node:buffer";
import { jsonCors, optionsResponse, requireVideoToken, startAsyncImageJob, tryImageEdits } from "../_lib/visual-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// True mask inpaint: forwards to the relay's OpenAI-compatible `images/edits`
// endpoint (mask alpha semantics: transparent = repaint area). If the relay
// does not support edits, responds with { fallback: true } so the client can
// degrade to reference-image regeneration + client-side mask compositing.
// Supports async:true (job_id + poll /image-jobs) to avoid Cloudflare 100s/524.
function decodeDataUrl(value: string): { buffer: Buffer; mime: string } | null {
  const match = /^data:([\w/+.-]+);base64,(.+)$/.exec(value || "");
  if (match) return { buffer: Buffer.from(match[2], "base64"), mime: match[1] };
  if (/^[A-Za-z0-9+/=]+$/.test(value || "") && value.length > 100) {
    return { buffer: Buffer.from(value, "base64"), mime: "image/png" };
  }
  return null;
}

/** Minimal PNG/JPEG dimension reader (no deps). Returns null if unrecognized. */
function readImageSize(buffer: Buffer): { w: number; h: number } | null {
  if (buffer.length > 24 && buffer[0] === 0x89 && buffer[1] === 0x50) {
    return { w: buffer.readUInt32BE(16), h: buffer.readUInt32BE(20) };
  }
  if (buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) break;
      const marker = buffer[offset + 1];
      const size = buffer.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { h: buffer.readUInt16BE(offset + 5), w: buffer.readUInt16BE(offset + 7) };
      }
      offset += 2 + size;
    }
  }
  return null;
}

async function runInpaint(payload: Record<string, unknown>) {
  const image = decodeDataUrl(String(payload.image_b64 || ""));
  const mask = decodeDataUrl(String(payload.mask_b64 || ""));
  if (!image || !mask) throw new Error("image_b64 and mask_b64 (PNG data URLs) are required");
  const imageSize = readImageSize(image.buffer);
  const maskSize = readImageSize(mask.buffer);
  if (imageSize && maskSize && (imageSize.w !== maskSize.w || imageSize.h !== maskSize.h)) {
    throw new Error(
      `mask size (${maskSize.w}x${maskSize.h}) must match image size (${imageSize.w}x${imageSize.h}) — the relay returns an opaque 502 otherwise`,
    );
  }

  const instruction = String(payload.instruction || "").trim() || "移除遮罩区域内的内容，按周围内容自然补全";
  const size = String(payload.size || "1024x1024");

  const result = await tryImageEdits({ image: image.buffer, mask: mask.buffer, prompt: instruction, size });
  if (!result.ok) {
    const err = new Error(`relay images/edits unavailable: ${result.detail}`) as Error & { fallback?: boolean };
    err.fallback = true;
    throw err;
  }
  // result shape for async jobs: image_b64 at top level (polled via /image-jobs)
  return { image_b64: result.imageB64, model: result.model };
}

export async function POST(request: Request) {
  const authError = requireVideoToken(request);
  if (authError) return authError;

  let payload: Record<string, unknown>;
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonCors({ detail: "invalid JSON body" }, { status: 400 });
  }

  if (payload.async === true || payload.async === "true" || payload.async === 1) {
    // Validate quickly so async job_id is not issued for bad payloads
    if (!decodeDataUrl(String(payload.image_b64 || "")) || !decodeDataUrl(String(payload.mask_b64 || ""))) {
      return jsonCors({ detail: "image_b64 and mask_b64 (PNG data URLs) are required" }, { status: 400 });
    }
    const jobId = startAsyncImageJob(() => runInpaint(payload));
    return jsonCors({ status: 200, message: "accepted", data: { job_id: jobId } });
  }

  try {
    const data = await runInpaint(payload);
    return jsonCors({ status: 200, message: "success", data });
  } catch (error) {
    const fallback = Boolean((error as { fallback?: boolean })?.fallback);
    return jsonCors(
      { detail: error instanceof Error ? error.message : String(error), fallback },
      { status: 502 },
    );
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
