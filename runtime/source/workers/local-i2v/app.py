import json
import os
import base64
import shutil
import subprocess
import time
import uuid
import asyncio
from collections import OrderedDict
from pathlib import Path
from threading import Lock, Thread
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel


WORK_DIR = Path(os.getenv("LOCAL_I2V_WORK_DIR", "./data")).resolve()
OUTPUT_DIR = WORK_DIR / "outputs"
INPUT_DIR = WORK_DIR / "inputs"
BACKEND = os.getenv("LOCAL_I2V_BACKEND", "ffmpeg").lower()
PUBLIC_BASE_URL = os.getenv("PUBLIC_BASE_URL", "").rstrip("/")
VIDEO_STORAGE_BASE_URL = os.getenv("VIDEO_STORAGE_BASE_URL", "").rstrip("/")
VIDEO_STORAGE_TOKEN = os.getenv("VIDEO_STORAGE_TOKEN", "")
MAX_DURATION = float(os.getenv("LOCAL_I2V_MAX_DURATION", "6"))
MAX_FPS = int(os.getenv("LOCAL_I2V_MAX_FPS", "24"))
COMFYUI_BASE_URL = os.getenv("COMFYUI_BASE_URL", "http://127.0.0.1:18086").rstrip("/")
COMFYUI_WORKFLOW_PATH = os.getenv(
    "COMFYUI_WORKFLOW_PATH",
    str(Path(__file__).resolve().parent / "workflows" / "wanvideo_2_1_14B_I2V_example_03.json"),
)
COMFYUI_TIMEOUT = float(os.getenv("COMFYUI_TIMEOUT", "7200"))
COMFYUI_POLL_INTERVAL = float(os.getenv("COMFYUI_POLL_INTERVAL", "5"))
COMFYUI_MODEL_NAME = os.getenv("COMFYUI_MODEL_NAME", "wan2.1-i2v-14b-480p-Q3_K_S.gguf")
COMFYUI_TEXT_ENCODER = os.getenv("COMFYUI_TEXT_ENCODER", "umt5-xxl-enc-fp8_e4m3fn.safetensors")
COMFYUI_VAE = os.getenv("COMFYUI_VAE", "wanvideo/Wan2_1_VAE_bf16.safetensors")
COMFYUI_CLIP_VISION = os.getenv("COMFYUI_CLIP_VISION", "clip_vision_h.safetensors")
COMFYUI_LORA = os.getenv("COMFYUI_LORA", "")
DEFAULT_NEGATIVE_PROMPT = os.getenv(
    "LOCAL_I2V_NEGATIVE_PROMPT",
    "色调艳丽，过曝，静态，细节模糊不清，字幕，文字，水印，画面静止，低质量，畸形，手指错误，脸部变形，背景杂乱，倒着走",
)
JOBS: dict[str, dict[str, Any]] = {}
JOBS_LOCK = Lock()

app = FastAPI(title="Local Image-to-Video Worker", version="0.1.0")


class I2VRequest(BaseModel):
    job_id: str | None = None
    prompt: str = ""
    negative_prompt: str = ""
    image_path: str | None = None
    host_image_path: str | None = None
    image_url: str | None = None
    image_b64: str | None = None
    aspect: str = "9:16"
    duration: float = 4
    fps: int = 24
    seed: int | None = None
    model: str = "framepack"
    quality: str = "draft"


def update_job(job_id: str, **fields: Any) -> None:
    with JOBS_LOCK:
        if job_id in JOBS:
            JOBS[job_id].update(fields)
            JOBS[job_id]["updated_at"] = int(time.time())


def init_dirs() -> None:
    INPUT_DIR.mkdir(parents=True, exist_ok=True)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)


def safe_duration(value: float) -> float:
    return max(1.0, min(float(value or 4), MAX_DURATION))


def safe_fps(value: int) -> int:
    return max(8, min(int(value or 24), MAX_FPS))


def copy_or_download_image(request: I2VRequest, job_id: str) -> Path:
    target = INPUT_DIR / f"{job_id}.png"
    if request.image_b64:
        target.write_bytes(base64.b64decode(request.image_b64))
        return target
    if request.host_image_path and Path(request.host_image_path).exists():
        shutil.copyfile(request.host_image_path, target)
        return target
    if request.image_path and Path(request.image_path).exists():
        shutil.copyfile(request.image_path, target)
        return target
    if request.image_url:
        with httpx.stream("GET", request.image_url, timeout=60, follow_redirects=True) as response:
            response.raise_for_status()
            with target.open("wb") as output:
                for chunk in response.iter_bytes():
                    output.write(chunk)
        return target
    raise RuntimeError("no readable image_path, host_image_path, or image_url")


def render_ffmpeg(input_image: Path, output_path: Path, duration: float, fps: int, aspect: str) -> None:
    if aspect == "16:9":
        width, height = 1280, 720
    elif aspect == "1:1":
        width, height = 768, 768
    else:
        width, height = 720, 1280
    frames = int(duration * fps)
    vf = (
        f"scale={width}:{height}:force_original_aspect_ratio=increase,"
        f"crop={width}:{height},"
        f"zoompan=z='min(zoom+0.0018,1.12)':d={frames}:s={width}x{height}:fps={fps},"
        "format=yuv420p"
    )
    command = [
        "ffmpeg",
        "-y",
        "-loop",
        "1",
        "-i",
        str(input_image),
        "-t",
        str(duration),
        "-vf",
        vf,
        "-an",
        "-movflags",
        "+faststart",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "20",
        str(output_path),
    ]
    subprocess.run(command, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)


def comfy_dimensions(aspect: str) -> tuple[int, int]:
    if aspect == "16:9":
        return 320, 192
    if aspect == "1:1":
        return 256, 256
    return 192, 320


def comfy_frame_count(duration: float, fps: int) -> int:
    # Wan 2.1 works naturally around 4n+1 frame counts. Keep smoke jobs small on 8GB VRAM.
    requested = max(5, min(int(duration * fps), 17))
    return requested - ((requested - 1) % 4)


async def comfy_json(client: httpx.AsyncClient, method: str, path: str, **kwargs: Any) -> Any:
    response = await client.request(method, f"{COMFYUI_BASE_URL}{path}", **kwargs)
    response.raise_for_status()
    return response.json()


def workflow_to_prompt(workflow: dict[str, Any], object_info: dict[str, Any]) -> dict[str, Any]:
    nodes = {
        str(node["id"]): node
        for node in workflow.get("nodes", [])
        if node.get("type") in object_info
    }
    links = {link[0]: link for link in workflow.get("links", [])}
    prompt: dict[str, Any] = OrderedDict()

    for node_id, node in nodes.items():
        class_type = node.get("type")
        class_info = object_info.get(class_type, {})
        input_info = class_info.get("input", {})
        input_names: list[str] = []
        for section in ("required", "optional"):
            values = input_info.get(section, {})
            if isinstance(values, dict):
                input_names.extend(values.keys())

        inputs: dict[str, Any] = {}
        linked_inputs = set()
        for input_spec in node.get("inputs", []) or []:
            link_id = input_spec.get("link")
            name = input_spec.get("name")
            if link_id is None or name is None or link_id not in links:
                continue
            link = links[link_id]
            if str(link[1]) not in nodes:
                continue
            inputs[name] = [str(link[1]), int(link[2])]
            linked_inputs.add(name)

        widget_values = node.get("widgets_values")
        if isinstance(widget_values, dict):
            for key, value in widget_values.items():
                if key in input_names and key not in inputs:
                    inputs[key] = value
        elif isinstance(widget_values, list):
            widget_names = [name for name in input_names if name not in linked_inputs and name not in inputs]
            for name, value in zip(widget_names, widget_values):
                inputs[name] = value

        prompt[node_id] = {"class_type": class_type, "inputs": inputs}
    return prompt


def set_first(prompt: dict[str, Any], class_type: str, updates: dict[str, Any]) -> None:
    for node in prompt.values():
        if node.get("class_type") == class_type:
            node.setdefault("inputs", {}).update(updates)
            return


def set_all(prompt: dict[str, Any], class_type: str, updates: dict[str, Any]) -> None:
    for node in prompt.values():
        if node.get("class_type") == class_type:
            node.setdefault("inputs", {}).update(updates)


def prune_unlinked_inputs(prompt: dict[str, Any], class_type: str, keep: set[str]) -> None:
    for node in prompt.values():
        if node.get("class_type") != class_type:
            continue
        inputs = node.setdefault("inputs", {})
        for key, value in list(inputs.items()):
            if key in keep or isinstance(value, list):
                continue
            del inputs[key]


def remove_nodes_by_class(prompt: dict[str, Any], class_type: str) -> None:
    removed = {node_id for node_id, node in prompt.items() if node.get("class_type") == class_type}
    for node_id in removed:
        del prompt[node_id]
    if not removed:
        return
    for node in prompt.values():
        inputs = node.setdefault("inputs", {})
        for key, value in list(inputs.items()):
            if isinstance(value, list) and value and str(value[0]) in removed:
                del inputs[key]


def patch_comfy_prompt(prompt: dict[str, Any], image_name: str, request: I2VRequest, duration: float, fps: int) -> None:
    width, height = comfy_dimensions(request.aspect)
    frames = comfy_frame_count(duration, fps)
    prompt_text = request.prompt.strip() or "cinematic natural motion, high quality video"
    negative_text = (request.negative_prompt or DEFAULT_NEGATIVE_PROMPT).strip()
    load_image_id = next((node_id for node_id, node in prompt.items() if node.get("class_type") == "LoadImage"), None)

    set_first(prompt, "LoadImage", {"image": image_name})
    set_all(prompt, "WanVideoTextEncode", {"positive_prompt": prompt_text, "negative_prompt": negative_text})
    set_all(prompt, "CLIPTextEncode", {"text": prompt_text})
    set_all(prompt, "WanVideoImageToVideoEncode", {"width": width, "height": height, "num_frames": frames})
    model_quantization = "disabled" if COMFYUI_MODEL_NAME.lower().endswith(".gguf") else "fp8_e4m3fn"
    set_all(prompt, "WanVideoModelLoader", {"model": COMFYUI_MODEL_NAME, "base_precision": "fp16", "quantization": model_quantization, "load_device": "offload_device", "attention_mode": "sdpa"})
    set_all(prompt, "LoadWanVideoT5TextEncoder", {"model_name": COMFYUI_TEXT_ENCODER, "precision": "bf16", "load_device": "offload_device", "quantization": "fp8_e4m3fn"})
    set_all(prompt, "WanVideoVAELoader", {"model_name": COMFYUI_VAE, "precision": "bf16"})
    set_all(prompt, "CLIPVisionLoader", {"clip_name": COMFYUI_CLIP_VISION})
    set_all(
        prompt,
        "WanVideoClipVisionEncode",
        {
            "strength_1": 1,
            "strength_2": 1,
            "crop": "center",
            "combine_embeds": "average",
            "force_offload": True,
        },
    )
    if load_image_id:
        set_all(prompt, "WanVideoClipVisionEncode", {"image_1": [load_image_id, 0]})
        set_all(prompt, "WanVideoImageToVideoEncode", {"start_image": [load_image_id, 0]})
    if COMFYUI_LORA:
        set_all(prompt, "WanVideoLoraSelect", {"lora": COMFYUI_LORA, "strength": 1})
    else:
        remove_nodes_by_class(prompt, "WanVideoLoraSelect")
    set_all(
        prompt,
        "WanVideoBlockSwap",
        {
            "blocks_to_swap": 30,
            "vace_blocks_to_swap": 0,
            "offload_img_emb": True,
            "offload_txt_emb": True,
            "use_non_blocking": False,
            "prefetch_blocks": 0,
            "block_swap_debug": False,
        },
    )
    set_all(
        prompt,
        "WanVideoSampler",
        {
            "steps": 2 if request.quality == "draft" else 4,
            "cfg": 1,
            "shift": 5,
            "seed": request.seed or int(time.time()),
            "force_offload": True,
            "scheduler": "dpm++_sde",
            "riflex_freq_index": 0,
            "rope_function": "comfy",
            "start_step": 0,
            "end_step": -1,
        },
    )
    set_all(
        prompt,
        "VHS_VideoCombine",
        {
            "frame_rate": fps,
            "filename_prefix": f"local_i2v_{request.job_id or 'job'}",
            "format": "video/h264-mp4",
            "pix_fmt": "yuv420p",
            "save_output": True,
        },
    )
    prune_unlinked_inputs(prompt, "WanVideoLoraSelect", {"lora", "strength", "low_mem_load", "merge_loras"})
    prune_unlinked_inputs(prompt, "WanVideoClipVisionEncode", {"strength_1", "strength_2", "crop", "combine_embeds", "force_offload"})
    prune_unlinked_inputs(
        prompt,
        "WanVideoImageToVideoEncode",
        {
            "width",
            "height",
            "num_frames",
            "noise_aug_strength",
            "start_latent_strength",
            "end_latent_strength",
            "force_offload",
            "start_image",
        },
    )
    prune_unlinked_inputs(prompt, "WanVideoSampler", {"steps", "cfg", "shift", "seed", "force_offload", "scheduler", "riflex_freq_index", "rope_function", "start_step", "end_step"})
    prune_unlinked_inputs(prompt, "WanVideoBlockSwap", {"blocks_to_swap", "vace_blocks_to_swap", "offload_img_emb", "offload_txt_emb", "use_non_blocking", "prefetch_blocks", "block_swap_debug"})


async def render_comfyui(job_id: str, input_image: Path, output_path: Path, request: I2VRequest, duration: float, fps: int) -> None:
    workflow_path = Path(COMFYUI_WORKFLOW_PATH)
    if not workflow_path.exists():
        raise RuntimeError(f"ComfyUI workflow not found: {workflow_path}")

    async with httpx.AsyncClient(timeout=COMFYUI_TIMEOUT) as client:
        update_job(job_id, state="comfyui_uploading_image", progress=25)
        with input_image.open("rb") as file:
            upload = await client.post(
                f"{COMFYUI_BASE_URL}/upload/image",
                files={"image": (input_image.name, file, "image/png")},
                data={"overwrite": "true"},
            )
        upload.raise_for_status()
        image_name = upload.json().get("name") or input_image.name

        update_job(job_id, state="comfyui_preparing_prompt", progress=30)
        object_info = await comfy_json(client, "GET", "/object_info")
        workflow = json.loads(workflow_path.read_text())
        prompt = workflow_to_prompt(workflow, object_info)
        patch_comfy_prompt(prompt, image_name, request, duration, fps)

        update_job(job_id, state="comfyui_queued", progress=35)
        queued = await comfy_json(client, "POST", "/prompt", json={"prompt": prompt, "client_id": job_id})
        prompt_id = queued.get("prompt_id")
        if not prompt_id:
            raise RuntimeError(f"ComfyUI did not return prompt_id: {queued}")

        started = time.time()
        while True:
            if time.time() - started > COMFYUI_TIMEOUT:
                raise RuntimeError(f"ComfyUI job timed out after {COMFYUI_TIMEOUT}s")
            history = await comfy_json(client, "GET", f"/history/{prompt_id}")
            item = history.get(prompt_id)
            if item:
                status = item.get("status", {})
                if status.get("status_str") == "error":
                    raise RuntimeError(json.dumps(status, ensure_ascii=False))
                outputs = item.get("outputs", {})
                for output in outputs.values():
                    videos = output.get("videos") or output.get("gifs") or []
                    for video in videos:
                        filename = video.get("filename")
                        file_type = video.get("type", "output")
                        subfolder = video.get("subfolder", "")
                        if filename:
                            params = {"filename": filename, "type": file_type, "subfolder": subfolder}
                            response = await client.get(f"{COMFYUI_BASE_URL}/view", params=params)
                            response.raise_for_status()
                            output_path.write_bytes(response.content)
                            return
            elapsed = int(time.time() - started)
            update_job(job_id, state="comfyui_rendering", progress=min(75, 35 + elapsed // 12), comfyui_prompt_id=prompt_id)
            await asyncio.sleep(COMFYUI_POLL_INTERVAL)


async def upload_to_storage(job_id: str, output_path: Path, request: I2VRequest) -> dict[str, Any] | None:
    if not VIDEO_STORAGE_BASE_URL or not VIDEO_STORAGE_TOKEN:
        return None
    async with httpx.AsyncClient(timeout=180) as client:
        with output_path.open("rb") as file:
            response = await client.post(
                f"{VIDEO_STORAGE_BASE_URL}/api/v1/videos/upload",
                headers={"Authorization": f"Bearer {VIDEO_STORAGE_TOKEN}"},
                data={
                    "source_task_id": job_id,
                    "kind": "local-i2v",
                    "title": output_path.name,
                    "metadata": json.dumps(
                        {
                            "archived_by": "local-i2v-worker",
                            "backend": BACKEND,
                            "model": request.model,
                            "quality": request.quality,
                            "prompt": request.prompt,
                        },
                        ensure_ascii=False,
                    ),
                },
                files={"file": (output_path.name, file, "video/mp4")},
            )
    response.raise_for_status()
    payload = response.json()
    data = payload.get("data") if isinstance(payload, dict) else None
    if isinstance(data, dict) and PUBLIC_BASE_URL and data.get("id") and data.get("filename"):
        data["public_url"] = f"{PUBLIC_BASE_URL}/media/{data['id']}/{data['filename']}"
    return data


def run_job(job_id: str, request: I2VRequest) -> None:
    init_dirs()
    try:
        update_job(job_id, state="loading_image", progress=10)
        input_image = copy_or_download_image(request, job_id)
        output_path = OUTPUT_DIR / f"{job_id}.mp4"
        duration = safe_duration(request.duration)
        fps = safe_fps(request.fps)
        if BACKEND not in {"ffmpeg", "comfyui"}:
            raise RuntimeError(f"backend {BACKEND!r} is not implemented in this worker yet")
        update_job(job_id, state="rendering", progress=35, backend=BACKEND)
        if BACKEND == "comfyui":
            asyncio.run(render_comfyui(job_id, input_image, output_path, request, duration, fps))
        else:
            render_ffmpeg(input_image, output_path, duration, fps, request.aspect)
        update_job(job_id, state="uploading", progress=80, output_path=str(output_path))
        storage_video = None
        try:
            storage_video = asyncio.run(upload_to_storage(job_id, output_path, request))
        except Exception as exc:
            update_job(job_id, storage_error=str(exc))
        update_job(
            job_id,
            state="complete",
            progress=100,
            output_path=str(output_path),
            storage_video=storage_video,
            completed_at=int(time.time()),
        )
    except Exception as exc:
        update_job(job_id, state="failed", progress=100, error=str(exc), completed_at=int(time.time()))


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "backend": BACKEND,
        "storage_enabled": bool(VIDEO_STORAGE_BASE_URL and VIDEO_STORAGE_TOKEN),
    }


@app.post("/api/v1/i2v")
def create_i2v(request: I2VRequest) -> dict[str, Any]:
    job_id = request.job_id or str(uuid.uuid4())
    with JOBS_LOCK:
        JOBS[job_id] = {
            "job_id": job_id,
            "state": "queued",
            "progress": 0,
            "prompt": request.prompt,
            "model": request.model,
            "quality": request.quality,
            "created_at": int(time.time()),
            "updated_at": int(time.time()),
        }
    Thread(target=run_job, args=(job_id, request), daemon=True).start()
    return {"status": 202, "message": "accepted", "data": JOBS[job_id], "job_id": job_id}


@app.get("/api/v1/i2v/{job_id}")
def get_i2v(job_id: str) -> dict[str, Any]:
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job not found")
    return {"status": 200, "message": "success", "data": job}
