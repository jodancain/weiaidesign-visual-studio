#!/usr/bin/env python3
"""Offline derivation/review only. Never invokes Docker or changes a daemon."""
import argparse
import copy
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WEB = ROOT.parent.parent
BASE_SHA256 = "01536f1d1df938ae611eba20d6349e0de7a99b6ecdee1549427a0b01b8301e28"
PROFILE = "docker-29.4.1-bwrap.json"
KERNEL = "6.6.114.1-microsoft-standard-WSL2"
ENGINES = set("photocraft vectorcraft filmcraft lightcraft pdfcraft effectcraft designcraft figcraft wordcraft soundcraft deckcraft cadcraft gridcraft".split())


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read_json(path):
    return json.loads(Path(path).read_bytes())


def encoded(value):
    return (json.dumps(value, indent=2, ensure_ascii=False) + "\n").encode()


def arg(index, value, op="SCMP_CMP_EQ", value_two=None):
    result = {"index": index, "value": value, "op": op}
    if value_two is not None:
        result["valueTwo"] = value_two
    return result


def rule(name, comment, *args):
    result = {"names": [name], "action": "SCMP_ACT_ALLOW",
              "includes": {"arches": ["amd64"]}, "comment": "T03: " + comment}
    if args:
        result["args"] = list(args)
    return result


def additions():
    # bubblewrap v0.12.0, non-setuid, --unshare-all --dev /dev; delta unchanged.
    # Deliberately no no-cgroup fallback: the reviewed WSL2 kernel has cgroupns.
    result = [
        rule("clone", "SIGCHLD + NEWNS/NEWUSER/NEWPID/NEWNET/NEWIPC/NEWUTS/NEWCGROUP; no other flags",
             arg(0, 0x7E020011)),
        rule("unshare", "second owned userns maps UID/GID back after devpts setup", arg(0, 0x10000000)),
    ]
    for flags, why in [
        (0x8C000, "MS_SILENT|MS_SLAVE|MS_REC: stop propagation to parent"),
        (0x6, "MS_NOSUID|MS_NODEV: root, /dev and /tmp tmpfs"),
        (0xC0EDD000, "MS_MGC_VAL|MS_SILENT|MS_BIND|MS_REC: initial newroot bind"),
        (0xD000, "MS_SILENT|MS_BIND|MS_REC: system, executable, devices and workspace binds"),
        (0xE, "MS_NOSUID|MS_NOEXEC|MS_NODEV: private procfs"),
        (0xA, "MS_NOSUID|MS_NOEXEC: private devpts"),
        (0x4C000, "MS_SILENT|MS_REC|MS_PRIVATE: oldroot before detach"),
    ]:
        result.append(rule("mount", why, arg(3, flags)))
    # bind-mount.c decodes only these inherited options. NOSUID is compulsory;
    # NODEV cannot be compulsory because --dev binds devices. No other bits,
    # including high bits, are accepted. OCI/Go uint64, NOT a JavaScript Number.
    optional = 0x1 | 0x4 | 0x8 | 0x400 | 0x800 | 0x200000
    result += [
        rule("mount", "bind remount: SILENT|BIND|REMOUNT|NOSUID, preserving only RO/NODEV/NOEXEC/NOATIME/NODIRATIME/RELATIME",
             arg(3, ((1 << 64) - 1) ^ optional, "SCMP_CMP_MASKED_EQ", 0x9022)),
        rule("pivot_root", "two root pivots; pointer paths cannot be filtered by seccomp"),
        rule("umount2", "detach old roots only (MNT_DETACH)", arg(1, 2)),
    ]
    return result


def derive(base_bytes):
    require(digest(base_bytes) == BASE_SHA256, "Unknown baseline: do not derive or replace it")
    base = json.loads(base_bytes)
    require(base["defaultAction"] == "SCMP_ACT_ERRNO" and base["defaultErrnoRet"] == 1,
            "Baseline must deny with EPERM")
    result = copy.deepcopy(base)
    result["syscalls"].extend(additions())
    return result


def check(check_inputs=True):
    sources = read_json(ROOT / "sources.lock.json")
    for source in sources["sources"]:
        if "local" in source:
            require(digest((ROOT / source["local"]).read_bytes()) == source["sha256"],
                    "Upstream bytes changed: " + source["id"])
    expected = encoded(derive((ROOT / "upstream/docker-29.4.1-default.json").read_bytes()))
    actual = (ROOT / PROFILE).read_bytes()
    require(actual == expected, "Derived profile differs; no silent policy widening")
    lock = read_json(ROOT / "review.lock.json")
    require(digest(actual) == lock["profileSha256"], "Profile review hash changed")
    require(digest((ROOT / "sources.lock.json").read_bytes()) == lock["sourcesLockSha256"], "Source lock changed")
    for name, expected_hash in lock["artifacts"].items():
        require(digest((ROOT / name).read_bytes()) == expected_hash, "Reviewed artifact drift: " + name)
    if check_inputs:
        for item in lock["inputs"]:
            require(digest((WEB / item["path"]).read_bytes()) == item["sha256"],
                    "Review input drift; re-review explicitly: " + item["path"])
    return lock


def gate(facts, *, candidate=False, profile=None, _service_layout=None):
    """Input is an allowlisted Docker version/info/inspect extract; never Env."""
    version, info, container = facts["version"], facts["info"], facts["container"]
    require(version["Version"] == "29.4.1", "Engine version changed")
    commit = version["GitCommit"]
    require(len(commit) >= 7 and "6c91b92cc71077b70c779c510da125301a8e40f3".startswith(commit),
            "Engine source commit unknown/different; inspect vendor provenance")
    require(version["Os"] == "linux" and version["Arch"] == "amd64", "Only Linux amd64 reviewed")
    require(info["KernelVersion"] == KERNEL, "Kernel changed; re-review")
    require("name=seccomp,profile=builtin" in info["SecurityOptions"], "Daemon baseline unknown")
    require(re.fullmatch(r"[a-f0-9]{64}", container["Id"]) and re.fullmatch(r"sha256:[a-f0-9]{64}", container["Image"]),
            "Require immutable container/image IDs")
    require(container["User"] in ["node", "1000", "1000:1000", "node:node"], "Require UID 1000; confirm with probe")
    require(container["Privileged"] is False and not container["CapAdd"], "No privileged container or added caps")
    for key in ["NetworkMode", "PidMode", "IpcMode", "UsernsMode"]:
        require(container[key] != "host" and not container[key].startswith("container:"), "Shared host/container namespace: " + key)
    opts = container["SecurityOpt"] or []
    allowed_other = {"no-new-privileges", "no-new-privileges=true"}
    seccomp = []
    for option in opts:
        if option.startswith("seccomp="):
            seccomp.append(option[len("seccomp="):])
        else:
            require(option in allowed_other, "Unknown security option; never silently replace: " + option.split("=", 1)[0])
    if candidate:
        if _service_layout and _service_layout["policyMode"] == "builtin":
            require(not seccomp or seccomp in [["default"], ["builtin"]], "Require builtin policy")
        else:
            require(len(seccomp) == 1, "Require exactly one inspected custom seccomp profile")
            require(json.loads(seccomp[0]) == profile, "Inspected policy differs from reviewed file")
        for key, value in {"Memory": 2147483648, "NanoCpus": 2000000000, "PidsLimit": 256}.items():
            require(type(container.get(key)) is int and container[key] == value, "Exact resource limit required: " + key)
        require(not container.get("Sysctls") and not container.get("Devices") and not container.get("Binds"), "Unexpected sysctl/device/legacy bind")
        require(set(container["CapDrop"] or []) == {"ALL"}, "Canary must drop all outer capabilities")
        require(any(o in allowed_other for o in opts), "Require no-new-privileges")
        require(not container["PortBindings"], "Canary must publish no ports")
        if _service_layout is not None:
            return service_mounts(container, _service_layout)
        mounts = {m["Destination"]: m for m in container["Mounts"]}
        require(len(mounts) == len(container["Mounts"]), "Duplicate mount destination")
        require(set(mounts).issubset({"/policy", "/opt/artcraft", "/evidence", "/tmp", "/data/image2"}), "Unexpected canary mount")
        for destination, writable in [("/policy", False), ("/opt/artcraft", False), ("/evidence", True)]:
            require(destination in mounts and mounts[destination]["Type"] == "bind" and mounts[destination]["RW"] is writable,
                    "Canary bind contract: " + destination)
        for destination in ["/tmp", "/data/image2"]:
            require(destination not in mounts or mounts[destination]["Type"] == "tmpfs", "No existing data volume")
        require(container["ReadonlyRootfs"] is True and isinstance(container["Tmpfs"], dict) and
                set(container["Tmpfs"]) == {"/tmp", "/data/image2"}, "Require isolated writable tmpfs paths")
    else:
        require(not seccomp or seccomp == ["default"] or seccomp == ["builtin"],
                "Existing container policy unknown/custom; do not replace")
    return True


def service_mounts(container, layout):
    """Separate exact service contract. Standalone candidate checks stay strict."""
    require(layout["policyMode"] in ["candidate", "builtin"], "Unknown policy mode")
    require(container["Image"] == layout["imageId"] and container["NetworkMode"] == layout["network"], "Service image/network drift")
    require(container["PidMode"] == "" and container["IpcMode"] == "private" and container["UsernsMode"] == "", "Unexpected service namespaces")
    require(container["ReadonlyRootfs"] is True, "Service rootfs must be read-only")
    require(container["Tmpfs"] == {"/tmp": "rw,nosuid,nodev,size=1073741824,mode=1777"}, "Exact private service tmpfs required")
    mounts = {m["Destination"]: m for m in container["Mounts"]}
    # Docker versions may expose tmpfs in Mounts as well as HostConfig.Tmpfs.
    require(len(mounts) == len(container["Mounts"]), "Duplicate service mount")
    if "/tmp" in mounts:
        tmp = mounts.pop("/tmp")
        require(tmp["Type"] == "tmpfs" and tmp["RW"] is True, "Unexpected /tmp mount")
    require(set(mounts) == {"/data/image2", "/opt/artcraft", "/policy"}, "Unexpected service mount")
    for dest, name, writable in [("/data/image2", layout["dataVolume"], True), ("/opt/artcraft", layout["nativeVolume"], False)]:
        m = mounts[dest]
        require(m["Type"] == "volume" and m["Name"] == name and m["RW"] is writable, "Service volume mismatch: " + dest)
    m = mounts["/policy"]
    require(m["Type"] == "bind" and m["Source"] == layout["policySource"] and m["RW"] is False, "Service policy mount drift")
    require(layout["nativeVolume"].startswith("artcraft-") and layout["dataVolume"] != layout["nativeVolume"], "Native volume must be independent")
    if layout["role"] == "canary":
        require(layout["dataVolume"].startswith("artcraft-") and layout["network"].startswith("artcraft-"), "Canary must use its own data/network")
    else:
        require(layout["role"] == "production" and layout["dataVolume"] == "weiai-image2-data" and layout["network"] == "weiai-studio-v3-production", "Wrong production scope")
    return True


def service_gate(facts, layout, profile):
    return gate(facts, candidate=True, profile=profile, _service_layout=layout)


def bind(before, after, result, lock, profile, *, service_layout=None):
    gate(before)
    gate(after, candidate=True, profile=profile, _service_layout=service_layout)
    require(before["container"]["Id"] != after["container"]["Id"], "Use a separate canary; do not replace the live container")
    if service_layout:
        require(service_layout["role"] == "canary" and after["container"]["Running"] is True, "Service proof requires live isolated canary")
    else:
        require(after["container"]["Running"] is False and after["container"]["ExitCode"] == 0, "Canary must finish successfully")
    require(result["status"] == "passed", "Target validation has not passed")
    mode = service_layout["policyMode"] if service_layout else "candidate"
    require(result["policyMode"] == mode, "Wrong policy execution")
    require(result["profileSha256"] == (lock["profileSha256"] if mode == "candidate" else None), "Probe policy hash mismatch")
    require(result["nativeManifestSha256"] == lock["nativeManifestSha256"], "Native bundle manifest drift")
    require(result["kernel"] == KERNEL, "Probe kernel mismatch")
    require(result["containerHostname"] == after["container"]["Hostname"], "Probe/container hostname mismatch")
    require(after["container"]["Id"].startswith(result["containerHostname"]), "Use default unique canary hostname")
    sandbox_pin = next(i["sha256"] for i in lock["inputs"] if i["path"].endswith("/craft-sandbox.mjs"))
    require(result["sandboxSourceSha256"] == sandbox_pin, "Sandbox source changed")
    require(result["probeSha256"] == lock["artifacts"]["target-probe.mjs"], "Probe implementation changed")
    native_pin = next(i["sha256"] for i in lock["inputs"] if i["path"].endswith("/craft-native.integration.mjs"))
    require(result["nativeTestSha256"] == native_pin, "Native suite changed")
    require(result["bwrap"] == lock["bwrap"], "bwrap binary/package/source identity needs review")
    for process in [result["node"], result["worker"], result["sandbox"]]:
        require(process["uid"] == 1000 and process["gid"] == 1000, "Unexpected process UID/GID")
        for key in ["CapEff", "CapPrm", "CapInh", "CapAmb", "CapBnd"]:
            require(int(process["status"][key], 16) == 0, "Process has capabilities: " + key)
        require(process["status"]["NoNewPrivs"] == "1" and process["status"]["Seccomp"] == "2", "Missing process protections")
    for outer in [result["node"], result["worker"]]:
        require(int(outer["status"]["CapBnd"], 16) == 0, "Outer bounding capabilities must be empty")
    for ns in ["net", "user", "mnt", "pid"]:
        require(result["worker"]["ns"][ns] != result["sandbox"]["ns"][ns], "Namespace is shared: " + ns)
    interfaces = result["sandbox"]["interfaces"]
    require(set(interfaces) == {"lo"} and interfaces["lo"] and result["sandbox"]["routes"] == [], "Sandbox is not loopback-only")
    require(all(i["internal"] and i["address"] in ["127.0.0.1", "::1"] for i in interfaces["lo"]), "Unexpected sandbox address")
    require(set(result["sandbox"]["envKeys"]) == set("PATH HOME TMPDIR TMP TEMP XDG_CONFIG_HOME XDG_CACHE_HOME XDG_DATA_HOME LANG LC_ALL RUST_BACKTRACE".split()), "Child environment is not the exact allowlist")
    for name in ["network", "neighbours", "symlinkEscape", "credentials", "ordinaryCommands"]:
        require(result["checks"][name] is True, "Missing targeted check: " + name)
    native = result["nativeResults"]
    require(len(native) == 13 and {r["id"] for r in native} == ENGINES, "All 13 native engines required")
    for engine in native:
        require(engine["status"] == "passed", "Native engine failed")
        require(engine["first"]["receipt"]["externalModelCalls"] == 0 and
                engine["second"]["receipt"]["externalModelCalls"] == 0, "Native receipt is not CPU-only")
    return {"status": "target-canary-passed-not-production-enabled", "profileSha256": lock["profileSha256"] if mode == "candidate" else "builtin",
            "containerId": after["container"]["Id"], "imageId": after["container"]["Image"],
            "nativeManifestSha256": result["nativeManifestSha256"], "bwrapSha256": result["bwrap"]["sha256"], "t01Inputs": [i for i in lock["inputs"] if "T01-" in i["path"]]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    sub.add_parser("check")
    sub.add_parser("derive")
    pre = sub.add_parser("preflight")
    pre.add_argument("--facts", required=True)
    attach = sub.add_parser("bind")
    for field in ["before", "after", "result", "out"]:
        attach.add_argument("--" + field, required=True)
    service = sub.add_parser("service-check")
    service.add_argument("--facts", required=True)
    service.add_argument("--layout", required=True)
    sb = sub.add_parser("bind-service")
    for field in ["before", "after", "result", "out", "layout"]:
        sb.add_argument("--" + field, required=True)
    args = parser.parse_args()
    if args.action == "derive":
        # Emits only to stdout. Shell redirection is an explicit local operation.
        print(encoded(derive((ROOT / "upstream/docker-29.4.1-default.json").read_bytes())).decode(), end="")
        return
    lock = check(check_inputs=args.action == "check")
    if args.action == "preflight":
        gate(read_json(args.facts))
        print("Preflight matched the reviewed baseline. This is NOT permission to run a policy.")
    elif args.action == "service-check":
        service_gate(read_json(args.facts), read_json(args.layout), read_json(ROOT / PROFILE))
        print("Exact service policy, mounts and limits matched.")
    elif args.action in ["bind", "bind-service"]:
        receipt = bind(read_json(args.before), read_json(args.after), read_json(args.result), lock, read_json(ROOT / PROFILE),
                       service_layout=read_json(args.layout) if args.action == "bind-service" else None)
        receipt["evidenceSha256"] = {key: digest(Path(getattr(args, key)).read_bytes()) for key in ["before", "after", "result"]}
        receipt["reviewLockSha256"] = digest((ROOT / "review.lock.json").read_bytes())
        if args.action == "bind-service": receipt["evidenceSha256"]["layout"] = digest(Path(args.layout).read_bytes())
        with Path(args.out).open("xb") as output:
            output.write(encoded(receipt))
        print("Canary receipt written; production enablement remains a separate review.")
    else:
        print(json.dumps({"status": "local-check-passed-target-not-run", "profileSha256": lock["profileSha256"],
                          "baselineRules": 31, "addedRules": len(additions())}))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, OSError) as error:
        raise SystemExit("T03 STOP: " + str(error))
