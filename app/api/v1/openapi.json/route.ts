import { jsonCors, optionsResponse } from "../_lib/visual-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const origin = new URL(request.url).origin;
  const publicBaseUrl = (process.env.PUBLIC_BASE_URL || `${origin}/api/v1`).replace(/\/+$/, "");
  const siteBaseUrl = (process.env.NEXT_PUBLIC_SITE_URL || origin).replace(/\/+$/, "");
  const agentBaseUrl = `${siteBaseUrl}/api`;
  return jsonCors({
    openapi: "3.1.0",
    info: {
      title: "Youngtuo Visual Studio API",
      version: "1.1.0",
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
      schemas: {
        ImageGenerationRequest: {
          type: "object",
          required: ["prompt"],
          properties: {
            prompt: { type: "string" },
            aspect: { type: "string", examples: ["1:1", "9:16", "16:9"] },
            count: { type: "integer", minimum: 1, maximum: 4, default: 1 },
            quality: { type: "string", enum: ["low", "medium", "high"] },
            style: { type: "string" },
            brand: { type: "string" },
            audience: { type: "string" },
            negative_prompt: { type: "string" },
            reference_images: {
              type: "array",
              items: {
                oneOf: [
                  { type: "string", description: "Base64 image or data URL" },
                  {
                    type: "object",
                    properties: {
                      b64: { type: "string" },
                      filename: { type: "string" },
                      mime_type: { type: "string" },
                    },
                  },
                ],
              },
            },
          },
        },
        ImageJobResponse: {
          type: "object",
          properties: {
            status: { type: "integer", examples: [200] },
            message: { type: "string", examples: ["success"] },
            data: {
              type: "object",
              properties: {
                job_id: { type: "string" },
                state: { type: "string", examples: ["complete"] },
                progress: { type: "integer", examples: [100] },
                images: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      public_url: { type: "string" },
                      download_url: { type: "string" },
                      prompt: { type: "string" },
                      model: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
        AgentChatRequest: {
          type: "object",
          required: ["messages"],
          properties: {
            messages: {
              type: "array",
              items: {
                type: "object",
                required: ["role", "content"],
                properties: {
                  role: { type: "string", enum: ["user", "assistant", "tool"] },
                  content: { type: "string" },
                  tool_call_id: { type: "string" },
                  name: { type: "string" },
                },
              },
            },
            canvas_state: {
              type: "object",
              description: "Optional current canvas selection and scene state for tool planning.",
            },
          },
        },
      },
    },
    paths: {
      "/health": {
        get: {
          summary: "Deployment and model configuration health",
          security: [],
          responses: { "200": { description: "Health state" } },
        },
      },
      "/images": {
        post: {
          summary: "Generate GPT images for the visual canvas",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/ImageGenerationRequest" } } },
          },
          responses: { "200": { description: "Image job", content: { "application/json": { schema: { $ref: "#/components/schemas/ImageJobResponse" } } } } },
        },
      },
      "/font-restyle": {
        post: {
          summary: "Replace text while preserving the selected lettering style",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  allOf: [
                    { $ref: "#/components/schemas/ImageGenerationRequest" },
                    {
                      type: "object",
                      required: ["new_text"],
                      properties: {
                        new_text: { type: "string" },
                        style_note: { type: "string" },
                      },
                    },
                  ],
                },
              },
            },
          },
          responses: { "200": { description: "Restyled lettering image job" } },
        },
      },
      "/material-transfer": {
        post: {
          summary: "Transfer a material swatch onto a target design",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  allOf: [
                    { $ref: "#/components/schemas/ImageGenerationRequest" },
                    {
                      type: "object",
                      properties: {
                        instruction: { type: "string" },
                        swatch_position: { type: "string", default: "right" },
                      },
                    },
                  ],
                },
              },
            },
          },
          responses: { "200": { description: "Material transfer image job" } },
        },
      },
      "/generated-images/{image_id}/{filename}": {
        get: {
          summary: "Read a generated image asset",
          security: [],
          parameters: [
            { name: "image_id", in: "path", required: true, schema: { type: "string" } },
            { name: "filename", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: { "200": { description: "Image bytes" }, "404": { description: "Image not found" } },
        },
        head: {
          summary: "Check a generated image asset",
          security: [],
          parameters: [
            { name: "image_id", in: "path", required: true, schema: { type: "string" } },
            { name: "filename", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: { "200": { description: "Image exists" }, "404": { description: "Image not found" } },
        },
      },
      "/image-videos": {
        post: {
          summary: "Proxy to the configured image-to-video backend when available",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object" } } },
          },
          responses: { "200": { description: "Image-to-video job" } },
        },
      },
      "/image-videos/{job_id}": {
        get: {
          summary: "Proxy image-to-video job status when available",
          parameters: [{ name: "job_id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Image-to-video job status" } },
        },
      },
      "/openapi.json": {
        get: {
          summary: "OpenAPI schema",
          security: [],
          responses: { "200": { description: "OpenAPI schema" } },
        },
      },
      "/agent-chat": {
        post: {
          summary: "Lovart-style planning agent with tool calls for the canvas",
          servers: [{ url: agentBaseUrl }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/AgentChatRequest" } } },
          },
          responses: { "200": { description: "Assistant message with optional tool_calls" } },
        },
      },
    },
  });
}

export async function OPTIONS() {
  return optionsResponse();
}
