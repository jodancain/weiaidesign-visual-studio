import React, { useEffect, useLayoutEffect, useState, useRef } from 'react';
import { Composition, registerRoot, useCurrentFrame, delayRender, continueRender, cancelRender } from 'remotion';
import { ThreeCanvas } from '@remotion/three';
import { useThree } from '@react-three/fiber';
import { createRuntime, configureRenderer, GL_OPTIONS, gpuInfo } from './browser-runtime';

function ExactFrame({ runtime, spec }: { runtime: any; spec: any }) {
  const frame = useCurrentFrame();
  const { gl } = useThree();
  const compiled = useRef<Promise<void> | null>(null);
  useLayoutEffect(() => {
    const handle = delayRender(`Scene shaders and frame ${frame}`);
    let disposed = false;
    (async () => {
      // Resizing an already rendered WebGL canvas clears its drawing buffers.
      // Configure once, then mutate only the deterministic scene on each seek.
      const first = !compiled.current;
      if (first) configureRenderer(gl, spec);
      runtime.evaluateFrame(frame); // absolute composition frame, never sequence-local
      if ('exposure' in runtime) gl.toneMappingExposure = runtime.exposure;
      runtime.scene.updateMatrixWorld(true); runtime.camera.updateMatrixWorld(true);
      compiled.current ||= gl.compileAsync(runtime.scene, runtime.camera).then(() => undefined);
      await compiled.current;
      if (!disposed) { gl.render(runtime.scene, runtime.camera); gl.getContext().finish(); }
      if (first) console.log('CODE_VIDEO_LOAD:' + String(performance.now() - runtime.loadStartedAt));
      continueRender(handle);
    })().catch(error => { continueRender(handle); cancelRender(error); });
    return () => { disposed = true; continueRender(handle); };
  }, [frame, runtime, gl, spec]);
  return null;
}
function Film({ spec }: { spec: any }) {
  const [frozenSpec] = useState(() => spec);
  const [runtime, setRuntime] = useState<any>(null);
  const [ready] = useState(() => delayRender('Loading shared SceneProgram'));
  useEffect(() => {
    let active = true, loaded: any;
    const loadStartedAt=performance.now();
    createRuntime(frozenSpec).then(value => { loaded = value; if (active) { (value as any).loadStartedAt=loadStartedAt;setRuntime(value); continueRender(ready); } else value.dispose(); }).catch(cancelRender);
    return () => { active = false; loaded?.dispose(); continueRender(ready); };
  }, [frozenSpec, ready]);
  if (!runtime) return null;
  return <ThreeCanvas width={spec.width} height={spec.height} dpr={1} gl={GL_OPTIONS} scene={runtime.scene} camera={runtime.camera} shadows
    onCreated={({ gl }) => { configureRenderer(gl, spec); console.log('CODE_VIDEO_GPU:' + JSON.stringify(gpuInfo(gl))); }}
    style={{ position: 'absolute', top: 0, left: 0, width: spec.width, height: spec.height, background: '#000' }}>
    <ExactFrame runtime={runtime} spec={frozenSpec} />
  </ThreeCanvas>;
}
const defaults = { spec: { width: 1280, height: 720, fps: 24, totalFrames: 1440 } };
registerRoot(() => <Composition id="CodeFilm" component={Film} durationInFrames={1440} fps={24} width={1280} height={720} defaultProps={defaults}
  calculateMetadata={({ props }) => ({ durationInFrames: props.spec.totalFrames, fps: props.spec.fps, width: props.spec.width, height: props.spec.height })} />);
