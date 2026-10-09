import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

export function nodeFileAPIs() {
  if (!globalThis.FileReader) Object.defineProperty(globalThis, 'FileReader', { configurable: true, value: class { result: ArrayBuffer | string | null = null; onloadend?: () => void; readAsArrayBuffer(blob: Blob) { void blob.arrayBuffer().then(value => { this.result = value; this.onloadend?.(); }); } readAsDataURL(blob: Blob) { void blob.arrayBuffer().then(value => { this.result = `data:${blob.type};base64,${Buffer.from(value).toString('base64')}`; this.onloadend?.(); }); } } });
  if (!globalThis.ProgressEvent) Object.defineProperty(globalThis, 'ProgressEvent', { configurable: true, value: class { constructor(public type: string) {} } });
}

/** Two distinct mesh nodes deliberately share one source material under a transformed assembly. */
export async function createPartsGLB() {
  nodeFileAPIs(); const root = new THREE.Group(), assembly = new THREE.Group(); root.name = 'Fixture'; assembly.name = 'Assembly'; assembly.position.set(.15, 0, .1); assembly.rotation.y = .15; root.add(assembly);
  const material = new THREE.MeshStandardMaterial({ color: '#96a7ba', roughness: .7 }), geometry = new THREE.BoxGeometry(.8, .8, .8);
  for (const [name, x] of [['左部件', -.85], ['右部件', .85]] as const) { const mesh = new THREE.Mesh(geometry, material); mesh.name = name; mesh.position.set(x, .45, 0); assembly.add(mesh); }
  const result = await new GLTFExporter().parseAsync(root, { binary: true, onlyVisible: false, trs: true }); geometry.dispose(); material.dispose(); if (!(result instanceof ArrayBuffer)) throw new Error('fixture GLB failed'); return result;
}
