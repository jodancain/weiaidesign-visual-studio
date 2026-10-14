export interface LegacyBindingScope { projectId: string; editor: unknown }
type Initialization = { scope: LegacyBindingScope; ready: Promise<void>; creating?: Promise<unknown> };

/** A toolbar action must observe the current project's lookup before it may create. */
export class LegacyBindingInitialization {
  private active?: Initialization;
  begin(scope: LegacyBindingScope, load: () => Promise<void>): Promise<void> {
    const entry: Initialization = { scope, ready: Promise.resolve() };
    this.active = entry;
    entry.ready = Promise.resolve().then(() => { this.assert(entry); return load(); });
    // Keep the rejection for waiting actions without an unhandled effect promise.
    void entry.ready.catch(() => {});
    return entry.ready;
  }
  clear() { this.active = undefined; }
  private entry(scope: LegacyBindingScope) {
    const entry = this.active;
    if (!entry || entry.scope.projectId !== scope.projectId || entry.scope.editor !== scope.editor) throw new Error('当前工程尚未连接，请稍后重试');
    return entry;
  }
  private assert(entry: Initialization) {
    if (this.active !== entry) throw new Error('已切换工程，原工程和待确认请求已保留');
  }
  async ready(scope: LegacyBindingScope) {
    const entry = this.entry(scope);
    await entry.ready; this.assert(entry);
  }
  async ensure<T>(scope: LegacyBindingScope, current: () => T | null, create: () => Promise<T>): Promise<T> {
    const entry = this.entry(scope);
    await entry.ready; this.assert(entry);
    const existing = current(); if (existing) return existing;
    if (entry.creating) { const result = await entry.creating as T; this.assert(entry); return result; }
    const pending = Promise.resolve().then(() => { this.assert(entry); return create(); });
    entry.creating = pending;
    try { const result = await pending; this.assert(entry); return result; }
    finally { if (entry.creating === pending) entry.creating = undefined; }
  }
}

export const legacyCreationKey = (projectId: string) => `image2-original-create-pending:${projectId}`;
export function assertLegacyRecoveryCanvas(hasCanonical: boolean, shapeCount: number) {
  if (!hasCanonical && shapeCount > 0) throw new Error('画布有尚未绑定的本地内容，已保留；请先保存或导入后再切换文档');
}
export function findPendingLegacyCreation<T extends { metadata?: Record<string, unknown>; parentDocumentId?: string }>(documents: T[], projectId: string, creationId: string): T | undefined {
  const matches = documents.filter(doc => !doc.parentDocumentId && doc.metadata?.legacyProjectId === projectId && doc.metadata?.legacyCreationId === creationId);
  if (matches.length > 1) throw new Error('发现多个待确认的新建结果，请保留文档并在版本窗口核对');
  return matches[0];
}

export async function recoverOrCreateLegacyDocument<T extends { metadata?: Record<string, unknown>; parentDocumentId?: string }>(options: {
  projectId: string; pending: () => string | null; mark: (id: string) => void; clear: () => void;
  lookup: () => Promise<T[]>; create: (creationId: string) => Promise<T>; bind: (document: T) => Promise<void>;
}): Promise<T> {
  const pending = options.pending();
  let document: T;
  if (pending) {
    const recovered = findPendingLegacyCreation(await options.lookup(), options.projectId, pending);
    if (!recovered) throw new Error('新建工程的结果尚待确认，已保留请求；不会重复新建');
    document = recovered;
  } else {
    const id = crypto.randomUUID(); options.mark(id);
    document = await options.create(id);
    if (document.metadata?.legacyProjectId !== options.projectId || document.metadata?.legacyCreationId !== id) throw new Error('新建回执尚未匹配，已保留请求；不会重复新建');
  }
  await options.bind(document); options.clear(); return document;
}
