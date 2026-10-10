#!/usr/bin/env python3
import cgi
import json
import os
import posixpath
import shutil
import sqlite3
import time
import uuid
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse


BASE_DIR = Path(os.environ.get("VIDEO_STORAGE_DATA_DIR", "./data")).resolve()
MEDIA_DIR = BASE_DIR / "media"
DB_PATH = BASE_DIR / "videos.sqlite3"
TOKEN = os.environ.get("VIDEO_STORAGE_TOKEN", "")
PUBLIC_BASE_URL = os.environ.get("VIDEO_STORAGE_PUBLIC_BASE_URL", "http://127.0.0.1:8788").rstrip("/")
MAX_UPLOAD_BYTES = int(os.environ.get("VIDEO_STORAGE_MAX_UPLOAD_BYTES", str(1024 * 1024 * 1024)))


def init_storage():
    MEDIA_DIR.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(DB_PATH) as db:
        db.execute(
            """
            create table if not exists videos (
              id text primary key,
              filename text not null,
              stored_name text not null,
              size integer not null,
              content_type text not null,
              source_task_id text,
              kind text,
              title text,
              metadata_json text,
              created_at integer not null
            )
            """
        )
        # Non-unique to preserve all historical records, including old duplicates.
        db.execute("create index if not exists videos_source_kind on videos(source_task_id, kind, created_at)")


def row_to_dict(row):
    keys = [
        "id",
        "filename",
        "stored_name",
        "size",
        "content_type",
        "source_task_id",
        "kind",
        "title",
        "metadata_json",
        "created_at",
    ]
    data = dict(zip(keys, row))
    data["metadata"] = json.loads(data.pop("metadata_json") or "{}")
    data["download_url"] = f"{PUBLIC_BASE_URL}/media/{data['id']}/{data['filename']}"
    return data


def safe_filename(name):
    name = posixpath.basename(name or "video.mp4")
    cleaned = []
    for char in name:
        if char.isalnum() or char in {".", "-", "_"}:
            cleaned.append(char)
        else:
            cleaned.append("_")
    value = "".join(cleaned).strip("._")
    return value or "video.mp4"


def store_upload(fileobj, filename, content_type, source_task_id, kind, title, metadata_raw):
    """Serialize check-and-insert across HTTP threads/processes without deleting history."""
    filename = safe_filename(filename)
    try:
        metadata = json.loads(metadata_raw) if metadata_raw else {}
    except json.JSONDecodeError:
        metadata = {"raw": metadata_raw}
    created_target = None
    committed = False
    try:
        with sqlite3.connect(DB_PATH, timeout=30) as db:
            # Acquire the writer lock before checking the idempotency pair. A second
            # upload waits, then sees the committed row before creating another file.
            db.execute("BEGIN IMMEDIATE")
            if source_task_id and kind:
                existing = db.execute(
                    "select * from videos where source_task_id = ? and kind = ? order by created_at desc limit 1",
                    (source_task_id, kind),
                ).fetchone()
                if existing:
                    return row_to_dict(existing), True
            video_id = str(uuid.uuid4())
            stored_name = f"{video_id}.mp4" if filename.lower().endswith(".mp4") else f"{video_id}_{filename}"
            target = MEDIA_DIR / stored_name
            with target.open("xb") as out:
                created_target = target
                shutil.copyfileobj(fileobj, out)
                out.flush()
                os.fsync(out.fileno())
            db.execute(
                """insert into videos
                (id, filename, stored_name, size, content_type, source_task_id, kind, title, metadata_json, created_at)
                values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (video_id, filename, stored_name, target.stat().st_size, content_type,
                 source_task_id, kind, title, json.dumps(metadata, ensure_ascii=False), int(time.time())),
            )
            row = db.execute("select * from videos where id = ?", (video_id,)).fetchone()
        committed = True
        return row_to_dict(row), False
    finally:
        # Only this attempt's new file is eligible for cleanup; existing records and
        # their media are never removed, even when a legacy pair has duplicates.
        if created_target is not None and not committed:
            try:
                created_target.unlink()
            except FileNotFoundError:
                pass


class Handler(BaseHTTPRequestHandler):
    server_version = "AiVideoStorage/1.0"

    def _send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_error(self, status, message):
        self._send_json(status, {"status": status, "message": message})

    def _require_token(self):
        if not TOKEN:
            self._send_error(HTTPStatus.SERVICE_UNAVAILABLE, "VIDEO_STORAGE_TOKEN is not configured")
            return False
        if self.headers.get("Authorization") != f"Bearer {TOKEN}":
            self._send_error(HTTPStatus.UNAUTHORIZED, "invalid or missing bearer token")
            return False
        return True

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            self._send_json(HTTPStatus.OK, {"status": "ok"})
            return
        if parsed.path == "/api/v1/videos":
            if not self._require_token():
                return
            query = parse_qs(parsed.query)
            limit = min(int(query.get("limit", ["50"])[0]), 200)
            with sqlite3.connect(DB_PATH) as db:
                rows = db.execute(
                    "select * from videos order by created_at desc limit ?", (limit,)
                ).fetchall()
            self._send_json(HTTPStatus.OK, {"status": 200, "data": [row_to_dict(r) for r in rows]})
            return
        if parsed.path.startswith("/api/v1/videos/"):
            if not self._require_token():
                return
            video_id = parsed.path.rsplit("/", 1)[-1]
            with sqlite3.connect(DB_PATH) as db:
                row = db.execute("select * from videos where id = ?", (video_id,)).fetchone()
            if not row:
                self._send_error(HTTPStatus.NOT_FOUND, "video not found")
                return
            self._send_json(HTTPStatus.OK, {"status": 200, "data": row_to_dict(row)})
            return
        if parsed.path.startswith("/media/"):
            self._serve_media(parsed.path)
            return
        self._send_error(HTTPStatus.NOT_FOUND, "not found")

    def do_HEAD(self):
        parsed = urlparse(self.path)
        if parsed.path.startswith("/media/"):
            self._serve_media(parsed.path, head_only=True)
            return
        self.send_response(HTTPStatus.NOT_FOUND)
        self.end_headers()

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path != "/api/v1/videos/upload":
            self._send_error(HTTPStatus.NOT_FOUND, "not found")
            return
        if not self._require_token():
            return
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > MAX_UPLOAD_BYTES:
            self._send_error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "upload too large or empty")
            return
        form = cgi.FieldStorage(
            fp=self.rfile,
            headers=self.headers,
            environ={
                "REQUEST_METHOD": "POST",
                "CONTENT_TYPE": self.headers.get("Content-Type", ""),
                "CONTENT_LENGTH": str(length),
            },
        )
        if "file" not in form:
            self._send_error(HTTPStatus.BAD_REQUEST, "missing multipart field: file")
            return
        file_item = form["file"]
        try:
            result, deduped = store_upload(
                file_item.file, file_item.filename, file_item.type or "application/octet-stream",
                form.getfirst("source_task_id", ""), form.getfirst("kind", "final"),
                form.getfirst("title", ""), form.getfirst("metadata", "{}"),
            )
        except (OSError, sqlite3.Error):
            self._send_error(HTTPStatus.SERVICE_UNAVAILABLE, "archive storage temporarily unavailable")
            return
        status = HTTPStatus.OK if deduped else HTTPStatus.CREATED
        self._send_json(status, {"status": int(status), "data": result, **({"deduped": True} if deduped else {})})

    def do_DELETE(self):
        parsed = urlparse(self.path)
        if not parsed.path.startswith("/api/v1/videos/"):
            self._send_error(HTTPStatus.NOT_FOUND, "not found")
            return
        if not self._require_token():
            return
        video_id = parsed.path.rsplit("/", 1)[-1]
        with sqlite3.connect(DB_PATH) as db:
            row = db.execute("select * from videos where id = ?", (video_id,)).fetchone()
            if not row:
                self._send_error(HTTPStatus.NOT_FOUND, "video not found")
                return
            data = row_to_dict(row)
            db.execute("delete from videos where id = ?", (video_id,))
        target = MEDIA_DIR / data["stored_name"]
        if target.exists():
            target.unlink()
        self._send_json(HTTPStatus.OK, {"status": 200, "message": "deleted", "data": data})

    def _serve_media(self, path, head_only=False):
        parts = [unquote(p) for p in path.split("/") if p]
        if len(parts) != 3:
            self._send_error(HTTPStatus.NOT_FOUND, "not found")
            return
        _, video_id, filename = parts
        with sqlite3.connect(DB_PATH) as db:
            row = db.execute("select * from videos where id = ?", (video_id,)).fetchone()
        if not row:
            self._send_error(HTTPStatus.NOT_FOUND, "video not found")
            return
        data = row_to_dict(row)
        if filename != data["filename"]:
            self._send_error(HTTPStatus.NOT_FOUND, "filename mismatch")
            return
        target = MEDIA_DIR / data["stored_name"]
        if not target.exists():
            self._send_error(HTTPStatus.NOT_FOUND, "file missing")
            return
        file_size = target.stat().st_size
        range_header = self.headers.get("Range", "")
        start = 0
        end = file_size - 1
        status = HTTPStatus.OK
        if range_header.startswith("bytes="):
            range_value = range_header.split("=", 1)[1].split(",", 1)[0].strip()
            start_raw, _, end_raw = range_value.partition("-")
            try:
                if start_raw:
                    start = int(start_raw)
                    end = int(end_raw) if end_raw else file_size - 1
                elif end_raw:
                    suffix = int(end_raw)
                    start = max(file_size - suffix, 0)
                    end = file_size - 1
                if start < 0 or end < start or start >= file_size:
                    self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                    self.send_header("Content-Range", f"bytes */{file_size}")
                    self.end_headers()
                    return
                end = min(end, file_size - 1)
                status = HTTPStatus.PARTIAL_CONTENT
            except ValueError:
                start = 0
                end = file_size - 1
        content_length = end - start + 1
        self.send_response(status)
        self.send_header("Content-Type", data["content_type"] or "video/mp4")
        self.send_header("Content-Length", str(content_length))
        self.send_header("Accept-Ranges", "bytes")
        if status == HTTPStatus.PARTIAL_CONTENT:
            self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
        self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        self.send_header("X-Robots-Tag", "noindex")
        self.end_headers()
        if not head_only:
            with target.open("rb") as source:
                source.seek(start)
                remaining = content_length
                while remaining > 0:
                    chunk = source.read(min(1024 * 1024, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)

    def log_message(self, fmt, *args):
        print("%s - - [%s] %s" % (self.client_address[0], self.log_date_time_string(), fmt % args))


def main():
    init_storage()
    host = os.environ.get("VIDEO_STORAGE_HOST", "0.0.0.0")
    port = int(os.environ.get("VIDEO_STORAGE_PORT", "8788"))
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"listening on {host}:{port}, data={BASE_DIR}, public={PUBLIC_BASE_URL}")
    server.serve_forever()


if __name__ == "__main__":
    main()
