import { createStandaloneImages, jsonCors, optionsResponse, requireVideoToken, startAsyncImageJob } from "../_lib/visual-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Reve-style material copy:
// the client composites the TARGET design and a MATERIAL swatch into one
// reference image (swatch strip on the right edge), then this endpoint asks the
// image model to re-render the target with its surfaces made of that material.
export async function POST(request: Request) {
  const authError = requireVideoToken(request);
  if (authError) return authError;

  let payload: Record<string, unknown>;
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonCors({ detail: "invalid JSON body" }, { status: 400 });
  }

  const hasReference =
    Boolean(payload.image_b64) ||
    (Array.isArray(payload.reference_images) && payload.reference_images.length > 0);
  if (!hasReference) {
    return jsonCors({ detail: "image_b64 or reference_images is required" }, { status: 400 });
  }

  const instruction = String(payload.instruction || payload.prompt || "").trim();
  const swatchPosition = String(payload.swatch_position || "right").trim() || "right";
  const rawPrompt = [
    `The reference image has two parts: the main area is the TARGET design/pattern, and the ${swatchPosition} strip is a MATERIAL swatch.`,
    "Recreate the TARGET design so that its surfaces are made of the provided material:",
    "transfer the material's texture, color, sheen, grain/weave and lighting response onto the target's shapes.",
    "Preserve the target's silhouette, composition, proportions and layout exactly.",
    "Render the material realistically with correct highlights and shadows.",
    `Output ONLY the re-materialized target artwork. Do not include the ${swatchPosition} swatch strip, labels, borders or dividers in the output.`,
    instruction ? `Extra direction: ${instruction}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const buildPayload = {
    ...payload,
    prompt: `material-transfer${instruction ? `: ${instruction}` : ""}`,
    raw_prompt: rawPrompt,
    n: Math.max(1, Math.min(4, Number(payload.n || payload.count || 1))),
  };
  if (payload.async === true || payload.async === "true" || payload.async === 1) {
    const jobId = startAsyncImageJob(async () => {
      const data = await createStandaloneImages(buildPayload, request);
      return { ...data, kind: "material-transfer" };
    });
    return jsonCors({ status: 200, message: "accepted", data: { job_id: jobId } });
  }
  try {
    const data = await createStandaloneImages(buildPayload, request);
    return jsonCors({ status: 200, message: "success", data: { ...data, kind: "material-transfer" } });
  } catch (error) {
    return jsonCors({ detail: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
