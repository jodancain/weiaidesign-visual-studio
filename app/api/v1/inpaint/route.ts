import { Buffer } from "node:buffer";
import { jsonCors, optionsResponse, requireVideoToken, tryImageEdits } from "../_lib/visual-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// True mask inpaint: forwards to the relay's OpenAI-compatible `images/edits`
// endpoint (mask alpha semantics: transparent = repaint area). If the relay
// does not support edits, responds with { fallback: true } so the client can
// degrade to reference-image regeneration + client-side mask compositing.
function decodeDataUrl(value: string): { buffer: Buffer; mime: string } | null {
  const match = /^data:([\w/+.-]+);base64,(.+)$/.exec(value || "");
  if (match) return { buffer: Buffer.from(match[2], "base64"), mime: match[1] };
  if (/^[A-Za-z0-9+/=]+$/.test(value || "") && value.length > 100) {
    return { buffer: Buffer.from(value, "base64"), mime: "image/png" };
  }
  return null;
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

  const image = decodeDataUrl(String(payload.image_b64 || ""));
  const mask = decodeDataUrl(String(payload.mask_b64 || ""));
  if (!image || !mask) return jsonCors({ detail: "image_b64 and mask_b64 (PNG data URLs) are required" }, { status: 400 });

  const instruction = String(payload.instruction || "").trim() || "移除遮罩区域内的内容，按周围内容自然补全";
  const size = String(payload.size || "1024x1024");

  try {
    const result = await tryImageEdits({ image: image.buffer, mask: mask.buffer, prompt: instruction, size });
    if (result.ok) {
      return jsonCors({ status: 200, message: "success", data: { image_b64: result.imageB64, model: result.model } });
    }
    return jsonCors(
      { detail: `relay images/edits unavailable: ${result.detail}`, fallback: true },
      { status: 502 },
    );
  } catch (error) {
    return jsonCors(
      { detail: error instanceof Error ? error.message : String(error), fallback: true },
      { status: 502 },
    );
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
