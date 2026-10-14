// Synthetic native CPU witness, only on an isolated canary volume with blank models.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const file = '/data/image2/upgrade-witness.json', owner = '99999999-9999-4999-8999-999999999999';
assert.equal(process.env.ARTCRAFT_CANARY, '1');
for (const [key, value] of Object.entries(process.env)) if (/^(IMAGE_OPENAI_|OPENAI_|AGENT_LLM_|GPU_COMFY_|IMAGE2_OCR_)/.test(key)) assert.ok(!value);
const api = async (path, body) => { const r = await fetch(`http://127.0.0.1:18088/api/v3/image2${path}`, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${process.env.IMAGE2_API_TOKEN}`, 'x-studio-visitor-id': owner, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(180000) }); assert.equal(r.status, 200); return (await r.json()).data; };
const state = existsSync(file) ? JSON.parse(readFileSync(file)) : { owner };
const save = () => writeFileSync(file, JSON.stringify(state));
if (!state.id) { state.id = (await api('/documents', { name: 'ArtCraft upgrade CPU witness', width: 128, height: 96 })).id; save(); }
const base = `/documents/${state.id}/craft`;
if (!state.project) { state.project = (await api(base + '/projects', { engineId: 'vectorcraft', idempotencyKey: 'upgrade-cpu-project', name: 'Upgrade native witness' })).id; save(); }
if (!state.job) { state.job = (await api(base + '/jobs', { projectId: state.project, baseRevision: 0, inputAssetIds: [], idempotencyKey: 'upgrade-cpu-job', steps: [{ command: 'new', args: { width: 128, height: 96 } }, { command: 'draw_path', args: { points: [[8,8],[110,18],[60,80]], closed: true, fill: '#136a9f', stroke: 'none' } }, { command: 'export', args: { path: { outputName: 'witness.png' }, format: 'png', scale: 1 } }] })).id; save(); }
const until = Date.now() + 180000; let job;
do { job = await api(base + `/jobs/${state.job}`); if (['complete','failed','cancelled'].includes(job.state)) break; await new Promise(r => setTimeout(r, 500)); } while (Date.now() < until);
assert.equal(job.state, 'complete'); assert.equal(job.output.receipt.externalModelCalls, 0);
if (!state.accepted) { await api(base + `/jobs/${state.job}/accept`, { baseRevision: 0, idempotencyKey: 'upgrade-cpu-accept' }); state.accepted = true; save(); }
console.log(JSON.stringify({ id: state.id, owner, accepted: true }));
