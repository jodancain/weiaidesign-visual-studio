/* Shared OpenAI-compatible chat helpers: primary AGENT_LLM_* router, IMAGE_OPENAI_* relay as fallback. */

const env = process.env;

export type ChatUpstream = { base: string; key: string; models: string[] };

export function chatUpstreams(): ChatUpstream[] {
  const list: ChatUpstream[] = [];
  const agentBase = (env.AGENT_LLM_BASE_URL || "").replace(/\/+$/, "");
  const agentKey = env.AGENT_LLM_API_KEY || "";
  const agentModels = (env.AGENT_LLM_MODELS || "claude-sonnet-5,gpt-5.5,kimi-k2.7-code")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (agentBase && agentKey && agentModels.length) list.push({ base: agentBase, key: agentKey, models: agentModels });
  const relayBase = (env.IMAGE_OPENAI_BASE_URL || "").replace(/\/+$/, "");
  const relayKey = env.IMAGE_OPENAI_API_KEY || env.OPENAI_API_KEY || "";
  if (relayBase && relayKey) {
    /* The image relay (ezr.sh) hosts the same chat models; when the agent key is bad or missing,
       keep the vision-capable planners before dropping to the small default model. */
    const relayModels = relayBase === agentBase
      ? Array.from(new Set([...agentModels, env.AGENT_LLM_MODEL || "gpt-5.4-mini"]))
      : [env.AGENT_LLM_MODEL || "gpt-5.4-mini"];
    list.push({ base: relayBase, key: relayKey, models: relayModels });
  }
  return list;
}

export function extractJsonObject(raw: string): Record<string, unknown> {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("model returned no JSON object");
  return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
}

/* Ask for a single JSON object; walks every upstream/model until one parses. */
export async function chatJson(params: {
  system: string;
  user: string;
  preferredModel?: string;
  timeoutMs?: number;
  maxTokens?: number;
}): Promise<{ value: Record<string, unknown>; model: string; fallbacks: string[] }> {
  const upstreams = chatUpstreams();
  if (!upstreams.length) throw new Error("agent LLM is not configured (AGENT_LLM_* / IMAGE_OPENAI_*)");
  const preferred = (params.preferredModel || "").trim();
  const errors: string[] = [];
  for (const upstream of upstreams) {
    const models = preferred && upstream.models.includes(preferred)
      ? [preferred, ...upstream.models.filter((m) => m !== preferred)]
      : upstream.models;
    for (const model of models) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), params.timeoutMs || 90000);
      try {
        const response = await fetch(`${upstream.base}/chat/completions`, {
          method: "POST",
          headers: { authorization: `Bearer ${upstream.key}`, "content-type": "application/json" },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: params.system },
              { role: "user", content: params.user },
            ],
            ...(params.maxTokens ? { max_tokens: params.maxTokens } : {}),
          }),
          signal: controller.signal,
        });
        const text = await response.text();
        if (!response.ok) {
          errors.push(`${model}: HTTP ${response.status} ${text.slice(0, 120)}`);
          continue;
        }
        const data = JSON.parse(text) as { choices?: Array<{ message?: { content?: unknown } }> };
        const content = data.choices?.[0]?.message?.content;
        const contentText = typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content.map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text?: unknown }).text || "") : "")).join("")
            : "";
        if (!contentText.trim()) {
          errors.push(`${model}: empty content`);
          continue;
        }
        return { value: extractJsonObject(contentText), model, fallbacks: errors };
      } catch (error) {
        errors.push(`${model}: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        clearTimeout(timer);
      }
    }
  }
  throw new Error(`all agent models failed: ${errors.join(" | ").slice(0, 600)}`);
}
