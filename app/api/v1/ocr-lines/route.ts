import { jsonCors, optionsResponse, requireVideoToken } from "../_lib/visual-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const env = process.env;

type OcrLine = { text: string; box?: [number, number, number, number] };

function clamp1000(n: number) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1000, Math.round(n)));
}

/** Parse vision model output: prefer [{text, box}], fall back to plain string[]. */
function parseOcrLines(raw: unknown[]): OcrLine[] {
  const lines: OcrLine[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      const text = item.trim();
      if (text) lines.push({ text });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const record = item as { text?: unknown; box?: unknown; bbox?: unknown };
    const text = String(record.text ?? "").trim();
    if (!text) continue;
    const boxRaw = Array.isArray(record.box) ? record.box : Array.isArray(record.bbox) ? record.bbox : null;
    if (boxRaw && boxRaw.length >= 4) {
      const box: [number, number, number, number] = [
        clamp1000(Number(boxRaw[0])),
        clamp1000(Number(boxRaw[1])),
        clamp1000(Number(boxRaw[2])),
        clamp1000(Number(boxRaw[3])),
      ];
      // Ensure x0<=x1, y0<=y1
      if (box[0] > box[2]) [box[0], box[2]] = [box[2], box[0]];
      if (box[1] > box[3]) [box[1], box[3]] = [box[3], box[1]];
      lines.push({ text, box });
    } else {
      lines.push({ text });
    }
  }
  return lines;
}

// Detect the text lines inside a lettering/design image via the relay's
// vision-capable chat model, so the client can offer per-line editing
// (Lovart "Edit Text" style). Returns optional normalized bboxes for
// mask-local font restyle. Falls back to plain string lines when needed.
export async function POST(request: Request) {
  const authError = requireVideoToken(request);
  if (authError) return authError;

  const upstreams: Array<{ base: string; key: string; model: string }> = [];
  const agentBase = (env.AGENT_LLM_BASE_URL || "").replace(/\/+$/, "");
  const agentKey = env.AGENT_LLM_API_KEY || "";
  if (agentBase && agentKey) upstreams.push({ base: agentBase, key: agentKey, model: env.VISION_LLM_MODEL || "cbcn/glm-5v-turbo" });
  const relayBase = (env.IMAGE_OPENAI_BASE_URL || "").replace(/\/+$/, "");
  const relayKey = env.IMAGE_OPENAI_API_KEY || env.OPENAI_API_KEY || "";
  if (relayBase && relayKey) upstreams.push({ base: relayBase, key: relayKey, model: env.AGENT_LLM_MODEL || "gpt-5.4-mini" });
  if (!upstreams.length) return jsonCors({ detail: "vision LLM is not configured" }, { status: 503 });

  let payload: { image_b64?: string };
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return jsonCors({ detail: "invalid JSON body" }, { status: 400 });
  }
  const image = String(payload.image_b64 || "");
  if (!image.startsWith("data:image/")) return jsonCors({ detail: "image_b64 (data URL) is required" }, { status: 400 });

  const ocrPrompt = [
    "识别这张设计图里的所有文字，按视觉行（从上到下）拆分。",
    "只输出 JSON 数组，每项为对象：{\"text\":\"该行文字\",\"box\":[x0,y0,x1,y1]}。",
    "box 为该行文字的轴对齐包围盒，坐标归一化到 0–1000（相对整图宽高，左上为原点，x0<x1，y0<y1）。",
    "示例：[{\"text\":\"SLOW DOWN\",\"box\":[120,280,880,420]},{\"text\":\"Enjoy Life!\",\"box\":[200,480,800,620]}]。",
    "不要输出任何其他内容。若无法给出坐标，可退回纯字符串数组 [\"行1\",\"行2\"]。",
  ].join("");

  const errors: string[] = [];
  for (const upstream of upstreams) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    try {
      const response = await fetch(`${upstream.base}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${upstream.key}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: upstream.model,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: ocrPrompt },
                { type: "image_url", image_url: { url: image } },
              ],
            },
          ],
          temperature: 0,
        }),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        errors.push(`${upstream.model}: HTTP ${response.status} ${text.slice(0, 120)}`);
        continue;
      }
      const data = JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }> };
      const content = String(data.choices?.[0]?.message?.content || "");
      const match = content.match(/\[[\s\S]*\]/);
      if (!match) {
        errors.push(`${upstream.model}: no JSON array`);
        continue;
      }
      let parsed: unknown[];
      try {
        parsed = JSON.parse(match[0]) as unknown[];
      } catch {
        errors.push(`${upstream.model}: invalid JSON array`);
        continue;
      }
      if (!Array.isArray(parsed)) {
        errors.push(`${upstream.model}: not an array`);
        continue;
      }
      const ocrLines = parseOcrLines(parsed);
      if (!ocrLines.length) {
        errors.push(`${upstream.model}: empty lines`);
        continue;
      }
      // Back-compat: lines is string[]; line_boxes carries optional bboxes
      const lines = ocrLines.map((item) => item.text);
      const line_boxes = ocrLines.map((item) =>
        item.box ? { text: item.text, box: item.box } : { text: item.text },
      );
      return jsonCors({
        status: 200,
        message: "success",
        data: { lines, line_boxes, model: upstream.model },
      });
    } catch (error) {
      errors.push(`${upstream.model}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timer);
    }
  }
  return jsonCors({ detail: `all vision models failed: ${errors.join(" | ").slice(0, 400)}` }, { status: 502 });
}

export async function OPTIONS() {
  return optionsResponse();
}
