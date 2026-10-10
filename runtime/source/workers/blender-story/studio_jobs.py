"""Durable, local-only Studio v3 rendering. The legacy queue owns GPU scheduling."""
from __future__ import annotations

import base64
import copy
import hashlib
import json
import math
import os
import re
import struct
import subprocess
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable


class StudioError(ValueError):
    def __init__(self, message: str, status: int = 422):
        super().__init__(message)
        self.status = status


def atomic_json(path: Path, value: Any) -> None:
    temp = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    with temp.open("w", encoding="utf8") as stream:
        json.dump(value, stream, ensure_ascii=False, allow_nan=False)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temp, path)


def read_glb(data: bytes) -> dict:
    if len(data) < 20 or len(data) > 200 * 1024 * 1024:
        raise StudioError("GLB must contain 20 bytes..200 MiB")
    magic, version, length = struct.unpack_from("<III", data)
    if magic != 0x46546C67 or version != 2 or length != len(data):
        raise StudioError("Invalid GLB 2 header")
    size, kind = struct.unpack_from("<II", data, 12)
    if kind != 0x4E4F534A or 20 + size > len(data):
        raise StudioError("GLB JSON chunk missing")
    try:
        document = json.loads(data[20:20 + size])
    except (ValueError, UnicodeError) as exc:
        raise StudioError("Invalid GLB JSON") from exc
    if not isinstance(document, dict):
        raise StudioError("GLB JSON must be an object")
    for key in ("buffers", "images", "scenes", "nodes"):
        if not isinstance(document.get(key, []), list) or any(not isinstance(item, dict) for item in document.get(key, [])):
            raise StudioError(f"GLB {key} must contain objects")
    for item in document.get("buffers", []) + document.get("images", []):
        uri = item.get("uri")
        if uri and (not isinstance(uri, str) or not uri.startswith("data:")):
            raise StudioError("GLB external resources are forbidden; embed assets")
    return document


def validate_landmark_readback(expected: list[dict], observed: list[dict]) -> dict:
    def key(point):
        return point["frame"], point["objectId"], point.get("bone", "root")
    actual = {key(point): point for point in observed}
    max_position, max_angle, checked = 0.0, 0.0, 0
    for point in expected:
        found = actual.get(key(point))
        if found is None:
            raise StudioError(f"Landmark readback missing: {key(point)}")
        for values, length in ((found.get("position"), 3), (found.get("quaternion", found.get("rotation")), 4)):
            if not isinstance(values, list) or len(values) != length or any(not isinstance(v, (int, float)) or not math.isfinite(v) for v in values):
                raise StudioError("Invalid landmark readback values")
        position = point.get("position")
        quaternion = point.get("quaternion", point.get("rotation"))
        if position is not None:
            distance = math.sqrt(sum((float(a) - float(b)) ** 2 for a, b in zip(position, found["position"])))
            max_position = max(max_position, distance)
        if quaternion is not None:
            other = found.get("quaternion", found.get("rotation"))
            norm = math.sqrt(sum(float(v) ** 2 for v in quaternion) * sum(float(v) ** 2 for v in other))
            if norm < 1e-12:
                raise StudioError("Invalid landmark quaternion")
            dot = abs(sum(float(a) * float(b) for a, b in zip(quaternion, other))) / norm
            angle = math.degrees(2 * math.acos(min(1, max(-1, dot))))
            max_angle = max(max_angle, angle)
        if position is not None or quaternion is not None:
            checked += 1
    if max_position > 0.001 or max_angle > 0.1:
        raise StudioError(f"Landmark drift exceeds tolerance: {max_position:.6f} m / {max_angle:.6f} degrees")
    return {"checked": checked, "maxPositionErrorMeters": max_position, "maxRotationErrorDegrees": max_angle, "positionToleranceMeters": .001, "rotationToleranceDegrees": .1}


def validate_request(body: dict) -> tuple[dict, bytes]:
    if not isinstance(body, dict):
        raise StudioError("Expected a JSON object")
    spec = copy.deepcopy(body)
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}", str(spec.get("jobRef", ""))):
        raise StudioError("jobRef must be a safe 1..128 character id")
    if not re.fullmatch(r"[A-Fa-f0-9]{64}", str(spec.get("inputHash", ""))):
        raise StudioError("inputHash must be SHA256 hex")
    if spec.get("fps") != 24:
        raise StudioError("Only 24 fps is supported")
    start, end = spec.get("frameStart"), spec.get("frameEnd")
    if type(start) is not int or type(end) is not int or start < 0 or end <= start or end - start > 2400:
        raise StudioError("frameStart/frameEnd must be an end-exclusive range of 1..2400 frames")
    resolution = spec.get("resolution", [1280, 720])
    if not isinstance(resolution, list) or len(resolution) != 2 or any(type(v) is not int or v < 64 or v > 2048 or v % 2 for v in resolution):
        raise StudioError("resolution must be two even integers within 64..2048")
    spec["resolution"] = resolution
    scene = spec.get("scene")
    if not isinstance(scene, dict) or scene.get("up", "Y") != "Y" or scene.get("units", "meters") != "meters":
        raise StudioError("scene must use Y-up meters")
    for key in ("objects", "cameras", "tracks", "lights"):
        if key in scene and not isinstance(scene[key], list):
            raise StudioError(f"scene.{key} must be an array")
    points = spec.get("landmarks", [])
    if not isinstance(points, list) or len(points) > 10000:
        raise StudioError("landmarks must contain at most 10000 samples")
    for point in points:
        if not isinstance(point, dict) or type(point.get("frame")) is not int or not start <= point["frame"] < end or not point.get("objectId"):
            raise StudioError("landmarks need objectId and a frame within the requested range")
        for key, length in (("position", 3), ("rotation", 4), ("quaternion", 4)):
            if key in point and (not isinstance(point[key], list) or len(point[key]) != length or any(not isinstance(v, (int, float)) or not math.isfinite(v) for v in point[key])):
                raise StudioError(f"landmark.{key} must contain {length} finite numbers")
    try:
        raw = base64.b64decode(spec.pop("baked_glb_b64"), validate=True)
    except (ValueError, KeyError, TypeError) as exc:
        raise StudioError("baked_glb_b64 must be valid base64") from exc
    document = read_glb(raw)
    # Importer times are local to a bake; keep its explicit origin with the durable input.
    origins = []
    for node in document.get("scenes", []) + document.get("nodes", []):
        extras = node.get("extras")
        if isinstance(extras, dict) and isinstance(extras.get("studio"), dict):
            origins.append(extras["studio"])
    origin = next((s for s in origins if "frameStart" in s), {})
    spec["bakeFrameStart"] = scene.get("bakeFrameStart", origin.get("frameStart", 0))
    if origin.get("cameraId"):
        camera_id = origin["cameraId"]
        if not any(isinstance(camera, dict) and camera.get("id") == camera_id for camera in scene.get("cameras", [])):
            raise StudioError("Baked camera is missing from scene sidecar")
        spec["bakedCameraId"] = camera_id
        scene["activeCameraId"] = camera_id
    if type(spec["bakeFrameStart"]) is not int or spec["bakeFrameStart"] > start:
        raise StudioError("Requested range precedes bake origin")
    if origin.get("frameEnd") is not None and end > origin["frameEnd"]:
        raise StudioError("Requested range exceeds baked animation")
    spec["glbSha256"] = hashlib.sha256(raw).hexdigest()
    # Strict JSON also rejects NaN/Infinity before Blender sees sidecar values.
    try:
        json.dumps(spec, allow_nan=False)
    except (ValueError, TypeError) as exc:
        raise StudioError("Sidecar contains invalid values") from exc
    return spec, raw


class StudioJobs:
    def __init__(self, root: Path, blender_bin: str, *, ffmpeg_bin: str = "ffmpeg", ffprobe_bin: str = "ffprobe", timeout: int = 3600, enqueue: Callable[[str], None] | None = None):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.blender_bin, self.ffmpeg_bin, self.ffprobe_bin = blender_bin, ffmpeg_bin, ffprobe_bin
        self.timeout = timeout
        self.enqueue = enqueue
        self.lock = threading.RLock()
        self._capability_cache: tuple[float, dict] | None = None
        self.jobs: dict[str, dict] = {}
        for path in self.root.glob("*/job.json"):
            try:
                job = json.loads(path.read_text(encoding="utf8"))
                if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}", job["id"]) or path.parent.name != job["id"]:
                    continue
                if job["state"] in ("queued", "running"):
                    job.update(state="queued", progress=0, recovered=True, updatedAt=time.time())
                    atomic_json(path, job)
                self.jobs[job["id"]] = job
            except (OSError, ValueError, KeyError):
                # Quarantine logically: never invent success or delete forensic evidence.
                continue

    def recover(self) -> None:
        if self.enqueue:
            for job in list(self.jobs.values()):
                if job["state"] == "queued":
                    self.enqueue(job["id"])

    def capabilities(self) -> dict:
        if self._capability_cache and time.time() - self._capability_cache[0] < 30:
            return dict(self._capability_cache[1])
        present = {}
        for key, binary, flag in (("blender", self.blender_bin, "--version"), ("ffmpeg", self.ffmpeg_bin, "-version"), ("ffprobe", self.ffprobe_bin, "-version")):
            try:
                process = subprocess.run([binary, flag], capture_output=True, timeout=10, check=False)
                present[key] = process.returncode == 0
            except (OSError, subprocess.TimeoutExpired):
                present[key] = False
        result = {**present, "available": all(present.values()), "fps": 24}
        self._capability_cache = (time.time(), result)
        return result

    def submit(self, body: dict) -> dict:
        spec, raw = validate_request(body)
        job_id = spec["jobRef"]
        digest = hashlib.sha256(json.dumps(spec, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
        with self.lock:
            previous = self.jobs.get(job_id)
            if previous:
                if previous["inputHash"] != spec["inputHash"] or previous["payloadDigest"] != digest:
                    raise StudioError("jobRef already exists with different input", 409)
                return self.public(previous)
            run = self.root / job_id
            run.mkdir(exist_ok=True)
            glb = run / "input.glb"
            with glb.open("wb") as stream:
                stream.write(raw); stream.flush(); os.fsync(stream.fileno())
            atomic_json(run / "input.json", spec)
            now = time.time()
            job = {"id": job_id, "job_id": job_id, "jobRef": job_id, "inputHash": spec["inputHash"], "payloadDigest": digest, "state": "queued", "progress": 0, "createdAt": now, "updatedAt": now}
            atomic_json(run / "job.json", job)
            self.jobs[job_id] = job
        if self.enqueue:
            self.enqueue(job_id)
        return self.public(job)

    def public(self, job: dict) -> dict:
        return copy.deepcopy({key: value for key, value in job.items() if key not in ("payloadDigest", "attempt")})

    def get(self, job_id: str) -> dict:
        with self.lock:
            if job_id not in self.jobs:
                raise StudioError("Render job not found", 404)
            return self.public(self.jobs[job_id])

    def update(self, job_id: str, **fields: Any) -> None:
        with self.lock:
            self.jobs[job_id].update(fields, updatedAt=time.time())
            atomic_json(self.root / job_id / "job.json", self.jobs[job_id])

    def asset(self, job_id: str, filename: str) -> Path:
        self.get(job_id)
        if not re.fullmatch(r"(?:frame_\d{6}\.png|preview\.mp4)", filename):
            raise StudioError("Asset not found", 404)
        job = self.jobs[job_id]
        if job["state"] != "complete":
            raise StudioError("Render is not complete", 409)
        path = self.root / job_id / job["attempt"] / filename
        if not path.is_file():
            raise StudioError("Asset not found", 404)
        return path

    def run(self, job_id: str) -> None:
        with self.lock:
            if self.jobs.get(job_id, {}).get("state") != "queued":
                return
            attempt = "attempt-" + uuid.uuid4().hex
            self.update(job_id, state="running", progress=5, attempt=attempt)
        run = self.root / job_id
        out = run / attempt
        out.mkdir()
        try:
            spec = json.loads((run / "input.json").read_text(encoding="utf8"))
            if hashlib.sha256((run / "input.glb").read_bytes()).hexdigest() != spec["glbSha256"]:
                raise StudioError("Persisted GLB hash mismatch")
            command = [self.blender_bin, "--background", "--factory-startup", "--disable-autoexec", "--python", str(Path(__file__).with_name("studio_render.py")), "--", "--spec", str(run / "input.json"), "--glb", str(run / "input.glb"), "--out", str(out)]
            from studio_gpu import gpu_slot
            self.update(job_id, waitingReason="Waiting for the shared GPU queue")
            with gpu_slot(), (out / "blender.log").open("w", encoding="utf8") as log:
                self.update(job_id, waitingReason=None)
                result = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, timeout=self.timeout, check=False)
            if result.returncode:
                raise StudioError(f"Blender failed with exit {result.returncode}; inspect worker render log")
            report = json.loads((out / "result.json").read_text(encoding="utf8"))
            comparison = validate_landmark_readback(spec.get("landmarks", []), report.get("landmarks", []))
            count = spec["frameEnd"] - spec["frameStart"]
            for frame in range(spec["frameStart"], spec["frameEnd"]):
                if not (out / f"frame_{frame:06d}.png").is_file():
                    raise StudioError(f"Missing rendered frame {frame}")
            self.update(job_id, progress=85)
            base_url = f"/api/v3/render/{job_id}/assets/"
            fields = {"images": [{"frame": frame, "url": base_url + f"frame_{frame:06d}.png"} for frame in sorted({spec["frameStart"], (spec["frameStart"] + spec["frameEnd"] - 1) // 2, spec["frameEnd"] - 1})], "landmarks": report.get("landmarks", []), "frames": count, "fps": 24, "resolution": spec["resolution"], "bakeFrameStart": spec["bakeFrameStart"]}
            fields["landmarkValidation"] = comparison
            fields["cameraId"] = spec["scene"].get("activeCameraId")
            if count > 1:
                video = out / "preview.mp4"
                subprocess.run([self.ffmpeg_bin, "-hide_banner", "-loglevel", "error", "-y", "-framerate", "24", "-start_number", str(spec["frameStart"]), "-i", str(out / "frame_%06d.png"), "-frames:v", str(count), "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(video)], check=True, capture_output=True, timeout=self.timeout)
                data = json.loads(subprocess.check_output([self.ffprobe_bin, "-v", "error", "-count_frames", "-show_streams", "-of", "json", str(video)], timeout=60))
                stream = next(s for s in data["streams"] if s["codec_type"] == "video")
                if int(stream["nb_read_frames"]) != count or stream["avg_frame_rate"] != "24/1" or [stream["width"], stream["height"]] != spec["resolution"]:
                    raise StudioError("Preview failed frame/fps/resolution validation")
                fields["video_url"] = base_url + "preview.mp4"
            self.update(job_id, state="complete", progress=100, **fields)
        except Exception as exc:
            self.update(job_id, state="failed", progress=100, error=f"{type(exc).__name__}: {str(exc)[:1000]}")


def register_routes(app: Any, manager: StudioJobs) -> None:
    from fastapi import Body, Header, HTTPException
    from fastapi.responses import FileResponse
    import hmac

    def authorize(authorization: str | None) -> None:
        token = os.getenv("STUDIO_WORKER_TOKEN", "")
        if token and not hmac.compare_digest(authorization or "", "Bearer " + token):
            raise HTTPException(401, "Unauthorized")

    @app.get("/api/v3/capabilities")
    def capabilities(authorization: str | None = Header(default=None)):
        authorize(authorization)
        return manager.capabilities()

    @app.post("/api/v3/render")
    def create_render(body: dict = Body(...), authorization: str | None = Header(default=None)):
        authorize(authorization)
        try:
            return manager.submit(body)
        except StudioError as exc:
            raise HTTPException(exc.status, str(exc)) from exc

    @app.get("/api/v3/render/{job_id}")
    def get_render(job_id: str, authorization: str | None = Header(default=None)):
        authorize(authorization)
        try:
            return manager.get(job_id)
        except StudioError as exc:
            raise HTTPException(exc.status, str(exc)) from exc

    @app.get("/api/v3/render/{job_id}/assets/{filename}")
    def get_render_asset(job_id: str, filename: str, authorization: str | None = Header(default=None)):
        authorize(authorization)
        try:
            return FileResponse(manager.asset(job_id, filename))
        except StudioError as exc:
            raise HTTPException(exc.status, str(exc)) from exc
