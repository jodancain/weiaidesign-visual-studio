import { jsonCors, optionsResponse, requireVideoToken } from "../../../_lib/visual-api";
import { loadOntology, startAnchorJob } from "../../../_lib/ontology";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/* POST { anchor_ids?: string[] } → start (re)generation; without ids, all pending/failed anchors */
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
  const only = Array.isArray(body.anchor_ids) ? body.anchor_ids.map(String).filter((x) => o.anchors.some((a) => a.id === x)) : undefined;
  if (only && !only.length) return jsonCors({ detail: "no matching anchor_ids" }, { status: 400 });
  const started = startAnchorJob(o, request, only);
  if (!started) return jsonCors({ detail: "an anchor job is already running for this ontology" }, { status: 409 });
  return jsonCors({ status: 202, data: { id: o.id, targets: only || o.anchors.filter((a) => a.status === "pending" || a.status === "failed").map((a) => a.id) } }, { status: 202 });
}

export async function OPTIONS() {
  return optionsResponse();
}
