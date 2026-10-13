#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { readFile, lstat, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';

const lockURL = new URL('./dependency-lock.json', import.meta.url);
const integrationURL = new URL('../../workers/code-video/enhance.mjs', import.meta.url);
const repository = 'https://github.com/2600th/dlss5-video-player';
const commit = '9752b5667284f23c21ead46f14abc971ecba48c6';
const tag = 'dlss5-video-player-v0.27.0';
const expectedParameters = { stages: 'nr', preset: 'natural', passes: 1, processingScale: 100, frameGeneration: false, superResolution: false };
const fileBindings = [
  { role: 'converter', relativePath: 'dlss5-convert.exe', constant: 'EXPECTED_EXE' },
  { role: 'neural-runtime', relativePath: 'neural-runtime/nvngx_dlssnr.dll', constant: 'EXPECTED_DLL' },
];

function help() {
  process.stdout.write(`Usage: node tools/dlss5/verify-runtime.mjs --lock-only
       node tools/dlss5/verify-runtime.mjs --package-dir <operator_directory>
       node tools/dlss5/verify-runtime.mjs --help

--lock-only    Validate dependency metadata and its binding to the Studio adapter.
--package-dir  Also hash the two required files in an operator-provided package.
This tool reads metadata/source/files only. It does not run binaries or download packages.
`);
}

function fail(code) { throw Object.assign(new Error(code), { code }); }
function requireValue(condition, code) { if (!condition) fail(code); }
function stringConstant(source, name) {
  const matches = [...source.matchAll(new RegExp(`\\bconst\\s+${name}\\s*=\\s*['"]([a-f0-9]{64})['"]`, 'g'))];
  requireValue(matches.length === 1, 'ADAPTER_PIN_NOT_FOUND');
  return matches[0][1];
}
function cliValue(source, flag) {
  const matches = [...source.matchAll(new RegExp(`['"]${flag}['"]\\s*,\\s*['"]([^'"]+)['"]`, 'g'))];
  requireValue(matches.length === 1, 'ADAPTER_PARAMETER_NOT_FOUND');
  return matches[0][1];
}

async function verifyLock() {
  let lock, source;
  try { lock = JSON.parse(await readFile(lockURL, 'utf8')); }
  catch { fail('DEPENDENCY_LOCK_UNREADABLE'); }
  try { source = await readFile(integrationURL, 'utf8'); }
  catch { fail('STUDIO_ADAPTER_UNREADABLE'); }
  requireValue(lock?.schemaVersion === 1, 'DEPENDENCY_LOCK_SCHEMA_INVALID');
  requireValue(lock.upstream?.repository === repository && lock.upstream.commit === commit && lock.upstream.tag === tag, 'UPSTREAM_PIN_INVALID');
  requireValue(lock.upstream.sourceUrl === `${repository}/tree/${commit}` && lock.upstream.sourceArchiveUrl === `${repository}/archive/${commit}.tar.gz` && lock.upstream.releaseUrl === `${repository}/releases/tag/${tag}`, 'UPSTREAM_URL_INVALID');
  const archive = lock.upstream.fullPackage;
  requireValue(archive?.name === 'dlss5-video-player-v0.27.0-win64.zip' && archive.bytes === 395738623 && archive.sha256 === 'a371e15cf5f935942534430a0ac1f453725a38ec2fb38aa81de7493836ca7677', 'PACKAGE_PIN_INVALID');
  requireValue(Array.isArray(lock.runtimeFiles) && lock.runtimeFiles.length === fileBindings.length, 'RUNTIME_FILE_SET_INVALID');
  for (const binding of fileBindings) {
    const entries = lock.runtimeFiles.filter(entry => entry?.role === binding.role);
    requireValue(entries.length === 1 && entries[0].relativePath === binding.relativePath && /^[a-f0-9]{64}$/.test(entries[0].sha256), 'RUNTIME_FILE_PIN_INVALID');
    requireValue(entries[0].sha256 === stringConstant(source, binding.constant), 'ADAPTER_HASH_PIN_MISMATCH');
  }
  requireValue(lock.parameters && Object.keys(lock.parameters).length === Object.keys(expectedParameters).length && Object.entries(expectedParameters).every(([key, value]) => lock.parameters[key] === value), 'NR_PARAMETER_PIN_INVALID');
  for (const [flag, value] of [['--stages', 'nr'], ['--preset', 'natural'], ['--passes', '1'], ['--processing-scale', '100']]) {
    requireValue(cliValue(source, flag) === value, 'ADAPTER_PARAMETER_PIN_MISMATCH');
  }
  requireValue(source.includes("join(runtimeDir,'neural-runtime','nvngx_dlssnr.dll')"), 'ADAPTER_RUNTIME_LAYOUT_MISMATCH');
  return lock;
}

async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function verifyPackage(directory, lock) {
  let directoryInfo;
  try { directoryInfo = await stat(directory); }
  catch { fail('PACKAGE_DIRECTORY_MISSING'); }
  requireValue(directoryInfo.isDirectory(), 'PACKAGE_DIRECTORY_INVALID');
  const files = [];
  for (const entry of lock.runtimeFiles) {
    const path = join(directory, ...entry.relativePath.split('/'));
    let info;
    try { info = await lstat(path); }
    catch (error) {
      if (error.code === 'ENOENT') { files.push({ relativePath: entry.relativePath, status: 'missing' }); continue; }
      files.push({ relativePath: entry.relativePath, status: 'unreadable' }); continue;
    }
    if (!info.isFile() || info.isSymbolicLink()) {
      files.push({ relativePath: entry.relativePath, status: 'not-regular-file' }); continue;
    }
    try {
      files.push({ relativePath: entry.relativePath, status: await hashFile(path) === entry.sha256 ? 'match' : 'mismatch' });
    } catch { files.push({ relativePath: entry.relativePath, status: 'unreadable' }); }
  }
  return files;
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.length === 1 && args[0] === '--help') { help(); return; }
  let lockOnly = false, packageDirectory;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--lock-only' && !lockOnly) lockOnly = true;
    else if (argument === '--package-dir' && !packageDirectory && args[index + 1] && !args[index + 1].startsWith('--')) packageDirectory = resolve(args[++index]);
    else fail('INVALID_ARGUMENTS');
  }
  requireValue(Boolean(lockOnly) !== Boolean(packageDirectory), 'CHOOSE_ONE_VERIFICATION_MODE');
  const lock = await verifyLock();
  const result = { ok: true, mode: lockOnly ? 'lock-only' : 'package-files', lockVerified: true, adapterPinsMatch: true, upstreamCommit: lock.upstream.commit };
  if (packageDirectory) {
    result.files = await verifyPackage(packageDirectory, lock);
    result.ok = result.files.every(file => file.status === 'match');
    if (!result.ok) process.exitCode = 1;
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

main().catch(error => {
  process.stderr.write(JSON.stringify({ ok: false, error: error.code || 'VERIFICATION_FAILED' }) + '\n');
  process.exitCode = 1;
});
