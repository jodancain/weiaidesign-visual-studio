# Blender Story Worker

Renders **greybox keyframes** for Story Mode: a fixed 3D scene + a posable clay humanoid,
driven by a small JSON *shot spec*. The gateway restyles each greybox to photoreal with
GPT-image (reference edit), then hands consecutive keyframes to Seedance/Veo.

Why greybox: the 3D side only has to nail **pose, composition, camera and continuity**.
Appearance is owned by the restyle pass, so no texturing or lighting art is needed.
Validated on 2026-09-30: GPT-image reference edits preserve pose/framing from a clay render
with sub-1% horizontal placement drift across samples.

## Layout

```
workers/blender-story/
  app.py                      FastAPI worker, port 18087 (Windows native — needs the GPU)
  render_shot.py              headless Blender script: spec -> 1080x1920 PNG
  build_scene_warehouse.py    one-shot scene builder (room, cameras, anchors, Rigify humanoid)
  build_manifest.py           regenerates assets/manifest.json from library.json + actions.json
  assets/manifest.json        THE ONLY THING THE STORYBOARD LLM SEES — menu of ids to pick from
  assets/poses/library.json   procedural poses: Rigify FK bone rotations, degrees, calibrated
  assets/poses/actions.json   registry for imported Mixamo actions (empty until imported)
  examples/pose-*.json        one shot spec per pose, used for the contact sheet
  start.ps1 / stop.ps1 / status.ps1
```

Runtime on Windows `ai`: code in `D:\story-worker\`, scenes + renders + logs in `D:\story-assets\`.
Neither is on the SynologyDrive sync share (file locks, large PNGs).

## API

```
GET  /health                         status, blender_present, scenes[], queue_depth
GET  /api/v1/manifest                assets/manifest.json
POST /api/v1/shot                    {shot_spec} -> {job_id, state:"queued"}
GET  /api/v1/shot/{job_id}           {state, image_b64, image_mime, camera, pose, anchor, resolution, render_seconds}
                                     ?include_image=false to poll without the payload
```

Shot spec:

```json
{
  "scene_id": "warehouse",
  "camera": "cam_medium",
  "pose_id": "arm_up_point",
  "character_anchor": "anchor_left",
  "character_rotation": 10,
  "character_offset": [0, 0],
  "resolution": [1080, 1920]
}
```

Validation is against the manifest (422 on unknown scene/camera/anchor/pose). Renders are
serialised through one worker thread so Blender never contends with ComfyUI for VRAM.
A 1080x1920 EEVEE frame takes about **2 s** on the RTX 3070.

## Running

```powershell
powershell -ExecutionPolicy Bypass -File D:\story-worker\start.ps1    # registers + starts scheduled task
powershell -ExecutionPolicy Bypass -File D:\story-worker\status.ps1
powershell -ExecutionPolicy Bypass -File D:\story-worker\stop.ps1
```

`start.ps1` runs the worker as Scheduled Task `BlenderStoryWorker` (at-logon trigger, restart on
failure). A plain `Start-Process` from an SSH session dies with the session — that was the first
attempt's failure mode. Logs: `D:\story-assets\worker.log`.

The gateway reaches it as `http://host.docker.internal:18087`. Port 18087 is **not** opened in
Windows Firewall, so it is not reachable from the tailnet; that is intentional.

## Rebuilding assets

```powershell
# scene (after editing build_scene_warehouse.py)
& "C:\Program Files\Blender Foundation\Blender 5.2\blender.exe" --background --python D:\story-worker\build_scene_warehouse.py -- --out D:\story-assets\scenes\warehouse.blend
# manifest (after editing library.json / actions.json) — run on the Mac, then sync
python3 build_manifest.py
# contact sheet of every pose
for %f in (D:\story-worker\examples\pose-*.json) do @blender --background D:\story-assets\scenes\warehouse.blend --python D:\story-worker\render_shot.py -- --spec %f --out D:\story-assets\renders\%~nf.png --pose-lib D:\story-worker\assets\poses\library.json
```

## Pose authoring (calibrated axis map)

Rotations are XYZ Euler degrees on Rigify **FK** controls. `render_shot.py` forces `IK_FK=1`
on all four limbs *before* posing (Rigify defaults to IK, which silently overrides FK).
Camera looks along **+Y**; `-Y` is toward camera. Measured on the generated rig:

| bone | X+ | X− | Z (L / R mirrored) |
|---|---|---|---|
| `upper_arm_fk.*` | forward / toward camera | back | `+`(L) `−`(R) raise · `−`(L) `+`(R) lower to vertical |
| `forearm_fk.*` | bend forward | — | raise / lower |
| `thigh_fk.*` | swing back | **lift forward** | abduct |
| `torso` | lean forward | lean back | Y = side bend |
| `head` | look down | look up | Z = tilt |

To lower the whole body (sit/crouch) use `bone_locations.torso = [0, 0, -z]`: **Z**, not Y
(measured hip_z 1.01 → 0.41 at −0.6).

## Scene library (2026-09-30): open-licence scenes, adapted not modelled

Principle: find it online, don't build it. Whole scenes come from Blender's official demo files
(all CC-BY, direct download from `https://mirror.blender.org/demo/...`); `adapt_scene.py` only
*wires them in*.

| scene_id | source | what the character stands on |
|---|---|---|
| `warehouse` | built in `build_scene_warehouse.py` (the original greybox room) | floor |
| `pagoda_mountain` | EEVEE demo **Temple** by Dominik Graf (`eevee/temple/temple.blend`, 350 MB) | the `Grass` mesh crest at z≈12.4 right in front of the great pagoda. NB: `Landscape_Small` lies ~4 m *below* `Grass`; the `Circle` object is the camera-rig path, not a floor. `cam_close` and `anchor_right` are omitted from the manifest here (rock ridge / dip). |
| `ancient_hall` | Cycles demo **Lone Monk** by Carlo Bergonzini (`cycles/lone-monk_cycles_and_exposure-node_demo.blend`) | cloister `floor` north of the well (well at x 19–21, y 19–21; y ≥ 27 is under the cloister roof). `furniture`/`chair`/`books` collections deleted. Exposure −3.5 (nishita sky blows out under clay). |
| `mist_forest` | EEVEE demo **Ember Forest** by Mike Pan (`eevee/ember_forest/forest.blend`) | `Ground` mesh in front of the trunk; cameras look along world +X (yaw −90). Ground is only ~17×13 m, wide shots see mist beyond its edge on purpose. |

Pipeline (all on Windows `ai`, scripts in `ops/`):

```
ops/download-demo-scenes.ps1   -> D:\story-assets\downloads\*.blend        (Scheduled Task; ~720 MB)
inspect_scene.py                -> JSON (collections, cameras, bounds, biggest meshes) + 25% previews per camera
probe_positions.py              -> object bounds + ground-height raycasts at given XY points
scene_configs/<id>.json         -> origin, yaw, ground_objects, per-camera pos/target/lens, exposure, collections to drop
adapt_scene.py                  -> appends char_main + body_* from warehouse.blend, standard cam_*/anchor_* in a local
                                   frame (+Y = look direction), raycast-snapped to ground, key/fill lights, view-layer
                                   clay override, 1080x1920 EEVEE -> D:\story-assets\scenes\<id>.blend
build_manifest.py               -> assets/manifest.json (SCENES dict lists per-scene cameras/anchors the LLM may pick)
ops/preview-all-scenes.ps1      -> 4 cameras x 4 poses per scene at 540x960 for a contact sheet
```

Lessons: run every Blender batch through a one-shot Scheduled Task (SSH-spawned processes die with the
session); ray-cast for ground with an allow-list *and* keep going through non-matching hits (grass
instances stack hundreds deep); when the whole scene renders white or black under clay override it is
the demo's sun/sky — fix with `exposure` in the config, not with lights.

## Animatic grid (2026-09-30, v0.4.0)

`POST /api/v1/grid` `{scene_id, start:<shot spec>, end:<shot spec>, panels:9, panel_resolution:[486,864], ease:"smooth"}`
→ poll `GET /api/v1/shot/{job_id}`. `render_grid.py` interpolates pose (per-bone quaternion slerp +
location lerp), character placement/facing and camera (position, orientation, lens) from `start` to `end`
and tiles 9 panels 3×3 with white gutters (1474×2608 for 486×864 panels; ~13 s on the RTX 3070).
Both specs must share `scene_id` (422 otherwise). Pixels are composed in numpy and written as PNG by
hand: `image.pixels` is scene-linear and round-tripping through `bpy.data.images.new().save()` came
out ~3× too dark, so the script applies the sRGB curve itself.

The gateway renders one grid per story segment (`animatic-NN.png`), shows it on the sign-off page
(`story_preview:true`) and derives the *motion script* text from the same start/end specs. Through
ezr.sh Seedance only accepts a single first frame, so the grid is **not** sent to the video model;
the AdCraft-style "follow the 3×3 grid" reference trick needs a direct Volcengine Ark key.

## Adding Mixamo actions later

Import the FBX into `warehouse.blend`, retarget/attach to `char_main` (or import as its own
armature and swap `get_rig()`), then register in `assets/poses/actions.json`:

```json
{ "actions": { "mx_idle": { "label": "Idle", "action": "Armature|mixamo.com|Layer0", "frames": [1, 40, 80], "description": "..." } } }
```

Run `build_manifest.py`; the LLM can now pick `mx_idle` and the worker will use
`pose_action`/`pose_frame` instead of the procedural library.
