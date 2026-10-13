import type { DocumentCommand, ImageDocument } from './types';
import { applyProfessionalDraft } from './professional-model';
export interface QueuedBatch {
  id: string; documentId: string; commands: DocumentCommand[]; createdAt: number;
  submittedRevision?: number; state: 'queued' | 'blocked'; error?: string;
}
export interface QueueStorage {
  list(documentId: string): Promise<QueuedBatch[]>;
  put(batch: QueuedBatch): Promise<void>; remove(id: string): Promise<void>;
  saveDocument(document: ImageDocument): Promise<void>;
}
export type CommandTransport = (documentId: string, body: { baseRevision: number; commandId: string; commands: DocumentCommand[] }) => Promise<ImageDocument>;
/** Frozen baseRevision + commandId allow safe resumption after an unknown HTTP outcome. */
export class ImageCommandQueue {
  private running = new Map<string, Promise<ImageDocument>>();
  private timestamp = 0;
  constructor(private storage: QueueStorage, private transport: CommandTransport) {}
  async enqueue(documentId: string, commands: DocumentCommand[]) {
    this.timestamp = Math.max(Date.now(), this.timestamp + 1);
    const batch: QueuedBatch = { id: crypto.randomUUID(), documentId, commands, createdAt: this.timestamp, state: 'queued' };
    await this.storage.put(batch); return batch;
  }
  pending(documentId: string) { return this.storage.list(documentId); }
  async discard(documentId: string) { for (const batch of await this.pending(documentId)) await this.storage.remove(batch.id); }
  flush(document: ImageDocument, onDocument: (document: ImageDocument) => void) {
    const active = this.running.get(document.id); if (active) return active;
    const promise = this.drain(document, onDocument).finally(() => this.running.delete(document.id));
    this.running.set(document.id, promise); return promise;
  }
  private async drain(document: ImageDocument, onDocument: (document: ImageDocument) => void) {
    let current = document;
    while (true) {
      const batch = (await this.pending(document.id))[0]; if (!batch || batch.state === 'blocked') return current;
      if (batch.submittedRevision === undefined) { batch.submittedRevision = current.revision; await this.storage.put(batch); }
      try {
        current = await this.transport(document.id, { baseRevision: batch.submittedRevision, commandId: batch.id, commands: batch.commands });
        await this.storage.saveDocument(current);
        await this.storage.remove(batch.id); onDocument(current);
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (status === 409 || (status && status >= 400 && status < 500 && status !== 429)) {
          batch.state = 'blocked'; batch.error = (error as Error).message; await this.storage.put(batch);
        }
        throw error;
      }
    }
  }
}
/** Projection only. Never pretend an optimistic draft is an accepted server revision. */
export function applyDraft(document: ImageDocument, batches: QueuedBatch[]): ImageDocument {
  if (document.schemaVersion===3) return applyProfessionalDraft(document,batches);
  const result = structuredClone(document);
  for (const batch of batches) for (const command of batch.commands) {
    if (command.type === 'document.update') Object.assign(result, command.patch);
    // ACK may update the canonical document one render before the durable queue is removed.
    if (command.type === 'layer.add' && !result.layers.some(layer => layer.id === command.layer.id)) result.layers.push(command.layer);
    if (command.type === 'layer.remove') {
      const removed = new Set([command.layerId]); let previous = -1;
      while (previous !== removed.size) { previous = removed.size; for (const layer of result.layers) if (layer.parentId && removed.has(layer.parentId)) removed.add(layer.id); }
      result.layers = result.layers.filter(layer => !removed.has(layer.id));
    }
    if (command.type === 'layer.update') { const layer = result.layers.find(item => item.id === command.layerId); if (layer) Object.assign(layer, command.patch); }
    if (command.type === 'layer.reorder') command.layerIds.forEach((id, z) => { const layer = result.layers.find(item => item.id === id); if (layer) layer.z = z; });
  }
  return result;
}
