import {
  isGpuComfyConfigured,
  resolveImageBuffer,
  runComfySegment,
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

async function runSegment(payload: Record<string, unknown>, request: Request) {
  if (!isGpuComfyConfigured()) {
    const err = new Error("GPU ComfyUI is not configured (GPU_COMFY_BASE_URL)") as Error & { status?: number };
    err.status = 503;
    throw err;
  }
  const maxSegments = Math.max(1, Math.min(16, Number(payload.max_segments || payload.maxSegments || 8) || 8));
  const image = await resolveImageBuffer(payload);
  const segmented = await runComfySegment(image, maxSegments);

  const overlaySaved = segmented.overlay
    ? await saveGeneratedImageBuffer(request, segmented.overlay.buffer, "segment-overlay", "png")
    : null;

  const maskSavedList = await Promise.all(
    segmented.masks.slice(0, maxSegments).map((mask, index) =>
      saveGeneratedImageBuffer(request, mask.buffer, `segment-mask-${index + 1}`, "png"),
    ),
  );
  const cutoutSavedList = await Promise.all(
    segmented.cutouts.slice(0, maxSegments).map((cutout, index) =>
      saveGeneratedImageBuffer(request, cutout.buffer, `segment-cutout-${index + 1}`, "png"),
    ),
  );

  const segments: Array<Record<string, unknown>> = [];
  const count = Math.max(maskSavedList.length, cutoutSavedList.length, overlaySaved ? 1 : 0);
  for (let i = 0; i < Math.max(1, Math.min(maxSegments, count)); i += 1) {
    const mask = maskSavedList[i] || maskSavedList[0] || null;
    const cutout = cutoutSavedList[i] || null;
    segments.push({
      id: `segment-${i + 1}`,
      label: cutout ? "cutout" : mask ? "mask" : "object",
      mask_url: mask?.public_url || null,
      cutout_url: cutout?.public_url || overlaySaved?.public_url || null,
      bbox: null,
    });
  }

  return {
    kind: "segment",
    state: "complete",
    segments,
    overlay_url: overlaySaved?.public_url || null,
    backend: segmented.backend,
    output_names: segmented.output_names,
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

  try {
    await resolveImageBuffer(payload);
  } catch (error) {
    const status = Number((error as { status?: number })?.status || 400);
    return jsonCors({ detail: error instanceof Error ? error.message : String(error) }, { status });
  }

  if (wantAsync) {
    const jobId = startAsyncImageJob(() => runSegment(payload, request));
    return jsonCors({ status: 200, message: "accepted", data: { job_id: jobId } });
  }

  try {
    const data = await runSegment(payload, request);
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
