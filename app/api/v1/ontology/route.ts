import { jsonCors, optionsResponse, requireVideoToken } from "../_lib/visual-api";
import { draftOntology, listOntologies, saveOntology, startAnchorJob, type Aspect, type Audience } from "../_lib/ontology";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* POST { brief, audience?, aspect_ratio?, model?, auto_anchors? } → drafted ontology (LLM only; anchors start when auto_anchors !== false) */
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
    const ontology = await draftOntology({ brief: brief.slice(0, 4000), audience, aspect_ratio, model: String(payload.model || "") });
    await saveOntology(ontology);
    const autoAnchors = payload.auto_anchors !== false;
    if (autoAnchors) startAnchorJob(ontology, request);
    const origin = new URL(request.url).origin;
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
        review_url: `${origin}/api/v1/ontology/${ontology.id}/review`,
        json_url: `${origin}/api/v1/ontology/${ontology.id}`,
        anchors_started: autoAnchors,
      },
    }, { status: 201 });
  } catch (error) {
    return jsonCors({ detail: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
}

export async function GET(request: Request) {
  const authError = requireVideoToken(request);
  if (authError) return authError;
  return jsonCors({ status: 200, data: { items: await listOntologies() } });
}

export async function OPTIONS() {
  return optionsResponse();
}
