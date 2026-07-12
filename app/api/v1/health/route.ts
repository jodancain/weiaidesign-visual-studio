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

export async function GET() {
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
  });
}

export async function OPTIONS() {
  return optionsResponse();
}
