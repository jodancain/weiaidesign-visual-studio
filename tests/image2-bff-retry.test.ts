import test from 'node:test';
import assert from 'node:assert/strict';
import { GET, POST } from '../app/api/v3/[...path]/route';
import { studioVisitor } from '../app/api/v3/_visitor';

test('image BFF retries a disconnected read with the same owner, but never replays mutations or rejected reads', async () => {
  const names = ['STUDIO_VISITOR_SECRET', 'IMAGE2_API_URL', 'IMAGE2_API_TOKEN'] as const;
  const old = Object.fromEntries(names.map(name => [name, process.env[name]])), fetch = globalThis.fetch;
  process.env.STUDIO_VISITOR_SECRET = 'image-bff-local-test-signing-secret'; process.env.IMAGE2_API_URL = 'http://image-service.invalid'; process.env.IMAGE2_API_TOKEN = 'image-service-local-test-token';
  const calls: Array<{ method?: string; owner: string | null; range: string | null }> = [];
  try {
    const visitor = studioVisitor(new Request('https://studio.example'));
    const headers = { cookie: visitor.cookie.split(';')[0], range: 'bytes=0-2' };
    const context = { params: Promise.resolve({ path: ['image2', 'assets', 'original', 'content'] }) };
    const svgPolicy = "default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; sandbox";
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const h = new Headers(init?.headers); calls.push({ method: init?.method, owner: h.get('x-studio-visitor-id'), range: h.get('range') });
      if (calls.length === 1) throw new TypeError('connection reset');
      return new Response('<sv', { status: 206, headers: { 'content-type': 'image/svg+xml', 'content-range': 'bytes 0-2/6', 'content-security-policy': svgPolicy } });
    }) as typeof fetch;
    const read = await GET(new Request('https://studio.example/api/v3/image2/assets/original/content', { headers }), context);
    assert.equal(read.status, 206); assert.equal(calls.length, 2); assert.deepEqual(calls[0], calls[1]); assert.equal(calls[0].owner, visitor.id);
    assert.equal(read.headers.get('content-security-policy'), svgPolicy); assert.equal(read.headers.get('content-range'), 'bytes 0-2/6'); assert.equal(await read.text(), '<sv');
    calls.length = 0;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => { calls.push({ method: init?.method, owner: null, range: null }); throw new TypeError('lost mutation receipt'); }) as typeof fetch;
    const mutation = await POST(new Request('https://studio.example/api/v3/image2/operations', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ idempotencyKey: 'frozen-original-key' }) }), { params: Promise.resolve({ path: ['image2', 'operations'] }) });
    assert.equal(mutation.status, 502); assert.equal(calls.length, 1);
    calls.length = 0;
    globalThis.fetch = (async () => { calls.push({ method: 'GET', owner: null, range: null }); return new Response('{}', { status: 503 }); }) as typeof fetch;
    assert.equal((await GET(new Request('https://studio.example/api/v3/image2/assets/original/content', { headers }), context)).status, 503); assert.equal(calls.length, 1);
    calls.length = 0;
    globalThis.fetch = (async () => { calls.push({ method: 'GET', owner: null, range: null }); throw Object.assign(new Error('read deadline'), { name: 'TimeoutError' }); }) as typeof fetch;
    assert.equal((await GET(new Request('https://studio.example/api/v3/image2/assets/original/content', { headers }), context)).status, 502); assert.equal(calls.length, 1);
  } finally { globalThis.fetch = fetch; for (const name of names) { if (old[name] === undefined) delete process.env[name]; else process.env[name] = old[name]; } }
});
