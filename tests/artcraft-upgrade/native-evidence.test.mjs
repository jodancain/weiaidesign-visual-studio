import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

// Execute the actual Node setup program embedded in the Windows executor,
// replacing only its fixed owned paths with this test's private directory.
const source = fs.readFileSync(new URL('../../scripts/artcraft-upgrade/upgrade.ps1', import.meta.url), 'utf8');
const program = source.match(/\$setup="(import fs from 'node:fs';[^"\r\n]+)"/)?.[1];
assert.ok(program, 'native evidence setup program must be present');
function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'native-evidence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const parent = join(root, 'owned'), leaf = join(parent, 'unique-run');
  const code = program.replace("import fs from 'node:fs';", '')
    .replace("'/data/image2/upgrade-evidence'", JSON.stringify(parent))
    .replace("'$path'", JSON.stringify(leaf));
  return { root, parent, leaf, run: () => runInNewContext(code, { fs, console: { log() {} } }) };
}
test('creates an empty parent and unique evidence leaf, preserving earlier evidence on repeat', t => {
  const f = fixture(t); f.run(); fs.writeFileSync(join(f.leaf, 'receipt.json'), 'retained');
  assert.throws(f.run, { code: 'EEXIST' });
  assert.equal(fs.readFileSync(join(f.leaf, 'receipt.json'), 'utf8'), 'retained');
});
test('accepts an existing ordinary owned parent without altering neighboring evidence', t => {
  const f = fixture(t); fs.mkdirSync(f.parent); fs.writeFileSync(join(f.parent, 'previous'), 'retained'); f.run();
  assert.ok(fs.statSync(f.leaf).isDirectory());
  assert.equal(fs.readFileSync(join(f.parent, 'previous'), 'utf8'), 'retained');
});
test('rejects a symlink parent before creating anything in its target', t => {
  const f = fixture(t), elsewhere = join(f.root, 'elsewhere'); fs.mkdirSync(elsewhere); fs.symlinkSync(elsewhere, f.parent);
  assert.throws(f.run, /native_evidence_parent_invalid/);
  assert.deepEqual(fs.readdirSync(elsewhere), []); assert.ok(fs.lstatSync(f.parent).isSymbolicLink());
});
test('rejects a regular-file parent without changing its bytes', t => {
  const f = fixture(t); fs.writeFileSync(f.parent, 'retained'); assert.throws(f.run);
  assert.equal(fs.readFileSync(f.parent, 'utf8'), 'retained');
});
