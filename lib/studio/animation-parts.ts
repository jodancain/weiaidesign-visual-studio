import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import type { ScenePart, Vec3, Quat } from './types';

type GLBNode = { name?: string; mesh?: number; children?: number[] };
type GLBDocument = { nodes?: GLBNode[]; buffers?: Array<{ uri?: string }>; images?: Array<{ uri?: string }> };
export type PartNode = { id: string; nodePath: string; name: string; parentId?: string };

export function readCompleteGLB(data: ArrayBuffer): GLBDocument {
  const view = new DataView(data); if (data.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(16, true) !== 0x4e4f534a) throw new Error('请选择有效的二进制 glTF 2.0 文件');
  const length = view.getUint32(12, true); if (length > data.byteLength - 20) throw new Error('GLB数据不完整');
  const document = JSON.parse(new TextDecoder().decode(new Uint8Array(data, 20, length))) as GLBDocument;
  if ([...(document.buffers || []), ...(document.images || [])].some(resource => resource.uri && !resource.uri.startsWith('data:'))) throw new Error('模型包含外部资源，请把贴图与缓冲全部嵌入GLB后再导入');
  return document;
}

export function glbPartManifest(document: GLBDocument): PartNode[] {
  const nodes = document.nodes || [], parents = new Map<number, number>(); nodes.forEach((node, index) => node.children?.forEach(child => parents.set(child, index)));
  return nodes.flatMap((node, index) => { if (!Number.isInteger(node.mesh)) return []; let parent = parents.get(index); const visited = new Set<number>(); while (parent !== undefined && !Number.isInteger(nodes[parent]?.mesh)) { if (visited.has(parent)) throw new Error('模型节点存在循环'); visited.add(parent); parent = parents.get(parent); } return [{ id: `gltf-node-${index}`, nodePath: `/nodes/${index}`, name: node.name || `部件 ${index}`, ...(parent === undefined ? {} : { parentId: `gltf-node-${parent}` }) }]; });
}

/** Keep original node names so imported clip bindings remain valid; identity comes from source node indices. */
export function markGLBParts(gltf: GLTF): Map<string, THREE.Object3D> {
  const manifest = glbPartManifest(gltf.parser.json), roots = new Map<string, THREE.Object3D>();
  gltf.scene.traverse(node => { const association = gltf.parser.associations.get(node); if (typeof association?.nodes !== 'number') return; const part = manifest.find(p => p.id === `gltf-node-${association.nodes}`); if (!part) return; node.userData.studioPartRoot = true; node.userData.studioPartId = part.id; node.userData.studioPartName = part.name; node.userData.studioPartPath = part.nodePath; roots.set(part.id, node); });
  gltf.scene.traverse(node => { if (!(node instanceof THREE.Mesh)) return; for (let parent: THREE.Object3D | null = node; parent; parent = parent.parent) if (parent.userData.studioPartRoot) { node.userData.studioPartId = parent.userData.studioPartId; break; }
    // A material reused by two source nodes must not let one part edit recolor its sibling.
    node.material = Array.isArray(node.material) ? node.material.map(material => material.clone()) : node.material.clone();
  }); return roots;
}

export async function inspectModelGLB(data: ArrayBuffer) {
  const document = readCompleteGLB(data), gltf = await new GLTFLoader().parseAsync(data, '');
  try { let skins = 0; gltf.scene.traverse(node => { if (node instanceof THREE.SkinnedMesh) skins++; }); if (skins) throw new Error('此GLB含蒙皮骨架，请使用“导入角色”以保留骨骼编辑');
    const nodes = markGLBParts(gltf); if (!nodes.size) throw new Error('此GLB没有可编辑的网格部件');
    const parts: ScenePart[] = [...nodes].map(([id, node]) => ({ id, transform: { position: node.position.toArray() as Vec3, rotation: node.quaternion.toArray() as Quat, scale: node.scale.toArray() as Vec3 }, visible: true, locked: false }));
    return { parts, metadata: { source: 'user-import', partSchemaVersion: 1, partNodes: glbPartManifest(document), clips: gltf.animations.map(clip => ({ name: clip.name, duration: clip.duration })) } };
  } finally { const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>(), textures = new Set<THREE.Texture>(); gltf.scene.traverse(node => { if (!(node instanceof THREE.Mesh)) return; geometries.add(node.geometry); for (const material of Array.isArray(node.material) ? node.material : [node.material]) { materials.add(material); for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value); } }); geometries.forEach(value => value.dispose()); materials.forEach(value => value.dispose()); textures.forEach(value => value.dispose()); }
}
