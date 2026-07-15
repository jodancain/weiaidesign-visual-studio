import { jsonCors, optionsResponse, requireVideoToken } from "../v1/_lib/visual-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const env = process.env;

const AGENT_SYSTEM_PROMPT = `你是 Youngtuo Visual Studio 的专业视觉设计代理，语言用中文。
工作方式：
1. 收到设计请求后，先用一两句话简述设计方案（构图/风格/配色/文字），不要长篇大论。
2. 生成图片前必须扩写 prompt：把要出现的中文/英文字样逐字写明（例如 标题文字："茶館"、副标题："CHAGUAN"），说明文字排版位置与字体气质、整体构图、主体细节、材质与光影、背景处理；避免泛泛描述。
3. 扩写完成后调用工具执行；生成类工具会自动把结果放到画布上。
4. 工具完成后，用 1-2 句话总结设计要点，并给作品起一个简短中文名，格式：【作品名】xxx。
5. 用户消息里出现 @高画质/@中画质/@低画质 时，把 quality 参数设为 high/medium/low；未提及时不传。
6. 改字/材质/视频/矢量化需要用户先在画布上选中图片；若当前没有选中（见画布状态），提醒用户选中后再说一次。
7. 只引用工具真实返回的链接，不要编造。`;

const TOOLS = [
  {
    type: "function",
    function: {
      name: "generate_images",
      description: "用扩写后的完整 prompt 生成图片并自动放到画布。调用前必须按系统规则扩写 prompt（字样逐字写明、排版、构图、材质光影）。",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "扩写后的完整图像生成 prompt（中文）" },
          aspect: { type: "string", description: "画幅：1:1 | 3:2 | 2:3 | 16:9 | 9:16" },
          count: { type: "number", description: "张数 1-4，默认 1" },
          quality: { type: "string", description: "low | medium | high" },
          transparent_background: { type: "boolean", description: "透明背景输出（logo/贴纸/图标/素材类需求时设 true）" },
          use_selected_reference: { type: "boolean", description: "以画布选中图为参考图（用户说\"参考这张/基于这张画\"时设 true）" },
        },
        required: ["prompt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "restyle_lettering",
      description: "同风格改字：以画布当前选中的第一张图片为字体设计参考，保持原字体骨架/笔画/质感/颜色，把文字替换为 new_text。需要用户已选中图片。",
      parameters: {
        type: "object",
        properties: {
          new_text: { type: "string", description: "新的文字内容" },
          style_note: { type: "string", description: "补充风格要求（可选）" },
        },
        required: ["new_text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "transfer_material",
      description: "材质复刻：把画布选中的第二张图（材质样本）的纹理迁移到第一张图（目标图案）上。需要用户同时选中两张图片。",
      parameters: {
        type: "object",
        properties: {
          instruction: { type: "string", description: "补充说明（可选）" },
          swap: { type: "boolean", description: "是否交换目标图与材质图" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_selected_image",
      description:
        "对画布选中的第一张图做指令式修改（去除背景/高清增强细节/移除某元素/调整局部/换角度等），保持主体与风格一致。需要用户已选中图片。",
      parameters: {
        type: "object",
        properties: {
          instruction: { type: "string", description: "修改指令，中文，明确说明改什么、保持什么不变" },
        },
        required: ["instruction"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "image_to_video",
      description: "视频功能已迁移到独立页面 /video。用户要做视频时调用本工具即可获得指路话术。",
      parameters: {
        type: "object",
        properties: { subject: { type: "string", description: "视频运动/内容描述" } },
        required: ["subject"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "vectorize_selected",
      description: "把画布选中的第一张位图矢量化并下载 SVG。需要用户已选中图片。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "export_ai",
      description: "把画布选区（未选中则整页）导出为 Illustrator 可打开的 .ai 文件并下载。",
      parameters: { type: "object", properties: {} },
    },
  },
];

type ChatUpstream = { base: string; key: string; models: string[] };

/* 主备双上游：AGENT_LLM_*（新 router，多模型自动匹配）优先，原 relay 备选 */
function chatUpstreams(): ChatUpstream[] {
  const list: ChatUpstream[] = [];
  const agentBase = (env.AGENT_LLM_BASE_URL || "").replace(/\/+$/, "");
  const agentKey = env.AGENT_LLM_API_KEY || "";
  const agentModels = (env.AGENT_LLM_MODELS || "cx/gpt-5.4,cbcn/glm-5.2,cbcn/kimi-k2.7")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (agentBase && agentKey && agentModels.length) list.push({ base: agentBase, key: agentKey, models: agentModels });
  const relayBase = (env.IMAGE_OPENAI_BASE_URL || "").replace(/\/+$/, "");
  const relayKey = env.IMAGE_OPENAI_API_KEY || env.OPENAI_API_KEY || "";
  if (relayBase && relayKey) list.push({ base: relayBase, key: relayKey, models: [env.AGENT_LLM_MODEL || "gpt-5.4-mini"] });
  return list;
}

export async function POST(request: Request) {
  const authError = requireVideoToken(request);
  if (authError) return authError;

  const upstreams = chatUpstreams();
  if (!upstreams.length) {
    return jsonCors({ detail: "agent LLM is not configured (AGENT_LLM_* / IMAGE_OPENAI_*)" }, { status: 503 });
  }

  let payload: { messages?: unknown[]; canvas_state?: unknown; model?: string };
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return jsonCors({ detail: "invalid JSON body" }, { status: 400 });
  }
  const history = Array.isArray(payload.messages) ? payload.messages : [];
  if (!history.length) return jsonCors({ detail: "messages is required" }, { status: 400 });

  const systemContent = `${AGENT_SYSTEM_PROMPT}\n\n当前画布状态：${JSON.stringify(payload.canvas_state || {})}`;
  const preferred = String(payload.model || "").trim();
  const errors: string[] = [];

  for (const upstream of upstreams) {
    const models = preferred && upstream.models.includes(preferred)
      ? [preferred, ...upstream.models.filter((m) => m !== preferred)]
      : upstream.models;
    for (const model of models) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 90000);
      try {
        const response = await fetch(`${upstream.base}/chat/completions`, {
          method: "POST",
          headers: { authorization: `Bearer ${upstream.key}`, "content-type": "application/json" },
          body: JSON.stringify({
            model,
            messages: [{ role: "system", content: systemContent }, ...history.slice(-30)],
            tools: TOOLS,
            tool_choice: "auto",
          }),
          signal: controller.signal,
        });
        const text = await response.text();
        if (!response.ok) {
          errors.push(`${model}: HTTP ${response.status} ${text.slice(0, 120)}`);
          continue;
        }
        let data: unknown = {};
        try {
          data = JSON.parse(text);
        } catch {
          errors.push(`${model}: non-JSON response`);
          continue;
        }
        const message = (data as { choices?: Array<{ message?: unknown }> }).choices?.[0]?.message || null;
        if (!message) {
          errors.push(`${model}: no message`);
          continue;
        }
        return jsonCors({ status: 200, message: "success", data: { message, model } });
      } catch (error) {
        errors.push(`${model}: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        clearTimeout(timer);
      }
    }
  }
  return jsonCors({ detail: `all agent models failed: ${errors.join(" | ").slice(0, 600)}` }, { status: 502 });
}

export async function OPTIONS() {
  return optionsResponse();
}
