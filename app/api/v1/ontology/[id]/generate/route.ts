import { jsonCors, optionsResponse, requireVideoToken } from "../../../_lib/visual-api";
import { loadOntology, submitShotVideos } from "../../../_lib/ontology";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/* POST { shot_ids?: string[] } → submit approved shots (two approved anchors) to the video gateway as first/last keyframe jobs */
export async function POST(request: Request, ctx: Ctx) {
  const authError = requireVideoToken(request);
  if (authError) return authError;
  const { id } = await ctx.params;
  const o = await loadOntology(id);
  if (!o) return jsonCors({ detail: "ontology not found" }, { status: 404 });
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    /* empty body is fine */
  }
  const shotIds = Array.isArray(body.shot_ids) ? body.shot_ids.map(String) : undefined;
  try {
    const submitted = await submitShotVideos(o, shotIds);
    return jsonCors({ status: 202, data: { id: o.id, state: o.state, submitted: submitted.filter((s) => s.status === "queued").length, shots: submitted.map((s) => ({ id: s.id, status: s.status, video_job_id: s.video_job_id, error: s.error })) } }, { status: 202 });
  } catch (error) {
    return jsonCors({ detail: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
