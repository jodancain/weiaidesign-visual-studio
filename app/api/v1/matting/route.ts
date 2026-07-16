import {
  isGpuComfyConfigured,
  resolveImageBuffer,
  runComfyMatting,
} from "../_lib/comfy-gpu";
import {
  jsonCors,
  optionsResponse,
  requireVideoToken,
  saveGeneratedImageBuffer,
  startAsyncImageJob,
} from "../_lib/visual-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function runMatting(payload: Record<string, unknown>, request: Request) {
  if (!isGpuComfyConfigured()) {
    const err = new Error("GPU ComfyUI is not configured (GPU_COMFY_BASE_URL)") as Error & { status?: number };
    err.status = 503;
    throw err;
  }
  const image = await resolveImageBuffer(payload);
  const matted = await runComfyMatting(image);
  const saved = await saveGeneratedImageBuffer(request, matted.buffer, "matting", "png");
  return {
    kind: "matting",
    state: "complete",
    image: {
      ...saved,
      mime_type: "image/png",
      has_alpha: true,
    },
    backend: matted.backend,
  };
}

export async function POST(request: Request) {
  const authError = requireVideoToken(request);
  if (authError) return authError;

  if (!isGpuComfyConfigured()) {
    return jsonCors(
      {
        detail: "GPU ComfyUI is not configured (GPU_COMFY_BASE_URL)",
        gpu_comfy_configured: false,
      },
      { status: 503 },
    );
  }

  let payload: Record<string, unknown>;
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonCors({ detail: "invalid JSON body" }, { status: 400 });
  }

  const wantAsync = payload.async === true || payload.async === "true" || payload.async === 1 || payload.async == null;
  // Default async:true so Cloudflare 100s is not hit by BiRefNet.

  try {
    // Fail fast on missing image input before issuing a job id.
    await resolveImageBuffer(payload);
  } catch (error) {
    const status = Number((error as { status?: number })?.status || 400);
    return jsonCors({ detail: error instanceof Error ? error.message : String(error) }, { status });
  }

  if (wantAsync) {
    const jobId = startAsyncImageJob(() => runMatting(payload, request));
    return jsonCors({ status: 200, message: "accepted", data: { job_id: jobId } });
  }

  try {
    const data = await runMatting(payload, request);
    return jsonCors({ status: 200, message: "success", data });
  } catch (error) {
    const status = Number((error as { status?: number })?.status || 502);
    return jsonCors(
      { detail: error instanceof Error ? error.message : String(error), gpu_comfy_configured: true },
      { status: status >= 400 && status < 600 ? status : 502 },
    );
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
