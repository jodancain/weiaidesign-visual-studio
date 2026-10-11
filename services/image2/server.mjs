import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { ImageStore } from './store.mjs';
import { createImageRouter } from './router.mjs';
import { ImageRunner } from './jobs.mjs';
import { inspectAsset } from './processors.mjs';

export function createImageService({ directory, token, config = {}, fetchImpl = fetch, processor } = {}) {
  if (typeof token !== 'string' || token.length < 24) throw new Error('IMAGE2_API_TOKEN must contain at least 24 characters');
  const store = new ImageStore(directory || process.env.IMAGE2_DATA_DIR || '/data/image2');
  const runner = new ImageRunner({ store, config, fetchImpl, processor });
  const handle = createImageRouter({ store, runner, config: { token }, assetInspector: inspectAsset });
  const server = createServer(async (req, res) => {
    if (req.url === '/health' && req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify({ status: 'ok', version: '2.0.0', persistent: true })); return; }
    try { if (await handle(req, res)) return; res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ detail: 'route not found' })); }
    catch { if (!res.headersSent) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ detail: '图片服务处理失败' })); } else res.destroy(); }
  });
  runner.start();
  return { server, store, runner, async close() { await new Promise(resolve => server.listening ? server.close(resolve) : resolve()); await runner.stop(); store.close(); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const service = createImageService({ token: process.env.IMAGE2_API_TOKEN });
  const port = Number(process.env.PORT || 18088);
  service.server.listen(port, process.env.HOSTNAME || '0.0.0.0', () => process.stdout.write(`Image Studio 2.0 service listening on ${port}\n`));
  let closing = false;
  for (const signal of ['SIGTERM','SIGINT']) process.on(signal, async () => { if (closing) return; closing = true; await service.close(); process.exit(0); });
}
