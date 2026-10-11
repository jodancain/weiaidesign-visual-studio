# CPU OCR worker

The worker uses PP-OCRv5_server_det and PP-OCRv5_server_rec, with PaddleOCR 3.3.2, PaddleX 3.3.8 and PaddlePaddle 3.2.2 pinned. It returns text, confidence, polygons and source-coordinate boxes; it never identifies fonts. Orientation correction and unwarping are disabled so pixel ownership stays in the source coordinate system. Model initialization blocks outbound Python socket connections; inbound worker HTTP remains available.

Explicit one-command preparation downloads the official versioned archives, checks pinned byte lengths and SHA-256, rejects changed artifacts, and builds the per-file model manifest:

```sh
python download_models.py --output /private/models/ocr
```

Sources, versioned URLs and SHA-256 provenance are in `model-sources.json`. The hashes are pinned from HTTPS downloads of the official artifacts verified on 2026-10-10, rather than vendor-published signatures. No weights are checked into the repository. A validated existing model volume is reused without network access. For fully offline preparation, provide the two archives and approved hashes explicitly:

```sh
python prepare_models.py --det-archive /private/det.tar --det-sha256 APPROVED_SHA256 --rec-archive /private/rec.tar --rec-sha256 APPROVED_SHA256 --output /private/models/ocr
```

Mount that model directory read-only at `/models/ocr`. The prepare command refuses existing model destinations and unsafe tar paths. The worker validates graph/weights, all per-file hashes and package versions before loading the CPU pipeline. It never invokes the prepare command and has no model download endpoint. An absent model volume keeps HTTP `/health` available with `ready:false`; `/ocr` returns 503. `ready:true` confirms that the pinned local pipeline loaded, not recognition quality on project samples.

`IMAGE2_OCR_TOKEN` is mandatory for POST `/ocr`. `/health` exposes model identities and readiness only. Publish no host port; the image2 service calls the internal worker using `IMAGE2_OCR_URL` and the same token. Keep serving egress disabled at deployment as additional assurance against dependencies attempting network access. An actual OCR smoke and the project acceptance corpus are separate gates from the unit tests and Docker source.

After starting the prepared worker, explicitly run `node smoke.mjs --url http://127.0.0.1:8080 --image /private/chinese-source.png --report /private/ocr-smoke.json --output /private/recomposed.png` with `IMAGE2_OCR_TOKEN` in the environment. This calls real CPU OCR, partitions source pixels into text/connected/residual layers, renders them through Sharp and checks source RGBA equality. It never calls generation or the GPU. A pass on one synthetic sample does not establish accuracy on all posters, fonts, transparent subjects or occlusion.

On 2026-10-10 the pinned pipeline was exercised on macOS arm64 in an isolated temporary venv using Python 3.12.14. Both real official archives were prepared and the worker reported `loaded_cpu`. A 1024×768 source rendered with the project's Noto Sans CJK SC font produced `中文图层测试2026` (0.981238 recognition confidence) and `原图像素保持不变` (0.999793). The first OCR call took 7271 ms on that session; source partition plus rendering took 198 ms. Five layers covered all 786432 pixels; both ownership recomposition and Sharp rendering compared against the source with zero differing RGBA channels. The two text layers retained original pixel patches with unknown fonts. No GPU or image generation was called. These timings are one sample, not a production latency estimate or broad accuracy benchmark.
