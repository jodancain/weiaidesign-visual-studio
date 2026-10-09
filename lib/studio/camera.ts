import * as THREE from 'three';
import type { StudioCamera, Vec3 } from './types';

/** Clone a world-space view for a project frame without changing the interactive camera. */
export function cameraForProjectFrame(source: THREE.Camera, aspect: number): THREE.PerspectiveCamera {
  if (!(source instanceof THREE.PerspectiveCamera)) throw new Error('仅支持保存透视机位');
  if (!(aspect > 0 && Number.isFinite(aspect))) throw new Error('项目画幅无效');
  source.updateWorldMatrix(true, false);
  const camera = source.clone();
  camera.position.copy(source.getWorldPosition(new THREE.Vector3()));
  camera.quaternion.copy(source.getWorldQuaternion(new THREE.Quaternion()));
  camera.scale.set(1, 1, 1);
  camera.aspect = aspect;
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return camera;
}

/** StudioCamera represents a Y-up, unrolled perspective view. Fail closed for unsupported optics. */
export function snapshotStudioCamera(source: THREE.Camera, options: { id: string; name: string; aspect: number; target?: THREE.Vector3 }): StudioCamera {
  const camera = cameraForProjectFrame(source, options.aspect);
  if (camera.filmOffset !== 0 || camera.view?.enabled) throw new Error('偏移镜头或局部投影暂不能另存为机位');
  const direction = camera.getWorldDirection(new THREE.Vector3());
  const position = camera.position.clone();
  const candidate = options.target?.clone();
  const delta = candidate?.clone().sub(position);
  // A rotation animation can disagree with the authored look-at point. Preserve the evaluated view.
  const target = delta && delta.lengthSq() > 1e-12 && delta.clone().normalize().dot(direction) > 1 - 1e-10
    ? candidate!
    : position.clone().addScaledVector(direction, delta && delta.length() > 1e-6 ? delta.length() : 10);
  const unrolled = new THREE.PerspectiveCamera();
  unrolled.position.copy(position); unrolled.lookAt(target); unrolled.updateMatrixWorld(true);
  if (unrolled.quaternion.angleTo(camera.quaternion) > 1e-5) throw new Error('当前机位含倾斜旋转，现有机位格式不能精确保留；请先移除倾斜再保存');
  const focalLength = camera.getFocalLength() * camera.zoom;
  if (![...position.toArray(), ...target.toArray(), focalLength, camera.filmGauge].every(Number.isFinite) || focalLength <= 0 || camera.filmGauge <= 0) throw new Error('当前机位参数无效');
  return { id: options.id, name: options.name, position: position.toArray() as Vec3, target: target.toArray() as Vec3, focalLength, sensorWidth: camera.filmGauge };
}
