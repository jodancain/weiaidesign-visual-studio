# Existing Web + image2 → ArtCraft upgrade

T06 is a **local integration candidate**, not a production acceptance receipt. Production stages require root review receipts; local tests do not establish target success. The executor upgrades only `weiai-image2` and `weiai-studio-v3-web` on Windows `AI`, user `qrrwi`, under `C:\Users\qrrwi\studio-v3-production`. It never invokes Compose or the first-install script.

## Fixed scope

- Keep Web UID/root, its current security profile, storage format and `weiaidesign-web_weiaidesign-data:/data`. Old `weiaidesign-web:18191` continues using that volume. No shared Web backup, restore, ownership migration or exclusive-writer gate exists in this route.
- The authoritative consistent backup covers **the entire stopped-worker `weiai-image2-data` volume**, including SQLite/WAL/SHM/assets. Restore proof uses a new release-owned copy, full file hashes, SQLite integrity/foreign keys, schema/table/row fingerprints and asset hashes. Neither production volume is ever a restore destination.
- Canary Web uses a **new empty independent volume**, synthetic visitors/assets and `127.0.0.1:18199`. Windows listeners and every Docker published binding, including stopped/IPv6 containers, are checked. Existing 18196–18198 canaries and all unrelated services are left alone.
- Canary core uses the restored image2 copy, an internal release network, synthetic internal credentials, no configured external adapters and no published core port. An additional native-binary volume is hydrated from the verified archive with Linux tar, preserving executable modes with `--strip-components=2 ./bin`; target GNU tar and all 13 executable ELF64 x86-64 files, sizes, hashes, commits and manifest are checked at final `/opt/artcraft` before hydration succeeds.
- Core canary and production use the same final image, bundle, policy and **2 CPU / 2 GiB / 256 PID**, UID 1000, cap-drop ALL, no-new-privileges, read-only rootfs, private `/tmp` tmpfs (1 GiB), own writable data and read-only policy/native mounts. No privileged, unconfined, SYS_ADMIN, host network or sysctl path exists.
- Full native13, Chinese, vector, confinement, HTTP/persistence and old-reader compatibility tests run on the target canary. Production runs only short isolation + Vector save/reopen, followed by BFF readback. **No full suite runs after opening entry.**

## Source and immutable identity

Source identity is the root-reviewed commit plus exact per-file manifest. The archive manifest records every included file hash separately from HEAD. Packaging automatically includes all upgrade/policy/ops/tests roots, including future helpers, and excludes `.env`, private/key paths, dependencies, runtime data, raw task reports and test logs.

Native archive: 512742646 bytes, SHA256 `2b3f7753d2a6eb4d0b80d2eb1bb105fd53c1862b6bdfcdacee31c7aa8b9a1a36`. Native manifest: `8e050bb717ab92246fec121a4e8bff45e328c1b9ff0994b015fc99c2dcc45509`.

T01 original core ID: `de24db0228b5bf1716d4e23e7e3c349d929970185983d26fa35671b3cedc0320`; image `sha256:a1d3f8c214b24b5b8d8665b5f3f9fe6c02cc5d0331326080e706b80952a4f050`.

T01 original Web ID: `c5259a425393a5c6a082f63897935416ee88f3a5b9fade85db1edd2698611fc3`; image `sha256:1350a3461ccc9580b9b399fab36281d4ff8f8284c19a72967af8a9c1c722a071`.

Production network `weiai-studio-v3-production` ID: `8ebd14998cd0a5754a93dad6a40db359af60e18b2b36f3749460197b9e6eb84f`. Preserve alias `image2`, both original 18194→18084 address bindings and restart policies. Inspect and each transition recheck runtime facts; historical evidence is not a current-state guarantee.

After root reviews the final source, freeze locally (does not build or commit):

```sh
python3 scripts/artcraft-upgrade/package.py --output ../output/artcraft-native-20261014/upgrade-t04-source.tar.gz
```

Retain archive SHA256, source-manifest SHA256 and HEAD from its receipt. Transfer/extract separately under the existing authorized production procedure; do not invent or substitute digests. The bootstrap directory must be the exact extracted archive, including `UPGRADE-SOURCE.json`.

Example frozen plan, with the two packaging receipt values filled in:

```json
{
  "ReleaseId": "20261014-native-t04",
  "SourceCommit": "c178faee15ebabae4570efe632d93c9a83eeb700",
  "SourceArchive": "C:\\Users\\qrrwi\\studio-v3-production\\inbox\\upgrade-t04-source.tar.gz",
  "SourceArchiveSha256": "<local packaging receipt>",
  "SourceManifestSha256": "<local packaging receipt>",
  "NativeArchive": "C:\\Users\\qrrwi\\studio-v3-production\\inbox\\artcraft-complete-linux.tar.gz",
  "ExpectedOldCoreId": "de24db0228b5bf1716d4e23e7e3c349d929970185983d26fa35671b3cedc0320",
  "ExpectedOldWebId": "c5259a425393a5c6a082f63897935416ee88f3a5b9fade85db1edd2698611fc3",
  "ExpectedOldCoreImage": "sha256:a1d3f8c214b24b5b8d8665b5f3f9fe6c02cc5d0331326080e706b80952a4f050",
  "ExpectedOldWebImage": "sha256:1350a3461ccc9580b9b399fab36281d4ff8f8284c19a72967af8a9c1c722a071",
  "ExpectedNetworkId": "8ebd14998cd0a5754a93dad6a40db359af60e18b2b36f3749460197b9e6eb84f",
  "PolicyMode": "candidate",
  "PolicySha256": "54445b51b34a5884dba65c7875995a0991402c5d46ca66df404690f968fb2ac4"
}
```

`candidate` selects a proposal, **not approval to apply it**. A builtin plan uses `PolicyMode=builtin`, `PolicySha256=builtin`; changing a frozen plan requires a new release. Source/runner/helper/gate/probe/policy/lock bytes are frozen before task submission mutations and rechecked before executor ACL, state, lock or Docker mutations. Source/native archive digests are also checked before executor mutations. The seccomp file goes directly to Docker as `--security-opt seccomp=<path>`; never parse/rewrite it with PowerShell or JavaScript numbers.

## Actual shutdown and observed legacy idle

There is no external admission receipt or operator reopening step. Three retained canary Webs target the production Core; their identities/destinations are inventoried and they remain running unchanged. **Core startup reopens all these callers immediately**, before the replacement primary Web starts.

Before either image2 snapshot, verify the exact running old Core ID/image and SHA256 of `/app/server.mjs` (`c20f9d762ecdd7398b104ac5d79e25fa2bdb5a5e0d6d7ca9ec836bb776d72fc0`) and `/app/jobs.mjs` (`cdf7bfa9c3ca74e81c33d70d003fa5c69081bb9958030f98af44b056a7b7b24e`). The independent shutdown audit established `server.close → runner.stop(activePromises) → store.close → exit(0)` and original-ID recovery with uncertain submission guards.

The executor requires zero active ledger records and preserves unchanged historical uncertain fingerprints, disables restart for the exact Core, sends `docker kill --signal=TERM <exact-ID>` and polls the same process start/exit identity for at most 180 seconds. It never uses `docker stop`: the old container has StopTimeout=1. Timeout leaves a pending receipt. Recovery continues a bounded wait and reconciles a late exit by exact ID/image/StartedAt/FinishedAt; a successful intentional restart is separately recorded. Restart drift, OOM or any exit other than 0 fails the drain; no timeout SIGKILL is issued or accepted. The normal-exit receipt and **offline post-closure ledger with zero queued/running work and unchanged historical uncertain receipts** bind the full image2 backup. New or changed uncertain fingerprints also abort promotion and preserve the records. If a queued race appears, restart only the original Core to recover original IDs, preserve receipt bytes, and stop deployment. Prepare does not stop any Web.

Cutover additionally scans the target Web's configured `/data/generated_images/_jobs` **and** `_ontology` before and after graceful Web SIGTERM. Image queued/running and ontology anchoring or generating anchors postpone the stop. Gateway video jobs with durable `video_job_id` continue independently even while display states remain generating/queued/running; they are inventoried, not blocked. Next's graceful exit (0/143) only waits HTTP/registered cleanup; the legacy `void` Promises have no reliable shutdown hook. The two scans are **bounded observed-idle evidence, not atomic admission or per-process attribution**. The shared 18191 writer remains live and untouched. Late unfinished receipts are preserved, the appropriate Web is restored, and uncertain interruption is reported; restarting Web does not resume those Promises and no paid job is automatically repeated.

The short production native smoke uses isolated scratch data and permits concurrent real jobs. Rollback retains the new Core/volume as soon as a candidate Core exists, including start-command timeouts. Healthy active Core workers are never stopped for rollback: restore the tested compatible old Web while new jobs continue. If the new Core cannot run, preserve its volume/records and report the concrete failure for root review; do not overwrite production data or start the old worker against newer records.

## Target policy and acceptance

The authoritative lock now uses successful `T01-host-metadata.json`, `T01-targets-152832.json` and runtime evidence. Docker 29.4.1 **Server.GitCommit**, kernel, builtin baseline, actual SecurityOpt, limits, mounts and bwrap binary/package source still require fresh target proof. The candidate preserves 31 Docker baseline rules and adds only 12 reviewed rules; its uint64 mask is never float-reserialized. The exception applies container-wide, not only to bwrap setup. See [policy details](../scripts/artcraft-sandbox-policy/README.md).

On a candidate plan, the first Canary invocation runs the final image under builtin seccomp on a separate synthetic service volume, retains its result and **stops before loading the candidate**. If builtin passes, review a builtin plan. If it fails, root reviews the actual failure and installed bwrap package source before creating a candidate-trial gate:

```json
{
  "ReleaseId": "20261014-native-t04",
  "NewCoreImage": "<state.NewCore>",
  "PolicySha256": "54445b51b34a5884dba65c7875995a0991402c5d46ca66df404690f968fb2ac4",
  "ControlReceiptSha256": "<state.BuiltinControl.ReceiptSha256>",
  "CandidateTrialApproved": false,
  "PolicyFailureCauseReviewed": false,
  "BwrapPackageSourceReviewed": false,
  "Reviewer": "<root reviewer>",
  "ApprovalReference": "<actual target review>"
}
```

Resume Canary with a new invocation and this gate. The final canary's T03 probe proves all capability sets (including CapBnd) zero for node/worker/sandbox, namespaces/network/neighbor/symlink/credential isolation, actual bwrap hash and the real native13 suite. `bind-service` verifies the exact service mount/network contract separately; standalone `bind` still refuses service volumes and published ports. The supplemental native helper runs ldd, confinement, Chinese/Vector and HTTP/persistence suites, **reusing T03 native13 instead of repeating it**. Accepted synthetic checkpoint/output BFF hashes and service restart/reopen are verified. Old image import-only compatibility is checked on another copy without starting its worker.

Python3 in the native overlay is used only for exact offline policy/uint64 validation; it adds no model integration. Full tests remain canary-only. Missing package support or syscall/LSM differences fail closed, with no automatic policy widening.

Root must also exercise the **original homepage** on 18199 using synthetic save/import/export, native acceptance/reopen, refresh/recovery and downloads. API tests do not certify the UI.

The Cutover gate binds `ReleaseId`, `PlanSha256`, `NewCoreImage`, `NewWebImage`, `CanaryBuildId`, `NativeReceiptSha256`, `PolicyReceiptSha256`, `PolicyMode`, `PolicySha256`, `BwrapSha256`. It requires true booleans `OriginalHomepagePassed`, `CanaryEvidenceReviewed`, `CompatibilityLimitationsAccepted`, `TargetPolicyEvidenceReviewed`, `CutoverApproved`, plus `Reviewer`, `OriginalHomepageEvidence`, `ApprovalReference`. Fill values from state/evidence after review. No obsolete post-entry full-test approval exists.

## Exact next target commands — one reviewed phase at a time

First run syntax/mock tests on **Windows PowerShell 5.1**, check host/storage headroom, scheduled interactive qrrwi identity and Docker access. Do not run the whole block as a batch. The bootstrap below is the exact source archive extracted into a fresh directory after its digest is verified.

```powershell
$bootstrap='C:\Users\qrrwi\studio-v3-production\inbox\t04-review'
powershell.exe -NoProfile -File "$bootstrap\tests\artcraft-upgrade\orchestration.ps1"
$task="$bootstrap\scripts\artcraft-upgrade\task.ps1"
$plan='C:\Users\qrrwi\studio-v3-production\inbox\plan-native-t04.json'
& $task -Mode Submit -PlanPath $plan -Phase Inspect -InvocationId inspect01
& $task -Mode Status -PlanPath $plan -InvocationId inspect01
```

Inspect checks exact original identity and verifies a **real nonempty ordinary asset download before any cutover**. Uploaded assets need not be on the canvas: witness carries an explicitly associated ID, byte count and SHA256. An empty/malformed/missing asset cannot become a late success or vacuous readback.

```powershell
& $task -Mode Submit -PlanPath $plan -Phase Prepare -InvocationId prepare01
& $task -Mode Status -PlanPath $plan -InvocationId prepare01
```

Prepare builds only base/native/Web, hydrates the independent bundle volume, collects policy baseline facts, then makes the stopped-worker image2 backup/restore proof. Finally it restores the original Core restart policy and starts it, reopening its callers; Web stays live throughout Prepare.

```powershell
& $task -Mode Submit -PlanPath $plan -Phase Canary -InvocationId canary001
& $task -Mode Status -PlanPath $plan -InvocationId canary001
# Candidate plan: only after reviewing the builtin control failure:
& $task -Mode Submit -PlanPath $plan -Phase Canary -InvocationId canary002 -GateReceipt 'C:\Users\qrrwi\studio-v3-production\inbox\policy-trial-t04.json'
& $task -Mode Status -PlanPath $plan -InvocationId canary002
```

After target policy, full canary, copied-ledger compatibility and original homepage review:

```powershell
& $task -Mode Submit -PlanPath $plan -Phase Cutover -InvocationId cutover01 -GateReceipt 'C:\Users\qrrwi\studio-v3-production\inbox\gate-native-t04.json'
& $task -Mode Status -PlanPath $plan -InvocationId cutover01
```

Cutover takes a fresh image2 backup, retains the old pair with restart `no`, starts the exact new core, performs short isolation/save/reopen and then starts matching Web. Successful local BFF and BUILD_ID checks set **EntryReady**. Core consumers were already reopened when the new Core started. Submit concise public readback:

```powershell
& $task -Mode Submit -PlanPath $plan -Phase Readback -InvocationId readback1
& $task -Mode Status -PlanPath $plan -InvocationId readback1
```

Readback verifies the four public domains, homepage JS identity, signed visitor ownership, capabilities, document and nonzero/hash-equal assets. It does not generate or automatically roll back on failure. `CutoverComplete` requires this receipt.

## Completion and data-preserving recovery

Tasks run detached through Windows Scheduled Tasks, under interactive qrrwi. `Submit` means scheduled only. `Status` requires **both** completion `ExitCode=0` and Task Scheduler `LastTaskResult=0`; Ready or missing receipt is not success. Pre-mutation hash rejection may have no completion receipt and is reported failed. Each invocation has immutable request/completion JSON; state writes are atomic/flushed, pending operations are recorded, and a host file lock serializes execution. Commands have a bounded 90-minute wait; timeout is an uncertain execution, never automatic replay.

A failed cutover recovers by exact IDs; once a new Core exists, recovery preserves it and swaps only Web. Root-directed rollback uses:

```powershell
& $task -Mode Submit -PlanPath $plan -Phase Rollback -InvocationId rollback01
& $task -Mode Status -PlanPath $plan -InvocationId rollback01
```

A healthy new Core remains running with all accepted records and active jobs while the exact old Web is restored. A stopped new Core is started against its own existing volume; inability to recover is a concrete root-review block. Only a cutover that never created a new Core may return the exact old pair. No production volume is ever restored from an archive. The old UI fallback does not provide native editing UI. Retained containers/canaries are not automatically cleaned up.
