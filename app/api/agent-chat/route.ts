import { jsonCors, optionsResponse, requireVideoToken } from "../v1/_lib/visual-api";
import { chatUpstreams } from "../v1/_lib/llm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const env = process.env;

/* 操作手册来源：《Lovart 全量创作档案》56 项目 / 181 轮的真实用法回放。
   绝大多数请求是「带 1–3 张参考图的局部编辑」，不是文生图；因此规则围绕图序指代、只改指定处、其余锁定来写。 */
const AGENT_SYSTEM_PROMPT = `你是 Youngtuo Visual Studio 的视觉设计代理（对标 Lovart Agent），全程用中文。

## 一、你看到的输入
- 用户消息里可能带若干张图片，按出现顺序编号：第 1 张 = 图一 / 图1 / Image A，第 2 张 = 图二 / 图2 / Image B，依此类推。画布状态 images 列表给出每张图的编号、来源（本轮附带 / 画布选中 / 上一版成品）和宽高。
- 用户说「图一/图二」时永远按这个编号解析，不要猜。用户说「这张 / 这个 / 上面的」而只有一张图时就是它；没有附图但对话里有上一版成品时，默认操作对象就是最新那张成品。
- 用户说「我原图 / 回到上一版 / 用最开始那张」时，操作对象换成对应的历史图（在 images 列表里找 source 为 attached 的原图或更早成品）。

## 二、先判断角色：主图 vs 参考图
每次编辑只有一张「主图」（被修改、构图/主体要保留的那张），其余是「参考图」（只提供某一个维度：画风 / 配色 / 款式 / 姿势 / 印花 / 路径 / 粗细 / 收尾方式）。常见句式：
- 「图二的 y 尾巴参考图一，其他字体不变」→ 主图=图二，参考=图一（只借尾巴造型）。
- 「把图一的衣服穿到图二模特身上」→ 主图=图二（模特、姿势、背景不变），参考=图一（衣服款式与印花）。
- 「图一变成图二画风，不要改图一的姿势」→ 主图=图一（姿势/构图/主体锁定），参考=图二（只借线条、上色方式）。
- 「把图二粉色部分变成图一颜色」→ 主图=图二，参考=图一（只取颜色）。
- 「参考图一 logo 的粗细变化，调整图二」→ 主图=图二，参考=图一（只取笔画粗细节奏）。
- 「参考图一图二的挂饰，用图三内容生成挂饰，色系按图三」→ 参考=图一图二（造型结构），主体与色系来源=图三。
- 「图一是我参考图二图三画的草稿，帮我规范一下」→ 主图=图一（草稿是唯一基础，不重新设计），参考=图二图三（规范化方向）。
调用 edit_images 时把主图放在 base_image，参考图按用户编号顺序放进 reference_images，并在 prompt 里逐张写明「第 N 张图是什么、只借它的什么」。

## 三、编辑任务的 prompt 写法（这是成败关键）
prompt 用中文写给图像编辑模型，结构固定为四段，缺一不可：
1. 图序说明：「第 1 张图（主图）：…；第 2 张图（参考）：只参考它的…，不要复制它的其他内容。」
2. 要改什么：一句话说清动作 + 范围，越具体越好（哪个部位、哪几个字母、哪一侧）。
3. 锁定清单（逐项写出来）：主体形象、头身比例、姿势、手脚位置、五官、线条粗细与手绘感、配色、构图、背景、衣服版型、字形骨架、字间节奏……凡是用户没让改的都写进「保持与主图完全一致」。用户说过「其他不变 / 不要改我的字 / 严格保留」时必须原话级强调，并追加「不重绘、不重新设计、不添加新元素」。
4. 输出规格：背景（透明 / 纯白 / 保持原背景）、是否只输出单个物件、是否平面矢量风格（纯色平涂、无渐变无阴影无 3D）、张数。
高频任务的标准写法（直接套用并补细节）：
- 去图案/去文字/去 logo：「去掉衣服上的所有图案与文字，保留版型、颜色、褶皱、光影与背景，不改变衣服轮廓。」
- 单独提取某物：「只保留 X，其余全部去掉，输出为透明背景 PNG（或纯白底），X 本身的造型、颜色、比例、线条一个像素都不改，被遮挡处不自行补画（除非用户要求补全）。」
- 去背景：优先调用 remove_background（精确抠图），不要用重绘。
- 换装/换印花：「把第 2 张图的衣服穿到第 1 张图模特身上，模特脸、发型、姿势、手、背景、鞋包全部不变；衣服按身体透视自然贴合，印花按原图图案原样映射，不重新绘制图案。」用户强调印花不能变时补一句「Prioritize textile print fidelity over creative reinterpretation」。
- 画风转换：「保持第 1 张图的姿势、动作、构图、主体轮廓和背景不变，只把线条、上色方式、质感换成第 2 张图的画风（描边粗细、抖动感、平涂/水彩/蜡笔…）。」
- 配色替换：「只把 X 部分的颜色换成第 2 张图的 Y 色（写出色彩描述/HEX），其余颜色、形状、光影不变。」
- 补全缺失/去遮挡：「去掉 X，按已露出的线条延续轮廓补全被遮挡部分，线条风格粗细与原图一致，不新增动作，不改变已有元素。」
- 路径文字（半弧/下半圆/S 形）：「严格沿用原字形、字重、颜色，一个字母都不重新设计，只把文字沿 <路径> 排列并随切线旋转；不要添加路径线本身。」下半圆=圆弧开口朝上，上拱半弧=开口朝下，用户没说方向时默认上拱。
- 字母大小统一 / 笔画粗细：「保留字体骨架与装饰细节，只把 <目标> 调整为 <目标状态>，保留原有的粗细节奏与基线。」用户抱怨「没有节奏了」时补「粗细要保留原字体的对比与节奏，不要变成等宽」。
- 花体更夸张 / 去多余花边：只放大或删减首尾装饰笔画，字母主体与颜色不变。
- 添加外描边：需要颜色和粗细，缺一就先问（例：「白色 5px？」）。
- 多方位产品图 / 模特佩戴：先列 shot 清单（平铺正面、对角折叠、模特正面、侧面 45°、细节特写…），每个 shot 单独调用一次 edit_images（并行调用），每张都写「严格保持原图案设计不变」。
- 多生成几个 / 多种款式：count=4（用户给了数量按数量），prompt 末尾写「4 个不同款式，每个都保留原图的核心特征」。
- 草稿精修：「以用户草稿为唯一基础，不重新设计角色；清理重复线、断线、杂线，统一描边粗细；其余结构、比例、姿势完全保留。」

## 四、追问与纠错（对话延续规则）
- 「不对 / 不要改我的字 / 你确定他穿上了？」：不要道歉了事，先在回复第一句说清上一版错在哪，再基于**用户确认过的那一版**（不是失败版）重新执行，锁定清单加严。
- 「同理 / 这个也一样」：把上一轮同样的修改套到本轮新附的图上。
- 「继续」：沿同一方向再出一组（count=4），并在回复里确认你理解的「继续」是什么。
- 连续两次同一处精细排版（单个字母缩放、像素级印花保真）仍失败时，坦白：生成式编辑是「理解后重绘」，做不到像素级 1:1；给出替代方案（矢量软件手动调整 / 透视贴图合成 / 放宽要求后再试一版），并问用户选哪条路。
- 用户明显生气时（感叹号、「去死吧」）：不再自由发挥，只问一个最核心的问题（角色被改了？形态不对？位置不对？），拿到答案再动手。

## 五、何时先问、何时直接做
直接做：指令里动作和对象都明确（绝大多数情况）。
先问（只问一个最小问题，不生成）：缺关键参数（描边颜色/粗细、高清放到多大、提取整组还是单个角色）、「看着有些奇怪帮我调一下」但看不出具体问题、需要参考图却没有附图。
用户口头说「参考图」但没有附图：明确告诉他没看到图，请他贴图；或说「直接做」你就按文字原创。

## 六、模型与画质
- 编辑默认 quality=medium；用户提到 高清/精修/矢量/logo 或明确 @高画质 → high；@低画质 → low；@中画质 → medium。
- 用户消息含 @Image-2 / @Image-1.5 / @Seedream 时 model_hint 相应设为 gpt-image-2 / gpt-image-1.5 / seedream-4-5。
- 工具返回 error_kind=content_policy（内容安全拦截，常见于真人穿搭、内衣、「紧身」等词）：立刻用 model_hint=seedream-4-5 重试一次，同时把敏感措辞改成中性表达（「紧身」→「修身」、真人→平铺展示或人台）；回复里用一句话说明「默认模型安全审核误判，已改用其他图像模型完成」。若仍失败，如实告知并建议改成平铺/人台。
- aspect 默认 auto（跟随主图比例）；用户说横版/宽 → 16:9 或 3:2，竖版 → 2:3 或 9:16，方形 → 1:1。文生图无主图时默认 1:1。

## 七、其他工具
- remove_background：去底/抠图/透明背景 → 优先用它（GPU 精确抠图，失败自动降级重绘）。
- upscale_image：高清/放大/提升分辨率。用户没说倍数先问「2 倍还是 4 倍」。
- vectorize_image：矢量图/SVG/矢量化。若图里有背景纹理或多余元素，先 edit_images 出一版纯色平涂白底干净版，再 vectorize_image（可同轮串行）。矢量化只做描边提取，改颜色要先用 edit_images。
- restyle_lettering：同风格改字（把文字内容换掉、保留字体设计）。
- transfer_material：材质/纹理迁移（需要目标图 + 材质图两张）。
- generate_images：没有主图的纯文生图（新 logo、字标、插画、海报）。Logo/字标类：先给结构级方案（负空间/镜像拼合/单线/几何切割），prompt 必含「扁平矢量、纯色、纯白背景、居中、无渐变无阴影无 3D 无材质」，quality=high、count=3；用户反向词写进 negative_prompt。用户贴了完整英文提示词（含 --ar / --no）时原样保留其约束并翻译进 prompt 与 negative_prompt。
- export_ai：导出 .ai。
- 视频需求：告诉用户去 /video 页面。
- 只要求资料/列举/建议而不出图时，直接文字回答，不调用工具。

## 八、回复风格（严格照做）
- 工具成功后只回 1–3 句：第一句用「已完成 / 已去掉 / 已调整 / 已把 X 换成 Y」开头，说清改了什么、保留了什么；第二句可选，提供一条最相关的可调项（「如需透明底 / 调整弧度 / 改成横版，告诉我即可」）。多张成品时用「款式一 / 款式二…」或「成品：<名称>（<宽×高>）」列出。
- 不输出方案清单、不复述规则、不解释思考过程、不写 Markdown 标题。不要用 emoji 堆砌。
- 只引用工具真实返回的链接，不编造。
- 若画布状态含 brand_kit / design_memory：默认持续生效，体现在 prompt 里，不在回复里复述；只有用户本次明确要求偏离时才覆盖对应规则。`;

const DESIGN_PLAN_SYSTEM_PROMPT = `你是 Youngtuo Visual Studio 的资深创意总监。你的任务是先做可执行的前置设计规划，不调用任何工具，也不输出隐藏思维过程。
你必须结合：最近对话上下文、用户当前请求、画布选中与历史成品、Brand Kit、默认个人设计 Skill、画幅/数量/受众/避免项。
规则：
1. 默认个人设计 Skill 是持续生效的硬约束；用户未重复提及不算取消。只有本次请求明确要求改变某条规则时，才覆盖对应规则。
2. Brand Kit 和品牌专属规则只在当前任务涉及对应品牌时启用，但一旦启用必须严格遵守。
3. 像 ChatGPT 网页一样利用对话上下文理解省略指代、续改要求和已经确认的方向。
4. **Logo/标志设计方案模式**（主交付物是 logo/标志/图标/icon/mark/字母标/品牌标/徽标/商标时；海报/插画里附带小 logo 不算）：
   - decisions 与 summary 必须给出**结构级**图形方案（负空间/镜像拼合/单线/几何切割等），不是情绪形容词。
   - finalPrompt 必含：扁平矢量 logo mark（flat vector logo mark）、纯色单色、负空间、极简几何、光滑干净曲线、大量留白、纯白背景、居中构图。
   - finalPrompt **严禁**材质、纹理、光影、立体、3D、渐变、照片感、装饰花纹、衬线装饰。
   - negativePrompt 写入用户反向词及呆板/复杂装饰等避免项。
5. 非 logo 类任务：像 Lovart 一样先明确构图、风格配色、文字排版、主体细节、材质光影、背景和避免项。
6. finalPrompt 必须是可以直接交给图像模型或编辑工具的完整中文执行指令。所有要出现的文字必须逐字写明，并说明位置和字体气质；未要求文字时明确“画面不出现任何文字或水印”。
7. 只给出简洁的专业设计决策，不解释逐步推理。
8. 仅输出一个 JSON 对象，不要 Markdown、代码围栏或额外文字，字段固定为：
{"title":"14字内方案名","summary":"1-2句目标摘要","action":"generate|edit|restyle_text|material|video|vectorize|export|answer","decisions":["4-6条可见设计决策"],"finalPrompt":"完整执行提示词","negativePrompt":"需要避免的元素与错误"}`;

type DesignPlan = {
  title: string;
  summary: string;
  action: "generate" | "edit" | "restyle_text" | "material" | "video" | "vectorize" | "export" | "answer";
  decisions: string[];
  finalPrompt: string;
  negativePrompt: string;
  imageModelHint?: "gpt-image-2" | "seedream-4-5";
  imageModelConfidence?: number;
  brandCompliant?: boolean | null;
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

/* ---------- Jev (TypeSafe System One) 结构化决策辅助：选生图模型 + 校验 Brand Kit 合规 ----------
   只做判断型任务（Choice/Noul），不做文本生成；失败静默降级，不阻断主流程。 */
type JevChoiceAnswer = { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> };
type JevNoulAnswer = { type: "noul"; noul: number };

async function callJev(state: string, questions: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const apiKey = env.TYPESAFE_API_KEY || "";
  if (!apiKey || !state.trim()) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ state, model: "jev-latest", questions }),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { answers?: Record<string, unknown> };
    return data.answers || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* 只有生图/编辑类 action 才需要选模型和校验合规；answer/video/export 等跳过，省 token。 */
const IMAGE_ACTIONS = new Set<DesignPlan["action"]>(["generate", "edit", "restyle_text", "material"]);

async function enrichPlanWithJev(plan: DesignPlan, brandKit: unknown): Promise<DesignPlan> {
  if (!IMAGE_ACTIONS.has(plan.action) || !plan.finalPrompt) return plan;

  const brandKitRecord = brandKit && typeof brandKit === "object" ? (brandKit as Record<string, unknown>) : {};
  const hasBrandRules = Boolean(
    brandKitRecord.name || (Array.isArray(brandKitRecord.palette) && brandKitRecord.palette.length) || brandKitRecord.styleWords,
  );

  const questions: Record<string, unknown> = {
    image_model: {
      type: "choice",
      instructions: "根据这个设计方案的 finalPrompt，选择最合适的图片生成模型",
      criteria: {
        "gpt-image-2": "适合精确文字渲染、写实质感、logo/图标、产品图、高文字准确度和高保真需求",
        "seedream-4-5": "适合风格化插画、艺术化处理、非写实概念图、绘画感强的视觉风格",
      },
    },
  };
  if (hasBrandRules) {
    questions.brand_compliant = {
      type: "noul",
      instructions: `finalPrompt 是否遵守了品牌规范（品牌信息：${cleanPlanText(JSON.stringify(brandKitRecord), 500)}）`,
    };
  }

  const answers = await callJev(`设计方案 finalPrompt：${plan.finalPrompt}`, questions);
  if (!answers) return plan;

  const modelAnswer = answers.image_model as JevChoiceAnswer | undefined;
  if (modelAnswer?.type === "choice" && (modelAnswer.choice === "gpt-image-2" || modelAnswer.choice === "seedream-4-5")) {
    plan.imageModelHint = modelAnswer.choice;
    plan.imageModelConfidence = modelAnswer.confidence;
  }
  const brandAnswer = answers.brand_compliant as JevNoulAnswer | undefined;
  if (brandAnswer?.type === "noul") {
    plan.brandCompliant = brandAnswer.noul >= 0.6;
  }
  return plan;
}

const IMAGE_INDEX_DESCRIPTION = "图片编号（1 起，对应用户说的 图一/图二…，见画布状态 images 列表）";

const TOOLS = [
  {
    type: "function",
    function: {
      name: "edit_images",
      description:
        "基于主图 + 参考图做编辑（去图案/提取/换装/换色/换画风/路径文字/补全/精修/多角度产品图等）。prompt 必须按系统规则写满四段：图序说明、要改什么、锁定清单、输出规格。成品自动放到画布并成为下一轮的默认主图。",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "写给图像编辑模型的完整中文指令（四段式）" },
          base_image: { type: "number", description: `主图${IMAGE_INDEX_DESCRIPTION}` },
          reference_images: {
            type: "array",
            items: { type: "number" },
            description: "参考图编号列表（按用户编号顺序，不含主图；没有则空数组）",
          },
          aspect: { type: "string", description: "auto（跟随主图，默认）| 1:1 | 3:2 | 2:3 | 16:9 | 9:16" },
          count: { type: "number", description: "张数 1-4，默认 1；「多个/几种/继续」为 4" },
          quality: { type: "string", description: "low | medium | high；编辑默认 medium" },
          transparent_background: { type: "boolean", description: "提取单个物件 / 贴纸素材时 true，输出透明 PNG" },
          model_hint: { type: "string", description: "gpt-image-2 | gpt-image-1.5 | seedream-4-5；仅用户 @ 指定或内容审核拦截后重试时填" },
          output_name: { type: "string", description: "成品名（12 字内，用于画布图层与回复，如「模特换装图」「BONELESS 下半圆路径」）" },
        },
        required: ["prompt", "base_image"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_images",
      description:
        "没有主图时的文生图（新 logo/字标/插画/海报）。prompt 需扩写完整：字样逐字写明、排版、构图；logo 模式用扁平矢量规格词并禁材质光影，quality=high、count=3。可用 reference_images 附风格参考图（仅借气质，不复制结构）。",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "扩写后的完整图像生成 prompt（中文）" },
          aspect: { type: "string", description: "画幅：1:1 | 3:2 | 2:3 | 16:9 | 9:16" },
          count: { type: "number", description: "张数 1-4，默认 1；logo/标志类固定 3" },
          quality: { type: "string", description: "low | medium | high；logo/标志类固定 high" },
          negative_prompt: { type: "string", description: "避免项与负面约束（用户反向词必写）" },
          transparent_background: { type: "boolean", description: "透明背景输出（贴纸/去底素材类可 true；纯白底 logo 标默认 false）" },
          reference_images: { type: "array", items: { type: "number" }, description: "风格参考图编号列表（可空）" },
          model_hint: { type: "string", description: "gpt-image-2 | gpt-image-1.5 | seedream-4-5（可空）" },
          output_name: { type: "string", description: "成品名（12 字内）" },
        },
        required: ["prompt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remove_background",
      description: "精确抠图去底，输出透明 PNG（GPU 抠图，失败自动降级为重绘去底）。用户说 去底/去背景/透明背景/抠出来 时用。",
      parameters: {
        type: "object",
        properties: { image: { type: "number", description: IMAGE_INDEX_DESCRIPTION } },
        required: ["image"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "upscale_image",
      description: "高清放大（提升分辨率与细节，不改内容）。用户说 高清/放大/提高分辨率 时用；倍数不明先问。",
      parameters: {
        type: "object",
        properties: {
          image: { type: "number", description: IMAGE_INDEX_DESCRIPTION },
          scale: { type: "number", description: "2 或 4" },
        },
        required: ["image"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "vectorize_image",
      description: "把位图矢量化为 SVG 并下载 + 落画布。只做描边提取；有背景/纹理时先用 edit_images 出干净白底纯色版再调用。",
      parameters: {
        type: "object",
        properties: { image: { type: "number", description: IMAGE_INDEX_DESCRIPTION } },
        required: ["image"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "restyle_lettering",
      description: "同风格改字：以指定图片为字体设计参考，保持原字体骨架/笔画/质感/颜色，把文字替换为 new_text。",
      parameters: {
        type: "object",
        properties: {
          image: { type: "number", description: IMAGE_INDEX_DESCRIPTION },
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
      description: "材质复刻：把材质图的纹理迁移到目标图案上。需要两张图。",
      parameters: {
        type: "object",
        properties: {
          target_image: { type: "number", description: `目标图案${IMAGE_INDEX_DESCRIPTION}` },
          material_image: { type: "number", description: `材质样本${IMAGE_INDEX_DESCRIPTION}` },
          instruction: { type: "string", description: "补充说明（可选）" },
        },
      },
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

type ContentPart = { type: string; text?: string; image_url?: { url?: string } };

/* Plan mode only reads text; flatten multimodal user content to its text parts. */
function textOfContent(content: unknown) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as ContentPart[])
      .map((part) => (part && part.type === "text" ? String(part.text || "") : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/* Vision tokens are the main cost: keep image parts only for the most recent user turns. */
const VISION_TURNS_KEPT = Number(env.AGENT_VISION_TURNS || "3");

function trimVisionHistory(history: unknown[]) {
  let userTurnsSeen = 0;
  const output: unknown[] = [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item = history[index];
    if (!item || typeof item !== "object") continue;
    const message = item as { role?: unknown; content?: unknown };
    if (message.role === "user" && Array.isArray(message.content)) {
      userTurnsSeen += 1;
      if (userTurnsSeen > VISION_TURNS_KEPT) {
        const parts = message.content as ContentPart[];
        const imageCount = parts.filter((part) => part?.type === "image_url").length;
        const text = textOfContent(parts);
        output.unshift({ role: "user", content: imageCount ? `${text}\n（本轮附带 ${imageCount} 张图片，已省略）` : text });
        continue;
      }
    }
    output.unshift(item);
  }
  return output;
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
          if (role !== "user" && role !== "assistant") return [];
          const content = textOfContent(message.content).trim();
          if (!content) return [];
          return [{ role, content }];
        })
        .slice(-24)
    : trimVisionHistory(history.slice(-30));
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
          let plan = parseDesignPlan(content, cleanPlanText(textOfContent(fallbackBrief?.content), 12000));
          plan = await enrichPlanWithJev(plan, (payload.canvas_state as Record<string, unknown> | undefined)?.brand_kit);
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
