import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from '@playwright/test';
import { POST, GET as visitorSession } from '../app/api/v3/session/route';
import { GET } from '../app/api/v3/[...path]/route';
import { createStudioSession, requireStudioAccess, requireStudioSameOrigin } from '../app/api/v3/_access';
import { requireVideoToken } from '../app/api/v1/_lib/visual-api';

const installation = 'synthetic-installation-access-for-test';
const base = 'http://127.0.0.1';
const authenticate = (token: string, url = `${base}/api/v3/session`, extra: Record<string, string> = {}) => POST(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...extra }, body: JSON.stringify({ token }) }));

test('standalone bind address differs from public Host without allowing forged forwarded hosts', async () => {
  const keys = ['REQUIRE_ACCESS_TOKEN', 'VIDEO_API_TOKEN', 'STUDIO_PUBLIC_ORIGIN'] as const, previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.REQUIRE_ACCESS_TOKEN = '1'; process.env.VIDEO_API_TOKEN = installation; delete process.env.STUDIO_PUBLIC_ORIGIN;
  try {
    const url = 'https://0.0.0.0:18084/api/v3/session';
    const accepted = await authenticate(installation, url, { host: 'studio.example', origin: 'https://studio.example', 'x-forwarded-proto': 'https' });
    assert.equal(accepted.status, 200); assert.match(accepted.headers.get('set-cookie')!, /; Secure/);
    const cookie = accepted.headers.get('set-cookie')!.split(';')[0];
    assert.equal(requireStudioAccess(new Request('https://0.0.0.0:18084/api/v3/projects', { method: 'PUT', headers: { host: 'studio.example', origin: 'https://studio.example', cookie } })), null);
    assert.equal((await authenticate(installation, url, { host: 'studio.example', origin: 'https://hostile.example', 'x-forwarded-host': 'hostile.example' })).status, 403);
    assert.equal((await authenticate(installation, url, { host: 'studio.example', origin: 'http://studio.example' })).status, 403);
    assert.equal(requireStudioSameOrigin(new Request('http://0.0.0.0:18084', { headers: { host: '127.0.0.1:18293', origin: 'http://127.0.0.1:18293' } })), null);
    assert.equal(requireStudioSameOrigin(new Request(url, { headers: { host: 'studio.example@hostile.example', origin: 'https://hostile.example' } }))?.status, 503);
    process.env.STUDIO_PUBLIC_ORIGIN = 'https://public.example';
    assert.equal(requireStudioSameOrigin(new Request(url, { headers: { host: 'internal.local', origin: 'https://public.example' } })), null);
    assert.equal(requireStudioSameOrigin(new Request(url, { headers: { host: 'hostile.example', origin: 'https://hostile.example' } }))?.status, 403);
    process.env.STUDIO_PUBLIC_ORIGIN = 'https://public.example/invalid-path';
    assert.equal(requireStudioSameOrigin(new Request(url, { headers: { origin: 'https://public.example' } }))?.status, 503);
  } finally { for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } }
});

test('signed short-lived v3 session validates access without exposing tokens or changing v1', async () => {
  const oldRequired = process.env.REQUIRE_ACCESS_TOKEN, oldToken = process.env.VIDEO_API_TOKEN;
  process.env.REQUIRE_ACCESS_TOKEN = '1'; process.env.VIDEO_API_TOKEN = installation;
  try {
    assert.equal((await authenticate('wrong')).status, 401); assert.equal((await authenticate('')).status, 400); assert.equal((await authenticate('不是有效访问码')).status, 400);
    assert.equal((await authenticate(installation, `${base}/api/v3/session`, { origin: 'https://unrelated.invalid' })).status, 403);
    const allowed = await authenticate(installation), cookie = allowed.headers.get('set-cookie')!; assert.equal(allowed.status, 200); assert.match(cookie, /Path=\/api\/v3/); assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/); assert.match(cookie, /Max-Age=3600/); assert.ok(!cookie.includes(installation)); assert.ok(!cookie.includes('Secure'));
    assert.match((await authenticate(installation, 'https://studio.example/api/v3/session')).headers.get('set-cookie')!, /; Secure/);
    assert.match((await authenticate(installation, `${base}/api/v3/session`, { 'x-forwarded-proto': 'https' })).headers.get('set-cookie')!, /; Secure/);
    const headers = { cookie: cookie.split(';')[0] };
    assert.equal(requireStudioAccess(new Request(`${base}/api/v3/assets/example/content`, { headers })), null);
    assert.equal(requireStudioAccess(new Request(`${base}/api/v3/projects`, { method: 'POST', headers: { ...headers, origin: 'http://other.localhost' } }))?.status, 403);
    assert.equal(requireStudioAccess(new Request(`${base}/api/v3/projects`, { method: 'POST', headers })), null);
    assert.equal(requireVideoToken(new Request(`${base}/api/v1/images`, { headers }))?.status, 401);
    assert.equal(requireStudioAccess(new Request(`${base}/api/v3/projects`, { headers: { ...headers, authorization: 'Bearer incorrect' } }))?.status, 401);
    assert.equal(requireStudioAccess(new Request(`${base}/api/v3/projects`, { headers: { authorization: `Bearer ${installation}`, cookie: 'studio_v3_access=invalid' } })), null);
    const expired = createStudioSession(new Request(base), Date.now() - 7200_000).cookie.split(';')[0]; assert.equal(requireStudioAccess(new Request(`${base}/api/v3/projects`, { headers: { cookie: expired } }))?.status, 401);
    const forged = headers.cookie.slice(0, -1) + (headers.cookie.endsWith('0') ? '1' : '0'); assert.equal(requireStudioAccess(new Request(`${base}/api/v3/projects`, { headers: { cookie: forged } }))?.status, 401);
    process.env.VIDEO_API_TOKEN = 'rotated-synthetic-installation'; assert.equal(requireStudioAccess(new Request(`${base}/api/v3/projects`, { headers }))?.status, 401);
  } finally { if (oldRequired === undefined) delete process.env.REQUIRE_ACCESS_TOKEN; else process.env.REQUIRE_ACCESS_TOKEN = oldRequired; if (oldToken === undefined) delete process.env.VIDEO_API_TOKEN; else process.env.VIDEO_API_TOKEN = oldToken; }
});

test('real Chrome anonymously loads image bytes with an HttpOnly ownership cookie and no bearer header', async () => {
  const keys = ['REQUIRE_ACCESS_TOKEN', 'VIDEO_API_TOKEN', 'VIDEO_API_PROXY_TOKEN', 'STUDIO_GATEWAY_URL'] as const, previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const nativeFetch = globalThis.fetch; const assetCalls: { authorization: string | null; cookie: string | null }[] = [];
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=', 'base64');
  process.env.REQUIRE_ACCESS_TOKEN = '1'; process.env.VIDEO_API_TOKEN = installation; process.env.VIDEO_API_PROXY_TOKEN = 'synthetic-upstream-only'; process.env.STUDIO_GATEWAY_URL = 'http://studio-test.invalid';
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => { const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url; if (url.startsWith('http://studio-test.invalid/')) { const headers = new Headers(init?.headers); assetCalls.push({ authorization: headers.get('authorization'), cookie: headers.get('cookie') }); return new Response(png, { headers: { 'content-type': 'image/png' } }); } return nativeFetch(input, init); }) as typeof fetch;
  const server = createServer(async (incoming, outgoing) => { try { const bytes: Buffer[] = []; for await (const chunk of incoming) bytes.push(Buffer.from(chunk)); const url = `http://127.0.0.1:${(server.address() as { port: number }).port}${incoming.url}`; const headers = new Headers(); for (const [key, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(',') : value); const request = new Request(url, { method: incoming.method, headers, ...(incoming.method === 'POST' ? { body: Buffer.concat(bytes) } : {}) }); let response: Response;
    if (incoming.url === '/api/v3/session') response = incoming.method === 'GET' ? await visitorSession(request) : await POST(request); else if (incoming.url?.startsWith('/api/v3/assets/')) response = await GET(request, { params: Promise.resolve({ path: ['assets', 'fixture', 'content'] }) }); else response = new Response('<!doctype html><html><body><img id="asset"><p>asset gate fixture</p></body></html>', { headers: { 'content-type': 'text/html' } }); outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries())); outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch { outgoing.writeHead(500); outgoing.end('test handler error'); } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`; const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try { const context = await browser.newContext(), page = await context.newPage(); await page.goto(url);
    assert.equal((await page.request.get(`${url}/api/v3/session`)).status(), 200);
    const cookie = (await context.cookies()).find(value => value.name === 'studio_v3_visitor')!; assert.equal(cookie.httpOnly, true); assert.equal(cookie.sameSite, 'Strict'); assert.equal(cookie.path, '/api/v3'); assert.ok(!cookie.value.includes(installation)); assert.equal(await page.evaluate(() => document.cookie), '');
    const size = await page.evaluate(async () => { const image = document.querySelector('#asset') as HTMLImageElement; image.src = '/api/v3/assets/fixture/content'; await image.decode(); return [image.naturalWidth, image.naturalHeight]; }); assert.deepEqual(size, [1, 1]); assert.equal(assetCalls.length, 1); assert.equal(assetCalls[0].authorization, 'Bearer synthetic-upstream-only'); assert.equal(assetCalls[0].cookie, null);
  } finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); globalThis.fetch = nativeFetch; for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } }
});
