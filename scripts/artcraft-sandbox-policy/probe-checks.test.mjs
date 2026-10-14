import test from 'node:test';
import assert from 'node:assert/strict';
import { assertBwrapIdentity, parseBwrapPackage, assertSandboxEnvironment, expectedEnvKeys, expectedSandboxEnvKeys, pwdMatchesWorkdir, assertNetwork, assertZeroCaps, observationCode, prepareEvidenceDirectory } from './target-probe.mjs';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('bwrap provenance rejects any binary, package, source, architecture or setid drift', async () => {
  const lock = JSON.parse(await readFile(new URL('./review.lock.json', import.meta.url), 'utf8'));
  const actual = structuredClone(lock.bwrap);
  actual.package = parseBwrapPackage('bubblewrap\n0.12.0-1~deb13u1\nbubblewrap\n0.12.0-1~deb13u1\namd64\n');
  assertBwrapIdentity(actual, lock.bwrap);
  for (const key of ['realpath', 'version', 'sha256', 'setid']) {
    const bad = structuredClone(actual); bad[key] = key === 'setid' ? true : 'unreviewed';
    assert.throws(() => assertBwrapIdentity(bad, lock.bwrap));
  }
  for (const key of Object.keys(actual.package)) {
    const bad = structuredClone(actual); bad.package[key] = 'unreviewed';
    assert.throws(() => assertBwrapIdentity(bad, lock.bwrap));
  }
  assert.throws(() => parseBwrapPackage('bubblewrap\n0.12.0-1~deb13u1\n'));
  assert.throws(() => parseBwrapPackage('bubblewrap\n0.12.0-1~deb13u1\n\n0.12.0-1~deb13u1\namd64\n'));
  assert.throws(() => parseBwrapPackage('bubblewrap\n0.12.0-1~deb13u1\nbubblewrap\n0.12.0-1~deb13u1\namd64\nextra\n'));
});

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


test('PWD must be derived from the canonical owned sandbox cwd, never an inherited value', () => {
  assert.equal(expectedEnvKeys.includes('PWD'), false);
  assert.equal(pwdMatchesWorkdir('/tmp/owned/project', '/tmp/owned/project', '/tmp/owned/project'), true);
  for (const args of [
    ['SYNTHETIC_PARENT_PWD', '/tmp/owned/project', '/tmp/owned/project'],
    ['/tmp/other', '/tmp/other', '/tmp/owned/project'],
    [undefined, '/tmp/owned/project', '/tmp/owned/project'],
    ['', '/tmp/owned/project', '/tmp/owned/project'],
    [undefined, undefined, undefined], ['relative', 'relative', 'relative'],
  ]) assert.equal(pwdMatchesWorkdir(...args), false);
});

test('sandbox environment rejects missing/extra/duplicate keys and missing or invalid PWD proof', () => {
  const valid = { envKeys: [...expectedSandboxEnvKeys], pwdMatchesWorkdir: true };
  assertSandboxEnvironment(valid);
  for (const change of [
    x => x.envKeys.push('OPENAI_API_KEY'), x => x.envKeys.push('UNKNOWN_ENV'),
    x => x.envKeys.push('PWD'), x => x.envKeys.splice(x.envKeys.indexOf('PWD'), 1),
    x => { delete x.pwdMatchesWorkdir; },
    ...[false, undefined, null, 0, 1, 'true'].map(value => x => { x.pwdMatchesWorkdir = value; }),
  ]) { const bad = structuredClone(valid); change(bad); assert.throws(() => assertSandboxEnvironment(bad)); }
});
