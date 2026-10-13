import { submissionIntent, type SubmissionStorage } from './submissions';
import type { ImageDocument } from './types';
export const MIGRATION_PREFIX = 'professional-migration:';
export interface MigrationResult { document: ImageDocument; sourceDocumentId: string; sourceRevision: number; mappings: {layers:Record<string,string>;auxiliary?:Record<string,unknown>;assets:Record<string,string>}; receipt: unknown }
/** Copy migration is frozen separately from charged jobs and document history. */
export class ProfessionalMigrationManager {
  constructor(private storage: SubmissionStorage, private transport: (path:string,body:Record<string,unknown>)=>Promise<unknown>) {}
  async migrate(source: ImageDocument, onCopy: (result:MigrationResult)=>Promise<void>) {
    const path = `/documents/${source.id}/migrate-v3`, intent = MIGRATION_PREFIX + submissionIntent(path,{documentId:source.id,sourceRevision:source.revision});
    const attempt = await this.storage.getOrCreate({intent,path,documentId:source.id,body:{sourceRevision:source.revision,idempotencyKey:crypto.randomUUID()},createdAt:Date.now()});
    return this.resume(attempt,onCopy);
  }
  async recover(sourceId:string,onCopy:(result:MigrationResult)=>Promise<void>) {
    for (const attempt of (await this.storage.list()).filter(item=>item.intent.startsWith(MIGRATION_PREFIX)&&item.documentId===sourceId)) await this.resume(attempt,onCopy);
  }
  private async resume(attempt: Awaited<ReturnType<SubmissionStorage['getOrCreate']>>, onCopy:(result:MigrationResult)=>Promise<void>) {
    try {
      const result = await this.transport(attempt.path,attempt.body) as MigrationResult;
      if (!result?.document || result.document.schemaVersion !== 3 || result.sourceDocumentId !== attempt.documentId || result.sourceRevision !== attempt.body.sourceRevision || result.document.id === attempt.documentId || !result.mappings || !result.receipt) throw new Error('复制升级回执不完整，原请求已保留');
      await onCopy(result); await this.storage.remove(attempt.intent); return result;
    } catch(error) {
      const status=(error as {status?:number}).status;
      if(status&&status>=400&&status<500&&![408,429].includes(status))await this.storage.remove(attempt.intent);
      throw error;
    }
  }
}
