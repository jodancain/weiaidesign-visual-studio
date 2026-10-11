import type { ImageDocument } from './types';
import type { QueuedBatch, QueueStorage } from './queue';
import type { SubmissionAttempt, SubmissionStorage } from './submissions';
let database: Promise<IDBDatabase> | undefined;
function db() {
  return database ||= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('image-studio-v2', 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('commands')) request.result.createObjectStore('commands', { keyPath: 'id' });
      if (!request.result.objectStoreNames.contains('documents')) request.result.createObjectStore('documents', { keyPath: 'id' });
      if (!request.result.objectStoreNames.contains('submissions')) request.result.createObjectStore('submissions', { keyPath: 'intent' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { database = undefined; reject(request.error); };
  });
}
async function read<T>(store: string, key?: string): Promise<T> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(store, 'readonly');
    const request = key ? transaction.objectStore(store).get(key) : transaction.objectStore(store).getAll();
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}
async function write(store: string, value: unknown, remove = false) {
  const database = await db();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(store, 'readwrite');
    if (remove) transaction.objectStore(store).delete(value as IDBValidKey); else transaction.objectStore(store).put(value);
    transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error); transaction.onerror = () => reject(transaction.error);
  });
}
export const image2Storage: QueueStorage = {
  list: async id => (await read<QueuedBatch[]>('commands')).filter(batch => batch.documentId === id).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
  put: batch => write('commands', batch), remove: id => write('commands', id, true),
  saveDocument: document => write('documents', document),
};
export const cachedDocument = (id: string) => read<ImageDocument | undefined>('documents', id);
export const cachedDocuments = () => read<ImageDocument[]>('documents');
export const submissionStorage: SubmissionStorage = {
  getOrCreate: async proposed => {
    const database = await db();
    return new Promise<SubmissionAttempt>((resolve, reject) => {
      const transaction = database.transaction('submissions', 'readwrite'), store = transaction.objectStore('submissions');
      const request = store.get(proposed.intent); let result = proposed;
      request.onsuccess = () => { if (request.result) result = request.result; else store.put(proposed); };
      transaction.oncomplete = () => resolve(result); transaction.onabort = () => reject(transaction.error); transaction.onerror = () => reject(transaction.error);
    });
  },
  remove: intent => write('submissions', intent, true), list: () => read<SubmissionAttempt[]>('submissions'),
};
