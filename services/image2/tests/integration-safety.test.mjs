import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImageStore } from '../store.mjs';
import { ImageRunner } from '../jobs.mjs';
import { ImageError } from '../domain.mjs';

const OWNER = '11111111-1111-4111-8111-111111111111';
const config = { agent: { baseUrl: 'https://fixture.invalid', apiKey: 'synthetic-only', models: ['fixture'], timeoutMs: 1000 } };
async function waitFor(check) {
  for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('fixture state did not settle');
}
function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'image2-safety-')), store = new ImageStore(directory);
  const runner = new ImageRunner({ store, config, fetchImpl: async () => { throw new Error('network forbidden by fixture'); }, ...options });
  t.after(async () => { await runner.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, runner };
}

test('cancellation while the last LLM response is outstanding cannot complete the job or run', async t => {
  let resolveResponse;
  const response = new Promise(resolve => { resolveResponse = resolve; }); let requests = 0;
  const f = fixture(t, { fetchImpl: async url => { assert.ok(String(url).endsWith('/chat/completions')); requests++; return response; } });
  const document = f.store.createDocument(OWNER, {}), conversation = f.store.createConversation(OWNER, { documentId: document.id });
  const { job, run } = await f.runner.submitRun(OWNER, conversation.id, { text: '取消夹具', references: [], idempotencyKey: 'cancel-last-reply' });
  f.runner.start(); await waitFor(() => f.store.jobRecord(job.id).private.agentState?.phase === 'llm_submitting');
  f.runner.cancel(OWNER, job.id);
  resolveResponse(Response.json({ choices: [{ message: { role: 'assistant', content: '夹具回复' } }] }));
  await waitFor(() => !f.runner.active.size);
  assert.equal(requests, 1); assert.equal(f.store.getJob(job.id, OWNER).state, 'cancelled'); assert.equal(f.store.getRun(run.id, OWNER).state, 'cancelled');
  assert.equal(f.store.getDocument(document.id, OWNER).revision, 0);
});

test('candidate initialization failure rolls back job, snapshot and branch together; retry never applies to main', async t => {
  const f = fixture(t, { processor: async () => ({ commands: [{ type: 'document.update', patch: { name: 'candidate-only' } }] }) });
  const document = f.store.createDocument(OWNER, { name: 'main-original' });
  const request = { documentId: document.id, baseRevision: 0, operation: 'resize', params: { width: 10, height: 10 }, inputs: [], mode: 'candidate', idempotencyKey: 'atomic-candidate' };
  const createBranch = f.store.createBranch.bind(f.store);
  f.store.createBranch = (...args) => { createBranch(...args); throw new ImageError('injected post-branch failure', 500); };
  await assert.rejects(f.runner.submit(OWNER, request), /injected/);
  f.store.createBranch = createBranch;
  assert.equal(f.store.listJobs(document.id, OWNER).length, 0); assert.equal(f.store.listBranches(document.id, OWNER).length, 0);
  assert.equal(f.store.getDocument(document.id, OWNER).name, 'main-original');
  const job = await f.runner.submit(OWNER, request); const again = await f.runner.submit(OWNER, request); assert.equal(again.id, job.id);
  f.runner.start(); await waitFor(() => f.store.getJob(job.id, OWNER).state === 'complete');
  assert.equal(f.store.getDocument(document.id, OWNER).name, 'main-original');
  assert.equal(f.store.listBranches(document.id, OWNER).length, 1);
  assert.equal(f.store.listBranches(document.id, OWNER)[0].name, 'candidate-only');
});

test('agent initialization failure leaves no orphan run, message, branch or queued job', async t => {
  const f = fixture(t), document = f.store.createDocument(OWNER, {}), conversation = f.store.createConversation(OWNER, { documentId: document.id });
  const createJob = f.store.createJob.bind(f.store);
  f.store.createJob = (...args) => { createJob(...args); throw new ImageError('injected job commit failure', 500); };
  await assert.rejects(f.runner.submitRun(OWNER, conversation.id, { text: 'atomic run', references: [], idempotencyKey: 'atomic-run' }), /injected/);
  f.store.createJob = createJob;
  assert.equal(f.store.listRuns(document.id, OWNER).length, 0); assert.equal(f.store.listMessages(conversation.id, OWNER).length, 0);
  assert.equal(f.store.listBranches(document.id, OWNER).length, 0); assert.equal(f.store.listJobs(document.id, OWNER).length, 0);
});

test('stale export submission cannot leave a queued job with no frozen document', async t => {
  const f = fixture(t), document = f.store.createDocument(OWNER, {});
  f.store.command(document.id, OWNER, { baseRevision: 0, commandId: 'human-edit', commands: [{ type: 'document.update', patch: { name: 'new-name' } }] });
  await assert.rejects(f.runner.export(OWNER, { documentId: document.id, format: 'png', idempotencyKey: 'stale-export', baseRevision: 0 }), e => e.code === 'revision_conflict');
  assert.equal(f.store.listJobs(document.id, OWNER).length, 0);
});

test('resume after command commit before tool acknowledgement reuses the original command revision', async t => {
  let requests = 0;
  const f = fixture(t, { fetchImpl: async () => { requests++; return Response.json({ choices: [{ message: { role: 'assistant', content: '已保留候选' } }] }); } });
  const document = f.store.createDocument(OWNER, { layers: [{ id: 'text', type: 'text', text: 'before', width: 80, height: 20 }] });
  const conversation = f.store.createConversation(OWNER, { documentId: document.id });
  const { job } = await f.runner.submitRun(OWNER, conversation.id, { text: '修改文字', references: [], idempotencyKey: 'resume-command' });
  const branchId = f.store.jobRecord(job.id).private.branchDocumentId, namespace = 'tool_1_0';
  const commands = [{ type: 'layer.update', layerId: 'text', patch: { text: 'after' } }];
  const call = { id: 'persisted-call', type: 'function', function: { name: 'apply_commands', arguments: JSON.stringify({ commands }) } };
  f.store.updateJob(job.id, { state: 'running' }, { agentCommandBases: { [namespace]: 0 }, agentState: { phase: 'received', round: 1, tools: 0, generations: 0, chargedCalls: [], messages: [{ role: 'user', content: '修改文字' }, { role: 'assistant', tool_calls: [call] }], pending: [call], callIndex: 0 } });
  f.store.command(branchId, OWNER, { baseRevision: 0, commandId: `${job.id}:${namespace}`, commands });
  // A restart now finds the edit committed but the tool acknowledgement absent.
  f.runner.start(); await waitFor(() => f.store.getJob(job.id, OWNER).state === 'complete');
  assert.equal(f.store.getDocument(branchId, OWNER).revision, 1); assert.equal(f.store.getDocument(branchId, OWNER).layers[0].text, 'after');
  assert.equal(f.store.jobRecord(job.id).private.toolOutputs[namespace].error, undefined); assert.equal(requests, 1);
  assert.equal(f.store.getDocument(document.id, OWNER).layers[0].text, 'before');
});
