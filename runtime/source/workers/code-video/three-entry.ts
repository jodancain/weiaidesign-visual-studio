import * as THREE from 'three';
import { configureRenderer, createRuntime, GL_OPTIONS, gpuInfo } from './browser-runtime';
declare global { interface Window { codeVideo: any } }
let runtime: Awaited<ReturnType<typeof createRuntime>>, gl: THREE.WebGLRenderer;
window.codeVideo = {
  async initialize(spec: any) {
    const started = performance.now();
    runtime = await createRuntime(spec);
    gl = new THREE.WebGLRenderer(GL_OPTIONS);
    configureRenderer(gl, spec);
    document.body.style.cssText = 'margin:0;padding:0;background:#000;overflow:hidden';
    gl.domElement.style.cssText = `display:block;width:${spec.width}px;height:${spec.height}px`;
    document.body.appendChild(gl.domElement);
    runtime.evaluateFrame(0);
    if ('exposure' in runtime) gl.toneMappingExposure = runtime.exposure;
    await gl.compileAsync(runtime.scene, runtime.camera);
    gl.render(runtime.scene, runtime.camera); gl.getContext().finish();
    return { ...gpuInfo(gl), resourceLoadMs: performance.now() - started };
  },
  renderFrame(frame: number) {
    if (!Number.isInteger(frame) || frame < 0) throw Error('Integer absolute frame required');
    const metadata = runtime.evaluateFrame(frame);
    if ('exposure' in runtime) gl.toneMappingExposure = runtime.exposure;
    runtime.scene.updateMatrixWorld(true); runtime.camera.updateMatrixWorld(true);
    gl.render(runtime.scene, runtime.camera); gl.getContext().finish();
    return metadata;
  },
};
