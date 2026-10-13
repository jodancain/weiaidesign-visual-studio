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
  const image2 = path[0] === 'image2';
  const configured = image2 ? process.env.IMAGE2_API_URL : process.env.STUDIO_GATEWAY_URL || process.env.VIDEO_API_PROXY_BASE_URL;
  const token = image2 ? process.env.IMAGE2_API_TOKEN : process.env.VIDEO_API_PROXY_TOKEN || process.env.VIDEO_API_TOKEN;
  if (!configured || (image2 && !token)) return Response.json({ detail: image2 ? '图片工作台服务尚未配置' : '视频工作台服务尚未配置（STUDIO_GATEWAY_URL）' }, { status: 503 });
  let base: string;
  if (image2) {
    try {
      const origin = new URL(configured);
      if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('invalid origin');
      base = origin.origin;
    } catch { return Response.json({ detail: '图片工作台服务地址配置无效' }, { status: 503 }); }
  } else base = configured.replace(/\/api\/v[13]\/?$/, '').replace(/\/$/, '');
  const incoming = new URL(request.url);
  const headers = new Headers();
  for (const name of ['content-type', 'range', 'if-none-match']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (token) headers.set('authorization', `Bearer ${token}`);
  // Never forward an identity supplied by JavaScript. Only the signed HttpOnly cookie is trusted.
  headers.set('x-studio-visitor-id', visitor.id);
  try {
    const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer();
    if (image2 && body && body.byteLength > 96 * 1024 * 1024) return Response.json({ detail: '上传内容超过96MB上限' }, { status: 413 });
    const fetchUpstream = () => fetch(`${base}/api/v3/${path.map(encodeURIComponent).join('/')}${incoming.search}`, {
      method: request.method, headers,
      body,
      cache: 'no-store', signal: AbortSignal.timeout(180_000),
    });
    let upstream: Response;
    try { upstream = await fetchUpstream(); }
    catch (error) {
      // A stale connection may fail a read before headers arrive. Retry only the same read;
      // mutations use the client's frozen receipt ledger and are never replayed by the BFF.
      if (!image2 || !['GET', 'HEAD'].includes(request.method) || ['AbortError', 'TimeoutError'].includes((error as Error).name)) throw error;
      upstream = await fetchUpstream();
    }
    const outputHeaders = new Headers();
    for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'content-disposition', 'etag']) {
      const value = upstream.headers.get(name);
      if (value) outputHeaders.set(name, value);
    }
    // Keep the image service's SVG sandbox on direct asset reads as well as previews.
    if (image2) {
      const policy = upstream.headers.get('content-security-policy');
      if (policy) outputHeaders.set('content-security-policy', policy);
    }
    outputHeaders.set('cache-control', 'no-store');
    outputHeaders.set('x-content-type-options', 'nosniff');
    if (!visitor.existing) outputHeaders.set('set-cookie', visitor.cookie);
    return new Response(request.method === 'HEAD' ? null : upstream.body, { status: upstream.status, headers: outputHeaders });
  } catch {
    return Response.json({ detail: image2 ? '图片工作台暂时连接失败；已提交任务会保留，请稍后恢复。' : '视频工作台服务连接失败，请检查服务状态后重试。' }, { status: 502 });
  }
}
export const GET = forward;
export const POST = forward;
export const PUT = forward;
export const DELETE = forward;
export const HEAD = forward;
