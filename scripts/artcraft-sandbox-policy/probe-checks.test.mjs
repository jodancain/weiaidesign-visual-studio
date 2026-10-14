import test from 'node:test';
import assert from 'node:assert/strict';
import { assertNetwork, assertZeroCaps, observationCode, prepareEvidenceDirectory } from './target-probe.mjs';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('empty owned volume creates evidence parent and unique leaf, without overwriting previous runs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'policy-empty-volume-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const parent = join(root, 'upgrade-evidence'), out = join(parent, 'builtin-control-run');
  await prepareEvidenceDirectory(out, parent);
  await writeFile(join(out, 'target.json'), 'original receipt', { flag: 'wx' });
  await assert.rejects(prepareEvidenceDirectory(out, parent), { code: 'EEXIST' });
  assert.equal(await readFile(join(out, 'target.json'), 'utf8'), 'original receipt');
  await assert.rejects(prepareEvidenceDirectory(join(root, 'outside'), parent));
  const invalidParent = join(root, 'file'); await writeFile(invalidParent, 'keep');
  await assert.rejects(prepareEvidenceDirectory(join(invalidParent, 'run'), invalidParent));
});

const processRecord = () => ({ uid: 1000, gid: 1000,
  status: { CapEff: '0000000000000000', CapPrm: '0000000000000000', CapInh: '0000000000000000',
    CapAmb: '0000000000000000', CapBnd: '0000000000000000', NoNewPrivs: '1', Seccomp: '2' } });
test('capability validator rejects effective, permitted, ambient, inherited and outer bounding capabilities', () => {
  assertZeroCaps(processRecord(), true);
  for (const key of ['CapEff', 'CapPrm', 'CapInh', 'CapAmb', 'CapBnd']) {
    const record = processRecord(); record.status[key] = '0000000000200000';
    assert.throws(() => assertZeroCaps(record, true));
    assert.throws(() => assertZeroCaps(record));
  }
  const record = processRecord(); record.status.NoNewPrivs = '0'; assert.throws(() => assertZeroCaps(record));
});
test('network validator rejects reused namespaces, non-loopback interfaces/addresses and routes', () => {
  const parent = { ns: { net: 'net:[1]', user: 'user:[1]', mnt: 'mnt:[1]', pid: 'pid:[1]' } };
  const sandbox = { ns: { net: 'net:[2]', user: 'user:[2]', mnt: 'mnt:[2]', pid: 'pid:[2]' },
    interfaces: { lo: [{ address: '127.0.0.1', internal: true }, { address: '::1', internal: true }] }, routes: [] };
  assertNetwork(parent, sandbox);
  for (const name of Object.keys(parent.ns)) {
    const bad = structuredClone(sandbox); bad.ns[name] = parent.ns[name]; assert.throws(() => assertNetwork(parent, bad));
  }
  for (const change of [x => x.interfaces.eth0 = [], x => x.interfaces.lo[0].address = '192.0.2.1', x => x.routes.push('default')]) {
    const bad = structuredClone(sandbox); change(bad); assert.throws(() => assertNetwork(parent, bad));
  }
});

test("actual worker observation program parses without newline escape corruption", () => {
  assert.doesNotThrow(() => new Function(observationCode));
});
