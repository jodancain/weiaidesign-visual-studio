import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { markGLBParts, readCompleteGLB } from './animation-parts';
import type { AnimationTrack, AssetRevision, Keyframe, RigProfile, SceneObject, StudioScene, Vec3 } from './types';

/** The evaluator is deliberately independent of React, playback history and wall-clock time. */
export type BoneState = { position: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3 };
export type ActorRuntime = { id: string; root: THREE.Group; bones: Map<string, THREE.Bone>; rest: Map<THREE.Bone, BoneState>; clips: THREE.AnimationClip[]; mixer: THREE.AnimationMixer; meshes: THREE.Mesh[]; skin?: THREE.SkinnedMesh; targets: Map<string, THREE.Bone>; parts: Map<string, THREE.Object3D>; partRest: Map<THREE.Object3D, BoneState>; rig?: RigProfile; masked: Map<string, THREE.AnimationClip> };
export type SceneRuntime = { root: THREE.Group; actors: Map<string, ActorRuntime>; cameras: Map<string, THREE.PerspectiveCamera>; dispose: () => void };
export type Landmark = { frame: number; objectId: string; bone: string; partId?: string; position: number[]; rotation: number[] };

export const BUILTIN_CLIPS = ['Idle', 'Walk', 'Punch', 'Kick', 'Wave'] as const;
export const identityTransform = () => ({ position: [0, 0, 0] as Vec3, rotation: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as Vec3 });

export function builtinRig(): RigProfile {
  const limits: NonNullable<RigProfile['limits']> = { Spine: { min: [-.7, -.7, -.5], max: [.7, .7, .5] }, Chest: { min: [-.6, -.8, -.5], max: [.6, .8, .5] }, Neck: { min: [-.7, -.9, -.5], max: [.7, .9, .5] }, Head: { min: [-.8, -1.4, -.7], max: [.8, 1.4, .7] } };
  for (const side of ['Left', 'Right']) { limits[`${side}UpperArm`] = { min: [-2.8, -1.55, -2.8], max: [2.8, 1.55, 2.8] }; limits[`${side}ForeArm`] = { min: [-1.5, -1.55, -2.7], max: [1.5, 1.55, 2.7] }; limits[`${side}Hand`] = { min: [-1.1, -.8, -.8], max: [1.1, .8, .8] }; limits[`${side}UpLeg`] = { min: [-1.7, -.8, -.9], max: [1.2, .8, .9] }; limits[`${side}Leg`] = { min: [-.05, -.1, -.1], max: [2.7, .1, .1] }; limits[`${side}Foot`] = { min: [-.8, -.5, -.5], max: [.8, .5, .5] }; }
  return { id: 'studio-human-v1', limits, bones: Object.fromEntries(['Hips', 'Spine', 'Chest', 'Neck', 'Head', 'LeftUpperArm', 'LeftForeArm', 'LeftHand', 'RightUpperArm', 'RightForeArm', 'RightHand', 'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'RightUpLeg', 'RightLeg', 'RightFoot'].map(n => [n, n])), chains: [
    { id: 'left-hand', target: [.68, 1.38, 0], effector: 'LeftHand', links: ['LeftForeArm', 'LeftUpperArm'], enabled: false },
    { id: 'right-hand', target: [-.68, 1.38, 0], effector: 'RightHand', links: ['RightForeArm', 'RightUpperArm'], enabled: false },
    { id: 'left-foot', target: [.12, .1, .1], effector: 'LeftFoot', links: ['LeftLeg', 'LeftUpLeg'], enabled: false },
    { id: 'right-foot', target: [-.12, .1, .1], effector: 'RightFoot', links: ['RightLeg', 'RightUpLeg'], enabled: false },
  ] };
}

export function newStudioObject(kind: SceneObject['kind'], name?: string): SceneObject {
  return { id: crypto.randomUUID(), name: name || ({ box: '方块', sphere: '球体', cylinder: '圆柱', plane: '平面', character: '角色', model: '模型' })[kind], kind, transform: identityTransform(), color: kind === 'character' ? '#c6ced9' : '#98a6b8', visible: true, locked: false, ...(kind === 'character' ? { rig: builtinRig() } : {}) };
}

function bezier(t: number, a: number, b: number) { const s = 1 - t; return 3 * s * s * t * a + 3 * s * t * t * b + t * t * t; }
export function easedFraction(t: number, key: Keyframe): number {
  if (key.interpolation === 'hold') return 0;
  if (key.ease) { let lo = 0, hi = 1; for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; if (bezier(mid, key.ease[0], key.ease[2]) < t) lo = mid; else hi = mid; } return bezier((lo + hi) / 2, key.ease[1], key.ease[3]); }
  return key.interpolation === 'smooth' ? t * t * (3 - 2 * t) : t;
}
export function sampleTrack(track: AnimationTrack, frame: number): number | number[] | undefined {
  if (track.muted || !track.keys.length) return undefined;
  const keys = [...track.keys].sort((a, b) => a.frame - b.frame);
  if (frame <= keys[0].frame) return Array.isArray(keys[0].value) ? [...keys[0].value] : keys[0].value;
  const last = keys[keys.length - 1]; if (frame >= last.frame) return Array.isArray(last.value) ? [...last.value] : last.value;
  const end = keys.findIndex(k => k.frame > frame), a = keys[end - 1], b = keys[end];
  const t = easedFraction((frame - a.frame) / (b.frame - a.frame), a);
  if (Array.isArray(a.value) && Array.isArray(b.value)) {
    if (track.property === 'rotation' && a.value.length === 4 && b.value.length === 4) return new THREE.Quaternion().fromArray(a.value).normalize().slerp(new THREE.Quaternion().fromArray(b.value).normalize(), t).toArray();
    return a.value.map((v, i) => v + ((b.value as number[])[i] - v) * t);
  }
  return Number(a.value) + (Number(b.value) - Number(a.value)) * t;
}

function originalHuman(color: string) {
  const root = new THREE.Group(); const bones: THREE.Bone[] = []; const byName = new Map<string, THREE.Bone>();
  const bone = (name: string, parent: string | null, p: Vec3) => { const b = new THREE.Bone(); b.name = name; b.position.fromArray(p); (parent ? byName.get(parent)! : root).add(b); bones.push(b); byName.set(name, b); return b; };
  bone('Hips', null, [0, 1.0, 0]); bone('Spine', 'Hips', [0, .16, 0]); bone('Chest', 'Spine', [0, .18, 0]); bone('Neck', 'Chest', [0, .17, 0]); bone('Head', 'Neck', [0, .13, 0]);
  for (const [side, sign] of [['Left', 1], ['Right', -1]] as const) {
    bone(`${side}Shoulder`, 'Chest', [sign * .17, .09, 0]); bone(`${side}UpperArm`, `${side}Shoulder`, [sign * .07, 0, 0]); bone(`${side}ForeArm`, `${side}UpperArm`, [sign * .23, -.015, 0]); bone(`${side}Hand`, `${side}ForeArm`, [sign * .22, -.015, 0]);
    bone(`${side}UpLeg`, 'Hips', [sign * .12, -.03, 0]); bone(`${side}Leg`, `${side}UpLeg`, [0, -.43, 0]); bone(`${side}Foot`, `${side}Leg`, [0, -.43, .07]);
  }
  root.updateMatrixWorld(true); const pieces: THREE.BufferGeometry[] = [];
  const weighted = (g: THREE.BufferGeometry, b: THREE.Bone) => { const n = g.attributes.position.count; const indices = new Uint16Array(n * 4), weights = new Float32Array(n * 4); for (let i = 0; i < n; i++) { indices[i * 4] = bones.indexOf(b); weights[i * 4] = 1; } g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(indices, 4)); g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4)); pieces.push(g); };
  const segment = (name: string, end: THREE.Vector3, radius: number) => { const b = byName.get(name)!; const start = b.getWorldPosition(new THREE.Vector3()), delta = end.clone().sub(start); const g = new THREE.CylinderGeometry(radius * .88, radius, delta.length(), 12, 4); g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.clone().normalize())); g.translate(...start.add(end).multiplyScalar(.5).toArray()); weighted(g, b); };
  for (const b of bones) {
    const child = b.children.find(c => c instanceof THREE.Bone) as THREE.Bone | undefined;
    if (child && !b.name.endsWith('Shoulder')) segment(b.name, child.getWorldPosition(new THREE.Vector3()), /UpLeg/.test(b.name) ? .082 : /Leg/.test(b.name) ? .066 : /Hips|Spine|Chest/.test(b.name) ? .14 : /Neck/.test(b.name) ? .055 : .048);
    if (/Hand|Foot/.test(b.name)) { const g = new THREE.SphereGeometry(1, 12, 8); g.scale(/Foot/.test(b.name) ? .065 : .055, .045, /Foot/.test(b.name) ? .13 : .05); const p = b.getWorldPosition(new THREE.Vector3()); g.translate(p.x, p.y, p.z + (/Foot/.test(b.name) ? .055 : 0)); weighted(g, b); }
  }
  const head = new THREE.SphereGeometry(1, 16, 12); head.scale(.108, .135, .105); const hp = byName.get('Head')!.getWorldPosition(new THREE.Vector3()); head.translate(hp.x, hp.y + .07, hp.z); weighted(head, byName.get('Head')!);
  const geometry = mergeGeometries(pieces, false); pieces.forEach(g => g.dispose()); if (!geometry) throw new Error('原创角色几何合并失败');
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshStandardMaterial({ color, roughness: .78 })); mesh.name = 'StudioHumanMesh'; mesh.castShadow = mesh.receiveShadow = true; root.add(mesh); root.updateMatrixWorld(true); mesh.bind(new THREE.Skeleton(bones));
  return { root, clips: proceduralClips(), skin: mesh };
}

function proceduralClips(): THREE.AnimationClip[] {
  const duration = 2, samples = 49, time = Array.from({ length: samples }, (_, i) => i * duration / (samples - 1));
  const names = ['Spine', 'Head', 'LeftUpperArm', 'RightUpperArm', 'LeftForeArm', 'RightForeArm', 'LeftUpLeg', 'RightUpLeg', 'LeftLeg', 'RightLeg'];
  return BUILTIN_CLIPS.map(kind => { const tracks = names.map(name => { const values: number[] = []; for (const t of time) {
    const w = Math.sin(t / duration * Math.PI * 2), sign = name.startsWith('Left') ? 1 : -1; let x = 0, y = 0, z = /UpperArm/.test(name) ? -sign * 1.25 : 0;
    if (kind === 'Idle' && name === 'Spine') x = .025 * w;
    if (kind === 'Walk') { if (/UpLeg/.test(name)) x = sign * .48 * w; if (/Leg$/.test(name) && !/UpLeg/.test(name)) x = Math.max(0, -sign * w) * .65; if (/UpperArm/.test(name)) x = -sign * .38 * w; }
    const hit = Math.pow(Math.sin(Math.PI * t / duration), 2);
    if (kind === 'Punch') { if (name === 'RightUpperArm') { z = 1.25 * (1 - hit); y = hit * 1.3; } if (name === 'RightForeArm') y = (1 - hit) * .9; if (name === 'Spine') y = -.22 * hit; }
    if (kind === 'Kick') { if (name === 'RightUpLeg') x = -1.25 * hit; if (name === 'RightLeg') x = .45 * Math.sin(Math.PI * hit); if (name === 'Spine') x = -.1 * hit; }
    if (kind === 'Wave') { if (name === 'LeftUpperArm') z = .65; if (name === 'LeftForeArm') z = 1.1 + .35 * w; if (name === 'Head') z = .07 * w; }
    values.push(...new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, 'XYZ')).toArray());
  } return new THREE.QuaternionKeyframeTrack(`${name}.quaternion`, time, values); }); return new THREE.AnimationClip(kind, duration, tracks); });
}

function collectActor(id: string, root: THREE.Group, clips: THREE.AnimationClip[], rig?: RigProfile): ActorRuntime {
  const bones = new Map<string, THREE.Bone>(), rest = new Map<THREE.Bone, BoneState>(), meshes: THREE.Mesh[] = []; let skin: THREE.SkinnedMesh | undefined;
  root.traverse(o => { o.userData.studioObjectId = id; if (o instanceof THREE.Bone) { if (bones.has(o.name)) throw new Error(`骨骼名称重复：${o.name}；请先归一化绑定`); bones.set(o.name, o); o.userData.studioBoneId = o.name; rest.set(o, { position: o.position.clone(), quaternion: o.quaternion.clone(), scale: o.scale.clone() }); } if (o instanceof THREE.Mesh) { meshes.push(o); o.castShadow = o.receiveShadow = true; if (o instanceof THREE.SkinnedMesh) skin ||= o; } });
  const parts = new Map<string, THREE.Object3D>(), partRest = new Map<THREE.Object3D, BoneState>(); root.traverse(node => { if (node.userData.studioPartRoot) { parts.set(node.userData.studioPartId, node); for (let ancestor: THREE.Object3D | null = node; ancestor && ancestor !== root; ancestor = ancestor.parent) partRest.set(ancestor, { position: ancestor.position.clone(), quaternion: ancestor.quaternion.clone(), scale: ancestor.scale.clone() }); } });
  const actor: ActorRuntime = { id, root, bones, rest, parts, partRest, clips, mixer: new THREE.AnimationMixer(root), meshes, skin, targets: new Map(), rig, masked: new Map() };
  if (rig && skin) { const original = skin.skeleton; const helpers: THREE.Bone[] = []; for (const chain of rig.chains) { const target = new THREE.Bone(); target.name = `__ik_${id}_${chain.id}`; target.position.fromArray(chain.target); root.add(target); actor.targets.set(chain.id, target); helpers.push(target); }
    root.updateMatrixWorld(true); const skeleton = new THREE.Skeleton([...original.bones, ...helpers], [...original.boneInverses.map(m => m.clone()), ...helpers.map(b => b.matrixWorld.clone().invert())]);
    for (const m of meshes) if (m instanceof THREE.SkinnedMesh && m.skeleton === original) m.skeleton = skeleton;
  }
  return actor;
}

export async function buildSceneRuntime(scene: StudioScene, assets: AssetRevision[]): Promise<SceneRuntime> {
  const root = new THREE.Group(); root.name = 'StudioScene'; const actors = new Map<string, ActorRuntime>(), cameras = new Map<string, THREE.PerspectiveCamera>(); const loader = new GLTFLoader();
  try { for (const object of scene.objects) {
    let group: THREE.Group, clips: THREE.AnimationClip[] = [];
    if (object.assetId) { const asset = assets.find(a => a.id === object.assetId); if (!asset) throw new Error(`${object.name}的模型资产不存在`); const loaded = await loader.loadAsync(asset.url); if (object.kind === 'model') markGLBParts(loaded); group = new THREE.Group(); group.add(loaded.scene); clips = loaded.animations; }
    else if (object.kind === 'character') { const h = originalHuman(object.color); group = h.root; clips = h.clips; }
    else { group = new THREE.Group(); const geometry = object.kind === 'sphere' ? new THREE.SphereGeometry(.5, 24, 16) : object.kind === 'cylinder' ? new THREE.CylinderGeometry(.5, .5, 1, 24) : object.kind === 'plane' ? new THREE.BoxGeometry(2, .025, 2) : new THREE.BoxGeometry(1, 1, 1); const m = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: object.color, roughness: .7 })); m.position.y = object.kind === 'plane' ? -.015 : .5; group.add(m); }
    group.name = object.id; group.userData.studioObjectId = object.id; const actor = collectActor(object.id, group, clips, object.rig); actors.set(object.id, actor); root.add(group);
  }
  for (const object of scene.objects) if (object.parentId) { const actor = actors.get(object.id)!, parent = actors.get(object.parentId); if (parent && parent !== actor) { let ancestor: THREE.Object3D | null = parent.root, cyclic = false; while (ancestor) { if (ancestor === actor.root) cyclic = true; ancestor = ancestor.parent; } if (cyclic) throw new Error('对象层级出现循环'); parent.root.add(actor.root); } }
  for (const data of scene.cameras) { const c = new THREE.PerspectiveCamera(40, 16 / 9, .01, 2000); c.name = data.id; c.userData.studioCameraId = data.id; cameras.set(data.id, c); root.add(c); }
  for (const clip of scene.clips) if (!actors.get(clip.targetId)?.clips.some(source => source.name === clip.clipName)) throw new Error(`动作不存在：${clip.clipName}，请从此角色的动作列表中选择`);
  const runtime = { root, actors, cameras, dispose: () => disposeRuntime(root, actors) }; evaluateScene(runtime, scene, 0, 'static'); return runtime;
  } catch (error) { disposeRuntime(root, actors); throw error; }
}

function disposeRuntime(root: THREE.Object3D, actors: Map<string, ActorRuntime>) { for (const a of actors.values()) { a.mixer.stopAllAction(); a.mixer.uncacheRoot(a.root); } const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>(), textures = new Set<THREE.Texture>(); root.traverse(o => { if (o instanceof THREE.Mesh) { geometries.add(o.geometry); for (const m of Array.isArray(o.material) ? o.material : [o.material]) { materials.add(m); for (const v of Object.values(m)) if (v instanceof THREE.Texture) textures.add(v); } } }); geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose()); textures.forEach(t => t.dispose()); }

function maskedClip(actor: ActorRuntime, clip: THREE.AnimationClip, mask: 'all' | 'upper' | 'lower', additive: boolean, instanceId: string) {
  const key = `${clip.uuid}:${mask}:${additive}:${instanceId}`; let result = actor.masked.get(key); if (result) return result;
  const lowerBones = new Set([...actor.bones.keys()].filter(name => /hip|leg|foot|toe|pelvis|thigh|calf|shin|ankle/i.test(name)));
  for (const chain of actor.rig?.chains || []) if (/foot|ankle|leg/i.test(chain.id + chain.effector)) { lowerBones.add(chain.effector); chain.links.forEach(name => lowerBones.add(name)); }
  const inLowerBody = (track: THREE.KeyframeTrack) => { const binding = THREE.PropertyBinding.parseTrackName(track.name); const nodeName = binding.objectName === 'bones' ? String(binding.objectIndex) : binding.nodeName; const node = actor.root.getObjectByName(nodeName) || actor.root.getObjectByProperty('uuid', nodeName); return node instanceof THREE.Bone ? lowerBones.has(node.name) : true; };
  result = new THREE.AnimationClip(`${clip.name}:${mask}:${additive}`, clip.duration, clip.tracks.filter(t => mask === 'all' || (mask === 'lower' ? inLowerBody(t) : !inLowerBody(t))).map(t => t.clone()));
  if (additive) THREE.AnimationUtils.makeClipAdditive(result, 0, result, 24); actor.masked.set(key, result); return result;
}

function seedOriginalLeg(actor: ActorRuntime, upper: THREE.Bone, knee: THREE.Bone, foot: THREE.Bone, target: THREE.Bone) {
  const a = upper.getWorldPosition(new THREE.Vector3()), b = knee.getWorldPosition(new THREE.Vector3()), c = foot.getWorldPosition(new THREE.Vector3()), goal = target.getWorldPosition(new THREE.Vector3());
  const first = a.distanceTo(b), second = b.distanceTo(c), distance = THREE.MathUtils.clamp(a.distanceTo(goal), Math.abs(first - second) + 1e-6, first + second - 1e-6); if (first < 1e-6 || second < 1e-6) return;
  const direction = goal.clone().sub(a).normalize(), pole = new THREE.Vector3(0, 0, 1).applyQuaternion(actor.root.getWorldQuaternion(new THREE.Quaternion())); pole.addScaledVector(direction, -pole.dot(direction)); if (pole.lengthSq() < 1e-6) pole.set(1, 0, 0).addScaledVector(direction, -direction.x); pole.normalize();
  const along = (first * first - second * second + distance * distance) / (2 * distance), bend = Math.sqrt(Math.max(0, first * first - along * along)); const desiredKnee = a.clone().addScaledVector(direction, along).addScaledVector(pole, bend);
  const rotateWorld = (bone: THREE.Bone, from: THREE.Vector3, to: THREE.Vector3) => { const delta = new THREE.Quaternion().setFromUnitVectors(from.normalize(), to.normalize()), world = bone.getWorldQuaternion(new THREE.Quaternion()).premultiply(delta), parent = bone.parent!.getWorldQuaternion(new THREE.Quaternion()); bone.quaternion.copy(parent.invert().multiply(world)); bone.updateMatrixWorld(true); };
  rotateWorld(upper, b.clone().sub(a), desiredKnee.clone().sub(a)); const middle = knee.getWorldPosition(new THREE.Vector3()); rotateWorld(knee, foot.getWorldPosition(new THREE.Vector3()).sub(middle), a.clone().addScaledVector(direction, distance).sub(middle));
}

/** Limits use the same rest-relative XYZ frame for imported FK, clips and every CCD step. */
export function clampBoneLimit(actor: ActorRuntime, bone: THREE.Bone, rig?: RigProfile): void {
  const limit = rig?.limits?.[bone.name], rest = actor.rest.get(bone); if (!limit || !rest) return;
  const relative = rest.quaternion.clone().invert().multiply(bone.quaternion), euler = new THREE.Euler().setFromQuaternion(relative, 'XYZ');
  euler.set(THREE.MathUtils.clamp(euler.x, limit.min[0], limit.max[0]), THREE.MathUtils.clamp(euler.y, limit.min[1], limit.max[1]), THREE.MathUtils.clamp(euler.z, limit.min[2], limit.max[2]), 'XYZ');
  bone.quaternion.copy(rest.quaternion).multiply(new THREE.Quaternion().setFromEuler(euler)).normalize();
}
function solveConstrainedCCD(actor: ActorRuntime, rig: RigProfile, target: THREE.Bone, effector: THREE.Bone, links: THREE.Bone[]) {
  const goal = target.getWorldPosition(new THREE.Vector3()), end = new THREE.Vector3(), origin = new THREE.Vector3(), inverse = new THREE.Quaternion(), delta = new THREE.Quaternion();
  for (let iteration = 0; iteration < 48; iteration++) { if (effector.getWorldPosition(end).distanceToSquared(goal) < 1e-10) break;
    for (const link of links) { link.getWorldPosition(origin); link.getWorldQuaternion(inverse).invert(); const from = effector.getWorldPosition(end).sub(origin).applyQuaternion(inverse).normalize(), to = goal.clone().sub(origin).applyQuaternion(inverse).normalize(); if (from.lengthSq() < 1e-12 || to.lengthSq() < 1e-12) continue;
      delta.setFromUnitVectors(from, to); const angle = new THREE.Quaternion().angleTo(delta); if (angle > .35) delta.slerp(new THREE.Quaternion(), 1 - .35 / angle);
      link.quaternion.multiply(delta).normalize(); clampBoneLimit(actor, link, rig); link.updateMatrixWorld(true);
    }
  }
}

export function evaluateScene(runtime: SceneRuntime, scene: StudioScene, frame: number, mode: 'static' | 'dynamic' = 'dynamic'): void {
  const ikPasses: Array<{ actor: ActorRuntime; object: SceneObject; targets: Map<string, Vec3> }> = [];
  for (const object of scene.objects) { const actor = runtime.actors.get(object.id); if (!actor) continue; actor.mixer.stopAllAction(); for (const [b, rest] of actor.rest) { b.position.copy(rest.position); b.quaternion.copy(rest.quaternion); b.scale.copy(rest.scale); }
    actor.root.position.fromArray(object.transform.position); actor.root.quaternion.fromArray(object.transform.rotation).normalize(); actor.root.scale.fromArray(object.transform.scale); actor.root.visible = object.visible;
    for (const [node, rest] of actor.partRest) { node.position.copy(rest.position); node.quaternion.copy(rest.quaternion); node.scale.copy(rest.scale); }
    for (const part of object.parts || []) { const node = actor.parts.get(part.id); if (!node) continue; node.position.fromArray(part.transform.position); node.quaternion.fromArray(part.transform.rotation).normalize(); node.scale.fromArray(part.transform.scale); node.visible = part.visible; if (part.color) for (const mesh of actor.meshes.filter(m => m.userData.studioPartId === part.id)) for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) if ('color' in material && material.color instanceof THREE.Color) material.color.set(part.color); }
    if (mode === 'dynamic') {
      for (const entry of scene.clips.filter(c => c.targetId === object.id && frame >= c.startFrame && frame < c.endFrame)) { const source = actor.clips.find(c => c.name === entry.clipName); if (!source) continue;
        const clip = maskedClip(actor, source, entry.mask, !!entry.additive, entry.id); const action = actor.mixer.clipAction(clip); action.enabled = true; action.setLoop(THREE.LoopRepeat, Infinity); action.play();
        action.time = (((entry.sourceIn + (frame - entry.startFrame) * entry.speed) / 24) % source.duration + source.duration) % source.duration;
        const fade = Math.min(entry.fadeIn > 0 ? (frame - entry.startFrame) / entry.fadeIn : 1, entry.fadeOut > 0 ? (entry.endFrame - frame) / entry.fadeOut : 1, 1);
        const weightTrack = scene.tracks.find(t => t.targetId === entry.id && t.property === 'weight'); const value = weightTrack ? sampleTrack(weightTrack, frame) : undefined;
        action.setEffectiveWeight(Math.max(0, Math.min(1, typeof value === 'number' ? value : entry.weight)) * Math.max(0, fade)); action.blendMode = entry.additive ? THREE.AdditiveAnimationBlendMode : THREE.NormalAnimationBlendMode;
      }
      actor.mixer.update(0);
    }
    for (const [name, q] of Object.entries(object.bonePoses || {})) actor.bones.get(name)?.quaternion.fromArray(q).normalize();
    for (const mesh of actor.meshes) if (mesh.morphTargetInfluences && mesh.morphTargetDictionary) for (const [name, idx] of Object.entries(mesh.morphTargetDictionary)) mesh.morphTargetInfluences[idx] = object.morphs?.[name] || 0;
    const targets = new Map((object.rig?.chains || []).map(c => [c.id, [...c.target] as Vec3]));
    if (mode === 'dynamic') for (const track of scene.tracks.filter(t => t.targetId === object.id)) { const value = sampleTrack(track, frame); if (value === undefined) continue; const target = track.partId ? actor.parts.get(track.partId) : track.bone ? actor.bones.get(track.bone) : actor.root;
      if (track.property === 'ikTarget' && track.bone && Array.isArray(value)) targets.set(track.bone, value as Vec3);
      else if (target && track.property === 'position' && Array.isArray(value)) target.position.fromArray(value);
      else if (target && track.property === 'rotation' && Array.isArray(value)) target.quaternion.fromArray(value).normalize();
      else if (target && track.property === 'scale' && Array.isArray(value)) target.scale.fromArray(value);
      else if (track.property === 'visible' && target) target.visible = !!Number(value);
      else if (track.property === 'morph' && track.bone) for (const m of actor.meshes) { const index = m.morphTargetDictionary?.[track.bone]; if (index !== undefined && m.morphTargetInfluences) m.morphTargetInfluences[index] = Number(value); }
    }
    for (const bone of actor.bones.values()) clampBoneLimit(actor, bone, object.rig);
    ikPasses.push({ actor, object, targets });
  }
  // All parent and child transforms must be current before solving a local IK target.
  runtime.root.updateMatrixWorld(true);
  for (const { actor, object, targets } of ikPasses) {
    if (actor.skin && object.rig) for (const chain of object.rig.chains.filter(c => c.enabled)) { const target = actor.targets.get(chain.id), effector = actor.bones.get(chain.effector), links = chain.links.map(n => actor.bones.get(n)); if (!target || !effector || links.some(b => !b)) continue;
      target.position.fromArray(targets.get(chain.id) || chain.target); target.updateMatrixWorld(true);
      // The original model uses a forward knee pole to remove the straight-leg CCD singularity.
      if (object.rig.id === 'studio-human-v1' && /foot/.test(chain.id) && links.length === 2) seedOriginalLeg(actor, links[1]!, links[0]!, effector, target);
      for (const link of links) { clampBoneLimit(actor, link!, object.rig); link!.updateMatrixWorld(true); }
      solveConstrainedCCD(actor, object.rig, target, effector, links as THREE.Bone[]);
    }
  }
  for (const data of scene.cameras) { const camera = runtime.cameras.get(data.id); if (!camera) continue; camera.position.fromArray(data.position); camera.filmGauge = data.sensorWidth; camera.setFocalLength(data.focalLength); camera.lookAt(new THREE.Vector3().fromArray(data.target)); if (mode === 'dynamic') for (const track of scene.tracks.filter(t => t.targetId === data.id)) { const value = sampleTrack(track, frame); if (Array.isArray(value) && track.property === 'position') camera.position.fromArray(value); else if (Array.isArray(value) && track.property === 'rotation') camera.quaternion.fromArray(value).normalize(); else if (typeof value === 'number' && track.property === 'focalLength') camera.setFocalLength(value); } camera.updateProjectionMatrix(); }
  runtime.root.updateMatrixWorld(true); for (const a of runtime.actors.values()) a.skin?.skeleton.update();
}

export function sceneLandmarks(runtime: SceneRuntime, frame: number): Landmark[] {
  const out: Landmark[] = []; for (const actor of runtime.actors.values()) { const nodes: Array<[string, THREE.Object3D]> = [['root', actor.root], ...actor.bones, ...[...actor.parts].map(([id, node]) => [`part:${id}`, node] as [string, THREE.Object3D])]; for (const [bone, node] of nodes) out.push({ frame, objectId: actor.id, bone, ...(bone.startsWith('part:') ? { partId: bone.slice(5) } : {}), position: node.getWorldPosition(new THREE.Vector3()).toArray(), rotation: node.getWorldQuaternion(new THREE.Quaternion()).toArray() }); } return out;
}

export async function bakeScene(runtime: SceneRuntime, scene: StudioScene, frameStart: number, frameEnd: number, restoreFrame = 0): Promise<{ blob: Blob; landmarks: Landmark[]; metadata: Record<string, unknown> }> {
  if (!Number.isInteger(frameStart) || !Number.isInteger(frameEnd) || frameStart < 0 || frameEnd <= frameStart || frameEnd - frameStart > 7200) throw new Error('烘焙范围须为 1–7200 个整数帧');
  const nodes: THREE.Object3D[] = []; for (const actor of runtime.actors.values()) { nodes.push(...new Set([actor.root, ...actor.bones.values(), ...actor.partRest.keys()])); } nodes.push(...runtime.cameras.values());
  const values = new Map(nodes.map(n => [n, { position: [] as number[], quaternion: [] as number[], scale: [] as number[] }])); const times: number[] = [], landmarks: Landmark[] = []; const helpers: THREE.Object3D[] = [];
  const morphs = new Map([...runtime.actors.values()].flatMap(a => a.meshes).filter(m => !!m.morphTargetInfluences?.length).map(m => [m, [] as number[]]));
  for (const actor of runtime.actors.values()) for (const [boneId, bone] of [...actor.bones, ...[...actor.parts].map(([id, node]) => [`part:${id}`, node] as [string, THREE.Object3D])]) { const helper = new THREE.Object3D(); helper.name = `studio-landmark:${actor.id}:${boneId}`; helper.userData = { studioLandmark: true, studioObjectId: actor.id, studioBoneId: boneId }; bone.add(helper); helpers.push(helper); }
  try { // Include the exclusive end as an interpolation boundary; Blender renders only [start,end).
    for (let f = frameStart; f <= frameEnd; f++) { evaluateScene(runtime, scene, f); times.push((f - frameStart) / 24); for (const node of nodes) { const v = values.get(node)!; v.position.push(...node.position.toArray()); v.quaternion.push(...node.quaternion.toArray()); v.scale.push(...node.scale.toArray()); } for (const [mesh, values] of morphs) values.push(...mesh.morphTargetInfluences!); if (f < frameEnd && (f === frameStart || f === frameEnd - 1 || f === Math.floor((frameStart + frameEnd - 1) / 2) || f % 12 === 0)) landmarks.push(...sceneLandmarks(runtime, f)); }
    const tracks: THREE.KeyframeTrack[] = []; for (const [node, v] of values) { tracks.push(new THREE.VectorKeyframeTrack(`${node.uuid}.position`, times, v.position), new THREE.QuaternionKeyframeTrack(`${node.uuid}.quaternion`, times, v.quaternion), new THREE.VectorKeyframeTrack(`${node.uuid}.scale`, times, v.scale)); }
    for (const [mesh, values] of morphs) tracks.push(new THREE.NumberKeyframeTrack(`${mesh.uuid}.morphTargetInfluences`, times, values));
    const clip = new THREE.AnimationClip('StudioBake', (frameEnd - frameStart) / 24, tracks); evaluateScene(runtime, scene, frameStart);
    runtime.root.userData.studio = { version: 3, fps: 24, frameStart, frameEnd, frame: restoreFrame, cameraId: scene.activeCameraId, sceneId: scene.id, sceneRevision: scene.revision, up: 'Y', units: 'meters' };
    const result = await new GLTFExporter().parseAsync(runtime.root, { binary: true, animations: [clip], trs: true, onlyVisible: false }); if (!(result instanceof ArrayBuffer)) throw new Error('GLB导出未返回二进制');
    return { blob: new Blob([result], { type: 'model/gltf-binary' }), landmarks, metadata: runtime.root.userData.studio };
  } finally { helpers.forEach(h => h.removeFromParent()); evaluateScene(runtime, scene, restoreFrame); }
}

export async function inspectRiggedGLB(data: ArrayBuffer) {
  readCompleteGLB(data);
  const gltf = await new GLTFLoader().parseAsync(data, ''); const bones = new Map<string, THREE.Bone>(); const skins: THREE.SkinnedMesh[] = [];
  try { gltf.scene.traverse(o => { if (o instanceof THREE.Bone) { if (bones.has(o.name)) throw new Error(`骨骼重名：${o.name}`); bones.set(o.name, o); } if (o instanceof THREE.SkinnedMesh) { if (!o.geometry.attributes.skinIndex || !o.geometry.attributes.skinWeight) throw new Error('角色缺少蒙皮权重'); skins.push(o); } }); if (!skins.length || !bones.size) throw new Error('此模型没有可编辑的已绑定骨架，请导入带蒙皮的GLB'); if (skins.some(s => s.skeleton.bones.some(b => !bones.has(b.name)))) throw new Error('骨架引用不完整');
    const match = (pattern: RegExp) => [...bones.keys()].find(n => pattern.test(n)); const chains: RigProfile['chains'] = [];
    for (const [side, sideRe] of [['left', /left|\.l$|_l$/i], ['right', /right|\.r$|_r$/i]] as const) for (const limb of ['hand', 'foot'] as const) { const effector = [...bones.values()].find(b => sideRe.test(b.name) && (limb === 'hand' ? /hand|wrist/i : /foot|ankle/i).test(b.name)); if (effector?.parent instanceof THREE.Bone && effector.parent.parent instanceof THREE.Bone) { const p = effector.getWorldPosition(new THREE.Vector3()); chains.push({ id: `${side}-${limb}`, effector: effector.name, links: [effector.parent.name, effector.parent.parent.name], target: p.toArray() as Vec3, enabled: false }); } }
    void match; return { rig: { id: 'imported-rig', bones: Object.fromEntries([...bones.keys()].map(n => [n, n])), chains }, metadata: { boneCount: bones.size, skinCount: skins.length, clips: gltf.animations.map(c => ({ name: c.name, duration: c.duration })), source: 'user-import' } };
  } finally { disposeRuntime(gltf.scene, new Map()); }
}
