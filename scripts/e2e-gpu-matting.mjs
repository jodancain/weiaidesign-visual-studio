/**
 * E2E: place image → select → 去底 (GPU matting path).
 * Requires next dev (NODE_ENV=development for window.__studioPlaceImage).
 * Prefer BASE_URL=http://127.0.0.1:3000 with GPU_COMFY_BASE_URL set.
 *
 * Usage:
 *   BASE_URL=http://127.0.0.1:3000 node scripts/e2e-gpu-matting.mjs
 */
import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE_URL || "http://127.0.0.1:3000";
const SAMPLE =
  process.env.SAMPLE_IMAGE ||
  join(__dirname, "../docs/test-samples/gpu-base-2026-07-16T22-35-33.jpg");
const OUT = { ok: false, steps: [], errors: [], pipeline: null };

function step(name, detail = "") {
  OUT.steps.push({ name, detail, t: new Date().toISOString() });
  console.log(`✓ ${name}${detail ? ` — ${detail}` : ""}`);
}

function fail(name, err) {
  const msg = err instanceof Error ? err.message : String(err);
  OUT.errors.push({ name, msg });
  console.error(`✗ ${name} — ${msg}`);
}

async function waitForTldraw(page) {
  await page.waitForSelector(".tldrawHost", { timeout: 45_000 });
  await page.waitForTimeout(1200);
}

async function main() {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);

  const apiHits = [];
  const jobStates = [];
  page.on("request", (req) => {
    const u = req.url();
    if (u.includes("/api/v1/matting") || u.includes("/api/v1/image-jobs") || u.includes("/api/v1/images")) {
      apiHits.push({ method: req.method(), url: u.replace(BASE, ""), t: Date.now() });
    }
  });
  page.on("response", async (res) => {
    const u = res.url();
    try {
      if (u.includes("/api/v1/image-jobs/")) {
        const json = await res.json().catch(() => null);
        const state = json?.data?.state;
        const kind = json?.data?.result?.kind;
        const publicUrl = json?.data?.result?.image?.public_url;
        jobStates.push({ state, kind, publicUrl, status: res.status() });
      }
      if (u.includes("/api/v1/matting") && res.request().method() === "POST") {
        const json = await res.json().catch(() => null);
        jobStates.push({ event: "matting_accept", status: res.status(), job_id: json?.data?.job_id });
      }
      if (u.includes("/api/v1/images") && res.request().method() === "POST") {
        jobStates.push({ event: "images_post", status: res.status() });
      }
    } catch {
      /* ignore body parse races */
    }
  });

  try {
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
      localStorage.setItem("lovartVoiceTipSeen", "1");
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForTldraw(page);
    await page.evaluate(() => {
      document.querySelectorAll(".modalScrim").forEach((el) => el.remove());
    });
    step("load", BASE);

    const hasHook = await page.evaluate(() => typeof window.__studioPlaceImage === "function");
    if (!hasHook) {
      throw new Error(
        "window.__studioPlaceImage missing — need next dev (NODE_ENV=development). Production build has no hook.",
      );
    }
    step("dev hook present");

    const buf = await readFile(SAMPLE);
    const dataUrl = `data:image/jpeg;base64,${buf.toString("base64")}`;
    await page.evaluate(async (src) => {
      await window.__studioPlaceImage(src, "gpu-e2e-base");
    }, dataUrl);
    await page.waitForTimeout(1500);
    step("place image", SAMPLE);

    // selection bar should appear after place (placeImageOnCanvas selects the shape)
    await page.waitForSelector(".selectionBar", { timeout: 15_000 });
    const qudi = page.locator(".selectionBar button", { hasText: "去底" });
    await qudi.waitFor({ state: "visible", timeout: 10_000 });
    step("selection bar + 去底 visible");

    const shapesBefore = await page.evaluate(() => {
      // count image-like assets / shapes via editor if available
      return document.querySelectorAll(".tl-shape").length;
    });

    await qudi.click();
    step("clicked 去底");

    // Wait for real GPU matting completion (not just placeholder shape)
    const deadline = Date.now() + 360_000;
    while (Date.now() < deadline) {
      const sawMatting = apiHits.some((h) => h.url.includes("/matting"));
      const sawImagesFallback = apiHits.some((h) => h.url.includes("/images") && h.method === "POST");
      const bodyText = await page.locator("body").innerText().catch(() => "");
      const doneMatt = jobStates.find(
        (j) => j.state === "done" && (j.kind === "matting" || (j.publicUrl && /matting/i.test(j.publicUrl))),
      );
      const failedJob = jobStates.find((j) => j.state === "failed");

      if (bodyText.includes("GPU 抠图暂不可用") || bodyText.includes("普通方案")) {
        OUT.pipeline = "degraded-gpt-remove-bg";
        step("degraded path message", "GPU unavailable → GPT remove-bg");
        break;
      }
      if (doneMatt) {
        OUT.pipeline = "gpu-matting";
        OUT.public_url = doneMatt.publicUrl || null;
        step("matting job done", doneMatt.publicUrl || "no url field");
        // allow placeImageOnCanvas to finish
        await page.waitForTimeout(2500);
        const shapesNow = await page.evaluate(() => document.querySelectorAll(".tl-shape").length);
        step("canvas shapes after result", `${shapesBefore} → ${shapesNow}`);
        if (shapesNow < shapesBefore) {
          throw new Error("shape count dropped after matting");
        }
        break;
      }
      if (failedJob && sawImagesFallback) {
        OUT.pipeline = "images-edit-fallback";
        step("job failed then images fallback");
        break;
      }
      if (failedJob && !sawImagesFallback) {
        // may still be falling back — wait a bit more unless message shown
      }
      if (sawImagesFallback && !sawMatting) {
        // only images path without matting attempt
        const shapesNow = await page.evaluate(() => document.querySelectorAll(".tl-shape").length);
        if (shapesNow > shapesBefore + 1) {
          OUT.pipeline = "images-edit-only";
          step("images-only path", `${shapesBefore} → ${shapesNow}`);
          break;
        }
      }
      await page.waitForTimeout(2000);
    }

    if (!OUT.pipeline) {
      const sawMatting = apiHits.some((h) => h.url.includes("/matting"));
      OUT.pipeline = sawMatting ? "gpu-matting-timeout" : "unknown-no-api";
      throw new Error(
        `timeout waiting for matting; pipeline=${OUT.pipeline}; hits=${JSON.stringify(apiHits.slice(0, 20))}; jobs=${JSON.stringify(jobStates.slice(-10))}`,
      );
    }

    OUT.ok =
      OUT.errors.length === 0 &&
      (OUT.pipeline === "gpu-matting" ||
        OUT.pipeline === "degraded-gpt-remove-bg" ||
        OUT.pipeline === "images-edit-fallback" ||
        OUT.pipeline === "images-edit-only");
    if (OUT.pipeline === "gpu-matting") {
      step("PASS gpu-matting pipeline");
    } else {
      step("PASS with non-GPU pipeline", OUT.pipeline);
    }
  } catch (err) {
    fail("main", err);
    OUT.ok = false;
    try {
      await page.screenshot({ path: "/tmp/e2e-gpu-matting-fail.png", fullPage: true });
      console.error("screenshot: /tmp/e2e-gpu-matting-fail.png");
    } catch {
      /* ignore */
    }
  } finally {
    await browser.close();
    console.log(JSON.stringify({ ok: OUT.ok, pipeline: OUT.pipeline, steps: OUT.steps, errors: OUT.errors, apiHits: apiHits.slice(0, 30) }, null, 2));
    process.exit(OUT.ok ? 0 : 1);
  }
}

main();
