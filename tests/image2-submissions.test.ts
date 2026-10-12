import test from 'node:test';
import assert from 'node:assert/strict';
import { ImageSubmissionManager, type SubmissionAttempt, type SubmissionStorage } from '../lib/image2/submissions';
class MemorySubmissions implements SubmissionStorage {
  records = new Map<string, SubmissionAttempt>();
  async getOrCreate(proposed: SubmissionAttempt) { const saved = this.records.get(proposed.intent); if (saved) return structuredClone(saved); this.records.set(proposed.intent, structuredClone(proposed)); return structuredClone(proposed); }
  async remove(intent: string) { this.records.delete(intent); }
  async list() { return [...this.records.values()].map(item => structuredClone(item)); }
}
test('lost operation/export/chat receipts freeze the complete body across retry and reload', async () => {
  for (const path of ['/operations', '/exports', '/conversations/conversation/messages']) {
    const storage = new MemorySubmissions(), calls: Record<string, unknown>[] = [];
    const transport = async (_path: string, body: Record<string, unknown>) => { calls.push(structuredClone(body)); if (calls.length === 1) throw new Error('receipt lost'); return { job: { id: '29d2212e-9d41-4d8d-a212-6101a8f54576' } }; };
    const first = new ImageSubmissionManager(storage, transport), intent = { documentId: 'doc', action: 'same', params: { color: '#f00', width: 80 } };
    const body = { documentId: 'doc', baseRevision: 4, inputs: [{ role: 'base', assetId: 'original' }], params: intent.params };
    await assert.rejects(first.submit(path, intent, body), /lost/); body.inputs[0].assetId = 'mutated';
    const reloaded = new ImageSubmissionManager(storage, transport);
    await reloaded.submit(path, { params: { width: 80, color: '#f00' }, action: 'same', documentId: 'doc' }, { baseRevision: 99, inputs: [{ assetId: 'new' }] });
    assert.deepEqual(calls[1], calls[0]); assert.equal(calls[1].baseRevision, 4); assert.deepEqual(calls[1].inputs, [{ role: 'base', assetId: 'original' }]);
    assert.equal((await reloaded.pending('doc')).length, 0); assert.ok(calls[0].idempotencyKey);
  }
});
test('server failure and incomplete success retain the attempt; explicit 4xx removes it', async () => {
  const storage = new MemorySubmissions(); let outcome: unknown = Object.assign(new Error('gateway'), { status: 502 });
  const manager = new ImageSubmissionManager(storage, async () => { if (outcome instanceof Error) throw outcome; return outcome; });
  const post = () => manager.submit('/operations', { documentId: 'doc' }, { documentId: 'doc', baseRevision: 2 });
  await assert.rejects(post(), /gateway/); assert.equal((await manager.pending()).length, 1);
  outcome = { job: {} }; await assert.rejects(post(), /回执/); assert.equal((await manager.pending()).length, 1);
  const frozen = (await manager.pending())[0].body;
  for (const id of ['', ' ', 'incomplete-id']) {
    outcome = { job: { id } }; await assert.rejects(post(), /回执/);
    assert.deepEqual((await manager.pending())[0].body, frozen);
  }
  outcome = Object.assign(new Error('not accepted'), { status: 422 }); await assert.rejects(post(), /not accepted/); assert.equal((await manager.pending()).length, 0);
});
test('concurrent clicks share one request; recovery reuses the immutable saved attempt', async () => {
  const storage = new MemorySubmissions(); let requests = 0, resolve!: (value: unknown) => void;
  const manager = new ImageSubmissionManager(storage, async () => { requests++; return new Promise(accept => { resolve = accept; }); });
  const one = manager.submit('/exports', { documentId: 'doc', format: 'png' }, { documentId: 'doc', baseRevision: 7 });
  const two = manager.submit('/exports', { format: 'png', documentId: 'doc' }, { baseRevision: 8 });
  await new Promise(accept => setTimeout(accept, 0)); assert.equal(requests, 1); resolve({ job: { id: 'b541701a-d5b5-4721-881c-c28e30d1b432' } }); assert.deepEqual(await one, await two);
  const failing = new ImageSubmissionManager(storage, async () => { throw new Error('offline'); });
  await assert.rejects(failing.submit('/operations', { documentId: 'doc' }, { documentId: 'doc', baseRevision: 12 }), /offline/);
  const saved = (await storage.list())[0], replay: SubmissionAttempt[] = [];
  await new ImageSubmissionManager(storage, async (path, body) => { replay.push({ ...saved, path, body }); return { run: { id: '51e0ce6c-f719-43c2-949f-e2a0424f821e' } }; }).recover('doc', () => {});
  assert.deepEqual(replay, [saved]); assert.equal((await storage.list()).length, 0);
});
test('HTTP timeout and rate-limit outcomes retain charged submissions across reload without a new key', async () => {
  for (const path of ['/operations', '/conversations/conversation/messages']) for (const status of [408, 429]) {
    const storage = new MemorySubmissions(), calls: Record<string, unknown>[] = [];
    const original = { documentId: 'doc', baseRevision: 3, text: 'preserve original request', inputs: [{ role: 'base', assetId: 'original' }] };
    const transport = async (_path: string, body: Record<string, unknown>) => {
      calls.push(structuredClone(body));
      if (calls.length === 1) throw Object.assign(new Error('response outcome unknown'), { status });
      return { job: { id: '29d2212e-9d41-4d8d-a212-6101a8f54576' } };
    };
    await assert.rejects(new ImageSubmissionManager(storage, transport).submit(path, { documentId: 'doc', action: 'same' }, original), /outcome unknown/);
    const saved = (await storage.list())[0];
    assert.ok(saved, `HTTP ${status} must preserve the pending request`);
    assert.deepEqual(saved.body, calls[0]);
    await new ImageSubmissionManager(storage, transport).resume(saved);
    assert.deepEqual(calls[1], calls[0]);
    assert.equal(calls[1].idempotencyKey, calls[0].idempotencyKey);
    assert.equal((await storage.list()).length, 0);
  }
});
export { MemorySubmissions };

test('an advanced canvas resumes the stored operation directly before inventing a new reference intent', async () => {
  const storage = new MemorySubmissions(), body = { documentId: 'doc', baseRevision: 5, operation: 'generate', inputs: [{ role: 'base', assetId: 'original-version' }], params: { prompt: 'same request' } };
  await assert.rejects(new ImageSubmissionManager(storage, async () => { throw new Error('receipt lost'); }).submit('/operations', { documentId: 'doc', reference: 'original-version' }, body));
  const saved = (await storage.list())[0], calls: unknown[] = [];
  const advancedCanvas = { baseRevision: 12, assetId: 'newer-version' };
  const reloaded = new ImageSubmissionManager(storage, async (path, request) => { calls.push({ path, request }); return { job: { id: '29d2212e-9d41-4d8d-a212-6101a8f54576' } }; });
  await reloaded.resume(saved);
  assert.deepEqual(calls, [{ path: '/operations', request: saved.body }]);
  assert.equal(saved.body.baseRevision, 5); assert.deepEqual(saved.body.inputs, [{ role: 'base', assetId: 'original-version' }]);
  assert.deepEqual(advancedCanvas, { baseRevision: 12, assetId: 'newer-version' }); assert.equal((await reloaded.pending()).length, 0);
});
