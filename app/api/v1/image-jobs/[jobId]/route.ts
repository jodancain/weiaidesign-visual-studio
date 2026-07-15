import { jsonCors, optionsResponse, readAsyncImageJob, requireVideoToken } from "../../_lib/visual-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const authError = requireVideoToken(request);
  if (authError) return authError;
  const { jobId } = await context.params;
  const job = await readAsyncImageJob(jobId);
  if (!job) return jsonCors({ detail: "job not found" }, { status: 404 });
  return jsonCors({ status: 200, message: "success", data: job });
}

export async function OPTIONS() {
  return optionsResponse();
}
