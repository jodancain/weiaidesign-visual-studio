/**
 * E2E: agent sessions bound to projects.
 * Project A has chat → switch B (empty/other) → back A (restored).
 *
 * Usage:
 *   BASE_URL=http://127.0.0.1:3000 node scripts/e2e-sessions-project.mjs
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
  await page.waitForSelector(".tldrawHost", { timeout: 45_000 });
  await page.waitForTimeout(1000);
}

async function openMenu(page) {
  if (await page.locator(".exportMenu").count()) return;
  await page.locator('button[aria-label="projects and export"]').click();
  await page.waitForSelector(".exportMenu", { timeout: 5000 });
}

async function clickProjectById(page, projectId) {
  await openMenu(page);
  const clicked = await page.evaluate((pid) => {
    const projects = JSON.parse(localStorage.getItem("lovartProjects") || "[]");
    const target = projects.find((p) => p.id === pid);
    if (!target) return { ok: false, reason: "not in storage" };
    const buttons = Array.from(document.querySelectorAll(".exportMenu button, .exportMenu .exportMenuItem"));
    const exclude = /新建|重命名|删除|导出|保存|恢复|矢量化|PNG|SVG|\.ai|云/;
    const match = buttons.find((b) => {
      const t = (b.textContent || "").trim();
      if (exclude.test(t)) return false;
      return t === target.name || t.startsWith(target.name);
    });
    if (!match) return { ok: false, reason: `no button for ${target.name}` };
    match.click();
    return { ok: true, name: target.name };
  }, projectId);
  if (!clicked.ok) throw new Error(`clickProjectById(${projectId}): ${clicked.reason}`);
  await waitForTldraw(page);
  await page.waitForTimeout(700);
  const active = await page.evaluate(() => localStorage.getItem("lovartActiveProjectId"));
  if (active !== projectId) throw new Error(`switch failed: want ${projectId} got ${active}`);
  return clicked.name;
}

async function chatTitle(page) {
  return page.locator(".chatTop h1").innerText();
}

async function openHistory(page) {
  await page.locator('button[aria-label="history"]').click();
  await page.waitForSelector(".historyDrawer", { timeout: 5000 });
}

async function closeHistory(page) {
  if (await page.locator(".historyDrawer").count()) {
    await page.locator(".drawerTop .ghostIcon").first().click().catch(() => {});
    await page.keyboard.press("Escape").catch(() => {});
    await page.locator(".drawerScrim").click({ position: { x: 5, y: 5 } }).catch(() => {});
    await page.waitForTimeout(300);
  }
}

async function main() {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);

  const projB = "projb" + Date.now().toString(36).slice(-6);
  const sessionA = "sess-a-" + Date.now().toString(36).slice(-4);
  const sessionB = "sess-b-" + Date.now().toString(36).slice(-4);
  const textA = "PROJECT_A_ONLY_MSG_α";
  const textB = "PROJECT_B_ONLY_MSG_β";

  try {
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.evaluate(
      ({ projB, sessionA, sessionB, textA, textB }) => {
        localStorage.clear();
        sessionStorage.clear();
        localStorage.setItem("lovartVoiceTipSeen", "1");
        const projects = [
          { id: "default", name: "Untitled", ts: Date.now() - 1000 },
          { id: projB, name: "项目 B", ts: Date.now() },
        ];
        localStorage.setItem("lovartProjects", JSON.stringify(projects));
        localStorage.setItem("lovartActiveProjectId", "default");
        // legacy session without projectId should migrate to default
        const legacy = {
          id: "legacy-no-pid",
          title: "legacy default",
          ts: Date.now() - 5000,
          messages: [{ id: "m0", role: "user", text: "LEGACY_DEFAULT", ts: Date.now() - 5000 }],
          oai: [],
        };
        const sessions = [
          {
            id: sessionA,
            projectId: "default",
            title: textA.slice(0, 24),
            ts: Date.now() - 100,
            messages: [{ id: "m1", role: "user", text: textA, ts: Date.now() - 100 }],
            oai: [{ role: "user", content: textA }],
          },
          {
            id: sessionB,
            projectId: projB,
            title: textB.slice(0, 24),
            ts: Date.now() - 50,
            messages: [{ id: "m2", role: "user", text: textB, ts: Date.now() - 50 }],
            oai: [{ role: "user", content: textB }],
          },
          legacy,
        ];
        localStorage.setItem("lovartSessions", JSON.stringify(sessions));
      },
      { projB, sessionA, sessionB, textA, textB },
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForTldraw(page);
    await page.evaluate(() => {
      document.querySelectorAll(".modalScrim").forEach((el) => el.remove());
    });
    step("boot with seeded sessions");

    // Active project default → should show session A (newest for default)
    const title0 = await chatTitle(page);
    const body0 = await page.locator(".chatPane").innerText();
    if (!body0.includes(textA) && !title0.includes(textA.slice(0, 10))) {
      // title may truncate; require message text in pane or restored session
      throw new Error(`expected project A chat; title=${title0} body=${body0.slice(0, 200)}`);
    }
    step("default project shows A", title0);

    // Migration: legacy should have projectId default in storage
    const migrated = await page.evaluate(() => {
      const list = JSON.parse(localStorage.getItem("lovartSessions") || "[]");
      const leg = list.find((s) => s.id === "legacy-no-pid");
      return leg ? leg.projectId : null;
    });
    if (migrated !== "default") throw new Error(`legacy projectId expected default, got ${migrated}`);
    step("legacy migrated to default");

    // History drawer only default sessions
    await openHistory(page);
    const histDefault = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll(".sessionItem"));
      return items.map((el) => ({
        id: el.getAttribute("data-session-id"),
        projectId: el.getAttribute("data-project-id"),
        text: (el.textContent || "").trim().slice(0, 80),
      }));
    });
    if (histDefault.some((h) => h.projectId && h.projectId !== "default")) {
      throw new Error(`drawer leaked other projects: ${JSON.stringify(histDefault)}`);
    }
    if (histDefault.some((h) => (h.text || "").includes(textB.slice(0, 10)))) {
      throw new Error("drawer shows project B session while on default");
    }
    step("history filtered to default", `n=${histDefault.length}`);
    await closeHistory(page);

    // Switch to project B
    await clickProjectById(page, projB);
    await page.waitForTimeout(500);
    const bodyB = await page.locator(".chatPane").innerText();
    const titleB = await chatTitle(page);
    if (bodyB.includes(textA)) throw new Error("project A message still visible on B");
    if (!bodyB.includes(textB) && !titleB.includes(textB.slice(0, 10))) {
      throw new Error(`expected B chat; title=${titleB} body=${bodyB.slice(0, 200)}`);
    }
    step("project B shows B chat", titleB);

    await openHistory(page);
    const histB = await page.evaluate(() =>
      Array.from(document.querySelectorAll(".sessionItem")).map((el) => ({
        projectId: el.getAttribute("data-project-id"),
        text: (el.textContent || "").trim().slice(0, 80),
      })),
    );
    if (histB.some((h) => h.projectId && h.projectId !== projB && h.projectId !== "default" ? false : false)) {
      /* no-op keep eslint happy */
    }
    if (histB.some((h) => (h.text || "").includes(textA.slice(0, 10)))) {
      throw new Error("drawer shows A session while on B");
    }
    if (!histB.every((h) => !h.projectId || h.projectId === projB)) {
      throw new Error(`B drawer wrong project ids: ${JSON.stringify(histB)}`);
    }
    step("history filtered to B", `n=${histB.length}`);
    await closeHistory(page);

    // Switch back to default → A restored
    await clickProjectById(page, "default");
    await page.waitForTimeout(500);
    const bodyA2 = await page.locator(".chatPane").innerText();
    const titleA2 = await chatTitle(page);
    if (!bodyA2.includes(textA) && !titleA2.includes(textA.slice(0, 10))) {
      throw new Error(`A not restored; title=${titleA2} body=${bodyA2.slice(0, 200)}`);
    }
    if (bodyA2.includes(textB)) throw new Error("B message leaked into A after switch back");
    step("switch back restores A", titleA2);

    // New chat stays on default project
    await page.locator('button[aria-label="new chat"]').click();
    await page.waitForTimeout(400);
    const afterNew = await page.evaluate(() => ({
      active: localStorage.getItem("lovartActiveProjectId"),
      title: document.querySelector(".chatTop h1")?.textContent || "",
      sessions: JSON.parse(localStorage.getItem("lovartSessions") || "[]"),
    }));
    if (afterNew.active !== "default") throw new Error("new chat changed project");
    if (afterNew.title !== "New chat" && !/New chat|新/.test(afterNew.title)) {
      // empty messages → sessionTitleOf returns "New chat"
      if (afterNew.title && afterNew.title.includes(textA)) {
        throw new Error(`new chat still shows old title ${afterNew.title}`);
      }
    }
    // A session should still be stored under default
    const aStill = afterNew.sessions.find((s) => s.id === sessionA || (s.messages || []).some((m) => m.text === textA));
    if (!aStill || (aStill.projectId && aStill.projectId !== "default")) {
      throw new Error(`session A lost or wrong project after new chat: ${JSON.stringify(aStill)}`);
    }
    step("new chat on current project; A kept in storage");

    OUT.ok = OUT.errors.length === 0;
  } catch (err) {
    fail("main", err);
    OUT.ok = false;
    try {
      await page.screenshot({ path: "/tmp/e2e-sessions-project-fail.png", fullPage: true });
      console.error("screenshot: /tmp/e2e-sessions-project-fail.png");
    } catch {
      /* ignore */
    }
  } finally {
    await browser.close();
    console.log(JSON.stringify({ ok: OUT.ok, steps: OUT.steps, errors: OUT.errors }, null, 2));
    process.exit(OUT.ok ? 0 : 1);
  }
}

main();
