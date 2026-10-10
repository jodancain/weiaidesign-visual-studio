"""V3-only deployment boundary; no Blender invocation or remote system changes."""
import os
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
from studio_service import create_app, configure


class ServiceBoundaryTest(unittest.TestCase):
    def test_task_configuration_reads_token_in_process_and_appends_logs(self):
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ), patch.object(sys, "stdout"), patch.object(sys, "stderr"):
            folder = Path(root)
            (folder / "token").write_text("d" * 64)
            config = {"tokenFile": str(folder / "token"), "renderDir": str(folder / "renders"),
                      "logDir": str(folder / "logs"), "blenderBin": "blender", "ffmpegBin": "ffmpeg", "ffprobeBin": "ffprobe"}
            (folder / "runtime.json").write_text(json.dumps(config))
            configure(folder / "runtime.json")
            try:
                self.assertEqual(os.environ["STUDIO_WORKER_TOKEN"], "d" * 64)
                self.assertEqual(os.environ["STUDIO_WORKER_HOST"], "127.0.0.1")
                self.assertNotIn("d" * 64, (folder / "runtime.json").read_text())
                self.assertTrue((folder / "logs/worker-stderr.log").is_file())
            finally:
                sys.stdout.close()
                sys.stderr.close()

    def test_missing_or_short_token_fails_closed(self):
        for token in ("", "short"):
            with patch.dict(os.environ, {"STUDIO_WORKER_TOKEN": token}):
                with self.assertRaises(RuntimeError):
                    create_app()

    def test_v3_requires_token_and_legacy_routes_are_absent(self):
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {
            "STUDIO_WORKER_TOKEN": "c" * 64, "STUDIO_RENDER_DIR": root,
        }):
            app = create_app()
            with TestClient(app) as client, patch.object(app.state.manager, "capabilities", return_value={"available": True}):
                for method, path in (("get", "/api/v3/capabilities"), ("post", "/api/v3/render"),
                                     ("get", "/api/v3/render/missing"), ("get", "/api/v3/render/missing/assets/preview.mp4")):
                    args = {"json": {}} if method == "post" else {}
                    self.assertEqual(getattr(client, method)(path, **args).status_code, 401)
                self.assertEqual(client.get("/api/v3/capabilities", headers={"Authorization": "Bearer " + "c" * 64}).status_code, 200)
                self.assertEqual(client.get("/api/v1/manifest").status_code, 404)
                self.assertEqual(client.post("/api/v1/shot", json={}).status_code, 404)
                self.assertEqual(client.get("/docs").status_code, 404)
                self.assertEqual(client.get("/health").json()["backend"], "blender-studio-v3")


if __name__ == "__main__":
    unittest.main()
