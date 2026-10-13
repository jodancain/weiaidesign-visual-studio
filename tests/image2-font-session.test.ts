import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createImageFontSession, type ImageFontLoadState } from '../lib/image2/font-session';
import { createImageFontLoader, ImageFontLoadError } from '../lib/image2/font-loader';
import type { ImageAsset } from '../lib/image2/types';

const data = new Uint8Array(37).fill(8), asset: ImageAsset = { id: 'shared-font', documentId: 'original', name: 'original.otf', mime: 'font/otf', hash: createHash('sha256').update(data).digest('hex'), bytes: data.byteLength, createdAt: 0 };
const cancelled = (error: unknown) => error instanceof ImageFontLoadError && error.code === 'font_cancelled';
const deferred = <T>() => { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setTimeout(resolve, 1));
type Face = { id: number };
test('same document asset refresh deduplicates pending and ready faces without clearing or rereading bytes', async () => {
  let reads = 0, clears = 0, creates = 0; const added: Face[] = [], removed: Face[] = [], bytes = deferred<ArrayBuffer>();
  const session = createImageFontSession<Face>({ loader: { load: () => { reads++; return bytes.promise; }, clear: () => { clears++; } }, createFace: async () => ({ id: ++creates }), addFace: face => added.push(face), deleteFace: face => removed.push(face) });
  session.bind('original'); const first = session.load(asset); session.bind('original'); assert.equal(session.load({ ...asset }), first); bytes.resolve(data.buffer);
  const face = await first; session.bind('original'); assert.equal(await session.load(asset), face); assert.equal(reads, 1); assert.equal(creates, 1); assert.equal(clears, 1); assert.deepEqual(added, [face]); assert.deepEqual(removed, []);
});
test('A -> B -> A while the first FontFace is decoding installs only the new face; stale completion cannot delete its replacement', async () => {
  const older = deferred<Face>(), newer = deferred<Face>(), added: Face[] = [], removed: Face[] = []; let creates = 0, reads = 0;
  const session = createImageFontSession<Face>({ loader: { load: async () => { reads++; return data.buffer; }, clear: () => {} }, createFace: () => ++creates === 1 ? older.promise : newer.promise, addFace: face => added.push(face), deleteFace: face => removed.push(face) });
  session.bind('A'); const old = session.load(asset); const oldResult = assert.rejects(old, cancelled); while (!creates) await tick();
  session.bind('B'); session.bind('A'); const replacement = session.load(asset); while (creates < 2) await tick(); const face = { id: 2 }; newer.resolve(face); assert.equal(await replacement, face);
  older.resolve({ id: 1 }); await oldResult; assert.equal(session.load(asset), replacement); assert.deepEqual(added, [face]); assert.deepEqual(removed, []); assert.equal(reads, 2);
});
test('stale failure after returning to the same font cannot remove the new in-flight marker', async () => {
  const oldBytes = deferred<ArrayBuffer>(), newBytes = deferred<ArrayBuffer>(); let reads = 0; const added: Face[] = [];
  const session = createImageFontSession<Face>({ loader: { load: () => ++reads === 1 ? oldBytes.promise : newBytes.promise, clear: () => {} }, createFace: async () => ({ id: reads }), addFace: face => added.push(face), deleteFace: () => {} });
  session.bind('A'); const old = session.load(asset); const rejected = assert.rejects(old, /old network failure/); session.bind('B'); session.bind('A'); const replacement = session.load(asset);
  oldBytes.reject(new Error('old network failure')); await rejected; assert.equal(session.load(asset), replacement); newBytes.resolve(data.buffer); await replacement; assert.equal(reads, 2); assert.equal(added.length, 1);
});
test('real bounded byte-loader cancels a changed document, cleans installed faces, and retries the original font on return', async () => {
  let block = true, requests = 0, creates = 0, aborted = 0; const added: Face[] = [], removed: Face[] = [];
  const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requests++;
    if (block) return new Promise<Response>((_resolve, reject) => { init!.signal!.addEventListener('abort', () => { aborted++; reject(new DOMException('Aborted', 'AbortError')); }, { once: true }); });
    return new Response(data, { status: 206, headers: { 'content-type': asset.mime, 'content-range': `bytes 0-${data.byteLength - 1}/${data.byteLength}`, etag: `"${asset.hash}"` } });
  }) as typeof fetch;
  const session = createImageFontSession<Face>({ loader: createImageFontLoader({ fetch: fetcher }), createFace: async () => ({ id: ++creates }), addFace: face => added.push(face), deleteFace: face => removed.push(face) });
  session.bind('original'); const old = session.load(asset); const rejected = assert.rejects(old, cancelled); while (!requests) await tick(); session.bind('professional'); await rejected; assert.equal(aborted, 1);
  block = false; const professional = await session.load(asset); session.bind('original'); const original = await session.load(asset); assert.notEqual(original, professional); assert.equal(requests, 3); assert.deepEqual(removed, [professional]); assert.deepEqual(added, [professional, original]);
  session.bind('original'); await session.load(asset); assert.equal(requests, 3); session.clear(); assert.deepEqual(removed, [professional, original]); await assert.rejects(session.load(asset), cancelled);
});
test('unmount during FontFace decoding prevents a later install and permits a fresh bind/load', async () => {
  const gate = deferred<Face>(); let creates = 0, reads = 0; const added: Face[] = [];
  const session = createImageFontSession<Face>({ loader: { load: async () => { reads++; return data.buffer; }, clear: () => {} }, createFace: async () => ++creates === 1 ? gate.promise : { id: creates }, addFace: face => added.push(face), deleteFace: () => {} });
  session.bind('A'); const old = session.load(asset); const rejected = assert.rejects(old, cancelled); while (!creates) await tick(); session.clear(); gate.resolve({ id: 1 }); await rejected; assert.deepEqual(added, []);
  session.bind('A'); await session.load(asset); assert.equal(reads, 2); assert.deepEqual(added, [{ id: 2 }]);
});
test('ready status follows successful face decoding and installation; decoding errors remain visible across refresh', async () => {
  const gate = deferred<Face>(), order: string[] = []; let states: Record<string, ImageFontLoadState> = {}, reads = 0;
  const session = createImageFontSession<Face>({ loader: { load: async () => { reads++; return data.buffer; }, clear: () => {} }, createFace: () => gate.promise, addFace: () => { assert.equal(states[asset.id].status, 'loading'); order.push('installed'); }, deleteFace: () => {}, onStateChange: next => { states = next; if (next[asset.id]) order.push(next[asset.id].status); } });
  session.bind('A'); const task = session.load(asset); await tick(); assert.equal(states[asset.id].status, 'loading'); gate.resolve({ id: 1 }); await task; assert.deepEqual(order, ['loading', 'installed', 'ready']);
  session.bind('B'); assert.deepEqual(states, {});
  let failedStates: Record<string, ImageFontLoadState> = {}, canDecode = false; const failed = createImageFontSession<Face>({ loader: { load: async () => { reads++; return data.buffer; }, clear: () => {} }, createFace: async () => { if (!canDecode) throw new Error('FontFace decode rejected'); return { id: 2 }; }, addFace: () => { assert.ok(canDecode, 'must not install a fallback'); }, deleteFace: () => {}, onStateChange: next => { failedStates = next; } });
  failed.bind('A'); const rejected = failed.load(asset); await assert.rejects(rejected, /decode rejected/); const afterFailure = reads; assert.equal(failedStates[asset.id].status, 'error'); assert.match(failedStates[asset.id].message!, /decode rejected/);
  failed.bind('A'); assert.equal(failed.load(asset), rejected); await assert.rejects(failed.load(asset), /decode rejected/); assert.equal(reads, afterFailure); assert.equal(failedStates[asset.id].status, 'error');
  failed.bind('B'); assert.deepEqual(failedStates, {}); canDecode = true; failed.bind('A'); await failed.load(asset); assert.equal(reads, afterFailure + 1); assert.equal(failedStates[asset.id].status, 'ready');
});
test('stale A decoding after A -> B -> A cannot replace the current ready status with a stale error', async () => {
  const old = deferred<Face>(); let creates = 0; const stateChanges: string[] = [];
  const session = createImageFontSession<Face>({ loader: { load: async () => data.buffer, clear: () => {} }, createFace: async () => ++creates === 1 ? old.promise : { id: 2 }, addFace: () => {}, deleteFace: () => {}, onStateChange: next => { if (next[asset.id]) stateChanges.push(next[asset.id].status); } });
  session.bind('A'); const first = session.load(asset); const cancelledTask = assert.rejects(first, cancelled); while (!creates) await tick(); session.bind('B'); session.bind('A'); await session.load(asset); old.resolve({ id: 1 }); await cancelledTask; assert.deepEqual(stateChanges, ['loading', 'loading', 'ready']);
});
test('canonical=null switches still bind the independent font session, and cancelled stale work is not shown as a new font error', () => {
  const source = readFileSync(new URL('../lib/image2/useLegacyImage2.ts', import.meta.url), 'utf8');
  const start = source.indexOf('async function bind(next:'), bind = source.slice(start, source.indexOf('useEffect(() => {', start));
  assert.match(bind, /fontSession\.current!\.bind\(next\.id\)/); assert.doesNotMatch(bind, /if \(canonical\.current && canonical\.current\.id !== next\.id\) clearFonts/);
  assert.ok(bind.indexOf('fontSession.current!.bind(next.id)') < bind.indexOf('canonical.current = next'));
  assert.match(source, /err instanceof ImageFontLoadError && err\.code === 'font_cancelled'\) return/); assert.doesNotMatch(source, /loadedFonts/);
  const panel = readFileSync(new URL('../components/image2/LegacyImagePanels.tsx', import.meta.url), 'utf8'); assert.match(panel, /aria-label="字体加载状态" role="status"/); assert.match(panel, /bridge\.fontStates\[selected\.fontAssetId\]/); for (const text of ['字体已加载', '字体加载失败', '字体加载中', '刷新页面重试']) assert.ok(panel.includes(text));
});
