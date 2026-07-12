import { optionsResponse, proxyLegacyApi, requireVideoToken } from "../../_lib/visual-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{
    jobId: string;
  }>;
};

export async function GET(request: Request, context: RouteContext) {
  const authError = requireVideoToken(request);
  if (authError) return authError;
  const params = await context.params;
  const url = new URL(request.url);
  return proxyLegacyApi(request, `/image-videos/${encodeURIComponent(params.jobId)}${url.search}`);
}

export async function OPTIONS() {
  return optionsResponse();
}
