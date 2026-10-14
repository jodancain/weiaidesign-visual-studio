# T03: Docker 29.4.1 bubblewrap policy proposal

**Review candidate only. No custom policy has been applied; target acceptance remains pending.**
Container scoped; no daemon change. Do not attach this policy to the live service
until the supervisor has reviewed the exact bytes and target evidence. T04 integrates this candidate into the focused upgrade executor; target review is still required.

## Evidence and pinned derivation

`review.lock.json` binds the policy to the exact local sandbox/runtime/native
definitions, existing tests, and the authoritative T01 runtime/host/target evidence files. The source digests
are observations of the working tree, including pre-existing native Dockerfile
edits; they do not establish final-image provenance.

- `T01-runtime.json` SHA256:
  `467c16fbe7b586b6d456ac3477e3e72127868863081f90dd31b478171883eb18`.
  Old image2: UID/GID 1000, CapEff/CapPrm 0, CapBnd `a80425fb`, NoNewPrivs 0,
  seccomp mode 2, bwrap absent, combined util-linux unshare probe EPERM.
- Successful `T01-host-metadata.json` SHA256 `1ba8d29fbd27acde675b404d423ed47371fa9208b4033edc95b6aaf7348951c0`
  and `T01-targets-152832.json` SHA256 `be36c148e7ee8f8763107a0424b8cf82c448f7d1dfd11f7194630f142019cc00`
  supply host/target facts, including builtin/default security and currently unlimited resources.
  The failed partial collector is no longer the lock's host authority. Fresh Engine GitCommit,
  full runtime facts and actual native image/bwrap evidence remain mandatory.
- Official Moby tag is **`docker-v29.4.1`**, commit
  `6c91b92cc71077b70c779c510da125301a8e40f3` (not `v29.4.1`). Its
  [go.mod](https://github.com/moby/moby/blob/6c91b92cc71077b70c779c510da125301a8e40f3/go.mod)
  pins `github.com/moby/profiles/seccomp v0.1.0`.
- Module tag `seccomp/v0.1.0` resolves to
  `c936cc7b4074219137bc0bee45670f5e4618d462`. Vendored default.json SHA256:
  `01536f1d1df938ae611eba20d6349e0de7a99b6ecdee1549427a0b01b8301e28`.
  [Official generator](https://github.com/moby/profiles/blob/c936cc7b4074219137bc0bee45670f5e4618d462/seccomp/generate.go)
  serializes `DefaultProfile()`. No moving-main default is used.
- [Moby loader](https://github.com/moby/moby/blob/6c91b92cc71077b70c779c510da125301a8e40f3/daemon/seccomp_linux.go)
  distinguishes builtin, explicit container policy, and daemon policy.
  [Profile loader](https://github.com/moby/profiles/blob/c936cc7b4074219137bc0bee45670f5e4618d462/seccomp/seccomp_linux.go)
  resolves capability conditions from the container's **bounding** set at
  creation, not from capabilities acquired later in a nested user namespace.
- [Docker documentation](https://github.com/docker/docs/blob/37ba9076a66c8a5b1cd7ba7f4b0eb1eb361fe698/content/manuals/engine/security/seccomp.md)
  specifies an allowlist/default-ERRNO profile and per-container
  `--security-opt seccomp=...`. Its generic unconfined example is **not** used.
- bwrap source frozen: **v0.12.0**, commit
  `2a76602a8c71f36c1527cf9fc3417d9149822e0c`.
  [bubblewrap.c](https://github.com/containers/bubblewrap/blob/2a76602a8c71f36c1527cf9fc3417d9149822e0c/bubblewrap.c#L3017)
  and [bind-mount.c](https://github.com/containers/bubblewrap/blob/2a76602a8c71f36c1527cf9fc3417d9149822e0c/bind-mount.c#L408)
  match the verified Debian orig archive. The native image pins
  **bubblewrap=0.12.0-1~deb13u1**, source version **0.12.0-1~deb13u1**, **amd64**.
  This [Debian security update](https://lists.debian.org/debian-security-announce/2026/msg00383.html)
  fixes symlink traversal; its one Debian patch changes the EPERM diagnostic only.
  Debian builds with `-Dassume_kernel=5.10.0`, using the safer openat2 path.
  The probe and receipt verifier require `/usr/bin/bwrap`, non-setid mode, and exact
  binary SHA256 `573236e5328ac2ebb08f59ae3a9805b4f8d12bdef14be8af4450d5463294985f`.
  Binary, package, source-version or architecture drift stops before isolation tests.
  The previous 0.11.0 version-gate failure is not a default-seccomp failure;
  a fresh builtin control is required with this coherent source/package lock.

`sources.lock.json` contains exact official URLs, commits, byte counts and SHA256
for all research sources. Only the upstream profile and its license are vendored.

## Exact permission delta

`policy.py` appends **12 rules / 5 syscall names** to all **31 unchanged** baseline
rules. The full header/archMap/capability and kernel conditions are preserved.
Default stays `SCMP_ACT_ERRNO`, errno **1 (EPERM)**. New rules select Docker daemon
architecture `amd64`; this is **not** a per-syscall ABI selector. Docker's existing
x86/x32 compatibility architectures remain present. Other daemon architectures
receive no additions and are outside this proposal.

Actual command: `--die-with-parent --unshare-all --new-session --cap-drop ALL`,
read-only `/usr /lib /lib64 /bin /etc/fonts /etc/ld.so.cache` where present,
private proc/dev/tmpfs, read-only executable, writable job directory, job cwd.

| Syscall | Permitted argument(s) | Reason and limit |
| --- | --- | --- |
| `clone` | arg0 **`0x7e020011`** exactly | SIGCHLD + NEWUSER/NEWNS/NEWPID/NEWNET/NEWIPC/NEWUTS/NEWCGROUP. bwrap.c 3017–3075. No other flags; no namespaces without NEWUSER. No cgroup-absent fallback on this reviewed kernel. |
| `unshare` | arg0 **`0x10000000`** exactly | NEWUSER only. The owned user namespace restores UID/GID after devpts setup (3339–3382). |
| `mount` | arg3 **`0x8c000`** | SILENT/SLAVE/REC: stop propagating mounts to parent. |
| `mount` | arg3 **`0x6`** | NOSUID/NODEV: root, /dev and /tmp tmpfs. |
| `mount` | arg3 **`0xc0edd000`** | MGC_VAL/SILENT/BIND/REC: initial newroot bind. Legacy magic retained because this source supplies it. |
| `mount` | arg3 **`0xd000`** | SILENT/BIND/REC: system/executable/workspace/device binds. |
| `mount` | arg3 **`0xe`** | NOSUID/NOEXEC/NODEV: procfs. |
| `mount` | arg3 **`0xa`** | NOSUID/NOEXEC: devpts. |
| `mount` | arg3 **`0x4c000`** | SILENT/REC/PRIVATE: oldroot before detach. |
| `mount` | arg3 masked equality | Required `0x9022` (SILENT/BIND/REMOUNT/NOSUID). Only RO/NODEV/NOEXEC/NOATIME/NODIRATIME/RELATIME may vary; all other bits, including upper 32 bits, must be zero. bind-mount.c 435–489 preserves inherited flags and adds restrictions. NODEV cannot be mandatory for device binds. |
| `pivot_root` | No pointer filtering possible | Two root pivots (3282, 3326); kernel namespace/capability checks must enforce ownership. |
| `umount2` | arg1 **`2`** exactly | MNT_DETACH old roots (3302, 3330). No FORCE/EXPIRE/NOFOLLOW allowance. |

Numeric mask is a JSON **uint64**. Do not round-trip the profile through JavaScript
Number or a floating-point JSON formatter. Python and Docker's Go JSON parser
preserve it. Hash exact file bytes before launch; compare inspected embedded JSON
with Python after launch (Docker may compact whitespace).

No new allowance for `clone3` (retains ENOSYS 38 under cap-drop ALL), `setns`,
new mount API (`fsopen/fsconfig/fsmount/fspick/open_tree/move_mount/mount_setattr`),
`umount`, BPF, perf, keyrings, modules, kexec, open_by_handle_at or userfaultfd.
Ordinary fork/thread clone rules, socket restrictions and other Docker protections
are unchanged. The old combined **util-linux unshare probe is intentionally not
an acceptance oracle**: its combined unshare flags still fail this narrow policy.

## Residual risk and mandatory boundaries

The exception applies to **every process in this container**, including a
compromised worker or native child. Seccomp cannot inspect filesystem-type/path
strings, namespace ownership, call order, or identify the executable invoking a
syscall. These flags therefore permit other kernel-accepted mounts with the same
flags; they are not path or filesystem allowlists. Opening unprivileged user
namespaces/mount code increases kernel attack surface and resource-exhaustion
risk. Cap-drop ALL does not prevent a process creating its own nested userns and
acquiring capabilities **there**. The current sandbox does not disable further
userns creation after exec. No claim of universal escape prevention is made.

Required outer settings: non-root UID/GID 1000, **cap-drop ALL**, no-new-privileges,
no privileged mode, no SYS_ADMIN or other added capability, no host/shared network,
PID/IPC/user namespaces, no Docker socket or production data in the canary.
Namespace-scoped setup capabilities may exist only in the new owned userns;
node/diagnostic worker/native exec must have CapEff/Prm/Inh/Amb 0 (outer Bnd 0).
The probe captures user namespace maps and rejects setuid/setgid bwrap.

The read-only canary image and isolated tmpfs/data paths below are additional
standalone test constraints. T04 adds a separate exact service contract with its own data volume, read-only native/policy mounts and private /tmp; it does not weaken standalone validation.
Do not turn off AppArmor/SELinux, add capabilities, change host sysctls or replace
an unknown container/daemon profile to make a failing test pass. Current T01
NoNewPrivs=0 is an observation, not a requested setting for the candidate.

## Local checks (safe now)

From `web/`:

```sh
python3 -B scripts/artcraft-sandbox-policy/policy.py check
python3 -B scripts/artcraft-sandbox-policy/test_policy.py
node --check scripts/artcraft-sandbox-policy/target-probe.mjs
node --test scripts/artcraft-sandbox-policy/probe-checks.test.mjs
```

All run offline. No Docker execution or seccomp filter installation. To audit
reproduction, `policy.py derive` emits the exact proposed JSON to stdout; compare
it with the committed candidate. It rejects any unknown baseline hash. `check`
also rejects source/evidence/artifact drift and never repairs it automatically.
Tests evaluate rule semantics and reject deliberately unsafe mutations; they do
not compile BPF or establish Linux/libseccomp compatibility.

## Safe next command plan — supervisor executes only after review

1. Review this delta/residual risk, source locks and exact policy SHA256. Inspect
   the final image ID, bwrap version/binary hash and distribution patch provenance.
   First test the **final image with builtin seccomp**, using the same isolated
   settings below. If that passes, retain builtin; this candidate is unnecessary.
   If it fails for libraries, missing binaries, LSM, package version or another
   cause, resolve that separately. A syscall denial requires target evidence,
   not speculative permission expansion.
2. Fresh **read-only** facts on the Windows Docker host (no remote call is made
   by these scripts). Choose a new evidence filename:

   ```powershell
   .\collect-review-facts.ps1 -Container weiai-image2 -OutFile .\before.json
   ```

   Bring only that allowlisted JSON to the reviewer. On a machine with Python:

   ```sh
   python3 -B scripts/artcraft-sandbox-policy/policy.py preflight --facts /review/before.json
   ```

   This gate requires Docker 29.4.1's known source commit, exact WSL2 kernel,
   daemon builtin and known container default SecurityOpt. Unknown/custom policy,
   changed version/commit/kernel, extra capabilities or shared namespaces stop it.
   The T01 partial host file **cannot** satisfy this fresh gate. Passing preflight
   is not approval and does not authorize any mutation.
3. **After supervisor approval only**, select existing, reviewed paths/immutable
   image ID. Create a new empty evidence directory owned/writable by UID 1000;
   verify Windows/Docker bind permissions separately. Do not mount credentials,
   env files, a repo root, production data or Docker socket. The existing native
   image must contain the unchanged native tests and fixtures; missing tests are
   a failed gate. Illustrative PowerShell uses no host privilege escalation:

   ```powershell
   $PolicyRoot = (Resolve-Path '<reviewed-policy-directory>').Path
   $NativeBundle = (Resolve-Path '<verified-Linux-bundle-root>').Path
   $EvidenceDir = (Resolve-Path '<new-empty-UID1000-writable-evidence-directory>').Path
   $NativeImage = 'sha256:<reviewed-final-native-image-id>'
   $PolicyFile = Join-Path $PolicyRoot 'docker-29.4.1-bwrap.json'
   $Expected = '54445b51b34a5884dba65c7875995a0991402c5d46ca66df404690f968fb2ac4'
   if ((Get-FileHash -LiteralPath $PolicyFile -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Expected) { throw 'Policy hash mismatch' }
   $Common = @('--user','1000:1000','--cap-drop','ALL','--security-opt','no-new-privileges=true',
     '--network','bridge','--read-only','--pids-limit','256','--memory','2g','--cpus','2',
     '--tmpfs','/tmp:rw,nosuid,nodev,mode=1777,size=512m',
     '--tmpfs','/data/image2:rw,nosuid,nodev,noexec,uid=1000,gid=1000,size=64m',
     '--mount',"type=bind,source=$PolicyRoot,target=/policy,readonly",
     '--mount',"type=bind,source=$NativeBundle,target=/opt/artcraft,readonly",
     '--mount',"type=bind,source=$EvidenceDir,target=/evidence",
     '--entrypoint','/usr/bin/env')
   # First, builtin control. No --rm: retain container for readback.
   docker create --name t03-builtin @Common $NativeImage -i PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 HOME=/tmp node /policy/target-probe.mjs --run-reviewed-target --mode builtin --expected-policy-sha256 builtin --service-dir /app --output-dir /evidence/builtin
   if ($LASTEXITCODE -ne 0) { throw 'Builtin create failed' }
   docker start -a t03-builtin
   .\collect-review-facts.ps1 -Container t03-builtin -OutFile .\builtin-inspect.json
   # STOP and review control's exit/evidence. Do not execute the next block automatically.
   ```

   Only when the builtin result warrants a policy trial **and the supervisor has
   approved this exact candidate**:

   ```powershell
   docker create --name t03-candidate @Common --security-opt "seccomp=$PolicyFile" $NativeImage -i PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 HOME=/tmp node /policy/target-probe.mjs --run-reviewed-target --mode candidate --expected-policy-sha256 $Expected --service-dir /app --output-dir /evidence/candidate
   if ($LASTEXITCODE -ne 0) { throw 'Candidate create failed; no fallback' }
   docker start -a t03-candidate
   .\collect-review-facts.ps1 -Container t03-candidate -OutFile .\after.json
   ```

   No restart policy, published port, existing service replacement, external
   model call, daemon reload or security-policy fallback is included. Inspect
   exit codes and `target.json` even when `docker start -a` returns an error.
   Leave cleanup of these two named canaries to the supervisor after evidence
   retention. A pre-existing name causes creation to stop.
4. **Required pass criteria**: node and diagnostic worker cap sets zero;
   sandbox cap sets zero; different user/mount/PID/net namespace inodes;
   sandbox only loopback interfaces/addresses and no IPv4 route; parent localhost
   HTTP positive control succeeds and sandbox curl cannot reach it; own output
   persists; neighbouring reads fail and writes/absolute symlink escapes cannot
   change/create actual neighbouring files, including after a fresh sandbox.
   Private tmpfs writes to the same pathname may succeed and are explicitly
   distinguished from writes to actual neighbours. Synthetic provider env
   canaries exist in the diagnostic worker but are absent from the sandbox's
   exact env allowlist; synthetic outside credential marker is unreadable and
   unchanged. No real credentials are read. `/bin/true`, Node output, ffmpeg and
   pdfinfo succeed. Existing **13/13 real ArtCraft edit/export/reopen tests** pass
   with CPU-only receipts. Fixture tests or a simple `bwrap true` are insufficient.
5. Bind retained evidence on the reviewer's Python machine:

   ```sh
   python3 -B scripts/artcraft-sandbox-policy/policy.py bind \
     --before /review/before.json --after /review/after.json \
     --result /review/candidate/target.json --out /review/T03-bound-receipt.json
   ```

   This checks the inspected custom JSON against the full pinned profile, exact
   file hash in the probe, source/test/probe hashes, image/container identity,
   required settings and all result gates. It refuses unknown profiles, skipped
   tests and overwritten receipts. Receipt binds raw before/after/result file
   hashes and T01 hashes. This is an audit chain of trusted collected evidence,
   **not cryptographic kernel attestation**. No `seccomp=path` string/label alone
   is accepted as proof of the loaded policy; Docker inspect must expose matching
   embedded JSON. Preserve all evidence even if the gate fails.

Production activation, real service worker verification under final mounts,
resource limits/LSM and provider configuration, and T02 integration remain
separate supervised gates. Do not infer production acceptance from a canary pass.

## T04 integration additions (local candidate)

All five capability sets, including **CapBnd**, must be zero in node, worker and
sandbox. The collector and both candidate/service gates require actual integer
Memory=2147483648, NanoCpus=2000000000, PidsLimit=256; missing/unlimited/different
values fail. Rounded uint64 profile readback is a permanent negative case.
The worker observation source uses String.raw and is syntax-tested before target use.

`service-check --facts <facts> --layout <layout>` and `bind-service --before <before>
--after <after> --result <target.json> --layout <layout> --out <receipt>` add the
exact running-service contract. The layout binds role, imageId, policyMode,
network, dataVolume, nativeVolume and normalized policySource. Canary data and
network must be release-owned; production names are fixed. No service publishes
core ports. Standalone `gate` / `bind` still reject a named data volume.

The upgrade executor uses the same final service image, raw policy file, native
manifest and limits for canary and production. It uses this probe's native13
results once, then runs Chinese/Vector/HTTP/persistence supplements in that same
canary. Its candidate trial requires a root-reviewed actual builtin failure and
bwrap package provenance; the final gate requires reviewed target results.
See [the integrated runbook](../../docs/ARTCRAFT_NATIVE_UPGRADE.md). No production
policy approval is asserted by this lock or by local tests.
