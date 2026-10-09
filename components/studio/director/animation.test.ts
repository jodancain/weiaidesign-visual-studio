import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { bakeScene, buildSceneRuntime, builtinRig, evaluateScene, inspectRiggedGLB, sampleTrack, sceneLandmarks } from '../../../lib/studio/animation';
import type { AnimationTrack, StudioScene } from '../../../lib/studio/types';

class NodeFileReader {
  result: ArrayBuffer | string | null = null; onloadend?: () => void; onerror?: (e: unknown) => void;
  readAsArrayBuffer(blob: Blob) { void blob.arrayBuffer().then(value => { this.result = value; this.onloadend?.(); }).catch(e => this.onerror?.(e)); }
  readAsDataURL(blob: Blob) { void blob.arrayBuffer().then(value => { this.result = `data:${blob.type};base64,${Buffer.from(value).toString('base64')}`; this.onloadend?.(); }).catch(e => this.onerror?.(e)); }
}
if (!globalThis.FileReader) Object.defineProperty(globalThis, 'FileReader', { value: NodeFileReader });
if (!globalThis.ProgressEvent) Object.defineProperty(globalThis, 'ProgressEvent', { value: class ProgressEvent { constructor(public type: string) {} } });

export function fixtureScene(): StudioScene {
  return { id: 'acceptance-scene', name: '原创角色动画实测', revision: 1, units: 'meters', up: 'Y', objects: [{ id: 'actor-a', name: '原创角色', kind: 'character', transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, color: '#aac1dc', visible: true, locked: false, rig: builtinRig() }], cameras: [{ id: 'camera-main', name: '镜头', position: [3, 2, 4], target: [0, 1, 0], focalLength: 35, sensorWidth: 36 }], activeCameraId: 'camera-main', background: '#171d28', groundColor: '#3a4050', showGround: true, exposure: 1, tracks: [{ id: 'root-motion', targetId: 'actor-a', property: 'position', keys: [{ frame: 0, value: [0, 0, 0], interpolation: 'linear' }, { frame: 72, value: [1.2, 0, 0], interpolation: 'smooth' }] }], clips: [{ id: 'walk', targetId: 'actor-a', clipName: 'Walk', startFrame: 0, endFrame: 72, sourceIn: 0, speed: 1, weight: 1, fadeIn: 0, fadeOut: 0, mask: 'all' }, { id: 'wave', targetId: 'actor-a', clipName: 'Wave', startFrame: 18, endFrame: 60, sourceIn: 0, speed: 1.2, weight: .8, fadeIn: 6, fadeOut: 6, mask: 'upper' }] };
}

test('typed interpolation handles holds, Bezier, endpoints and quaternion shortest path', () => {
  const track: AnimationTrack = { id: 't', targetId: 'o', property: 'position', keys: [{ frame: 0, value: [0, 0, 0], interpolation: 'linear' }, { frame: 24, value: [2, 4, 6], interpolation: 'linear' }] };
  assert.deepEqual(sampleTrack(track, 12), [1, 2, 3]); assert.deepEqual(sampleTrack(track, -5), [0, 0, 0]); assert.deepEqual(sampleTrack(track, 100), [2, 4, 6]);
  track.keys[0].interpolation = 'hold'; assert.deepEqual(sampleTrack(track, 23), [0, 0, 0]);
  track.keys[0] = { frame: 0, value: [0, 0, 0], interpolation: 'smooth', ease: [.4, 0, .6, 1] }; assert.ok(Math.abs((sampleTrack(track, 12) as number[])[0] - 1) < 1e-5);
  const rotation: AnimationTrack = { ...track, property: 'rotation', keys: [{ frame: 0, value: [0, 0, 0, 1], interpolation: 'linear' }, { frame: 24, value: [0, 0, 0, -1], interpolation: 'linear' }] }; assert.ok(Math.abs((sampleTrack(rotation, 12) as number[])[3]) > .999);
});

test('original character is weighted 3D geometry and arbitrary seeking is deterministic', async () => {
  const scene = fixtureScene(), runtime = await buildSceneRuntime(scene, []); try { const actor = runtime.actors.get('actor-a')!; assert.ok(actor.skin); assert.ok(actor.skin.geometry.attributes.position.count > 1000); assert.equal(actor.clips.length, 5); assert.ok(actor.bones.size > 15);
    evaluateScene(runtime, scene, 31); const first = sceneLandmarks(runtime, 31); for (const f of [3, 71, 0, 18, 31]) evaluateScene(runtime, scene, f); assert.deepEqual(sceneLandmarks(runtime, 31), first);
    const at31 = actor.bones.get('LeftHand')!.getWorldPosition(new THREE.Vector3()); evaluateScene(runtime, scene, 1); assert.ok(at31.distanceTo(actor.bones.get('LeftHand')!.getWorldPosition(new THREE.Vector3())) > .05);
  } finally { runtime.dispose(); }
});

test('upper-body clip masking preserves leg animation and clip instances remain independent', async () => {
  const scene = fixtureScene(), runtime = await buildSceneRuntime(scene, []); try { evaluateScene(runtime, scene, 30); const withWave = runtime.actors.get('actor-a')!.bones.get('LeftUpLeg')!.quaternion.clone(); const onlyWalk = { ...scene, clips: scene.clips.slice(0, 1) }; evaluateScene(runtime, onlyWalk, 30); assert.ok(withWave.angleTo(runtime.actors.get('actor-a')!.bones.get('LeftUpLeg')!.quaternion) < 1e-7);
    const duplicate = { ...scene, clips: [{ ...scene.clips[0], id: 'walk-a', weight: .5 }, { ...scene.clips[0], id: 'walk-b', sourceIn: 12, weight: .5 }] }; evaluateScene(runtime, duplicate, 10); const both = runtime.actors.get('actor-a')!.bones.get('LeftUpLeg')!.quaternion.clone(); evaluateScene(runtime, { ...duplicate, clips: duplicate.clips.slice(1) }, 10); assert.ok(both.angleTo(runtime.actors.get('actor-a')!.bones.get('LeftUpLeg')!.quaternion) > .01);
  } finally { runtime.dispose(); }
});

test('the original punch reaches forward along the character facing direction', async () => {
  const scene = fixtureScene(); scene.tracks = []; scene.clips = [{ ...scene.clips[0], clipName: 'Punch', startFrame: 0, endFrame: 48 }]; const runtime = await buildSceneRuntime(scene, []);
  try { evaluateScene(runtime, scene, 24); const actor = runtime.actors.get('actor-a')!; assert.ok(actor.bones.get('RightHand')!.getWorldPosition(new THREE.Vector3()).z > .3); } finally { runtime.dispose(); }
});

test('CCD reaches a hand target and FK keys override the selected bone deterministically', async () => {
  const scene = fixtureScene(); scene.clips = []; scene.tracks = []; const chain = scene.objects[0].rig!.chains[0]; chain.enabled = true; chain.target = [.5, 1.25, .22]; const runtime = await buildSceneRuntime(scene, []);
  try { evaluateScene(runtime, scene, 0); const hand = runtime.actors.get('actor-a')!.bones.get('LeftHand')!.getWorldPosition(new THREE.Vector3()); assert.ok(hand.distanceTo(new THREE.Vector3().fromArray(chain.target)) < .035, `${hand.toArray()} target ${chain.target}`);
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), .5).toArray(); scene.tracks.push({ id: 'head', targetId: 'actor-a', bone: 'Head', property: 'rotation', keys: [{ frame: 0, value: q, interpolation: 'hold' }] }); evaluateScene(runtime, scene, 7); assert.ok(runtime.actors.get('actor-a')!.bones.get('Head')!.quaternion.angleTo(new THREE.Quaternion().fromArray(q)) < 1e-7);
  } finally { runtime.dispose(); }
});


test('all four CCD limbs reach reachable targets', async () => {
  const scene = fixtureScene(); scene.clips = []; scene.tracks = [];
  for (const chain of scene.objects[0].rig!.chains) { chain.enabled = true; const side = chain.id.startsWith('left') ? 1 : -1; chain.target = chain.id.endsWith('hand') ? [side * .45, 1.35, .2] : [side * .15, .2, .13]; }
  const runtime = await buildSceneRuntime(scene, []); try { evaluateScene(runtime, scene, 0); for (const chain of scene.objects[0].rig!.chains) { const bone = runtime.actors.get('actor-a')!.bones.get(chain.effector)!; assert.ok(bone.getWorldPosition(new THREE.Vector3()).distanceTo(new THREE.Vector3().fromArray(chain.target)) < .004, `${chain.id}: ${bone.getWorldPosition(new THREE.Vector3()).toArray()}`); } } finally { runtime.dispose(); }
});

test('FK and every IK step honor rest-relative joint limits and deterministic seeking', async () => {
  const scene = fixtureScene(); scene.clips = []; scene.tracks = []; const object = scene.objects[0]; object.rig!.limits = { Head: { min: [-.2, -.3, -.4], max: [.2, .3, .4] }, LeftUpperArm: { min: [0, 0, 0], max: [0, 0, 0] }, LeftForeArm: { min: [0, 0, 0], max: [0, 0, 0] } }; object.rig!.chains[0].enabled = true; object.rig!.chains[0].target = [.3, 1.1, .5];
  const runtime = await buildSceneRuntime(scene, []); try { const actor = runtime.actors.get('actor-a')!, head = actor.bones.get('Head')!, rest = new THREE.Quaternion().setFromEuler(new THREE.Euler(.15, -.1, .65)); actor.rest.get(head)!.quaternion.copy(rest);
    const outside = rest.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(.8, .9, -.8))); scene.tracks = [{ id: 'limited-head', targetId: object.id, bone: 'Head', property: 'rotation', keys: [{ frame: 0, value: outside.toArray(), interpolation: 'linear' }, { frame: 24, value: rest.toArray(), interpolation: 'linear' }] }];
    evaluateScene(runtime, scene, 0); const relative = new THREE.Euler().setFromQuaternion(rest.clone().invert().multiply(head.quaternion), 'XYZ'); assert.ok(Math.abs(relative.x - .2) < 1e-7); assert.ok(Math.abs(relative.y - .3) < 1e-7); assert.ok(Math.abs(relative.z + .4) < 1e-7); for (const name of ['LeftUpperArm', 'LeftForeArm']) assert.ok(actor.bones.get(name)!.quaternion.angleTo(actor.rest.get(actor.bones.get(name)!)!.quaternion) < 1e-7);
    const initial = sceneLandmarks(runtime, 0); evaluateScene(runtime, scene, 19); evaluateScene(runtime, scene, 0); assert.deepEqual(sceneLandmarks(runtime, 0), initial);
    object.rig!.limits = {}; evaluateScene(runtime, scene, 0); assert.ok(head.quaternion.angleTo(outside) < 1e-7, 'disabling the limit must restore the authored pose');
  } finally { runtime.dispose(); }
});

test('parented characters solve IK against current animated parent transforms', async () => {
  const scene = fixtureScene(); scene.objects[0].parentId = 'moving-parent'; scene.objects[0].rig!.chains[0].enabled = true; scene.objects[0].rig!.chains[0].target = [.5, 1.25, .22]; scene.objects.push({ id: 'moving-parent', name: 'parent', kind: 'box', transform: { position: [1, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, color: '#ffffff', visible: true, locked: false }); scene.tracks = [{ id: 'parent-motion', targetId: 'moving-parent', property: 'position', keys: [{ frame: 0, value: [0, 0, 0], interpolation: 'linear' }, { frame: 72, value: [3, 0, 0], interpolation: 'linear' }] }]; scene.clips = [];
  const runtime = await buildSceneRuntime(scene, []); try { evaluateScene(runtime, scene, 50); const first = sceneLandmarks(runtime, 50); evaluateScene(runtime, scene, 1); evaluateScene(runtime, scene, 50); assert.deepEqual(sceneLandmarks(runtime, 50), first); const actor = runtime.actors.get('actor-a')!, expected = actor.root.localToWorld(new THREE.Vector3(.5, 1.25, .22)); assert.ok(actor.bones.get('LeftHand')!.getWorldPosition(new THREE.Vector3()).distanceTo(expected) < .035); } finally { runtime.dispose(); }
});

test('GLB bake carries real skin, animations, bone markers and round-trips world landmarks', async () => {
  const scene = fixtureScene(), runtime = await buildSceneRuntime(scene, []); try { const baked = await bakeScene(runtime, scene, 0, 72, 17), bytes = await baked.blob.arrayBuffer(); const data = new DataView(bytes); assert.equal(data.getUint32(0, true), 0x46546c67); const json = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 20, data.getUint32(12, true)))); assert.ok(json.skins.length); assert.ok(json.animations[0].channels.length > 50); assert.ok(json.nodes.some((n: { name: string }) => n.name === 'studio-landmark:actor-a:LeftHand'));
    const gltf = await new GLTFLoader().parseAsync(bytes, ''); const mixer = new THREE.AnimationMixer(gltf.scene); const action = mixer.clipAction(gltf.animations[0]); action.setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = true; action.play();
    for (const f of [0, 24, 48, 71]) { mixer.setTime(f / 24); gltf.scene.updateMatrixWorld(true); evaluateScene(runtime, scene, f); for (const expected of sceneLandmarks(runtime, f)) { let node: THREE.Object3D | undefined; gltf.scene.traverse(candidate => { if (expected.bone === 'root' ? candidate.name === expected.objectId : candidate.userData.studioLandmark && candidate.userData.studioObjectId === expected.objectId && candidate.userData.studioBoneId === expected.bone) node = candidate; }); assert.ok(node, expected.bone); assert.ok(node.getWorldPosition(new THREE.Vector3()).distanceTo(new THREE.Vector3().fromArray(expected.position)) < .00001, `${f} ${expected.bone}`); assert.ok(node.getWorldQuaternion(new THREE.Quaternion()).angleTo(new THREE.Quaternion().fromArray(expected.rotation)) < .00001); } }
    const imported = await inspectRiggedGLB(bytes); assert.ok(imported.metadata.boneCount > 15); assert.ok(imported.metadata.clips.some(c => c.name === 'StudioBake'));
  } finally { runtime.dispose(); }
});

if (process.argv.includes('--fixture') || process.argv.includes('--fixture-ik') || process.argv.includes('--fixture-limbs') || process.argv.includes('--fixture-limits')) {
  const scene = fixtureScene(); const withLimits = process.argv.includes('--fixture-limits'), withLimbs = process.argv.includes('--fixture-limbs'), withIK = process.argv.includes('--fixture-ik') || withLimbs || withLimits; if (withIK) { scene.clips = []; scene.objects[0].rig!.chains[0].enabled = true; scene.objects[0].rig!.chains[0].target = [.5, 1.25, .22]; scene.tracks.push({ id: 'hand-ik', targetId: 'actor-a', bone: 'left-hand', property: 'ikTarget', keys: [{ frame: 0, value: [.5, 1.25, .22], interpolation: 'smooth' }, { frame: 12, value: [.35, 1.4, .3], interpolation: 'linear' }] }, { id: 'head-fk', targetId: 'actor-a', bone: 'Head', property: 'rotation', keys: [{ frame: 0, value: [0, 0, 0, 1], interpolation: 'linear' }, { frame: 12, value: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), .7).toArray(), interpolation: 'linear' }] }); } if (withLimbs) for (const chain of scene.objects[0].rig!.chains) { chain.enabled = true; const sign = chain.id.startsWith('left') ? 1 : -1; chain.target = chain.id.endsWith('hand') ? [sign * .45, 1.35, .2] : [sign * .15, .2, .13]; } if (withLimits) { scene.objects[0].rig!.limits!.Head = { min: [-.2, -.25, -.2], max: [.2, .25, .2] }; scene.objects[0].rig!.limits!.LeftUpperArm = { min: [-.1, -.1, -.1], max: [.1, .1, .1] }; } const runtime = await buildSceneRuntime(scene, []); const baked = await bakeScene(runtime, scene, 0, withIK ? 13 : 72); const directory = withLimits ? '/tmp/studio-v3-director-limits-acceptance' : withLimbs ? '/tmp/studio-v3-director-limbs-acceptance' : withIK ? '/tmp/studio-v3-director-ik-acceptance' : '/tmp/studio-v3-director-acceptance'; await mkdir(directory, { recursive: true }); await writeFile(`${directory}/bake.glb`, Buffer.from(await baked.blob.arrayBuffer())); await writeFile(`${directory}/scene.json`, JSON.stringify(scene, null, 2)); await writeFile(`${directory}/landmarks.json`, JSON.stringify(baked.landmarks, null, 2)); runtime.dispose(); console.log(`Fixture: ${directory}`);
}
