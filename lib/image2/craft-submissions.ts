import { image2Api } from './client';
import { submissionIntent, type SubmissionAttempt, type SubmissionStorage } from './submissions';

let database: Promise<IDBDatabase> | undefined;
const db = () => database ||= new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open('image-studio-craft-v1', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('attempts', { keyPath: 'intent' });
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => { database = undefined; reject(request.error); };
});
const storage: SubmissionStorage = {
  async getOrCreate(proposed) {
    const database = await db();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction('attempts', 'readwrite'), store = transaction.objectStore('attempts'), request = store.get(proposed.intent); let result = proposed;
      request.onsuccess = () => { if (request.result) result = request.result; else store.put(proposed); };
      transaction.oncomplete = () => resolve(result); transaction.onabort = transaction.onerror = () => reject(transaction.error);
    });
  },
  async remove(intent) { const database = await db(); await new Promise<void>((resolve, reject) => { const transaction = database.transaction('attempts', 'readwrite'); transaction.objectStore('attempts').delete(intent); transaction.oncomplete = () => resolve(); transaction.onabort = transaction.onerror = () => reject(transaction.error); }); },
  async list() { const database = await db(); return new Promise((resolve, reject) => { const request = database.transaction('attempts', 'readonly').objectStore('attempts').getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); },
};

/** Native tool requests have their own queue so image-operation recovery never misclassifies them. */
export class CraftSubmissionManager {
  private running = new Map<string, Promise<unknown>>();
  constructor(private store: SubmissionStorage, private transport: (path: string, body: Record<string, unknown>) => Promise<unknown>) {}
  submit<T>(path: string, documentId: string, intent: Record<string, unknown>, body: object): Promise<T> {
    return this.resume({ intent: submissionIntent(path, intent), path, documentId, body: structuredClone(body) as Record<string, unknown>, createdAt: Date.now() });
  }
  resume<T>(attempt: SubmissionAttempt): Promise<T> {
    const current = this.running.get(attempt.intent); if (current) return current as Promise<T>;
    const request = this.execute(attempt).finally(() => this.running.delete(attempt.intent)); this.running.set(attempt.intent, request); return request as Promise<T>;
  }
  private async execute(proposed: SubmissionAttempt) {
    const attempt = await this.store.getOrCreate(proposed);
    try {
      const result = await this.transport(attempt.path, attempt.body);
      if (!result || typeof result !== 'object' || typeof (result as { id?: unknown }).id !== 'string' || !(result as { id: string }).id) throw new Error('专业工具回执不完整，原请求已保留，请恢复提交确认结果');
      await this.store.remove(attempt.intent); return result;
    } catch (cause) {
      const status = (cause as { status?: number }).status;
      if (status && status >= 400 && status < 500 && ![408, 429].includes(status)) await this.store.remove(attempt.intent);
      throw cause;
    }
  }
  pending(documentId: string) { return this.store.list().then(list => list.filter(item => item.documentId === documentId)); }
}
export const craftSubmissions = new CraftSubmissionManager(storage, image2Api);
