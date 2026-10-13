import type { ImageAsset } from './types';

const CHUNK_BYTES = 1024 * 1024;
const MAX_FONT_BYTES = 64 * CHUNK_BYTES;
const FONT_MIMES = new Set(['font/otf', 'font/ttf', 'font/woff', 'font/woff2']);
export class ImageFontLoadError extends Error {
  constructor(message: string, public code: string) { super(message); }
}
interface Options { fetch?: typeof fetch; timeoutMs?: number; cacheBytes?: number }
const fail = (message: string, code: string): never => { throw new ImageFontLoadError(message, code); };
export function imageFontIdentity(asset: ImageAsset): string {
  if (!asset.id || !asset.documentId || !/^[a-f0-9]{64}$/i.test(asset.hash) || !Number.isSafeInteger(asset.bytes) || asset.bytes < 1 || asset.bytes > MAX_FONT_BYTES || !FONT_MIMES.has(asset.mime)) fail('字体资产信息无效或超过64MB上限', 'font_asset_invalid');
  return JSON.stringify([asset.documentId, asset.id, asset.hash.toLowerCase(), asset.bytes, asset.mime]);
}

/** Original font bytes only. At most two bounded same-origin reads; no full download fallback for large fonts. */
export function createImageFontLoader(options: Options = {}) {
  const read = options.fetch || globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 45_000, limit = options.cacheBytes ?? MAX_FONT_BYTES;
  if (!(timeoutMs > 0 && timeoutMs <= 60_000) || !(limit >= 0 && limit <= MAX_FONT_BYTES)) throw new Error('Invalid font loader bounds');
  const ready = new Map<string, ArrayBuffer>(), pending = new Map<string, Promise<ArrayBuffer>>(), controllers = new Set<AbortController>();
  let storedBytes = 0, generation = 0, serial = Promise.resolve();
  const cancelled = () => new ImageFontLoadError('字体读取已取消', 'font_cancelled');
  const assertCurrent = (scope: number) => { if (scope !== generation) throw cancelled(); };
  const remember = (key: string, bytes: ArrayBuffer) => {
    if (bytes.byteLength > limit) return;
    while (storedBytes + bytes.byteLength > limit) { const oldest = ready.keys().next().value!; storedBytes -= ready.get(oldest)!.byteLength; ready.delete(oldest); }
    ready.set(key, bytes); storedBytes += bytes.byteLength;
  };
  async function chunk(asset: ImageAsset, start: number, end: number, parent: AbortSignal): Promise<Uint8Array> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (parent.aborted) throw cancelled();
      const controller = new AbortController(), abort = () => controller.abort();
      parent.addEventListener('abort', abort, { once: true });
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
      let response: Response | undefined;
      try {
        response = await read(`/api/v3/image2/assets/${encodeURIComponent(asset.id)}/content`, { credentials: 'same-origin', cache: 'no-store', headers: { range: `bytes=${start}-${end}` }, signal: controller.signal });
        if (controller.signal.aborted) throw cancelled();
        const wholeSmall = response.status === 200 && asset.bytes <= CHUNK_BYTES && start === 0 && end === asset.bytes - 1;
        if (response.status !== 206 && !wholeSmall) {
          if ([502, 503, 504].includes(response.status) && attempt === 0) { await response.body?.cancel(); continue; }
          fail('字体服务未返回有效字节分段', 'font_range_invalid');
        }
        if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== asset.mime) fail('字体分段格式与原资产不一致', 'font_mime_mismatch');
        if (!wholeSmall) {
          const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
          if (!range || Number(range[1]) !== start || Number(range[2]) !== end || Number(range[3]) !== asset.bytes) fail('字体分段位置或总尺寸不一致', 'font_range_mismatch');
        }
        const etag = response.headers.get('etag');
        if (etag && etag.replace(/^W\//, '').toLowerCase() !== `"${asset.hash.toLowerCase()}"`) fail('字体分段标识与原资产不一致', 'font_hash_mismatch');
        const reader = response.body?.getReader();
        if (!reader) throw new ImageFontLoadError('字体分段内容缺失', 'font_truncated');
        const bytes = new Uint8Array(end - start + 1); let offset = 0;
        try {
          while (true) {
            const part = await reader.read();
            if (controller.signal.aborted) throw cancelled();
            if (part.done) break;
            if (offset + part.value.byteLength > bytes.byteLength) fail('字体分段超过声明尺寸', 'font_size_mismatch');
            bytes.set(part.value, offset); offset += part.value.byteLength;
          }
        } finally { reader.releaseLock(); }
        if (offset !== bytes.byteLength) fail('字体分段读取不完整', 'font_truncated');
        return bytes;
      } catch (error) {
        controller.abort();
        if (parent.aborted) throw cancelled();
        if (timedOut) { if (attempt === 0) continue; fail('字体分段读取超时，请稍后重试', 'font_timeout'); }
        if (error instanceof ImageFontLoadError) throw error;
        if (attempt === 1) fail('字体分段网络读取失败，请稍后重试', 'font_network');
      } finally { clearTimeout(timer); parent.removeEventListener('abort', abort); if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {}); }
    }
    return fail('字体分段网络读取失败', 'font_network');
  }
  async function download(asset: ImageAsset, scope: number): Promise<ArrayBuffer> {
    assertCurrent(scope);
    const controller = new AbortController(); controllers.add(controller);
    const bytes = new Uint8Array(asset.bytes), count = Math.ceil(asset.bytes / CHUNK_BYTES); let next = 0;
    async function lane() {
      while (next < count) {
        assertCurrent(scope); const index = next++, start = index * CHUNK_BYTES, end = Math.min(asset.bytes, start + CHUNK_BYTES) - 1;
        bytes.set(await chunk(asset, start, end, controller.signal), start);
      }
    }
    try {
      await Promise.all(Array.from({ length: Math.min(2, count) }, lane)); assertCurrent(scope);
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.buffer)), hash = Array.from(digest, n => n.toString(16).padStart(2, '0')).join('');
      assertCurrent(scope);
      if (hash !== asset.hash.toLowerCase()) fail('字体完整内容校验失败', 'font_hash_mismatch');
      return bytes.buffer;
    } finally { controller.abort(); controllers.delete(controller); }
  }
  return {
    load(asset: ImageAsset): Promise<ArrayBuffer> {
      const immutableAsset = { ...asset };
      let key: string; try { key = imageFontIdentity(immutableAsset); } catch (error) { return Promise.reject(error); }
      if (ready.has(key)) { const bytes = ready.get(key)!; ready.delete(key); ready.set(key, bytes); return Promise.resolve(bytes); }
      if (pending.has(key)) return pending.get(key)!;
      const scope = generation;
      // Font downloads are serialized; each has two lanes. Many available fonts cannot multiply request or buffer concurrency.
      const task = serial.then(() => download(immutableAsset, scope)).then(bytes => { assertCurrent(scope); remember(key, bytes); return bytes; });
      serial = task.then(() => {}, () => {}); pending.set(key, task);
      void task.then(() => { if (pending.get(key) === task) pending.delete(key); }, () => { if (pending.get(key) === task) pending.delete(key); });
      return task;
    },
    clear() { generation++; for (const controller of controllers) controller.abort(); ready.clear(); pending.clear(); storedBytes = 0; },
  };
}
