import { optionsResponse, proxyLegacyApi, requireVideoToken } from "../_lib/visual-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const authError = requireVideoToken(request);
  if (authError) return authError;
  const url = new URL(request.url);
  return proxyLegacyApi(request, `/image-videos${url.search}`);
}

export async function OPTIONS() {
  return optionsResponse();
}
