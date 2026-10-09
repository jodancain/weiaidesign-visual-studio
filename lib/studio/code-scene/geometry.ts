import * as T from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { V3 } from './schema';

export function noise(seed: number, i: number) { let n = Math.imul((i + seed) | 0, 1597334677); n ^= n >>> 16; return (n >>> 0) / 4294967295; }
export function surface(color: string, kind: 'wood' | 'cloth' | 'metal' | 'plain' = 'plain', seed = 1) {
  const m = new T.MeshStandardMaterial({ color, roughness: kind === 'metal' ? .46 : .84, metalness: kind === 'metal' ? .26 : 0 });
  if (kind !== 'plain') {
    const size = 128, data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const n = noise(seed, y * size + x), wave = kind === 'wood' ? Math.sin(x * .43 + Math.sin(y * .045) * 3) : kind === 'cloth' ? Math.sin(x * Math.PI / 3) * Math.cos(y * Math.PI / 3) : n;
      const v = Math.round(180 + wave * 32 + n * 24), at = (y * size + x) * 4;
      data[at] = data[at + 1] = data[at + 2] = v; data[at + 3] = 255;
    }
    const tex = new T.DataTexture(data, size, size, T.RGBAFormat); tex.wrapS = tex.wrapT = T.RepeatWrapping; tex.repeat.set(kind === 'cloth' ? 4 : 2, 2); tex.needsUpdate = true;
    m.bumpMap = tex; m.bumpScale = kind === 'cloth' ? .011 : .004; m.roughnessMap = tex;
  }
  return m;
}
export function mesh(parent: T.Object3D, geometry: T.BufferGeometry, material: T.Material, p: V3 = [0, 0, 0], name = '') {
  const o = new T.Mesh(geometry, material); o.position.fromArray(p); o.name = name; o.castShadow = o.receiveShadow = true; parent.add(o); return o;
}
export const box = (p: T.Object3D, size: V3, pos: V3, m: T.Material, radius = .025, name = '') => mesh(p, new RoundedBoxGeometry(...size, 2, Math.min(radius, ...size.map(x => x / 3))), m, pos, name);
export function sphere(p: T.Object3D, size: V3, pos: V3, m: T.Material, name = '') { const o = mesh(p, new T.SphereGeometry(1, 20, 14), m, pos, name); o.scale.fromArray(size); return o; }
export function cylinder(p: T.Object3D, r: number, h: number, pos: V3, m: T.Material, name = '') { return mesh(p, new T.CylinderGeometry(r, r, h, 20), m, pos, name); }
export function rod(p: T.Object3D, a: V3, b: V3, r: number, m: T.Material, name = '') { const av = new T.Vector3(...a), bv = new T.Vector3(...b), d = bv.clone().sub(av); const o = cylinder(p, r, d.length(), av.add(bv).multiplyScalar(.5).toArray(), m, name); o.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), d.normalize()); return o; }
export const torus = (p: T.Object3D, r: number, tube: number, pos: V3, m: T.Material, name = '') => mesh(p, new T.TorusGeometry(r, tube, 8, 36), m, pos, name);
export function entity(id: string) { const g = new T.Group(); g.name = id; g.userData.studioObjectId = id; return g; }
export function identify(root: T.Object3D, id: string) { root.traverse(n => { n.userData.studioObjectId = id; }); }
export function pointOn(o: T.Object3D, p: V3 = [0, 0, 0]) { o.updateWorldMatrix(true, false); return o.localToWorld(new T.Vector3(...p)); }
export function placeWorld(o: T.Object3D, world: T.Vector3) { o.parent?.updateWorldMatrix(true, false); o.position.copy(o.parent ? o.parent.worldToLocal(world.clone()) : world); }
export const smooth = (t: number) => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); };
export const between = (t: number, a: number, b: number) => smooth((t - a) / (b - a));
