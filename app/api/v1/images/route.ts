import { createStandaloneImages, jsonCors, optionsResponse, requireVideoToken, startAsyncImageJob } from "../_lib/visual-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const authError = requireVideoToken(request);
  if (authError) return authError;

  let payload: Record<string, unknown>;
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonCors({ detail: "invalid JSON body" }, { status: 400 });
  }

  if (payload.async === true || payload.async === "true" || payload.async === 1) {
    const jobId = startAsyncImageJob(() => createStandaloneImages(payload, request));
    return jsonCors({ status: 200, message: "accepted", data: { job_id: jobId } });
  }
  try {
    const data = await createStandaloneImages(payload, request);
    return jsonCors({ status: 200, message: "success", data });
  } catch (error) {
    return jsonCors({ detail: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
