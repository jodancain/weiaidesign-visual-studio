"""Packaging boundaries without reading a real credential or creating a release."""
import importlib.util
from pathlib import Path
import tempfile
import io
import re
import subprocess
import tarfile
import unittest

spec = importlib.util.spec_from_file_location('upgrade_package', Path(__file__).resolve().parents[2] / 'scripts/artcraft-upgrade/package.py')
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)

class PackageTest(unittest.TestCase):
    def test_new_policy_ops_and_tests_are_included_without_an_extra_list_edit(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            wanted = ['scripts/artcraft-sandbox-policy/new-rule.py', 'scripts/artcraft-sandbox-policy/upstream/default.json', 'services/image2/ops/new-probe.mjs', 'tests/artcraft-upgrade/new-case.ps1', 'scripts/artcraft-upgrade/helper.ps1']
            excluded = ['.env', 'scripts/artcraft-sandbox-policy/__pycache__/test.pyc', 'docs/api-task-reports/raw.json', 'scripts/artcraft-sandbox-policy/local-validation.json', 'private/notes.md']
            for name in wanted + excluded:
                path = root / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_text('synthetic')
            self.assertEqual(package.source_names(root, excluded), sorted(wanted))

    def test_real_archive_dot_bin_prefix_hydrates_at_native_root(self):
        script = (Path(__file__).resolve().parents[2] / 'scripts/artcraft-upgrade/upgrade.ps1').read_text()
        strip, member = re.search(r'tar -xzf /input/\$leaf -C /native --strip-components=(\d+) ([./a-z]+)', script).groups()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); archive = root / 'bundle.tar.gz'; target = root / 'native'; target.mkdir()
            with tarfile.open(archive, 'w:gz') as tf:
                info = tarfile.TarInfo('./bin'); info.type = tarfile.DIRTYPE; info.mode = 0o755; tf.addfile(info)
                info = tarfile.TarInfo('./bin/manifest.json'); info.size = 2; info.mode = 0o644; tf.addfile(info, io.BytesIO(b'{}'))
            subprocess.run(['tar', '-xzf', str(archive), '-C', str(target), '--strip-components=' + strip, member], check=True)
            self.assertEqual((target / 'manifest.json').read_bytes(), b'{}')
            self.assertFalse((target / 'bin').exists())

if __name__ == '__main__':
    unittest.main(verbosity=2)
