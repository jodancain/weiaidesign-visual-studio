# Studio 3.0 director

`DirectorPanel` is a client-only R3F/Drei scene editor. Its default and named exports are equivalent. The workbench owns all project persistence, asset upload, scene commands and undo/redo; the director submits typed `SceneOp[]` and never executes AI source code.

- Coordinates: Y-up, meters, integer frames, 24 fps, end-exclusive frame ranges.
- Animation evaluator: reset rest pose, evaluate independent weighted source clips with masks/fades, apply base pose and FK/root/morph tracks, update the complete object hierarchy, then solve IK. Original knees use a forward pole seed before CCD to avoid the straight-leg singularity. Imported rigs retain their own bone axes.
- Character entry: one complete GLB with skin weights and unique named bones. External texture/buffer URLs are rejected. Original volumetric SkinnedMesh and Idle/Walk/Punch/Kick/Wave clips are created in source without copying the reference ZIP's model assets. Imported source clips remain source-specific; there is no automatic cross-rig retargeting.
- Joint limits: optional per-bone XYZ ranges relative to the imported rest quaternion. The same clamp applies after FK/source clips and after each CCD joint step, then bakes into the GLB. The UI supports enabling, disabling and changing the ranges; original characters provide 16 default ranges. Imported axes remain source-specific, so limits require rig-appropriate tuning.
- Static model entry: complete unskinned GLB. Original glTF mesh node indices become stable `gltf-node-N` part IDs and `/nodes/N` JSON pointers. Parts retain their local transforms and intermediate assembly hierarchy. Materials are isolated per mesh so editing a selected part cannot recolor a sibling that shared the source material. A part is an authored mesh node; there is no automatic geometry segmentation.
- Selection: point, rectangle and lasso sample frontmost ray hits, excluding hidden and locked objects or parts. Stable object/part IDs flow to typed edits. Region selection uses a bounded screen sampling grid rather than a pixel-perfect ID buffer. Static edits issue `part.update`; dynamic part edits issue a matching `partId` track. AI receives the exact selected part IDs for server-side scope validation.
- Playback: the workbench owns the single playback clock; the director only displays its frame and requests play/stop or scrubbing.
- Editing fields: text and numbers remain local while typing. Enter or leaving the field confirms one command; Escape restores the latest saved value. IME candidate confirmation does not submit or clear an unfinished composition. Failed submissions preserve the draft for retry. An incoming value does not silently overwrite a dirty draft; a conflicting draft requires explicit confirmation. Exposure and morph sliders commit at the end of a gesture. Focusing an inspector field or seeking pauses playback.
- Narrow screens: compact tabs reveal the asset and property panels without clipping controls. This keeps essential controls reachable; the full animation workflow remains oriented toward desktop use.
- Camera saving: both observation and selected-camera views use the project aspect ratio. Saving a new camera retains world position, the real Orbit target (or evaluated forward direction), focal length and film gauge; switching happens only after persistence succeeds. Undoing a camera creation falls back to a valid scene camera. The current camera schema cannot encode roll or shifted/view-offset optics, so saving those views fails explicitly instead of silently changing composition.
- Screenshot: “保存当前镜头” captures the selected scene camera; “保存观察视角” saves the observation as a new persistent camera and captures that view. Both produce a 1280×720 or 720×1280 offscreen render without helper overlays. The captureView field distinguishes the source, and every image retains a valid cameraId for restoration. Metadata includes scene revision, mode, frame, camera ID/matrices, object/part IDs and normalized centers. Centers are references, not segmentation masks. Reopening an old screenshot must check its scene revision before editing the live scene.
- Bake: actual per-frame GLB root/bone/part/assembly/camera/morph animation; helper nodes attached to bones and parts preserve original node axes across Blender import. `extras.studio` carries frame origin, end, fps, camera ID and scene revision. Visibility/focal-length and environment data also remain in the typed scene sidecar.

Extra callbacks beyond the initial contract: `onHistory`, `onAI`, `onImportAsset`. Screenshot restoration uses `initialShotView`, `initialMode`, `initialCameraId`; camera selection is local view state and does not change a scene revision. Bake metadata identifies the chosen camera.

## Validation

From `web`:

```sh
npx tsx --test components/studio/director/animation.test.ts components/studio/director/parts.test.ts
npx playwright test --config=components/studio/director/playwright.config.ts
npx playwright test --config=components/studio/director/playwright.parts.config.ts
npx playwright test --config=components/studio/director/playwright.edgecases.config.ts
```

Set `STUDIO_TEST_BASE_URL` to validate a standalone production server; for example `STUDIO_TEST_BASE_URL=http://127.0.0.1:18294`. Both browser configs write reports and screenshots to the project `output/studio-v3-validation-20261001` directory.

Core tests cover deterministic seeking, quaternion/easing interpolation, independent clip instances and body masks, original punch direction, FK, reachable four-limb IK, animated parenting, and real GLB skin/animation/landmark round-trip. Optional `--fixture`, `--fixture-ik`, `--fixture-limbs` and `--fixture-limits` arguments to `animation.test.ts` write small Three/Blender acceptance fixtures under `/tmp/studio-v3-director*-acceptance`.

Part tests use a real two-mesh GLB with a transformed assembly parent and shared source material. They check sibling isolation and real GLB bake/reimport; `parts.test.ts --fixture` writes a 13-frame worker acceptance fixture with part motion and visibility changes.

The browser tests create their own projects and verify occlusion-aware selection, FK/IK, joint-limit controls, undo/redo, key dragging/copy/curves, a clean captured PNG, capture restoration and stale-revision rejection, actual GLB upload/import with bone editing, and part isolation. Evidence is under `output/studio-v3-validation-20261001/director-*`. These checks do not by themselves certify third-party character rigs or generated final-film quality.

`director-joint-limits-evidence.json` records a 70° authored Head FK key evaluated at a 15° configured limit through frame seeking, then restored to 70° when the limit is disabled. The core test also uses a nonidentity rest quaternion and locked IK links. `--fixture-limits` exports a short constrained FK/IK GLB for an independent Blender landmark readback; the worker retains its own render evidence.

Exploration evidence in `output/studio-v3-exploration-20261001` retains the production reproductions of lost typing under 600 ms response latency, seeking snapping back during playback, and a clipped mobile inspector. The separate edge-case suite verifies full keyboard input, negative decimals, Escape, failed-command retry, a 7200-frame timeline, and narrow-screen reachability. Its IME case dispatches native composition events in Chrome and uses real `keyboard.insertText`; this verifies the browser event contract, not an operating-system IME installation.

Camera integrity regression: `npx tsx --test tests/studio-camera.test.ts` and `npx playwright test --config=components/studio/director/playwright.camera.config.ts`. The full existing director/part/edge-case suites can be run with `playwright.integrity.config.ts`; use `STUDIO_TEST_BASE_URL` and `STUDIO_EVIDENCE_DIR` for isolated targets and evidence. Current red/green results live under `output/studio-v3-integrity-20261001/web`.
