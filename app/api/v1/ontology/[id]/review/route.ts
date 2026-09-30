import { loadOntology, refreshShotVideos, renderReviewHtml } from "../../../_lib/ontology";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/* Standalone review page: objects + anchor images, link graph, shots; buttons call the JSON API. */
export async function GET(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const o = await loadOntology(id);
  if (!o) return new Response("ontology not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  await refreshShotVideos(o);
  const apiBase = (process.env.PUBLIC_BASE_URL || `${new URL(request.url).origin}/api/v1`).replace(/\/+$/, "");
  return new Response(renderReviewHtml(o, apiBase), {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" },
  });
}
