#!/usr/bin/env python3
"""Restore the committed Studio snapshot without reading working-tree source."""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import tarfile
from datetime import datetime, timezone


MANIFEST_PATH = "runtime/manifest.json"
SOURCE_PREFIX = "runtime/source/"
RECEIPT_PATH = ".studio-restore-receipt.json"
EXCLUDED_PARTS = {
    ".git", "node_modules", ".next", "output", "__pycache__", ".venv",
    "venv", ".cache", ".pytest_cache", ".mypy_cache", ".ruff_cache",
}
ENV_TEMPLATES = {".env.example", ".env.sample", ".env.template"}


def fail(message: str) -> None:
    raise ValueError(message)


def safe_path(name: str) -> str:
    if not isinstance(name, str) or not name:
        fail("Archive and manifest paths must be nonempty strings")
    if "\\" in name or ":" in name or any(ord(char) < 32 for char in name):
        fail(f"Unsafe relative path: {name!r}")
    path = PurePosixPath(name)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in name.split("/")):
        fail(f"Unsafe relative path: {name!r}")
    if path.as_posix() != name:
        fail(f"Noncanonical relative path: {name!r}")
    return name


def source_path(name: str) -> str:
    name = safe_path(name)
    for part in PurePosixPath(name).parts:
        if part.casefold() in EXCLUDED_PARTS or part.lower().endswith((".pyc", ".pyo")):
            fail(f"Excluded runtime content: {name}")
        if part.casefold().startswith(".env") and part not in ENV_TEMPLATES:
            fail(f"Only credential-free environment templates can be restored: {name}")
    return name


def git(repo: Path, *args: str) -> bytes:
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
    )
    if result.returncode:
        fail(f"git {args[0]} failed: {result.stderr.decode('utf-8', errors='replace').strip()}")
    return result.stdout


def committed_archive(repo: Path, revision: str) -> tuple[str, dict[str, bytes], dict[str, int]]:
    commit = git(repo, "rev-parse", "--verify", "--end-of-options", f"{revision}^{{commit}}")
    commit_id = commit.decode("ascii").strip()
    if not re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", commit_id):
        fail("Git did not resolve the requested revision to a commit")
    data = git(repo, "archive", "--format=tar", commit_id)
    files: dict[str, bytes] = {}
    modes: dict[str, int] = {}
    names: set[str] = set()
    folded_names: set[str] = set()
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:") as archive:
        for member in archive:
            name = safe_path(member.name.rstrip("/") if member.isdir() else member.name)
            if name in names or name.casefold() in folded_names:
                fail(f"Duplicate or case-colliding archive path: {name}")
            names.add(name)
            folded_names.add(name.casefold())
            if member.isdir():
                continue
            if not member.isfile() or member.issym() or member.islnk():
                fail(f"Only regular files and directories are supported: {name}")
            if member.mode & ~0o777:
                fail(f"Unsafe archive permissions: {name}")
            handle = archive.extractfile(member)
            if handle is None:
                fail(f"Unreadable archive file: {name}")
            files[name] = handle.read()
            modes[name] = member.mode
    return commit_id, files, modes


def load_manifest(files: dict[str, bytes]) -> dict:
    if MANIFEST_PATH not in files:
        fail("The requested commit has no runtime/manifest.json; commit the runtime snapshot first")
    try:
        manifest = json.loads(files[MANIFEST_PATH])
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f"Invalid committed runtime manifest: {error}")
    if not isinstance(manifest, dict) or manifest.get("schemaVersion") != 1:
        fail("Unsupported runtime manifest schema")
    entries = manifest.get("files")
    if not isinstance(entries, dict) or not entries:
        fail("Runtime manifest must contain a nonempty files map")
    if not isinstance(manifest.get("packagingAdjustments", []), list):
        fail("Runtime packagingAdjustments must be a list")
    actual = {name[len(SOURCE_PREFIX):] for name in files if name.startswith(SOURCE_PREFIX)}
    expected = set(entries)
    if actual != expected:
        fail(f"Runtime manifest coverage differs from archive: missing={sorted(expected - actual)}, unlisted={sorted(actual - expected)}")
    for name, entry in entries.items():
        source_path(name)
        if PurePosixPath(name).parts[0].casefold() in {"web", "runtime", RECEIPT_PATH}:
            fail(f"Runtime path conflicts with the restored workspace layout: {name}")
        if not isinstance(entry, dict):
            fail(f"Invalid manifest file record: {name}")
        if not isinstance(entry.get("sha256"), str) or not re.fullmatch(r"[0-9a-f]{64}", entry["sha256"]):
            fail(f"Invalid SHA-256 in manifest: {name}")
        if type(entry.get("bytes")) is not int or entry["bytes"] < 0:
            fail(f"Invalid byte length in manifest: {name}")
        if type(entry.get("mode")) is not int or not 0 <= entry["mode"] <= 0o777:
            fail(f"Invalid permission mode in manifest: {name}")
        original_hash = entry.get("sourceSha256")
        if original_hash is not None and (not isinstance(original_hash, str) or not re.fullmatch(r"[0-9a-f]{64}", original_hash)):
            fail(f"Invalid original source SHA-256 in manifest: {name}")
        content = files[SOURCE_PREFIX + name]
        if len(content) != entry["bytes"] or hashlib.sha256(content).hexdigest() != entry["sha256"]:
            fail(f"Committed runtime file fails manifest verification: {name}")
    return manifest


def restore_plan(files: dict[str, bytes], modes: dict[str, int], manifest: dict) -> dict[str, tuple[bytes, int]]:
    plan: dict[str, tuple[bytes, int]] = {}
    folded_names: set[str] = set()
    for name, content in files.items():
        if name.startswith(SOURCE_PREFIX):
            target = name[len(SOURCE_PREFIX):]
            mode = manifest["files"][target]["mode"]
        elif name == "runtime" or name.startswith("runtime/"):
            continue
        else:
            target = "web/" + source_path(name)
            mode = modes[name]
        if target in plan or target.casefold() in folded_names:
            fail(f"Restored files would collide: {target}")
        plan[target] = (content, mode)
        folded_names.add(target.casefold())
    # A regular file cannot also be an ancestor directory of another file.
    for name in plan:
        for parent in PurePosixPath(name).parents:
            if parent.as_posix() != "." and parent.as_posix().casefold() in folded_names:
                fail(f"Restored file conflicts with a directory: {name}")
    return plan


def prepare_output(output: Path) -> Path:
    if output.is_symlink():
        fail("Output must not be a symbolic link")
    if output.exists() and (not output.is_dir() or any(output.iterdir())):
        fail("Output must be a nonexistent or empty directory; existing files are never overwritten")
    output.mkdir(parents=True, exist_ok=True)
    return output.resolve()


def write_restore(output: Path, plan: dict[str, tuple[bytes, int]], manifest: dict, receipt: dict) -> None:
    for name, (content, mode) in sorted(plan.items()):
        target = output.joinpath(*PurePosixPath(name).parts)
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("xb") as handle:
            handle.write(content)
        os.chmod(target, mode)
    for name, entry in manifest["files"].items():
        target = output.joinpath(*PurePosixPath(name).parts)
        content = target.read_bytes()
        if len(content) != entry["bytes"] or hashlib.sha256(content).hexdigest() != entry["sha256"]:
            fail(f"Restored runtime file fails readback verification: {name}")
        if target.stat().st_mode & 0o777 != entry["mode"]:
            fail(f"Restored runtime file permission differs from manifest: {name}")
    receipt["restoredAt"] = datetime.now(timezone.utc).isoformat()
    receipt["runtimeReadbackVerified"] = True
    with (output / RECEIPT_PATH).open("x", encoding="utf-8") as handle:
        json.dump(receipt, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, help="New or empty destination directory")
    parser.add_argument("--revision", default="HEAD", help="Committed Git revision to restore (default: HEAD)")
    parser.add_argument("--verify-only", action="store_true", help="Verify the committed archive without writing any output")
    args = parser.parse_args()
    if not args.verify_only and args.output is None:
        parser.error("--output is required unless --verify-only is used")
    repo = Path(__file__).resolve().parents[1]
    try:
        commit, files, modes = committed_archive(repo, args.revision)
        manifest = load_manifest(files)
        plan = restore_plan(files, modes, manifest)
        receipt = {
            "schemaVersion": 1,
            "purpose": "Studio committed source restoration",
            "gitRevision": commit,
            "manifestSha256": hashlib.sha256(files[MANIFEST_PATH]).hexdigest(),
            "runtimeFiles": len(manifest["files"]),
            "webFiles": len(plan) - len(manifest["files"]),
            "archiveVerified": True,
            "packagingAdjustments": manifest.get("packagingAdjustments", []),
        }
        if not args.verify_only:
            output = prepare_output(args.output)
            write_restore(output, plan, manifest, receipt)
            receipt["output"] = str(output)
            receipt["receiptFile"] = RECEIPT_PATH
        else:
            receipt["verifyOnly"] = True
        print(json.dumps(receipt, ensure_ascii=False, indent=2))
        return 0
    except (OSError, ValueError, tarfile.TarError) as error:
        print(f"restore: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
