import concurrent.futures
import importlib.util
import io
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest

spec = importlib.util.spec_from_file_location("nas_fixture_server", Path(__file__).with_name("server.py"))
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


class AtomicUploadTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="nas-storage-test-")
        server.BASE_DIR = Path(self.temp.name)
        server.MEDIA_DIR = server.BASE_DIR / "media"
        server.DB_PATH = server.BASE_DIR / "videos.sqlite3"
        server.PUBLIC_BASE_URL = "http://fixture.invalid"
        server.init_storage()

    def tearDown(self):
        self.temp.cleanup()

    def upload(self, source="task-1", kind="studio-v3-video", content=b"fixture-video"):
        return server.store_upload(io.BytesIO(content), "fixture.mp4", "video/mp4", source, kind, "test", '{"safe":true}')

    def rows(self):
        with sqlite3.connect(server.DB_PATH) as db:
            return db.execute("select * from videos").fetchall()

    def test_eight_concurrent_retries_create_one_record_and_one_media_file(self):
        barrier = threading.Barrier(8)

        def submit(_):
            barrier.wait(timeout=10)
            return self.upload(content=b"video-bytes" * 10000)

        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(submit, range(8)))
        self.assertEqual(len({result[0]["id"] for result in results}), 1)
        self.assertEqual(sum(not result[1] for result in results), 1)
        self.assertEqual(len(self.rows()), 1)
        files = list(server.MEDIA_DIR.iterdir())
        self.assertEqual(len(files), 1)
        self.assertEqual(files[0].read_bytes(), b"video-bytes" * 10000)

    def test_legacy_duplicate_rows_and_files_are_preserved(self):
        for i in range(2):
            filename = f"legacy-{i}.mp4"
            (server.MEDIA_DIR / filename).write_bytes(b"historical")
            with sqlite3.connect(server.DB_PATH) as db:
                db.execute("insert into videos values(?,?,?,?,?,?,?,?,?,?)", (str(i), filename, filename, 10, "video/mp4", "legacy", "studio-v3-video", "old", "{}", i))
        server.init_storage()  # Migration adds a non-unique index without deleting rows.
        result, deduped = self.upload(source="legacy")
        self.assertTrue(deduped)
        self.assertEqual(result["id"], "1")
        self.assertEqual(len(self.rows()), 2)
        self.assertEqual(len(list(server.MEDIA_DIR.iterdir())), 2)

    def test_failed_insert_removes_only_the_current_attempt_file(self):
        old, _ = self.upload(source="old")
        with sqlite3.connect(server.DB_PATH) as db:
            db.execute("create trigger reject_fixture before insert on videos begin select raise(abort, 'fixture database failure'); end")
        with self.assertRaises(sqlite3.IntegrityError):
            self.upload(source="new")
        self.assertEqual(len(self.rows()), 1)
        files = list(server.MEDIA_DIR.iterdir())
        self.assertEqual(len(files), 1)
        self.assertEqual(files[0].name, old["stored_name"])

    def test_kind_is_part_of_key_and_unkeyed_uploads_remain_distinct(self):
        first, _ = self.upload(kind="studio-v3-video")
        second, _ = self.upload(kind="other-video")
        self.assertNotEqual(first["id"], second["id"])
        third, _ = self.upload(source="")
        fourth, _ = self.upload(source="")
        self.assertNotEqual(third["id"], fourth["id"])
        self.assertEqual(len(self.rows()), 4)


if __name__ == "__main__":
    unittest.main(verbosity=2)
