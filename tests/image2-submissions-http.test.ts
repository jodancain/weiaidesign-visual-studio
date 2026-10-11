import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { ImageSubmissionManager, type SubmissionAttempt, type SubmissionStorage } from '../lib/image2/submissions';
import type { ImageDocument, ImageJob } from '../lib/image2/types';
class MemorySubmissions implements SubmissionStorage {
  records = new Map<string, SubmissionAttempt>();
  async getOrCreate(attempt: SubmissionAttempt) { const old = this.records.get(attempt.intent); if (old) return structuredClone(old); this.records.set(attempt.intent, structuredClone(attempt)); return structuredClone(attempt); }
  async remove(intent: string) { this.records.delete(intent); } async list() { return [...this.records.values()].map(item => structuredClone(item)); }
}
const listen = (server: Server) => new Promise<string>(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`)));
const wait = async (check: () => Promise<boolean>) => { const start = Date.now(); while (!await check()) { assert.ok(Date.now() - start < 15000, 'job did not terminate'); await new Promise(resolve => setTimeout(resolve, 20)); } };
test('real HTTP accepted CPU operation/export/chat with lost receipts replays once with zero provider calls', async () => {
  const serviceModuleUrl = new URL('../services/image2/server.mjs', import.meta.url);
  const { createImageService } = await import(serviceModuleUrl.href);
  const directory = await mkdtemp(join(tmpdir(), 'image2-receipt-http-')); let providers = 0;
  const token = 'fake-local-image2-receipt-test-token', headers = { authorization: `Bearer ${token}`, 'x-studio-visitor-id': crypto.randomUUID(), 'content-type': 'application/json' };
  const service = createImageService({ directory, token, config: { imageBaseUrl: '', imageApiKey: '', comfyBaseUrl: '', comfyToken: '', ocrUrl: '', ocrToken: '', agent: { baseUrl: '', apiKey: '', models: ['disabled'], maxRounds: 6 } }, fetchImpl: async () => { providers++; throw new Error('external calls forbidden'); } });
  const origin = await listen(service.server), dropped = new Set<string>(), received: Record<string, unknown>[][] = [], accepted = new Map<string, unknown>();
  const proxy = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString(), path = req.url!;
      if (req.method === 'POST') received.push([JSON.parse(body)]);
      const upstream = await fetch(`${origin}${path}`, { method: req.method, headers, ...(body ? { body } : {}) });
      const bytes = await upstream.text();
      if (req.method === 'POST' && ['/api/v3/image2/operations', '/api/v3/image2/exports'].includes(path) || req.method === 'POST' && path.endsWith('/messages')) {
        if (!dropped.has(path)) { assert.ok(upstream.ok, bytes); dropped.add(path); accepted.set(path, JSON.parse(bytes).data); res.destroy(); return; }
      }
      res.writeHead(upstream.status, { 'content-type': 'application/json' }); res.end(bytes);
    } catch { res.destroy(); }
  });
  const proxyOrigin = await listen(proxy);
  const api = async <T,>(path: string, body?: unknown): Promise<T> => { const response = await fetch(`${origin}/api/v3/image2${path}`, { method: body ? 'POST' : 'GET', headers, ...(body ? { body: JSON.stringify(body) } : {}) }); const value = await response.json(); assert.ok(response.ok, JSON.stringify(value)); return value.data as T; };
  const transport = async (path: string, body: Record<string, unknown>) => { const response = await fetch(`${proxyOrigin}/api/v3/image2${path}`, { method: 'POST', headers, body: JSON.stringify(body) }); const value = await response.json(); if (!response.ok) throw Object.assign(new Error(value.detail), { status: response.status }); return value.data; };
  try {
    let document = await api<ImageDocument>('/documents', { name: 'receipt recovery', width: 4, height: 4 });
    const require = createRequire(import.meta.url), sharp = require('../services/image2/node_modules/sharp');
    const image = await sharp({ create: { width: 4, height: 4, channels: 4, background: '#aabbaa' } }).png().toBuffer();
    const asset = await api<{ id: string }>('/assets', { documentId: document.id, name: 'base.png', mime: 'image/png', data: image.toString('base64') });
    const layerId = crypto.randomUUID(); document = await api<ImageDocument>(`/documents/${document.id}/commands`, { baseRevision: document.revision, commandId: crypto.randomUUID(), commands: [{ type: 'layer.add', layer: { id: layerId, type: 'raster', name: 'base', x: 0, y: 0, width: 4, height: 4, rotation: 0, opacity: 1, visible: true, locked: false, z: 0, assetId: asset.id } }] });
    const storage = new MemorySubmissions(), first = new ImageSubmissionManager(storage, transport), intent = { documentId: document.id, operation: 'resize', layerId };
    await assert.rejects(first.submit('/operations', intent, { documentId: document.id, baseRevision: document.revision, targetLayerId: layerId, operation: 'resize', params: { width: 2, height: 2 }, inputs: [{ role: 'base', assetId: asset.id }], mode: 'apply' }));
    const frozen = (await storage.list())[0].body, acceptedJob = (accepted.get('/api/v3/image2/operations') as { job: ImageJob }).job;
    await wait(async () => (await api<ImageJob>(`/jobs/${acceptedJob.id}`)).state === 'complete');
    document = await api<ImageDocument>(`/documents/${document.id}`);
    document = await api<ImageDocument>(`/documents/${document.id}/commands`, { baseRevision: document.revision, commandId: crypto.randomUUID(), commands: [{ type: 'layer.remove', layerId }] });
    const replayed = await new ImageSubmissionManager(storage, transport).submit<{ job: ImageJob }>('/operations', intent, { documentId: document.id, baseRevision: document.revision, operation: 'resize', targetLayerId: 'deleted' });
    assert.equal(replayed.job.id, acceptedJob.id); assert.deepEqual(received[0][0], received[1][0]); assert.deepEqual(received[1][0], frozen);
    for (const path of ['/exports', '/messages']) {
      const conversation = path === '/messages' ? await api<{ id: string }>('/conversations', { documentId: document.id }) : undefined;
      const route = conversation ? `/conversations/${conversation.id}/messages` : path, store = new MemorySubmissions(), manager = new ImageSubmissionManager(store, transport);
      const body = conversation ? { text: '测试恢复', references: [] } : { documentId: document.id, baseRevision: document.revision, format: 'svg' };
      await assert.rejects(manager.submit(route, { documentId: document.id, action: path }, body));
      const old = (await store.list())[0].body;
      const receipt = await new ImageSubmissionManager(store, transport).submit<{ job: ImageJob }>(route, { documentId: document.id, action: path }, { ...body, baseRevision: 999 });
      assert.equal(receipt.job.id, (accepted.get(`/api/v3/image2${route}`) as { job: ImageJob }).job.id); assert.deepEqual(received.at(-1)![0], old);
    }
    const jobs = await api<ImageJob[]>(`/documents/${document.id}/jobs`); assert.equal(jobs.length, 3); assert.equal(providers, 0);
  } finally { await new Promise<void>(resolve => proxy.close(() => resolve())); await service.close(); await rm(directory, { recursive: true, force: true }); }
});
test('real HTTP lost generation receipt never repeats a simulated provider submission', async () => {
  const { createImageService } = await import(new URL('../services/image2/server.mjs', import.meta.url).href);
  const directory = await mkdtemp(join(tmpdir(), 'image2-provider-once-')), token = 'fake-local-provider-once-test-token';
  const headers = { authorization: `Bearer ${token}`, 'x-studio-visitor-id': crypto.randomUUID(), 'content-type': 'application/json' };
  const sharp = createRequire(import.meta.url)('../services/image2/node_modules/sharp'), png = await sharp({ create: { width: 4, height: 4, channels: 4, background: '#45aa89' } }).png().toBuffer();
  let providers = 0;
  const service = createImageService({ directory, token,
    config: { imageBaseUrl: 'http://simulated-provider.invalid', imageApiKey: 'fake-not-a-real-key', imageModel: 'gpt-image-2', comfyBaseUrl: '', comfyToken: '', ocrUrl: '', ocrToken: '', agent: { baseUrl: '', apiKey: '', models: ['disabled'], maxRounds: 6 } },
    fetchImpl: async (url: string) => { assert.equal(url, 'http://simulated-provider.invalid/images/generations'); providers++; return new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }), { status: 200, headers: { 'content-type': 'application/json' } }); },
  });
  const origin = await listen(service.server), bodies: string[] = []; let receipt: { job: ImageJob } | undefined;
  const proxy = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); const body = Buffer.concat(chunks).toString(); bodies.push(body);
    const response = await fetch(`${origin}/api/v3/image2/operations`, { method: 'POST', headers, body }), result = await response.text();
    if (!receipt) { assert.ok(response.ok, result); receipt = JSON.parse(result).data; res.destroy(); }
    else { res.writeHead(response.status, { 'content-type': 'application/json' }); res.end(result); }
  });
  const proxyOrigin = await listen(proxy);
  const api = async <T,>(path: string, body?: unknown): Promise<T> => { const response = await fetch(`${origin}/api/v3/image2${path}`, { method: body ? 'POST' : 'GET', headers, ...(body ? { body: JSON.stringify(body) } : {}) }); const value = await response.json(); assert.ok(response.ok, JSON.stringify(value)); return value.data; };
  const transport = async (_path: string, body: Record<string, unknown>) => { const response = await fetch(proxyOrigin, { method: 'POST', headers, body: JSON.stringify(body) }); const value = await response.json(); assert.ok(response.ok, JSON.stringify(value)); return value.data; };
  try {
    let doc = await api<ImageDocument>('/documents', { name: 'provider once', width: 4, height: 4 }); const storage = new MemorySubmissions(), intent = { documentId: doc.id, operation: 'generate', params: { prompt: 'local simulated output' } };
    await assert.rejects(new ImageSubmissionManager(storage, transport).submit('/operations', intent, { documentId: doc.id, operation: 'generate', baseRevision: doc.revision, params: intent.params, mode: 'candidate' }));
    await wait(async () => (await api<ImageJob>(`/jobs/${receipt!.job.id}`)).state === 'complete');
    doc = await api<ImageDocument>(`/documents/${doc.id}/commands`, { baseRevision: doc.revision, commandId: crypto.randomUUID(), commands: [{ type: 'document.update', patch: { name: 'changed after receipt lost' } }] });
    const recovered = await new ImageSubmissionManager(storage, transport).submit<{ job: ImageJob }>('/operations', intent, { documentId: doc.id, baseRevision: doc.revision, operation: 'generate', params: intent.params });
    assert.equal(recovered.job.id, receipt!.job.id); assert.equal(bodies[0], bodies[1]); assert.equal(providers, 1); assert.equal((await api<ImageJob[]>(`/documents/${doc.id}/jobs`)).length, 1);
  } finally { await new Promise<void>(resolve => proxy.close(() => resolve())); await service.close(); await rm(directory, { recursive: true, force: true }); }
});
