/** Image-build-only repair of Debian soname links; library bytes are never changed. */
import assert from 'node:assert/strict';
import { lstat, realpath, readFile, readlink, symlink, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const systemLibraries = ['blas', 'lapack'].map(name => ({
  alias: `/usr/lib/x86_64-linux-gnu/lib${name}.so.3`,
  trustedRoot: `/usr/lib/x86_64-linux-gnu/${name}`,
}));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

export async function normalizeRuntimeLibraries(specs = systemLibraries, owner = 0) {
  const verified = [];
  // Verify the entire fixed set before replacing any link.
  for (const { alias, trustedRoot } of specs) {
    const link = await lstat(alias);
    assert.ok(link.isSymbolicLink() && link.uid === owner, 'Soname must be an owned symlink');
    const root = await realpath(trustedRoot), target = await realpath(alias);
    assert.equal(root, resolve(trustedRoot), 'Trusted root must already be canonical');
    assert.ok(target.startsWith(root + '/'), 'Library target escaped its fixed system root');
    for (let parent = dirname(target); ; parent = dirname(parent)) {
      const stat = await lstat(parent);
      assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === owner && !(stat.mode & 0o022), 'Library parent is not trusted');
      if (parent === root) break;
      assert.ok(parent.startsWith(root + '/'));
    }
    const stat = await lstat(target), bytes = await readFile(target);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.uid === owner && !(stat.mode & 0o022), 'Library must be a protected ordinary file');
    assert.equal(bytes.subarray(0, 4).toString('hex'), '7f454c46', 'Library must be ELF');
    verified.push({ alias, target, originalLink: await readlink(alias), sha256: sha(bytes), bytes: bytes.length, uid: stat.uid, mode: stat.mode & 0o777 });
  }
  for (const item of verified) {
    if (item.originalLink !== item.target) {
      const temporary = join(dirname(item.alias), '.' + item.alias.split('/').at(-1) + '.artcraft-normalized');
      await symlink(item.target, temporary); // Refuse preexisting staging paths.
      await rename(temporary, item.alias);
    }
    assert.equal(await readlink(item.alias), item.target);
    assert.equal(await realpath(item.alias), item.target);
    assert.equal(sha(await readFile(item.alias)), item.sha256, 'Library bytes changed');
  }
  return { normalized: verified, libraryBytesUnchanged: true, sandboxMountsUnchanged: true };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64'); assert.equal(process.getuid(), 0, 'Image build root is required');
  console.log(JSON.stringify(await normalizeRuntimeLibraries()));
}
