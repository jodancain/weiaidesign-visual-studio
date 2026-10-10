"""Build an inspectable native-worker bundle; never copy, deploy or restart remotely."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import zipfile


def package_worker(output: Path) -> dict:
    root = Path(__file__).resolve().parent
    required = {"app.py", "studio_jobs.py", "studio_render.py", "start.ps1", "assets/manifest.json", "assets/poses/library.json"}
    files = set()
    for pattern in ("*.py", "*.ps1", "*.md", "assets/**/*.json", "scene_configs/**/*.json", "examples/**/*.json", "ops/**/*.ps1"):
        for path in root.glob(pattern):
            if path.is_symlink():
                raise ValueError(f"Refusing symlink in bundle: {path.relative_to(root)}")
            if path.is_file():
                files.add(path.relative_to(root).as_posix())
    missing = required - files
    if missing:
        raise ValueError(f"Worker bundle is incomplete: {sorted(missing)}")
    manifest = {"format": 1, "purpose": "native Blender Story worker source, v1 and v3", "files": {}}
    output = output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
        for name in sorted(files):
            data = (root / name).read_bytes()
            manifest["files"][name] = {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
            bundle.writestr(name, data)
        bundle.writestr("worker-bundle-manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    return {"output": str(output), "files": len(files), "sha256": hashlib.sha256(output.read_bytes()).hexdigest(), "requiredFiles": sorted(required)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(package_worker(args.output), ensure_ascii=False, indent=2))
