import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { bakeScene, buildSceneRuntime, evaluateScene, identityTransform, sceneLandmarks } from '../../../lib/studio/animation';
import { inspectModelGLB } from '../../../lib/studio/animation-parts';
import type { AssetRevision, StudioScene } from '../../../lib/studio/types';
import { createPartsGLB } from './test-fixtures';

async function fixture() {
  const bytes = await createPartsGLB(), inspected = await inspectModelGLB(bytes), asset: AssetRevision = { id: 'parts-source', name: 'TwoParts.glb', kind: 'model', mime: 'model/gltf-binary', hash: 'fixture', url: `data:model/gltf-binary;base64,${Buffer.from(bytes).toString('base64')}`, bytes: bytes.byteLength, createdAt: '', metadata: inspected.metadata };
  const scene: StudioScene = { id: 'parts-scene', name: '静态GLB部件实测', revision: 1, units: 'meters', up: 'Y', objects: [{ id: 'assembly', name: 'Assembly', kind: 'model', assetId: asset.id, transform: identityTransform(), visible: true, locked: false, color: '#96a7ba', parts: inspected.parts }], cameras: [{ id: 'parts-camera', name: '主相机', position: [0, 1, 6], target: [0, .5, 0], focalLength: 35, sensorWidth: 36 }], activeCameraId: 'parts-camera', background: '#111827', groundColor: '#44495b', showGround: true, exposure: 1, clips: [], tracks: [] };
  return { scene, asset, inspected };
}

test('part identity and edits preserve the sibling transform, visibility and shared-source material', async () => {
  const { scene, asset, inspected } = await fixture(); assert.equal(inspected.parts.length, 2); assert.ok(inspected.metadata.partNodes.every(p => p.nodePath === `/nodes/${p.id.slice(10)}`));
  const again = await inspectModelGLB(await createPartsGLB()); assert.deepEqual(again.parts.map(p => p.id), inspected.parts.map(p => p.id)); const runtime = await buildSceneRuntime(scene, [asset]);
  try { const actor = runtime.actors.get('assembly')!, [left, right] = scene.objects[0].parts!; const rightNode = actor.parts.get(right.id)!; const original = { matrix: rightNode.matrixWorld.toArray(), color: ((rightNode as THREE.Mesh).material as THREE.MeshStandardMaterial).color.getHexString(), visible: rightNode.visible }; left.transform.position[0] = -1.2; left.color = '#ff0000'; left.visible = false; evaluateScene(runtime, scene, 0, 'static'); assert.deepEqual(rightNode.matrixWorld.toArray(), original.matrix); assert.equal(((rightNode as THREE.Mesh).material as THREE.MeshStandardMaterial).color.getHexString(), original.color); assert.equal(rightNode.visible, original.visible); assert.equal(actor.parts.get(left.id)!.visible, false); assert.equal(((actor.parts.get(left.id) as THREE.Mesh).material as THREE.MeshStandardMaterial).color.getHexString(), 'ff0000');
    left.visible = true; scene.tracks = [{ id: 'part-motion', targetId: 'assembly', partId: left.id, property: 'position', keys: [{ frame: 0, value: [-1.2, .45, 0], interpolation: 'linear' }, { frame: 12, value: [-1.2, .85, .2], interpolation: 'linear' }] }]; evaluateScene(runtime, scene, 6); const halfway = sceneLandmarks(runtime, 6); evaluateScene(runtime, scene, 0); evaluateScene(runtime, scene, 6); assert.deepEqual(sceneLandmarks(runtime, 6), halfway); assert.deepEqual(rightNode.matrixWorld.toArray(), original.matrix);
  } finally { runtime.dispose(); }
});

test('part tracks and intermediate assembly hierarchy survive actual GLB bake and reload', async () => {
  const { scene, asset } = await fixture(), [left, right] = scene.objects[0].parts!; left.color = '#dd5544'; scene.tracks = [{ id: 'left-move', targetId: 'assembly', partId: left.id, property: 'position', keys: [{ frame: 0, value: left.transform.position, interpolation: 'linear' }, { frame: 12, value: [-1.15, .75, .2], interpolation: 'smooth' }] }, { id: 'right-visibility', targetId: 'assembly', partId: right.id, property: 'visible', keys: [{ frame: 0, value: 1, interpolation: 'hold' }, { frame: 6, value: 0, interpolation: 'hold' }, { frame: 10, value: 1, interpolation: 'hold' }] }]; const runtime = await buildSceneRuntime(scene, [asset]);
  try { const result = await bakeScene(runtime, scene, 0, 13), bytes = await result.blob.arrayBuffer(), gltf = await new GLTFLoader().parseAsync(bytes, ''), mixer = new THREE.AnimationMixer(gltf.scene); mixer.clipAction(gltf.animations[0]).setLoop(THREE.LoopOnce, 1).play();
    for (const frame of [0, 6, 12]) { mixer.setTime(frame / 24); gltf.scene.updateMatrixWorld(true); evaluateScene(runtime, scene, frame); for (const expected of sceneLandmarks(runtime, frame).filter(item => item.partId)) { let marker: THREE.Object3D | undefined; gltf.scene.traverse(node => { if (node.userData.studioLandmark && node.userData.studioBoneId === expected.bone) marker = node; }); assert.ok(marker); assert.ok(marker.getWorldPosition(new THREE.Vector3()).distanceTo(new THREE.Vector3().fromArray(expected.position)) < 1e-6); assert.ok(marker.getWorldQuaternion(new THREE.Quaternion()).angleTo(new THREE.Quaternion().fromArray(expected.rotation)) < 1e-6); } }
    if (process.argv.includes('--fixture')) { const directory = '/tmp/studio-v3-director-parts-acceptance'; await mkdir(directory, { recursive: true }); await writeFile(`${directory}/bake.glb`, Buffer.from(bytes)); await writeFile(`${directory}/scene.json`, JSON.stringify(scene, null, 2)); await writeFile(`${directory}/landmarks.json`, JSON.stringify(result.landmarks, null, 2)); console.log(`Fixture: ${directory}`); }
  } finally { runtime.dispose(); }
});
