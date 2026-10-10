import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createProject } from '../../gateway/studio/domain.mjs';

const { build } = createRequire(resolve('web/package.json'))('esbuild');
const directory = await mkdtemp(join(tmpdir(), 'studio-environment-runtime-'));
const output = join(directory, 'runtime.mjs');
await build({ entryPoints: [resolve('workers/code-video/browser-runtime.ts')], outfile: output, bundle: true, platform: 'node', format: 'esm', nodePaths: [resolve('web/node_modules')], logLevel: 'silent' });
const { createRuntime } = await import(pathToFileURL(output).href);
test.after(() => rm(directory, { recursive: true, force: true }));

function fixture() {
  const data = createProject({ demo: false }).scenes[0];
  data.background = '#344155'; data.groundColor = '#797573';
  data.objects = [{ id: 'cube', kind: 'box', name: 'cube', color: '#d69b41', visible: true, locked: false, transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } }];
  return { width: 1280, height: 720, sceneSnapshot: data };
}

test('ordinary scene exports the director background, ground and default lighting without editor helpers', async () => {
  const runtime = await createRuntime(fixture());
  try {
    assert.equal(runtime.scene.background.getHexString(), '344155');
    const ground = runtime.scene.children.find(o => o.isMesh && o.geometry.type === 'PlaneGeometry'); assert.ok(ground, 'visible director ground must be rendered');
    assert.deepEqual([ground.geometry.parameters.width, ground.geometry.parameters.height], [200, 200]);
    assert.deepEqual(ground.position.toArray(), [0, -.025, 0]); assert.equal(ground.rotation.x, -Math.PI / 2); assert.equal(ground.receiveShadow, true);
    assert.equal(ground.material.color.getHexString(), '797573'); assert.equal(ground.material.roughness, .9);
    const lights = runtime.scene.children.filter(o => o.isLight); assert.equal(lights.length, 2);
    const key = lights.find(o => o.isDirectionalLight), fill = lights.find(o => o.isAmbientLight);
    assert.deepEqual(key.position.toArray(), [4, 7, 5]); assert.equal(key.intensity, 3); assert.equal(key.color.getHexString(), 'ffffff'); assert.equal(key.castShadow, true); assert.deepEqual(key.shadow.mapSize.toArray(), [2048, 2048]);
    assert.equal(fill.intensity, .7); assert.equal(fill.color.getHexString(), 'd9e2ff');
    const helpers = []; runtime.scene.traverse(o => { if (o.userData.studioHelper || o.isGridHelper || o.isAxesHelper) helpers.push(o.type); }); assert.deepEqual(helpers, []);
    runtime.evaluateFrame(72); assert.equal(runtime.camera.aspect, 16 / 9);
  } finally { runtime.dispose(); }
});

test('explicit lights=[] and showGround=false do not silently reintroduce defaults', async () => {
  const spec = fixture(); spec.sceneSnapshot.lights = []; spec.sceneSnapshot.showGround = false;
  const runtime = await createRuntime(spec);
  try { assert.equal(runtime.scene.children.filter(o => o.isLight).length, 0); assert.equal(runtime.scene.children.filter(o => o.isMesh && o.geometry.type === 'PlaneGeometry').length, 0); assert.equal(runtime.scene.environment, null); assert.equal(runtime.scene.background.getHexString(), '344155'); }
  finally { runtime.dispose(); }
});

test('all authored light types preserve position, intensity and color and dispose owned ground/shadows', async () => {
  const spec = fixture(); spec.sceneSnapshot.lights = [{ id: 'ambient-custom', type: 'ambient', color: '#123456', intensity: .23, position: [0, 0, 0] }, { id: 'point-custom', type: 'point', color: '#abcdef', intensity: 12, position: [1, 2, 3] }, { id: 'sun-custom', type: 'directional', color: '#fedcba', intensity: 4, position: [-2, 6, 1] }];
  const runtime = await createRuntime(spec); const lights = runtime.scene.children.filter(o => o.isLight); assert.equal(lights.length, 3);
  for (const value of spec.sceneSnapshot.lights) { const actual = lights.find(o => o.name === value.id); assert.ok(actual); assert.equal(actual.intensity, value.intensity); assert.equal(actual.color.getHexString(), value.color.slice(1)); assert.deepEqual(actual.position.toArray(), value.position); assert.equal(Boolean(actual.castShadow), value.type !== 'ambient'); }
  assert.equal(lights.find(o => o.isPointLight).shadow.mapSize.x, 512, 'matches existing director point-light default');
  assert.equal(lights.find(o => o.isDirectionalLight).shadow.mapSize.x, 2048);
  const ground = runtime.scene.children.find(o => o.isMesh && o.geometry.type === 'PlaneGeometry'); let geometryDisposed = false, materialDisposed = false;
  ground.geometry.addEventListener('dispose', () => { geometryDisposed = true; }); ground.material.addEventListener('dispose', () => { materialDisposed = true; }); runtime.dispose(); assert.equal(geometryDisposed, true); assert.equal(materialDisposed, true);
});
