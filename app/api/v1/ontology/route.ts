import { jsonCors, optionsResponse, requireVideoToken } from "../_lib/visual-api";
import { BLENDER_WORKER_URL, draftOntology, listBlenderModels, listOntologies, saveOntology, startAnchorJob, type Aspect, type Audience } from "../_lib/ontology";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* POST { brief, audience?, aspect_ratio?, model?, auto_anchors?, render_backend?, draft? } → drafted ontology (LLM, or `draft` = pre-authored ontology JSON passed through the same gates; anchors start when auto_anchors !== false) */
export async function POST(request: Request) {
  const authError = requireVideoToken(request);
  if (authError) return authError;
  let payload: Record<string, unknown>;
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonCors({ detail: "invalid JSON body" }, { status: 400 });
  }
  const brief = String(payload.brief || payload.prompt || "").trim();
  if (brief.length < 8) return jsonCors({ detail: "brief is required (>= 8 chars)" }, { status: 400 });
  const audience = (["owner", "showroom", "accessory"].includes(String(payload.audience)) ? String(payload.audience) : "showroom") as Audience;
  const aspect_ratio = (["16:9", "9:16", "1:1"].includes(String(payload.aspect_ratio || payload.aspect)) ? String(payload.aspect_ratio || payload.aspect) : "16:9") as Aspect;
  try {
    const render_backend = payload.render_backend === "blender" ? "blender" : "image";
    const ontology = await draftOntology({ brief: brief.slice(0, 4000), audience, aspect_ratio, model: String(payload.model || ""), render_backend, ...(payload.draft && typeof payload.draft === "object" ? { draft: payload.draft } : {}) });
    await saveOntology(ontology);
    const autoAnchors = payload.auto_anchors !== false;
    if (autoAnchors) startAnchorJob(ontology, request);
    const apiBase = (process.env.PUBLIC_BASE_URL || `${new URL(request.url).origin}/api/v1`).replace(/\/+$/, "");
    return jsonCors({
      status: 201,
      message: "drafted",
      data: {
        id: ontology.id,
        state: ontology.state,
        title: ontology.title,
        objects: ontology.objects.length,
        links: ontology.links.length,
        anchors: ontology.anchors.length,
        shots: ontology.shots.length,
        errors: ontology.errors,
        review_url: `${apiBase}/ontology/${ontology.id}/review`,
        json_url: `${apiBase}/ontology/${ontology.id}`,
        anchors_started: autoAnchors,
        render_backend: ontology.render_backend,
        blender_states: ontology.blender?.states.length ?? 0,
        blender_anchors: ontology.anchors.filter((a) => a.render).length,
      },
    }, { status: 201 });
  } catch (error) {
    return jsonCors({ detail: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
}

export async function GET(request: Request) {
  const authError = requireVideoToken(request);
  if (authError) return authError;
  return jsonCors({ status: 200, data: { items: await listOntologies(), blender: { available: Boolean(BLENDER_WORKER_URL), models: BLENDER_WORKER_URL ? await listBlenderModels() : [] } } });
}

export async function OPTIONS() {
  return optionsResponse();
}
