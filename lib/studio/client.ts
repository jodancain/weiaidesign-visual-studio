export class StudioApiError extends Error { constructor(message: string, public status: number) { super(message); } }
let visitorReady: Promise<void> | undefined;
export function ensureStudioVisitor(): Promise<void> {
  // One bootstrap for concurrent startup calls prevents competing first-visit cookies.
  return visitorReady ||= fetch('/api/v3/session', { cache: 'no-store', credentials: 'same-origin' }).then(async response => {
    if (!response.ok) { const result = await response.json().catch(() => ({})); throw new StudioApiError(result.detail || '无法建立匿名会话，请刷新重试', response.status); }
  }).catch(error => { visitorReady = undefined; throw error; });
}
export async function studioApi<T>(path: string, body?: unknown, method?: string): Promise<T> {
  await ensureStudioVisitor();
  const response = await fetch(`/api/v3${path}`, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store', credentials: 'same-origin',
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new StudioApiError(result.detail || `请求失败 (${response.status})`, response.status);
  return result.data as T;
}
export const studioId = () => crypto.randomUUID();
export async function blobBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsDataURL(blob);
  });
}
export function frameTime(frame: number): string {
  const seconds = Math.floor(frame / 24);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}:${String(frame % 24).padStart(2, '0')}`;
}
