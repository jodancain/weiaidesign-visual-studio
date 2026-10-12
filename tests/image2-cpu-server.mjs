import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createImageService } from '../services/image2/server.mjs';
import { executeOperation, registry } from '../services/image2/processors.mjs';

const evidence = resolve(process.env.IMAGE2_CPU_EVIDENCE_DIR || '../output/image2-browser-nonai-20261012');
mkdirSync(evidence, { recursive: true });
const audit = { mode: 'local-real-service-cpu-only', startedAt: new Date().toISOString(), externalAttempts: [], operations: [] };
function checkpoint() { const file = join(evidence, 'provider-audit.json'); writeFileSync(file + '.tmp', JSON.stringify(audit, null, 2)); renameSync(file + '.tmp', file); }
const service = createImageService({
  directory: join(evidence, 'data'), token: 'image2-local-browser-test-token-20261010',
  config: { imageBaseUrl: '', imageApiKey: '', comfyBaseUrl: '', comfyToken: '', ocrUrl: '', ocrToken: '',
    agent: { baseUrl: '', apiKey: '', models: ['disabled-local-test'], maxRounds: 6, maxTools: 24, maxGenerations: 0 } },
  fetchImpl: async url => { const parsed = new URL(url); audit.externalAttempts.push({ at: new Date().toISOString(), origin: parsed.origin, path: parsed.pathname }); checkpoint(); throw new Error('External model access is forbidden in the CPU browser test'); },
  processor: async (request, context) => {
    const entry = { jobId: context.jobId, operation: request.operation, executionClass: registry[request.operation]?.executionClass, startedAt: new Date().toISOString() };
    audit.operations.push(entry); checkpoint();
    try { const result = await executeOperation(request, context); entry.state = 'processed'; entry.output = result.output; return result; }
    catch (error) { entry.state = 'failed'; entry.error = error.code || error.message; throw error; }
    finally { entry.finishedAt = new Date().toISOString(); checkpoint(); }
  },
});
const handler = service.server.listeners('request')[0];
service.server.removeAllListeners('request');
service.server.on('request', (req, res) => {
  if (req.method === 'GET' && req.url === '/__test-audit') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(audit)); return; }
  return handler(req, res);
});
checkpoint();
service.server.listen(18108, '127.0.0.1', () => process.stdout.write(`CPU-only test service on 18108; evidence=${evidence}\n`));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => { await service.close(); audit.stoppedAt = new Date().toISOString(); checkpoint(); process.exit(0); });
