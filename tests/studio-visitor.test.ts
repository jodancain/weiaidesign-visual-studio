import test from 'node:test';
import assert from 'node:assert/strict';
import { GET as session } from '../app/api/v3/session/route';
import { GET, POST } from '../app/api/v3/[...path]/route';
import { readStudioVisitor, studioVisitor } from '../app/api/v3/_visitor';
import { requireVideoToken } from '../app/api/v1/_lib/visual-api';

test('anonymous ownership is signed, stable across renewal, private, and cannot authenticate v1', async () => {
  const names = ['STUDIO_VISITOR_SECRET', 'VIDEO_API_TOKEN', 'REQUIRE_ACCESS_TOKEN'] as const;
  const old = Object.fromEntries(names.map(name => [name, process.env[name]]));
  process.env.STUDIO_VISITOR_SECRET = 'test-signing-secret'; process.env.VIDEO_API_TOKEN = 'synthetic-v1-token'; process.env.REQUIRE_ACCESS_TOKEN = '1';
  try {
    const initial = await session(new Request('https://studio.example/api/v3/session'));
    assert.equal(initial.status, 200);
    const cookie = initial.headers.get('set-cookie')!; assert.match(cookie, /HttpOnly; SameSite=Strict/); assert.match(cookie, /; Secure/); assert.ok(!cookie.includes('test-signing-secret'));
    const request = new Request('https://studio.example/api/v3/projects', { headers: { cookie: cookie.split(';')[0] } });
    const owner = readStudioVisitor(request); assert.ok(owner); assert.equal(studioVisitor(request).id, owner);
    assert.equal(requireVideoToken(request)?.status, 401);
    assert.equal(readStudioVisitor(new Request(request.url, { headers: { cookie: cookie.split(';')[0].replace(/.$/, 'x') } })), null);
    assert.equal(readStudioVisitor(request, Date.now() + 366 * 86400_000), null);
    assert.equal((await session(new Request(request.url, { headers: { origin: 'https://other.example' } }))).status, 403);
    assert.equal((await session(new Request(request.url, { headers: { 'sec-fetch-site': 'cross-site' } }))).status, 403);
  } finally { for (const name of names) { if (old[name] === undefined) delete process.env[name]; else process.env[name] = old[name]; } }
});

test('BFF discards visitor spoofing and external auth, forwards signed owner plus internal bearer and Range', async () => {
  const names = ['STUDIO_VISITOR_SECRET', 'VIDEO_API_PROXY_TOKEN', 'STUDIO_GATEWAY_URL'] as const;
  const old = Object.fromEntries(names.map(name => [name, process.env[name]])), fetch = globalThis.fetch;
  process.env.STUDIO_VISITOR_SECRET = 'test-signing'; process.env.VIDEO_API_PROXY_TOKEN = 'upstream-test'; process.env.STUDIO_GATEWAY_URL = 'http://isolated.invalid';
  const seen: Headers[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => { seen.push(new Headers(init?.headers)); return new Response('abc', { status: 206, headers: { 'content-range': 'bytes 0-2/3', 'accept-ranges': 'bytes' } }); }) as typeof globalThis.fetch;
  try {
    const visitor = studioVisitor(new Request('https://studio.example'));
    const request = new Request('https://studio.example/api/v3/assets/a/content', { headers: { cookie: visitor.cookie.split(';')[0], authorization: 'Bearer browser-value', 'x-studio-visitor-id': 'another-visitor', range: 'bytes=0-2' } });
    const result = await GET(request, { params: Promise.resolve({ path: ['assets', 'a', 'content'] }) });
    assert.equal(result.status, 206); assert.equal(result.headers.get('content-range'), 'bytes 0-2/3');
    assert.equal(seen[0].get('x-studio-visitor-id'), visitor.id); assert.equal(seen[0].get('authorization'), 'Bearer upstream-test'); assert.equal(seen[0].get('cookie'), null); assert.equal(seen[0].get('range'), 'bytes=0-2');
    const denied = await POST(new Request(request.url, { method: 'POST', headers: { origin: 'https://evil.example' } }), { params: Promise.resolve({ path: ['projects'] }) });
    assert.equal(denied.status, 403); assert.equal(seen.length, 1);
  } finally { globalThis.fetch = fetch; for (const name of names) { if (old[name] === undefined) delete process.env[name]; else process.env[name] = old[name]; } }
});
