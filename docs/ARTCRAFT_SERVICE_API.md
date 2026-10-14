# ArtCraft native project service

Native files remain separate from the image layer tree. Each native project belongs to one ImageDocument and inherits its signed visitor authorization. The ordinary image2 internal token is required; the browser uses the existing BFF.

All routes below are relative to `/api/v3/image2/documents/:documentId/craft` and return the existing `{data: ...}` envelope.

| Route | Request / result |
| --- | --- |
| `GET /capabilities` | Actual binary/hash/sandbox/protocol availability and native command/tool catalogs for 13 engines. Unavailable engines are explicit. |
| `GET /projects` | Native project array. |
| `POST /projects` | `{engineId,name?,idempotencyKey,initialAssetId?}` → project at revision 0; an imported bundle adds `importJobId` for the real reopen/inspect/preview candidate. |
| `GET /projects/:id` | Native project, accepted immutable checkpoint reference and `latestOutput` when available. |
| `GET /projects/:id/revisions` | Accepted native revision snapshots. |
| `POST /projects/:id/restore` | `{revision,baseRevision,idempotencyKey}` → new history candidate; accepting adds a revision without rewriting history. |
| `POST /assets` | `{name,mime,data}`; base64 native/media/image upload, maximum 64 MiB. |
| `POST /jobs` | `{projectId,baseRevision,steps:[{command,args}],inputAssetIds?,idempotencyKey}` → persistent job. |
| `GET /jobs`, `GET /jobs/:id` | Job array / job, candidate files, structured native state and processor receipt. |
| `POST /jobs/:id/cancel` | Stop queued/running native work; preserve existing receipts. |
| `POST /jobs/:id/retry` | `{idempotencyKey}` explicitly retries a failed/cancelled request from its frozen original input and base revision. |
| `POST /jobs/:id/accept` | `{baseRevision,idempotencyKey}` accepts one completed native candidate; conflicting candidates remain available. |
| `POST /jobs/:id/discard` | Discard an unaccepted completed candidate; immutable artifacts remain available. |

Input file parameters use `{assetId:"registered-id"}` and must also be listed in `inputAssetIds`. Output paths use `{outputName:"result.png"}`. The runtime substitutes managed paths and validates the discovered native schema/command allowlist. Arbitrary filesystem paths, environment, shell, network and scripting are not exposed to the model. Unknown native formats are downloaded as `application/octet-stream`; known images/PDF/fonts and playable media signatures are checked.

Jobs execute in isolated workspaces from the last accepted immutable checkpoint. The checkpoint bundles native state and managed media/library inputs and exports. Closing a browser does not cancel them. Interrupted native CPU jobs replay in a fresh isolated workspace from their frozen base; there is no external charged model submission in this replay. Outputs are registered only after a full checkpoint is available. The service is intended to run as one worker instance per SQLite volume, matching the existing image job runner.

The existing six-round Agent protocol exposes `craft_capabilities`, `craft_execute` and `craft_restore`. `craft_capabilities` with `projectId` lists the branch and frozen source history; `craft_restore` selects `history: "source" | "branch"` and a revision. Source native versions are frozen before the first Agent context is sent. Agent native edits first advance native projects on the task branch. Accepting the image candidate checks and promotes native changes in the same SQLite transaction; either image/native conflicts roll both back. Pending or unaccepted native candidates block whole-branch acceptance. Native-only results include actual preview/output references instead of relying on an empty image preview. `latestOutput.sourceJobId` and `sourceDocumentId` preserve the real source branch identity after promotion.

Persistent undo/redo uses revision restoration. Native `edit.undo` only has the current native process's undo stack; it does not restore prior jobs. A revision without a checkpoint cannot be restored. Restoring a checkpoint performs no model calls, produces a candidate, and leaves the current project unchanged until acceptance.

To continue editing a downloaded `.craftbundle`, upload it through `/assets`, then create a project with that owned `initialAssetId`. The service validates engine identity, hashes, managed paths and size limits before creating the project. It then runs the real engine to reopen, inspect and save the project, requiring an actual preview when that engine provides preview capability. `pendingImportAssetId` blocks ordinary edits until this candidate is accepted; a failed import retains the source bundle for explicit retry. This protocol is distinct from feeding a bundle into native `doc_open`, which expects its own native format.

The ordinary V2/V3 `.image2.zip` project package includes an optional `manifest.craft` version-1 extension. Export submission freezes the native projects, complete accepted revision tree, source receipt summaries and transitive immutable asset dependencies in the same transaction as the image snapshot. Required native exports are included even when their role is `export`; a later native edit cannot change a queued export. The extension is bounded to 100 projects, 2,000 native revisions/receipts and 2 MB of metadata, within the existing archive asset/byte limits. Oversized projects fail explicitly instead of dropping native history.

Project-package import checks engine identities, checkpoint integrity, managed paths and all asset references before writing. Image/native histories and new asset, project and receipt IDs are committed together under the importing visitor. Canvas native references are remapped, and `metadata.craftImport` retains the mapping. Historical native receipts are marked `importedSource`; accepted history stays available, while pending/unknown/unaccepted source work becomes a cancelled archival receipt. Import never executes or automatically retries it. An unfinished native-bundle import retains its original asset as provenance without becoming an accepted checkpoint. Missing engine binaries do not prevent safe package storage; actual subsequent edits still require installed capabilities. Old image packages without the extension remain compatible.

Individual `.craftbundle` exports remain useful for transferring one native checkpoint. Placing a PNG/SVG native export on the original image canvas creates an export snapshot with native provenance, not an editable native application object.

## Validation

- `node --test services/image2/tests/craft-service.test.mjs`: synthetic runtime tests for ledger, idempotency, owner isolation, source freezing, restart, cancellation, branch transactions and HTTP/Agent contracts. These do not establish native engine implementation parity.
- `IMAGE2_CRAFT_REAL_BIN_DIR=/path/to/verified/bin node --test services/image2/tests/craft-service-native.test.mjs`: real PhotoCraft process and OS sandbox, HTTP upload/edit/accept, service restart/reopen, existing Agent protocol calling the real native engine, persistent history candidate acceptance, and downloaded bundle import into a fresh document followed by another edit. It checks exact decoded pixel recovery, actual import preview and no duplicate acceptance. The LLM response is synthetic; this does not claim a live provider conversation.
- Runtime tests separately verify native bundle integrity, path/command isolation and protocol behavior. Every additional engine still needs an actual binary round trip and relevant visual/structured result checks; catalog presence alone is not feature acceptance.
- `node --test services/image2/tests/craft-package.test.mjs`: V2/V3 complete native history, frozen queued exports, cross-visitor import, mapped canvas references, cancelled source receipts, rejected malformed/out-of-package references, branch-only dependency closure and native task enqueue isolation. The real PhotoCraft integration also checks whole-image-project import by a new visitor, continued editing and native history restoration with exact RGBA equality.
