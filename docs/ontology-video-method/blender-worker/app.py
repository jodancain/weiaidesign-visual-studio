"""
Blender Story worker — renders greybox keyframes for Story Mode.

Runs as a native Windows process (Blender needs the GPU and lives on the Windows side),
listening on 18087. Same job shape as workers/local-i2v so the gateway integrates the same way:

    GET  /health
    GET  /api/v1/manifest              -> assets/manifest.json (what the storyboard LLM may pick)
    POST /api/v1/shot   {shot_spec}    -> {job_id, state:"queued"}
    GET  /api/v1/shot/{job_id}         -> {state: queued|rendering|complete|failed, image_b64, ...}

Renders are serialised through a single worker thread: one Blender process at a time, so a
burst of keyframes cannot fight ComfyUI (which shares the RTX 3070) for VRAM.

Config (env):
    STORY_WORKER_PORT        default 18087
    BLENDER_BIN              default C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe
    STORY_ASSETS_DIR         default D:\\story-assets       (scenes/, renders/)
    STORY_WORKER_DIR         default this file's directory (render_shot.py, assets/manifest.json, assets/poses/)
    STORY_RENDER_TIMEOUT     default 300 seconds per shot
    STORY_JOB_TTL            default 3600 seconds before finished jobs are forgotten
"""

from __future__ import annotations

import base64
import json
import os
import queue
import re
import subprocess
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

PORT = int(os.getenv("STORY_WORKER_PORT", "18087"))
BLENDER_BIN = os.getenv("BLENDER_BIN", r"C:\Program Files\Blender Foundation\Blender 5.2\blender.exe")
ASSETS_DIR = Path(os.getenv("STORY_ASSETS_DIR", r"D:\story-assets"))
WORKER_DIR = Path(os.getenv("STORY_WORKER_DIR", os.path.dirname(os.path.abspath(__file__))))
RENDER_TIMEOUT = int(os.getenv("STORY_RENDER_TIMEOUT", "300"))
JOB_TTL = int(os.getenv("STORY_JOB_TTL", "3600"))

RENDER_SCRIPT = WORKER_DIR / "render_shot.py"
ONTOLOGY_SCRIPT = WORKER_DIR / "render_ontology.py"
MODELS_DIR = ASSETS_DIR / "models"
POSE_LIB = WORKER_DIR / "assets" / "poses" / "library.json"
MANIFEST = WORKER_DIR / "assets" / "manifest.json"
SCENES_DIR = ASSETS_DIR / "scenes"
RENDERS_DIR = ASSETS_DIR / "renders"

app = FastAPI(title="Blender Story Worker", version="0.2.0")
jobs: dict[str, dict[str, Any]] = {}
jobs_lock = threading.Lock()
work_queue: "queue.Queue[str]" = queue.Queue()


class ShotSpec(BaseModel):
    scene_id: str = "warehouse"
    camera: str
    pose_id: str | None = None
    pose_action: str | None = None
    pose_frame: int | None = None
    character_anchor: str = "anchor_center"
    character_offset: list[float] = Field(default_factory=lambda: [0.0, 0.0])
    character_rotation: float = 0.0
    camera_offset: list[float] | None = None
    resolution: list[int] = Field(default_factory=lambda: [1080, 1920])
    engine: str = "BLENDER_EEVEE"
    # Caller-side correlation only; echoed back untouched.
    job_ref: str | None = None


def load_manifest() -> dict[str, Any]:
    with open(MANIFEST, "r", encoding="utf-8") as fh:
        return json.load(fh)


def update_job(job_id: str, **fields: Any) -> None:
    with jobs_lock:
        job = jobs.get(job_id)
        if job is not None:
            job.update(fields)
            job["updated_at"] = time.time()


def validate_spec(spec: ShotSpec, manifest: dict[str, Any]) -> Path:
    scene = manifest["scenes"].get(spec.scene_id)
    if scene is None:
        raise HTTPException(422, f"unknown scene_id: {spec.scene_id}")
    if spec.camera not in scene["cameras"]:
        raise HTTPException(422, f"unknown camera {spec.camera!r} for scene {spec.scene_id}")
    if spec.character_anchor not in scene["anchors"]:
        raise HTTPException(422, f"unknown anchor {spec.character_anchor!r} for scene {spec.scene_id}")
    if not spec.pose_id and not spec.pose_action:
        raise HTTPException(422, "pose_id or pose_action is required")
    if spec.pose_id and spec.pose_id not in manifest["poses"]:
        raise HTTPException(422, f"unknown pose_id: {spec.pose_id}")
    if spec.pose_id and manifest["poses"][spec.pose_id].get("source") == "action" and not spec.pose_action:
        entry = manifest["poses"][spec.pose_id]
        spec.pose_action = entry["pose_action"]
        spec.pose_frame = spec.pose_frame or entry.get("pose_frames", [1])[0]
    if len(spec.resolution) != 2 or min(spec.resolution) < 64 or max(spec.resolution) > 4096:
        raise HTTPException(422, "resolution must be [w, h] within 64..4096")
    blend = SCENES_DIR / Path(scene["file"]).name
    if not blend.exists():
        raise HTTPException(503, f"scene file missing on worker: {blend}")
    return blend


def render_job(job_id: str) -> None:
    with jobs_lock:
        job = dict(jobs[job_id])
    spec: dict[str, Any] = job["spec"]
    blend: str = job["blend"]
    run_dir = RENDERS_DIR / job_id
    run_dir.mkdir(parents=True, exist_ok=True)
    spec_path = run_dir / "shot.json"
    out_path = run_dir / "frame.png"
    # render_shot.py reads the spec verbatim; drop worker-only keys.
    render_spec = {k: v for k, v in spec.items() if k not in ("scene_id", "engine", "job_ref")}
    spec_path.write_text(json.dumps(render_spec), encoding="utf-8")
    cmd = [
        BLENDER_BIN, "--background", blend,
        "--python", str(RENDER_SCRIPT), "--",
        "--spec", str(spec_path), "--out", str(out_path),
        "--pose-lib", str(POSE_LIB), "--engine", spec.get("engine", "BLENDER_EEVEE"),
    ]
    update_job(job_id, state="rendering", progress=10, started_at=time.time())
    started = time.time()
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=RENDER_TIMEOUT, encoding="utf-8", errors="replace")
    except subprocess.TimeoutExpired:
        update_job(job_id, state="failed", progress=100, error=f"blender timed out after {RENDER_TIMEOUT}s")
        return
    tail = "\n".join((proc.stdout or "").splitlines()[-25:])
    done_line = next((l for l in (proc.stdout or "").splitlines() if l.startswith('{"event": "RENDER_DONE"')), None)
    if proc.returncode != 0 or not done_line or not out_path.exists():
        err = (proc.stderr or "").strip().splitlines()[-5:]
        update_job(job_id, state="failed", progress=100,
                   error=f"blender exit {proc.returncode}; {' | '.join(err) or 'no RENDER_DONE'}", blender_tail=tail)
        return
    info = json.loads(done_line)
    image_b64 = base64.b64encode(out_path.read_bytes()).decode("ascii")
    update_job(
        job_id, state="complete", progress=100,
        image_path=str(out_path), image_mime="image/png", image_b64=image_b64,
        bytes=info.get("bytes"), camera=info.get("camera"), pose=info.get("pose"),
        anchor=info.get("anchor"), resolution=info.get("resolution"),
        render_seconds=round(time.time() - started, 1),
    )


class OntologyRenderSpec(BaseModel):
    """Subject-agnostic studio render: see render_ontology.py docstring for the schema."""
    scene: dict[str, Any] = Field(default_factory=dict)
    subject: dict[str, Any]
    states: list[dict[str, Any]] = Field(default_factory=list)
    anchors: list[dict[str, Any]]
    resolution: list[int] = Field(default_factory=lambda: [1280, 720])
    engine: str = "BLENDER_EEVEE"
    samples: int = 24
    job_ref: str | None = None


def validate_ontology_spec(spec: OntologyRenderSpec) -> None:
    if not spec.anchors or len(spec.anchors) > 24:
        raise HTTPException(422, "anchors must contain 1..24 items")
    ids = [str(a.get("id", "")) for a in spec.anchors]
    if any(not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", i) for i in ids) or len(set(ids)) != len(ids):
        raise HTTPException(422, "anchor ids must be unique kebab/snake tokens")
    asset = (spec.subject or {}).get("asset") or {}
    if asset.get("path"):
        # only files inside the models dir; the caller may pass a bare filename
        candidate = Path(asset["path"])
        if not candidate.is_absolute():
            candidate = MODELS_DIR / candidate.name
        if MODELS_DIR.resolve() not in candidate.resolve().parents or not candidate.exists():
            raise HTTPException(422, f"asset not found under models dir: {candidate.name}")
        asset["path"] = str(candidate)
    elif not (spec.subject or {}).get("proxy"):
        raise HTTPException(422, "subject needs asset.path or proxy")
    if len(spec.resolution) != 2 or min(spec.resolution) < 64 or max(spec.resolution) > 4096:
        raise HTTPException(422, "resolution must be [w, h] within 64..4096")
    for st in spec.states:
        for op in st.get("ops", []):
            try:
                re.compile(op.get("match", ""))
            except re.error as exc:
                raise HTTPException(422, f"bad regex in state {st.get('id')}: {exc}") from exc


def render_ontology_job(job_id: str) -> None:
    with jobs_lock:
        job = dict(jobs[job_id])
    run_dir = RENDERS_DIR / job_id
    run_dir.mkdir(parents=True, exist_ok=True)
    spec_path = run_dir / "ontology.json"
    spec_path.write_text(json.dumps(job["spec"]), encoding="utf-8")
    cmd = [BLENDER_BIN, "--background", "--factory-startup", "--python", str(ONTOLOGY_SCRIPT), "--", "--spec", str(spec_path), "--out-dir", str(run_dir)]
    update_job(job_id, state="rendering", progress=5, started_at=time.time())
    started = time.time()
    timeout = max(RENDER_TIMEOUT, 60 * len(job["spec"].get("anchors", [])))
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, encoding="utf-8", errors="replace")
    except subprocess.TimeoutExpired:
        update_job(job_id, state="failed", progress=100, error=f"blender timed out after {timeout}s")
        return
    lines = (proc.stdout or "").splitlines()
    anchors = [json.loads(l) for l in lines if l.startswith('{"event": "ANCHOR_DONE"')]
    done = next((json.loads(l) for l in lines if l.startswith('{"event": "RENDER_DONE"')), None)
    tail = "\n".join(lines[-25:])
    if proc.returncode != 0 or done is None:
        err = (proc.stderr or "").strip().splitlines()[-5:]
        update_job(job_id, state="failed", progress=100, error=f"blender exit {proc.returncode}; {' | '.join(err) or 'no RENDER_DONE'}", blender_tail=tail)
        return
    images = {}
    for a in anchors:
        p = Path(a["out"])
        if p.exists():
            images[a["id"]] = {"image_b64": base64.b64encode(p.read_bytes()).decode("ascii"), "image_mime": "image/png",
                               "bytes": a.get("bytes"), "camera": a.get("camera"), "states": a.get("states")}
    update_job(job_id, state="complete", progress=100, images=images, subject_bbox=done.get("subject_bbox"),
               mesh_names=done.get("mesh_names"), render_seconds=round(time.time() - started, 1))


def worker_loop() -> None:
    while True:
        job_id = work_queue.get()
        try:
            with jobs_lock:
                kind = jobs.get(job_id, {}).get("kind", "shot")
            (render_ontology_job if kind == "ontology" else render_job)(job_id)
        except Exception as exc:  # noqa: BLE001
            update_job(job_id, state="failed", progress=100, error=f"{type(exc).__name__}: {exc}")
        finally:
            work_queue.task_done()
            reap_jobs()


def reap_jobs() -> None:
    cutoff = time.time() - JOB_TTL
    with jobs_lock:
        for jid in [j for j, v in jobs.items() if v.get("state") in ("complete", "failed") and v.get("updated_at", 0) < cutoff]:
            jobs.pop(jid, None)


threading.Thread(target=worker_loop, daemon=True, name="blender-render").start()


@app.get("/health")
def health() -> dict[str, Any]:
    manifest_ok = MANIFEST.exists()
    scenes = sorted(p.name for p in SCENES_DIR.glob("*.blend")) if SCENES_DIR.exists() else []
    with jobs_lock:
        states = [j.get("state") for j in jobs.values()]
    return {
        "status": "ok" if manifest_ok and scenes and Path(BLENDER_BIN).exists() else "degraded",
        "backend": "blender-story",
        "blender_bin": BLENDER_BIN,
        "blender_present": Path(BLENDER_BIN).exists(),
        "scenes": scenes,
        "manifest": manifest_ok,
        "queue_depth": work_queue.qsize(),
        "jobs": {"total": len(states), "rendering": states.count("rendering"), "queued": states.count("queued")},
    }


@app.get("/api/v1/manifest")
def manifest() -> JSONResponse:
    return JSONResponse(load_manifest())


@app.post("/api/v1/shot")
def create_shot(spec: ShotSpec) -> dict[str, Any]:
    m = load_manifest()
    blend = validate_spec(spec, m)
    job_id = f"shot-{uuid.uuid4()}"
    with jobs_lock:
        jobs[job_id] = {
            "job_id": job_id, "state": "queued", "progress": 0,
            "spec": spec.model_dump(), "blend": str(blend), "job_ref": spec.job_ref,
            "created_at": time.time(), "updated_at": time.time(),
        }
    work_queue.put(job_id)
    return {"job_id": job_id, "state": "queued", "progress": 0, "queue_position": work_queue.qsize()}


@app.get("/api/v1/shot/{job_id}")
def get_shot(job_id: str, include_image: bool = True) -> dict[str, Any]:
    with jobs_lock:
        job = jobs.get(job_id)
        if job is None:
            raise HTTPException(404, "shot job not found")
        out = dict(job)
    if not include_image:
        out.pop("image_b64", None)
    return out


@app.get("/api/v1/models")
def list_models() -> dict[str, Any]:
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    items = [{"name": p.name, "bytes": p.stat().st_size} for p in sorted(MODELS_DIR.iterdir()) if p.suffix.lower() in (".glb", ".gltf", ".obj", ".fbx")]
    return {"models_dir": str(MODELS_DIR), "items": items}


@app.post("/api/v1/ontology-render")
def create_ontology_render(spec: OntologyRenderSpec) -> dict[str, Any]:
    validate_ontology_spec(spec)
    job_id = f"onto-{uuid.uuid4()}"
    with jobs_lock:
        jobs[job_id] = {"job_id": job_id, "kind": "ontology", "state": "queued", "progress": 0, "spec": spec.model_dump(),
                        "job_ref": spec.job_ref, "created_at": time.time(), "updated_at": time.time()}
    work_queue.put(job_id)
    return {"job_id": job_id, "state": "queued", "progress": 0, "queue_position": work_queue.qsize(), "anchors": [a["id"] for a in spec.anchors]}


@app.get("/api/v1/ontology-render/{job_id}")
def get_ontology_render(job_id: str, include_images: bool = True) -> dict[str, Any]:
    with jobs_lock:
        job = jobs.get(job_id)
        if job is None or job.get("kind") != "ontology":
            raise HTTPException(404, "ontology render job not found")
        out = dict(job)
    if not include_images and "images" in out:
        out["images"] = {k: {kk: vv for kk, vv in v.items() if kk != "image_b64"} for k, v in out["images"].items()}
    return out


if __name__ == "__main__":
    import uvicorn

    RENDERS_DIR.mkdir(parents=True, exist_ok=True)
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="info")
