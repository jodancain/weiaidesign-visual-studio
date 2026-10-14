import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { assembleCraftBundle, publishCraftDirectory } from '../../../scripts/assemble-craft-bundle.mjs';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const script = path.join(repository, 'scripts/assemble-craft-bundle.mjs');
const lockBytes = await fs.readFile(path.join(repository, 'services/image2/craft-engines.lock.json'));
const lock = JSON.parse(lockBytes), sha = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const readManifest = async directory => JSON.parse(await fs.readFile(path.join(directory, 'manifest.json')));
const saveManifest = (directory, manifest) => fs.writeFile(path.join(directory, 'manifest.json'), json(manifest));

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'craft-bundle-assembly-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fontManifest = '# Synthetic fixture only; no font glyph verification.\n';
  const fonts = { sourceCommit: lock.fonts.commit, manifests: [{ name: 'fonts/manifest.txt', sha256: sha(fontManifest) }], fonts: [], transforms: [] };
  const inputs = [];
  for (const engine of lock.engines) {
    const directory = path.join(root, engine.id); inputs.push(directory);
    const binary = Buffer.from(`Small non-native test bytes: ${engine.id}\n`), cargo = `# synthetic test lock for ${engine.id}\n`;
    const build = { toolchain: lock.rustToolchain, package: engine.package, sourceLockHash: sha(lockBytes), features: engine.features, defaultFeatures: engine.defaultFeatures !== false, profile: 'release', target: 'x86_64-unknown-linux-gnu', cargoLockHash: sha(cargo), fonts: { sourceCommit: lock.fonts.commit, provenanceHash: sha(JSON.stringify(fonts)), required: true, figcraftEmbedCjk: true, manifests: fonts.manifests, transforms: [] } };
    const files = {
      'manifest.json': json({ version: 1, platform: 'linux', arch: 'x64', engines: [{ id: engine.id, sourceCommit: engine.commit, binary: `${engine.id}-cli`, bytes: binary.length, sha256: sha(binary), build }] }),
      [`${engine.id}-cli`]: binary,
      [`licenses/${engine.id}/BUILD.json`]: json(build),
      [`licenses/${engine.id}/Cargo.lock`]: cargo,
      [`licenses/${engine.id}/dependencies.json`]: '[]\n',
      [`licenses/${engine.id}/SOURCE.txt`]: `${engine.repository}\ncommit ${engine.commit}\nSynthetic fixture, not a native build.\n`,
      [`licenses/${engine.id}/LICENSE-MIT`]: 'Synthetic engine notice for file-assembly tests only.\n',
      'licenses/craft-fonts/PROVENANCE.json': json(fonts),
      'licenses/craft-fonts/fonts/manifest.txt': fontManifest,
      'licenses/craft-fonts/ATTRIBUTION.md': 'Synthetic font attribution.\n',
      'licenses/craft-fonts/LICENSE-MIT': 'Identical shared test notice.\n',
      'licenses/craft-fonts/LICENSE-APACHE': 'Identical second shared test notice.\n',
    };
    for (const [name, bytes] of Object.entries(files)) { await fs.mkdir(path.dirname(path.join(directory, name)), { recursive: true }); await fs.writeFile(path.join(directory, name), bytes); }
  }
  return { root, inputs, output: path.join(root, 'assembled') };
}
async function rejectsClean(f, pattern) {
  await assert.rejects(assembleCraftBundle(f), pattern);
  await assert.rejects(fs.lstat(f.output), { code: 'ENOENT' });
  assert.equal((await fs.readdir(f.root)).filter(name => name.startsWith('.assembled.assembling-')).length, 0, 'failed staging directories are removed');
}

test('13 synthetic artifacts assemble a complete locked manifest, byte-exact binaries and merged shared licenses', async t => {
  const f = await fixture(t), result = await assembleCraftBundle(f);
  assert.equal(result.engines.length, 13); assert.equal(result.platform, 'linux'); assert.equal(result.arch, 'x64');
  const manifest = await readManifest(result.binDirectory);
  assert.deepEqual(manifest.engines.map(engine => engine.id), lock.engines.map(engine => engine.id));
  for (const entry of manifest.engines) {
    const bytes = await fs.readFile(path.join(result.binDirectory, entry.binary));
    assert.equal(bytes.length, entry.bytes); assert.equal(sha(bytes), entry.sha256); assert.match(bytes.toString(), /non-native test bytes/);
    assert.equal((await fs.stat(path.join(result.binDirectory, entry.binary))).mode & 0o777, 0o755);
    assert.equal(entry.sourceCommit, lock.engines.find(engine => engine.id === entry.id).commit);
  }
  const report = JSON.parse(await fs.readFile(path.join(result.directory, 'assembly.json')));
  assert.equal(report.sourceLockHash, sha(lockBytes)); assert.equal(report.engineCount, 13);
  assert.match(report.verification, /no native execution/);
  assert.equal(Object.keys(report.notices).filter(name => name === 'licenses/craft-fonts/LICENSE-MIT').length, 1);
  assert.equal(await fs.readFile(path.join(result.binDirectory, 'licenses/craft-fonts/LICENSE-MIT'), 'utf8'), 'Identical shared test notice.\n');
  const second = await assembleCraftBundle({ inputs: [result.binDirectory], output: path.join(f.root, 'reassembled') });
  assert.deepEqual(await readManifest(second.binDirectory), manifest, 'a verified complete bin directory can be an input');
});

test('missing and duplicate locked engines cannot produce a partial deployment directory', async t => {
  const f = await fixture(t);
  await rejectsClean({ ...f, inputs: f.inputs.slice(1) }, /Missing engines/);
  await rejectsClean({ ...f, inputs: [f.inputs[0], ...f.inputs.slice(0, -1)] }, /Duplicate input/);
  const clone = path.join(f.root, 'duplicate'); await fs.cp(f.inputs[0], clone, { recursive: true });
  await rejectsClean({ ...f, inputs: [...f.inputs.slice(0, -1), clone] }, /duplicate engine/);
});

test('mixed platforms, mixed architectures and a false build target are rejected', async t => {
  const f = await fixture(t), original = await readManifest(f.inputs[1]);
  for (const change of [{ platform: 'darwin' }, { arch: 'arm64' }]) {
    await saveManifest(f.inputs[1], { ...original, ...change }); await rejectsClean(f, /Mixed platform or architecture/);
  }
  await saveManifest(f.inputs[1], original);
  const first = await readManifest(f.inputs[0]); first.engines[0].build.target = 'aarch64-apple-darwin';
  await saveManifest(f.inputs[0], first); await rejectsClean(f, /Build provenance/);
});

test('source commit, source-lock hash and compiler provenance must match the actual repository lock', async t => {
  const f = await fixture(t), original = await readManifest(f.inputs[0]);
  for (const mutate of [entry => { entry.sourceCommit = '0'.repeat(40); }, entry => { entry.build.sourceLockHash = '0'.repeat(64); }, entry => { entry.build.toolchain = '1.0.0'; }]) {
    const manifest = structuredClone(original); mutate(manifest.engines[0]); await saveManifest(f.inputs[0], manifest);
    await rejectsClean(f, /source commit|provenance/);
  }
});

test('both incorrect byte counts and same-size binary modifications fail integrity checks', async t => {
  const f = await fixture(t), original = await readManifest(f.inputs[0]);
  const manifest = structuredClone(original); manifest.engines[0].bytes++; await saveManifest(f.inputs[0], manifest);
  await rejectsClean(f, /checksum\/bytes mismatch/);
  await saveManifest(f.inputs[0], original);
  const file = path.join(f.inputs[0], original.engines[0].binary), bytes = await fs.readFile(file); bytes[0] ^= 1; await fs.writeFile(file, bytes);
  await rejectsClean(f, /checksum\/bytes mismatch/);
});

test('unsafe manifest binary names and unlisted files cannot escape or expand the package', async t => {
  const f = await fixture(t), original = await readManifest(f.inputs[0]);
  for (const binary of ['../escape', '/tmp/escape', 'nested/photocraft-cli', 'C:\\escape']) {
    const manifest = structuredClone(original); manifest.engines[0].binary = binary; await saveManifest(f.inputs[0], manifest); await rejectsClean(f, /Invalid binary manifest/);
  }
  await saveManifest(f.inputs[0], original); await fs.writeFile(path.join(f.inputs[0], 'unlisted-script.sh'), 'never execute');
  await rejectsClean(f, /Unexpected file/);
});

test('symbolic links are rejected at input roots, binaries and inside license directories', async t => {
  const f = await fixture(t), alias = path.join(f.root, 'alias'); await fs.symlink(f.inputs[0], alias);
  await rejectsClean({ ...f, inputs: [alias, ...f.inputs.slice(1)] }, /real directory/);
  const file = path.join(f.inputs[0], `${lock.engines[0].id}-cli`), saved = path.join(f.root, 'saved-binary');
  await fs.rename(file, saved); await fs.symlink(saved, file); await rejectsClean(f, /Symlink/);
  await fs.unlink(file); await fs.rename(saved, file);
  const notice = path.join(f.inputs[0], 'licenses', 'linked'); await fs.symlink(f.inputs[1], notice);
  await rejectsClean(f, /Symlink/);
});

test('conflicting shared license bytes and unsafe/case-conflicting paths fail instead of overwriting', async t => {
  const f = await fixture(t), notice = path.join(f.inputs[1], 'licenses/craft-fonts/LICENSE-MIT');
  await fs.writeFile(notice, 'Different license bytes.\n'); await rejectsClean(f, /License conflict/);
  await fs.writeFile(notice, 'Identical shared test notice.\n');
  const unsafe = path.join(f.inputs[0], 'licenses', 'bad:name'); await fs.writeFile(unsafe, 'unsafe'); await rejectsClean(f, /Unsafe artifact path/);
  await fs.unlink(unsafe); await fs.writeFile(path.join(f.inputs[1], 'licenses/craft-fonts/license-mit'), 'conflicting spelling');
  await rejectsClean(f, /Conflicting artifact path spelling|License conflict/);
});

test('missing license provenance and mismatched BUILD metadata fail closed', async t => {
  const f = await fixture(t), file = path.join(f.inputs[0], `licenses/${lock.engines[0].id}/BUILD.json`), original = await fs.readFile(file);
  await fs.writeFile(file, '{}'); await rejectsClean(f, /BUILD.json disagrees/);
  await fs.writeFile(file, original); await fs.unlink(path.join(f.inputs[0], 'licenses/craft-fonts/PROVENANCE.json'));
  await rejectsClean(f, /metadata is missing/);
});

test('existing files, empty directories and nonempty directories are never replaced, including at atomic publication', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.output, 'existing'); await assert.rejects(assembleCraftBundle(f), /Output already exists/); assert.equal(await fs.readFile(f.output, 'utf8'), 'existing'); await fs.unlink(f.output);
  for (const populated of [false, true]) {
    await fs.mkdir(f.output); if (populated) await fs.writeFile(path.join(f.output, 'keep'), 'existing');
    await assert.rejects(assembleCraftBundle(f), /Output already exists/);
    const stage = path.join(f.root, 'stage'); await fs.mkdir(stage); await fs.writeFile(path.join(stage, 'new'), 'new');
    await assert.rejects(publishCraftDirectory(stage, f.output), /Atomic publication failed/);
    assert.equal(await fs.readFile(path.join(stage, 'new'), 'utf8'), 'new');
    assert.deepEqual(await fs.readdir(f.output), populated ? ['keep'] : []);
    await fs.rm(stage, { recursive: true }); await fs.rm(f.output, { recursive: true });
  }
});

test('competing complete assemblies publish exactly one output and clean all staging directories', async t => {
  const f = await fixture(t), results = await Promise.allSettled([assembleCraftBundle(f), assembleCraftBundle(f)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal((await readManifest(path.join(f.output, 'bin'))).engines.length, 13);
  assert.equal((await fs.readdir(f.root)).some(name => name.startsWith('.assembled.assembling-')), false);
});

test('CLI accepts repeated inputs without invoking native binaries and prints the completed bin path', async t => {
  const f = await fixture(t);
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...f.inputs.flatMap(input => ['--input', input]), '--output', f.output], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
    child.on('error', reject); child.on('exit', code => resolve({ code, stdout, stderr }));
  });
  assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).binDirectory, path.join(f.output, 'bin'));
});
