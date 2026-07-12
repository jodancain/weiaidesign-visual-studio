import { optionsResponse, serveGeneratedImage } from "../../../_lib/visual-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{
    imageId: string;
    filename: string;
  }>;
};

export async function GET(_request: Request, context: RouteContext) {
  const params = await context.params;
  return serveGeneratedImage(params.imageId, params.filename, "GET");
}

export async function HEAD(_request: Request, context: RouteContext) {
  const params = await context.params;
  return serveGeneratedImage(params.imageId, params.filename, "HEAD");
}

export async function OPTIONS() {
  return optionsResponse();
}
