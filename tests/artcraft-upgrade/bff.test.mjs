import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const run = (scenario, requireNativeAssets = true, assets = []) => spawnSync(process.execPath, ['--import', './tests/artcraft-upgrade/bff-fetch-fixture.mjs', 'scripts/artcraft-upgrade/bff-probe.mjs'], {
  encoding: 'utf8', env: { PATH: process.env.PATH, ARTCRAFT_TEST_SCENARIO: scenario, STUDIO_VISITOR_SECRET: 'synthetic-only', IMAGE2_API_TOKEN: 'synthetic-only', IMAGE2_API_URL: 'http://image2:18088', ARTCRAFT_PROBE_INPUT: Buffer.from(JSON.stringify({ id: 'doc', owner: '11111111-1111-4111-8111-111111111111', requireNativeAssets, assets })).toString('base64') },
});
test('BFF witness verifies actual nonzero checkpoint, output and ordinary asset downloads', () => {
  const r = run('pass'); assert.equal(r.status, 0, r.stderr); const receipt = JSON.parse(r.stdout);
  assert.equal(receipt.routes[0].verifiedAssetCount, 3); assert.equal(receipt.routes[0].nativeAssetCount, 2);
  assert.ok(receipt.routes[0].verifiedAssets.every(a => a.bytes > 0));
});
for (const scenario of ['empty', 'corrupt', 'empty-list']) test(`BFF rejects ${scenario} downloads`, () => {
  const r = run(scenario, scenario !== 'empty-list'); assert.notEqual(r.status, 0);
});

const pinned = [{ id: 'uploaded', bytes: Buffer.byteLength('verified native bytes'), sha256: createHash('sha256').update('verified native bytes').digest('hex') }];
test('ordinary BFF readback accepts uploaded off-canvas association and verifies pinned bytes', () => {
  const r = run('off-canvas', false, pinned); assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).routes[0].verifiedAssetCount, 1);
});
test('ordinary readback rejects missing and stale pinned assets', () => {
  assert.notEqual(run('missing', false, pinned).status, 0);
  assert.notEqual(run('pin-corrupt', false, [{ ...pinned[0], sha256: '0'.repeat(64) }]).status, 0);
  assert.notEqual(run('off-canvas', false, [{ ...pinned[0], bytes: 0 }]).status, 0);
});
