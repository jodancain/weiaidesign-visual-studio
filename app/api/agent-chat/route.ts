import { jsonCors, optionsResponse, requireVideoToken } from "../v1/_lib/visual-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const env = process.env;

const AGENT_SYSTEM_PROMPT = `你是 Youngtuo Visual Studio 的专业视觉设计代理，语言用中文。
工作方式：
1. 当前画布状态若含 design_plan，表示前置设计规划已经完成并锁定。必须严格沿用其 action、decisions、finalPrompt 和 negativePrompt，直接选择并调用合适工具，不得重新换方向；若没有 design_plan，才用一两句话补充方案。
2. 生成图片时必须使用 design_plan.finalPrompt；其中应把要出现的中文/英文字样逐字写明（例如 标题文字："茶館"、副标题："CHAGUAN"），并明确文字排版位置与字体气质、整体构图、主体细节、材质与光影、背景处理。
3. 扩写完成后调用工具执行；生成类工具会自动把结果放到画布上。
4. 工具完成后，用 1-2 句话总结设计要点，并给作品起一个简短中文名，格式：【作品名】xxx。
5. 用户消息里出现 @高画质/@中画质/@低画质 时，把 quality 参数设为 high/medium/low；未提及时不传。
6. 改字/材质/视频/矢量化需要用户先在画布上选中图片；若当前没有选中（见画布状态），提醒用户选中后再说一次。
7. 只引用工具真实返回的链接，不要编造。
8. 若画布状态含 brand_kit：扩写 prompt 必须遵守其色板（逐个写出 HEX）、风格词、字体气质；hasLogo 为 true 时注明「logo 已作为参考图上传，须保持原样、勿重绘 logo」；仅当用户明确要求偏离品牌时，以用户指令为准。
9. 若画布状态含 design_memory：把它视为默认持续生效的个人设计 Skill，而不是可选参考。所有与当前任务相关的通用规则必须执行；品牌专属规则在任务涉及对应品牌时自动执行。用户没有重复提及规则不代表取消，只有本次消息明确要求修改或偏离某条规则时，才覆盖对应规则，其余规则继续生效。不要在回复中机械复述 Skill，直接体现在方案、工具参数和扩写 prompt 中。`;

const DESIGN_PLAN_SYSTEM_PROMPT = `你是 Youngtuo Visual Studio 的资深创意总监。你的任务是先做可执行的前置设计规划，不调用任何工具，也不输出隐藏思维过程。
你必须结合：最近对话上下文、用户当前请求、画布选中与历史成品、Brand Kit、默认个人设计 Skill、画幅/数量/受众/避免项。
规则：
1. 默认个人设计 Skill 是持续生效的硬约束；用户未重复提及不算取消。只有本次请求明确要求改变某条规则时，才覆盖对应规则。
2. Brand Kit 和品牌专属规则只在当前任务涉及对应品牌时启用，但一旦启用必须严格遵守。
3. 像 ChatGPT 网页一样利用对话上下文理解省略指代、续改要求和已经确认的方向；像 Lovart 一样先明确构图、风格配色、文字排版、主体细节、材质光影、背景和避免项。
4. finalPrompt 必须是可以直接交给图像模型或编辑工具的完整中文执行指令。所有要出现的文字必须逐字写明，并说明位置和字体气质；未要求文字时明确“画面不出现任何文字或水印”。
5. 只给出简洁的专业设计决策，不解释逐步推理。
6. 仅输出一个 JSON 对象，不要 Markdown、代码围栏或额外文字，字段固定为：
{"title":"14字内方案名","summary":"1-2句目标摘要","action":"generate|edit|restyle_text|material|video|vectorize|export|answer","decisions":["4-6条可见设计决策"],"finalPrompt":"完整执行提示词","negativePrompt":"需要避免的元素与错误"}`;

type DesignPlan = {
  title: string;
  summary: string;
  action: "generate" | "edit" | "restyle_text" | "material" | "video" | "vectorize" | "export" | "answer";
  decisions: string[];
  finalPrompt: string;
  negativePrompt: string;
};

const DESIGN_PLAN_ACTIONS = new Set<DesignPlan["action"]>([
  "generate",
  "edit",
  "restyle_text",
  "material",
  "video",
  "vectorize",
  "export",
  "answer",
]);

const ANSWER_ONLY_PATTERN = /(?:不要|无需|不需要|先不|暂不).{0,8}(?:生成|出图|做图)|只(?:给|要|做|分析).{0,8}(?:方案|分析|建议|方向|提示词)|(?:方案|分析|建议|方向).{0,8}(?:即可|就行)/i;

function cleanPlanText(value: unknown, max: number) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function parseDesignPlan(raw: string, fallbackBrief: string): DesignPlan {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  let value: Record<string, unknown> = {};
  if (start >= 0 && end > start) {
    try {
      value = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
    } catch {
      value = {};
    }
  }
  const actionValue = cleanPlanText(value.action, 32) as DesignPlan["action"];
  const action = ANSWER_ONLY_PATTERN.test(fallbackBrief)
    ? "answer"
    : DESIGN_PLAN_ACTIONS.has(actionValue)
      ? actionValue
      : "generate";
  const decisions = Array.isArray(value.decisions)
    ? value.decisions.map((item) => cleanPlanText(item, 500)).filter(Boolean).slice(0, 6)
    : [];
  const fallbackDecision = cleanPlanText(raw, 500);
  const normalizedDecisions = decisions.length >= 3
    ? decisions
    : [
        fallbackDecision || "结合当前对话锁定用户真实目标与交付用途",
        "遵守已启用的默认个人设计 Skill 与相关 Brand Kit",
        "明确主体、构图层级、配色、文字与材质光影后再执行",
        "保持画面干净可落地，并主动排除长期避免项",
      ];
  return {
    title: cleanPlanText(value.title, 40) || "前置设计方案",
    summary: cleanPlanText(value.summary, 800) || "已结合对话上下文、画布和默认设计规范整理执行方向。",
    action,
    decisions: normalizedDecisions,
    finalPrompt: cleanPlanText(value.finalPrompt ?? value.final_prompt, 12000) || fallbackBrief,
    negativePrompt: cleanPlanText(value.negativePrompt ?? value.negative_prompt, 3000),
  };
}

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
          negative_prompt: { type: "string", description: "来自前置设计方案的避免项与负面约束" },
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

  let payload: { messages?: unknown[]; canvas_state?: unknown; model?: string; mode?: string };
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return jsonCors({ detail: "invalid JSON body" }, { status: 400 });
  }
  const history = Array.isArray(payload.messages) ? payload.messages : [];
  if (!history.length) return jsonCors({ detail: "messages is required" }, { status: 400 });

  const mode = payload.mode === "plan" ? "plan" : "execute";
  const systemContent = `${mode === "plan" ? DESIGN_PLAN_SYSTEM_PROMPT : AGENT_SYSTEM_PROMPT}\n\n当前画布状态：${JSON.stringify(payload.canvas_state || {})}`;
  const requestHistory = mode === "plan"
    ? history
        .flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const message = item as { role?: unknown; content?: unknown };
          const role = String(message.role || "");
          if ((role !== "user" && role !== "assistant") || typeof message.content !== "string" || !message.content.trim()) return [];
          return [{ role, content: message.content }];
        })
        .slice(-24)
    : history.slice(-30);
  const fallbackBrief = [...requestHistory]
    .reverse()
    .find((item) => item && typeof item === "object" && (item as { role?: unknown }).role === "user") as { content?: unknown } | undefined;
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
            messages: [{ role: "system", content: systemContent }, ...requestHistory],
            ...(mode === "execute" ? { tools: TOOLS, tool_choice: "auto" } : {}),
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
        if (mode === "plan") {
          const content = String((message as { content?: unknown }).content || "");
          const plan = parseDesignPlan(content, cleanPlanText(fallbackBrief?.content, 12000));
          return jsonCors({ status: 200, message: "success", data: { plan, model } });
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
