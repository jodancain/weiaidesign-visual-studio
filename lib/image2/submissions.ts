export interface SubmissionAttempt {
  intent: string; path: string; documentId?: string; body: Record<string, unknown>; createdAt: number;
}
export interface SubmissionStorage {
  getOrCreate(attempt: SubmissionAttempt): Promise<SubmissionAttempt>;
  remove(intent: string): Promise<void>; list(): Promise<SubmissionAttempt[]>;
}
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().filter(key => (value as Record<string, unknown>)[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
};
export function submissionIntent(path: string, intent: Record<string, unknown>) { return canonical({ path, intent }); }
function hasReceipt(value: unknown) {
  if (!value || typeof value !== 'object') return false;
  const receipt = value as { job?: { id?: unknown }; run?: { id?: unknown } };
  const validId = (id: unknown) => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
  return validId(receipt.job?.id) || validId(receipt.run?.id);
}
/** Charged/substantial submissions retain the complete first body until a durable receipt arrives. */
export class ImageSubmissionManager {
  private running = new Map<string, Promise<unknown>>();
  constructor(private storage: SubmissionStorage, private transport: (path: string, body: Record<string, unknown>) => Promise<unknown>) {}
  submit<T>(path: string, intent: Record<string, unknown>, body: Record<string, unknown>): Promise<T> {
    return this.run({ intent: submissionIntent(path, intent), path, documentId: String(intent.documentId || body.documentId || '') || undefined,
      body: structuredClone({ ...body, idempotencyKey: body.idempotencyKey || crypto.randomUUID() }), createdAt: Date.now() }) as Promise<T>;
  }
  private run(attempt: SubmissionAttempt) {
    const current = this.running.get(attempt.intent); if (current) return current;
    const run = this.execute(attempt).finally(() => this.running.delete(attempt.intent)); this.running.set(attempt.intent, run); return run;
  }
  private async execute(proposed: SubmissionAttempt) {
    const attempt = await this.storage.getOrCreate(proposed);
    try {
      const result = await this.transport(attempt.path, attempt.body);
      if (!hasReceipt(result)) throw new Error('提交回执尚未完整，原请求已保留；请恢复提交确认结果');
      await this.storage.remove(attempt.intent); return result;
    } catch (error) {
      const status = (error as { status?: number }).status;
      // Timeouts and rate-limit responses can hide an accepted upstream request.
      // Preserve its identity until the server returns a durable receipt.
      if (status && status >= 400 && status < 500 && ![408, 429].includes(status)) await this.storage.remove(attempt.intent);
      throw error;
    }
  }
  pending(documentId?: string) { return this.storage.list().then(list => documentId ? list.filter(item => item.documentId === documentId) : list); }
  /** Resume a stored attempt itself, even when the live document/reference set has advanced. */
  resume<T>(attempt: SubmissionAttempt): Promise<T> { return this.run(structuredClone(attempt)) as Promise<T>; }
  async recover(documentId: string, onReceipt: (receipt: unknown) => void) {
    for (const attempt of await this.pending(documentId)) onReceipt(await this.run(attempt));
  }
}
