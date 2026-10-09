/** Isolated integration harness: real SQLite/router/BFF, deterministic fixture LLM,
 * no worker execution, no production configuration, no paid API requests. */
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudioRouter } from '../../gateway/studio/router.mjs';
import { StudioStore } from '../../gateway/studio/store.mjs';
import { createProject, digest } from '../../gateway/studio/domain.mjs';
import { SCENE_MODEL } from '../../gateway/studio/code-jobs.mjs';
import { makeTemplateProgram } from '../lib/studio/code-scene/defaults.ts';
import { GET as session } from '../app/api/v3/session/route.ts';
import { GET as forward } from '../app/api/v3/[...path]/route.ts';
const directory = mkdtempSync(join(tmpdir(), 'studio-web-integration-'));
const seed = new StudioStore(directory), demo = seed.createProject(createProject({ name: '公开只读集成示例', demo: true })); seed.close();
const router = createStudioRouter({ dataDir: directory, token: 'isolated-test-only', publicDemoProjectIds: [demo.id], startJobs: false, codeWorkerUrl: 'http://fixture-worker.invalid', codeWorkerToken: 'no-worker-execution',
  provider: { capabilities: () => ({ llm: true, video: false }), generateScene: async input => { const content = JSON.stringify(makeTemplateProgram(input.film)); return { content, provenance: { requestedModel: SCENE_MODEL, actualModel: SCENE_MODEL, requestBodyHash: digest(input), responseHash: digest(content), fixture: true } }; } },
  fetchImpl: async url => { if (!String(url).endsWith('/capabilities')) throw Error('Fixture worker execution is forbidden'); return Response.json({ available: true, runtimeHash: 'a'.repeat(64), renderers: { 'three-webgl': { available: true }, remotion: { available: true } }, dlss: { available: true } }); },
});
router.jobs.tick = () => {};
const ticking = setInterval(() => { for (const id of router.store.pendingJobs()) if (router.store.job(id).job.kind === 'scene-generation') void router.jobs.step(id); }, 100);
const gateway = createServer((req, res) => { void router.handle(req, res).then(handled => { if (!handled) { res.writeHead(404); res.end(); } }); }); gateway.listen(18364, '127.0.0.1'); await once(gateway, 'listening');
process.env.STUDIO_GATEWAY_URL = 'http://127.0.0.1:18364'; process.env.VIDEO_API_PROXY_TOKEN = 'isolated-test-only'; process.env.STUDIO_VISITOR_SECRET = 'isolated-test-signing-only'; delete process.env.STUDIO_PUBLIC_ORIGIN;
const proxy = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://127.0.0.1:18365'); let result;
    if (url.pathname.startsWith('/api/v3/')) {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks), headers = new Headers(); for (const [name, value] of Object.entries(req.headers)) if (value) headers.set(name, Array.isArray(value) ? value.join(',') : value);
      const request = new Request(url, { method: req.method, headers, ...(!['GET', 'HEAD'].includes(req.method) ? { body } : {}) });
      result = url.pathname === '/api/v3/session' ? await session(request) : await forward(request, { params: Promise.resolve({ path: url.pathname.slice('/api/v3/'.length).split('/') }) });
    } else result = await fetch(`http://127.0.0.1:18293${url.pathname}${url.search}`, { headers: { host: '127.0.0.1:18293' } });
    const headers = Object.fromEntries([...result.headers].filter(([key]) => !['content-length', 'content-encoding', 'transfer-encoding', 'connection'].includes(key)));
    res.writeHead(result.status, headers); res.end(req.method === 'HEAD' ? undefined : Buffer.from(await result.arrayBuffer()));
  } catch (error) { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ detail: error.message })); }
});
proxy.on('upgrade', (req, socket, head) => {
  const upstream = connect(18293, '127.0.0.1', () => {
    const headers = Object.entries(req.headers).map(([key, value]) => `${key}: ${key === 'host' ? '127.0.0.1:18293' : value}`).join('\r\n');
    upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${headers}\r\n\r\n`); if (head.length) upstream.write(head); socket.pipe(upstream); upstream.pipe(socket);
  });
  upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy()); socket.on('close', () => upstream.destroy());
}); proxy.listen(18365, '127.0.0.1'); await once(proxy, 'listening');
console.log(JSON.stringify({ purpose: 'isolated integration harness', base: 'http://127.0.0.1:18365', gateway: 'http://127.0.0.1:18364', demoId: demo.id, paidAPIs: false, workerExecution: false }));
async function close() { clearInterval(ticking); proxy.closeAllConnections(); gateway.closeAllConnections(); proxy.close(); gateway.close(); await router.close(); rmSync(directory, { recursive: true, force: true }); process.exit(0); }
process.once('SIGINT', close); process.once('SIGTERM', close);
