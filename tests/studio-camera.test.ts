import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { cameraForProjectFrame, snapshotStudioCamera } from '../lib/studio/camera';
function close(a: number[], b: number[], epsilon = 1e-9) { assert.equal(a.length, b.length); a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < epsilon, `${i}: ${v} vs ${b[i]}`)); }
function restore(data: ReturnType<typeof snapshotStudioCamera>, aspect: number) { const camera = new THREE.PerspectiveCamera(45, aspect, .01, 2000); camera.position.fromArray(data.position); camera.filmGauge = data.sensorWidth; camera.setFocalLength(data.focalLength); camera.lookAt(new THREE.Vector3().fromArray(data.target)); camera.updateMatrixWorld(true); return camera; }
for (const aspect of [16 / 9, 9 / 16]) test(`snapshot preserves a panned camera target and its project projection at ${aspect}`, () => {
  const camera = new THREE.PerspectiveCamera(45, aspect, .01, 2000), target = new THREE.Vector3(1, 1.8, -2);
  camera.position.set(4, 3, 8); camera.filmGauge = 36; camera.setFocalLength(75); camera.lookAt(target); camera.updateMatrixWorld(true);
  const data = snapshotStudioCamera(camera, { id: 'saved', name: '机位', aspect, target });
  close(data.target, target.toArray()); assert.ok(Math.abs(data.focalLength - 75) < 1e-10); assert.equal(data.sensorWidth, 36);
  const saved = restore(data, aspect); close(saved.projectionMatrix.toArray(), camera.projectionMatrix.toArray()); close(saved.matrixWorld.toArray(), camera.matrixWorld.toArray());
  for (const point of [new THREE.Vector3(1, 1.8, -2), new THREE.Vector3(-2, .5, 0)]) close(point.clone().project(saved).toArray(), point.clone().project(camera).toArray());
});
test('project-frame camera cloning preserves world transform, folds zoom into optics, and leaves observation untouched', () => {
  const parent = new THREE.Group(); parent.position.set(5, 0, -2); parent.rotation.y = .4;
  const camera = new THREE.PerspectiveCamera(45, 2.2, .01, 2000); camera.position.set(0, 2, 6); camera.zoom = 1.5; camera.lookAt(0, 1, 0); parent.add(camera); parent.updateMatrixWorld(true);
  const before = camera.projectionMatrix.toArray(), data = snapshotStudioCamera(camera, { id: 'saved', name: '机位', aspect: 9 / 16 });
  const frame = cameraForProjectFrame(camera, 9 / 16), saved = restore(data, 9 / 16);
  close(saved.matrixWorld.toArray(), frame.matrixWorld.toArray()); close(saved.projectionMatrix.toArray(), frame.projectionMatrix.toArray()); close(camera.projectionMatrix.toArray(), before); assert.equal(camera.aspect, 2.2);
});
test('evaluated rotation uses its forward direction instead of stale authored target', () => {
  const camera = new THREE.PerspectiveCamera(45, 16 / 9); camera.position.set(1, 2, 3); camera.lookAt(-2, 1, -1); camera.updateMatrixWorld(true);
  const data = snapshotStudioCamera(camera, { id: 'saved', name: '机位', aspect: 16 / 9, target: new THREE.Vector3(0, 1, 0) });
  const saved = restore(data, 16 / 9); assert.ok(saved.quaternion.angleTo(camera.quaternion) < 1e-7);
});
test('roll and shifted optics fail explicitly instead of silently losing the view', () => {
  const camera = new THREE.PerspectiveCamera(45, 16 / 9); camera.position.set(1, 2, 3); camera.lookAt(0, 1, 0); camera.rotateZ(.2);
  assert.throws(() => snapshotStudioCamera(camera, { id: 'saved', name: '机位', aspect: 16 / 9 }), /倾斜旋转/);
  camera.rotateZ(-.2); camera.filmOffset = 2;
  assert.throws(() => snapshotStudioCamera(camera, { id: 'saved', name: '机位', aspect: 16 / 9 }), /偏移镜头/);
});
