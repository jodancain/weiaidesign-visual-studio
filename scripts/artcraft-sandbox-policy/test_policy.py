"""Offline regression checks: no Docker, network, namespaces, or credentials."""
import copy
import itertools
import json
import unittest
import policy as p


def applicable(rule, caps=(), arch="amd64"):
    include, exclude = rule.get("includes", {}), rule.get("excludes", {})
    if include.get("arches") and arch not in include["arches"]:
        return False
    if arch in exclude.get("arches", []):
        return False
    if not set(include.get("caps", [])).issubset(caps) or set(exclude.get("caps", [])).intersection(caps):
        return False
    kernel = (6, 6)
    if include.get("minKernel") and kernel < tuple(map(int, include["minKernel"].split("."))):
        return False
    if exclude.get("minKernel") and kernel >= tuple(map(int, exclude["minKernel"].split("."))):
        return False
    return True


def decision(profile, name, args=(), caps=()):
    args = list(args) + [0] * (6 - len(args))
    matches = []
    for rule in profile["syscalls"]:
        if name not in rule["names"] or not applicable(rule, caps):
            continue
        for condition in rule.get("args", []):
            actual, value = args[condition["index"]], condition["value"]
            op = condition["op"]
            match = {"SCMP_CMP_EQ": lambda: actual == value, "SCMP_CMP_NE": lambda: actual != value,
                     "SCMP_CMP_MASKED_EQ": lambda: actual & value == condition.get("valueTwo", 0)}[op]()
            if not match:
                break
        else:
            matches.append((rule["action"], rule.get("errnoRet")))
    # Explicit errno (clone3 ENOSYS) wins over allow; the default is fallback.
    return next((r for r in matches if r[0] == "SCMP_ACT_ERRNO"), matches[0] if matches else
                (profile["defaultAction"], profile.get("defaultErrnoRet")))


def facts():
    return {"version": {"Version": "29.4.1", "GitCommit": "6c91b92", "Os": "linux", "Arch": "amd64"},
            "info": {"KernelVersion": p.KERNEL, "SecurityOptions": ["name=seccomp,profile=builtin", "name=cgroupns"]},
            "container": {"Id": "a" * 64, "Image": "sha256:" + "b" * 64, "Hostname": "a" * 12,
                          "User": "node", "Privileged": False, "CapAdd": None, "CapDrop": None,
                          "NetworkMode": "bridge", "PidMode": "", "IpcMode": "private", "UsernsMode": "",
                          "SecurityOpt": None, "PortBindings": {}, "ReadonlyRootfs": True,
                          "Running": False, "ExitCode": 0, "Memory": 2147483648, "NanoCpus": 2000000000, "PidsLimit": 256,
                          "Tmpfs": {"/tmp": "rw", "/data/image2": "rw"},
                          "Mounts": [{"Destination": d, "Type": "bind", "RW": rw} for d, rw in
                                     [("/policy", False), ("/opt/artcraft", False), ("/evidence", True)]]}}


class PolicyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.base_bytes = (p.ROOT / "upstream/docker-29.4.1-default.json").read_bytes()
        cls.base = json.loads(cls.base_bytes)
        cls.profile = p.derive(cls.base_bytes)

    def test_reviewed_bytes_and_inputs(self):
        p.check()

    def test_unknown_baseline_is_never_replaced(self):
        altered = copy.deepcopy(self.base)
        altered["defaultAction"] = "SCMP_ACT_ALLOW"
        with self.assertRaisesRegex(ValueError, "Unknown baseline"):
            p.derive(p.encoded(altered))

    def test_every_original_rule_and_header_preserved(self):
        self.assertEqual(self.profile["syscalls"][:31], self.base["syscalls"])
        self.assertEqual({k: v for k, v in self.profile.items() if k != "syscalls"},
                         {k: v for k, v in self.base.items() if k != "syscalls"})
        self.assertEqual(len(self.profile["syscalls"]), 43)
        self.assertEqual({r["names"][0] for r in p.additions()}, {"clone", "unshare", "mount", "pivot_root", "umount2"})
        self.assertTrue(all(r["includes"] == {"arches": ["amd64"]} for r in p.additions()))

    def test_namespace_flags_are_exact(self):
        self.assertEqual(decision(self.profile, "clone", [0x7E020011])[0], "SCMP_ACT_ALLOW")
        for bit in range(64):
            mutated = 0x7E020011 ^ (1 << bit)
            self.assertEqual(decision(self.profile, "clone", [mutated])[0], "SCMP_ACT_ERRNO", hex(mutated))
        for flags in [0, 0x40000000, 0x50000000, 0x7E020000, 0x10000001]:
            self.assertEqual(decision(self.profile, "unshare", [flags])[0], "SCMP_ACT_ERRNO")
        self.assertEqual(decision(self.profile, "unshare", [0x10000000])[0], "SCMP_ACT_ALLOW")
        self.assertEqual(decision(self.profile, "clone", [17])[0], "SCMP_ACT_ALLOW")

    def test_mount_options_bounded_including_high_bits(self):
        optional = [1, 4, 8, 0x400, 0x800, 0x200000]
        for switches in itertools.product([0, 1], repeat=len(optional)):
            flags = 0x9022 | sum(bit * switch for bit, switch in zip(optional, switches))
            self.assertEqual(decision(self.profile, "mount", [0, 0, 0, flags])[0], "SCMP_ACT_ALLOW")
            for bad in [flags & ~2, flags | (1 << 40), flags | 0x100000, flags | 0x40]:
                self.assertEqual(decision(self.profile, "mount", [0, 0, 0, bad])[0], "SCMP_ACT_ERRNO")
        for flags in [6, 10, 14, 0x8C000, 0x4C000, 0xD000, 0xC0EDD000]:
            self.assertEqual(decision(self.profile, "mount", [0, 0, 0, flags])[0], "SCMP_ACT_ALLOW")
        for flags in [0, 0x1000, 0x2000, 0x100000, 0xC0ED0000]:
            self.assertEqual(decision(self.profile, "mount", [0, 0, 0, flags])[0], "SCMP_ACT_ERRNO")
        for flags in [0, 1, 3, 8, 2 | (1 << 32)]:
            self.assertEqual(decision(self.profile, "umount2", [0, flags])[0], "SCMP_ACT_ERRNO")
        self.assertEqual(decision(self.profile, "umount2", [0, 2])[0], "SCMP_ACT_ALLOW")

    def test_unrelated_default_protections_remain(self):
        for caps in [(), ("CAP_CHOWN", "CAP_SYS_CHROOT", "CAP_NET_RAW", "CAP_MKNOD")]:
            for name in ["setns", "bpf", "fsopen", "fsconfig", "fsmount", "fspick", "open_tree", "move_mount", "mount_setattr",
                         "perf_event_open", "keyctl", "add_key", "request_key", "init_module", "finit_module", "delete_module",
                         "kexec_load", "open_by_handle_at", "userfaultfd", "swapon", "swapoff", "syslog", "not_a_syscall"]:
                self.assertEqual(decision(self.profile, name, caps=caps), decision(self.base, name, caps=caps), name)
                self.assertEqual(decision(self.profile, name, caps=caps)[0], "SCMP_ACT_ERRNO", name)
        self.assertEqual(decision(self.profile, "clone3"), ("SCMP_ACT_ERRNO", 38))
        self.assertEqual(decision(self.profile, "socket", [40])[0], "SCMP_ACT_ERRNO")
        for name in ["read", "write", "execve", "capget", "capset", "prctl", "fork", "futex", "getpid"]:
            self.assertEqual(decision(self.profile, name)[0], "SCMP_ACT_ALLOW", name)

    def test_unknown_or_weakened_runtime_fails_gate(self):
        self.assertTrue(p.gate(facts()))
        changes = {"SecurityOpt": ["seccomp=unconfined"], "Privileged": True, "CapAdd": ["SYS_ADMIN"],
                   "NetworkMode": "host", "PidMode": "host", "IpcMode": "container:other", "UsernsMode": "host", "User": "root"}
        for key, value in changes.items():
            f = facts(); f["container"][key] = value
            with self.assertRaises(ValueError, msg=key):
                p.gate(f)
        for options in [["seccomp={}"], ["apparmor=unconfined"], ["unknown=value"]]:
            f = facts(); f["container"]["SecurityOpt"] = options
            with self.assertRaises(ValueError):
                p.gate(f)
        f = facts(); f["info"]["SecurityOptions"] = []
        with self.assertRaises(ValueError):
            p.gate(f)
        f = facts(); f["version"]["GitCommit"] = "unknown"
        with self.assertRaises(ValueError):
            p.gate(f)

    def test_custom_policy_readback_must_match(self):
        f = facts(); f["container"]["CapDrop"] = ["ALL"]
        f["container"]["SecurityOpt"] = ["no-new-privileges=true", "seccomp=" + json.dumps(self.profile)]
        self.assertTrue(p.gate(f, candidate=True, profile=self.profile))
        for key, value in [("CapDrop", []), ("PortBindings", {"80/tcp": [{}]}), ("SecurityOpt", ["seccomp=" + json.dumps(self.profile)]),
                           ("Mounts", [{"Destination": "/data/image2", "Type": "volume", "RW": True}]), ("ReadonlyRootfs", False)]:
            altered = copy.deepcopy(f); altered["container"][key] = value
            with self.assertRaises(ValueError):
                p.gate(altered, candidate=True, profile=self.profile)
        f["container"]["SecurityOpt"][1] = 'seccomp={"defaultAction":"SCMP_ACT_ALLOW"}'
        with self.assertRaises(ValueError):
            p.gate(f, candidate=True, profile=self.profile)

    def test_binding_rejects_false_passes(self):
        lock = p.read_json(p.ROOT / "review.lock.json")
        before, after = facts(), facts()
        after["container"].update(Id="c" * 64, Hostname="c" * 12, CapDrop=["ALL"],
                                  SecurityOpt=["no-new-privileges=true", "seccomp=" + json.dumps(self.profile)])
        proc = {"uid": 1000, "gid": 1000, "status": {k: "0000000000000000" for k in ["CapEff", "CapPrm", "CapInh", "CapAmb", "CapBnd"]},
                "ns": {n: n + ":[1]" for n in ["net", "user", "mnt", "pid"]}}
        proc["status"].update(NoNewPrivs="1", Seccomp="2")
        child = copy.deepcopy(proc); child["ns"] = {n: n + ":[2]" for n in proc["ns"]}
        child.update(interfaces={"lo": [{"address": "127.0.0.1", "internal": True}]}, routes=[],
                     envKeys="PATH HOME TMPDIR TMP TEMP XDG_CONFIG_HOME XDG_CACHE_HOME XDG_DATA_HOME LANG LC_ALL RUST_BACKTRACE".split())
        result = {"status": "passed", "nativeManifestSha256": lock["nativeManifestSha256"], "policyMode": "candidate", "profileSha256": lock["profileSha256"], "kernel": p.KERNEL,
                  "containerHostname": "c" * 12, "sandboxSourceSha256": next(i["sha256"] for i in lock["inputs"] if i["path"].endswith('/craft-sandbox.mjs')),
                  "probeSha256": lock["artifacts"]["target-probe.mjs"], "nativeTestSha256": next(i["sha256"] for i in lock["inputs"] if i["path"].endswith('/craft-native.integration.mjs')),
                  "bwrap": copy.deepcopy(lock["bwrap"]),
                  "node": copy.deepcopy(proc), "worker": copy.deepcopy(proc), "sandbox": child,
                  "checks": {k: True for k in ["network", "neighbours", "symlinkEscape", "credentials", "ordinaryCommands"]},
                  "nativeResults": [{"id": e, "status": "passed", **{phase: {"receipt": {"externalModelCalls": 0}} for phase in ["first", "second"]}} for e in p.ENGINES]}
        self.assertEqual(p.bind(before, after, result, lock, self.profile)["status"], "target-canary-passed-not-production-enabled")
        mutations = [lambda x: x.update(status="skipped"), lambda x: x["nativeResults"].pop(),
                     lambda x: x["sandbox"]["status"].update(CapEff="1"),
                     *[lambda x, who=who: x[who]["status"].update(CapBnd="200000") for who in ["node", "worker", "sandbox"]], lambda x: x["sandbox"]["ns"].update(net=x["worker"]["ns"]["net"]),
                     lambda x: x["sandbox"]["envKeys"].append("OPENAI_API_KEY"), lambda x: x.update(profileSha256="0" * 64),
                     lambda x: x.update(nativeTestSha256="0" * 64), lambda x: x["bwrap"].update(version="bubblewrap 0.11.0"),
                     lambda x: x["bwrap"].update(sha256="d" * 64), lambda x: x["bwrap"].update(setid=True),
                     lambda x: x["bwrap"]["package"].update(sourceVersion="unreviewed"),
                     lambda x: x["bwrap"]["package"].update(architecture="arm64")]
        for mutate in mutations:
            altered = copy.deepcopy(result); mutate(altered)
            with self.assertRaises(ValueError):
                p.bind(before, after, altered, lock, self.profile)

    def test_limits_and_rounded_uint64(self):
        f = facts(); f["container"].update(CapDrop=["ALL"], SecurityOpt=["no-new-privileges=true", "seccomp=" + json.dumps(self.profile)])
        for key in ["Memory", "NanoCpus", "PidsLimit"]:
            for value in [None, 0, -1, 1, "256"]:
                bad = copy.deepcopy(f); bad["container"][key] = value
                with self.assertRaises(ValueError): p.gate(bad, candidate=True, profile=self.profile)
            bad = copy.deepcopy(f); del bad["container"][key]
            with self.assertRaises(ValueError): p.gate(bad, candidate=True, profile=self.profile)
        rounded = copy.deepcopy(self.profile)
        mask = next(a for r in rounded["syscalls"] for a in r.get("args", []) if a["value"] > 2**53)
        mask["value"] = int(float(mask["value"]))
        f["container"]["SecurityOpt"][1] = "seccomp=" + json.dumps(rounded)
        with self.assertRaisesRegex(ValueError, "Inspected policy differs"):
            p.gate(f, candidate=True, profile=self.profile)

    def test_service_contract_does_not_weaken_standalone(self):
        f = facts(); c = f["container"]
        c.update(CapDrop=["ALL"], SecurityOpt=["no-new-privileges=true", "seccomp=" + json.dumps(self.profile)],
                 NetworkMode="artcraft-r-canary", Tmpfs={"/tmp": "rw,nosuid,nodev,size=1073741824,mode=1777"},
                 Mounts=[{"Type": "volume", "Destination": "/data/image2", "RW": True, "Name": "artcraft-r-copy"},
                         {"Type": "volume", "Destination": "/opt/artcraft", "RW": False, "Name": "artcraft-r-native"},
                         {"Type": "bind", "Destination": "/policy", "RW": False, "Source": "/reviewed"}])
        layout = {"role": "canary", "policyMode": "candidate", "imageId": c["Image"], "network": "artcraft-r-canary", "dataVolume": "artcraft-r-copy", "nativeVolume": "artcraft-r-native", "policySource": "/reviewed"}
        self.assertTrue(p.service_gate(f, layout, self.profile))
        with self.assertRaises(ValueError): p.gate(f, candidate=True, profile=self.profile)
        for mutate in [lambda x: x["Mounts"][0].update(Name="weiai-image2-data"), lambda x: x["Mounts"][1].update(RW=True),
                       lambda x: x["Mounts"][2].update(Source="/other"), lambda x: x.update(PortBindings={"80/tcp": [{}]}),
                       lambda x: x.update(Sysctls={"kernel.foo": "1"}), lambda x: x.update(Tmpfs={}), lambda x: x.update(ReadonlyRootfs=False)]:
            bad = copy.deepcopy(f); mutate(bad["container"])
            with self.assertRaises(ValueError): p.service_gate(bad, layout, self.profile)
        prod = copy.deepcopy(layout); prod.update(role="production", dataVolume="weiai-image2-data", network="weiai-studio-v3-production")
        c["Mounts"][0]["Name"] = prod["dataVolume"]; c["NetworkMode"] = prod["network"]
        self.assertTrue(p.service_gate(f, prod, self.profile))


if __name__ == "__main__":
    unittest.main(verbosity=2)
