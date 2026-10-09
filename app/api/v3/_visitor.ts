import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { studioRequestOrigin } from './_access';

export const STUDIO_VISITOR_COOKIE = 'studio_v3_visitor';
const TTL = 365 * 24 * 60 * 60;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function secret() {
  const value = process.env.STUDIO_VISITOR_SECRET || process.env.VIDEO_API_PROXY_TOKEN || process.env.VIDEO_API_TOKEN;
  if (!value) throw new Error('匿名工作台会话服务尚未配置，请联系服务管理员');
  return value;
}
const sign = (payload: string, key: string) => createHmac('sha256', key).update(`studio-visitor:${payload}`).digest('hex');
export function readStudioVisitor(request: Request, now = Date.now()): string | null {
  const raw = request.headers.get('cookie')?.split(';').map(part => part.trim()).find(part => part.startsWith(`${STUDIO_VISITOR_COOKIE}=`))?.slice(STUDIO_VISITOR_COOKIE.length + 1);
  if (!raw) return null;
  const [version, id, expires, mac, extra] = raw.split('.');
  if (extra || version !== '1' || !UUID.test(id || '') || !/^\d{10}$/.test(expires || '') || !/^[a-f0-9]{64}$/.test(mac || '')) return null;
  const seconds = Math.floor(now / 1000);
  if (Number(expires) <= seconds || Number(expires) > seconds + TTL + 60) return null;
  const expected = sign(`${version}.${id}.${expires}`, secret());
  return timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(expected, 'hex')) ? id : null;
}
export function studioVisitor(request: Request, now = Date.now()) {
  const key = secret(), existing = readStudioVisitor(request, now), id = existing || randomUUID();
  const expiresAt = Math.floor(now / 1000) + TTL, payload = `1.${id}.${expiresAt}`;
  const secure = studioRequestOrigin(request)?.startsWith('https:') || request.headers.get('x-forwarded-proto')?.split(',')[0].trim() === 'https';
  return { id, existing: !!existing, expiresAt: expiresAt * 1000, cookie: `${STUDIO_VISITOR_COOKIE}=${payload}.${sign(payload, key)}; Path=/api/v3; HttpOnly; SameSite=Strict; Max-Age=${TTL}${secure ? '; Secure' : ''}` };
}
