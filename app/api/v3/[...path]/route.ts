import { requireStudioSameOrigin } from '../_access';
import { studioVisitor } from '../_visitor';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function forward(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const denied = requireStudioSameOrigin(request);
  if (denied) return denied;
  if (request.headers.get('sec-fetch-site') === 'cross-site') return Response.json({ detail: '请在本站打开视频工作台' }, { status: 403 });
  let visitor: ReturnType<typeof studioVisitor>;
  try { visitor = studioVisitor(request); }
  catch (error) { return Response.json({ detail: (error as Error).message }, { status: 503 }); }
  const { path } = await context.params;
  if (path.some(part => !part || part === '..' || part.includes('/') || part.includes('\\'))) {
    return Response.json({ detail: 'invalid route' }, { status: 400 });
  }
  const configured = process.env.STUDIO_GATEWAY_URL || process.env.VIDEO_API_PROXY_BASE_URL;
  if (!configured) return Response.json({ detail: '视频工作台服务尚未配置（STUDIO_GATEWAY_URL）' }, { status: 503 });
  const base = configured.replace(/\/api\/v[13]\/?$/, '').replace(/\/$/, '');
  const incoming = new URL(request.url);
  const headers = new Headers();
  for (const name of ['content-type', 'range', 'if-none-match']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const token = process.env.VIDEO_API_PROXY_TOKEN || process.env.VIDEO_API_TOKEN;
  if (token) headers.set('authorization', `Bearer ${token}`);
  // Never forward an identity supplied by JavaScript. Only the signed HttpOnly cookie is trusted.
  headers.set('x-studio-visitor-id', visitor.id);
  try {
    const upstream = await fetch(`${base}/api/v3/${path.map(encodeURIComponent).join('/')}${incoming.search}`, {
      method: request.method, headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer(),
      cache: 'no-store', signal: AbortSignal.timeout(180_000),
    });
    const outputHeaders = new Headers();
    for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'content-disposition', 'etag']) {
      const value = upstream.headers.get(name);
      if (value) outputHeaders.set(name, value);
    }
    outputHeaders.set('cache-control', 'no-store');
    outputHeaders.set('x-content-type-options', 'nosniff');
    if (!visitor.existing) outputHeaders.set('set-cookie', visitor.cookie);
    return new Response(request.method === 'HEAD' ? null : upstream.body, { status: upstream.status, headers: outputHeaders });
  } catch {
    return Response.json({ detail: '视频工作台服务连接失败，请检查服务状态后重试。' }, { status: 502 });
  }
}
export const GET = forward;
export const POST = forward;
export const PUT = forward;
export const DELETE = forward;
export const HEAD = forward;
