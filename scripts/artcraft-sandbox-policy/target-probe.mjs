/** Opt-in target canary only. Does not start Docker, load policy, or call providers. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { hostname, release, networkInterfaces } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const runFile = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const cleanEnv = { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', HOME: '/tmp' };
export const expectedEnvKeys = ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'LANG', 'LC_ALL', 'RUST_BACKTRACE'].sort();
const canaryNames = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'IMAGE2_API_TOKEN', 'HTTP_PROXY'];

// Outputs only security facts and environment NAMES, never environment values.
export const observationCode = String.raw`
const fs = require('node:fs'), os = require('node:os');
const status = Object.fromEntries(fs.readFileSync('/proc/self/status','utf8').split('\n').filter(x => /^(CapEff|CapPrm|CapInh|CapAmb|CapBnd|NoNewPrivs|Seccomp|Seccomp_filters):/.test(x)).map(x => x.split(':').map(y => y.trim())));
const ns = Object.fromEntries(['user','mnt','pid','net'].map(x=>[x,fs.readlinkSync('/proc/self/ns/'+x)]));
console.log(JSON.stringify({uid:process.getuid(),gid:process.getgid(),status,ns,uidMap:fs.readFileSync('/proc/self/uid_map','utf8').trim(),gidMap:fs.readFileSync('/proc/self/gid_map','utf8').trim(),interfaces:os.networkInterfaces(),routes:fs.readFileSync('/proc/net/route','utf8').trim().split('\n').slice(1),envKeys:Object.keys(process.env).sort()}));`;

export function assertZeroCaps(record, outer = false) {
  assert.equal(record.uid, 1000); assert.equal(record.gid, 1000);
  for (const key of ['CapEff', 'CapPrm', 'CapInh', 'CapAmb', 'CapBnd']) {
    assert.equal(BigInt(`0x${record.status[key]}`), 0n, key);
  }
  assert.equal(record.status.NoNewPrivs, '1'); assert.equal(record.status.Seccomp, '2');
}

export function assertNetwork(parent, sandbox) {
  for (const name of ['net', 'user', 'mnt', 'pid']) assert.notEqual(sandbox.ns[name], parent.ns[name], `${name} namespace must differ`);
  assert.deepEqual(Object.keys(sandbox.interfaces), ['lo']);
  assert.ok(sandbox.interfaces.lo.length > 0);
  for (const iface of sandbox.interfaces.lo) {
    assert.equal(iface.internal, true);
    assert.ok(iface.address === '127.0.0.1' || iface.address === '::1');
  }
  assert.deepEqual(sandbox.routes, [], 'No IPv4 routes out of loopback-only namespace');
}

async function execute(command) {
  try {
    const out = await runFile(command.file, command.args, { cwd: command.cwd, env: command.env,
      timeout: 30000, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024 });
    return { code: 0, ...out };
  } catch (error) {
    return { code: error.code ?? -1, stdout: error.stdout ?? '', stderr: error.stderr ?? '', killed: !!error.killed };
  }
}

async function observation() {
  const status = Object.fromEntries((await fs.readFile('/proc/self/status', 'utf8')).split('\n')
    .filter(x => /^(CapEff|CapPrm|CapInh|CapAmb|CapBnd|NoNewPrivs|Seccomp|Seccomp_filters):/.test(x))
    .map(x => x.split(':').map(y => y.trim())));
  const ns = Object.fromEntries(await Promise.all(['user', 'mnt', 'pid', 'net'].map(async x => [x, await fs.readlink(`/proc/self/ns/${x}`)])));
  return { uid: process.getuid(), gid: process.getgid(), status, ns,
    uidMap: (await fs.readFile('/proc/self/uid_map', 'utf8')).trim(),
    gidMap: (await fs.readFile('/proc/self/gid_map', 'utf8')).trim(),
    interfaces: networkInterfaces(), routes: (await fs.readFile('/proc/net/route', 'utf8')).trim().split('\n').slice(1) };
}

async function worker(serviceDir, work) {
  // This diagnostic Node worker receives only synthetic provider canaries.
  const inheritedCanariesPresent = canaryNames.every(name => process.env[name] === 'T03_SYNTHETIC_ONLY');
  assert.ok(inheritedCanariesPresent);
  const own = await observation();
  const { craftSandboxCommand } = await import(pathToFileURL(join(serviceDir, 'craft-sandbox.mjs')));
  const command = await craftSandboxCommand(process.execPath, ['-e', observationCode], { workDir: work });
  assert.equal(command.isolation, 'linux-bubblewrap');
  assert.deepEqual(Object.keys(command.env).sort(), expectedEnvKeys);
  const result = await execute(command);
  assert.equal(result.code, 0, result.stderr);
  console.log(JSON.stringify({ worker: own, sandbox: JSON.parse(result.stdout), inheritedCanariesPresent }));
}

export async function prepareEvidenceDirectory(out, parent = '/data/image2/upgrade-evidence') {
  const folder = resolve(out), ownedParent = resolve(parent);
  assert.equal(dirname(folder), ownedParent, 'evidence must be a unique direct child of the owned parent');
  await fs.mkdir(ownedParent, { recursive: true });
  const stat = await fs.lstat(ownedParent); assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
  await fs.mkdir(folder, { recursive: false }); // EEXIST fails; never reuse/overwrite evidence.
  return folder;
}

async function main(args) {
  assert.equal(args.shift(), '--run-reviewed-target', 'Opt-in required; read README and obtain supervisor review first');
  assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64');
  const options = Object.fromEntries(Array.from({ length: args.length / 2 }, (_, i) => [args[i * 2], args[i * 2 + 1]]));
  assert.equal(args.length, 8, 'Use --mode, --expected-policy-sha256, --service-dir, --output-dir');
  assert.deepEqual(Object.keys(options).sort(), ['--mode', '--expected-policy-sha256', '--service-dir', '--output-dir'].sort());
  const mode = options['--mode']; assert.ok(['builtin', 'candidate'].includes(mode));
  const serviceDir = resolve(options['--service-dir']), out = resolve(options['--output-dir']);
  assert.ok(out.startsWith('/evidence/') || out.startsWith('/data/image2/upgrade-evidence/'), 'Use a new directory on the isolated /evidence mount');
  const lock = JSON.parse(await fs.readFile(join(here, 'review.lock.json')));
  const policyHash = sha(await fs.readFile(join(here, 'docker-29.4.1-bwrap.json')));
  assert.equal(policyHash, lock.profileSha256);
  assert.equal(options['--expected-policy-sha256'], mode === 'candidate' ? policyHash : 'builtin');
  const record = { status: 'failed', policyMode: mode, profileSha256: mode === 'candidate' ? policyHash : null,
    startedAt: new Date().toISOString(), containerHostname: hostname(), kernel: release(), checks: {},
    probeSha256: sha(await fs.readFile(fileURLToPath(import.meta.url))) };
  let root, server, evidenceReady = false;
  try {
    record.stage = 'evidence-setup';
    await prepareEvidenceDirectory(out, out.startsWith('/evidence/') ? '/evidence' : '/data/image2/upgrade-evidence');
    evidenceReady = true; record.stage = 'probe';
    assert.equal(release(), '6.6.114.1-microsoft-standard-WSL2', 'Kernel drift requires review');
    record.sandboxSourceSha256 = sha(await fs.readFile(join(serviceDir, 'craft-sandbox.mjs')));
    assert.equal(record.sandboxSourceSha256, lock.inputs.find(i => i.path.endsWith('/craft-sandbox.mjs')).sha256);
    record.nativeManifestSha256 = sha(await fs.readFile('/opt/artcraft/manifest.json'));
    assert.equal(record.nativeManifestSha256, lock.nativeManifestSha256);
    record.node = await observation(); assertZeroCaps(record.node, true);
    const bwrap = await fs.realpath('/usr/bin/bwrap'), st = await fs.stat(bwrap);
    const version = await execute({ file: bwrap, args: ['--version'], env: cleanEnv });
    assert.equal(version.code, 0);
    record.bwrap = { version: version.stdout.trim(), sha256: sha(await fs.readFile(bwrap)), setid: !!(st.mode & 0o6000) };
    assert.equal(record.bwrap.setid, false); assert.equal(record.bwrap.version, 'bubblewrap 0.11.0', 'Review different package source before widening');
    root = await fs.mkdtemp('/tmp/t03-policy-'); const work = join(root, 'project-a'); await fs.mkdir(work);
    const workerResult = await execute({ file: process.execPath, args: [fileURLToPath(import.meta.url), '--worker', serviceDir, work],
      env: { ...cleanEnv, ...Object.fromEntries(canaryNames.map(name => [name, 'T03_SYNTHETIC_ONLY'])) } });
    assert.equal(workerResult.code, 0, workerResult.stderr);
    const observed = JSON.parse(workerResult.stdout);
    record.worker = observed.worker; record.sandbox = observed.sandbox;
    assertZeroCaps(record.worker, true); assertZeroCaps(record.sandbox);
    assertNetwork(record.worker, record.sandbox);
    assert.deepEqual(record.sandbox.envKeys, expectedEnvKeys); assert.equal(observed.inheritedCanariesPresent, true);
    const { craftSandboxCommand } = await import(pathToFileURL(join(serviceDir, 'craft-sandbox.mjs')));
    const sandbox = async (file, argv) => execute(await craftSandboxCommand(file, argv, { workDir: work }));
    let requests = 0;
    server = createServer((_, response) => { requests++; response.end('T03_REACHABLE'); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    const baseline = await execute({ file: '/usr/bin/curl', args: ['-q', '-fsS', '--max-time', '2', url], env: cleanEnv });
    assert.equal(baseline.code, 0); assert.equal(baseline.stdout, 'T03_REACHABLE'); assert.equal(requests, 1);
    const isolated = await sandbox('/usr/bin/curl', ['-q', '-fsS', '--max-time', '2', url]);
    assert.notEqual(isolated.code, 0); assert.equal(isolated.killed, false); assert.equal(requests, 1);
    record.checks.network = true;
    await new Promise(resolve => server.close(resolve)); server = undefined;
    const existing = join(root, 'project-b-marker'), absent = join(root, 'project-b-new');
    const provider = join(root, 'synthetic-provider-marker');
    await fs.writeFile(existing, 'ORIGINAL'); await fs.writeFile(provider, 'T03_SYNTHETIC_ONLY');
    const direct = [existing, absent, provider]; const links = [];
    for (const [index, destination] of direct.entries()) {
      const link = join(work, `escape-${index}`); await fs.symlink(destination, link); links.push(link);
    }
    for (const destination of [...direct, ...links]) {
      const read = await sandbox('/bin/cat', [destination]); assert.notEqual(read.code, 0); assert.equal(read.stdout, '');
      const write = await sandbox(process.execPath, ['-e', 'require("fs").writeFileSync(process.argv[1],"PRIVATE_ONLY")', destination]);
      assert.ok(!write.killed);
      // A write can create a private tmpfs pathname. The actual neighbour must
      // remain unchanged/absent, and a fresh sandbox must not see the write.
      assert.equal(await fs.readFile(existing, 'utf8'), 'ORIGINAL');
      assert.equal(await fs.readFile(provider, 'utf8'), 'T03_SYNTHETIC_ONLY');
      await assert.rejects(fs.stat(absent), { code: 'ENOENT' });
      const fresh = await sandbox('/bin/cat', [destination]); assert.notEqual(fresh.code, 0); assert.equal(fresh.stdout, '');
    }
    record.checks.neighbours = true; record.checks.symlinkEscape = true; record.checks.credentials = true;
    const own = join(work, 'output.txt');
    assert.equal((await sandbox(process.execPath, ['-e', 'require("fs").writeFileSync(process.argv[1],"OWN_OUTPUT")', own])).code, 0);
    assert.equal(await fs.readFile(own, 'utf8'), 'OWN_OUTPUT');
    const ownRead = await sandbox('/bin/cat', [own]); assert.equal(ownRead.code, 0); assert.equal(ownRead.stdout, 'OWN_OUTPUT');
    for (const [file, argv] of [['/bin/true', []], ['/usr/bin/ffmpeg', ['-version']], ['/usr/bin/pdfinfo', ['-v']]]) {
      const result = await sandbox(file, argv); assert.equal(result.code, 0, result.stderr);
    }
    record.checks.ordinaryCommands = true;
    // Existing real 13-engine CPU/edit/export/reopen suite, unchanged. Must be
    // present in the exact native image; a missing dependency is a failed gate.
    const acceptance = join(serviceDir, 'tests/craft-native.integration.mjs');
    record.nativeTestSha256 = sha(await fs.readFile(acceptance));
    assert.equal(record.nativeTestSha256, lock.inputs.find(i => i.path.endsWith('/craft-native.integration.mjs')).sha256);
    const { runNativeCraftAcceptance } = await import(pathToFileURL(acceptance));
    const native = await runNativeCraftAcceptance({ binDir: '/opt/artcraft', evidenceDir: join(out, 'native') });
    assert.equal(native.results.length, 13); assert.ok(native.results.every(r => r.status === 'passed'));
    record.nativeResults = native.results;
    record.status = 'passed';
  } catch (error) {
    record.error = { code: error.code ?? null, message: error.message };
    process.exitCode = 1;
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    if (root) await fs.rm(root, { recursive: true, force: true });
    record.finishedAt = new Date().toISOString();
    if (evidenceReady) await fs.writeFile(join(out, 'target.json'), JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  }
  console.log(JSON.stringify({ status: record.status, stage: record.stage, evidence: evidenceReady ? join(out, 'target.json') : null, setupFailure: !evidenceReady, errorCode: record.error?.code || null }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === '--worker') await worker(process.argv[3], process.argv[4]);
  else await main(process.argv.slice(2));
}
