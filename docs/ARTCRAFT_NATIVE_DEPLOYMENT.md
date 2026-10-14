# Native engine build and optional Linux deployment

Local macOS native tests do not establish Linux compatibility. The Linux workflow and optional container overlay below are preparation, not a recorded successful Linux build, sandbox run or production deployment.

## Build provenance

`services/image2/craft-engines.lock.json` pins each upstream source commit and Rust **1.98.1**. Install that toolchain explicitly (`rustup toolchain install 1.98.1`) before invoking `node scripts/build-craft-engines.mjs`. The script checks clean source and the exact remote/commit, uses Cargo's locked dependencies, rejects tracked source changes during compilation and publishes binaries by atomic rename. The manifest records binary SHA-256, byte length, platform/architecture, compiler details, Cargo version, profile/features and source/Cargo lock hashes. `bin/licenses` includes upstream/dependency notices and font/asset license files identified in source, plus dependency metadata.

The same lock pins `storytold/craft-fonts` at `3d9ab3a132ed0eff457e424226a435a901da30d3`. Install the image service dependencies before building; the font input validator uses its font parser. The build validates each font SHA-256 and OFL notice, and verifies actual outlined glyphs for `中文海报标志设计矢量编辑` in the pinned Noto Sans CJK SC file. It creates a separate input directory and sets absolute `CRAFT_FONTS_DIR`, `CRAFT_FONTS_REQUIRED=1` and `FIGCRAFT_EMBED_CJK=1`. No upstream font bytes are changed. This pinned font repository has no optional `latin-manifest.txt`; the derived input adds an explicitly empty/comment-only file for FigCraft's strict parser. That transform, original manifests, hashes, attribution and licenses are recorded in `bin/licenses/craft-fonts/PROVENANCE.json`. The empty list does not count as Latin or Chinese glyph coverage.

### Chinese coverage boundaries

Font-file verification and successful compilation do not establish native text rendering in every engine. The pinned source has these differences:

| Engines | Pinned source behavior |
| --- | --- |
| Photo, Vector, Film, Light, Design, Word | Native font build reads the shared manifest, including the Simplified Chinese face; Word additionally requires a `Hans` face in strict builds. Actual native previews/exports still need Chinese samples. |
| Fig | Embeds `Hans` only with `FIGCRAFT_EMBED_CJK`; the build enables it explicitly. |
| PDF, Deck, CAD | Their build scripts deliberately exclude Noto CJK/Source Han families. Shared font input alone does not establish Chinese content support. PDF's current `page_add_text` native path is limited to WinAnsi built-in fonts; use the existing Image2 text/PDF export path for Chinese instead. |
| Effect | Text font resolution uses system fonts and an optional engine font directory rather than this build input. Verify the fonts actually visible inside the sandbox. |
| Sound, Grid | No shared-font embedding build input was found in the pinned native pipeline; native data/structured results and any text rendering are separate checks. |

The optional Linux container installs Noto CJK system fonts, but individual engines may still filter families or use different renderers. macOS system fallback success is not evidence that the Linux container or a font-embedded rebuild passed. Preserve per-engine Chinese text, native checkpoint reopening, preview and export evidence rather than claiming blanket Chinese support.

This is rebuildable provenance, not a promise of byte-identical output across SDKs/linkers/OS releases. Build on the target host; the script rejects `CARGO_BUILD_TARGET` so a cross-compiled binary cannot be mislabeled as the build machine's platform. Build into a new versioned directory. Do not run concurrent builds against one output directory or modify a bundle while a service is using it. Deploy the completed bundle read-only. The runtime verifies pinned source, platform/architecture and actual binary bytes before launch; incorrect bundles remain unavailable.

The manually dispatched `craft-native.yml` workflow offers separate macOS and Ubuntu Linux runners. The `all` selection expands the pinned source lock into 13 independent engine jobs, with at most three running concurrently; selecting one engine creates one native job. Each engine has its own 120-minute budget, and a failed engine does not cancel the remaining verification jobs. Rust is pinned; Linux installs build headers and bubblewrap. Both runners install ffmpeg/ffprobe as an external media verification oracle, not as a privileged native-engine tool. Artifacts include both the tested platform and engine in their names; each binary artifact contains that engine, its manifest and licenses, not the complete suite.

Every selected engine must pass its real native checkpoint round trip. PhotoCraft also runs the persistent service, Agent protocol and project-package reimport test. PhotoCraft and VectorCraft run actual Chinese glyph and checkpoint pixel checks; VectorCraft additionally records dots, holes and thin-line tracing measurements. The tracing report measures fidelity and does not claim pixel-perfect tracing merely because the command completed. Verify each required engine's result and artifact separately before assembling a production suite. A macOS artifact cannot be mounted into Linux as a working engine suite. These workflow definitions do not constitute a successful Linux run; start with a separate Linux PhotoCraft verification and retain its actual evidence.

## Optional container setup

The ordinary `services/image2/Dockerfile` and `compose.yml` continue to support the existing image service without native binaries. They do not, by themselves, install bubblewrap or enable ArtCraft. The optional `Dockerfile.native` adds the Linux sandbox, font, audio and graphics runtime libraries. `compose.native.yml` mounts a separately verified Linux bundle at `/opt/artcraft` and sets `IMAGE2_CRAFT_BIN_DIR`.

Build the base image first, then the overlay image. Set `IMAGE2_BASE_IMAGE` to that actual base tag, `IMAGE2_NATIVE_IMAGE_TAG` to a new native tag, and `IMAGE2_CRAFT_BUNDLE_DIR` to the verified **Linux** bundle directory. Preserve the existing image2 data volume and run one service worker against it. No additional public port is needed.

Before treating the overlay as deployable, validate its package installation, `ldd` dependencies for every binary, native protocol startup and actual round trips inside the final container/host combination. `bubblewrap --unshare-all` requires kernel user namespaces and a compatible container seccomp/AppArmor policy. Installing the package alone does not prove that those namespaces can be created. The service fails closed if isolation cannot start; the overlay does not add privileged mode or disable seccomp/AppArmor. Configure the target's narrow approved policy and rerun the sandbox tests, rather than substituting unsandboxed execution.

The launcher removes credentials from child environments, denies network access, exposes only system runtime files plus one job workspace, and prevents writes to neighbouring projects. Linux tests must independently prove those properties. The container overlay has total memory, CPU and process limits; these protect the worker container as a whole. A per-job memory/process quota independent of the Node service is not yet implemented. Native CPU jobs have a wall-clock/response/file budget and cancellation kills their process group. Keep these distinct from a claim that all native parsers are invulnerable.

The image2 health endpoint proves service availability; it does not prove engine availability. Read each engine's actual capability state, run owned-file create/edit/checkpoint/reopen tests, and test original-homepage native candidates before switching production. Native model inference remains unavailable unless a separate configured adapter exists; native CPU availability does not enable arbitrary external model or network calls.
