import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { craftSandboxCommand } from '../craft-sandbox.mjs';

const execute = (command, input = '') => new Promise(resolve => {
  const child = spawn(command.file, command.args, { cwd: command.cwd, env: command.env });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
  child.stdin.on('error', () => {}); child.stdin.end(input);
  child.on('error', error => resolve({ code: -1, stdout, stderr: error.message }));
  child.on('exit', code => resolve({ code, stdout, stderr }));
});

test('native confinement blocks network and neighbouring writes while retaining job output', { skip: !['darwin','linux'].includes(process.platform) }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'craft-network-')), work = join(root, 'work');
  const { mkdir } = await import('node:fs/promises'); await mkdir(work);
  let requests = 0;
  const server = createServer((request, response) => { requests++; response.end('reachable'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const baseline = await execute({ file: '/usr/bin/curl', args: ['-fsS', '--max-time', '2', url], cwd: work, env: { PATH: '/usr/bin:/bin' } });
    assert.equal(baseline.stdout, 'reachable'); assert.equal(requests, 1);
    const blocked = await execute(await craftSandboxCommand('/usr/bin/curl', ['-fsS', '--max-time', '2', url], { workDir: work }));
    assert.notEqual(blocked.code, 0); assert.equal(requests, 1);
    const own = join(work, 'result.txt'), outside = join(root, 'not-output.txt');
    assert.equal((await execute(await craftSandboxCommand('/usr/bin/tee', [own], { workDir: work }), 'result')).code, 0);
    assert.equal(await readFile(own, 'utf8'), 'result');
    const outsideWrite = await execute(await craftSandboxCommand('/usr/bin/tee', [outside], { workDir: work }), 'namespace-only');
    // Bubblewrap can create this pathname in its private /tmp; it is not the host path.
    // Seatbelt instead denies the write. Both must preserve the host's absence state.
    if (outsideWrite.code === 0) {
      assert.equal(process.platform, 'linux'); assert.equal(outsideWrite.stdout, 'namespace-only');
    }
    await assert.rejects(readFile(outside), { code: 'ENOENT' });
    const laterNamespace = await execute(await craftSandboxCommand('/bin/cat', [outside], { workDir: work }));
    assert.notEqual(laterNamespace.code, 0); assert.equal(laterNamespace.stdout, '');
  } finally { await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); }
});

test('native isolation rejects unsupported platforms and arbitrary launch arguments', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'craft-isolation-'));
  try {
    await assert.rejects(craftSandboxCommand(process.execPath, [], { workDir: dir, platform: 'win32' }), { code: 'CRAFT_SANDBOX_UNAVAILABLE' });
    await assert.rejects(craftSandboxCommand(process.execPath, ['\0'], { workDir: dir }), { code: 'CRAFT_SANDBOX_UNAVAILABLE' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('native process reads its fixture but cannot read a neighbouring project', { skip: !['darwin','linux'].includes(process.platform) }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'craft-confinement-')), work = join(root, 'work');
  const { mkdir } = await import('node:fs/promises'); await mkdir(work);
  try {
    const own = join(work, 'input.txt'), other = join(root, 'neighbour.txt');
    await writeFile(own, 'own-project'); await writeFile(other, 'not-an-engine-input');
    const accepted = await execute(await craftSandboxCommand('/bin/cat', [own], { workDir: work }));
    assert.equal(accepted.code, 0, accepted.stderr); assert.equal(accepted.stdout, 'own-project');
    const denied = await execute(await craftSandboxCommand('/bin/cat', [other], { workDir: work }));
    assert.notEqual(denied.code, 0); assert.equal(denied.stdout, '');
    assert.equal(await readFile(other, 'utf8'), 'not-an-engine-input');
    const env = (await craftSandboxCommand('/bin/cat', [own], { workDir: work })).env;
    assert.equal(env.OPENAI_API_KEY, undefined); assert.equal(env.IMAGE2_API_TOKEN, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('native writes and workspace symlinks cannot alter existing or absent host neighbours', { skip: !['darwin','linux'].includes(process.platform) }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'craft-host-write-')), work = join(root, 'work');
  const { mkdir } = await import('node:fs/promises'); await mkdir(work);
  try {
    const existing = join(root, 'existing.txt'), absent = join(root, 'absent.txt');
    const existingLink = join(work, 'existing-link.txt'), absentLink = join(work, 'absent-link.txt');
    await writeFile(existing, 'original-host-content');
    await symlink(existing, existingLink); await symlink(absent, absentLink);
    for (const target of [existing, existingLink]) {
      const read = await execute(await craftSandboxCommand('/bin/cat', [target], { workDir: work }));
      assert.notEqual(read.code, 0); assert.equal(read.stdout, '');
    }
    for (const target of [existing, absent, existingLink, absentLink]) {
      const write = await execute(await craftSandboxCommand('/usr/bin/tee', [target], { workDir: work }), 'namespace-only');
      if (write.code === 0) {
        assert.equal(process.platform, 'linux'); assert.equal(write.stdout, 'namespace-only');
      }
      assert.equal(await readFile(existing, 'utf8'), 'original-host-content');
      await assert.rejects(readFile(absent), { code: 'ENOENT' });
      // A new namespace sees neither the host content nor a previous private write.
      const read = await execute(await craftSandboxCommand('/bin/cat', [target], { workDir: work }));
      assert.notEqual(read.code, 0); assert.equal(read.stdout, '');
    }
    const own = join(work, 'own.txt');
    assert.equal((await execute(await craftSandboxCommand('/usr/bin/tee', [own], { workDir: work }), 'accepted')).code, 0);
    assert.equal(await readFile(own, 'utf8'), 'accepted');
  } finally { await rm(root, { recursive: true, force: true }); }
});
