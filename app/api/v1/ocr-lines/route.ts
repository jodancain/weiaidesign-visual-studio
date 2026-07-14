import { jsonCors, optionsResponse, requireVideoToken } from "../_lib/visual-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const env = process.env;

// Detect the text lines inside a lettering/design image via the relay's
// vision-capable chat model, so the client can offer per-line editing
// (Lovart "Edit Text" style). Falls back gracefully client-side when the
// model lacks vision support.
export async function POST(request: Request) {
  const authError = requireVideoToken(request);
  if (authError) return authError;

  const baseURL = (env.IMAGE_OPENAI_BASE_URL || "").replace(/\/+$/, "");
  const apiKey = env.IMAGE_OPENAI_API_KEY || env.OPENAI_API_KEY || "";
  if (!baseURL || !apiKey) return jsonCors({ detail: "vision LLM is not configured" }, { status: 503 });

  let payload: { image_b64?: string };
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return jsonCors({ detail: "invalid JSON body" }, { status: 400 });
  }
  const image = String(payload.image_b64 || "");
  if (!image.startsWith("data:image/")) return jsonCors({ detail: "image_b64 (data URL) is required" }, { status: 400 });

  const model = env.VISION_LLM_MODEL || env.AGENT_LLM_MODEL || "gpt-5.4-mini";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const upstream = await fetch(`${baseURL}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: '识别这张设计图里的所有文字，按视觉行（从上到下）拆分，每行一个字符串。只输出 JSON 数组，例如 ["99.9%","angel","(nobody\'s perfect)"]。不要输出任何其他内容。',
              },
              { type: "image_url", image_url: { url: image } },
            ],
          },
        ],
        temperature: 0,
      }),
      signal: controller.signal,
    });
    const text = await upstream.text();
    if (!upstream.ok) return jsonCors({ detail: `vision llm error ${upstream.status}: ${text.slice(0, 300)}` }, { status: 502 });
    const data = JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }> };
    const content = String(data.choices?.[0]?.message?.content || "");
    const match = content.match(/\[[\s\S]*\]/);
    if (!match) return jsonCors({ detail: `no JSON array in response: ${content.slice(0, 200)}` }, { status: 502 });
    const lines = (JSON.parse(match[0]) as unknown[]).map((item) => String(item)).filter((item) => item.trim());
    return jsonCors({ status: 200, message: "success", data: { lines, model } });
  } catch (error) {
    return jsonCors({ detail: error instanceof Error ? error.message : String(error) }, { status: 502 });
  } finally {
    clearTimeout(timer);
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
