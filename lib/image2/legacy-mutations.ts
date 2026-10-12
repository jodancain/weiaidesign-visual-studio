import { submissionIntent, type SubmissionAttempt, type SubmissionStorage } from './submissions';
import { submissionStorage } from './storage';
import type { ImageDocument } from './types';

export const LEGACY_MUTATION_PREFIX = 'legacy-doc-mutation:';
export interface LegacyMutationIntent {
  documentId: string;
  direction?: 'undo' | 'redo';
  branchId?: string;
  branchDocumentId?: string;
}
export interface LegacyMutationBody {
  baseRevision: number;
  commandId?: string;
  direction?: 'undo' | 'redo';
  branchDocumentId?: string;
  [key: string]: unknown;
}
export type LegacyMutationTransport = (path: string, body: Record<string, unknown>) => Promise<unknown>;

/** History/accept receipts contain documents; keep them apart from charged job receipts. */
export function getMutationsStorage(base: SubmissionStorage = submissionStorage): SubmissionStorage {
  return {
    getOrCreate: attempt => {
      if (!attempt.intent.startsWith(LEGACY_MUTATION_PREFIX)) throw new Error('原工程修改草稿必须使用独立命名空间');
      return base.getOrCreate(attempt);
    },
    remove: intent => {
      if (!intent.startsWith(LEGACY_MUTATION_PREFIX)) throw new Error('不能清理其他类型的提交草稿');
      return base.remove(intent);
    },
    list: async () => (await base.list()).filter(attempt => attempt.intent.startsWith(LEGACY_MUTATION_PREFIX)),
  };
}

function acknowledgement(value: unknown, attempt: SubmissionAttempt): ImageDocument {
  const result = value && typeof value === 'object' && 'document' in value ? (value as { document: unknown }).document : value;
  const document = result as ImageDocument | undefined;
  const minimumRevision=Number(attempt.body.baseRevision)+(attempt.path.endsWith('/history')?1:0);
  if (!document || document.id !== attempt.documentId || document.schemaVersion !== 2 || !Number.isSafeInteger(document.revision) || document.revision < minimumRevision || !Array.isArray(document.layers) || !Array.isArray(document.assetIds)) throw new Error('工程修改回执尚未完整，原请求已保留；请恢复确认结果');
  return document;
}

/** Freeze the first baseRevision+commandId until a verified server receipt arrives. */
export class LegacyDocumentMutationManager {
  private running = new Map<string, Promise<ImageDocument>>();
  constructor(private storage: SubmissionStorage, private transport: LegacyMutationTransport) {}
  submit(path: string, intent: LegacyMutationIntent, body: LegacyMutationBody): Promise<ImageDocument> {
    const route = /^\/documents\/([^/]+)\/(history|accept)$/.exec(path);
    if (!route || decodeURIComponent(route[1]) !== intent.documentId || !Number.isSafeInteger(body.baseRevision) || body.baseRevision < 0) return Promise.reject(new Error('原工程修改目标或版本无效'));
    if (route[2] === 'history' && (!['undo','redo'].includes(String(body.direction)) || intent.direction !== body.direction) || route[2] === 'accept' && (typeof body.branchDocumentId !== 'string' || !body.branchDocumentId || (intent.branchId || intent.branchDocumentId) !== body.branchDocumentId)) return Promise.reject(new Error('原工程修改意图与请求不一致'));
    const attempt: SubmissionAttempt = {
      intent: `${LEGACY_MUTATION_PREFIX}${submissionIntent(path, intent as unknown as Record<string, unknown>)}`,
      path,documentId:intent.documentId,body:structuredClone({...body,commandId:body.commandId || crypto.randomUUID()}),createdAt:Date.now(),
    };
    return this.run(attempt);
  }
  private run(attempt: SubmissionAttempt): Promise<ImageDocument> {
    const active = this.running.get(attempt.intent); if (active) return active;
    const request = this.execute(attempt).finally(() => this.running.delete(attempt.intent));
    this.running.set(attempt.intent, request); return request;
  }
  private async execute(proposed: SubmissionAttempt): Promise<ImageDocument> {
    const attempt = await this.storage.getOrCreate(proposed);
    try {
      const document = acknowledgement(await this.transport(attempt.path, attempt.body), attempt);
      await this.storage.remove(attempt.intent); return document;
    } catch (error) {
      const status = (error as {status?:number}).status;
      // A timeout/rate-limit response is retained conservatively. Definite client
      // rejection can be corrected and submitted with a new command identity.
      if (status && status >= 400 && status < 500 && ![408,429].includes(status)) await this.storage.remove(attempt.intent);
      throw error;
    }
  }
  async pending(documentId?: string): Promise<SubmissionAttempt[]> {
    return (await this.storage.list()).filter(attempt => attempt.intent.startsWith(LEGACY_MUTATION_PREFIX) && (!documentId || attempt.documentId === documentId)).sort((a,b) => a.createdAt - b.createdAt || a.intent.localeCompare(b.intent));
  }
  async recover(documentId: string, onDocument: (document: ImageDocument) => void): Promise<void> {
    for (const attempt of await this.pending(documentId)) onDocument(await this.run(attempt));
  }
}
