import test from 'node:test';
import assert from 'node:assert/strict';
import { createImageDocument, applyCommands, mergeBranch, inspectBytes, digest, requireOwner } from '../domain.mjs';

const textLayer = id => ({ id, type: 'text', text: '原字', width: 200, height: 40 });
test('document commands preserve typed text and reject identity, graph, geometry and unregistered asset corruption', () => {
  const document = createImageDocument({ width: 600, height: 400, layers: [textLayer('a')] });
  const changed = applyCommands(document, [{ type: 'layer.update', layerId: 'a', patch: { text: '新字', fill: '#ff0000' } }]);
  assert.equal(changed.layers[0].text, '新字'); assert.equal(document.layers[0].text, '原字');
  for (const patch of [{ id: 'fake' }, { opacity: 2 }, { x: Infinity }, { assetId: 'unregistered' }, { parentId: 'a' }]) {
    assert.throws(() => applyCommands(document, [{ type: 'layer.update', layerId: 'a', patch }]));
  }
  assert.throws(() => createImageDocument({ width: 32768, height: 32768 }), /dimensions/);
  assert.throws(() => requireOwner(undefined), /visitor/);
});
test('group removal is recursive and reorder requires every stable layer id exactly once', () => {
  const d = createImageDocument({ layers: [{ id: 'group', type: 'group' }, { ...textLayer('a'), parentId: 'group' }, textLayer('b')] });
  const removed = applyCommands(d, [{ type: 'layer.remove', layerId: 'group' }]); assert.deepEqual(removed.layers.map(l => l.id), ['b']);
  assert.throws(() => applyCommands(d, [{ type: 'layer.reorder', layerIds: ['a','a','b'] }]));
});
test('branch merges disjoint layers and rejects concurrent changes to the same layer', () => {
  const base = createImageDocument({ layers: [textLayer('a'),textLayer('b')] });
  const local = applyCommands(base, [{ type: 'layer.update', layerId: 'a', patch: { text: '主分支' } }]);
  const branch = applyCommands(base, [{ type: 'layer.update', layerId: 'b', patch: { text: '候选' } }]);
  const merged = mergeBranch(base, local, branch); assert.deepEqual(merged.layers.map(l => l.text), ['主分支','候选']);
  const conflict = applyCommands(base, [{ type: 'layer.update', layerId: 'a', patch: { text: '另一候选' } }]);
  assert.throws(() => mergeBranch(base, local, conflict), e => e.status === 409 && e.code === 'branch_conflict');
});
test('canonical hashes are stable while unsafe SVGs and MIME lies are rejected', () => {
  assert.equal(digest({ b: 2, a: 1 }), digest({ a: 1, b: 2 }));
  assert.throws(() => inspectBytes(Buffer.from('not png'), 'image/png'));
  for (const markup of ['<svg><script>alert(1)</script></svg>', '<svg><image href="https://example.com/a"/></svg>', '<svg><rect onclick="x"/></svg>']) assert.throws(() => inspectBytes(Buffer.from(markup), 'image/svg+xml'));
  assert.equal(inspectBytes(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><path fill="#000" d="M0 0L1 1"/></svg>'), 'image/svg+xml').mime, 'image/svg+xml');
});
test('locked layers and locked group descendants cannot change except explicit own unlock', () => {
  const d = createImageDocument({ layers: [{ ...textLayer('logo'), locked: true, z: 0 }, { id: 'group', type: 'group', locked: true, z: 1 }, { ...textLayer('child'), parentId: 'group', z: 2 }] });
  for (const commands of [
    [{ type: 'layer.update', layerId: 'logo', patch: { text: 'changed' } }],
    [{ type: 'layer.update', layerId: 'child', patch: { x: 20 } }],
    [{ type: 'layer.update', layerId: 'child', patch: { locked: false } }],
    [{ type: 'layer.remove', layerId: 'group' }],
    [{ type: 'layer.reorder', layerIds: ['group','logo','child'] }],
    [{ type: 'layer.add', layer: { ...textLayer('new'), parentId: 'group' } }],
  ]) assert.throws(() => applyCommands(d, commands), e => e.code === 'layer_locked');
  const unlocked = applyCommands(d, [{ type: 'layer.update', layerId: 'logo', patch: { locked: false } }, { type: 'layer.update', layerId: 'logo', patch: { text: 'allowed' } }]);
  assert.equal(unlocked.layers[0].text, 'allowed');
});
test('server text defaults match the editor while explicit typography remains unchanged', () => {
  const d=createImageDocument({layers:[textLayer('default'),{...textLayer('explicit'),fontSize:48,fill:'#ff0000',lineHeight:1.5,tracking:2,fontWeight:700}]});
  assert.deepEqual(['fontSize','fill','lineHeight','tracking','fontWeight'].map(k=>d.layers[0][k]),[24,'#20232b',1.2,0,400]);
  assert.equal(d.layers[1].fontSize,48);assert.equal(d.layers[1].fill,'#ff0000');
});
