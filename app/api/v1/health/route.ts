import { gpuComfyHostOnly, isGpuComfyConfigured } from "../_lib/comfy-gpu";
import {
  imageFallbackModels,
  imageGenerationConcurrency,
  imageGenerationRetries,
  imageModel,
  imageOutputCompression,
  imageOutputDir,
  imageOutputFormat,
  imageQuality,
  imageTimeoutSeconds,
  jsonCors,
  optionsResponse,
} from "../_lib/visual-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Ask the video gateway whether Story Mode (Blender greybox keyframes) is wired up.
    Best-effort with a short timeout: health must never hang on the upstream. */
async function upstreamStoryModeAvailable(): Promise<boolean | null> {
  const base = (process.env.VIDEO_API_PROXY_BASE_URL || "").replace(/\/+$/, "");
  if (!base) return null;
  try {
    const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2500) });
    if (!response.ok) return null;
    const data = (await response.json()) as { story_mode_available?: unknown };
    return typeof data.story_mode_available === "boolean" ? data.story_mode_available : null;
  } catch {
    return null;
  }
}

export async function GET() {
  const storyModeAvailable = await upstreamStoryModeAvailable();
  return jsonCors({
    status: "ok",
    backend: "next-visual-api",
    image_generation_endpoint: true,
    image_model: imageModel,
    image_fallback_models: imageFallbackModels,
    image_quality: imageQuality,
    image_output_format: imageOutputFormat,
    image_output_compression: imageOutputCompression,
    image_timeout_seconds: imageTimeoutSeconds,
    image_generation_retries: imageGenerationRetries,
    image_generation_concurrency: imageGenerationConcurrency,
    image_output_dir: imageOutputDir,
    image_base_url_configured: Boolean(process.env.IMAGE_OPENAI_BASE_URL),
    image_key_set: Boolean(process.env.IMAGE_OPENAI_API_KEY || process.env.OPENAI_API_KEY),
    api_token_configured: Boolean(process.env.VIDEO_API_TOKEN),
    video_proxy_configured: Boolean(process.env.VIDEO_API_PROXY_BASE_URL),
    story_mode_available: storyModeAvailable,
    gpu_comfy_configured: isGpuComfyConfigured(),
    gpu_comfy_base_url_host: gpuComfyHostOnly() || null,
  });
}

export async function OPTIONS() {
  return optionsResponse();
}
