import { jsonCors, optionsResponse } from "../_lib/visual-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const origin = new URL(request.url).origin;
  const publicBaseUrl = (process.env.PUBLIC_BASE_URL || `${origin}/api/v1`).replace(/\/+$/, "");
  return jsonCors({
    openapi: "3.1.0",
    info: {
      title: "Youngtuo Visual Studio API",
      version: "1.0.0",
    },
    servers: [{ url: publicBaseUrl }],
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
        },
      },
    },
    paths: {
      "/health": { get: { summary: "Deployment and model configuration health" } },
      "/images": { post: { summary: "Generate GPT images for the visual canvas" } },
      "/generated-images/{image_id}/{filename}": { get: { summary: "Read a generated image asset" } },
      "/image-videos": { post: { summary: "Proxy to the configured image-to-video backend when available" } },
      "/image-videos/{job_id}": { get: { summary: "Proxy image-to-video job status when available" } },
      "/openapi.json": { get: { summary: "OpenAPI schema" } },
    },
  });
}

export async function OPTIONS() {
  return optionsResponse();
}
