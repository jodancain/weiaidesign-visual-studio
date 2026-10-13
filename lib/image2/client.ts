import { blobBase64 } from '../studio/client';
import type { ImageAsset, ImageDocument } from './types';
export const IMAGE2_BASE = '/api/v3/image2';
export class Image2ApiError extends Error {
  constructor(message: string, public status: number, public code?: string) { super(message); }
}
let visitorReady: Promise<void> | undefined;
function ensureImage2Visitor(): Promise<void> {
  // Image documents use a signed visitor; existing video projects retain their installation session.
  return visitorReady ||= fetch('/api/v3/session', { cache: 'no-store', credentials: 'same-origin' }).then(async response => {
    if (!response.ok) { const result = await response.json().catch(() => ({})); throw new Image2ApiError(result.detail || '无法建立匿名会话，请刷新重试', response.status); }
  }).catch(error => { visitorReady = undefined; throw error; });
}
export async function image2Api<T>(path: string, body?: unknown, method?: string): Promise<T> {
  await ensureImage2Visitor();
  const response = await fetch(`${IMAGE2_BASE}${path}`, {
    method: method || (body === undefined ? 'GET' : 'POST'), credentials: 'same-origin', cache: 'no-store',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Image2ApiError(value.detail || `请求失败 (${response.status})`, response.status, value.code);
  return value.data as T;
}
export const assetUrl = (id: string) => `${IMAGE2_BASE}/assets/${encodeURIComponent(id)}/content`;
export async function uploadAsset(documentId: string, file: Blob, name: string, metadata?: Record<string, unknown>, inputs?: Array<{role:string;assetId:string;hash?:string}>) {
  return image2Api<ImageAsset>('/assets', { documentId, name, mime: file.type || 'application/octet-stream', data: await blobBase64(file), metadata, inputs });
}
export function unwrapDocument(value: ImageDocument | { document: ImageDocument }): ImageDocument {
  return 'document' in value ? value.document : value;
}
export function listValue<T>(value: T[] | Record<string, unknown>, key: string): T[] {
  return Array.isArray(value) ? value : Array.isArray(value?.[key]) ? value[key] as T[] : [];
}
