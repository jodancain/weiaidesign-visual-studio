import type { ImageDocument } from './types';

export interface LegacyCanvasSnapshot {
  store: Record<string, unknown>;
  schema?: unknown;
  [key: string]: unknown;
}
export interface LegacyFrozenRequest {
  path: string;
  body: Record<string, unknown>;
  intent?: string;
  idempotencyKey?: string;
}
export interface LegacyCanvasDraft {
  projectId: string;
  documentId: string;
  baseRevision: number;
  snapshot: LegacyCanvasSnapshot;
  savedAt: number;
  frozenRequests?: LegacyFrozenRequest[];
}
export type LegacyDraftDisposition = 'none' | 'resume' | 'revision_conflict' | 'document_mismatch';
export interface LegacyDraftIdentity { documentId: string; baseRevision: number; savedAt: number }
export interface LegacyDraftStorage {
  put(draft: LegacyCanvasDraft): Promise<void>;
  read(projectId: string): Promise<LegacyCanvasDraft | undefined>;
  remove(projectId: string, expected?: LegacyDraftIdentity): Promise<void>;
}

let timestamp = 0;
/** Capture synchronously before any upload/network/IDB await or pagehide. */
export function createLegacyCanvasDraft(input: Omit<LegacyCanvasDraft, 'savedAt'>): LegacyCanvasDraft {
  timestamp = Math.max(Date.now(), timestamp + 1);
  return cloneLegacyDraft({ ...input, savedAt: timestamp });
}
export function cloneLegacyDraft(draft: LegacyCanvasDraft): LegacyCanvasDraft {
  if (!draft || typeof draft.projectId !== 'string' || !draft.projectId || typeof draft.documentId !== 'string' || !draft.documentId || !Number.isSafeInteger(draft.baseRevision) || draft.baseRevision < 0 || !Number.isSafeInteger(draft.savedAt) || draft.savedAt < 0 || !draft.snapshot || typeof draft.snapshot !== 'object' || !draft.snapshot.store || typeof draft.snapshot.store !== 'object' || Array.isArray(draft.snapshot.store)) throw new Error('原画布草稿标识或快照无效');
  // Submission bodies are not regenerated or assigned a new idempotency key.
  return structuredClone(draft);
}
export function classifyLegacyDraft(draft: LegacyCanvasDraft | undefined, server: Pick<ImageDocument, 'id' | 'revision'>): LegacyDraftDisposition {
  if (!draft) return 'none';
  if (draft.documentId !== server.id) return 'document_mismatch';
  return draft.baseRevision === server.revision ? 'resume' : 'revision_conflict';
}
export function matchesLegacyDraft(draft: LegacyCanvasDraft, expected: LegacyDraftIdentity) {
  return draft.documentId === expected.documentId && draft.baseRevision === expected.baseRevision && draft.savedAt === expected.savedAt;
}

let database: Promise<IDBDatabase> | undefined;
function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('本机浏览器不支持保存原画布草稿'));
  return database ||= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('image-studio-original-drafts', 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('drafts')) request.result.createObjectStore('drafts', { keyPath: 'projectId' });
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); database = undefined; };
      resolve(db);
    };
    request.onerror = () => { database = undefined; reject(request.error || new Error('原画布草稿数据库不可用')); };
    request.onblocked = () => { database = undefined; reject(new Error('原画布草稿数据库被其他标签页阻塞')); };
  });
}
function transaction(db: IDBDatabase, mode: IDBTransactionMode) {
  if (mode !== 'readwrite') return db.transaction('drafts', mode);
  try { return db.transaction('drafts', mode, { durability: 'strict' }); }
  catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return db.transaction('drafts', mode);
  }
}

/** Separate DB: creating canvas drafts cannot upgrade/erase command or submission ledgers. */
export const legacyDraftStorage: LegacyDraftStorage = {
  put: async input => {
    const draft = cloneLegacyDraft(input), db = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = transaction(db, 'readwrite'), store = tx.objectStore('drafts'), request = store.get(draft.projectId);
      request.onsuccess = () => {
        const previous = request.result as LegacyCanvasDraft | undefined;
        if (!previous || previous.savedAt <= draft.savedAt) store.put(draft);
      };
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(tx.error || new Error('原画布草稿保存失败'));
    });
  },
  read: async projectId => {
    const db = await openDatabase();
    return new Promise<LegacyCanvasDraft | undefined>((resolve, reject) => {
      const tx = transaction(db, 'readonly'), request = tx.objectStore('drafts').get(projectId);
      let draft: LegacyCanvasDraft | undefined;
      request.onsuccess = () => { draft = request.result; };
      tx.oncomplete = () => { try { resolve(draft ? cloneLegacyDraft(draft) : undefined); } catch (error) { reject(error); } };
      tx.onabort = tx.onerror = () => reject(tx.error || new Error('原画布草稿读取失败'));
    });
  },
  remove: async (projectId, expected) => {
    const db = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = transaction(db, 'readwrite'), store = tx.objectStore('drafts');
      if (!expected) store.delete(projectId);
      else {
        const request = store.get(projectId);
        request.onsuccess = () => {
          const current = request.result as LegacyCanvasDraft | undefined;
          if (current && matchesLegacyDraft(current, expected)) store.delete(projectId);
        };
      }
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(tx.error || new Error('原画布草稿清理失败'));
    });
  },
};
