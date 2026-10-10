# Studio v3 media execution

`app.py` registers `studio_jobs.py` alongside the existing v1 routes. Both versions use
the existing single render queue, so v3 does not start a second competing Blender loop.

## Runtime

- `BLENDER_BIN`: native Blender executable, 5.2.2 tested.
- `FFMPEG_BIN`, `FFPROBE_BIN`: executable paths, defaults `ffmpeg` and `ffprobe`.
- `STUDIO_RENDER_DIR`: durable job directory, defaults to `STORY_ASSETS_DIR/renders/studio-v3`.
- `STUDIO_RENDER_TIMEOUT`: per-render/process timeout in seconds, default 3600.
- `STUDIO_WORKER_TOKEN`: optional dedicated bearer credential for every v3 route. Set it
  together with the gateway configuration before exposing v3 outside a trusted network.
- `STUDIO_RENDER_ENGINE`: default `BLENDER_EEVEE`; `CYCLES` is supported for CPU/headless validation.
- `STUDIO_RENDER_SAMPLES`: Cycles samples, default 16.

`GET /api/v3/capabilities` actually executes version probes for Blender, FFmpeg and
ffprobe. The result is cached for 30 seconds. `available` means all three work.

`POST /api/v3/render` accepts `jobRef`, a 64-hex `inputHash`, embedded `baked_glb_b64`,
the StudioScene `scene`, `frameStart`, `frameEnd`, `fps:24`, `resolution:[w,h]`, and
optional `landmarks`. Frame intervals are end-exclusive. One frame returns a PNG;
multiple frames additionally return a checked 24-fps MP4. The status route is
`GET /api/v3/render/:jobRef`. Completed results include `images:[{frame,url}]`,
`video_url` when applicable, `landmarks`, and `landmarkValidation`. Asset URLs are
relative to the worker and serve only completed PNG/MP4 outputs.

`jobRef` is the persistent ID. Repeating it with identical input returns the same job.
Changing either the claimed hash or actual payload under that ID returns 409.
Input, input-byte hash, and manifests are durable before queue submission. On startup,
interrupted queued/running local renders are queued again into a new attempt directory;
old process output cannot overwrite a new attempt. Complete/failed jobs are retained
and never silently retried. This recovery rule applies only to local deterministic
renders; it must not be copied to paid external-provider requests.

## Bake contract

The GLB must be self-contained. External buffer/image URIs are rejected. Node names
are stable object IDs; cameras use camera IDs. The bake origin is read from
`extras.studio.frameStart` on a scene or node (`scene.bakeFrameStart` can override).
Blender evaluates `globalFrame - bakeFrameStart` at 24 fps and fps_base=1. Objects,
skeletal TRS, IK and blended motion are already baked and are not solved again.

The selected local director camera is read from `extras.studio.cameraId` when present,
and must exist in the sidecar camera list; otherwise sidecar `activeCameraId` is used.
Sidecar controls lens tracks, ambient/directional/point lights,
background, ground, exposure and visibility tracks. Camera positions and skeletal
animation come from the GLB. Sidecar uses Y-up meters; renderer converts coordinates.
Static GLB parts are found by `studioPartRoot`, `studioPartId` and `studioObjectId`
extras. `objects[].parts[].visible` and `tracks[].partId` visibility apply after import;
TRS/color are already baked. Hidden parent objects or parts hide every descendant,
independent of the sidecar list order. Part landmarks use `bone: "part:<partId>"`
and the same identity-child helper convention as bone landmarks.

Landmarks are `{frame,objectId,bone?,position?,rotation?}` with XYZW quaternions
(`quaternion` is also accepted). Root object landmarks read its matrix. Bone landmarks
require an identity child node named `studio-landmark:<objectId>:<bone>` attached to
that bone, because Blender's edit-bone axes need not equal the original glTF node axes.
Readback converts world matrices back to Y-up. Supplied expectations must match within
1 mm and 0.1 degrees; missing points, nonfinite data or excess drift fail the job.

## Compositor

`gateway/studio/compositor.mjs` resolves assets to local files and produces 24-fps
H.264/AAC. The base video track must cover the sequence exactly without gaps or overlaps.
Audio/text layers may overlap. Video and audio source-in, trim and delay are frame based;
short material fails before execution. Final frame count and audio duration are verified
with ffprobe, with no silent video looping or extension. Output is fixed to 1280×720
for landscape and 720×1280 for portrait. Text `x/y` are normalized center anchors in
0..1 (defaults .5/.82), and `fontSize` is measured in final-output pixels.

Text panels are rasterized with Python 3 + Pillow and a Unicode font, then overlaid by
FFmpeg; this works with FFmpeg builds without drawtext. On Debian install
`ffmpeg python3 python3-pil fonts-noto-cjk`. `STUDIO_PYTHON_BIN` and `STUDIO_FONT_PATH`
can select alternative local executables/fonts. Missing dependencies fail explicitly.

Offline tests:

```sh
python3 -m unittest discover -s workers/blender-story -p studio_jobs_test.py -v
node --test gateway/studio/compositor.test.mjs
```

FastAPI/httpx enables the additional HTTP-contract test. The compositor test generates
only local color/tone fixtures and verifies 240 actual frames, trim boundaries, Unicode
text timing, mixed PCM levels, fades and rejection of gaps/overlaps/short sources.
Set `STUDIO_TEST_OUTPUT_DIR` to keep the MP4 and numeric test evidence.

## Native Windows worker packaging and deployment boundary

`scripts/deploy-sync.sh` includes the entire `workers/` tree in its source archive,
so it includes the new Studio modules. Its destination is the WSL project checkout;
it does **not** update the separate native runtime `D:\story-worker`, install Blender
or FFmpeg, or restart the Windows Scheduled Task. `deploy-long-video-production.sh`
only updates the gateway/web runtime and does not deploy the native worker either.

Create a local, reviewable bundle before a separately authorized native deployment:

```sh
python3 workers/blender-story/studio_package.py --output /tmp/blender-story-worker.zip
```

The ZIP contains all sibling Python modules (including `studio_*.py`), PowerShell
scripts and the worker JSON configuration/assets. Its `worker-bundle-manifest.json`
records every included file's SHA256. It excludes runtime renders, downloaded
models/scenes, `.env`, credentials and Python caches. Packaging does not SSH, copy
files to Windows or stop/start any service. `start.ps1` now checks the required Studio
modules before it changes task registration, preventing an `app.py`-only update
from silently creating a broken task.

For an approved native deployment, extract the **whole** reviewed bundle into the
native worker directory, preserving `D:\story-assets` and durable v3 jobs; compare
files against the manifest before starting. Python must have FastAPI, Pydantic and
Uvicorn available; the task account must be able to execute Blender, FFmpeg and
ffprobe. Configure `BLENDER_BIN`, `FFMPEG_BIN`, `FFPROBE_BIN`, the durable directory
and matching worker/gateway bearer credentials in the actual Scheduled Task runtime
environment. A temporary SSH/PowerShell process environment is not proof that a
Scheduled Task receives those values. After any separately approved restart, verify
both `/health` and authenticated `/api/v3/capabilities`; all three actual binary probes
must pass for `available:true`. Do not infer readiness from a source sync or an open port.
