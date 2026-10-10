import asyncio
import base64
import json
import mimetypes
import os
import re
import subprocess
import time
import tomllib
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse

import httpx
from fastapi import BackgroundTasks, FastAPI, Header, HTTPException, Request
from fastapi.responses import Response, StreamingResponse
from starlette.background import BackgroundTask


UPSTREAM = os.getenv("MPT_UPSTREAM_URL", "http://api:8080").rstrip("/")
PUBLIC_BASE_URL = os.getenv("PUBLIC_BASE_URL", "").rstrip("/")
VIDEO_API_TOKEN = os.getenv("VIDEO_API_TOKEN", "")
TIMEOUT_SECONDS = float(os.getenv("MPT_GATEWAY_TIMEOUT_SECONDS", "600"))
VIDEO_STORAGE_BASE_URL = os.getenv("VIDEO_STORAGE_BASE_URL", "").rstrip("/")
VIDEO_STORAGE_TOKEN = os.getenv("VIDEO_STORAGE_TOKEN", "")
MPT_CONFIG_PATH = Path(os.getenv("MPT_CONFIG_PATH", "/MoneyPrinterTurbo/config.toml"))
MPT_CONFIG_FALLBACK_PATH = Path(os.getenv("MPT_CONFIG_FALLBACK_PATH", "/app/config.toml"))
LOCAL_VIDEO_DIR = Path(os.getenv("MPT_LOCAL_VIDEO_DIR", "/MoneyPrinterTurbo/storage/local_videos"))
MPT_HOST_STORAGE_DIR = os.getenv("MPT_HOST_STORAGE_DIR", "")
LOCAL_I2V_WORKER_URL = os.getenv("LOCAL_I2V_WORKER_URL", "http://local-i2v-worker:18085").rstrip("/")
IMAGE_MODEL = os.getenv("IMAGE_OPENAI_MODEL", "gpt-image-1.5")
IMAGE_FALLBACK_MODELS = [
    item.strip()
    for item in os.getenv("IMAGE_OPENAI_FALLBACK_MODELS", "gpt-image-1").split(",")
    if item.strip()
]
IMAGE_GENERATION_MODELS = list(dict.fromkeys([IMAGE_MODEL, *IMAGE_FALLBACK_MODELS]))
IMAGE_OPENAI_QUALITY = os.getenv("IMAGE_OPENAI_QUALITY", "low")
IMAGE_OPENAI_OUTPUT_FORMAT = os.getenv("IMAGE_OPENAI_OUTPUT_FORMAT", "jpeg")
IMAGE_OPENAI_OUTPUT_COMPRESSION = int(os.getenv("IMAGE_OPENAI_OUTPUT_COMPRESSION", "70") or "70")
IMAGE_GENERATION_RETRIES = max(1, int(os.getenv("IMAGE_GENERATION_RETRIES", "3") or "3"))
IMAGE_VIDEO_BACKEND = os.getenv("IMAGE_VIDEO_BACKEND", "gemini").lower()
GEMINI_VIDEO_BASE_URL = os.getenv("GEMINI_VIDEO_BASE_URL", "https://api.yundongyl.cn/v1beta").rstrip("/")
GEMINI_VIDEO_MODEL = os.getenv("GEMINI_VIDEO_MODEL", "veo-3.1-fast-generate-preview")
GEMINI_VIDEO_API_KEY = os.getenv("GEMINI_VIDEO_API_KEY") or os.getenv("GEMINI_API_KEY") or ""
GEMINI_VIDEO_RESOLUTION = os.getenv("GEMINI_VIDEO_RESOLUTION", "720p")
GEMINI_VIDEO_PERSON_GENERATION = os.getenv("GEMINI_VIDEO_PERSON_GENERATION", "allow_adult")
GEMINI_VIDEO_POLL_INTERVAL = float(os.getenv("GEMINI_VIDEO_POLL_INTERVAL", "10"))
GEMINI_VIDEO_TIMEOUT_SECONDS = float(os.getenv("GEMINI_VIDEO_TIMEOUT_SECONDS", "900"))
IMAGE_SIZE_BY_ASPECT = {
    "9:16": "1024x1536",
    "16:9": "1536x1024",
    "1:1": "1024x1024",
    "4:5": "1024x1536",
    "3:2": "1536x1024",
}
IMAGE_OUTPUT_DIR = Path(os.getenv("IMAGE_OUTPUT_DIR", str(LOCAL_VIDEO_DIR / "generated_images")))
IMAGE_JOBS: dict[str, dict[str, Any]] = {}
LOCAL_I2V_JOBS: dict[str, dict[str, Any]] = {}
FREE_I2V_JOBS: dict[str, dict[str, Any]] = {}
FREE_I2V_DISCOVERY_TIMEOUT = float(os.getenv("FREE_I2V_DISCOVERY_TIMEOUT", "12"))
FREE_I2V_MAX_CANDIDATES = int(os.getenv("FREE_I2V_MAX_CANDIDATES", "10"))
FREE_I2V_SEARCH_ENABLED = os.getenv("FREE_I2V_SEARCH_ENABLED", "1").lower() not in {"0", "false", "no"}
FREE_I2V_GRADIO_SPACE = os.getenv("FREE_I2V_GRADIO_SPACE", "preSalesAIAutomation/imagetovideo")
FREE_I2V_GRADIO_API = os.getenv("FREE_I2V_GRADIO_API", "/generate_video_sync")
FREE_I2V_GRADIO_STEPS = int(os.getenv("FREE_I2V_GRADIO_STEPS", "6"))
FREE_I2V_GRADIO_DURATION = int(os.getenv("FREE_I2V_GRADIO_DURATION", "4"))
FREE_I2V_MIN_DURATION = float(os.getenv("FREE_I2V_MIN_DURATION", "2"))
FREE_I2V_MAX_DURATION = float(os.getenv("FREE_I2V_MAX_DURATION", "8"))
FREE_I2V_SEARCH_QUERIES = [
    item.strip()
    for item in os.getenv(
        "FREE_I2V_SEARCH_QUERIES",
        "free AI image to video generator no login upload image no watermark;"
        '"image to video" "no signup" "upload image" AI;'
        '"free image to video" "no sign up" AI generator',
    ).split(";")
    if item.strip()
]
FREE_I2V_SEED_PROVIDERS = [
    {"name": "IMGtoVideo.ai / Hugging Face Space", "url": "https://www.imgtovideo.ai/"},
    {"name": "Vider.ai", "url": "https://vider.ai/"},
    {"name": "LoreMotion", "url": "https://loremotion.com/generate/"},
    {"name": "IMGtoVideo.ai", "url": "https://www.imgtovideo.ai/"},
    {"name": "Free.ai Image to Video", "url": "https://free.ai/video/image-to-video/"},
    {"name": "Creen AI", "url": "https://www.creen.ai/image-to-video"},
    {"name": "VideoAii", "url": "https://videoaii.com/"},
    {"name": "CREATUS AI", "url": "https://creatus.ai/image-animation-image-to-video"},
    {"name": "FluxNote", "url": "https://fluxnote.io/tools/ai-image-to-video-free"},
    {"name": "Clipin", "url": "https://clipin.ai/"},
]

app = FastAPI(
    title="MoneyPrinterTurbo Video API",
    version="1.0.0",
    description="Authenticated gateway for MoneyPrinterTurbo video-generation tasks.",
)


def require_token(authorization: str | None) -> None:
    if not VIDEO_API_TOKEN:
        raise HTTPException(status_code=503, detail="VIDEO_API_TOKEN is not configured")
    expected = f"Bearer {VIDEO_API_TOKEN}"
    if authorization != expected:
        raise HTTPException(status_code=401, detail="invalid or missing bearer token")


def config_app() -> dict[str, Any]:
    for path in (MPT_CONFIG_PATH, MPT_CONFIG_FALLBACK_PATH):
        if not path.exists() or path.stat().st_size <= 0:
            continue
        with path.open("rb") as file:
            return tomllib.load(file).get("app", {})
    return {}


def safe_float(value: Any, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def clamp_duration(value: Any, default: float, minimum: float, maximum: float) -> float:
    duration = safe_float(value, default)
    return max(minimum, min(duration, maximum))


def payload_duration(payload: dict[str, Any], default: float, minimum: float, maximum: float) -> float:
    return clamp_duration(payload.get("duration") or payload.get("video_clip_duration"), default, minimum, maximum)


def image_client_config() -> tuple[str, str]:
    app_config = config_app()
    base_url = os.getenv("IMAGE_OPENAI_BASE_URL") or app_config.get("openai_base_url") or ""
    api_key = os.getenv("IMAGE_OPENAI_API_KEY") or app_config.get("openai_api_key") or ""
    if not base_url or not api_key:
        raise HTTPException(status_code=503, detail="image generation config is missing")
    return base_url.rstrip("/"), api_key


def image_extension() -> str:
    value = (IMAGE_OPENAI_OUTPUT_FORMAT or "png").lower()
    if value == "jpeg":
        return "jpg"
    if value in {"jpg", "png", "webp"}:
        return value
    return "png"


def image_mime_type(filename: str | None = None) -> str:
    value = (filename or "").lower()
    if value.startswith("image/"):
        return "image/jpeg" if value == "image/jpg" else value
    ext = value.rsplit(".", 1)[-1] if filename and "." in filename else IMAGE_OPENAI_OUTPUT_FORMAT.lower()
    if ext in {"jpg", "jpeg"}:
        return "image/jpeg"
    if ext == "webp":
        return "image/webp"
    return "image/png"


def image_public_url(image_id: str, filename: str) -> str:
    base = PUBLIC_BASE_URL or "/api/v1"
    return f"{base}/generated-images/{image_id}/{filename}"


def standalone_image_prompt(payload: dict[str, Any], index: int, count: int) -> str:
    prompt = str(payload.get("prompt") or payload.get("image_prompt") or payload.get("video_subject") or "").strip()
    if not prompt:
        return ""
    lines = [
        "Create one production-ready visual asset.",
        f"Brief: {prompt}",
    ]
    for key, label in (
        ("style", "Visual style"),
        ("visual_style", "Visual style"),
        ("brand", "Brand rules"),
        ("brand_kit", "Brand rules"),
        ("format", "Asset format"),
        ("asset_type", "Asset format"),
        ("audience", "Audience"),
    ):
        value = str(payload.get(key) or "").strip()
        if value:
            lines.append(f"{label}: {value}")
    if count > 1:
        lines.append(f"Variation {index} of {count}: keep the same core idea but change composition, staging, and detail.")
    lines.append("Keep composition coherent, text legible when requested, no watermark, no UI chrome, no extra logos unless specified.")
    negative = str(payload.get("negative_prompt") or "").strip()
    if negative:
        lines.append(f"Avoid: {negative}")
    return "\n".join(lines)


def decode_reference_image(value: str) -> tuple[bytes, str]:
    raw = str(value or "").strip()
    match = re.match(r"^data:(image/[a-z0-9.+-]+);base64,(.+)$", raw, flags=re.I | re.S)
    if match:
        return base64.b64decode(match.group(2)), image_mime_type(match.group(1))
    return base64.b64decode(raw), "image/png"


def extract_reference_images(payload: dict[str, Any]) -> list[dict[str, Any]]:
    candidates: list[Any] = []
    if payload.get("image_b64"):
        candidates.append({"b64": payload.get("image_b64"), "filename": payload.get("image_filename")})
    if isinstance(payload.get("reference_images"), list):
        candidates.extend(payload["reference_images"])
    refs: list[dict[str, Any]] = []
    for item in candidates[:4]:
        if isinstance(item, str):
            item = {"b64": item}
        if not isinstance(item, dict):
            continue
        raw = item.get("b64") or item.get("data_url") or item.get("data")
        if not raw:
            continue
        try:
            data, mime_type = decode_reference_image(str(raw))
        except Exception:
            continue
        if not data:
            continue
        refs.append(
            {
                "data": data,
                "mime_type": str(item.get("mime_type") or item.get("mimeType") or mime_type),
                "filename": Path(str(item.get("filename") or item.get("name") or f"reference-{len(refs) + 1}.png")).name,
            }
        )
    return refs


async def generate_single_standalone_image(
    client: httpx.AsyncClient,
    prompt: str,
    aspect: str,
    out_path: Path,
    references: list[dict[str, Any]],
) -> dict[str, Any]:
    base_url, api_key = image_client_config()
    last_error: Exception | None = None
    headers = {"Authorization": f"Bearer {api_key}"}
    for attempt in range(IMAGE_GENERATION_RETRIES):
        model = IMAGE_GENERATION_MODELS[min(attempt, len(IMAGE_GENERATION_MODELS) - 1)] or IMAGE_MODEL
        try:
            if references:
                ref = references[0]
                files = {"image": (ref["filename"], ref["data"], ref["mime_type"])}
                data = {
                    "model": model,
                    "prompt": prompt,
                    "size": IMAGE_SIZE_BY_ASPECT.get(aspect, "1024x1024"),
                    "n": "1",
                }
                if IMAGE_OPENAI_QUALITY:
                    data["quality"] = IMAGE_OPENAI_QUALITY
                if IMAGE_OPENAI_OUTPUT_FORMAT:
                    data["output_format"] = IMAGE_OPENAI_OUTPUT_FORMAT
                if IMAGE_OPENAI_OUTPUT_COMPRESSION > 0:
                    data["output_compression"] = str(IMAGE_OPENAI_OUTPUT_COMPRESSION)
                response = await client.post(f"{base_url}/images/edits", headers=headers, data=data, files=files, timeout=300)
            else:
                body: dict[str, Any] = {
                    "model": model,
                    "prompt": prompt,
                    "size": IMAGE_SIZE_BY_ASPECT.get(aspect, "1024x1024"),
                    "n": 1,
                }
                if IMAGE_OPENAI_QUALITY:
                    body["quality"] = IMAGE_OPENAI_QUALITY
                if IMAGE_OPENAI_OUTPUT_FORMAT:
                    body["output_format"] = IMAGE_OPENAI_OUTPUT_FORMAT
                if IMAGE_OPENAI_OUTPUT_COMPRESSION > 0:
                    body["output_compression"] = IMAGE_OPENAI_OUTPUT_COMPRESSION
                response = await client.post(f"{base_url}/images/generations", headers=headers, json=body, timeout=300)
            response.raise_for_status()
            item = (response.json().get("data") or [None])[0]
            if not item:
                raise RuntimeError("image generation returned no data")
            if item.get("b64_json"):
                out_path.write_bytes(base64.b64decode(item["b64_json"]))
            elif item.get("url"):
                image_response = await client.get(item["url"], timeout=60)
                image_response.raise_for_status()
                out_path.write_bytes(image_response.content)
            else:
                raise RuntimeError("image generation returned unsupported payload")
            return {"model": model, "mode": "edit" if references else "generation", "mime_type": image_mime_type(out_path.name), "size": out_path.stat().st_size}
        except Exception as exc:
            last_error = exc
            if references:
                references = []
                continue
            await asyncio.sleep(min(30, 3 * (attempt + 1) * (attempt + 1)))
    raise RuntimeError(str(last_error or "image generation failed"))


async def create_standalone_images(payload: dict[str, Any]) -> dict[str, Any]:
    prompt = str(payload.get("prompt") or payload.get("image_prompt") or payload.get("video_subject") or "").strip()
    if not prompt:
        raise HTTPException(status_code=422, detail="prompt is required")
    aspect = str(payload.get("aspect_ratio") or payload.get("aspect") or payload.get("video_aspect") or "1:1")
    count = max(1, min(4, int(payload.get("n") or payload.get("count") or payload.get("image_count") or 1)))
    image_id = f"img-{uuid.uuid4()}"
    run_dir = IMAGE_OUTPUT_DIR / image_id
    run_dir.mkdir(parents=True, exist_ok=True)
    references = extract_reference_images(payload)
    images: list[dict[str, Any]] = []
    errors: list[str] = []
    async with httpx.AsyncClient() as client:
        for index in range(1, count + 1):
            filename = f"image-{index:02d}.{image_extension()}"
            out_path = run_dir / filename
            image_prompt_text = standalone_image_prompt(payload, index, count)
            try:
                result = await generate_single_standalone_image(client, image_prompt_text, aspect, out_path, references[:])
                public_url = image_public_url(image_id, filename)
                images.append(
                    {
                        "id": f"{image_id}-{index}",
                        "image_id": image_id,
                        "index": index,
                        "filename": filename,
                        "prompt": image_prompt_text,
                        "aspect_ratio": aspect,
                        "model": result["model"],
                        "mode": result["mode"],
                        "reference_mode": "edit" if references and result["mode"] == "edit" else ("fallback_generation" if references else "none"),
                        "mime_type": result["mime_type"],
                        "size": result["size"],
                        "public_url": public_url,
                        "download_url": public_url,
                    }
                )
            except Exception as exc:
                errors.append(f"image-{index}: {exc}")
    if not images:
        raise HTTPException(status_code=502, detail="; ".join(errors) or "no images generated")
    return {
        "job_id": image_id,
        "state": "complete",
        "progress": 100,
        "prompt": prompt,
        "aspect_ratio": aspect,
        "count": count,
        "image_model": IMAGE_MODEL,
        "image_fallback_models": IMAGE_FALLBACK_MODELS,
        "image_quality": IMAGE_OPENAI_QUALITY,
        "image_output_format": IMAGE_OPENAI_OUTPUT_FORMAT,
        "image_output_compression": IMAGE_OPENAI_OUTPUT_COMPRESSION,
        "reference_count": len(references),
        "images": images,
        "errors": errors,
    }


def gemini_video_client_config() -> tuple[str, str]:
    app_config = config_app()
    base_url = GEMINI_VIDEO_BASE_URL or app_config.get("gemini_base_url") or "https://api.yundongyl.cn/v1beta"
    api_key = GEMINI_VIDEO_API_KEY or app_config.get("gemini_api_key") or ""
    if not base_url or not api_key:
        raise HTTPException(status_code=503, detail="Gemini video config is missing")
    return base_url.rstrip("/"), api_key


def normalize_veo_duration(value: Any, resolution: str = "720p") -> int:
    requested = safe_float(value, 8)
    if resolution in {"1080p", "4k"}:
        return 8
    for allowed in (4, 6, 8):
        if requested <= allowed:
            return allowed
    return 8


def normalize_script(payload: Any) -> str:
    data = payload.get("data") if isinstance(payload, dict) else payload
    if isinstance(data, dict):
        value = data.get("video_script") or data.get("script")
        if value:
            return str(value)
    if isinstance(data, str):
        return data
    return ""


def split_script_to_shots(script: str, limit: int) -> list[str]:
    parts = [item.strip() for item in re.split(r"[。！？!?；;\n]+", script) if item.strip()]
    if not parts:
        return [script.strip()] if script.strip() else []
    if len(parts) == limit:
        return parts
    if len(parts) < limit:
        text = "。".join(parts)
        if len(text) <= 24:
            while parts and len(parts) < limit:
                parts.append(f"{parts[-1]}，动作完成后的结尾关键帧")
            return parts
        chunk_size = max(24, (len(text) + limit - 1) // limit)
        chunks = [text[index:index + chunk_size].strip("，,。 ") for index in range(0, len(text), chunk_size)]
        chunks = [chunk for chunk in chunks if chunk][:limit]
        while chunks and len(chunks) < limit:
            chunks.append(f"{chunks[-1]}，动作完成后的结尾关键帧")
        return chunks
    chunk_size = max(1, round(len(parts) / limit))
    shots = []
    for index in range(0, len(parts), chunk_size):
        shots.append("。".join(parts[index:index + chunk_size]))
        if len(shots) >= limit:
            break
    while shots and len(shots) < limit:
        shots.append(f"{shots[-1]}，动作完成后的结尾关键帧")
    return shots


def compact_text(value: str, limit: int = 8000) -> str:
    value = re.sub(r"<script\b[^<]*(?:(?!</script>)<[^<]*)*</script>", " ", value, flags=re.I)
    value = re.sub(r"<style\b[^<]*(?:(?!</style>)<[^<]*)*</style>", " ", value, flags=re.I)
    value = re.sub(r"<[^>]+>", " ", value)
    value = re.sub(r"\s+", " ", value).strip()
    return value[:limit]


def provider_name_from_url(url: str) -> str:
    host = urlparse(url).netloc.lower().removeprefix("www.")
    return host.split(":")[0] or url


def normalize_candidate_url(url: str) -> str | None:
    if not url:
        return None
    url = unquote(url)
    parsed = urlparse(url)
    if parsed.netloc.endswith("duckduckgo.com") and parsed.path.startswith("/l/"):
        target = parse_qs(parsed.query).get("uddg", [""])[0]
        url = unquote(target)
        parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return None
    return f"{parsed.scheme}://{parsed.netloc}{parsed.path}".rstrip("/") or url


def extract_duckduckgo_urls(html: str) -> list[str]:
    urls: list[str] = []
    for match in re.finditer(r'href="([^"]+)"', html):
        href = match.group(1).replace("&amp;", "&")
        normalized = normalize_candidate_url(href)
        if not normalized:
            continue
        host = urlparse(normalized).netloc.lower()
        if "duckduckgo.com" in host or "bing.com" in host or "google.com" in host:
            continue
        urls.append(normalized)
    return urls


def score_free_i2v_page(url: str, html: str, source: str, claimed_name: str | None = None) -> dict[str, Any]:
    text = compact_text(html)
    lower = text.lower()
    title_match = re.search(r"<title[^>]*>(.*?)</title>", html, flags=re.I | re.S)
    title = compact_text(title_match.group(1), 160) if title_match else claimed_name or provider_name_from_url(url)
    checks = {
        "mentions_image_to_video": any(term in lower for term in ["image to video", "image-to-video", "photo to video", "animate photo", "animate image"]),
        "mentions_upload": any(term in lower for term in ["upload", "drag", "drop", "choose file", "starter image", "reference image"]),
        "claims_free": any(term in lower for term in ["free", "no cost", "0 dollars", "daily free", "free tier"]),
        "claims_no_login": any(term in lower for term in ["no login", "no sign-up", "no signup", "no sign up", "no account", "without creating an account"]),
        "claims_download": any(term in lower for term in ["download", "mp4", "video ready", "output"]),
        "mentions_watermark": "watermark" in lower,
        "mentions_api": "api" in lower,
        "mentions_captcha": "captcha" in lower or "cloudflare" in lower,
        "mentions_login": any(term in lower for term in ["login", "log in", "sign in", "sign up", "create account"]),
        "mentions_paid": any(term in lower for term in ["pricing", "upgrade", "buy tokens", "paid", "subscription", "pro version", "premium"]),
    }
    score = 0
    score += 22 if checks["mentions_image_to_video"] else 0
    score += 18 if checks["mentions_upload"] else 0
    score += 18 if checks["claims_free"] else 0
    score += 22 if checks["claims_no_login"] else 0
    score += 8 if checks["claims_download"] else 0
    score += 4 if checks["mentions_watermark"] else 0
    score -= 20 if checks["mentions_captcha"] else 0
    if checks["mentions_login"] and not checks["claims_no_login"]:
        score -= 18
    if checks["mentions_paid"] and not checks["claims_free"]:
        score -= 12
    if checks["mentions_paid"] and checks["claims_free"]:
        score -= 4
    status = "likely_free_no_login" if score >= 60 else "possible" if score >= 35 else "weak"
    evidence_terms = [
        label
        for label, present in checks.items()
        if present and label in {"claims_free", "claims_no_login", "mentions_upload", "claims_download", "mentions_image_to_video"}
    ]
    return {
        "name": claimed_name or title or provider_name_from_url(url),
        "url": url,
        "score": score,
        "status": status,
        "source": source,
        "checks": checks,
        "evidence": evidence_terms,
        "note": (
            "candidate only: automatic execution requires a verified site adapter; no login/captcha bypass is attempted"
        ),
    }


async def fetch_text(client: httpx.AsyncClient, url: str) -> str:
    response = await client.get(
        url,
        follow_redirects=True,
        headers={
            "User-Agent": "Mozilla/5.0 compatible ai-video-provider-discovery/1.0",
            "Accept": "text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.5",
        },
    )
    response.raise_for_status()
    return response.text


async def search_free_i2v_candidates(client: httpx.AsyncClient) -> list[str]:
    if not FREE_I2V_SEARCH_ENABLED:
        return []
    urls: list[str] = []
    for query in FREE_I2V_SEARCH_QUERIES[:4]:
        try:
            html = await fetch_text(client, f"https://duckduckgo.com/html/?{httpx.QueryParams({'q': query})}")
            urls.extend(extract_duckduckgo_urls(html))
        except Exception:
            continue
    return urls


async def discover_free_i2v_providers() -> dict[str, Any]:
    timeout = httpx.Timeout(FREE_I2V_DISCOVERY_TIMEOUT, connect=5)
    discovered_at = int(time.time())
    provider_by_url: dict[str, dict[str, str]] = {}
    for item in FREE_I2V_SEED_PROVIDERS:
        normalized = normalize_candidate_url(item["url"])
        if normalized:
            provider_by_url[normalized] = {"name": item["name"], "source": "seed"}
    async with httpx.AsyncClient(timeout=timeout) as client:
        for url in await search_free_i2v_candidates(client):
            provider_by_url.setdefault(url, {"name": provider_name_from_url(url), "source": "search"})

        candidates: list[dict[str, Any]] = []
        for url, meta in list(provider_by_url.items())[:24]:
            try:
                html = await fetch_text(client, url)
                candidates.append(score_free_i2v_page(url, html, meta["source"], meta.get("name")))
            except Exception as exc:
                candidates.append(
                    {
                        "name": meta.get("name") or provider_name_from_url(url),
                        "url": url,
                        "score": 0,
                        "status": "unreachable",
                        "source": meta["source"],
                        "error": str(exc),
                    }
                )
    candidates.sort(key=lambda item: item.get("score", 0), reverse=True)
    usable = [item for item in candidates if item.get("status") in {"likely_free_no_login", "possible"}]
    return {
        "discovered_at": discovered_at,
        "search_enabled": FREE_I2V_SEARCH_ENABLED,
        "candidates": candidates[:FREE_I2V_MAX_CANDIDATES],
        "usable_count": len(usable),
        "execution": {
            "mode": "manual_or_adapter",
            "message": "Free no-login sites are discovered live. Automatic generation is enabled only for verified adapters; login/captcha bypass is not attempted.",
        },
    }


def image_prompt(subject: str, shot: str, aspect: str) -> str:
    orientation = "vertical 9:16" if aspect == "9:16" else "horizontal 16:9" if aspect == "16:9" else "square 1:1"
    return (
        f"Create a realistic cinematic {orientation} image for a short video storyboard. "
        f"Topic: {subject}. Shot: {shot}. "
        "Use concrete visual objects and actions, coherent lighting, clean composition, no captions, no UI text, no watermarks."
    )


def host_storage_path(container_path: str) -> str | None:
    if not MPT_HOST_STORAGE_DIR:
        return None
    marker = "/MoneyPrinterTurbo/storage"
    if not container_path.startswith(marker):
        return None
    suffix = container_path.removeprefix(marker).lstrip("/")
    return str(Path(MPT_HOST_STORAGE_DIR) / suffix)


async def create_script_with_upstream(client: httpx.AsyncClient, payload: dict[str, Any]) -> str:
    script_response = await client.post(
        f"{UPSTREAM}/api/v1/scripts",
        json={
            "video_subject": payload.get("video_subject", ""),
            "video_language": payload.get("video_language", "zh-CN"),
            "paragraph_number": payload.get("paragraph_number", 1),
        },
    )
    script_response.raise_for_status()
    return normalize_script(script_response.json())


async def generate_storyboard_images(
    client: httpx.AsyncClient,
    subject: str,
    script: str,
    aspect: str,
    image_count: int,
    job_id: str | None = None,
) -> tuple[str, list[dict[str, Any]]]:
    base_url, api_key = image_client_config()
    run_id = f"gpt-image-{uuid.uuid4()}"
    run_dir = LOCAL_VIDEO_DIR / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    shots = split_script_to_shots(script, max(1, min(image_count, 8)))[:image_count]
    materials: list[dict[str, Any]] = []
    errors: list[str] = []
    for index, shot in enumerate(shots, start=1):
        if job_id and job_id in IMAGE_JOBS:
            IMAGE_JOBS[job_id].update(
                {
                    "state": "generating_images",
                    "progress": 30 + int((index - 1) / max(len(shots), 1) * 45),
                    "image_index": index,
                    "image_total": len(shots),
                    "image_errors": errors,
                }
            )
        prompt = image_prompt(subject, shot, aspect)
        try:
            response = await client.post(
                f"{base_url}/images/generations",
                headers={"Authorization": f"Bearer {api_key}"},
                json={
                    "model": IMAGE_MODEL,
                    "prompt": prompt,
                    "size": IMAGE_SIZE_BY_ASPECT.get(aspect, "1024x1536"),
                    "n": 1,
                },
                timeout=180,
            )
            response.raise_for_status()
            data = response.json().get("data") or []
            if not data:
                raise RuntimeError(f"image generation returned no data for shot {index}")
            item = data[0]
            image_path = run_dir / f"shot-{index:02d}.png"
            if item.get("b64_json"):
                image_path.write_bytes(base64.b64decode(item["b64_json"]))
            elif item.get("url"):
                image_response = await client.get(item["url"], timeout=60)
                image_response.raise_for_status()
                image_path.write_bytes(image_response.content)
            else:
                raise RuntimeError(f"image generation returned unsupported payload for shot {index}")
            materials.append(
                {
                    "provider": "gpt-image",
                    "url": str(image_path),
                    "duration": 0,
                    "shot": shot,
                    "prompt": prompt,
                }
            )
        except Exception as exc:
            errors.append(f"shot-{index}: {exc}")
            continue
    if not materials:
        raise RuntimeError("; ".join(errors) or "no storyboard images generated")
    if job_id and job_id in IMAGE_JOBS:
        IMAGE_JOBS[job_id]["image_errors"] = errors
    return run_id, materials


def media_bytes_data(path: str) -> dict[str, Any]:
    image_path = Path(path)
    mime_type = mimetypes.guess_type(str(image_path))[0] or "image/png"
    return {
        "bytesBase64Encoded": base64.b64encode(image_path.read_bytes()).decode("ascii"),
        "mimeType": mime_type,
    }


def extract_gemini_video_uri(payload: Any) -> str | None:
    if isinstance(payload, dict):
        video = payload.get("video")
        if isinstance(video, dict):
            uri = video.get("uri") or video.get("downloadUri")
            if isinstance(uri, str) and uri:
                return uri
        for key in ("uri", "downloadUri", "fileUri"):
            value = payload.get(key)
            if isinstance(value, str) and value.startswith(("http://", "https://")):
                return value
        for value in payload.values():
            found = extract_gemini_video_uri(value)
            if found:
                return found
    if isinstance(payload, list):
        for item in payload:
            found = extract_gemini_video_uri(item)
            if found:
                return found
    return None


async def submit_gemini_video_operation(
    client: httpx.AsyncClient,
    prompt: str,
    image_path: str,
    last_image_path: str | None,
    aspect: str,
    duration_seconds: int,
) -> tuple[str, dict[str, Any]]:
    base_url, api_key = gemini_video_client_config()
    instance: dict[str, Any] = {
        "prompt": prompt,
        "image": media_bytes_data(image_path),
    }
    if last_image_path:
        instance["lastFrame"] = media_bytes_data(last_image_path)
    parameters: dict[str, Any] = {
        "aspectRatio": "9:16" if aspect == "9:16" else "16:9",
        "durationSeconds": duration_seconds,
        "resolution": GEMINI_VIDEO_RESOLUTION,
        "personGeneration": GEMINI_VIDEO_PERSON_GENERATION,
    }
    response = await client.post(
        f"{base_url}/models/{GEMINI_VIDEO_MODEL}:predictLongRunning",
        headers={
            "x-goog-api-key": api_key,
            "Content-Type": "application/json",
        },
        json={
            "instances": [instance],
            "parameters": parameters,
        },
        timeout=120,
    )
    response.raise_for_status()
    operation = response.json()
    operation_name = operation.get("name")
    if not operation_name:
        raise RuntimeError(f"Gemini video operation returned no name: {operation}")
    return operation_name, operation


async def poll_gemini_video_operation(client: httpx.AsyncClient, operation_name: str) -> dict[str, Any]:
    base_url, api_key = gemini_video_client_config()
    deadline = time.time() + GEMINI_VIDEO_TIMEOUT_SECONDS
    last_status: dict[str, Any] = {}
    while time.time() < deadline:
        response = await client.get(
            f"{base_url}/{operation_name.lstrip('/')}",
            headers={"x-goog-api-key": api_key},
            timeout=60,
        )
        response.raise_for_status()
        last_status = response.json()
        if last_status.get("done") is True:
            if last_status.get("error"):
                raise RuntimeError(f"Gemini video generation failed: {last_status['error']}")
            return last_status
        await asyncio.sleep(GEMINI_VIDEO_POLL_INTERVAL)
    raise RuntimeError(f"Gemini video generation timed out: {last_status}")


async def download_gemini_video(
    client: httpx.AsyncClient,
    video_uri: str,
    output_path: Path,
    operation_name: str | None = None,
) -> Path:
    base_url, api_key = gemini_video_client_config()
    google_prefix = "https://generativelanguage.googleapis.com/v1beta/"
    download_uri = video_uri
    if video_uri.startswith(google_prefix):
        relative = video_uri[len(google_prefix):].lstrip("/")
        download_uri = f"{base_url}/{relative}"
        if operation_name:
            separator = "&" if "?" in download_uri else "?"
            download_uri = f"{download_uri}{separator}operation={operation_name}"
    response = await client.get(
        download_uri,
        headers={"x-goog-api-key": api_key},
        follow_redirects=True,
        timeout=180,
    )
    response.raise_for_status()
    output_path.write_bytes(response.content)
    return output_path


async def transcode_for_mobile(input_path: Path, output_path: Path) -> Path:
    def run_ffmpeg() -> Path:
        try:
            result = subprocess.run(
                [
                    "ffmpeg",
                    "-y",
                    "-i",
                    str(input_path),
                    "-c:v",
                    "libx264",
                    "-pix_fmt",
                    "yuv420p",
                    "-c:a",
                    "aac",
                    "-movflags",
                    "+faststart",
                    str(output_path),
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
            if result.returncode == 0 and output_path.exists():
                return output_path
        except Exception:
            pass
        return input_path

    return await asyncio.to_thread(run_ffmpeg)


async def run_image_video_job(job_id: str, payload: dict[str, Any]) -> None:
    IMAGE_JOBS[job_id].update({"state": "generating_script", "progress": 10})
    try:
        subject = str(payload.get("video_subject") or "").strip()
        aspect = str(payload.get("video_aspect") or "9:16")
        backend = str(payload.get("backend") or IMAGE_VIDEO_BACKEND or "gemini").lower()
        default_image_count = 2 if backend in {"gemini", "veo", "relay-gemini", "gpt-gemini"} else 4
        image_count = int(payload.get("image_count") or default_image_count)
        image_count = max(1, min(image_count, 8))
        timeout = httpx.Timeout(max(TIMEOUT_SECONDS, 900), connect=15)
        async with httpx.AsyncClient(timeout=timeout) as client:
            script = str(payload.get("video_script") or "").strip()
            if not script:
                script = await create_script_with_upstream(client, payload)
            if not script:
                raise RuntimeError("failed to generate video script")
            IMAGE_JOBS[job_id].update({"state": "generating_images", "progress": 30, "script": script})
            if backend in {"gemini", "veo", "relay-gemini", "gpt-gemini"}:
                image_count = 2
            run_id, materials = await generate_storyboard_images(
                client=client,
                subject=subject,
                script=script,
                aspect=aspect,
                image_count=image_count,
                job_id=job_id,
            )
            IMAGE_JOBS[job_id].update(
                {
                    "state": "creating_video_task",
                    "progress": 80,
                    "run_id": run_id,
                    "materials": [
                        {
                            "url": item["url"],
                            "shot": item["shot"],
                            "prompt": item["prompt"],
                        }
                        for item in materials
                    ],
                    "backend": backend,
                }
            )
            if backend in {"gemini", "veo", "relay-gemini", "gpt-gemini"}:
                requested_duration = payload.get("duration") or payload.get("video_clip_duration")
                duration_seconds = normalize_veo_duration(requested_duration, GEMINI_VIDEO_RESOLUTION)
                first_material = materials[0]
                video_prompt = str(payload.get("prompt") or first_material.get("shot") or script or subject).strip()
                if subject and subject not in video_prompt:
                    video_prompt = f"{subject}. {video_prompt}"
                video_prompt = (
                    f"{video_prompt}\n"
                    "Generate clear real subject motion and action. Keep identity and composition stable. "
                    "Avoid text overlays, subtitles, UI, logos, and watermark-like marks."
                )
                IMAGE_JOBS[job_id].update(
                    {
                        "state": "generating_gemini_video",
                        "progress": 65,
                        "video_prompt": video_prompt,
                        "requested_duration": requested_duration,
                        "duration": duration_seconds,
                        "video_model": GEMINI_VIDEO_MODEL,
                        "video_base_url": GEMINI_VIDEO_BASE_URL,
                    }
                )
                operation_name, operation = await submit_gemini_video_operation(
                    client=client,
                    prompt=video_prompt,
                    image_path=str(first_material["url"]),
                    last_image_path=str(materials[1]["url"]) if len(materials) > 1 else None,
                    aspect=aspect,
                    duration_seconds=duration_seconds,
                )
                IMAGE_JOBS[job_id].update(
                    {
                        "state": "polling_gemini_video",
                        "progress": 75,
                        "operation_name": operation_name,
                        "operation": operation,
                    }
                )
                final_operation = await poll_gemini_video_operation(client, operation_name)
                video_uri = extract_gemini_video_uri(final_operation)
                if not video_uri:
                    raise RuntimeError(f"Gemini video operation returned no video URI: {final_operation}")
                raw_output_path = LOCAL_VIDEO_DIR / run_id / "gemini-video-raw.mp4"
                mobile_output_path = LOCAL_VIDEO_DIR / run_id / "gemini-video.mp4"
                await download_gemini_video(client, video_uri, raw_output_path, operation_name)
                IMAGE_JOBS[job_id].update(
                    {
                        "state": "transcoding",
                        "progress": 86,
                        "result_video_url": video_uri,
                        "raw_video_path": str(raw_output_path),
                        "operation_result": final_operation,
                    }
                )
                output_path = await transcode_for_mobile(raw_output_path, mobile_output_path)
                IMAGE_JOBS[job_id].update(
                    {
                        "state": "archiving",
                        "progress": 90,
                        "result_video_path": str(output_path),
                    }
                )
                storage_video = await archive_external_video(
                    client=client,
                    job_id=job_id,
                    video_url=None,
                    video_path=str(output_path),
                    title=subject or "gpt-gemini-video",
                    kind="gemini-video",
                    archived_by="moneyprinterturbo-gpt-gemini",
                    provider=GEMINI_VIDEO_MODEL,
                    metadata={
                        "image_provider": "gpt-image",
                        "image_model": IMAGE_MODEL,
                        "video_provider": "gemini",
                        "video_model": GEMINI_VIDEO_MODEL,
                        "requested_duration": requested_duration,
                        "duration": duration_seconds,
                        "operation_name": operation_name,
                        "keyframe_mode": "first_last_frame",
                        "mobile_transcoded": output_path == mobile_output_path,
                    },
                )
                IMAGE_JOBS[job_id].update(
                    {
                        "state": "complete",
                        "progress": 100,
                        "storage_video": storage_video,
                        "image_model": IMAGE_MODEL,
                        "image_count": len(materials),
                        "video_model": GEMINI_VIDEO_MODEL,
                        "message": "GPT image and Gemini video generation completed through relay APIs.",
                    }
                )
                return
            video_payload = {
                **payload,
                "video_script": script,
                "video_source": "local",
                "video_materials": [
                    {
                        "provider": item["provider"],
                        "url": item["url"],
                        "duration": item["duration"],
                    }
                    for item in materials
                ],
                "video_terms": ["gpt image storyboard"],
                "video_concat_mode": "sequential",
            }
            upstream_response = await client.post(f"{UPSTREAM}/api/v1/videos", json=video_payload)
            upstream_response.raise_for_status()
            result = upstream_response.json()
            data = result.get("data") if isinstance(result.get("data"), dict) else {}
            IMAGE_JOBS[job_id].update(
                {
                    "state": "submitted",
                    "progress": 100,
                    "task_id": data.get("task_id"),
                    "response": result,
                    "image_model": IMAGE_MODEL,
                    "image_count": len(materials),
                    "backend": backend,
                }
            )
    except Exception as exc:
        IMAGE_JOBS[job_id].update({"state": "failed", "progress": 100, "error": str(exc)})


async def run_local_i2v_job(job_id: str, payload: dict[str, Any]) -> None:
    LOCAL_I2V_JOBS[job_id].update({"state": "preparing", "progress": 10})
    try:
        if not LOCAL_I2V_WORKER_URL:
            raise RuntimeError("LOCAL_I2V_WORKER_URL is not configured")
        subject = str(payload.get("video_subject") or payload.get("prompt") or "").strip()
        prompt = str(payload.get("prompt") or subject).strip()
        aspect = str(payload.get("video_aspect") or "9:16")
        timeout = httpx.Timeout(max(TIMEOUT_SECONDS, 900), connect=15)
        async with httpx.AsyncClient(timeout=timeout) as client:
            image_path = str(payload.get("image_path") or "").strip()
            image_url = str(payload.get("image_url") or "").strip()
            image_b64 = str(payload.get("image_b64") or "").strip()
            run_id = ""
            materials: list[dict[str, Any]] = []

            if image_b64:
                run_id = f"local-i2v-{uuid.uuid4()}"
                run_dir = LOCAL_VIDEO_DIR / run_id
                run_dir.mkdir(parents=True, exist_ok=True)
                image_path = str(run_dir / "input.png")
                Path(image_path).write_bytes(base64.b64decode(image_b64))
            elif not image_path and not image_url:
                if not subject:
                    raise RuntimeError("video_subject, prompt, image_path, image_url, or image_b64 is required")
                LOCAL_I2V_JOBS[job_id].update({"state": "generating_image", "progress": 25})
                script = str(payload.get("video_script") or "").strip()
                if not script:
                    script = await create_script_with_upstream(client, payload)
                run_id, materials = await generate_storyboard_images(
                    client=client,
                    subject=subject,
                    script=script or subject,
                    aspect=aspect,
                    image_count=1,
                    job_id=None,
                )
                image_path = str(materials[0]["url"])
                prompt = str(materials[0]["shot"] or prompt or subject)

            LOCAL_I2V_JOBS[job_id].update(
                {
                    "state": "submitting_worker",
                    "progress": 55,
                    "run_id": run_id,
                    "image_path": image_path or None,
                    "image_url": image_url or None,
                    "prompt": prompt,
                    "materials": materials,
                }
            )
            worker_payload = {
                "job_id": job_id,
                "prompt": prompt,
                "negative_prompt": payload.get("negative_prompt", ""),
                "image_path": image_path or None,
                "host_image_path": host_storage_path(image_path) if image_path else None,
                "image_url": image_url or None,
                "image_b64": (
                    base64.b64encode(Path(image_path).read_bytes()).decode("ascii")
                    if image_path and Path(image_path).exists()
                    else None
                ),
                "aspect": aspect,
                "duration": payload.get("duration") or payload.get("video_clip_duration") or 4,
                "fps": payload.get("fps") or 24,
                "seed": payload.get("seed"),
                "model": payload.get("model") or "framepack",
                "quality": payload.get("quality") or "draft",
            }
            response = await client.post(f"{LOCAL_I2V_WORKER_URL}/api/v1/i2v", json=worker_payload)
            response.raise_for_status()
            worker_result = response.json()
            LOCAL_I2V_JOBS[job_id].update(
                {
                    "state": "submitted",
                    "progress": 70,
                    "worker_url": LOCAL_I2V_WORKER_URL,
                    "worker_response": worker_result,
                    "worker_job_id": (
                        worker_result.get("job_id")
                        or (worker_result.get("data") or {}).get("job_id")
                        if isinstance(worker_result, dict)
                        else None
                    ),
                }
            )
    except Exception as exc:
        LOCAL_I2V_JOBS[job_id].update({"state": "failed", "progress": 100, "error": str(exc)})


def guess_image_suffix(content_type: str | None, fallback: str = ".jpg") -> str:
    if content_type:
        guessed = mimetypes.guess_extension(content_type.split(";", 1)[0].strip())
        if guessed in {".jpg", ".jpeg", ".png", ".webp"}:
            return ".jpg" if guessed == ".jpeg" else guessed
    return fallback


async def prepare_free_i2v_image(
    client: httpx.AsyncClient,
    job_id: str,
    payload: dict[str, Any],
) -> tuple[str, str, list[dict[str, Any]]]:
    run_id = f"free-i2v-{uuid.uuid4()}"
    run_dir = LOCAL_VIDEO_DIR / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    materials: list[dict[str, Any]] = []

    image_path = str(payload.get("image_path") or "").strip()
    if image_path:
        path = Path(image_path)
        if not path.exists():
            raise RuntimeError(f"image_path does not exist: {image_path}")
        return str(path), run_id, materials

    image_b64 = str(payload.get("image_b64") or "").strip()
    if image_b64:
        suffix = ".png" if image_b64.startswith("iVBOR") else ".jpg"
        path = run_dir / f"input{suffix}"
        path.write_bytes(base64.b64decode(image_b64))
        return str(path), run_id, materials

    image_url = str(payload.get("image_url") or "").strip()
    if image_url:
        response = await client.get(image_url, follow_redirects=True, timeout=120)
        response.raise_for_status()
        suffix = guess_image_suffix(response.headers.get("content-type"))
        path = run_dir / f"input{suffix}"
        path.write_bytes(response.content)
        return str(path), run_id, materials

    subject = str(payload.get("video_subject") or payload.get("prompt") or "").strip()
    if not subject:
        raise RuntimeError("image_url, image_path, image_b64, video_subject, or prompt is required")

    FREE_I2V_JOBS[job_id].update({"state": "generating_image", "progress": 30})
    aspect = str(payload.get("video_aspect") or "9:16")
    script = str(payload.get("video_script") or "").strip()
    if not script:
        script = await create_script_with_upstream(client, payload)
    _, materials = await generate_storyboard_images(
        client=client,
        subject=subject,
        script=script or subject,
        aspect=aspect,
        image_count=1,
        job_id=None,
    )
    return str(materials[0]["url"]), run_id, materials


def extract_gradio_video(result: Any) -> tuple[str | None, str | None, Any]:
    item = result
    if isinstance(item, (list, tuple)) and item:
        item = item[0]
    if isinstance(item, dict) and "video" in item:
        item = item["video"]
    if isinstance(item, dict):
        return item.get("url"), item.get("path"), result
    if isinstance(item, str):
        if item.startswith("http://") or item.startswith("https://"):
            return item, None, result
        return None, item, result
    return None, None, result


def gradio_space_base_url(space: str) -> str:
    if space.startswith("http://") or space.startswith("https://"):
        return space.rstrip("/")
    owner, name = space.split("/", 1)
    host = f"{owner}-{name}".lower().replace("_", "-")
    return f"https://{host}.hf.space"


def run_gradio_i2v_sync(
    image_path: str,
    prompt: str,
    negative_prompt: str,
    duration: float,
) -> tuple[str | None, str | None, Any]:
    base_url = gradio_space_base_url(FREE_I2V_GRADIO_SPACE)
    timeout = httpx.Timeout(max(TIMEOUT_SECONDS, 900), connect=30, read=max(TIMEOUT_SECONDS, 900))
    image_file = Path(image_path)
    mime_type = mimetypes.guess_type(str(image_file))[0] or "image/jpeg"
    session_hash = uuid.uuid4().hex[:12]
    headers = {"User-Agent": "Mozilla/5.0 compatible moneyprinterturbo-free-i2v/1.0"}
    with httpx.Client(timeout=timeout, follow_redirects=True, headers=headers) as client:
        config_response = None
        for attempt in range(4):
            config_response = client.get(f"{base_url}/config")
            if config_response.status_code < 500:
                break
            time.sleep(2 + attempt * 2)
        if config_response is None:
            raise RuntimeError("failed to fetch Gradio config")
        config_response.raise_for_status()
        config = config_response.json()
        api_prefix = config.get("api_prefix") or "/gradio_api"
        fn_index = 0
        api_name = FREE_I2V_GRADIO_API.lstrip("/")
        for index, dependency in enumerate(config.get("dependencies") or []):
            if dependency.get("api_name") == api_name:
                fn_index = index
                break

        upload_response = None
        for attempt in range(4):
            with image_file.open("rb") as file:
                upload_response = client.post(
                    f"{base_url}{api_prefix}/upload",
                    files={"files": (image_file.name, file, mime_type)},
                )
            if upload_response.status_code < 500:
                break
            time.sleep(2 + attempt * 2)
        if upload_response is None:
            raise RuntimeError("failed to upload image to Gradio")
        upload_response.raise_for_status()
        upload_paths = upload_response.json()
        if not upload_paths:
            raise RuntimeError("Gradio upload returned no file path")
        uploaded_path = upload_paths[0]
        file_data = {
            "path": uploaded_path,
            "orig_name": image_file.name,
            "mime_type": mime_type,
            "is_stream": False,
            "meta": {"_type": "gradio.FileData"},
        }
        data = [
            file_data,
            prompt,
            FREE_I2V_GRADIO_STEPS,
            negative_prompt,
            duration,
            1,
            1,
            int(time.time()) % 2147483647,
            True,
        ]
        join_payload = {
            "data": data,
            "event_data": None,
            "fn_index": fn_index,
            "trigger_id": None,
            "session_hash": session_hash,
        }
        join_response = None
        for attempt in range(4):
            join_response = client.post(f"{base_url}{api_prefix}/queue/join", json=join_payload)
            if join_response.status_code < 500:
                break
            time.sleep(2 + attempt * 2)
        if join_response is None:
            raise RuntimeError("failed to join Gradio queue")
        join_response.raise_for_status()

        with client.stream("GET", f"{base_url}{api_prefix}/queue/data?session_hash={session_hash}") as response:
            response.raise_for_status()
            for line in response.iter_lines():
                if not line or not line.startswith("data: "):
                    continue
                event = json.loads(line.removeprefix("data: "))
                if event.get("msg") == "process_completed":
                    if not event.get("success", False):
                        raise RuntimeError(event.get("output", {}).get("error") or "Gradio generation failed")
                    output = (event.get("output") or {}).get("data") or []
                    return extract_gradio_video(output)
                if event.get("msg") == "process_interrupted":
                    raise RuntimeError("Gradio generation interrupted")
    raise RuntimeError("Gradio generation ended without a completed event")


async def archive_external_video(
    client: httpx.AsyncClient,
    job_id: str,
    video_url: str | None,
    video_path: str | None,
    title: str,
    metadata: dict[str, Any] | None = None,
    kind: str = "external-video",
    archived_by: str = "moneyprinterturbo-gateway",
    provider: str | None = None,
) -> dict[str, Any] | None:
    if not VIDEO_STORAGE_BASE_URL or not VIDEO_STORAGE_TOKEN:
        return None
    filename = f"{job_id}.mp4"
    content_type = "video/mp4"
    if video_path and Path(video_path).exists():
        content = Path(video_path).read_bytes()
        filename = Path(video_path).name or filename
    elif video_url:
        response = await client.get(video_url, follow_redirects=True, timeout=180)
        response.raise_for_status()
        content = response.content
        content_type = response.headers.get("content-type", content_type)
        parsed_name = urlparse(video_url).path.rsplit("/", 1)[-1]
        if parsed_name.endswith(".mp4"):
            filename = parsed_name
    else:
        return None
    upload_response = await client.post(
        f"{VIDEO_STORAGE_BASE_URL}/api/v1/videos/upload",
        headers={"Authorization": f"Bearer {VIDEO_STORAGE_TOKEN}"},
        data={
            "source_task_id": job_id,
            "kind": kind,
            "title": title or filename,
            "metadata": json.dumps(
                {
                    "archived_by": archived_by,
                    "provider": provider,
                    **(metadata or {}),
                },
                ensure_ascii=False,
            ),
        },
        files={"file": (filename, content, content_type)},
    )
    upload_response.raise_for_status()
    payload = upload_response.json()
    result = payload.get("data")
    if isinstance(result, dict):
        if payload.get("deduped"):
            result["deduped"] = True
        return add_public_media_url(result)
    return None


async def run_free_i2v_job(job_id: str, payload: dict[str, Any]) -> None:
    FREE_I2V_JOBS[job_id].update({"state": "discovering", "progress": 10})
    try:
        requested_duration = payload.get("duration") or payload.get("video_clip_duration")
        duration = payload_duration(
            payload,
            default=float(FREE_I2V_GRADIO_DURATION),
            minimum=FREE_I2V_MIN_DURATION,
            maximum=FREE_I2V_MAX_DURATION,
        )
        discovery = await discover_free_i2v_providers()
        candidates = discovery.get("candidates") or []
        likely = [item for item in candidates if item.get("status") == "likely_free_no_login"]
        possible = [item for item in candidates if item.get("status") == "possible"]
        selected = likely[0] if likely else possible[0] if possible else candidates[0] if candidates else None
        adapter_provider = {
            "name": "IMGtoVideo.ai / Hugging Face Space",
            "url": "https://www.imgtovideo.ai/",
            "space": FREE_I2V_GRADIO_SPACE,
            "api": FREE_I2V_GRADIO_API,
            "status": "verified_adapter",
            "duration_supported": True,
            "duration_range": {
                "min": FREE_I2V_MIN_DURATION,
                "max": FREE_I2V_MAX_DURATION,
                "unit": "seconds",
            },
        }
        FREE_I2V_JOBS[job_id].update(
            {
                "state": "preparing_image",
                "progress": 25,
                "prompt": payload.get("prompt") or payload.get("video_subject"),
                "image_url": payload.get("image_url"),
                "selected_provider": adapter_provider,
                "requested_duration": requested_duration,
                "duration": duration,
                "candidates": candidates,
                "discovery": {
                    "discovered_at": discovery.get("discovered_at"),
                    "search_enabled": discovery.get("search_enabled"),
                    "usable_count": discovery.get("usable_count"),
                },
            }
        )
        timeout = httpx.Timeout(max(TIMEOUT_SECONDS, 900), connect=15)
        async with httpx.AsyncClient(timeout=timeout) as client:
            image_path, run_id, materials = await prepare_free_i2v_image(client, job_id, payload)
            prompt = str(payload.get("prompt") or payload.get("video_subject") or "").strip()
            if not prompt:
                prompt = "Make this image come alive with natural subject motion, stable identity, and cinematic realistic movement."
            negative_prompt = str(
                payload.get("negative_prompt")
                or "low quality, worst quality, static, still image, camera pan only, frozen frames, jitter, blurry, distorted body, bad hands, bad face, watermark, subtitles"
            )
            FREE_I2V_JOBS[job_id].update(
                {
                    "state": "generating",
                    "progress": 55,
                    "run_id": run_id,
                    "image_path": image_path,
                    "materials": materials,
                    "duration": duration,
                    "message": "Submitted to verified free Gradio image-to-video adapter.",
                }
            )
            video_url, video_path, raw_result = await asyncio.to_thread(
                run_gradio_i2v_sync,
                image_path,
                prompt,
                negative_prompt,
                duration,
            )
            if not video_url and not video_path:
                raise RuntimeError(f"free i2v adapter returned no video: {raw_result}")
            FREE_I2V_JOBS[job_id].update(
                {
                    "state": "archiving",
                    "progress": 85,
                    "result_video_url": video_url,
                    "result_video_path": video_path,
                    "raw_result": raw_result,
                }
            )
            storage_video = await archive_external_video(
                client=client,
                job_id=job_id,
                video_url=video_url,
                video_path=video_path,
                title=str(payload.get("video_subject") or payload.get("prompt") or "free-i2v"),
                kind="free-i2v",
                archived_by="moneyprinterturbo-free-i2v",
                provider=FREE_I2V_GRADIO_SPACE,
                metadata={
                    "requested_duration": requested_duration,
                    "duration": duration,
                },
            )
            FREE_I2V_JOBS[job_id].update(
                {
                    "state": "complete",
                    "progress": 100,
                    "storage_video": storage_video,
                    "message": "Free image-to-video generation completed.",
                }
            )
    except Exception as exc:
        FREE_I2V_JOBS[job_id].update({"state": "failed", "progress": 100, "error": str(exc)})


def rewrite_urls(payload: Any) -> Any:
    if not PUBLIC_BASE_URL:
        return payload
    if isinstance(payload, dict):
        return {key: rewrite_urls(value) for key, value in payload.items()}
    if isinstance(payload, list):
        return [rewrite_urls(item) for item in payload]
    if isinstance(payload, str):
        return payload.replace(f"{UPSTREAM}/tasks/", f"{PUBLIC_BASE_URL}/tasks/")
    return payload


def task_artifact_path(url: str) -> str | None:
    parsed = urlparse(url)
    marker = "/tasks/"
    if marker not in parsed.path:
        return None
    return parsed.path.split(marker, 1)[1]


def add_public_media_url(video: dict[str, Any]) -> dict[str, Any]:
    if PUBLIC_BASE_URL and video.get("id") and video.get("filename"):
        video["public_url"] = f"{PUBLIC_BASE_URL}/media/{video['id']}/{video['filename']}"
    return video


async def archive_artifact(
    client: httpx.AsyncClient,
    task_id: str,
    url: str,
    kind: str,
) -> dict[str, Any] | None:
    if not VIDEO_STORAGE_BASE_URL or not VIDEO_STORAGE_TOKEN:
        return None
    artifact_path = task_artifact_path(url)
    if not artifact_path:
        return None
    filename = artifact_path.rsplit("/", 1)[-1] or f"{kind}.mp4"
    upstream_response = await client.get(f"{UPSTREAM}/tasks/{artifact_path}")
    upstream_response.raise_for_status()
    upload_response = await client.post(
        f"{VIDEO_STORAGE_BASE_URL}/api/v1/videos/upload",
        headers={"Authorization": f"Bearer {VIDEO_STORAGE_TOKEN}"},
        data={
            "source_task_id": task_id,
            "kind": kind,
            "title": filename,
            "metadata": '{"archived_by":"moneyprinterturbo-gateway"}',
        },
        files={
            "file": (
                filename,
                upstream_response.content,
                upstream_response.headers.get("content-type", "video/mp4"),
            )
        },
    )
    upload_response.raise_for_status()
    upload_payload = upload_response.json()
    result = upload_payload.get("data")
    if isinstance(result, dict):
        if upload_payload.get("deduped"):
            result["deduped"] = True
        result = add_public_media_url(result)
    return result


async def archive_completed_task(payload: Any) -> Any:
    if not VIDEO_STORAGE_BASE_URL or not VIDEO_STORAGE_TOKEN or not isinstance(payload, dict):
        return payload
    data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
    if data.get("state") != 1 or not data.get("task_id"):
        return payload
    task_id = data["task_id"]
    archives: list[dict[str, Any]] = []
    errors: list[str] = []
    timeout = httpx.Timeout(TIMEOUT_SECONDS, connect=15)
    async with httpx.AsyncClient(timeout=timeout) as client:
        for index, url in enumerate(data.get("videos") or [], start=1):
            try:
                archived = await archive_artifact(client, task_id, url, f"final-{index}")
                if archived:
                    archives.append(archived)
            except Exception as exc:
                errors.append(f"final-{index}: {exc}")
        for index, url in enumerate(data.get("combined_videos") or [], start=1):
            try:
                archived = await archive_artifact(client, task_id, url, f"combined-{index}")
                if archived:
                    archives.append(archived)
            except Exception as exc:
                errors.append(f"combined-{index}: {exc}")
    if archives:
        data["storage_videos"] = archives
    elif isinstance(data.get("storage_videos"), list):
        data["storage_videos"] = [
            add_public_media_url(item) if isinstance(item, dict) else item
            for item in data["storage_videos"]
        ]
    if errors:
        data["storage_errors"] = errors
    return payload


async def proxy_json(method: str, path: str, request: Request) -> Response:
    async with httpx.AsyncClient(timeout=TIMEOUT_SECONDS) as client:
        body = await request.body()
        headers = {
            key: value
            for key, value in request.headers.items()
            if key.lower() in {"content-type", "x-task-id"}
        }
        upstream_response = await client.request(
            method,
            f"{UPSTREAM}{path}",
            content=body or None,
            headers=headers,
            params=request.query_params,
        )
    content_type = upstream_response.headers.get("content-type", "")
    if "application/json" in content_type:
        payload = upstream_response.json()
        payload = await archive_completed_task(payload)
        return Response(
            content=json.dumps(payload, ensure_ascii=False).encode("utf-8")
            if not PUBLIC_BASE_URL
            else httpx.Response(200, json=rewrite_urls(payload)).content,
            status_code=upstream_response.status_code,
            media_type="application/json",
        )
    return Response(
        content=upstream_response.content,
        status_code=upstream_response.status_code,
        media_type=content_type or None,
    )


@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "image_generation_endpoint": True,
        "image_model": IMAGE_MODEL,
        "image_fallback_models": IMAGE_FALLBACK_MODELS,
        "image_output_format": IMAGE_OPENAI_OUTPUT_FORMAT,
    }


@app.get("/api/v1/openapi.json", include_in_schema=False)
async def prefixed_openapi() -> dict[str, Any]:
    return app.openapi()


@app.post("/api/v1/videos", tags=["video"])
async def create_video(request: Request, authorization: str | None = Header(default=None)) -> Response:
    require_token(authorization)
    return await proxy_json("POST", "/api/v1/videos", request)


@app.post("/api/v1/images", tags=["image"])
async def create_images(request: Request, authorization: str | None = Header(default=None)) -> Response:
    require_token(authorization)
    payload = await request.json()
    data = await create_standalone_images(payload)
    result = {"status": 200, "message": "success", "data": data}
    return Response(
        content=json.dumps(result, ensure_ascii=False).encode("utf-8"),
        status_code=200,
        media_type="application/json",
    )


@app.api_route("/api/v1/generated-images/{image_id}/{filename}", methods=["GET", "HEAD"], tags=["image"])
async def get_generated_image(image_id: str, filename: str) -> Response:
    safe_image_id = Path(image_id).name
    safe_filename = Path(filename).name
    image_path = IMAGE_OUTPUT_DIR / safe_image_id / safe_filename
    if not image_path.exists() or not image_path.is_file():
        raise HTTPException(status_code=404, detail="generated image not found")
    headers = {
        "Cache-Control": "public, max-age=31536000, immutable",
        "Access-Control-Allow-Origin": "*",
        "X-Robots-Tag": "noindex",
    }
    return Response(content=image_path.read_bytes(), media_type=image_mime_type(safe_filename), headers=headers)


@app.post("/api/v1/image-videos", tags=["video"])
async def create_image_video(
    request: Request,
    background_tasks: BackgroundTasks,
    authorization: str | None = Header(default=None),
) -> Response:
    require_token(authorization)
    payload = await request.json()
    subject = str(payload.get("video_subject") or "").strip()
    if not subject:
        raise HTTPException(status_code=422, detail="video_subject is required")
    job_id = str(uuid.uuid4())
    backend = str(payload.get("backend") or IMAGE_VIDEO_BACKEND or "gemini").lower()
    IMAGE_JOBS[job_id] = {
        "job_id": job_id,
        "state": "queued",
        "progress": 0,
        "video_subject": subject,
        "backend": backend,
        "image_model": IMAGE_MODEL,
        "video_model": GEMINI_VIDEO_MODEL if backend in {"gemini", "veo", "relay-gemini", "gpt-gemini"} else None,
    }
    background_tasks.add_task(run_image_video_job, job_id, payload)
    result = {"status": 202, "message": "accepted", "data": IMAGE_JOBS[job_id]}
    return Response(
        content=json.dumps(result, ensure_ascii=False).encode("utf-8"),
        status_code=202,
        media_type="application/json",
    )


@app.get("/api/v1/image-videos/{job_id}", tags=["video"])
async def get_image_video_job(job_id: str, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    require_token(authorization)
    job = IMAGE_JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="image video job not found")
    return {"status": 200, "message": "success", "data": job}


@app.post("/api/v1/local-i2v", tags=["video"])
async def create_local_i2v_job(
    request: Request,
    background_tasks: BackgroundTasks,
    authorization: str | None = Header(default=None),
) -> Response:
    require_token(authorization)
    if not LOCAL_I2V_WORKER_URL:
        raise HTTPException(status_code=503, detail="LOCAL_I2V_WORKER_URL is not configured")
    payload = await request.json()
    job_id = str(uuid.uuid4())
    LOCAL_I2V_JOBS[job_id] = {
        "job_id": job_id,
        "state": "queued",
        "progress": 0,
        "video_subject": payload.get("video_subject"),
        "worker_url": LOCAL_I2V_WORKER_URL,
    }
    background_tasks.add_task(run_local_i2v_job, job_id, payload)
    result = {"status": 202, "message": "accepted", "data": LOCAL_I2V_JOBS[job_id]}
    return Response(
        content=json.dumps(result, ensure_ascii=False).encode("utf-8"),
        status_code=202,
        media_type="application/json",
    )


@app.get("/api/v1/local-i2v/{job_id}", tags=["video"])
async def get_local_i2v_job(job_id: str, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    require_token(authorization)
    job = LOCAL_I2V_JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="local i2v job not found")
    if LOCAL_I2V_WORKER_URL and job.get("worker_job_id") and job.get("state") not in {"failed", "complete"}:
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(30, connect=5)) as client:
                response = await client.get(f"{LOCAL_I2V_WORKER_URL}/api/v1/i2v/{job['worker_job_id']}")
                if response.status_code < 400:
                    worker_status = response.json()
                    data = worker_status.get("data") if isinstance(worker_status, dict) else None
                    state = (data or worker_status).get("state") if isinstance(data or worker_status, dict) else None
                    progress = (data or worker_status).get("progress") if isinstance(data or worker_status, dict) else None
                    if progress is not None:
                        job["progress"] = progress
                    if state:
                        job["state"] = state
                    job["worker_status"] = worker_status
        except Exception as exc:
            job["worker_status_error"] = str(exc)
    return {"status": 200, "message": "success", "data": job}


@app.get("/api/v1/free-i2v/providers", tags=["video"])
async def get_free_i2v_providers(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    require_token(authorization)
    discovery = await discover_free_i2v_providers()
    return {"status": 200, "message": "success", "data": discovery}


@app.post("/api/v1/free-i2v", tags=["video"])
async def create_free_i2v_job(
    request: Request,
    background_tasks: BackgroundTasks,
    authorization: str | None = Header(default=None),
) -> Response:
    require_token(authorization)
    payload = await request.json()
    if not (payload.get("image_url") or payload.get("image_path") or payload.get("image_b64") or payload.get("video_subject")):
        raise HTTPException(status_code=422, detail="image_url, image_path, image_b64, or video_subject is required")
    job_id = str(uuid.uuid4())
    duration = payload_duration(
        payload,
        default=float(FREE_I2V_GRADIO_DURATION),
        minimum=FREE_I2V_MIN_DURATION,
        maximum=FREE_I2V_MAX_DURATION,
    )
    FREE_I2V_JOBS[job_id] = {
        "job_id": job_id,
        "state": "queued",
        "progress": 0,
        "video_subject": payload.get("video_subject"),
        "image_url": payload.get("image_url"),
        "requested_duration": payload.get("duration") or payload.get("video_clip_duration"),
        "duration": duration,
    }
    background_tasks.add_task(run_free_i2v_job, job_id, payload)
    result = {"status": 202, "message": "accepted", "data": FREE_I2V_JOBS[job_id]}
    return Response(
        content=json.dumps(result, ensure_ascii=False).encode("utf-8"),
        status_code=202,
        media_type="application/json",
    )


@app.get("/api/v1/free-i2v/{job_id}", tags=["video"])
async def get_free_i2v_job(job_id: str, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    require_token(authorization)
    job = FREE_I2V_JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="free i2v job not found")
    return {"status": 200, "message": "success", "data": job}


@app.get("/api/v1/videos/{task_id}", tags=["video"])
async def get_video_task(
    task_id: str,
    request: Request,
    authorization: str | None = Header(default=None),
) -> Response:
    require_token(authorization)
    return await proxy_json("GET", f"/api/v1/tasks/{task_id}", request)


@app.delete("/api/v1/videos/{task_id}", tags=["video"])
async def delete_video_task(
    task_id: str,
    request: Request,
    authorization: str | None = Header(default=None),
) -> Response:
    require_token(authorization)
    return await proxy_json("DELETE", f"/api/v1/tasks/{task_id}", request)


@app.post("/api/v1/scripts", tags=["helpers"])
async def create_script(request: Request, authorization: str | None = Header(default=None)) -> Response:
    require_token(authorization)
    return await proxy_json("POST", "/api/v1/scripts", request)


@app.post("/api/v1/terms", tags=["helpers"])
async def create_terms(request: Request, authorization: str | None = Header(default=None)) -> Response:
    require_token(authorization)
    return await proxy_json("POST", "/api/v1/terms", request)


@app.api_route("/api/v1/tasks/{path:path}", methods=["GET"], tags=["artifacts"])
async def get_task_artifact(
    path: str,
    authorization: str | None = Header(default=None),
) -> StreamingResponse:
    require_token(authorization)
    upstream_url = f"{UPSTREAM}/tasks/{path}"
    client = httpx.AsyncClient(timeout=TIMEOUT_SECONDS)
    request = client.build_request("GET", upstream_url)
    upstream_response = await client.send(request, stream=True)
    if upstream_response.status_code >= 400:
        body = await upstream_response.aread()
        await client.aclose()
        return Response(
            content=body,
            status_code=upstream_response.status_code,
            media_type=upstream_response.headers.get("content-type"),
        )
    return StreamingResponse(
        upstream_response.aiter_bytes(),
        status_code=upstream_response.status_code,
        media_type=upstream_response.headers.get("content-type", "application/octet-stream"),
        background=BackgroundTask(client.aclose),
        headers={
            "content-disposition": upstream_response.headers.get(
                "content-disposition", f'attachment; filename="{path.split("/")[-1]}"'
            )
        },
    )


@app.api_route(
    "/api/v1/media/{video_id}/{filename}",
    methods=["GET", "HEAD"],
    tags=["artifacts"],
    response_model=None,
)
async def get_public_media(video_id: str, filename: str, request: Request):
    if not VIDEO_STORAGE_BASE_URL:
        raise HTTPException(status_code=503, detail="VIDEO_STORAGE_BASE_URL is not configured")
    storage_url = f"{VIDEO_STORAGE_BASE_URL}/media/{video_id}/{filename}"
    headers = {}
    if request.headers.get("range"):
        headers["Range"] = request.headers["range"]
    client = httpx.AsyncClient(timeout=TIMEOUT_SECONDS)
    upstream_request = client.build_request(request.method, storage_url, headers=headers)
    upstream_response = await client.send(upstream_request, stream=request.method != "HEAD")
    response_headers = {
        key: value
        for key, value in upstream_response.headers.items()
        if key.lower()
        in {
            "accept-ranges",
            "cache-control",
            "content-length",
            "content-range",
            "etag",
            "last-modified",
        }
    }
    response_headers["content-disposition"] = f'inline; filename="{filename}"'
    response_headers["x-robots-tag"] = "noindex"
    if request.method == "HEAD" or upstream_response.status_code >= 400:
        body = b"" if request.method == "HEAD" else await upstream_response.aread()
        await client.aclose()
        return Response(
            content=body,
            status_code=upstream_response.status_code,
            media_type=upstream_response.headers.get("content-type", "video/mp4"),
            headers=response_headers,
        )
    return StreamingResponse(
        upstream_response.aiter_bytes(),
        status_code=upstream_response.status_code,
        media_type=upstream_response.headers.get("content-type", "video/mp4"),
        background=BackgroundTask(client.aclose),
        headers=response_headers,
    )
