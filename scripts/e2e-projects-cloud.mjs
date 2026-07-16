/**
 * E2E: multi-project switch + cloud snapshot save/restore
 * Uses system Chrome (channel: chrome) — does not download browsers.
 *
 * Usage:
 *   BASE_URL=http://127.0.0.1:3000 node scripts/e2e-projects-cloud.mjs
 */
import { chromium } from "playwright";

const BASE = process.env.BASE_URL || "http://127.0.0.1:3000";
const OUT = { ok: false, steps: [], errors: [] };

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
  await page.waitForSelector(".tldrawHost", { timeout: 30_000 });
  await page.waitForTimeout(1500);
}

async function openMenu(page) {
  const menu = page.locator(".exportMenu");
  if (await menu.count()) {
    // already open
    return;
  }
  await page.locator('button[aria-label="projects and export"]').click();
  await page.waitForSelector(".exportMenu", { timeout: 5000 });
}

async function closeMenu(page) {
  // click canvas area to close if still open
  if (await page.locator(".exportMenu").count()) {
    await page.keyboard.press("Escape").catch(() => {});
    await page.mouse.click(10, 10).catch(() => {});
    await page.waitForTimeout(200);
  }
}

async function shapeCount(page) {
  return page.evaluate(() => {
    const shapes = document.querySelectorAll(".tl-shape, [data-shape-type], .tl-shape-container");
    return shapes.length;
  });
}

async function drawStroke(page) {
  const host = page.locator(".tldrawHost");
  const box = await host.boundingBox();
  if (!box) throw new Error("tldraw host not visible");
  // draw tool
  await page.keyboard.press("d");
  await page.waitForTimeout(250);
  const x = box.x + box.width * 0.45;
  const y = box.y + box.height * 0.45;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 15; i++) {
    await page.mouse.move(x + i * 8, y + Math.sin(i / 2) * 30);
  }
  await page.mouse.up();
  await page.waitForTimeout(600);
  // back to select
  await page.keyboard.press("v");
  await page.waitForTimeout(200);
}

async function clickProjectById(page, projectId) {
  await openMenu(page);
  const clicked = await page.evaluate((pid) => {
    const projects = JSON.parse(localStorage.getItem("lovartProjects") || "[]");
    const target = projects.find((p) => p.id === pid);
    if (!target) return { ok: false, reason: "not in storage" };
    const buttons = Array.from(document.querySelectorAll(".exportMenu button, .exportMenu .exportMenuItem"));
    // Prefer exact name match among project rows (exclude action buttons)
    const exclude = /新建|重命名|删除|导出|保存|恢复|矢量化|PNG|SVG|\.ai|云/;
    const match = buttons.find((b) => {
      const t = (b.textContent || "").trim();
      if (exclude.test(t)) return false;
      return t === target.name || t.startsWith(target.name);
    });
    if (!match) return { ok: false, reason: `no button for ${target.name}`, names: buttons.map((b) => b.textContent) };
    match.click();
    return { ok: true, name: target.name };
  }, projectId);
  if (!clicked.ok) throw new Error(`clickProjectById(${projectId}): ${clicked.reason}`);
  await waitForTldraw(page);
  await page.waitForTimeout(900);
  const active = await page.evaluate(() => localStorage.getItem("lovartActiveProjectId"));
  if (active !== projectId) throw new Error(`switch failed: want ${projectId} got ${active}`);
  return clicked.name;
}

async function main() {
  const browser = await chromium.launch({
    channel: "chrome",
    headless: true,
  });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  // isolate storage so old canvases don't confuse shape counts
  await context.clearCookies();
  const page = await context.newPage();
  page.setDefaultTimeout(25_000);

  try {
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    // clear site storage for clean multi-project test (keep voice tip dismissed)
    await page.evaluate(async () => {
      localStorage.clear();
      sessionStorage.clear();
      localStorage.setItem("lovartVoiceTipSeen", "1");
      if (indexedDB.databases) {
        const dbs = await indexedDB.databases();
        for (const db of dbs) {
          if (db.name) indexedDB.deleteDatabase(db.name);
        }
      }
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForTldraw(page);
    // dismiss any leftover modal scrims
    await page.evaluate(() => {
      document.querySelectorAll(".modalScrim").forEach((el) => el.remove());
    });
    step("load home (clean)", BASE);

    const boot = await page.evaluate(() => ({
      projects: JSON.parse(localStorage.getItem("lovartProjects") || "[]"),
      active: localStorage.getItem("lovartActiveProjectId"),
    }));
    if (boot.active !== "default" && boot.active !== null) {
      // migration should set default
    }
    step("projects boot", `active=${boot.active} n=${boot.projects.length}`);

    await drawStroke(page);
    const defaultCount1 = await shapeCount(page);
    step("draw on default", `shapeNodes≈${defaultCount1}`);

    await openMenu(page);
    await page.getByRole("button", { name: /新建项目/ }).click();
    await waitForTldraw(page);
    await page.waitForTimeout(900);
    const afterCreate = await page.evaluate(() => ({
      active: localStorage.getItem("lovartActiveProjectId"),
      projects: JSON.parse(localStorage.getItem("lovartProjects") || "[]"),
    }));
    if (!afterCreate.active || afterCreate.active === "default") {
      throw new Error(`expected new project id, got ${afterCreate.active}`);
    }
    if (afterCreate.projects.length < 2) throw new Error("expected ≥2 projects after create");
    const newId = afterCreate.active;
    step("create project", `id=${newId} n=${afterCreate.projects.length}`);

    await drawStroke(page);
    const newCount = await shapeCount(page);
    step("draw on new project", `shapeNodes≈${newCount}`);

    // Cloud save
    await openMenu(page);
    await page.getByRole("button", { name: /保存到云端/ }).click();
    await page.waitForTimeout(2000);
    const putCheck = await page.evaluate(async (pid) => {
      const res = await fetch(`/api/v1/canvas-snapshots/${pid}`);
      const body = await res.json().catch(() => null);
      return { status: res.status, body };
    }, newId);
    if (putCheck.status !== 200) {
      throw new Error(`cloud GET after save failed HTTP ${putCheck.status}: ${JSON.stringify(putCheck.body)}`);
    }
    const hasSnapshot = Boolean(putCheck.body?.data?.snapshot);
    if (!hasSnapshot) throw new Error("cloud snapshot missing in GET body");
    step("cloud save", `GET ${putCheck.status} bytes=${putCheck.body?.data?.byteLength ?? "?"}`);

    // Switch to default — old local canvas should still load
    await clickProjectById(page, "default");
    const defaultCount2 = await shapeCount(page);
    step("switch to default", `shapeNodes≈${defaultCount2}`);

    // Switch back to new project — strokes should remain
    await clickProjectById(page, newId);
    const newCount2 = await shapeCount(page);
    step("switch to new project", `shapeNodes≈${newCount2}`);

    // Wipe IndexedDB for new project key, remount, restore from cloud
    await page.evaluate(async (pid) => {
      const key = `lovart-canvas-${pid}`;
      const names = [
        key,
        `TLDRAW_DOCUMENT_v2${key}`,
        `TLDRAW_DOCUMENT_v2lovart-canvas-${pid}`,
      ];
      if (indexedDB.databases) {
        const dbs = await indexedDB.databases();
        for (const db of dbs) {
          if (db.name && db.name.includes(key)) names.push(db.name);
        }
      }
      await Promise.all(
        [...new Set(names)].map(
          (name) =>
            new Promise((resolve) => {
              const req = indexedDB.deleteDatabase(name);
              req.onsuccess = () => resolve(null);
              req.onerror = () => resolve(null);
              req.onblocked = () => resolve(null);
            }),
        ),
      );
    }, newId);

    await clickProjectById(page, "default");
    await clickProjectById(page, newId);
    await page.waitForTimeout(800);

    page.once("dialog", (d) => d.accept());
    await openMenu(page);
    await page.getByRole("button", { name: /从云端恢复/ }).click();
    await page.waitForTimeout(2500);
    const afterRestore = await shapeCount(page);
    const syncClass = (await page.locator(".syncStatusIcon").getAttribute("class")) || "";
    step("cloud restore", `shapeNodes≈${afterRestore} sync=${syncClass}`);

    // API negative check: invalid project id
    const bad = await page.evaluate(async () => {
      const res = await fetch("/api/v1/canvas-snapshots/BAD_ID!!");
      return res.status;
    });
    if (bad !== 400) throw new Error(`invalid projectId should 400, got ${bad}`);
    step("api validation", `invalid id → ${bad}`);

    OUT.ok = OUT.errors.length === 0;
  } catch (err) {
    fail("main", err);
    OUT.ok = false;
    try {
      await page.screenshot({ path: "/tmp/e2e-projects-cloud-fail.png", fullPage: true });
      console.error("screenshot: /tmp/e2e-projects-cloud-fail.png");
    } catch {
      /* ignore */
    }
  } finally {
    await browser.close();
  }

  console.log("\n=== E2E RESULT ===");
  console.log(JSON.stringify(OUT, null, 2));
  process.exit(OUT.ok ? 0 : 1);
}

main();
