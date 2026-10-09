import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { requireVideoToken } from '../v1/_lib/visual-api';

export const STUDIO_ACCESS_COOKIE = 'studio_v3_access';
export const STUDIO_ACCESS_TTL_SECONDS = 3600;

/** Next standalone uses its bind address in request.url; the reverse proxy preserves Host. */
export function studioRequestOrigin(request: Request): string | null {
  const configured = process.env.STUDIO_PUBLIC_ORIGIN;
  try {
    if (configured) {
      const publicUrl = new URL(configured);
      return ['http:', 'https:'].includes(publicUrl.protocol) && !publicUrl.username && !publicUrl.password && publicUrl.pathname === '/' && !publicUrl.search && !publicUrl.hash ? publicUrl.origin : null;
    }
    const requestUrl = new URL(request.url), host = request.headers.get('host');
    if (!host) return requestUrl.origin;
    // Never trust X-Forwarded-Host. Reject delimiters that could turn Host into a URL.
    if (/[\s,\/\\@?#]/.test(host)) return null;
    const target = new URL(`${requestUrl.protocol}//${host}`);
    return ['http:', 'https:'].includes(target.protocol) && target.host ? target.origin : null;
  } catch { return null; }
}

export function requireStudioSameOrigin(request: Request) {
  const origin = request.headers.get('origin');
  if (!origin) return null; // Bearer-authenticated non-browser API clients do not send Origin.
  const expected = studioRequestOrigin(request);
  if (!expected) return Response.json({ detail: '视频工作台公开地址配置无效' }, { status: 503, headers: { 'cache-control': 'no-store' } });
  let actual: URL;
  try { actual = new URL(origin); } catch { return Response.json({ detail: '只允许本站修改视频项目' }, { status: 403 }); }
  if (actual.origin !== expected || actual.origin !== origin) return Response.json({ detail: '只允许本站修改视频项目' }, { status: 403, headers: { 'cache-control': 'no-store' } });
  return null;
}

function signature(payload: string, installationToken: string) {
  return createHmac('sha256', installationToken).update(`studio-v3-session:${payload}`).digest('hex');
}

/** The cookie contains an expiring proof, never the installation or provider token. */
export function createStudioSession(request: Request, now = Date.now()) {
  const token = process.env.VIDEO_API_TOKEN || '';
  if (!token) throw new Error('installation access is not configured');
  const expires = Math.floor(now / 1000) + STUDIO_ACCESS_TTL_SECONDS;
  const payload = `${expires}.${randomBytes(16).toString('hex')}`;
  const value = `${payload}.${signature(payload, token)}`;
  const secure = studioRequestOrigin(request)?.startsWith('https:') || new URL(request.url).protocol === 'https:' || request.headers.get('x-forwarded-proto')?.split(',')[0].trim() === 'https';
  return { expiresAt: expires * 1000, cookie: `${STUDIO_ACCESS_COOKIE}=${value}; Path=/api/v3; HttpOnly; SameSite=Strict; Max-Age=${STUDIO_ACCESS_TTL_SECONDS}${secure ? '; Secure' : ''}` };
}

export function studioValidationRequest(request: Request, now = Date.now()): Request {
  // Even an invalid explicit header wins over a browser session; never hide caller mistakes.
  if (request.headers.has('authorization')) return request;
  const raw = request.headers.get('cookie')?.split(';').map(part => part.trim()).find(part => part.startsWith(`${STUDIO_ACCESS_COOKIE}=`))?.slice(STUDIO_ACCESS_COOKIE.length + 1);
  const token = process.env.VIDEO_API_TOKEN || '';
  if (!raw || !token) return request;
  const [expiresText, nonce, mac, extra] = raw.split('.');
  if (extra || !/^\d{10,12}$/.test(expiresText || '') || !/^[a-f0-9]{32}$/.test(nonce || '') || !/^[a-f0-9]{64}$/.test(mac || '')) return request;
  const seconds = Math.floor(now / 1000), expires = Number(expiresText);
  if (expires <= seconds || expires > seconds + STUDIO_ACCESS_TTL_SECONDS) return request;
  const expected = signature(`${expiresText}.${nonce}`, token);
  if (!timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(expected, 'hex'))) return request;
  const headers = new Headers(request.headers); headers.set('authorization', `Bearer ${token}`);
  // Validation needs only headers; do not consume or transfer the actual proxy request body.
  return new Request(request.url, { headers });
}

export function requireStudioAccess(request: Request) {
  if (['POST', 'PUT', 'DELETE'].includes(request.method)) { const denied = requireStudioSameOrigin(request); if (denied) return denied; }
  return requireVideoToken(studioValidationRequest(request));
}
