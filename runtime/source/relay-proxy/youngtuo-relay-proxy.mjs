import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const PORT = Number(process.env.YOUNGTUO_RELAY_PORT || 18182);
const HOST = process.env.YOUNGTUO_RELAY_HOST || "127.0.0.1";
const UPSTREAM = (process.env.YOUNGTUO_RELAY_UPSTREAM || "https://api.yundongyl.cn").replace(/\/+$/, "");
const ARCHIVE_TOKEN = process.env.YOUNGTUO_VIDEO_ARCHIVE_TOKEN || "";
const DRIVE_OUTPUT_FOLDER_ID = process.env.YOUNGTUO_DRIVE_OUTPUT_FOLDER_ID || "";
const DRIVE_PUBLIC = /^(1|true|yes)$/i.test(process.env.YOUNGTUO_DRIVE_PUBLIC || "0");
const GCLOUD_BIN = process.env.GCLOUD_BIN || "/opt/homebrew/bin/gcloud";
const CLOUDSDK_PYTHON =
  process.env.CLOUDSDK_PYTHON ||
  "";
const FFMPEG_BIN = process.env.FFMPEG_BIN || "/opt/homebrew/bin/ffmpeg";
const ARCHIVE_DOWNLOAD_TIMEOUT_SECONDS = Number(process.env.YOUNGTUO_VIDEO_ARCHIVE_DOWNLOAD_TIMEOUT_SECONDS || 900);
const ARCHIVE_DOWNLOAD_RETRIES = Number(process.env.YOUNGTUO_VIDEO_ARCHIVE_DOWNLOAD_RETRIES || 5);
const ARCHIVE_MAX_CLIPS = Number(process.env.YOUNGTUO_VIDEO_ARCHIVE_MAX_CLIPS || 0);
const DRIVE_UPLOAD_TIMEOUT_SECONDS = Number(process.env.YOUNGTUO_DRIVE_UPLOAD_TIMEOUT_SECONDS || 900);
const STORAGE_BASE_URL = (process.env.YOUNGTUO_VIDEO_STORAGE_BASE_URL || "").replace(/\/+$/, "");
const STORAGE_TOKEN = process.env.YOUNGTUO_VIDEO_STORAGE_TOKEN || "";
const PUBLIC_API_BASE_URL = (process.env.YOUNGTUO_PUBLIC_API_BASE_URL || "https://video.youngtuo.win/api/v1").replace(/\/+$/, "");
const STORAGE_UPLOAD_TIMEOUT_SECONDS = Number(process.env.YOUNGTUO_VIDEO_STORAGE_UPLOAD_TIMEOUT_SECONDS || 300);

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
  });
  res.end(body);
}

function filteredHeaders(headers) {
  const output = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (["host", "connection", "content-length", "accept-encoding"].includes(lower)) continue;
    if (value === undefined) continue;
    output[key] = value;
  }
  return output;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

async function readJson(req) {
  const body = await readBody(req);
  if (!body) return {};
  return JSON.parse(body.toString("utf8"));
}

function requireArchiveToken(req, res) {
  if (!ARCHIVE_TOKEN) {
    sendJson(res, 503, { detail: "YOUNGTUO_VIDEO_ARCHIVE_TOKEN is not configured" });
    return false;
  }
  if (req.headers.authorization !== `Bearer ${ARCHIVE_TOKEN}`) {
    sendJson(res, 401, { detail: "invalid or missing archive token" });
    return false;
  }
  return true;
}

function relayLog(event, payload) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...payload }));
}

function appendSearchParam(rawUrl, key, value) {
  if (!value) return rawUrl;
  const url = new URL(rawUrl);
  if (!url.searchParams.has(key)) url.searchParams.set(key, value);
  return url.toString();
}

function geminiDownloadUrl(uri, operationName) {
  const raw = String(uri || "").trim();
  if (!raw) throw new Error("gemini_uri or download_url is required");
  const googlePrefix = "https://generativelanguage.googleapis.com/";
  if (raw.startsWith(googlePrefix)) {
    return appendSearchParam(`${UPSTREAM}/${raw.slice(googlePrefix.length).replace(/^\/+/, "")}`, "operation", operationName);
  }
  return appendSearchParam(raw, "operation", operationName);
}

function safeFilename(value) {
  const name = String(value || "gemini-video.mp4").split(/[\\/]/).pop().replace(/[^\w.\-()+@ ]+/g, "_").trim();
  if (!name) return "gemini-video.mp4";
  return /\.[a-z0-9]{2,8}$/i.test(name) ? name : `${name}.mp4`;
}

function driveAccessToken() {
  const configured = process.env.YOUNGTUO_DRIVE_ACCESS_TOKEN || "";
  if (configured) return configured;
  return execFileSync(GCLOUD_BIN, ["auth", "print-access-token"], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...(existsSync(CLOUDSDK_PYTHON) ? { CLOUDSDK_PYTHON } : {}),
    },
    timeout: 30000,
  }).trim();
}

async function downloadBinaryBuffer(downloadUrl, headers = {}) {
  let lastError;
  for (let attempt = 1; attempt <= Math.max(1, ARCHIVE_DOWNLOAD_RETRIES); attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ARCHIVE_DOWNLOAD_TIMEOUT_SECONDS * 1000);
    try {
      const response = await fetch(downloadUrl, { headers, redirect: "follow", signal: controller.signal });
      if (!response.ok) throw new Error(`download failed: ${response.status} ${response.statusText}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      return {
        buffer,
        contentType: response.headers.get("content-type") || "video/mp4",
      };
    } catch (error) {
      lastError = error;
      if (attempt >= Math.max(1, ARCHIVE_DOWNLOAD_RETRIES)) break;
      relayLog("video_download_retry", {
        attempt,
        max_attempts: Math.max(1, ARCHIVE_DOWNLOAD_RETRIES),
        error: String(error.message || error).slice(0, 300),
      });
      await new Promise((resolve) => setTimeout(resolve, Math.min(60000, 3000 * attempt * attempt)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

async function downloadVideoBuffer(downloadUrl, apiKey) {
  const headers = {};
  if (apiKey) headers["x-goog-api-key"] = apiKey;
  return downloadBinaryBuffer(downloadUrl, headers);
}

async function driveFetch(path, options = {}) {
  const token = driveAccessToken();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DRIVE_UPLOAD_TIMEOUT_SECONDS * 1000);
  try {
    const response = await fetch(`https://www.googleapis.com${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${token}`,
        ...(options.headers || {}),
      },
    });
    const text = await response.text();
    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { raw: text };
    }
    if (!response.ok) throw new Error(`Google Drive API failed: ${response.status} ${JSON.stringify(payload).slice(0, 800)}`);
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

async function uploadBufferToDrive(buffer, filename, contentType, folderId, metadata, makePublic) {
  const boundary = `youngtuo-${randomUUID()}`;
  const driveMetadata = {
    name: filename,
    parents: [folderId || DRIVE_OUTPUT_FOLDER_ID],
    description: JSON.stringify(metadata || {}).slice(0, 12000),
  };
  const head = Buffer.from(
    `--${boundary}\r\n` +
      "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
      `${JSON.stringify(driveMetadata)}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: ${contentType || "video/mp4"}\r\n\r\n`,
    "utf8",
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  const body = Buffer.concat([head, buffer, tail]);
  const fields = "id,name,mimeType,size,webViewLink,webContentLink";
  const file = await driveFetch(`/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=${encodeURIComponent(fields)}`, {
    method: "POST",
    headers: {
      "content-type": `multipart/related; boundary=${boundary}`,
      "content-length": String(body.length),
    },
    body,
  });
  if (makePublic) {
    await driveFetch(`/drive/v3/files/${encodeURIComponent(file.id)}/permissions?supportsAllDrives=true`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "reader", type: "anyone" }),
    });
  }
  return {
    id: file.id,
    name: file.name,
    size: Number(file.size || buffer.length),
    content_type: file.mimeType || contentType || "video/mp4",
    webViewLink: file.webViewLink,
    webContentLink: file.webContentLink,
    public: Boolean(makePublic),
  };
}

async function archiveDrive(req, res) {
  if (!requireArchiveToken(req, res)) return;
  const started = Date.now();
  const payload = await readJson(req);
  const operationName = String(payload.operation_name || "");
  const downloadUrl = payload.download_url || geminiDownloadUrl(payload.gemini_uri, operationName);
  const filename = safeFilename(payload.filename || payload.title || "gemini-video.mp4");
  const apiKey = String(req.headers["x-goog-api-key"] || process.env.YOUNGTUO_GEMINI_API_KEY || "");
  const publicLink = payload.public === undefined ? DRIVE_PUBLIC : Boolean(payload.public);
  const downloaded = await downloadVideoBuffer(downloadUrl, apiKey);
  const downloadedAt = Date.now();
  const driveVideo = await uploadBufferToDrive(
    downloaded.buffer,
    filename,
    downloaded.contentType,
    String(payload.folder_id || DRIVE_OUTPUT_FOLDER_ID),
    {
      archived_by: "youngtuo-relay-drive-archiver",
      operation_name: operationName,
      source_task_id: payload.source_task_id,
      kind: payload.kind,
      ...(payload.metadata && typeof payload.metadata === "object" ? payload.metadata : {}),
    },
    publicLink,
  );
  const completedAt = Date.now();
  sendJson(res, 200, {
    ok: true,
    data: {
      drive_video: driveVideo,
      bytes: downloaded.buffer.length,
      download_seconds: Number(((downloadedAt - started) / 1000).toFixed(2)),
      upload_seconds: Number(((completedAt - downloadedAt) / 1000).toFixed(2)),
    },
  });
}

function runFfmpeg(args) {
  if (!existsSync(FFMPEG_BIN)) throw new Error(`ffmpeg not found: ${FFMPEG_BIN}`);
  const result = spawnSync(FFMPEG_BIN, args, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`ffmpeg failed: ${(result.stderr || result.stdout || "").slice(0, 1600)}`);
  }
}

function escapeSubtitleFilterPath(path) {
  return String(path || "")
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'");
}

function addStoragePublicUrl(item, publicBaseUrl) {
  if (!item || typeof item !== "object") return item;
  const videoId = item.id || item.video_id;
  const filename = item.filename || item.file_name || item.name;
  const base = String(publicBaseUrl || PUBLIC_API_BASE_URL || "").replace(/\/+$/, "");
  if (videoId && filename && base && !item.public_url) {
    item.public_url = `${base}/media/${encodeURIComponent(videoId)}/${encodeURIComponent(filename)}`;
  }
  return item;
}

async function uploadBufferToStorage(buffer, filename, payload, metadata) {
  const baseUrl = String(payload.storage_base_url || STORAGE_BASE_URL || "").replace(/\/+$/, "");
  const token = String(payload.storage_token || STORAGE_TOKEN || "");
  if (!baseUrl || !token) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STORAGE_UPLOAD_TIMEOUT_SECONDS * 1000);
  try {
    const boundary = `youngtuo-storage-${randomUUID()}`;
    const field = (name, value) =>
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${String(value || "")}\r\n`, "utf8");
    const safeName = String(filename || "video.mp4").replace(/[\r\n"]/g, "_");
    const fileHead = Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${safeName}"\r\n` +
        "Content-Type: video/mp4\r\n\r\n",
      "utf8",
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
    const body = Buffer.concat([
      field("source_task_id", String(payload.source_task_id || "")),
      field("kind", String(payload.storage_kind || payload.kind || "gemini-video-long")),
      field("title", String(payload.title || filename)),
      field("metadata", JSON.stringify(metadata || {})),
      fileHead,
      buffer,
      tail,
    ]);
    const response = await fetch(`${baseUrl}/api/v1/videos/upload`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": `multipart/form-data; boundary=${boundary}`,
        "content-length": String(body.length),
      },
      body,
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: text };
    }
    if (!response.ok) throw new Error(`storage upload failed: ${response.status} ${JSON.stringify(parsed).slice(0, 800)}`);
    const data = parsed.data && typeof parsed.data === "object" ? parsed.data : null;
    if (data && parsed.deduped) data.deduped = true;
    return addStoragePublicUrl(data, payload.public_api_base_url);
  } finally {
    clearTimeout(timer);
  }
}

async function archiveConcatDrive(req, res) {
  if (!requireArchiveToken(req, res)) return;
  const started = Date.now();
  const payload = await readJson(req);
  const clips = Array.isArray(payload.clips) ? payload.clips : [];
  if (!clips.length) throw new Error("clips is required");
  if (ARCHIVE_MAX_CLIPS > 0 && clips.length > ARCHIVE_MAX_CLIPS) throw new Error(`too many clips; max ${ARCHIVE_MAX_CLIPS}`);

  const apiKey = String(req.headers["x-goog-api-key"] || process.env.YOUNGTUO_GEMINI_API_KEY || "");
  const publicLink = payload.public === undefined ? DRIVE_PUBLIC : Boolean(payload.public);
  const targetSeconds = Number(payload.target_seconds || payload.duration_seconds || 0);
  const filename = safeFilename(payload.filename || payload.title || "gemini-video-long.mp4");
  const subtitleSrt = String(payload.subtitle_srt || "").trim();
  const audioUrl = String(payload.audio_url || payload.music_url || "").trim();
  const workDir = mkdtempSync(join(tmpdir(), "youngtuo-video-archive-"));
  const downloaded = [];
  try {
    relayLog("concat_start", {
      source_task_id: payload.source_task_id,
      clip_count: clips.length,
      target_seconds: targetSeconds || undefined,
      subtitle_track: Boolean(subtitleSrt),
      audio_url_set: Boolean(audioUrl),
    });
    const concatListPath = join(workDir, "concat.txt");
    const subtitlePath = join(workDir, "subtitles.srt");
    const audioPath = join(workDir, "audio-source");
    for (let index = 0; index < clips.length; index += 1) {
      const clip = clips[index] || {};
      const operationName = String(clip.operation_name || payload.operation_name || "");
      const downloadUrl = clip.download_url || geminiDownloadUrl(clip.gemini_uri, operationName);
      relayLog("concat_download_start", { source_task_id: payload.source_task_id, index: index + 1, operation_name: operationName });
      const item = await downloadVideoBuffer(downloadUrl, apiKey);
      const clipPath = join(workDir, `clip-${String(index + 1).padStart(2, "0")}.mp4`);
      writeFileSync(clipPath, item.buffer);
      downloaded.push({ path: clipPath, bytes: item.buffer.length, operation_name: operationName });
      relayLog("concat_download_done", { source_task_id: payload.source_task_id, index: index + 1, bytes: item.buffer.length });
    }
    if (subtitleSrt) writeFileSync(subtitlePath, subtitleSrt);
    let audioDownloaded = null;
    if (audioUrl) {
      audioDownloaded = await downloadBinaryBuffer(audioUrl);
      writeFileSync(audioPath, audioDownloaded.buffer);
    }
    const subtitleInputIndex = subtitleSrt ? (audioDownloaded ? 2 : 1) : -1;
    writeFileSync(
      concatListPath,
      downloaded.map((item) => `file '${item.path.replace(/'/g, "'\\''")}'`).join("\n") + "\n",
    );
    const outputPath = join(workDir, "combined.mp4");
    const args = [
      "-y",
      "-nostdin",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      concatListPath,
      ...(audioDownloaded ? ["-i", audioPath] : []),
      ...(subtitleSrt ? ["-i", subtitlePath] : []),
      "-map",
      "0:v:0",
      "-map",
      audioDownloaded ? "1:a:0" : "0:a?",
      ...(subtitleSrt ? ["-map", `${subtitleInputIndex}:s:0`] : []),
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      ...(subtitleSrt ? ["-c:s", "mov_text", "-disposition:s:0", "default"] : []),
      "-movflags",
      "+faststart",
    ];
    if (audioDownloaded) args.push("-shortest");
    if (targetSeconds > 0) args.push("-t", String(Math.max(1, targetSeconds)));
    args.push(outputPath);
    relayLog("concat_ffmpeg_start", { source_task_id: payload.source_task_id, clip_count: clips.length, subtitle_track: Boolean(subtitleSrt) });
    runFfmpeg(args);
    const combined = readFileSync(outputPath);
    const combinedAt = Date.now();
    relayLog("concat_ffmpeg_done", { source_task_id: payload.source_task_id, bytes: combined.length });
    const archiveMetadata = {
      archived_by: "youngtuo-relay-drive-concat-archiver",
      source_task_id: payload.source_task_id,
      kind: payload.kind || "gemini-video-long",
      target_seconds: targetSeconds || undefined,
      clip_count: clips.length,
      subtitle_track: Boolean(subtitleSrt),
      subtitle_burned: false,
      audio_mixed: Boolean(audioDownloaded),
      clips: downloaded.map((item, index) => ({
        index: index + 1,
        bytes: item.bytes,
        operation_name: item.operation_name,
      })),
      ...(payload.metadata && typeof payload.metadata === "object" ? payload.metadata : {}),
    };
    const driveVideo = await uploadBufferToDrive(
      combined,
      filename,
      "video/mp4",
      String(payload.folder_id || DRIVE_OUTPUT_FOLDER_ID),
      archiveMetadata,
      publicLink,
    );
    const driveUploadedAt = Date.now();
    relayLog("concat_drive_upload_done", { source_task_id: payload.source_task_id, drive_id: driveVideo?.id, bytes: combined.length });
    let storageVideo = null;
    let storageUploadedAt = driveUploadedAt;
    try {
      relayLog("concat_storage_upload_start", { source_task_id: payload.source_task_id, storage_configured: Boolean(payload.storage_base_url || STORAGE_BASE_URL) });
      storageVideo = await uploadBufferToStorage(combined, filename, payload, {
        ...archiveMetadata,
        archived_by: "youngtuo-relay-drive-and-storage-concat-archiver",
      });
      storageUploadedAt = Date.now();
      relayLog("concat_storage_upload_done", { source_task_id: payload.source_task_id, storage_id: storageVideo?.id || null });
    } catch (error) {
      storageUploadedAt = Date.now();
      relayLog("storage_upload_failed", { error: String(error.message || error).slice(0, 500), source_task_id: payload.source_task_id });
    }
    sendJson(res, 200, {
      ok: true,
      data: {
        drive_video: driveVideo,
        storage_video: storageVideo,
        clip_count: clips.length,
        input_bytes: downloaded.reduce((sum, item) => sum + item.bytes, 0),
        output_bytes: combined.length,
        download_and_concat_seconds: Number(((combinedAt - started) / 1000).toFixed(2)),
        upload_seconds: Number(((driveUploadedAt - combinedAt) / 1000).toFixed(2)),
        storage_upload_seconds: storageVideo ? Number(((storageUploadedAt - driveUploadedAt) / 1000).toFixed(2)) : undefined,
        subtitle_track: Boolean(subtitleSrt),
        subtitle_burned: false,
        audio_mixed: Boolean(audioDownloaded),
      },
    });
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname === "/health") {
      return sendJson(res, 200, {
        status: "ok",
        upstream: UPSTREAM,
        drive_archive_ready: Boolean(ARCHIVE_TOKEN && DRIVE_OUTPUT_FOLDER_ID),
        storage_archive_ready: Boolean(STORAGE_BASE_URL && STORAGE_TOKEN),
        max_concat_clips: ARCHIVE_MAX_CLIPS > 0 ? ARCHIVE_MAX_CLIPS : null,
        ffmpeg_ready: existsSync(FFMPEG_BIN),
      });
    }
    if (url.pathname === "/video-archive/drive" && req.method === "POST") {
      return await archiveDrive(req, res);
    }
    if (url.pathname === "/video-archive/drive/concat" && req.method === "POST") {
      return await archiveConcatDrive(req, res);
    }
    if (!url.pathname.startsWith("/relay/")) {
      return sendJson(res, 404, { detail: "not found" });
    }

    const upstreamPath = url.pathname.replace(/^\/relay/, "");
    const target = `${UPSTREAM}${upstreamPath}${url.search}`;
    const method = req.method || "GET";
    const startedAt = Date.now();
    const body = ["GET", "HEAD"].includes(method) ? undefined : await readBody(req);
    const upstream = await fetch(target, {
      method,
      headers: {
        ...filteredHeaders(req.headers),
        "accept-encoding": "identity",
      },
      body,
      redirect: "manual",
    });

    const headers = {};
    for (const [key, value] of upstream.headers.entries()) {
      if (["connection", "transfer-encoding", "content-encoding", "content-length"].includes(key.toLowerCase())) continue;
      headers[key] = value;
    }
    const responseBody = method === "HEAD" || !upstream.body ? undefined : Buffer.from(await upstream.arrayBuffer());
    if (responseBody) headers["content-length"] = String(responseBody.length);
    res.writeHead(upstream.status, headers);
    res.end(responseBody);
    if (upstreamPath.includes("/images/generations") || upstreamPath.includes(":predictLongRunning")) {
      relayLog("relay_proxy_completed", {
        method,
        upstream_path: upstreamPath,
        status: upstream.status,
        bytes: responseBody ? responseBody.length : 0,
        ms: Date.now() - startedAt,
      });
    }
  } catch (error) {
    relayLog("relay_proxy_error", {
      path: req.url || "",
      error: String(error.message || error).slice(0, 500),
    });
    sendJson(res, 502, { detail: String(error.message || error) });
  }
}).listen(PORT, HOST, () => {
  console.log(`youngtuo relay proxy listening on ${HOST}:${PORT}`);
});
