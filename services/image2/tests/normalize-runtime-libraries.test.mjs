import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, symlink, readlink, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeRuntimeLibraries } from '../ops/normalize-runtime-libraries.mjs';

async function fixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'runtime-library-links-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'trusted'), outside = join(base, 'outside'), alias = join(base, 'lib.so.3');
  await mkdir(root); await writeFile(outside, Buffer.from('7f454c466f757473696465', 'hex'));
  const target = join(root, 'lib.so.3.0'); await writeFile(target, Buffer.from('7f454c4666697874757265', 'hex'));
  const alternative = join(base, 'alternative'); await symlink(target, alternative); await symlink(alternative, alias);
  return { base, root, outside, alias, target, spec: { alias, trustedRoot: root }, owner: process.getuid() };
}
test('normalizes only the soname link, preserves ELF bytes, and is idempotent', async t => {
  const f = await fixture(t), before = await readFile(f.target);
  const result = await normalizeRuntimeLibraries([f.spec], f.owner);
  assert.equal(await readlink(f.alias), f.target); assert.deepEqual(await readFile(f.target), before);
  assert.equal(result.libraryBytesUnchanged, true); assert.equal(result.sandboxMountsUnchanged, true);
  assert.deepEqual(await normalizeRuntimeLibraries([f.spec], f.owner), { ...result, normalized: [{ ...result.normalized[0], originalLink: f.target }] });
});
test('rejects escaping targets, writable files, non-ELF files and untrusted owners before replacement', async t => {
  for (const kind of ['escape', 'writable', 'not-elf', 'wrong-owner', 'parent-writable']) {
    await t.test(kind, async t => {
      const f = await fixture(t), old = await readlink(f.alias);
      if (kind === 'escape') { await rm(f.target); await symlink(f.outside, f.target); }
      if (kind === 'writable') await chmod(f.target, 0o666);
      if (kind === 'not-elf') await writeFile(f.target, 'not a shared library');
      if (kind === 'parent-writable') await chmod(f.root, 0o777);
      const reasons = { escape: /escaped/, writable: /protected ordinary file/, 'not-elf': /must be ELF/, 'wrong-owner': /owned symlink/, 'parent-writable': /parent is not trusted/ };
      await assert.rejects(normalizeRuntimeLibraries([f.spec], kind === 'wrong-owner' ? f.owner + 1 : f.owner), reasons[kind]);
      assert.equal(await readlink(f.alias), old);
    });
  }
});
test('a later invalid library prevents all earlier link replacements', async t => {
  const a = await fixture(t), b = await fixture(t), before = await readlink(a.alias);
  await writeFile(b.target, 'invalid');
  await assert.rejects(normalizeRuntimeLibraries([a.spec, b.spec], a.owner), /must be ELF/);
  assert.equal(await readlink(a.alias), before);
});
