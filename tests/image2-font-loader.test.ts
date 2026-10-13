import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createImageFontLoader, ImageFontLoadError } from '../lib/image2/font-loader';
import type { ImageAsset } from '../lib/image2/types';

const CHUNK = 1024 * 1024;
const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const asset = (data: Uint8Array, id = 'font', documentId = 'doc'): ImageAsset => ({ id, documentId, name: `${id}.otf`, mime: 'font/otf', bytes: data.byteLength, hash: hash(data), createdAt: 0 });
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
type Range = { start: number; end: number };
function network(data: Uint8Array, entry: ImageAsset, response?: (range: Range, signal: AbortSignal) => Promise<Response> | Response) {
  const calls: Range[] = []; let active = 0, maxActive = 0;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(input, `/api/v3/image2/assets/${encodeURIComponent(entry.id)}/content`); assert.equal(init?.credentials, 'same-origin'); assert.equal(init?.cache, 'no-store'); assert.ok(!init?.method || init.method === 'GET');
    const range = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init?.headers).get('range') || ''); assert.ok(range);
    const requested = { start: Number(range[1]), end: Number(range[2]) }; assert.ok(requested.end - requested.start + 1 <= CHUNK); calls.push(requested);
    active++; maxActive = Math.max(maxActive, active);
    try { await delay(1); return response ? await response(requested, init!.signal!) : part(data, entry, requested); } finally { active--; }
  }) as typeof fetch;
  return { fetcher, calls, maxActive: () => maxActive };
}
function part(data: Uint8Array, entry: ImageAsset, range: Range, extra: HeadersInit = {}, body = data.subarray(range.start, range.end + 1)) {
  return new Response(new Uint8Array(body).buffer, { status: 206, headers: { 'content-type': entry.mime, 'content-range': `bytes ${range.start}-${range.end}/${entry.bytes}`, etag: `"${entry.hash}"`, ...Object.fromEntries(new Headers(extra)) } });
}
const code = (expected: string) => (error: unknown) => error instanceof ImageFontLoadError && error.code === expected;

test('complete original CJK font uses exact bounded ranges, only two requests at a time, and preserves the full font hash', async () => {
  const original = readFileSync(new URL('../services/image2/fonts/NotoSansCJKsc-Regular.otf', import.meta.url)), before = hash(original), entry = asset(original), mock = network(original, entry), loader = createImageFontLoader({ fetch: mock.fetcher });
  const result = await loader.load(entry);
  assert.deepEqual(new Uint8Array(result), new Uint8Array(original)); assert.equal(hash(new Uint8Array(result)), entry.hash); assert.equal(hash(original), before);
  const count = Math.ceil(original.byteLength / CHUNK); assert.equal(mock.calls.length, count); assert.ok(mock.maxActive() <= 2); assert.equal(mock.calls[0].start, 0); assert.equal(mock.calls.at(-1)!.end, original.byteLength - 1);
  assert.deepEqual(mock.calls.map(call => call.start).sort((a, b) => a - b), Array.from({ length: count }, (_, i) => i * CHUNK));
});
test('concurrent polling loads share the exact pending promise and cached validated bytes', async () => {
  const data = new Uint8Array(2 * CHUNK + 37).fill(20), entry = asset(data), mock = network(data, entry), loader = createImageFontLoader({ fetch: mock.fetcher });
  const first = loader.load(entry), second = loader.load({ ...entry }); assert.equal(first, second);
  const [a, b] = await Promise.all([first, second]); assert.equal(a, b); assert.equal(mock.calls.length, 3); assert.equal(await loader.load(entry), a); assert.equal(mock.calls.length, 3);
});
test('range metadata rejects changing totals, starts, ends, MIME and immutable ETag', async t => {
  const data = new Uint8Array(CHUNK + 17).fill(5), entry = asset(data);
  const cases: Array<{ name: string; error: string; header: (range: Range) => HeadersInit }> = [
    { name: 'total', error: 'font_range_mismatch', header: range => ({ 'content-range': `bytes ${range.start}-${range.end}/${entry.bytes + 1}` }) },
    { name: 'start', error: 'font_range_mismatch', header: range => ({ 'content-range': `bytes ${range.start + 1}-${range.end}/${entry.bytes}` }) },
    { name: 'end', error: 'font_range_mismatch', header: range => ({ 'content-range': `bytes ${range.start}-${range.end - 1}/${entry.bytes}` }) },
    { name: 'mime', error: 'font_mime_mismatch', header: () => ({ 'content-type': 'text/html' }) },
    { name: 'etag', error: 'font_hash_mismatch', header: () => ({ etag: `"${'f'.repeat(64)}"` }) },
  ];
  for (const value of cases) await t.test(value.name, async () => {
    const mock = network(data, entry, range => part(data, entry, range, value.header(range))), loader = createImageFontLoader({ fetch: mock.fetcher });
    await assert.rejects(loader.load(entry), code(value.error)); assert.ok(mock.calls.length <= 2);
  });
});
test('truncated or oversized body is rejected even when claimed headers are valid', async t => {
  const data = new Uint8Array(17).fill(9), entry = asset(data);
  for (const [name, body, error] of [['short', data.subarray(0, 16), 'font_truncated'], ['long', new Uint8Array(18), 'font_size_mismatch']] as const) await t.test(name, async () => {
    const mock = network(data, entry, range => part(data, entry, range, {}, body)); await assert.rejects(createImageFontLoader({ fetch: mock.fetcher }).load(entry), code(error)); assert.equal(mock.calls.length, 1);
  });
});
test('full SHA256 rejects corrupted payload without caching; a later correct read succeeds', async () => {
  const data = new Uint8Array(29).fill(11), corrupt = new Uint8Array(data); corrupt[3] ^= 1; const entry = asset(data); let valid = false;
  const mock = network(data, entry, range => part(data, entry, range, {}, valid ? data : corrupt)), loader = createImageFontLoader({ fetch: mock.fetcher });
  await assert.rejects(loader.load(entry), code('font_hash_mismatch')); valid = true; assert.deepEqual(new Uint8Array(await loader.load(entry)), data); assert.equal(mock.calls.length, 2);
});
test('large unexpected 200 is refused before full download; exact small 200 is bounded and hash validated', async () => {
  const big = new Uint8Array(CHUNK + 3), bigEntry = asset(big), rejected = network(big, bigEntry, () => new Response(big, { headers: { 'content-type': 'font/otf' } }));
  await assert.rejects(createImageFontLoader({ fetch: rejected.fetcher }).load(bigEntry), code('font_range_invalid')); assert.ok(rejected.calls.length <= 2);
  const small = new Uint8Array(15).fill(71), smallEntry = asset(small), accepted = network(small, smallEntry, () => new Response(small, { headers: { 'content-type': 'font/otf' } }));
  assert.deepEqual(new Uint8Array(await createImageFontLoader({ fetch: accepted.fetcher }).load(smallEntry)), small); assert.equal(accepted.calls.length, 1);
});
test('headers and body-read stalls both time out with only one bounded retry', async t => {
  const data = new Uint8Array(17), entry = asset(data);
  for (const stage of ['headers', 'body']) await t.test(stage, async () => {
    const mock = network(data, entry, (range, signal) => {
      if (stage === 'headers') return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
      const stream = new ReadableStream<Uint8Array>({ start(controller) { signal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true }); } });
      return new Response(stream, { status: 206, headers: { 'content-type': entry.mime, 'content-range': `bytes ${range.start}-${range.end}/${entry.bytes}` } });
    });
    await assert.rejects(createImageFontLoader({ fetch: mock.fetcher, timeoutMs: 15 }).load(entry), code('font_timeout')); assert.equal(mock.calls.length, 2);
  });
});
test('project clear aborts active loads and removes cached identities; other documents never reuse prior bytes', async () => {
  const data = new Uint8Array(17).fill(13), entry = asset(data); let block = true;
  const mock = network(data, entry, (range, signal) => block ? new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })) : part(data, entry, range));
  const loader = createImageFontLoader({ fetch: mock.fetcher }), task = loader.load(entry); while (!mock.calls.length) await delay(1); await delay(2); loader.clear(); await assert.rejects(task, code('font_cancelled'));
  block = false; await loader.load(entry); await loader.load({ ...entry, documentId: 'other-document' }); assert.equal(mock.calls.length, 3);
  loader.clear(); await loader.load(entry); assert.equal(mock.calls.length, 4);
});
test('byte cache is bounded and all available fonts together still have at most two requests in flight', async () => {
  const data = new Uint8Array(CHUNK + 5).fill(7), first = asset(data, 'a'), second = asset(data, 'b'); let active = 0, maximum = 0; const calls: string[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    active++; maximum = Math.max(maximum, active); calls.push(String(input)); await delay(2); const entry = String(input).includes('/a/') ? first : second, range = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init?.headers).get('range')!)!;
    active--; return part(data, entry, { start: Number(range[1]), end: Number(range[2]) });
  }) as typeof fetch;
  const loader = createImageFontLoader({ fetch: fetcher, cacheBytes: data.byteLength });
  await Promise.all([loader.load(first), loader.load(second)]); assert.ok(maximum <= 2); assert.equal(calls.length, 4);
  await loader.load(first); assert.equal(calls.length, 6); await loader.load(first); assert.equal(calls.length, 6);
});
test('invalid asset sizes/hash/MIME are refused without requests and original UI uses BufferSource with scope cleanup', async () => {
  let calls = 0; const fetcher = (async () => { calls++; throw new Error('must not fetch'); }) as typeof fetch, loader = createImageFontLoader({ fetch: fetcher }), entry = asset(new Uint8Array(5));
  for (const patch of [{ bytes: 0 }, { bytes: 64 * CHUNK + 1 }, { hash: 'invalid' }, { mime: 'text/plain' }]) await assert.rejects(loader.load({ ...entry, ...patch }), code('font_asset_invalid'));
  assert.equal(calls, 0);
  const source = readFileSync(new URL('../lib/image2/useLegacyImage2.ts', import.meta.url), 'utf8'); assert.match(source, /new FontFace\(name, bytes,/); assert.doesNotMatch(source, /new FontFace\(name, `url/); assert.match(source, /assertScope\(captured\); window\.document\.fonts\.add/); assert.match(source, /epoch\.current\+\+; clearFonts\(\)/); assert.match(source, /window\.document\.fonts\.delete\(face\)/);
});
