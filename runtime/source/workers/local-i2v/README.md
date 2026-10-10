# Local I2V Worker

This folder documents the worker contract used by `POST /api/v1/local-i2v`.

The gateway intentionally keeps the local model worker separate from the main MoneyPrinterTurbo containers. A bad or memory-heavy video model should not take down the public API, web console, NAS media proxy, or GPT-image fallback path.

## Worker Contract

Configure the gateway with:

```bash
LOCAL_I2V_WORKER_URL=http://127.0.0.1:18085
MPT_HOST_STORAGE_DIR=/home/studio-user/dev/moneyprinterturbo/storage
```

The gateway submits:

```http
POST /api/v1/i2v
Content-Type: application/json
```

```json
{
  "job_id": "gateway-job-id",
  "prompt": "slow cinematic camera push",
  "negative_prompt": "",
  "image_path": "/MoneyPrinterTurbo/storage/local_videos/run/shot-01.png",
  "host_image_path": "/home/studio-user/dev/moneyprinterturbo/storage/local_videos/run/shot-01.png",
  "image_url": null,
  "image_b64": null,
  "aspect": "9:16",
  "duration": 4,
  "fps": 24,
  "seed": null,
  "model": "framepack",
  "quality": "draft"
}
```

The worker should return either a synchronous result or an async job:

```json
{
  "job_id": "worker-job-id",
  "state": "queued",
  "progress": 0
}
```

Status endpoint:

```http
GET /api/v1/i2v/{worker_job_id}
```

Recommended terminal states: `complete`, `failed`.

## Current Windows `ai` Probe

FramePack was cloned to:

```text
/home/studio-user/dev/FramePack
```

Micromamba env:

```text
/home/studio-user/micromamba/envs/framepack
```

Validated:

- RTX 3070 8GB is visible to PyTorch.
- `demo_gradio.py --help` and `demo_gradio_f1.py --help` run.
- A default `demo_gradio.py --server 0.0.0.0 --port 18085` launch downloaded model shards, but pushed WSL memory to roughly 21GB and did not bind the port before Ubuntu WSL had to be terminated.

Next safe options:

- Try a dedicated worker with strict one-job queue and smaller defaults instead of launching Gradio.
- Try ComfyUI + Wan2.1 GGUF low quantization for better quality, accepting very slow generation on 8GB VRAM.
- Use a remote 24GB+ GPU worker for production-quality Jimeng-like motion, while keeping this gateway contract unchanged.

## Included Worker

This directory also contains a small FastAPI worker implementation:

- `app.py`
- `requirements.txt`
- `start.sh`
- `stop.sh`
- `status.sh`

Default backend:

```text
LOCAL_I2V_BACKEND=ffmpeg
```

The ffmpeg backend is only an end-to-end fallback. It creates a short H.264 MP4 from the input image with a slow zoom/pan, then uploads the MP4 to the NAS storage service when `VIDEO_STORAGE_BASE_URL` and `VIDEO_STORAGE_TOKEN` are configured. It is intentionally not presented as the final quality solution; the model backend should replace the internals while keeping the same `/api/v1/i2v` contract.

Deployment path on Windows `ai`:

```text
/home/studio-user/dev/moneyprinterturbo/workers/local-i2v
```

Start:

```bash
cd /home/studio-user/dev/moneyprinterturbo/workers/local-i2v
./start.sh
```

Current deployed worker shape:

- Container: `local-i2v-worker`
- Image: `moneyprinterturbo-api`
- Docker network: `moneyprinterturbo_default`
- Internal health: `http://local-i2v-worker:18085/health`
- Gateway default worker URL: `http://local-i2v-worker:18085`

Because Docker Desktop WSL bind mounts became unreliable after WSL termination, the gateway now sends local images to the worker as `image_b64` when possible. The worker can still accept `image_url` directly, which is the most robust path for independent model workers.

## ComfyUI Backend

The worker also supports an experimental real I2V backend:

```bash
LOCAL_I2V_BACKEND=comfyui
COMFYUI_BASE_URL=http://host.docker.internal:18086
COMFYUI_WORKFLOW_PATH=/home/studio-user/dev/ComfyUI/custom_nodes/ComfyUI-WanVideoWrapper/example_workflows/wanvideo_2_1_14B_I2V_example_03.json
```

On Windows `ai`, ComfyUI is installed at:

```text
/home/studio-user/dev/ComfyUI
```

The current target workflow is Kijai `WanVideoWrapper` Wan2.1 I2V 480p, with the model files placed under ComfyUI model folders:

```text
models/diffusion_models/WanVideo/Wan2_1-I2V-14B-480P_fp8_e4m3fn.safetensors
models/text_encoders/umt5-xxl-enc-fp8_e4m3fn.safetensors
models/vae/wanvideo/Wan2_1_VAE_bf16.safetensors
models/clip_vision/clip_vision_h.safetensors
models/loras/WanVideo/Lightx2v/lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors
```

This mode keeps the public gateway contract unchanged, but generation can be very slow on RTX 3070 8GB. Use short 480p jobs first.
