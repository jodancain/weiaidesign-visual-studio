/** Verify the unchanged pinned Linux archive after GNU tar hydration. No execution. */
import assert from 'node:assert/strict';
import { readFileSync, lstatSync, accessSync, constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export function verifyBundle(root, expectedManifest, lock) {
  const bytes = readFileSync(join(root, 'manifest.json'));
  assert.equal(sha(bytes), expectedManifest);
  const manifest = JSON.parse(bytes);
  assert.equal(manifest.platform, 'linux'); assert.equal(manifest.arch, 'x64');
  assert.equal(manifest.engines.length, 13); assert.equal(lock.engines.length, 13);
  assert.equal(new Set(manifest.engines.map(e => e.id)).size, 13);
  const binaries = manifest.engines.map(entry => {
    const engine = lock.engines.find(e => e.id === entry.id);
    assert.ok(engine); assert.equal(entry.sourceCommit, engine.commit);
    assert.equal(entry.binary, `${engine.id}-cli`);
    const file = join(root, entry.binary), stat = lstatSync(file), binary = readFileSync(file);
    assert.ok(stat.isFile() && !stat.isSymbolicLink());
    assert.ok(stat.mode & 0o111); accessSync(file, constants.R_OK | constants.X_OK);
    assert.equal(binary.length, entry.bytes); assert.equal(sha(binary), entry.sha256);
    assert.equal(binary.subarray(0, 4).toString('hex'), '7f454c46');
    assert.equal(binary[4], 2); assert.equal(binary[5], 1); assert.equal(binary.readUInt16LE(18), 62);
    return { id: entry.id, bytes: binary.length, sha256: entry.sha256, elf64X86: true, executable: true };
  });
  return { passed: true, root, manifestSha256: expectedManifest, binaries };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const lock = JSON.parse(readFileSync(new URL('../craft-engines.lock.json', import.meta.url)));
    console.log(JSON.stringify(verifyBundle('/opt/artcraft', '8e050bb717ab92246fec121a4e8bff45e328c1b9ff0994b015fc99c2dcc45509', lock)));
  } catch { process.stderr.write('native bundle root/manifest/ELF verification failed\n'); process.exitCode = 1; }
}
