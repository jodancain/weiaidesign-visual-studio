/** Runs inside the EXACT final image, as node, on the target DockerDesktop host. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, readlinkSync, mkdtempSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { craftSandboxCommand } from '../craft-sandbox.mjs';
const root = process.argv[2], smoke = process.argv[3] === 'smoke', supplement = process.argv[3] === 'supplement';
assert.ok(root?.startsWith('/tmp/') || root?.startsWith('/data/image2/upgrade-evidence/'));
assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64'); assert.notEqual(process.getuid(), 0);
const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/home/node', LANG: 'C.UTF-8', IMAGE2_CRAFT_BIN_DIR: '/opt/artcraft', IMAGE2_CRAFT_REAL_BIN_DIR: '/opt/artcraft' };
// No inherited provider/API/token env, even when this is run in the final worker.
for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, env);
mkdirSync(root, { recursive: true });
const receipt = { platform: process.platform, uid: process.getuid(), passed: false, mode: smoke ? 'smoke' : supplement ? 'supplement' : 'full', tests: [] };
const save = () => writeFileSync(join(root, 'receipt.json'), JSON.stringify(receipt, null, 2));
function run(name, args, extra = {}) {
  const evidence = join(root, name); mkdirSync(evidence, { recursive: true });
  const r = spawnSync(process.execPath, args, { cwd: '/app', env: { ...env, IMAGE2_CRAFT_EVIDENCE_DIR: evidence, ...extra }, encoding: 'utf8', timeout: 40 * 60 * 1000, maxBuffer: 32 * 1024 * 1024 });
  writeFileSync(join(evidence, 'stdout.txt'), r.stdout || ''); writeFileSync(join(evidence, 'stderr.txt'), r.stderr || '');
  receipt.tests.push({ name, exitCode: r.status, signal: r.signal, passed: r.status === 0 }); save(); assert.equal(r.status, 0, `${name} failed; retained evidence`);
}
try {
  receipt.bwrapSha256 = createHash('sha256').update(readFileSync('/usr/bin/bwrap')).digest('hex');
  const status = readFileSync('/proc/self/status', 'utf8');
  for (const key of ['CapEff', 'CapPrm', 'CapInh', 'CapAmb', 'CapBnd']) assert.match(status, new RegExp(`^${key}:\\s*0+$`, 'm'));
  assert.equal(process.getuid(), 1000);
  const manifest = readFileSync('/opt/artcraft/manifest.json'); receipt.manifestSha256 = createHash('sha256').update(manifest).digest('hex');
  const entries = JSON.parse(manifest).engines;
  // Runtime's pinned manifest and binary verification is exercised by all 13 tests.
  assert.equal(entries.length, 13); receipt.manifestPresent = true;
  receipt.dependencies = [];
  for (const entry of (smoke ? [] : entries)) {
    assert.match(entry.binary, /^[a-z]+craft-cli$/);
    const file = join('/opt/artcraft', entry.binary), bytes = readFileSync(file);
    assert.equal(bytes.length, entry.bytes); assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256);
    const ldd = spawnSync('/usr/bin/ldd', [file], { env, encoding: 'utf8', timeout: 30000 });
    assert.equal(ldd.status, 0); assert.doesNotMatch(ldd.stdout, /not found/);
    receipt.dependencies.push({ engine: entry.id, passed: true, ldd: ldd.stdout.trim() });
  }
  save();
  const work = mkdtempSync(join(root, 'namespace-')), outside = join(root, 'outside.txt'); writeFileSync(outside, 'denied');
  // /sys is intentionally absent; /proc/net/dev is the interface oracle.
  const command = await craftSandboxCommand(process.execPath, ['--input-type=module', '-e', `import fs from 'node:fs';import assert from 'node:assert/strict';assert.notEqual(fs.readlinkSync('/proc/self/ns/net'),${JSON.stringify(readlinkSync('/proc/self/ns/net'))});const interfaces=fs.readFileSync('/proc/net/dev','utf8').split('\\n').slice(2).filter(l=>l.includes(':')).map(l=>l.split(':')[0].trim());assert.deepEqual(interfaces,['lo']);const caps=fs.readFileSync('/proc/self/status','utf8').match(/^Cap(?:Inh|Prm|Eff|Bnd|Amb):\\s*([0-9a-f]+)$/gm);assert.equal(caps.length,5);assert.ok(caps.every(l=>/^0+$/.test(l.split(':')[1].trim())));assert.throws(()=>fs.readFileSync(${JSON.stringify(outside)}));fs.writeFileSync(${JSON.stringify(join(work, 'own.txt'))},'own');console.log(JSON.stringify({networkNamespaceDistinct:true,loopbackOnly:true,capabilitiesZero:true,outsideReadDenied:true}));`], { workDir: work });
  const probe = spawnSync(command.file, command.args, { cwd: command.cwd, env: command.env, encoding: 'utf8', timeout: 20000 });
  writeFileSync(join(root, 'namespace-stderr.txt'), probe.stderr || ''); assert.equal(probe.status, 0, 'namespace policy gate failed'); receipt.sandbox = JSON.parse(probe.stdout); save();
  if (!smoke) run('confinement', ['--test', 'tests/craft-sandbox.test.mjs']);
  if (smoke) {
    run('native-checkpoint-smoke', ['tests/craft-native.integration.mjs', 'vectorcraft']);
    receipt.passed = true; save();
  } else {
  if (!supplement) {
  run('native13', ['tests/craft-native.integration.mjs']);
  const results = JSON.parse(readFileSync(join(root, 'native13/results.json'))).results;
  assert.equal(results.length, 13); assert.equal(new Set(results.map(r => r.id)).size, 13); assert.ok(results.every(r => r.status === 'passed'));
  }
  run('persistent-service', ['--test', 'tests/craft-service-native.test.mjs']);
  for (const id of ['photocraft', 'vectorcraft']) run(`cjk-${id}`, ['tests/craft-cjk.integration.mjs', id]);
  run('chinese-text8', ['tests/craft-text.integration.mjs']);
  run('vector-detail', ['tests/craft-vector.integration.mjs']);
  receipt.passed = true; save();
  }
} catch { save(); process.stderr.write('target native gate failed; see retained evidence; no sandbox bypass allowed\n'); process.exitCode = 1; }
