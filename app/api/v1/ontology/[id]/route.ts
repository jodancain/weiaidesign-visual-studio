import { jsonCors, optionsResponse, requireVideoToken } from "../../_lib/visual-api";
import { applyReview, loadOntology, refreshShotVideos, saveOntology } from "../../_lib/ontology";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(request: Request, ctx: Ctx) {
  const authError = requireVideoToken(request);
  if (authError) return authError;
  const { id } = await ctx.params;
  const o = await loadOntology(id);
  if (!o) return jsonCors({ detail: "ontology not found" }, { status: 404 });
  await refreshShotVideos(o);
  return jsonCors({ status: 200, data: o });
}

/* PATCH { anchors: {id: "approved"|"rejected"|{status,feedback}}, shots: {id: {status,caption,motion_prompt}}, notes, reviewer } */
export async function PATCH(request: Request, ctx: Ctx) {
  const authError = requireVideoToken(request);
  if (authError) return authError;
  const { id } = await ctx.params;
  const o = await loadOntology(id);
  if (!o) return jsonCors({ detail: "ontology not found" }, { status: 404 });
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonCors({ detail: "invalid JSON body" }, { status: 400 });
  }
  applyReview(o, body);
  await saveOntology(o);
  return jsonCors({ status: 200, data: { id: o.id, state: o.state, approved_anchors: o.anchors.filter((a) => a.status === "approved").length, approved_shots: o.shots.filter((s) => s.status === "approved").length } });
}

export async function OPTIONS() {
  return optionsResponse();
}
