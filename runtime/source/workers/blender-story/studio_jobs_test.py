"""Offline durable-queue tests; no Blender, GPU, API credentials or network."""
import base64
import ast
import json
import struct
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path
from types import SimpleNamespace
from studio_jobs import StudioJobs, StudioError, read_glb, register_routes, validate_landmark_readback, validate_request

try:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
except ImportError:
    TestClient = None


def glb(document=None):
    data = json.dumps(document or {"asset": {"version": "2.0"}, "scenes": [{"nodes": []}]}).encode()
    data += b" " * (-len(data) % 4)
    return struct.pack("<IIIII", 0x46546C67, 2, 20 + len(data), len(data), 0x4E4F534A) + data


def request():
    return {"jobRef": "test-job", "inputHash": "a" * 64, "baked_glb_b64": base64.b64encode(glb()).decode(), "scene": {"up": "Y", "units": "meters", "objects": [], "cameras": []}, "frameStart": 0, "frameEnd": 24, "fps": 24, "resolution": [64, 64]}


class DurableJobsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.queued = []
        self.manager = StudioJobs(self.root, "missing-blender", enqueue=self.queued.append)

    def tearDown(self):
        self.temp.cleanup()

    def test_submission_is_durable_and_duplicate_does_not_enqueue(self):
        first = self.manager.submit(request())
        self.assertEqual(first, self.manager.submit(request()))
        self.assertEqual(self.queued, ["test-job"])
        disk = json.loads((self.root / "test-job/job.json").read_text())
        self.assertEqual(disk["state"], "queued")
        self.assertTrue((self.root / "test-job/input.glb").is_file())

    def test_same_reference_changed_input_is_conflict_even_when_claimed_hash_same(self):
        self.manager.submit(request())
        altered = request()
        altered["frameEnd"] = 23
        with self.assertRaises(StudioError) as result:
            self.manager.submit(altered)
        self.assertEqual(result.exception.status, 409)

    def test_restart_recovers_running_job_as_one_queued_job(self):
        self.manager.submit(request())
        self.manager.update("test-job", state="running", progress=45)
        recovered = []
        new = StudioJobs(self.root, "missing-blender", enqueue=recovered.append)
        new.recover()
        self.assertEqual(recovered, ["test-job"])
        self.assertTrue(new.get("test-job")["recovered"])
        new.submit(request())
        self.assertEqual(len(recovered), 1)

    def test_completed_and_failed_jobs_are_not_restarted(self):
        self.manager.submit(request())
        self.manager.update("test-job", state="complete", progress=100, attempt="attempt-fixture", frames=24)
        recovered = []
        new = StudioJobs(self.root, "missing-blender", enqueue=recovered.append)
        new.recover()
        self.assertEqual(recovered, [])
        self.assertEqual(new.submit(request())["state"], "complete")
        new.update("test-job", state="failed", error="fixture")
        self.assertEqual(new.submit(request())["state"], "failed")

    def test_tampered_persistent_glb_fails_before_execution(self):
        self.manager.submit(request())
        (self.root / "test-job/input.glb").write_bytes(b"bad")
        self.manager.run("test-job")
        self.assertIn("hash mismatch", self.manager.get("test-job")["error"])

    def test_glb_external_resources_and_path_ids_are_rejected(self):
        with self.assertRaises(StudioError):
            read_glb(glb({"buffers": [{"uri": "file:///private/file"}]}))
        body = request(); body["jobRef"] = "../../escape"
        with self.assertRaises(StudioError):
            self.manager.submit(body)
        self.manager.submit(request())
        with self.assertRaises(StudioError):
            self.manager.asset("test-job", "../../input.glb")

    def test_bake_origin_is_explicit_and_range_is_checked(self):
        body = request()
        body["baked_glb_b64"] = base64.b64encode(glb({"scenes": [{"extras": {"studio": {"frameStart": 12, "frameEnd": 36}}}]})).decode()
        with self.assertRaises(StudioError):
            self.manager.submit(body)
        body.update(frameStart=12, frameEnd=36)
        self.manager.submit(body)
        self.assertEqual(json.loads((self.root / "test-job/input.json").read_text())["bakeFrameStart"], 12)

    def test_baked_view_camera_overrides_default_without_mutating_request(self):
        body = request()
        body["scene"].update(activeCameraId="default", cameras=[{"id": "default"}, {"id": "view"}])
        body["baked_glb_b64"] = base64.b64encode(glb({"nodes": [{"extras": {"studio": {"frameStart": 0, "frameEnd": 24, "cameraId": "view"}}}]})).decode()
        spec, _ = validate_request(body)
        self.assertEqual(spec["bakedCameraId"], "view")
        self.assertEqual(spec["scene"]["activeCameraId"], "view")
        self.assertEqual(body["scene"]["activeCameraId"], "default")
        body["scene"]["cameras"] = [{"id": "default"}]
        with self.assertRaises(StudioError):
            validate_request(body)

    def test_invalid_resolution_fps_and_nonfinite_sidecar_are_rejected(self):
        for patch in ({"fps": 30}, {"resolution": [65, 64]}, {"frameEnd": 0}, {"scene": {"exposure": float("nan")}}):
            with self.subTest(patch=patch):
                body = request(); body.update(patch)
                with self.assertRaises(StudioError):
                    self.manager.submit(body)

    def test_landmark_gate_checks_position_rotation_and_quaternion_equivalence(self):
        expected = [{"frame": 0, "objectId": "human", "bone": "Hand", "position": [1, 2, 3], "rotation": [0, 0, 0, 1]}]
        observed = [{**expected[0], "quaternion": [0, 0, 0, -1]}]
        self.assertEqual(validate_landmark_readback(expected, observed)["checked"], 1)
        for patch in ({"position": [1.002, 2, 3]}, {"quaternion": [0, 0, .01, 1]}, {"position": [float("nan"), 2, 3]}):
            with self.assertRaises(StudioError):
                validate_landmark_readback(expected, [{**observed[0], **patch}])
        with self.assertRaises(StudioError):
            validate_landmark_readback(expected, [])

    def test_nested_object_and_part_visibility_never_unhides_hidden_parent(self):
        # Execute the renderer's actual dependency-free visibility functions with
        # Blender-shaped objects; native import/render is covered by GLB fixtures.
        class Object:
            def __init__(self, name, parent=None, **extras):
                self.name, self.parent, self.extras = name, parent, extras
                self.type, self.hide_render, self.children_recursive = 'EMPTY', False, []
                ancestor = parent
                while ancestor:
                    ancestor.children_recursive.append(self)
                    ancestor = ancestor.parent
            def get(self, key):
                return self.extras.get(key)
        parent = Object('parent')
        child = Object('child', parent)
        part = Object('part-node', child, studioPartRoot=True, studioPartId='gltf-node-2', studioObjectId='child')
        mesh = Object('mesh', part)
        objects = {o.name:o for o in [parent, child, part, mesh]}
        class Collection(dict):
            def __iter__(self):
                return iter(self.values())
        tree = ast.parse(Path(__file__).with_name('studio_render.py').read_text())
        functions = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in {'descendants','find_object','value_at','apply_sidecar'}]
        scope = {'bpy':SimpleNamespace(data=SimpleNamespace(objects=Collection(objects)))}
        exec(compile(ast.Module(body=functions, type_ignores=[]), 'studio_render.py', 'exec'), scope)
        scene = {'objects':[{'id':'child','visible':False,'parentId':'parent','parts':[{'id':'gltf-node-2','visible':True}]},{'id':'parent','visible':True}], 'tracks':[]}
        scope['apply_sidecar'](scene,0)
        self.assertTrue(mesh.hide_render)  # child-before-parent order cannot override child false.
        scene['objects'][0]['visible'] = True
        scene['objects'][0]['parts'][0]['visible'] = False
        scope['apply_sidecar'](scene,0); self.assertFalse(child.hide_render); self.assertTrue(mesh.hide_render)
        scene['tracks'] = [{'targetId':'child','partId':'gltf-node-2','property':'visible','keys':[{'frame':0,'value':1}]}]
        scope['apply_sidecar'](scene,0); self.assertFalse(mesh.hide_render)
        scene['objects'][1]['visible'] = False
        scope['apply_sidecar'](scene,0); self.assertTrue(mesh.hide_render)

    @unittest.skipUnless(TestClient, "FastAPI/httpx not installed in this Python")
    def test_http_contract_auth_idempotency_status_and_capabilities(self):
        app = FastAPI()
        register_routes(app, self.manager)
        with patch.dict("os.environ", {"STUDIO_WORKER_TOKEN": "test-only-no-real-credential"}):
            client = TestClient(app)
            self.assertEqual(client.post("/api/v3/render", json=request()).status_code, 401)
            headers = {"Authorization": "Bearer test-only-no-real-credential"}
            first = client.post("/api/v3/render", headers=headers, json=request())
            self.assertEqual(first.status_code, 200, first.text)
            second = client.post("/api/v3/render", headers=headers, json=request())
            self.assertEqual(first.json()["id"], second.json()["id"])
            self.assertEqual(len(self.queued), 1)
            self.assertEqual(client.get("/api/v3/render/test-job", headers=headers).json()["state"], "queued")
            self.assertEqual(client.get("/api/v3/render/missing", headers=headers).status_code, 404)
            self.assertEqual(client.get("/api/v3/render/test-job/assets/preview.mp4", headers=headers).status_code, 409)
            capability = client.get("/api/v3/capabilities", headers=headers).json()
            self.assertFalse(capability["blender"])
            self.assertFalse(capability["available"])


if __name__ == "__main__":
    unittest.main()
