#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lockFile = path.join(repository, 'services/image2/craft-engines.lock.json');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const manifestLimit = 1024 * 1024, noticeLimit = 32 * 1024 * 1024, binaryLimit = 2 * 1024 ** 3;
const platforms = { linux: { x64: 'x86_64-unknown-linux-gnu', arm64: 'aarch64-unknown-linux-gnu' }, darwin: { x64: 'x86_64-apple-darwin', arm64: 'aarch64-apple-darwin' } };
const fail = message => { throw new Error(message); };
const sameStamp = (a, b) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key]);
const within = (parent, child) => child === parent || child.startsWith(parent + path.sep);

function safeRelative(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || /[:\x00-\x1f\x7f]/.test(value) || path.posix.isAbsolute(value) || value.split('/').some(part => !part || ['.', '..'].includes(part) || /[. ]$/.test(part))) fail(`Unsafe artifact path: ${String(value)}`);
  return value;
}
async function absent(file) {
  try { await fs.lstat(file); fail(`Output already exists: ${file}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
async function sourceRoot(input) {
  const root = path.resolve(input), stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`Input must be a real directory: ${input}`);
  return fs.realpath(root);
}
async function inventory(root) {
  const files = new Map(), names = new Set();
  async function walk(directory, prefix = '') {
    for (const name of (await fs.readdir(directory)).sort()) {
      const relative = safeRelative(prefix ? `${prefix}/${name}` : name), key = relative.normalize('NFC').toLowerCase();
      if (names.has(key)) fail(`Conflicting artifact path spelling: ${relative}`);
      names.add(key); if (names.size > 100000) fail('Artifact contains too many paths');
      const file = path.join(root, relative), stat = await fs.lstat(file, { bigint: true });
      if (stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile()) fail(`Symlink or special file is forbidden: ${relative}`);
      if (stat.isDirectory()) await walk(file, relative);
      else files.set(relative, { file, stat });
    }
  }
  await walk(root); return files;
}
async function readFile(entry, limit) {
  if (!entry || entry.stat.size > BigInt(limit)) fail('Required metadata is missing or exceeds its size limit');
  const handle = await fs.open(entry.file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || !sameStamp(before, entry.stat)) fail('Artifact changed during validation');
    const bytes = await handle.readFile();
    if (bytes.length > limit || !sameStamp(before, await handle.stat({ bigint: true }))) fail('Artifact changed during validation');
    return bytes;
  } finally { await handle.close(); }
}
const readJson = async (entry, limit = manifestLimit) => JSON.parse((await readFile(entry, limit)).toString('utf8'));

async function copyChecked(entry, destination, { limit, compare = false, mode = 0o644 }) {
  if (!entry || entry.stat.size > BigInt(limit)) fail('Artifact file is missing or exceeds its size limit');
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const source = await fs.open(entry.file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let target;
  try {
    const before = await source.stat({ bigint: true });
    if (!before.isFile() || !sameStamp(before, entry.stat)) fail('Artifact changed during copying');
    target = await fs.open(destination, compare ? 'r' : 'wx', mode);
    const digest = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024), other = compare ? Buffer.alloc(buffer.length) : null;
    let total = 0;
    for (;;) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, total);
      if (!bytesRead) break;
      total += bytesRead; if (total > limit) fail('Artifact file exceeds its size limit');
      const chunk = buffer.subarray(0, bytesRead); digest.update(chunk);
      if (compare) {
        const existing = await target.read(other, 0, bytesRead, total - bytesRead);
        if (existing.bytesRead !== bytesRead || !chunk.equals(other.subarray(0, bytesRead))) fail(`License conflict: ${path.basename(destination)}`);
      } else {
        let written = 0;
        while (written < bytesRead) { const result = await target.write(chunk, written, bytesRead - written); if (!result.bytesWritten) fail('Could not finish artifact copy'); written += result.bytesWritten; }
      }
    }
    if (BigInt(total) !== before.size || !sameStamp(before, await source.stat({ bigint: true }))) fail('Artifact changed during copying');
    if (compare && (await target.stat()).size !== total) fail(`License conflict: ${path.basename(destination)}`);
    if (!compare) { await target.chmod(mode); await target.sync(); }
    return { bytes: total, sha256: digest.digest('hex') };
  } finally { await source.close(); await target?.close(); }
}

// Node's POSIX rename can replace an existing empty directory. These fixed system
// calls publish the whole staged tree atomically and refuse even a racing target.
const publishPython = String.raw`
import ctypes, os, sys
source, destination = sys.argv[1:]
if not os.path.isabs(source) or not os.path.isabs(destination) or os.path.dirname(source) != os.path.dirname(destination):
    raise RuntimeError('Publication requires sibling absolute paths')
if os.path.islink(source) or not os.path.isdir(source):
    raise RuntimeError('Publication source must be a real directory')
libc = ctypes.CDLL(None, use_errno=True)
if sys.platform == 'linux':
    rename = libc.renameat2
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    result = rename(-100, os.fsencode(source), -100, os.fsencode(destination), 1)
elif sys.platform == 'darwin':
    rename = libc.renamex_np
    rename.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    result = rename(os.fsencode(source), os.fsencode(destination), 4)
else:
    raise RuntimeError('Atomic publication is supported only on Linux and macOS')
if result:
    errno = ctypes.get_errno()
    raise OSError(errno, os.strerror(errno))
`;
export function publishCraftDirectory(source, destination) {
  if (!['linux', 'darwin'].includes(process.platform)) return Promise.reject(new Error('Atomic publication requires Linux/macOS and /usr/bin/python3'));
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/python3', ['-I', '-c', publishPython, source, destination], { shell: false, stdio: ['ignore', 'ignore', 'pipe'], env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } });
    let stderr = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 10000);
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error(`Atomic publication failed${timedOut ? ' (timeout)' : ''}: ${stderr.trim() || `exit ${code}`}`)); });
  });
}

function validateBuild(entry, engine, lock, lockHash, platform, arch) {
  const build = entry.build;
  if (!build || build.sourceLockHash !== lockHash || build.toolchain !== lock.rustToolchain || build.package !== engine.package || !isDeepStrictEqual(build.features, engine.features) || build.defaultFeatures !== (engine.defaultFeatures !== false) || !['dev', 'release'].includes(build.profile) || build.target !== platforms[platform]?.[arch]) fail(`Build provenance does not match the source lock/platform: ${engine.id}`);
  if (build.fonts?.sourceCommit !== lock.fonts.commit || build.fonts.required !== true || build.fonts.figcraftEmbedCjk !== true || !/^[a-f0-9]{64}$/.test(build.fonts.provenanceHash || '') || !/^[a-f0-9]{64}$/.test(build.cargoLockHash || '')) fail(`Missing pinned font/dependency provenance: ${engine.id}`);
  if (!Array.isArray(build.fonts.manifests) || !build.fonts.manifests.length) fail(`Missing shared font manifests: ${engine.id}`);
}

async function normalizeDirectories(directory) {
  await fs.chmod(directory, 0o755);
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) if (entry.isDirectory()) await normalizeDirectories(path.join(directory, entry.name));
}

/** Assemble existing build artifacts only. No download, compilation or engine execution. */
export async function assembleCraftBundle({ inputs, output }) {
  if (!Array.isArray(inputs) || !inputs.length || inputs.length > 13 || inputs.some(input => typeof input !== 'string' || !input) || typeof output !== 'string' || !output) fail('Provide 1–13 --input directories and one new --output directory');
  const lockBytes = await fs.readFile(lockFile), lock = JSON.parse(lockBytes), lockHash = hash(lockBytes);
  if (lock.version !== 1 || lock.engines?.length !== 13 || new Set(lock.engines.map(engine => engine.id)).size !== 13 || lock.engines.some(engine => !/^[a-z]+$/.test(engine.id) || !/^[a-f0-9]{40}$/.test(engine.commit) || engine.package !== `${engine.id}-cli`)) fail('Expected the complete pinned 13-engine source lock');
  const requestedOutput = path.resolve(output); await absent(requestedOutput);
  const parent = await fs.realpath(path.dirname(requestedOutput)), destination = path.join(parent, path.basename(requestedOutput));
  await absent(destination);
  const roots = await Promise.all(inputs.map(sourceRoot));
  if (new Set(roots).size !== roots.length) fail('Duplicate input directory');
  if (roots.some(root => within(root, destination) || within(destination, root))) fail('Input and output directories must not overlap');
  let stage = await fs.mkdtemp(path.join(parent, `.${path.basename(destination)}.assembling-`));
  try {
    const bin = path.join(stage, 'bin'), engines = new Map(), copied = new Map(), notices = new Map(), provenance = [];
    let platform, arch, totalBytes = 0;
    await fs.mkdir(bin);
    for (const root of roots) {
      const files = await inventory(root), manifestBytes = await readFile(files.get('manifest.json'), manifestLimit), manifest = JSON.parse(manifestBytes);
      if (manifest.version !== 1 || !platforms[manifest.platform]?.[manifest.arch] || !Array.isArray(manifest.engines) || !manifest.engines.length) fail('Unsupported or malformed input manifest');
      if (platform && (platform !== manifest.platform || arch !== manifest.arch)) fail('Mixed platform or architecture artifacts');
      platform = manifest.platform; arch = manifest.arch;
      const binaries = new Set();
      for (const entry of manifest.engines) {
        const engine = lock.engines.find(item => item.id === entry.id);
        if (!engine || engines.has(entry.id)) fail(`Unknown or duplicate engine: ${entry.id}`);
        if (entry.sourceCommit !== engine.commit || entry.binary !== `${engine.id}-cli` || !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0 || entry.bytes > binaryLimit || !/^[a-f0-9]{64}$/.test(entry.sha256 || '')) fail(`Invalid binary manifest or source commit: ${engine.id}`);
        safeRelative(entry.binary); validateBuild(entry, engine, lock, lockHash, platform, arch);
        const license = `licenses/${engine.id}/`;
        if (!isDeepStrictEqual(await readJson(files.get(`${license}BUILD.json`)), entry.build)) fail(`BUILD.json disagrees with manifest: ${engine.id}`);
        if (hash(await readFile(files.get(`${license}Cargo.lock`), noticeLimit)) !== entry.build.cargoLockHash) fail(`Cargo.lock checksum mismatch: ${engine.id}`);
        await readJson(files.get(`${license}dependencies.json`));
        const source = (await readFile(files.get(`${license}SOURCE.txt`), manifestLimit)).toString('utf8');
        if (!source.startsWith(`${engine.repository}\ncommit ${engine.commit}\n`)) fail(`SOURCE.txt disagrees with pinned source: ${engine.id}`);
        if (![...files.keys()].some(name => name.startsWith(license) && /^(?:licen[sc]e|copying|notice|copyright)(?:[-_. ]|$)/i.test(path.posix.basename(name)))) fail(`Engine license notices are missing: ${engine.id}`);
        const fontProvenance = await readJson(files.get('licenses/craft-fonts/PROVENANCE.json'));
        if (fontProvenance.sourceCommit !== lock.fonts.commit || hash(JSON.stringify(fontProvenance)) !== entry.build.fonts.provenanceHash) fail(`Shared font provenance mismatch: ${engine.id}`);
        for (const name of ['ATTRIBUTION.md', 'LICENSE-MIT', 'LICENSE-APACHE']) await readFile(files.get(`licenses/craft-fonts/${name}`), noticeLimit);
        for (const fontManifest of entry.build.fonts.manifests || []) if (hash(await readFile(files.get(`licenses/craft-fonts/${safeRelative(fontManifest.name)}`), noticeLimit)) !== fontManifest.sha256) fail(`Shared font manifest mismatch: ${engine.id}`);
        const actual = await copyChecked(files.get(entry.binary), path.join(bin, entry.binary), { limit: binaryLimit, mode: 0o755 });
        if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256) fail(`Binary checksum/bytes mismatch: ${engine.id}`);
        totalBytes += actual.bytes; binaries.add(entry.binary); engines.set(entry.id, entry);
      }
      for (const [name, entry] of files) {
        if (name === 'manifest.json' || binaries.has(name)) continue;
        if (!name.startsWith('licenses/')) fail(`Unexpected file outside the manifest/license tree: ${name}`);
        const key = name.normalize('NFC').toLowerCase(), previous = copied.get(key);
        if (previous && previous !== name) fail(`Conflicting license path spelling: ${name}`);
        const actual = await copyChecked(entry, path.join(bin, name), { limit: noticeLimit, compare: !!previous });
        if (!previous) { totalBytes += actual.bytes; notices.set(name, actual); }
        copied.set(key, name);
      }
      if (totalBytes > 16 * 1024 ** 3) fail('Assembled bundle exceeds its total size budget');
      provenance.push({ manifestSha256: hash(manifestBytes), engines: manifest.engines.map(entry => entry.id) });
    }
    const missing = lock.engines.filter(engine => !engines.has(engine.id)).map(engine => engine.id);
    if (missing.length) fail(`Missing engines: ${missing.join(', ')}`);
    const manifest = { version: 1, platform, arch, engines: lock.engines.map(engine => engines.get(engine.id)) };
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
    if (manifestBytes.length > manifestLimit) fail('Assembled manifest exceeds the runtime size limit');
    await fs.writeFile(path.join(bin, 'manifest.json'), manifestBytes, { flag: 'wx', mode: 0o644 });
    await fs.writeFile(path.join(stage, 'assembly.json'), JSON.stringify({ version: 1, sourceLockHash: lockHash, platform, arch, manifestSha256: hash(manifestBytes), engineCount: engines.size, inputs: provenance, notices: Object.fromEntries([...notices].sort(([a], [b]) => a.localeCompare(b))), verification: 'file integrity and locked build metadata only; no native execution' }, null, 2) + '\n', { flag: 'wx', mode: 0o644 });
    await fs.chmod(path.join(bin, 'manifest.json'), 0o644); await fs.chmod(path.join(stage, 'assembly.json'), 0o644);
    await normalizeDirectories(stage);
    await publishCraftDirectory(stage, destination); stage = undefined;
    return { directory: destination, binDirectory: path.join(destination, 'bin'), platform, arch, engines: manifest.engines.map(entry => entry.id) };
  } finally { if (stage) await fs.rm(stage, { recursive: true, force: true }); }
}

async function main(args) {
  const inputs = []; let output;
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index], value = args[index + 1];
    if (!value || !['--input', '--output'].includes(option) || option === '--output' && output) fail('Usage: node scripts/assemble-craft-bundle.mjs --input ARTIFACT_DIR [--input ARTIFACT_DIR ...] --output NEW_DIRECTORY');
    if (option === '--input') inputs.push(value); else output = value;
  }
  console.log(JSON.stringify(await assembleCraftBundle({ inputs, output }), null, 2));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch(error => { console.error(`Craft bundle assembly failed: ${error.message}`); process.exitCode = 1; });
