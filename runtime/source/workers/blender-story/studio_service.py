"""Authenticated V3-only worker, deployed beside the unchanged legacy worker."""
from __future__ import annotations

from contextlib import asynccontextmanager
import os
import json
from pathlib import Path
import queue
import re
import sys
import threading

from fastapi import FastAPI
from studio_jobs import StudioJobs, register_routes


def configure(path: Path) -> None:
    """Read the secret inside the scheduled Python process; never place it in argv."""
    config = json.loads(path.read_text(encoding="utf-8-sig"))
    token = Path(config["tokenFile"]).read_text(encoding="utf-8-sig").strip()
    if not re.fullmatch(r"[a-f0-9]{64}", token):
        raise RuntimeError("Private worker token must be 32 random bytes encoded as hex")
    os.environ.update({
        "STUDIO_WORKER_TOKEN": token, "STUDIO_WORKER_HOST": config.get("host", "127.0.0.1"),
        "STORY_WORKER_PORT": str(config.get("port", 18088)), "STUDIO_RENDER_DIR": config["renderDir"],
        "BLENDER_BIN": config["blenderBin"], "FFMPEG_BIN": config["ffmpegBin"],
        "FFPROBE_BIN": config["ffprobeBin"], "STUDIO_RENDER_ENGINE": config.get("engine", "BLENDER_EEVEE"),
    })
    logs = Path(config["logDir"])
    logs.mkdir(parents=True, exist_ok=True)
    sys.stdout = (logs / "worker-stdout.log").open("a", encoding="utf8", buffering=1)
    sys.stderr = (logs / "worker-stderr.log").open("a", encoding="utf8", buffering=1)


def create_app() -> FastAPI:
    if len(os.getenv("STUDIO_WORKER_TOKEN", "")) < 32:
        raise RuntimeError("STUDIO_WORKER_TOKEN must contain at least 32 characters")
    work: queue.Queue[str | None] = queue.Queue()
    manager = StudioJobs(
        Path(os.getenv("STUDIO_RENDER_DIR", r"D:\studio-v3-data\renders")),
        os.getenv("BLENDER_BIN", r"C:\Program Files\Blender Foundation\Blender 5.2\blender.exe"),
        ffmpeg_bin=os.getenv("FFMPEG_BIN", "ffmpeg"),
        ffprobe_bin=os.getenv("FFPROBE_BIN", "ffprobe"),
        timeout=int(os.getenv("STUDIO_RENDER_TIMEOUT", "3600")),
        enqueue=work.put,
    )

    def render_loop() -> None:
        while True:
            job_id = work.get()
            try:
                if job_id is None:
                    return
                manager.run(job_id)
            finally:
                work.task_done()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        manager.recover()
        worker = threading.Thread(target=render_loop, daemon=True, name="studio-v3-render")
        worker.start()
        yield
        work.put(None)
        worker.join(timeout=5)

    app = FastAPI(title="Blender Studio V3 Worker", version="3.0.0", lifespan=lifespan,
                  docs_url=None, redoc_url=None, openapi_url=None)
    app.state.manager = manager
    register_routes(app, manager)

    @app.get("/health")
    def health():
        return {"status": "ok", "backend": "blender-studio-v3", "queue_depth": work.qsize()}

    return app


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path)
    args = parser.parse_args()
    if args.config:
        configure(args.config)
    import uvicorn
    uvicorn.run(create_app(), host=os.getenv("STUDIO_WORKER_HOST", "127.0.0.1"),
                port=int(os.getenv("STORY_WORKER_PORT", "18088")), log_level="info")
