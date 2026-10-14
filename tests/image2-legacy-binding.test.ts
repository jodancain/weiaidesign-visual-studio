import test from 'node:test';
import assert from 'node:assert/strict';
import { LegacyBindingInitialization, findPendingLegacyCreation, recoverOrCreateLegacyDocument, assertLegacyRecoveryCanvas } from '../lib/image2/legacy-binding';
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const scope = () => ({ projectId: 'project', editor: {} });

test('early layers and versions actions wait for the mapped revision instead of creating an empty document', async () => {
  const gate = new LegacyBindingInitialization(), key = scope(), held = deferred();
  const original = { id: 'original', revision: 4, text: '中文验收', fontSize: 44 };
  let current: typeof original | null = null, creates = 0;
  const loading = gate.begin(key, async () => { await held.promise; current = original; });
  const create = async () => { creates++; return { ...original, id: 'empty', revision: 0 }; };
  const first = gate.ensure(key, () => current, create), second = gate.ensure(key, () => current, create);
  await Promise.resolve(); assert.equal(creates, 0); held.resolve(); await loading;
  assert.equal(await first, original); assert.equal(await second, original); assert.equal(creates, 0);
});

test('capability or document lookup failure is never interpreted as an empty project', async () => {
  for (const stage of ['capabilities', 'mapped document', 'document list']) {
    const gate = new LegacyBindingInitialization(), key = scope(); let creates = 0;
    await assert.rejects(gate.begin(key, async () => { throw new Error(stage); }), new RegExp(stage));
    await assert.rejects(gate.ensure(key, () => null, async () => { creates++; return {}; }), new RegExp(stage));
    assert.equal(creates, 0);
  }
});

test('a real empty project creates once for simultaneous toolbar actions', async () => {
  const gate = new LegacyBindingInitialization(), key = scope(), held = deferred(); let creates = 0;
  await gate.begin(key, async () => {});
  const create = async () => { creates++; await held.promise; return { id: 'one' }; };
  const first = gate.ensure(key, () => null, create), second = gate.ensure(key, () => null, create);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(creates, 1); held.resolve();
  assert.equal(await first, await second);
});

test('late initialization and old editor actions cannot create in a switched project', async () => {
  const gate = new LegacyBindingInitialization(), old = scope(), held = deferred(); let creates = 0;
  const loading = gate.begin(old, () => held.promise);
  const pending = gate.ensure(old, () => null, async () => { creates++; return {}; });
  await Promise.resolve(); gate.clear(); const next = { projectId: 'new', editor: {} }; await gate.begin(next, async () => {});
  held.resolve(); await loading; await assert.rejects(pending, /已切换工程/);
  await assert.rejects(gate.ensure({ ...next, editor: {} }, () => null, async () => { creates++; return {}; }), /尚未连接/);
  assert.equal(creates, 0);
});

test('unknown create response recovers its exact scoped metadata marker without another POST', async () => {
  let marker: string | null = null, posts = 0, stored: { id: string; metadata: Record<string, unknown> } | undefined;
  const bound: string[] = [];
  const options = { projectId: 'project', pending: () => marker, mark: (id: string) => { marker = id; }, clear: () => { marker = null; },
    lookup: async () => [stored!], create: async (id: string) => { posts++; stored = { id: 'accepted', metadata: { legacyProjectId: 'project', legacyCreationId: id } }; throw new Error('response lost'); }, bind: async (document: NonNullable<typeof stored>) => { bound.push(document.id); } };
  await assert.rejects(recoverOrCreateLegacyDocument(options), /response lost/); assert.ok(marker);
  const recovered = await recoverOrCreateLegacyDocument(options);
  assert.equal(recovered.id, 'accepted'); assert.equal(posts, 1); assert.deepEqual(bound, ['accepted']); assert.equal(marker, null);
});

test('unknown create outcome stays pending through empty or failed lookup and never silently adopts unrelated documents', async () => {
  let posts = 0, cleared = false;
  const options = { projectId: 'project', pending: () => 'pending-id', mark: () => {}, clear: () => { cleared = true; }, lookup: async () => [{ metadata: { legacyProjectId: 'other', legacyCreationId: 'pending-id' } }], create: async () => { posts++; return {}; }, bind: async () => {} };
  await assert.rejects(recoverOrCreateLegacyDocument(options), /不会重复新建/);
  await assert.rejects(recoverOrCreateLegacyDocument({ ...options, lookup: async () => { throw new Error('502'); } }), /502/);
  assert.equal(posts, 0); assert.equal(cleared, false);
  assert.throws(() => findPendingLegacyCreation([{ metadata: { legacyProjectId: 'project', legacyCreationId: 'pending-id' } }, { metadata: { legacyProjectId: 'project', legacyCreationId: 'pending-id' } }], 'project', 'pending-id'), /多个/);
});

test('bind failure retains the accepted creation marker and both documents', async () => {
  let marker: string | null = null, posts = 0;
  const records: Array<{ metadata: Record<string, unknown> }> = [];
  const options = { projectId: 'project', pending: () => marker, mark: (id: string) => { marker = id; }, clear: () => { marker = null; }, lookup: async () => records,
    create: async (id: string) => { posts++; const document = { metadata: { legacyProjectId: 'project', legacyCreationId: id } }; records.push(document); return document; }, bind: async () => { throw new Error('binding interrupted'); } };
  await assert.rejects(recoverOrCreateLegacyDocument(options), /binding interrupted/); assert.ok(marker);
  await assert.rejects(recoverOrCreateLegacyDocument(options), /binding interrupted/); assert.equal(posts, 1); assert.equal(records.length, 1);
});

test('StrictMode same-scope begin-clear-begin rejects a stale initialization response', async () => {
  const gate = new LegacyBindingInitialization(), key = scope(), old = deferred(), next = deferred(); let creates = 0;
  const firstLoad = gate.begin(key, () => old.promise);
  const staleAction = gate.ensure(key, () => null, async () => { creates++; return 'wrong'; });
  await Promise.resolve(); gate.clear(); const secondLoad = gate.begin(key, () => next.promise);
  const currentAction = gate.ensure(key, () => 'preserved', async () => { creates++; return 'wrong'; });
  old.resolve(); await firstLoad; await assert.rejects(staleAction, /已切换工程/);
  next.resolve(); await secondLoad; assert.equal(await currentAction, 'preserved'); assert.equal(creates, 0);
});

test('failed initialization cannot authorize recovery to erase an unbound local canvas', () => {
  const local = [{ id: 'native-shape', text: 'unsaved local content' }];
  assert.throws(() => { assertLegacyRecoveryCanvas(false, local.length); local.splice(0); }, /尚未绑定的本地内容/);
  assert.deepEqual(local, [{ id: 'native-shape', text: 'unsaved local content' }]);
  assertLegacyRecoveryCanvas(false, 0);
});
