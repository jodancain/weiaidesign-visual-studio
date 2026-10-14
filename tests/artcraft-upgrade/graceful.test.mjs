import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createImageService } from '../../services/image2/server.mjs';
import { ImageRunner } from '../../services/image2/jobs.mjs';

test('listener closes before waiting active worker promises; CLI SIGTERM exits 0', async t => {
  const root = mkdtempSync(join(tmpdir(), 'graceful-core-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const service = createImageService({ directory: join(root, 'direct'), token: 'synthetic-no-provider-token-12345', config: {} });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  const address = `http://127.0.0.1:${service.server.address().port}/health`;
  let release; const active = new Promise(resolve => { release = resolve; });
  service.runner.activePromises.add(active);
  let done = false; const closing = service.close().then(() => { done = true; });
  await new Promise(resolve => setTimeout(resolve, 30));
  await assert.rejects(fetch(address)); assert.equal(done, false);
  release(); await closing; assert.equal(done, true);
  const child = spawn(process.execPath, ['services/image2/server.mjs'], { env: {
    PATH: process.env.PATH, IMAGE2_DATA_DIR: join(root, 'child'), IMAGE2_API_TOKEN: 'synthetic-no-provider-token-12345', PORT: '0', HOSTNAME: '127.0.0.1'
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
  await once(child.stdout, 'data'); const exited = once(child, 'exit'); child.kill('SIGTERM');
  assert.deepEqual(await exited, [0, null]);
});

test('verified old recovery code keeps queued/running IDs and guards uncertain submissions', async () => {
  // Verified running old jobs.mjs SHA cdf7bfa9c3ca74e81c33d70d003fa5c69081bb9958030f98af44b056a7b7b24e.
  // Minimal public source excerpt; no dependency on private host audit/report files.
  const old = "  start() {\n    this.stopped = false;\n    for (const id of this.store.pendingJobs()) {\n      const r = this.store.jobRecord(id);\n      if (r.job.state === 'running') {\n        const receipt = r.private.providerReceipt;\n        const agentUnknown = r.private.agentState?.phase === 'llm_submitting';\n        const toolUnknown = Object.values(r.private.toolStates || {}).some(s => s.providerReceipt?.provider === 'image' && s.providerReceipt.phase === 'submitting');\n        if (agentUnknown || toolUnknown || (receipt?.provider === 'image' && receipt.phase === 'submitting')) {\n          this.store.updateJob(id, { state: 'uncertain', stage: 'acceptance_unknown', error: '模型接收状态未知，已停止自动重投', retryable: false });\n          if (r.private.input.runId) this.store.updateRun(r.private.input.runId, { state: 'uncertain', error: '模型接收状态未知，任务分支已保留' });\n        } else this.store.updateJob(id, { state: 'queued', stage: 'resuming' });\n      }\n    }\n    this.timer = setInterval(() => void this.tick(), 200); this.timer.unref(); void this.tick();\n  }\n  async stop() { this.stopped = true; clearInterval(this.timer); await Promise.allSettled([...this.activePromises || []]); }";
  const compact = s => s.replace(/\s+/g, '');
  assert.equal(compact(old), compact(ImageRunner.prototype.start.toString() + ImageRunner.prototype.stop.toString()));
  const jobs = new Map([
    ['queued-id', { job: { state: 'queued' }, private: { input: {} } }],
    ['running-id', { job: { state: 'running' }, private: { input: {} } }],
    ['submitting-id', { job: { state: 'running' }, private: { input: {}, providerReceipt: { provider: 'image', phase: 'submitting' } } }]
  ]);
  const updates = [], runner = Object.create(ImageRunner.prototype);
  runner.store = { pendingJobs: () => [...jobs.keys()], jobRecord: id => jobs.get(id), updateJob: (id, update) => { updates.push({ id, ...update }); } };
  runner.tick = async () => {}; runner.start(); await runner.stop();
  assert.deepEqual([...jobs.keys()], ['queued-id', 'running-id', 'submitting-id']);
  assert.equal(updates.find(x => x.id === 'running-id').state, 'queued');
  assert.equal(updates.find(x => x.id === 'submitting-id').state, 'uncertain');
  assert.equal(updates.find(x => x.id === 'submitting-id').retryable, false);
  assert.equal(updates.some(x => x.id === 'queued-id'), false);
});
