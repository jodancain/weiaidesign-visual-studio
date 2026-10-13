import { ImageFontLoadError, imageFontIdentity } from './font-loader';
import type { ImageAsset } from './types';

export interface ImageFontSession<Face> {
  bind(documentId: string): void;
  load(asset: ImageAsset): Promise<Face>;
  clear(): void;
}
export interface ImageFontLoadState { status: 'loading' | 'ready' | 'error'; message?: string }
interface Options<Face> {
  loader: { load(asset: ImageAsset): Promise<ArrayBuffer>; clear(): void };
  createFace(asset: ImageAsset, bytes: ArrayBuffer): Promise<Face>;
  addFace(face: Face): void;
  deleteFace(face: Face): void;
  onStateChange?(states: Record<string, ImageFontLoadState>): void;
}
/** Document identity stays independent of the canvas canonical ref while it is cleared for a switch. */
export function createImageFontSession<Face>(options: Options<Face>): ImageFontSession<Face> {
  type Entry = { generation: number; assetId: string; state: ImageFontLoadState; promise?: Promise<Face>; face?: Face };
  const entries = new Map<string, Entry>(), invalid = new Map<string, ImageFontLoadState>();
  let documentId: string | undefined, generation = 0;
  const notify = () => options.onStateChange?.(Object.fromEntries([...invalid, ...Array.from(entries.values(), entry => [entry.assetId, { ...entry.state }] as const)]));
  function clear() {
    generation++; documentId = undefined;
    options.loader.clear();
    for (const entry of entries.values()) if (entry.face !== undefined) options.deleteFace(entry.face);
    entries.clear(); invalid.clear(); notify();
  }
  return {
    clear,
    bind(next: string) {
      if (!next) throw new Error('Font session requires a document identity');
      if (documentId === next) return;
      clear(); documentId = next;
    },
    load(asset: ImageAsset): Promise<Face> {
      if (!documentId) return Promise.reject(new ImageFontLoadError('字体工程已关闭', 'font_cancelled'));
      let key: string; try { key = imageFontIdentity(asset); } catch (error) { invalid.set(asset.id, { status: 'error', message: error instanceof Error ? error.message : '字体信息无效' }); notify(); return Promise.reject(error); }
      const existing = entries.get(key); if (existing) return existing.promise!;
      invalid.delete(asset.id);
      const entry: Entry = { generation, assetId: asset.id, state: { status: 'loading' } }, bound = documentId;
      const assertCurrent = () => {
        if (generation !== entry.generation || documentId !== bound || entries.get(key) !== entry) throw new ImageFontLoadError('字体读取已取消', 'font_cancelled');
      };
      entries.set(key, entry); notify();
      entry.promise = options.loader.load(asset).then(bytes => { assertCurrent(); return options.createFace(asset, bytes); }).then(face => {
        assertCurrent(); options.addFace(face); entry.face = face; entry.state = { status: 'ready' }; notify(); return face;
      }).catch(error => {
        // A stale request for A must never delete the replacement request after A -> B -> A.
        if (entries.get(key) === entry) { entry.state = { status: 'error', message: error instanceof Error ? error.message : '字体加载失败' }; notify(); }
        throw error;
      });
      return entry.promise;
    },
  };
}
