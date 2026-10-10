# Scene, render and NR task contract

This extends the existing v3 API. Project JSON remains schemaVersion 3; SQLite user_version is 3, adding project_owners, job_actions and worker_versions without rewriting legacy project or job snapshots. Node 22.13+ is required.

## Access boundary

All gateway calls still require the server VIDEO_API_TOKEN bearer. The BFF signs a stable random visitor UUID in an httpOnly cookie and overwrites the outgoing x-studio-visitor-id header. The gateway trusts that header only after validating its server bearer and UUID syntax. Browser-provided visitor headers must never be forwarded verbatim.

A visitor can list/read/change only owned projects and their assets/jobs. Legacy unowned projects remain available to authenticated internal calls that omit the visitor header. They cannot be claimed by the first visitor. PUBLIC_DEMO_PROJECT_IDS explicitly allowlists read-only demonstrations: visitors can read the project, referenced media, script/review, and POST /projects/:id/copy. A copy gets a new project ID, new asset IDs over immutable content, cleared paid approvals/takes, and the visitor owner in one SQLite transaction. It preserves code-program provenance as an opaque historical pointer; copying does not authorize reading the original job.

No account-wide login, operator code, daily count or spend quota is added. Worker tokens are never returned to visitors. Reverting to an old gateway also removes visitor enforcement: rollback must restore the matching older web/BFF or isolate the visitor entry point, not leave the new public BFF pointing at an old gateway.

## New project routes

All responses use the existing `{data: ...}` wrapper. New submissions require `baseRevision` and `idempotencyKey` (1–170 chars). Repeating an accepted key returns the original task after project revision changes; changed request content with the same key is 409. New authoring intent requires a new key. Neither a retry nor an unknown acceptance creates an unbounded model loop.

- `POST /projects/:id/scene-generations`: `{baseRevision,idempotencyKey,film,prompt,referenceAssetIds?}`. `film` is one of `three-knocks`, `borrow-sunshine`, `last-seed-of-light`. Requires a 1440-frame, 24 fps, 16:9 project. The sole model is `claude-opus-5-5`; response model identity must match. At most four image references and 8 MB per request. The packaged engineering baseline and its hash are frozen with the request. Closed declarative JSON only; model changes are cameras/look/action timing within the registered story. Contact blocking is fixed.
- `POST /projects/:id/scene-generations/:jobId/apply`: `{baseRevision,commandId,scene}`. The client compiles the completed SceneProgram using the trusted shared compiler. The server verifies same-project completed job and exact program hash, validates scene/registered object/part identities, fills immutable provenance, then adds the scene, ten shots and eleven canvas cards with one CAS/undo command. The returned `{project,sceneId}` uses `code-<jobId>` as the scene ID. A late model result never silently replaces concurrent authoring edits.
- `POST /projects/:id/renders`: `{baseRevision,idempotencyKey,sceneId,sceneRevision,backends?:['three-webgl'|'remotion'],sceneGenerationJobId?}`. Returns `{jobs,renderGroupId}`, including for a single backend. A two-backend group is committed atomically as two independently cancellable tasks. The snapshot uses the current editable scene and its immutable codeProgram, not an old unedited job result. Ordinary director scenes are also accepted. The per-task frame bound is 1–7200; output is 24 fps, 1280×720 or 720×1280.
- `POST /projects/:id/enhancements`: `{baseRevision,idempotencyKey,sourceAssetId,sourceHash}`. The source must be an owned video with verified 24 fps, at most 7200 frames, and dimensions at most 3840 per axis. These are finite execution/transfer bounds, not visitor quotas. Fixed NR parameters: `stages:nr`, `preset:natural`, `passes:1`, `processingScale:100`, `frameGeneration:false`, `superResolution:false`. No caller-supplied source path, executable, script or arbitrary URL is accepted.
- `POST /jobs/:id/cancel`: durable cancel request. A disconnected worker remains cancelling/waiting until its terminal state is confirmed. A model request interrupted after submission becomes uncertain, not a safe-to-retry failure.
- `POST /jobs/:id/retry`: `{idempotencyKey}`. Explicitly retries safe failed/cancelled render/enhancement tasks using the same jobRef/inputHash and worker checkpoints. Duplicate action keys do not restart again. Model tasks with any paid attempt and all uncertain submissions reject this endpoint.
- Existing `GET /jobs/:id`, `GET /projects/:id/jobs` expose stage, progress, waitingReason, cancellable/retryable, sourceRevision, outputRevision, outputAssetIds, partialAssets, output and renderGroupId where relevant. Partial clean/shot assets are checkpoints; only a validated final base/enhanced video marks the task complete.

## Frozen RenderSpec and runtime

`spec` contains schemaVersion, backend, original backends array, renderGroupId, projectId/sourceRevision, sceneId/sceneRevision, fps/width/height/totalFrames/seed, sceneSnapshot, optional sceneProgram/provenance, sceneSnapshotHash, renderProfile/renderProfileHash, frozen audio/text sequence and immutable asset descriptors. specHash excludes backend/backends so a paired comparison has a shared exact source hash. inputHash includes the per-backend task input.

runtimeHash freezes the procedural constructors/render toolchain. The first task requires a successful worker capability hash; later offline submissions can use a previously verified hash persisted under that exact worker origin. A different runtime version must be refused, not silently substituted. Worker completion also reports and matches runtimeHash. Changes to frames, materials, objects, tracks, cameras, audio or captions require a new render request.

Code-scene object/part registration is generated from the trusted shared compiler into code-scene-registry.json. Ordinary imported parts still require actual GLB metadata. Unknown code-scene object IDs and external GLB buffer/image URIs are rejected before a worker call. Regenerate the registry and refresh the schema/engineering baselines when changing the shared compiler; verify all three compiler snapshots through validateProject before shipping.

## Worker transport

Configure STUDIO_CODE_WORKER_URL and STUDIO_CODE_WORKER_TOKEN; the token explicitly falls back to STUDIO_WORKER_TOKEN. The code worker is distinct from the legacy Blender endpoint. The worker serializes the shared GPU itself.

- `GET /api/v3/code/capabilities`: `{available,runtimeHash,renderers:{'three-webgl':{available,reason?},remotion:{available,reason?}},dlss:{available,reason?}}`. Installed configuration alone must not claim a usable interactive NR desktop.
- `POST /api/v3/code/jobs`: `{jobRef,inputHash,kind:'render'|'enhancement',spec,assets:[{id,hash,mime,base64}]}`. Assets are bounded, owned and SHA-verified before transfer. Worker persists acceptance before returning and treats same jobRef/hash/body as idempotent; conflicting content is 409.
- `GET /api/v3/code/jobs/:jobRef`: `{jobRef,inputHash,status:'queued'|'running'|'complete'|'failed'|'cancelled',stage,progress,outputs?,receipt?,waitingReason?,error?}`. Unknown IDs return 404. Polling/recovery first reconciles a lost acceptance response by the same ID; only a definite 404 permits the same idempotent worker POST again.
- `POST /api/v3/code/jobs/:jobRef/cancel`: `{inputHash}`; same identity/status receipt.
- `POST /api/v3/code/jobs/:jobRef/retry`: `{inputHash,retryKey}`; deduplicate retryKey, preserve completed frame/shot checkpoints, never overwrite an already published artifact with different bytes.
- `GET /api/v3/code/media/:jobRef/:name`: bearer-protected immutable media. Each output is `{name,mime,sha256,bytes,url,role,frameStart?,frameEnd?}`. Roles include clean/base/enhanced/comparison/shot/thumbnail/audio. Receipt JSON belongs in the top-level receipt, not a media output.

Every receipt must match jobRef/inputHash; all output locations are validated as an exact filename under the configured worker origin/job namespace before downloads. The gateway then verifies bytes/SHA and actual ffprobe frame count, rate, dimensions and duration. Side-by-side comparison is twice the source width. Checkpoint asset insertion, project revision and job output ledger commit in one transaction. A lost response or restart does not duplicate a checkpoint.

## Model execution and recovery

The model request body hash and credential-free route/reference receipt are stored before POST. Raw returned content and provenance are checkpointed before validation. Only a known completed but invalid JSON/schema response can enter a repair stage: at most two additional calls, with the same provider route and model. Unknown transport acceptance or a process restart during submission becomes uncertain and is never automatically resubmitted. A valid response recovered from SQLite is validated without another model call. A different or unreported actual model fails instead of falling back.

All job kinds have explicit dispatch; an unknown kind fails and cannot fall into FFmpeg export. Retry/cancel actions are independently durable. Existing generation, Blender preview, export and archival behavior is retained; new renderer checkpoints are not accidentally sent through the old single-video NAS archiver.

## NR completion and audio/caption preservation

For a code-render base asset, enhancement follows its trusted completed render job to the clean pre-caption video, and freezes cleanSourceAssetId/cleanSourceHash plus the original RenderSpec/audio assets. sourceAssetId/sourceHash continue to identify the user-selected base video. Uploaded or legacy clips without a clean checkpoint use their original pixels and record burnedTextWillBeEnhanced=true.

A complete NR receipt must match original source, actual neural input hash, runtimeHash, fixed parameters, the pinned converter executable and NR DLL hashes, and Feature18 created/evaluated evidence. Intermittent log counts are not reported as a verified full-frame count; verifiedNeuralFrames may be null. The enhanced final video must preserve the original source AAC packet hashes when audio exists. Subtitles/music are restored after NR for clean render inputs. Missing or mismatched evidence fails before importing a purported final enhanced artifact.

## Verification

Run from repository root:

```sh
STUDIO_TEST_CJK_FONT='output/story-films-20261001/execution/font-recovery/fonts/NotoSansCJK-Regular.ttc' node --test gateway/studio/*.test.mjs
```

New tests are in code-tasks.test.mjs; full local output is evidence/code-tasks-full-20261002.tap. They use isolated SQLite, fake HTTP model/worker responses and real local FFmpeg/ffprobe for timing and AAC identity. They do not call paid models, run remote GPU work or prove production deployment. Real model, shared-renderer pixel equivalence, Windows interactive NR, browser ownership/copy UX and deployed version checks remain separate integration evidence.


## Effects tasks (2026-10-08)

`POST /projects/:id/effects-plans` accepts `{baseRevision,sourceAssetId,sourceHash,prompt,idempotencyKey}`. The selected MP4 must be a completed Mode 3 `base`, `enhanced` or `effects` output with trusted server provenance; comparison/clean/shot outputs and uploaded metadata claiming another job are rejected. Source limits are 24 fps, 1–7200 frames, even dimensions 16–2560 and at most 3.7 megapixels. The source bytes are hashed, real timing is probed, and up to six actual JPEG frames (at most 640×360) are checkpointed before calling exactly `claude-opus-5-5`. The model returns the closed EffectsProgram JSON contract; no arbitrary code, media URL or After Effects executable is run. A complete plan exposes `output.effectsProgram` and `output.effectsProgramHash`, plus the exact selected source identity. Planning never replaces the source asset.

`POST /projects/:id/effects-renders` accepts `{baseRevision,planJobId,planHash,sourceAssetId,sourceHash,idempotencyKey}`. It requires a completed plan in this project, the same source identity and canonical program hash, then freezes the worker runtime and immutable spec. Effects plans default to `autoRender: true`: the gateway persists the orchestration intent, creates the single associated render after planning, and scans completed plans with pending handoff after a restart. A temporarily unavailable worker leaves a durable waiting stage with backoff. Browser closure does not interrupt this handoff; the UI submission remains only an idempotent fallback. There is no extra approval endpoint. Every request for the same plan, including different keys or failed/cancelled existing jobs, resolves to the original render job. Recovery uses the existing `/jobs/:id/retry` action. Job top-level `planJobId`, `planHash`, `sourceAssetId`, and `sourceHash` survive every state; completion keeps those bindings in `output`.

The worker receives `kind: effects-render` through the existing code-worker protocol. It returns exactly one `effects` MP4 and one `comparison` MP4, with the comparison twice the source width. Receipt runtime/source/program identities, media SHA/bytes, exact fps/frame dimensions and original audio packet/timeline hashes are validated. Each result is a new asset with source `effects-compositor`, role metadata, `effectsProgramHash`, `planJobId`, and the original source asset as parent. The original bytes, subtitles, other assets and selected timeline version are not overwritten. Normal user actions can explicitly select a new version later.

Effects planning uses the same known-invalid-only maximum two repairs as scene generation. Submissions are persisted before POST; unknown acceptance, unreadable success or restart during submission becomes `uncertain`, with no automatic or explicit retry of a possibly accepted model call. A stored valid response is validated without another request. Provider usage is a receipt, not a bill or refund confirmation; this implementation has no refund API and never infers that a failed or cancelled job was refunded.

Schema 4 adds only `asset_origins`, populated by server-side project copying; all existing rows, owners and idempotency receipts are retained. New demo copies can trace the original immutable output. Older copies without trusted copy receipts are not silently adopted: render again or copy a current example. `capabilities.effects` exposes `{available,model,reason}` and requires both configured LLM and real worker effects capability. Existing anonymous ownership and trusted internal-token behavior are preserved.

Tests: `node --test gateway/studio/*.test.mjs`; set `STUDIO_TEST_CJK_FONT` to the existing test TTC for the optional actual Chinese glyph oracle. Effects tests use isolated SQLite and HTTP fixtures, synthetic local FFmpeg media and fake model/worker replies; they do not submit paid requests or deploy production.

Cancellation refinements: a completed plan waiting for its automatic handoff remains cancellable. It becomes `cancelled`, retaining its paid program; `/jobs/:id/retry` on this specific case only resumes the free handoff. It never returns to model submission. If the worker completed before cancellation arrived, the gateway exposes `recovering_completed_output` / `cancellationTooLate: true`, disables retry, and downloads the original immutable output instead. Unknown-worker cancellation uses a persistent input-hash tombstone; an explicit retry can return `requiresSubmission: true`, allowing only the original frozen spec with the same job ID to be accepted. The old retry key cannot reactivate a newer cancellation.
