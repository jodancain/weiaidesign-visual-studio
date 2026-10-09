import test from 'node:test';
import assert from 'node:assert/strict';
import { submitJobWithReceipt } from '../lib/studio/job-attempt';

test('lost receipt survives reload and retries the same paid attempt, then permits an explicit new candidate', async () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) || null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  const seen: string[] = [];
  await assert.rejects(submitJobWithReceipt(storage, 'project:shot:approved-hash', async key => { seen.push(key); throw new Error('connection closed after provider acceptance'); }, () => 'attempt-1'));
  const result = await submitJobWithReceipt(storage, 'project:shot:approved-hash', async key => { seen.push(key); return { id: 'the-original-job' }; }, () => 'must-not-be-used');
  assert.equal(result.id, 'the-original-job');
  assert.deepEqual(seen, ['attempt-1', 'attempt-1']);
  assert.equal(values.size, 0);
  await submitJobWithReceipt(storage, 'project:shot:approved-hash', async key => { seen.push(key); return {}; }, () => 'attempt-2');
  assert.deepEqual(seen, ['attempt-1', 'attempt-1', 'attempt-2']);
});
