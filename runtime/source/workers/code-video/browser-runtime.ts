import * as THREE from 'three';
import { createCodeScene } from '../../web/lib/studio/code-scene';
import { buildSceneRuntime, evaluateScene } from '../../web/lib/studio/animation';
import type { StudioLight } from '../../web/lib/studio/types';

// Both exporters use these exact settings and evaluate absolute integer frames.
export const GL_OPTIONS = { antialias: true, alpha: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' as const };
export function configureRenderer(gl: THREE.WebGLRenderer, spec: any) {
  gl.setPixelRatio(1);
  gl.setSize(spec.width, spec.height, false);
  gl.outputColorSpace = THREE.SRGBColorSpace;
  gl.toneMapping = THREE.ACESFilmicToneMapping;
  gl.toneMappingExposure = spec.sceneProgram?.look?.exposure ?? spec.renderProfile?.exposure ?? 1;
  gl.shadowMap.enabled = true;
  gl.shadowMap.type = THREE.PCFShadowMap;
  gl.sortObjects = true;
}
export function gpuInfo(gl: THREE.WebGLRenderer) {
  const ctx = gl.getContext(), ext = ctx.getExtension('WEBGL_debug_renderer_info');
  return { vendor: ext ? ctx.getParameter(ext.UNMASKED_VENDOR_WEBGL) : ctx.getParameter(ctx.VENDOR), renderer: ext ? ctx.getParameter(ext.UNMASKED_RENDERER_WEBGL) : ctx.getParameter(ctx.RENDERER), version: ctx.getParameter(ctx.VERSION), dpr: gl.getPixelRatio(), samples: ctx.getParameter(ctx.SAMPLES), three: THREE.REVISION };
}
export async function createRuntime(spec: any) {
  const program = spec.sceneProgram ?? spec.sceneSnapshot?.codeProgram;
  if (program) {
    const runtime = createCodeScene(program);
    runtime.camera.aspect = spec.width / spec.height;
    runtime.camera.updateProjectionMatrix();
    const evaluate = runtime.evaluateFrame;
    runtime.evaluateFrame = (frame: number) => evaluate(frame, spec.sceneSnapshot);
    return runtime;
  }
  const data = spec.sceneSnapshot;
  if (!data) throw Error('RenderSpec has no scene');
  const runtime = await buildSceneRuntime(data, spec.browserAssets ?? []);
  const scene = new THREE.Scene(); scene.add(runtime.root);
  // Mirror the deployed director environment, excluding its grid and gizmos.
  scene.background = new THREE.Color(data.background);
  const authoredLights: StudioLight[] = data.lights ?? [
    { id: 'key', name: '主光', type: 'directional', position: [4, 7, 5], intensity: 3, color: '#ffffff' },
    { id: 'fill', name: '环境', type: 'ambient', position: [0, 0, 0], intensity: .7, color: '#d9e2ff' },
  ];
  const lights = authoredLights.map(value => {
    const light = value.type === 'ambient' ? new THREE.AmbientLight(value.color, value.intensity) : value.type === 'point' ? new THREE.PointLight(value.color, value.intensity) : new THREE.DirectionalLight(value.color, value.intensity);
    light.name = value.id; light.position.fromArray(value.position);
    if (light instanceof THREE.PointLight || light instanceof THREE.DirectionalLight) light.castShadow = true;
    if (light instanceof THREE.DirectionalLight) light.shadow.mapSize.set(2048, 2048);
    scene.add(light); return light;
  });
  const ground = data.showGround ? new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshStandardMaterial({ color: data.groundColor, roughness: .9 })) : null;
  if (ground) { ground.name = 'studio-export-ground'; ground.rotation.x = -Math.PI / 2; ground.position.y = -.025; ground.receiveShadow = true; scene.add(ground); }
  const camera = runtime.cameras.get(spec.cameraId || data.activeCameraId) || [...runtime.cameras.values()][0];
  if (!camera) throw Error('Scene needs a camera');
  camera.aspect = spec.width / spec.height; camera.updateProjectionMatrix();
  return { scene, camera, evaluateFrame(frame: number) { evaluateScene(runtime, data, frame, 'dynamic'); return { frame }; }, dispose() {
    runtime.dispose(); ground?.geometry.dispose(); ground?.material.dispose();
    for (const light of lights) if (light instanceof THREE.PointLight || light instanceof THREE.DirectionalLight) light.shadow.dispose();
    scene.clear();
  } };
}
