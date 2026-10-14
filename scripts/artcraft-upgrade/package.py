#!/usr/bin/env python3
"""Freeze a REVIEWED local tree without committing, building or reading env files.
Run only after supervisor review. Includes the reviewed integration roots; excludes raw reports and secrets.
"""
import argparse
import hashlib
import io
import json
from pathlib import Path
import subprocess
import tarfile

# Include every required file under the reviewed integration roots. No stale
# per-file list can silently omit a newly added policy, helper or negative test.
EXTRA_ROOTS = ['scripts/artcraft-upgrade', 'scripts/artcraft-sandbox-policy',
               'services/image2/ops', 'tests/artcraft-upgrade']
EXTRA = ['docs/ARTCRAFT_NATIVE_UPGRADE.md']

def source_names(root, tracked):
    extra = [p.relative_to(root).as_posix() for folder in EXTRA_ROOTS for p in (root / folder).rglob('*') if p.is_file()]
    return sorted({n for n in tracked + EXTRA + extra if n and allowed(n) and (root / n).is_file()})

def allowed(name):
    path = Path(name)
    return not name.startswith('docs/api-task-reports/') and path.name != 'local-validation.json' and not any(p in {'.git', 'node_modules', 'output', 'runtime', '.next', 'data', 'models', 'private', 'secrets', '__pycache__'} or p.startswith('.env') for p in path.parts) and path.suffix not in {'.pem', '.key', '.p12', '.pfx', '.pyc', '.log'}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    output = Path(args.output).resolve()
    if output.exists():
        raise SystemExit('Refusing to overwrite an immutable release archive')
    tracked = subprocess.check_output(['git', 'ls-files', '-z'], cwd=root).decode().split('\0')
    names = source_names(root, tracked)
    files = {}; contents = {}
    # Per-file hashes explicitly identify reviewed dirty deployment changes; HEAD
    # alone is not claimed as the build's full source identity.
    for name in names:
        if (root / name).is_symlink():
            raise SystemExit('Source symlink requires explicit packaging review')
        contents[name] = (root / name).read_bytes()
        files[name] = hashlib.sha256(contents[name]).hexdigest()
    source = {'head': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root).decode().strip(),
              'files': files, 'sourceIdentity': 'HEAD plus exact reviewed file manifest; not a clean-commit claim'}
    metadata = json.dumps(source, indent=2, sort_keys=True).encode()
    output.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(output, 'w:gz') as archive:
        for name in names:
            info = tarfile.TarInfo(name); info.size = len(contents[name]); info.mode = (root / name).stat().st_mode & 0o777
            archive.addfile(info, io.BytesIO(contents[name]))
        info = tarfile.TarInfo('UPGRADE-SOURCE.json'); info.size = len(metadata); info.mode = 0o644
        archive.addfile(info, io.BytesIO(metadata))
    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    print(json.dumps({'archive': str(output), 'bytes': output.stat().st_size, 'sha256': digest, 'head': source['head'], 'sourceManifestSha256': hashlib.sha256(metadata).hexdigest()}))

if __name__ == '__main__':
    main()
