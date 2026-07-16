import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { imageOutputDir, jsonCors, optionsResponse, requireVideoToken } from "../../_lib/visual-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Snapshots can be multi-MB JSON; allow long uploads on serverless hosts. */
export const maxDuration = 60;

const PROJECT_ID_RE = /^[a-z0-9-]{1,40}$/;
const MAX_SNAPSHOT_BYTES = 12 * 1024 * 1024; // 12 MB hard cap

function canvasDir() {
  return join(imageOutputDir, "_canvas");
}

function snapshotPath(projectId: string) {
  return join(canvasDir(), `${projectId}.json`);
}

function validateProjectId(projectId: string): string | null {
  const id = String(projectId || "").trim().toLowerCase();
  if (!PROJECT_ID_RE.test(id)) return null;
  return id;
}

export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  const authError = requireVideoToken(request);
  if (authError) return authError;
  const { projectId: raw } = await context.params;
  const projectId = validateProjectId(raw);
  if (!projectId) return jsonCors({ detail: "invalid projectId" }, { status: 400 });

  try {
    const rawJson = await readFile(snapshotPath(projectId), "utf8");
    const data = JSON.parse(rawJson) as Record<string, unknown>;
    return jsonCors({
      status: 200,
      message: "success",
      data: {
        projectId,
        snapshot: data.snapshot ?? data,
        projectName: data.projectName ?? null,
        updatedAt: data.updatedAt ?? null,
        byteLength: Buffer.byteLength(rawJson, "utf8"),
      },
    });
  } catch {
    return jsonCors({ detail: "snapshot not found" }, { status: 404 });
  }
}

export async function PUT(request: Request, context: { params: Promise<{ projectId: string }> }) {
  const authError = requireVideoToken(request);
  if (authError) return authError;
  const { projectId: raw } = await context.params;
  const projectId = validateProjectId(raw);
  if (!projectId) return jsonCors({ detail: "invalid projectId" }, { status: 400 });

  let body: unknown;
  try {
    const text = await request.text();
    if (Buffer.byteLength(text, "utf8") > MAX_SNAPSHOT_BYTES) {
      return jsonCors({ detail: `snapshot too large (max ${MAX_SNAPSHOT_BYTES} bytes)` }, { status: 413 });
    }
    body = JSON.parse(text);
  } catch {
    return jsonCors({ detail: "invalid JSON body" }, { status: 400 });
  }

  if (!body || typeof body !== "object") {
    return jsonCors({ detail: "body must be an object" }, { status: 400 });
  }

  const record = body as Record<string, unknown>;
  // Accept either { snapshot: TLEditorSnapshot } or bare TLEditorSnapshot / TLStoreSnapshot
  const payloadSnapshot =
    record.snapshot && typeof record.snapshot === "object"
      ? record.snapshot
      : "document" in record || "store" in record
        ? record
        : null;
  if (!payloadSnapshot || typeof payloadSnapshot !== "object") {
    return jsonCors({ detail: "snapshot must be a tldraw snapshot object" }, { status: 400 });
  }

  const updatedAt = Date.now();
  const projectName = typeof record.projectName === "string" ? record.projectName.slice(0, 120) : "";
  const fileBody = JSON.stringify({
    projectId,
    projectName,
    updatedAt,
    snapshot: payloadSnapshot,
  });

  try {
    await mkdir(canvasDir(), { recursive: true });
    await writeFile(snapshotPath(projectId), fileBody, "utf8");
  } catch (error) {
    return jsonCors(
      { detail: error instanceof Error ? error.message : "failed to write snapshot" },
      { status: 500 },
    );
  }

  return jsonCors({
    status: 200,
    message: "success",
    data: {
      projectId,
      projectName,
      updatedAt,
      byteLength: Buffer.byteLength(fileBody, "utf8"),
    },
  });
}

export async function OPTIONS() {
  return optionsResponse();
}
