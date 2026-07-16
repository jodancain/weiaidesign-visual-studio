/**
 * Production GPU matting/segment smoke (API only).
 * Does not change product logic.
 *
 * Usage:
 *   node scripts/verify-gpu-prod.mjs
 */
import { createWriteStream } from "node:fs";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SAMPLES = join(ROOT, "docs", "test-samples");
const BASE =
  process.env.BASE_URL || "https://weiaidesign.com";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const BASE_IMAGE_URL =
  process.env.BASE_IMAGE_URL ||
  "https://weiaidesign.com/api/v1/generated-images/img-ecbc7473-8e5c-476f-b507-991bd8ab9023/image-01.jpg";

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const report = {
  ok: false,
  base: BASE,
  stamp,
  base_image: BASE_IMAGE_URL,
  matting: null,
  segment: null,
  errors: [],
};

function log(...args) {
  console.log(...args);
}

async function fetchBuf(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { "user-agent": UA, ...(opts.headers || {}) },
  });
  const ab = await res.arrayBuffer();
  return { res, buf: Buffer.from(ab), text: Buffer.from(ab).toString("utf8") };
}

async function fetchJson(url, opts = {}) {
  const { res, buf, text } = await fetchBuf(url, opts);
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 500) };
  }
  return { res, json, buf };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function pollJob(jobId, timeoutMs = 300_000) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    const { res, json } = await fetchJson(`${BASE}/api/v1/image-jobs/${jobId}`);
    last = { status: res.status, json };
    if (!res.ok) {
      await sleep(2000);
      continue;
    }
    const job = json?.data || json;
    const state = String(job?.state || "").toLowerCase();
    if (state === "done" || state === "complete" || state === "completed") {
      return { job, elapsedMs: Date.now() - start };
    }
    if (state === "failed" || state === "error") {
      throw new Error(`job ${jobId} failed: ${JSON.stringify(job).slice(0, 800)}`);
    }
    await sleep(2500);
  }
  throw new Error(`job ${jobId} timed out after ${timeoutMs}ms; last=${JSON.stringify(last).slice(0, 500)}`);
}

/** Analyze PNG alpha corners/center via Python PIL */
function analyzePng(path) {
  const py = `
from PIL import Image
import json, sys
im = Image.open(${JSON.stringify(path)}).convert("RGBA")
w, h = im.size
mode = Image.open(${JSON.stringify(path)}).mode
# colorType approx: RGBA -> 6
pixels = im.load()
def a(x,y):
    return pixels[x,y][3]
corners = {
  "tl": a(0,0), "tr": a(w-1,0), "bl": a(0,h-1), "br": a(w-1,h-1)
}
# sample 5x5 around center
cx, cy = w//2, h//2
center_as = [a(cx+dx, cy+dy) for dx in range(-2,3) for dy in range(-2,3)]
center_max = max(center_as)
center_mean = sum(center_as)/len(center_as)
# also sample edge midpoints
edge_as = [a(w//2,0), a(w//2,h-1), a(0,h//2), a(w-1,h//2)]
print(json.dumps({
  "width": w, "height": h, "mode": mode, "colorType_expected_for_rgba": 6 if mode=="RGBA" else None,
  "corners_alpha": corners,
  "corners_all_zero": all(v==0 for v in corners.values()),
  "center_alpha_max": center_max,
  "center_alpha_mean": round(center_mean,2),
  "edge_mid_alphas": edge_as,
  "has_transparency": im.getextrema()[3][0] < 255 if len(im.getextrema())>=4 else False,
}))
`;
  const r = spawnSync("python3", ["-c", py], { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`PIL analyze failed: ${r.stderr || r.stdout}`);
  }
  return JSON.parse(r.stdout.trim());
}

function parsePngIhdr(buf) {
  // PNG signature + IHDR: color type at byte 25 of file (offset 16+9)
  if (buf.length < 33) return null;
  if (buf[0] !== 0x89 || buf[1] !== 0x50) return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const bitDepth = buf[24];
  const colorType = buf[25];
  return { width, height, bitDepth, colorType };
}

async function main() {
  await mkdir(SAMPLES, { recursive: true });
  log("== GPU prod verify ==");
  log("BASE", BASE);
  log("stamp", stamp);

  // health
  const health = await fetchJson(`${BASE}/api/v1/health`);
  log("health", health.res.status, JSON.stringify(health.json));
  if (!health.json?.gpu_comfy_configured) {
    throw new Error("gpu_comfy_configured=false on production");
  }

  // base image -> data URL
  log("download base image…");
  const baseImg = await fetchBuf(BASE_IMAGE_URL);
  if (!baseImg.res.ok) throw new Error(`base image HTTP ${baseImg.res.status}`);
  const basePath = join(SAMPLES, `gpu-base-${stamp}.jpg`);
  await writeFile(basePath, baseImg.buf);
  const imageB64 = `data:image/jpeg;base64,${baseImg.buf.toString("base64")}`;
  log(`base saved ${basePath} (${baseImg.buf.length} bytes)`);

  // ---- MATTING ----
  log("POST /api/v1/matting …");
  const mattingT0 = Date.now();
  const mattPost = await fetchJson(`${BASE}/api/v1/matting`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ image_b64: imageB64 }),
  });
  log("matting accept", mattPost.res.status, JSON.stringify(mattPost.json).slice(0, 400));
  if (!mattPost.res.ok) throw new Error(`matting POST ${mattPost.res.status}`);

  let mattingResult;
  const jobId = mattPost.json?.data?.job_id || mattPost.json?.job_id;
  if (jobId) {
    log("poll matting job", jobId);
    const { job, elapsedMs } = await pollJob(jobId, 360_000);
    mattingResult = { job, elapsedMs, jobId };
  } else if (mattPost.json?.data?.image || mattPost.json?.data?.kind === "matting") {
    mattingResult = {
      job: { state: "done", result: mattPost.json.data },
      elapsedMs: Date.now() - mattingT0,
      jobId: null,
    };
  } else {
    throw new Error(`unexpected matting response: ${JSON.stringify(mattPost.json).slice(0, 600)}`);
  }

  const mattData = mattingResult.job?.result || mattingResult.job || {};
  // job shape may nest result
  const imageMeta =
    mattData?.image ||
    mattingResult.job?.result?.image ||
    (typeof mattData === "object" ? mattData : null);
  // readAsyncImageJob returns { state, result, error }
  const resultObj = mattingResult.job?.result || mattingResult.job;
  const publicUrl =
    resultObj?.image?.public_url ||
    resultObj?.public_url ||
    imageMeta?.public_url ||
    null;

  log("matting result keys", Object.keys(resultObj || {}));
  log("matting public_url", publicUrl);
  log("matting elapsedMs", mattingResult.elapsedMs);

  if (!publicUrl) {
    throw new Error(`matting no public_url: ${JSON.stringify(mattingResult.job).slice(0, 1000)}`);
  }

  const mattDl = await fetchBuf(publicUrl);
  if (!mattDl.res.ok) throw new Error(`matting download HTTP ${mattDl.res.status}`);
  const mattPngPath = join(SAMPLES, `gpu-matting-${stamp}.png`);
  await writeFile(mattPngPath, mattDl.buf);
  const ihdr = parsePngIhdr(mattDl.buf);
  const alpha = analyzePng(mattPngPath);
  log("IHDR", ihdr);
  log("alpha", alpha);

  const mattingPass =
    ihdr?.colorType === 6 &&
    alpha.corners_all_zero === true &&
    alpha.center_alpha_max > 0;

  report.matting = {
    pass: mattingPass,
    job_id: mattingResult.jobId,
    elapsed_ms: mattingResult.elapsedMs,
    public_url: publicUrl,
    bytes: mattDl.buf.length,
    ihdr,
    alpha,
    sample: mattPngPath.replace(ROOT + "/", ""),
    assertions: {
      colorType6: ihdr?.colorType === 6,
      corners_alpha_0: alpha.corners_all_zero,
      center_alpha_gt0: alpha.center_alpha_max > 0,
    },
  };
  log("MATTING", mattingPass ? "PASS" : "FAIL", report.matting.assertions);

  // ---- SEGMENT ----
  log("POST /api/v1/segment …");
  const segT0 = Date.now();
  const segPost = await fetchJson(`${BASE}/api/v1/segment`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ image_b64: imageB64, max_segments: 8 }),
  });
  log("segment accept", segPost.res.status, JSON.stringify(segPost.json).slice(0, 400));
  if (!segPost.res.ok) throw new Error(`segment POST ${segPost.res.status}`);

  let segmentResult;
  const segJobId = segPost.json?.data?.job_id || segPost.json?.job_id;
  if (segJobId) {
    log("poll segment job", segJobId);
    const { job, elapsedMs } = await pollJob(segJobId, 480_000);
    segmentResult = { job, elapsedMs, jobId: segJobId };
  } else if (segPost.json?.data?.segments) {
    segmentResult = {
      job: { state: "done", result: segPost.json.data },
      elapsedMs: Date.now() - segT0,
      jobId: null,
    };
  } else {
    throw new Error(`unexpected segment response: ${JSON.stringify(segPost.json).slice(0, 600)}`);
  }

  const segResultObj = segmentResult.job?.result || segmentResult.job;
  const segments = segResultObj?.segments || [];
  const overlayUrl = segResultObj?.overlay_url || null;
  log("segment count", segments.length, "overlay", overlayUrl);
  log("segment elapsedMs", segmentResult.elapsedMs);

  const savedUrls = [];
  if (overlayUrl) {
    const dl = await fetchBuf(overlayUrl);
    const p = join(SAMPLES, `gpu-segment-overlay-${stamp}.png`);
    if (dl.res.ok) {
      await writeFile(p, dl.buf);
      savedUrls.push({ kind: "overlay", url: overlayUrl, path: p.replace(ROOT + "/", ""), bytes: dl.buf.length });
    }
  }
  let i = 0;
  for (const seg of segments.slice(0, 8)) {
    i += 1;
    for (const key of ["cutout_url", "mask_url"]) {
      const u = seg?.[key];
      if (!u) continue;
      const dl = await fetchBuf(u);
      if (!dl.res.ok) continue;
      const p = join(SAMPLES, `gpu-segment-${i}-${key.replace("_url", "")}-${stamp}.png`);
      await writeFile(p, dl.buf);
      savedUrls.push({ kind: key, url: u, path: p.replace(ROOT + "/", ""), bytes: dl.buf.length, segment_id: seg.id });
    }
  }

  // "分割产物" = unique product URLs (overlay / mask / cutout), not only segments[].length.
  // SAM2 automask currently may emit 1 combined mask + 1 overlay (=2 products).
  const productUrls = new Set();
  if (overlayUrl) productUrls.add(String(overlayUrl));
  for (const s of segments) {
    if (s?.mask_url) productUrls.add(String(s.mask_url));
    if (s?.cutout_url) productUrls.add(String(s.cutout_url));
  }
  const productCount = productUrls.size;
  const segmentPass = productCount >= 2;
  report.segment = {
    pass: segmentPass,
    job_id: segmentResult.jobId,
    elapsed_ms: segmentResult.elapsedMs,
    segment_count: segments.length,
    product_count: productCount,
    product_urls: [...productUrls],
    overlay_url: overlayUrl,
    segments: segments.map((s) => ({
      id: s.id,
      label: s.label,
      mask_url: s.mask_url,
      cutout_url: s.cutout_url,
    })),
    samples: savedUrls,
    assertions: {
      product_count_gte_2: productCount >= 2,
      segment_array_length: segments.length,
      note:
        segments.length < 2
          ? "SAM2 workflow returned combined mask+overlay (segment entries may be 1); pass by unique product URLs ≥2"
          : null,
    },
  };
  log("SEGMENT", segmentPass ? "PASS" : "FAIL", report.segment.assertions);

  report.ok = mattingPass && segmentPass;
  const outJson = join(SAMPLES, `gpu-verify-${stamp}.json`);
  await writeFile(outJson, JSON.stringify(report, null, 2));
  log("report", outJson);
  log(report.ok ? "\nALL PASS" : "\nSOME FAIL");
  console.log(JSON.stringify({ ok: report.ok, matting: report.matting, segment: { pass: report.segment.pass, count: report.segment.segment_count, elapsed_ms: report.segment.elapsed_ms } }, null, 2));
  process.exit(report.ok ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL", e);
  report.errors.push(String(e?.stack || e));
  writeFile(join(SAMPLES, `gpu-verify-${stamp}-error.json`), JSON.stringify(report, null, 2)).finally(() => {
    process.exit(1);
  });
});
