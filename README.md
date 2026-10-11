# Weiai Design Visual Studio

This repository keeps the Next.js workbench at its root. It includes the ontology-video workflow, Studio v3 editor, timeline, generation pipeline and effects controls.

## Web development

```sh
npm ci
npm run dev
```

Configure server credentials using `.env.example`. Studio v3 calls the separate backend through `STUDIO_GATEWAY_URL`.

## Image Studio 2.0

The `/image2` preview entry uses a separate Node 22 service and SQLite volume. Install its dependencies with `npm ci --prefix services/image2`. CPU edits, real Chinese text/SVG layers, pixel-preserving layer restoration and persistent candidate jobs share one operation registry. The original entry remains available.

See [the service README](services/image2/README.md), [implementation and acceptance scope](docs/IMAGE2_2.0.md), and [Docker deployment and recovery](docs/IMAGE2_DEPLOYMENT.md). Image2-specific tests are `npm run test:image2`, `npm run test:image2:client` and `npm run test:image2:browser`; the real CPU OCR smoke is explicit. These commands do not authorize production deployment or paid model submissions.

## Complete Studio source workspace

[runtime/](runtime/README.md) contains the gateway, Blender and code-video workers, optional archive/relay services, deployment helpers, static scene definitions and attribution notices. Its SHA-256 manifest excludes runtime data and credentials.

Restore a committed version into a new directory:

```sh
python3 runtime/restore.py --output /path/to/new-studio-workspace
```

The result has sibling `web/`, `gateway/` and `workers/` directories, preserving their imports. Restoration exports source; it does not install dependencies, start services or submit model requests. See the runtime README for prerequisites and verification commands.

## Ontology-video method

- [Method and diagrams](docs/ontology-video-method.md)
- [Ontology workflow implementation](app/api/v1/_lib/ontology.ts)
- [Studio backend contracts](runtime/source/gateway/studio/README.md)
- [Runtime operations and attribution](runtime/source/docs/studio-v3/)
