#!/usr/bin/env python3
"""Fingerprint Studio source for build/readback evidence; never reads runtime secrets."""
import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
files = set()
for folder in ('web/app', 'web/components', 'web/lib', 'web/tests', 'gateway/studio', 'workers/blender-story'):
    for path in (root / folder).rglob('*'):
        if path.is_file() and path.suffix in ('.ts', '.tsx', '.css', '.json', '.mjs', '.py'):
            files.add(path)
for name in ('web/package.json', 'web/package-lock.json', 'web/next.config.ts', 'web/eslint.config.mjs',
             'web/playwright.studio-loop.config.ts', 'gateway/node-gateway.mjs',
             'gateway/package.json', 'gateway/package-lock.json', 'Dockerfile', 'Dockerfile.studio'):
    path = root / name
    if path.is_file():
        files.add(path)
entries = {str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(files)}
fingerprint = hashlib.sha256(json.dumps(entries, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
result = {'at': datetime.now(timezone.utc).isoformat(), 'sha256': fingerprint, 'files': entries}
args.output.parent.mkdir(parents=True, exist_ok=True)
args.output.write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({'files': len(entries), 'sha256': fingerprint, 'output': str(args.output)}))
