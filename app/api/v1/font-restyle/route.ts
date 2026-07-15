import { createStandaloneImages, jsonCors, optionsResponse, requireVideoToken, startAsyncImageJob } from "../_lib/visual-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Style-matched lettering replacement:
// takes one reference image that contains designed lettering/typography and a
// `new_text` string, then re-renders the same type design with the new text.
export async function POST(request: Request) {
  const authError = requireVideoToken(request);
  if (authError) return authError;

  let payload: Record<string, unknown>;
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonCors({ detail: "invalid JSON body" }, { status: 400 });
  }

  const lineEdits = (Array.isArray(payload.line_edits) ? payload.line_edits : [])
    .map((item) => {
      const record = item as { from?: unknown; to?: unknown };
      return { from: String(record.from || "").trim(), to: String(record.to || "").trim() };
    })
    .filter((item) => item.from && item.to && item.from !== item.to);
  const newText = String(payload.new_text || payload.text || "").trim() || lineEdits.map((item) => item.to).join(" / ");
  if (!newText && !lineEdits.length) return jsonCors({ detail: "new_text or line_edits is required" }, { status: 400 });
  const hasReference =
    Boolean(payload.image_b64) ||
    (Array.isArray(payload.reference_images) && payload.reference_images.length > 0);
  if (!hasReference) {
    return jsonCors({ detail: "image_b64 or reference_images is required" }, { status: 400 });
  }

  const styleNote = String(payload.style_note || payload.note || "").trim();
  const replacementDirective = lineEdits.length
    ? `只替换下列文字行，其余每一行文字逐字保持原样：${lineEdits
        .map((item) => `「${item.from}」改为「${item.to}」`)
        .join("；")}。`
    : `把图中的文字内容替换为：「${newText}」。`;
  const rawPrompt = [
    "这是对同一张图片的编辑任务，不是重新创作。图中包含定制设计的美术字/字体设计。",
    replacementDirective,
    "新文字必须逐笔画沿用原字体设计，以下全部保持与原图一致：",
    "字体骨架与字形比例、笔画粗细与边缘处理、衬线与笔锋、材质与纹理、",
    "立体感与描边、投影与高光、颜色与渐变、透视角度、排版位置与字距节奏。",
    "背景的每个像素、装饰元素、未提及的文字行全部保持原样，不得改变构图与配色。",
    "不得添加水印、多余文字或新元素。",
    styleNote ? `补充要求：${styleNote}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const buildPayload = {
    quality: ["low", "medium", "high"].includes(String(payload.quality || "").toLowerCase())
      ? String(payload.quality).toLowerCase()
      : "high",
        ...payload,
        prompt: `font-restyle: ${newText}`,
        raw_prompt: rawPrompt,
        n: Math.max(1, Math.min(4, Number(payload.n || payload.count || 1))),
      };
  if (payload.async === true || payload.async === "true" || payload.async === 1) {
    const jobId = startAsyncImageJob(async () => {
      const data = await createStandaloneImages(buildPayload, request);
      return { ...data, kind: "font-restyle", new_text: newText };
    });
    return jsonCors({ status: 200, message: "accepted", data: { job_id: jobId } });
  }
  try {
    const data = await createStandaloneImages(buildPayload, request);
    return jsonCors({ status: 200, message: "success", data: { ...data, kind: "font-restyle", new_text: newText } });
  } catch (error) {
    return jsonCors({ detail: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
