"""Explicit offline model preparation. Never invoked by worker startup or image requests."""
import argparse
import hashlib
import json
import shutil
import tarfile
import tempfile
from pathlib import Path
from worker import MODELS


def prepare(archives, output):
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    sources = {}
    for role, (archive, expected) in archives.items():
        archive = Path(archive)
        actual = hashlib.sha256(archive.read_bytes()).hexdigest()
        if actual != expected:
            raise ValueError("Archive SHA-256 mismatch: " + role)
        with tempfile.TemporaryDirectory() as temp:
            temp = Path(temp)
            with tarfile.open(archive) as tar:
                for member in tar.getmembers():
                    target = (temp / member.name).resolve()
                    if not target.is_relative_to(temp.resolve()) or member.issym() or member.islnk() or not (member.isdir() or member.isfile()):
                        raise ValueError("Unsafe archive entry")
                    if member.size > 1024 * 1024 * 1024:
                        raise ValueError("Archive file exceeds size budget")
                # Manual extraction supports the local Python as well as Docker's Python 3.11,
                # and never permits tar metadata, links, devices or traversal to write files.
                for member in tar.getmembers():
                    target = (temp / member.name).resolve()
                    if member.isdir():
                        target.mkdir(parents=True, exist_ok=True)
                    else:
                        target.parent.mkdir(parents=True, exist_ok=True)
                        with tar.extractfile(member) as source, target.open('wb') as destination:
                            shutil.copyfileobj(source, destination)
            graph = next(temp.rglob("inference.json"), None) or next(temp.rglob("inference.pdmodel"), None)
            if graph is None or not (graph.parent / "inference.pdiparams").is_file() or not (graph.parent / 'inference.yml').is_file():
                raise ValueError("Archive does not contain the required model graph and weights")
            destination = output / MODELS[role]
            if destination.exists():
                raise ValueError("Prepared destination already exists; use a new model volume")
            shutil.copytree(graph.parent, destination)
        sources[role] = {"archive_sha256": actual}
    files = {str(p.relative_to(output)): hashlib.sha256(p.read_bytes()).hexdigest()
             for name in MODELS.values() for p in (output / name).rglob("*") if p.is_file()}
    manifest = {"ocr_version": "PP-OCRv5", "models": MODELS, "sources": sources, "files": files}
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--det-archive", required=True)
    parser.add_argument("--det-sha256", required=True)
    parser.add_argument("--rec-archive", required=True)
    parser.add_argument("--rec-sha256", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    manifest = prepare({"det": (args.det_archive, args.det_sha256),
                        "rec": (args.rec_archive, args.rec_sha256)}, args.output)
    print(json.dumps({"prepared": True, "models": manifest["models"], "files": len(manifest["files"])}))
