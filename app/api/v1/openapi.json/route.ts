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
      version: "1.4.0",
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
            aspect: {
              type: "string",
              examples: ["auto", "1:1", "3:2", "2:3", "9:16", "16:9"],
              description: "auto (default) follows the first reference image's proportions; 1:1 when there is no reference",
            },
            count: { type: "integer", minimum: 1, maximum: 4, default: 1 },
            image_model: { type: "string", description: "Preferred image model, e.g. gpt-image-2 | gpt-image-1.5 | seedream-4-5" },
            allow_generation_fallback: {
              type: "boolean",
              default: false,
              description: "When a reference edit fails, fall back to text-to-image. Off by default so edits never silently return unrelated pictures.",
            },
            quality: { type: "string", enum: ["low", "medium", "high"] },
            style: { type: "string" },
            brand: { type: "string" },
            design_memory: {
              type: "string",
              description: "User-approved default design skill; applied unless the current request explicitly overrides a specific rule",
            },
            audience: { type: "string" },
            negative_prompt: { type: "string" },
            reference_images: {
              type: "array",
              description: "Order matters: first item is the base image being edited, the rest are references (style / colour / garment / path).",
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
                      reference_mode: { type: "string", examples: ["multi", "single_fallback", "none"] },
                      policy_fallback: { type: "boolean", description: "true when the default model was blocked by content policy and the request completed on IMAGE_POLICY_FALLBACK_MODEL" },
                    },
                  },
                },
                policy_fallback: { type: "boolean" },
                error_kind: { type: "string", enum: ["content_policy", "upstream"], description: "Set when some or all images failed; failed jobs prefix the error with content_policy: when the block was a safety rejection" },
              },
            },
          },
        },
        AgentChatRequest: {
          type: "object",
          required: ["messages"],
          properties: {
            mode: {
              type: "string",
              enum: ["plan", "execute"],
              default: "execute",
              description: "Use plan for a context-aware design brief before calling execute with the returned plan in canvas_state.design_plan.",
            },
            model: { type: "string", description: "Optional planning/chat model override" },
            messages: {
              type: "array",
              items: {
                type: "object",
                required: ["role", "content"],
                properties: {
                  role: { type: "string", enum: ["system", "user", "assistant", "tool"] },
                  content: {
                    oneOf: [
                      { type: "string" },
                      {
                        type: "array",
                        description: "OpenAI multimodal parts: {type:text,text} and {type:image_url,image_url:{url}} — user turns may carry the pictures they refer to as 图一/图二",
                        items: { type: "object" },
                      },
                    ],
                  },
                  tool_call_id: { type: "string" },
                  name: { type: "string" },
                },
              },
            },
            canvas_state: {
              type: "object",
              description: "Current canvas, Brand Kit, default design skill, and optional locked design_plan.",
            },
          },
        },
        DesignPlan: {
          type: "object",
          required: ["title", "summary", "action", "decisions", "finalPrompt", "negativePrompt"],
          properties: {
            title: { type: "string" },
            summary: { type: "string" },
            action: {
              type: "string",
              enum: ["generate", "edit", "restyle_text", "material", "video", "vectorize", "export", "answer"],
            },
            decisions: { type: "array", items: { type: "string" } },
            finalPrompt: { type: "string", description: "Expanded prompt locked for the execute phase" },
            negativePrompt: { type: "string" },
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
      "/ontology": {
        post: {
          summary: "本体视频法 C 线：需求 → 本体（对象/属性/链接/锚图/镜头），默认随即开始锚图生成",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["brief"],
                  properties: {
                    brief: { type: "string", description: "视频需求原文（≥ 8 字）" },
                    audience: { type: "string", enum: ["owner", "showroom", "accessory"], default: "showroom" },
                    aspect_ratio: { type: "string", enum: ["16:9", "9:16", "1:1"], default: "16:9" },
                    model: { type: "string", description: "优先使用的 LLM 模型名（可选）" },
                    auto_anchors: { type: "boolean", default: true, description: "false 时只起草本体，不生成锚图" },
                  },
                },
              },
            },
          },
          responses: { "201": { description: "已起草；返回 id、review_url（人工审核 HTML）、json_url" } },
        },
        get: { summary: "最近的本体列表", responses: { "200": { description: "items[]" } } },
      },
      "/ontology/{id}": {
        get: {
          summary: "本体 JSON（会同步镜头视频任务状态）",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Ontology" }, "404": { description: "not found" } },
        },
        patch: {
          summary: "写入审核决定：anchors{id: approved|rejected|{status,feedback}}、shots{id:{status,caption,motion_prompt}}、notes",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "state 与通过数量" } },
        },
      },
      "/ontology/{id}/anchors": {
        post: {
          summary: "开始（重）生成锚图；body.anchor_ids 可选，缺省为所有待生成/失败的锚图",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "202": { description: "已开始" }, "409": { description: "已有任务在跑" } },
        },
      },
      "/ontology/{id}/generate": {
        post: {
          summary: "把已通过且两端锚图已通过的镜头提交为首尾关键帧图生视频任务（固定 8 秒）",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "202": { description: "submitted 数量与各镜头 job id" }, "400": { description: "没有可提交的镜头" } },
        },
      },
      "/ontology/{id}/review": {
        get: {
          summary: "人工审核页（独立 HTML：对象与锚图、链接图、镜头起止锚图、字幕、生成结果）",
          security: [],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "text/html" } },
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
          summary: "Lovart-style visual agent: multimodal edit/generate planning with canvas tool calls (edit_images, generate_images, remove_background, upscale_image, vectorize_image, restyle_lettering, transfer_material, export_ai)",
          servers: [{ url: agentBaseUrl }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/AgentChatRequest" } } },
          },
          responses: {
            "200": {
              description: "mode=plan returns data.plan; mode=execute returns data.message with optional tool_calls",
            },
          },
        },
      },
      "/image-jobs/{job_id}": {
        get: {
          summary: "Poll async image job status (matting/segment/images/inpaint etc.)",
          parameters: [{ name: "job_id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "Job state: running | done | failed" },
            "404": { description: "Job not found" },
          },
        },
      },
      "/inpaint": {
        post: {
          summary: "Mask inpaint via images/edits (async recommended)",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["image_b64", "mask_b64"],
                  properties: {
                    image_b64: { type: "string" },
                    mask_b64: { type: "string" },
                    instruction: { type: "string" },
                    size: { type: "string", examples: ["1024x1024"] },
                    async: { type: "boolean", default: true },
                  },
                },
              },
            },
          },
          responses: { "200": { description: "Accepted job or completed inpaint" } },
        },
      },
      "/ocr-lines": {
        post: {
          summary: "OCR text lines with bounding boxes for local font restyle",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object", properties: { image_b64: { type: "string" } } } } },
          },
          responses: { "200": { description: "OCR lines" } },
        },
      },
      "/canvas-snapshots/{project_id}": {
        get: {
          summary: "Load a canvas cloud snapshot",
          parameters: [{ name: "project_id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Snapshot JSON" }, "404": { description: "Not found" } },
        },
        put: {
          summary: "Save a canvas cloud snapshot",
          parameters: [{ name: "project_id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object" } } },
          },
          responses: { "200": { description: "Saved" } },
        },
      },
      "/matting": {
        post: {
          summary: "GPU BiRefNet background matting (async by default; poll /image-jobs)",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    image_b64: { type: "string", description: "PNG/JPEG data URL or base64" },
                    image_url: { type: "string", description: "Remote image URL (image/* only, ≤12MB)" },
                    async: { type: "boolean", default: true },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "Accepted job_id or completed matting result" },
            "503": { description: "GPU_COMFY_BASE_URL not configured" },
          },
        },
      },
      "/segment": {
        post: {
          summary: "GPU SAM2 semantic segmentation (async by default; poll /image-jobs)",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    image_b64: { type: "string" },
                    image_url: { type: "string" },
                    max_segments: { type: "integer", minimum: 1, maximum: 16, default: 8 },
                    async: { type: "boolean", default: true },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "Accepted job_id or completed segment result" },
            "503": { description: "GPU_COMFY_BASE_URL not configured" },
          },
        },
      },
    },
  });
}

export async function OPTIONS() {
  return optionsResponse();
}
