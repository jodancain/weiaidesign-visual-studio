import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createImageService } from '../services/image2/server.mjs';
const directory = mkdtempSync(join(tmpdir(), 'image2-real-browser-'));
const service = createImageService({
  directory, token: 'image2-local-browser-test-token-20261010',
  config: { imageBaseUrl: '', imageApiKey: '', comfyBaseUrl: '', comfyToken: '', ocrUrl: '', ocrToken: '',
    agent: { baseUrl: '', apiKey: '', models: ['disabled-local-test'], maxRounds: 6, maxTools: 24, maxGenerations: 0 } },
  fetchImpl: async () => { throw new Error('External model access is forbidden in real browser integration'); },
});
service.server.listen(18108, '127.0.0.1', () => process.stdout.write(`CPU-only Image2 test service; data=${directory}\n`));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => { await service.close(); process.exit(0); });
