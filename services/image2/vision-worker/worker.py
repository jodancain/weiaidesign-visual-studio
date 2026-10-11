"""CPU PP-OCRv5 worker. All model files are prepared offline; no network/model download path."""
import base64
import hashlib
import io
import json
import os
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib import metadata
from pathlib import Path

MODELS = {"det": "PP-OCRv5_server_det", "rec": "PP-OCRv5_server_rec"}
EXPECTED_PACKAGES = {"paddleocr": "3.3.2", "paddlex": "3.3.8", "paddlepaddle": "3.2.2"}


def block_model_network():
    """Serving accepts inbound HTTP; model libraries have no outbound socket path."""
    os.environ["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] = "True"
    def denied_connect(*_args, **_kwargs):
        raise PermissionError("Runtime model network access is disabled")
    socket.socket.connect = denied_connect
    socket.socket.connect_ex = denied_connect


def validate_models(root):
    root = Path(root)
    manifest_path = root / "manifest.json"
    if not manifest_path.is_file():
        return False, "model_manifest_missing"
    try:
        manifest = json.loads(manifest_path.read_text())
        if manifest.get("ocr_version") != "PP-OCRv5" or manifest.get("models") != MODELS:
            return False, "model_manifest_version_mismatch"
        for name in MODELS.values():
            directory = root / name
            if not (directory / "inference.pdiparams").is_file():
                return False, "model_weights_missing"
            if not (directory / "inference.yml").is_file():
                return False, "model_config_missing"
            if not any((directory / f).is_file() for f in ("inference.json", "inference.pdmodel")):
                return False, "model_graph_missing"
        files = manifest.get("files", {})
        if not files:
            return False, "model_checksums_missing"
        for relative, expected in files.items():
            target = (root / relative).resolve()
            if not target.is_relative_to(root.resolve()) or not target.is_file():
                return False, "model_file_invalid"
            if hashlib.sha256(target.read_bytes()).hexdigest() != expected:
                return False, "model_checksum_mismatch"
        # Every model file must have been part of the immutable manifest.
        actual = {str(p.relative_to(root)) for name in MODELS.values() for p in (root/name).rglob('*') if p.is_file()}
        if actual != set(files):
            return False, "model_manifest_incomplete"
        return True, "prepared"
    except (OSError, ValueError, TypeError):
        return False, "model_manifest_invalid"


class OCREngine:
    def __init__(self, root):
        self.root = Path(root)
        self.pipeline = None
        self.reason = "not_initialized"
        self.lock = threading.Lock()

    def initialize(self):
        valid, self.reason = validate_models(self.root)
        if not valid:
            return
        try:
            if any(metadata.version(package) != version for package, version in EXPECTED_PACKAGES.items()):
                self.reason = "runtime_version_mismatch"
                return
            # Construct only after validating every local graph/weight file. Optional download-
            # backed orientation and unwarping modules are explicitly disabled.
            block_model_network()
            from paddleocr import PaddleOCR
            self.pipeline = PaddleOCR(
                ocr_version="PP-OCRv5", device="cpu", enable_hpi=False,
                text_detection_model_name=MODELS["det"],
                text_detection_model_dir=str(self.root / MODELS["det"]),
                text_recognition_model_name=MODELS["rec"],
                text_recognition_model_dir=str(self.root / MODELS["rec"]),
                use_doc_orientation_classify=False, use_doc_unwarping=False,
                use_textline_orientation=False,
            )
            self.reason = "loaded_cpu"
        except Exception as error:
            self.pipeline = None
            self.reason = "runtime_load_failed:" + type(error).__name__

    def health(self):
        return {"ready": self.pipeline is not None, "reason": self.reason,
                "models": MODELS, "ocr_version": "PP-OCRv5", "device": "cpu",
                "packages": EXPECTED_PACKAGES, "downloads_at_runtime": False}

    def predict(self, encoded):
        if self.pipeline is None:
            raise RuntimeError("model_not_ready")
        import numpy as np
        from PIL import Image
        image_bytes = base64.b64decode(encoded, validate=True)
        if len(image_bytes) > 32 * 1024 * 1024:
            raise ValueError("image_too_large")
        with Image.open(io.BytesIO(image_bytes)) as source:
            if source.width * source.height > 16_000_000:
                raise ValueError("pixel_budget_exceeded")
            image = source.convert("RGB")
        with self.lock:
            results = self.pipeline.predict(np.array(image))
            items = []
            for result in results:
                data = result.json
                if callable(data):
                    data = data()
                if isinstance(data, str):
                    data = json.loads(data)
                data = data.get("res", data)
                texts, scores = data.get("rec_texts", []), data.get("rec_scores", [])
                polygons, boxes = data.get("rec_polys", []), data.get("rec_boxes", [])
                for i, text in enumerate(texts):
                    polygon = polygons[i] if i < len(polygons) else None
                    bbox = boxes[i] if i < len(boxes) else None
                    if hasattr(polygon, "tolist"):
                        polygon = polygon.tolist()
                    if hasattr(bbox, "tolist"):
                        bbox = bbox.tolist()
                    items.append({"text": str(text), "confidence": float(scores[i]) if i < len(scores) else 0,
                                  "bbox": bbox, "polygon": polygon, "fontFamily": None, "fontStatus": "unknown"})
        return {"items": items, "width": image.width, "height": image.height, "models": MODELS}


def make_handler(engine, token):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass  # no request bodies/URLs or bearer tokens in logs

        def send_json(self, status, data):
            payload = json.dumps(data, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def authorized(self):
            return bool(token) and self.headers.get("Authorization") == "Bearer " + token

        def do_GET(self):
            if self.path != "/health":
                return self.send_json(404, {"detail": "not_found"})
            self.send_json(200, engine.health())

        def do_POST(self):
            if self.path != "/ocr":
                return self.send_json(404, {"detail": "not_found"})
            if not self.authorized():
                return self.send_json(401, {"detail": "unauthorized"})
            if engine.pipeline is None:
                return self.send_json(503, {"detail": "model_not_ready"})
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length < 1 or length > 48 * 1024 * 1024:
                    return self.send_json(413, {"detail": "body_too_large"})
                body = json.loads(self.rfile.read(length))
                self.send_json(200, engine.predict(body["image"]))
            except (ValueError, KeyError):
                self.send_json(400, {"detail": "invalid_image"})
            except Exception:
                self.send_json(502, {"detail": "ocr_failed"})
    return Handler


if __name__ == "__main__":
    engine = OCREngine(os.environ.get("IMAGE2_OCR_MODEL_DIR", "/models/ocr"))
    engine.initialize()
    ThreadingHTTPServer((os.environ.get("IMAGE2_OCR_BIND", "0.0.0.0"),
                         int(os.environ.get("PORT", "8080"))),
                        make_handler(engine, os.environ.get("IMAGE2_OCR_TOKEN", ""))).serve_forever()
