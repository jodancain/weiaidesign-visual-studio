import { requireVideoToken } from '../../v1/_lib/visual-api';
import { createStudioSession, requireStudioSameOrigin } from '../_access';
import { studioVisitor } from '../_visitor';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Public workspace bootstrap. No installation code or account is requested. */
export async function GET(request: Request) {
  const denied = requireStudioSameOrigin(request);
  if (denied) return denied;
  if (request.headers.get('sec-fetch-site') === 'cross-site') return Response.json({ detail: '请在本站打开视频工作台' }, { status: 403 });
  try {
    const visitor = studioVisitor(request);
    return Response.json({ data: { anonymous: true, expiresAt: visitor.expiresAt } }, { headers: { 'set-cookie': visitor.cookie, 'cache-control': 'no-store' } });
  } catch (error) { return Response.json({ detail: (error as Error).message }, { status: 503, headers: { 'cache-control': 'no-store' } }); }
}

export async function POST(request: Request) {
  const originDenied = requireStudioSameOrigin(request);
  if (originDenied) return originDenied;
  let input: unknown;
  try { input = await request.json(); } catch { return Response.json({ detail: '请输入安装访问码' }, { status: 400 }); }
  const token = input && typeof input === 'object' && 'token' in input ? (input as { token?: unknown }).token : null;
  if (typeof token !== 'string' || !token || token.length > 8192 || /[^\x20-\x7e]/.test(token)) return Response.json({ detail: '请输入有效的安装访问码' }, { status: 400 });
  const denied = requireVideoToken(new Request(request.url, { headers: { authorization: `Bearer ${token}` } }));
  if (denied) return Response.json({ detail: denied.status === 401 ? '访问码不正确，请重试。' : '安装访问门禁尚未配置完成。' }, { status: denied.status, headers: { 'cache-control': 'no-store' } });
  if (process.env.REQUIRE_ACCESS_TOKEN !== '1') return Response.json({ data: { authenticated: true, expiresAt: null } }, { headers: { 'cache-control': 'no-store' } });
  const session = createStudioSession(request);
  return Response.json({ data: { authenticated: true, expiresAt: session.expiresAt } }, { headers: { 'set-cookie': session.cookie, 'cache-control': 'no-store' } });
}
