import importlib.util
import json
import tempfile
import hashlib
import tarfile
import io
import socket
import unittest
from pathlib import Path
from worker import OCREngine, validate_models


class WorkerReadinessTest(unittest.TestCase):
    def test_missing_models_never_import_paddle_or_download(self):
        with tempfile.TemporaryDirectory() as directory:
            engine = OCREngine(directory)
            engine.initialize()
            self.assertFalse(engine.health()['ready'])
            self.assertEqual(engine.reason, 'model_manifest_missing')
            self.assertFalse(engine.health()['downloads_at_runtime'])

    def test_wrong_model_version_is_not_ready(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, 'manifest.json').write_text(json.dumps({'ocr_version': 'latest'}))
            self.assertEqual(validate_models(directory), (False, 'model_manifest_version_mismatch'))

    def test_missing_weights_is_not_ready(self):
        from worker import MODELS
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, 'manifest.json').write_text(json.dumps({'ocr_version': 'PP-OCRv5', 'models': MODELS}))
            self.assertEqual(validate_models(directory), (False, 'model_weights_missing'))

    def test_explicit_prepare_pins_all_hashes_and_detects_tampering(self):
        from prepare_models import prepare
        from worker import MODELS
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archives = {}
            for role, name in MODELS.items():
                archive = root / (role + '.tar')
                with tarfile.open(archive, 'w') as tar:
                    for file in ['inference.json', 'inference.pdiparams', 'inference.yml']:
                        content = (role + ':' + file).encode()
                        member = tarfile.TarInfo(name + '/' + file)
                        member.size = len(content)
                        tar.addfile(member, io.BytesIO(content))
                archives[role] = (archive, hashlib.sha256(archive.read_bytes()).hexdigest())
            models = root / 'prepared'
            prepare(archives, models)
            self.assertEqual(validate_models(models), (True, 'prepared'))
            from download_models import download_and_prepare
            from unittest.mock import patch
            with patch('urllib.request.urlopen', side_effect=AssertionError('Unexpected model download')):
                self.assertTrue(download_and_prepare(models, root/'unused-cache')['already_present'])
            (models / MODELS['rec'] / 'inference.pdiparams').write_bytes(b'changed')
            self.assertEqual(validate_models(models), (False, 'model_checksum_mismatch'))

    def test_prepare_rejects_archive_path_traversal(self):
        from prepare_models import prepare
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / 'unsafe.tar'
            with tarfile.open(archive, 'w') as tar:
                member = tarfile.TarInfo('../escape')
                member.size = 1
                tar.addfile(member, io.BytesIO(b'x'))
            with self.assertRaisesRegex(ValueError, 'Unsafe'):
                prepare({'det': (archive, hashlib.sha256(archive.read_bytes()).hexdigest())}, root / 'prepared')
            self.assertFalse((root / 'escape').exists())

    def test_runtime_network_is_blocked_before_model_import(self):
        from worker import block_model_network
        original, original_ex = socket.socket.connect, socket.socket.connect_ex
        try:
            block_model_network()
            with socket.socket() as connection:
                with self.assertRaises(PermissionError):
                    connection.connect(('127.0.0.1', 1))
        finally:
            socket.socket.connect, socket.socket.connect_ex = original, original_ex


if __name__ == '__main__':
    unittest.main()
