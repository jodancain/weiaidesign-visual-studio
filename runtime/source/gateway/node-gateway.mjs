import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { URL, fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { createStudioRouter } from "./studio/router.mjs";

const env = process.env;

let fileEnvCache = null;

function parseEnvFile(content) {
  const values = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const index = normalized.indexOf("=");
    if (index <= 0) continue;
    const key = normalized.slice(0, index).trim();
    let value = normalized.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function fileEnv() {
  if (fileEnvCache) return fileEnvCache;
  fileEnvCache = {};
  const paths = [env.MPT_ENV_PATH, "/mpt.env", "/MoneyPrinterTurbo/.env"].filter(Boolean);
  for (const path of paths) {
    try {
      if (existsSync(path)) Object.assign(fileEnvCache, parseEnvFile(readFileSync(path, "utf8")));
    } catch {
      // Ignore optional env files.
    }
  }
  return fileEnvCache;
}

function envValue(key, fallback = "") {
  if (env[key]) return env[key];
  const fromFile = fileEnv()[key];
  return fromFile === undefined || fromFile === "" ? fallback : fromFile;
}

const PORT = Number(envValue("PORT", envValue("GATEWAY_PORT", "18082")));
const VIDEO_API_TOKEN = envValue("VIDEO_API_TOKEN");
const PUBLIC_BASE_URL = envValue("PUBLIC_BASE_URL", "https://video.youngtuo.win/api/v1").replace(/\/+$/, "");
const VIDEO_STORAGE_BASE_URL = envValue("VIDEO_STORAGE_BASE_URL").replace(/\/+$/, "");
const VIDEO_STORAGE_TOKEN = envValue("VIDEO_STORAGE_TOKEN");
const MPT_CONFIG_PATH = envValue("MPT_CONFIG_PATH", "/MoneyPrinterTurbo/config.toml");
const LOCAL_VIDEO_DIR = envValue("MPT_LOCAL_VIDEO_DIR", "/MoneyPrinterTurbo/storage/local_videos");
const IMAGE_MODEL = envValue("IMAGE_OPENAI_MODEL", "gpt-image-1.5");
const IMAGE_OPENAI_FALLBACK_MODELS = envValue("IMAGE_OPENAI_FALLBACK_MODELS", "gpt-image-1")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const IMAGE_GENERATION_MODELS = Array.from(new Set([IMAGE_MODEL, ...IMAGE_OPENAI_FALLBACK_MODELS].filter(Boolean)));
const IMAGE_OPENAI_TIMEOUT_SECONDS = Number(envValue("IMAGE_OPENAI_TIMEOUT_SECONDS", "300"));
const IMAGE_OPENAI_QUALITY = envValue("IMAGE_OPENAI_QUALITY", "low");
const IMAGE_OPENAI_OUTPUT_FORMAT = envValue("IMAGE_OPENAI_OUTPUT_FORMAT", "jpeg");
const IMAGE_OPENAI_OUTPUT_COMPRESSION = Number(envValue("IMAGE_OPENAI_OUTPUT_COMPRESSION", "70"));
const IMAGE_OUTPUT_DIR = envValue("IMAGE_OUTPUT_DIR", join(LOCAL_VIDEO_DIR, "generated_images"));
const GEMINI_VIDEO_BASE_URL = envValue("GEMINI_VIDEO_BASE_URL", "https://api.yundongyl.cn/v1beta").replace(/\/+$/, "");
const GEMINI_VIDEO_MODEL = envValue("GEMINI_VIDEO_MODEL", "veo-3.1-fast-generate-preview");
const GEMINI_VIDEO_API_KEY = envValue("GEMINI_VIDEO_API_KEY", envValue("GEMINI_API_KEY"));
const GEMINI_VIDEO_RESOLUTION = envValue("GEMINI_VIDEO_RESOLUTION", "720p");
const GEMINI_VIDEO_PERSON_GENERATION = envValue("GEMINI_VIDEO_PERSON_GENERATION", "allow_adult");
const GEMINI_VIDEO_SUBMIT_TIMEOUT_SECONDS = Number(envValue("GEMINI_VIDEO_SUBMIT_TIMEOUT_SECONDS", "300"));
const GEMINI_VIDEO_SUBMIT_RETRIES = Math.max(1, Number(envValue("GEMINI_VIDEO_SUBMIT_RETRIES", "6")));
const GEMINI_VIDEO_SUBMIT_RETRY_DELAY_SECONDS = Math.max(1, Number(envValue("GEMINI_VIDEO_SUBMIT_RETRY_DELAY_SECONDS", "45")));
const GEMINI_VIDEO_TIMEOUT_SECONDS = Number(envValue("GEMINI_VIDEO_TIMEOUT_SECONDS", "900"));
const GEMINI_VIDEO_POLL_INTERVAL = Number(envValue("GEMINI_VIDEO_POLL_INTERVAL", "10"));
const GEMINI_VIDEO_DOWNLOAD_TIMEOUT_SECONDS = Number(envValue("GEMINI_VIDEO_DOWNLOAD_TIMEOUT_SECONDS", "600"));
const REMOTE_VIDEO_ARCHIVER_URL = envValue("REMOTE_VIDEO_ARCHIVER_URL").replace(/\/+$/, "");
const REMOTE_VIDEO_ARCHIVER_TOKEN = envValue("REMOTE_VIDEO_ARCHIVER_TOKEN");
const REMOTE_VIDEO_ARCHIVER_FOLDER_ID = envValue("REMOTE_VIDEO_ARCHIVER_FOLDER_ID");
const REMOTE_VIDEO_ARCHIVER_PUBLIC = /^(1|true|yes)$/i.test(envValue("REMOTE_VIDEO_ARCHIVER_PUBLIC", "0"));
const REMOTE_VIDEO_ARCHIVER_TIMEOUT_SECONDS = Number(envValue("REMOTE_VIDEO_ARCHIVER_TIMEOUT_SECONDS", "1200"));
const IMAGE_VIDEO_MAX_DURATION_SECONDS = Number(envValue("IMAGE_VIDEO_MAX_DURATION_SECONDS", "0"));
const IMAGE_VIDEO_MAX_SEGMENTS = Number(envValue("IMAGE_VIDEO_MAX_SEGMENTS", "0"));
const IMAGE_VIDEO_SEGMENT_SECONDS = Number(envValue("IMAGE_VIDEO_SEGMENT_SECONDS", "8"));
const IMAGE_GENERATION_CONCURRENCY = Math.max(1, Number(envValue("IMAGE_GENERATION_CONCURRENCY", "1")));
const IMAGE_GENERATION_RETRIES = Math.max(1, Number(envValue("IMAGE_GENERATION_RETRIES", "3")));

// Video backend selection. "seedance" (default) and "veo-openai" both speak the OpenAI-style
// /v1/video/generations contract exposed by the relay; "gemini" keeps the legacy Gemini-native
// predictLongRunning path. Only Gemini-native honours a last frame; the OpenAI-style route is
// first-frame-only, which is acceptable when consecutive keyframes come from one authored scene.
const VIDEO_BACKEND = envValue("VIDEO_BACKEND", "seedance").toLowerCase();
const OPENAI_VIDEO_BASE_URL = envValue("OPENAI_VIDEO_BASE_URL", envValue("IMAGE_OPENAI_BASE_URL")).replace(/\/+$/, "");
const OPENAI_VIDEO_API_KEY = envValue("OPENAI_VIDEO_API_KEY", envValue("IMAGE_OPENAI_API_KEY"));
const SEEDANCE_MODEL = envValue("SEEDANCE_MODEL", "dreamina-seedance-2-0");
// Seedance 2.x always renders a soundtrack (the relay drops `generate_audio`), and that audio
// trips upstream copyright screening roughly half the time; failed runs still bill. On that
// specific rejection we retry once on a model with a clean record instead of surfacing a fail.
const SEEDANCE_FALLBACK_MODEL = envValue("SEEDANCE_FALLBACK_MODEL", "doubao-seedance-1-5-pro-251215");
const SEEDANCE_AUDIO_HINT = envValue("SEEDANCE_AUDIO_HINT", "No background music, no soundtrack, no singing; only quiet natural ambient sound.");
const VEO_OPENAI_MODEL = envValue("VEO_OPENAI_MODEL", "veo-3.1-fast-generate-001");
const OPENAI_VIDEO_TIMEOUT_SECONDS = Number(envValue("OPENAI_VIDEO_TIMEOUT_SECONDS", "900"));
const OPENAI_VIDEO_POLL_INTERVAL = Number(envValue("OPENAI_VIDEO_POLL_INTERVAL", "10"));
// Keyframe image model. Seedream needs >= 3,686,400 px and rejects output_format/compression.
const KEYFRAME_IMAGE_MODEL = envValue("KEYFRAME_IMAGE_MODEL", "");
// Story Mode: keyframes come from the Blender greybox worker and are restyled with GPT-image
// (reference edit) instead of being generated from text. Empty URL = feature disabled.
const BLENDER_STORY_WORKER_URL = envValue("BLENDER_STORY_WORKER_URL").replace(/\/+$/, "");
const BLENDER_STORY_TIMEOUT_SECONDS = Number(envValue("BLENDER_STORY_TIMEOUT_SECONDS", "300"));
const BLENDER_STORY_POLL_INTERVAL = Number(envValue("BLENDER_STORY_POLL_INTERVAL", "2"));
let storyManifestCache = { at: 0, value: null };

const jobs = new Map();
const imageMimeTypes = new Map();

function parseTomlString(content, key) {
  const re = new RegExp(`^\\s*${key}\\s*=\\s*\"([^\"]*)\"\\s*$`, "m");
  const match = content.match(re);
  return match ? match[1] : "";
}

function configValue(key) {
  try {
    if (!existsSync(MPT_CONFIG_PATH)) return "";
    return parseTomlString(readFileSync(MPT_CONFIG_PATH, "utf8"), key);
  } catch {
    return "";
  }
}

function openAIConfig() {
  const baseUrl = (envValue("IMAGE_OPENAI_BASE_URL") || configValue("openai_base_url") || "").replace(/\/+$/, "");
  const apiKey = envValue("IMAGE_OPENAI_API_KEY") || configValue("openai_api_key") || "";
  const chatModel = configValue("openai_model_name") || "gpt-5.4-mini";
  if (!baseUrl || !apiKey) throw new Error("image generation config is missing");
  return { baseUrl, apiKey, chatModel };
}

function json(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET,POST,DELETE,HEAD,OPTIONS",
  });
  res.end(body);
}

function requireToken(req, res) {
  if (!VIDEO_API_TOKEN) {
    json(res, 503, { detail: "VIDEO_API_TOKEN is not configured" });
    return false;
  }
  if (req.headers.authorization !== `Bearer ${VIDEO_API_TOKEN}`) {
    json(res, 401, { detail: "invalid or missing bearer token" });
    return false;
  }
  return true;
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function imageSize(aspect) {
  if (aspect === "16:9" || aspect === "3:2") return "1536x1024";
  if (aspect === "1:1") return "1024x1024";
  return "1024x1536";
}

/** Seedream (ByteDance) requires >= 3,686,400 px total; gpt-image's 1024/1536 sizes are rejected. */
function isSeedreamModel(model) {
  return /seedream/i.test(String(model || ""));
}

function seedreamImageSize(aspect) {
  if (aspect === "16:9") return "2560x1440";
  if (aspect === "3:2") return "2496x1664";
  if (aspect === "1:1") return "2048x2048";
  return "1440x2560";
}

/** Per-model request body for /images/generations. Seedream rejects output_format/compression. */
function imageGenerationBody(model, prompt, aspect) {
  if (isSeedreamModel(model)) {
    return { model, prompt, size: seedreamImageSize(aspect), n: 1, response_format: "b64_json" };
  }
  return {
    model,
    prompt,
    size: imageSize(aspect),
    n: 1,
    ...(IMAGE_OPENAI_QUALITY ? { quality: IMAGE_OPENAI_QUALITY } : {}),
    ...(IMAGE_OPENAI_OUTPUT_FORMAT ? { output_format: IMAGE_OPENAI_OUTPUT_FORMAT } : {}),
    ...(IMAGE_OPENAI_OUTPUT_COMPRESSION > 0 ? { output_compression: IMAGE_OPENAI_OUTPUT_COMPRESSION } : {}),
  };
}

/** Model attempt order for keyframes: an explicit KEYFRAME_IMAGE_MODEL leads, then the normal chain. */
function keyframeImageModels() {
  return Array.from(new Set([KEYFRAME_IMAGE_MODEL, ...IMAGE_GENERATION_MODELS].filter(Boolean)));
}

function imageExtension() {
  const value = String(IMAGE_OPENAI_OUTPUT_FORMAT || "png").toLowerCase();
  if (value === "jpeg") return "jpg";
  if (["jpg", "png", "webp"].includes(value)) return value;
  return "png";
}

function imagePublicUrl(imageId, filename) {
  return `${PUBLIC_BASE_URL}/generated-images/${encodeURIComponent(imageId)}/${encodeURIComponent(filename)}`;
}

function normalizeDuration(value) {
  if (GEMINI_VIDEO_RESOLUTION === "1080p" || GEMINI_VIDEO_RESOLUTION === "4k") return 8;
  const requested = Number(value || 8);
  if (requested <= 4) return 4;
  if (requested <= 6) return 6;
  return 8;
}

function numericPayloadValue(payload, keys) {
  for (const key of keys) {
    const value = Number(payload[key] || 0);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

function requestedTotalDuration(payload) {
  const direct = Number(
    payload.total_duration_seconds ||
      payload.total_duration ||
      payload.target_duration_seconds ||
      payload.target_duration ||
      payload.duration_seconds ||
      payload.duration ||
      0,
  );
  const clip = Number(payload.video_clip_duration || 0);
  const paragraphs = Math.max(1, Number(payload.paragraph_number || payload.video_count || 1));
  const fromClips = clip > 0 ? clip * paragraphs : 0;
  const audioDuration = numericPayloadValue(payload, ["audio_duration_seconds", "song_duration_seconds", "music_duration_seconds", "source_duration_seconds"]);
  const lyricDuration = lyricDurationHint(payload);
  const requested =
    Number.isFinite(direct) && direct > 0
      ? direct
      : Math.max(audioDuration || 0, lyricDuration || 0, fromClips || 0, clip || 0, 8);
  const normalized = Math.max(4, requested);
  return IMAGE_VIDEO_MAX_DURATION_SECONDS > 0
    ? Math.min(normalized, Math.max(8, IMAGE_VIDEO_MAX_DURATION_SECONDS))
    : normalized;
}

function longSegmentCount(targetDuration) {
  const count = Math.max(1, Math.ceil(targetDuration / Math.max(4, IMAGE_VIDEO_SEGMENT_SECONDS)));
  return IMAGE_VIDEO_MAX_SEGMENTS > 0 ? Math.min(count, IMAGE_VIDEO_MAX_SEGMENTS) : count;
}

function booleanEnabled(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return /^(1|true|yes|on)$/i.test(value.trim());
  return false;
}

function lyricLineAllowed(line) {
  const value = String(line || "").trim();
  if (!value) return false;
  if (/^\[[^\]]+\]$/.test(value)) return false;
  if (/^\[[a-z]+:[^\]]*\]$/i.test(value)) return false;
  if (/^new lyrics$/i.test(value)) return false;
  if (/^[（(]?\s*同上\s*[）)]?$/i.test(value)) return false;
  return true;
}

function secondsValue(value, fallback = 0) {
  const direct = Number(value);
  if (Number.isFinite(direct)) return direct;
  const text = String(value || "").trim();
  const match = text.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/);
  if (!match) return fallback;
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  const millis = Number((match[4] || "").padEnd(3, "0") || 0);
  return hours * 3600 + minutes * 60 + seconds + millis / 1000;
}

function stripLyricTimingTags(line) {
  return String(line || "").replace(/\[(?:(?:\d+:)?\d{1,2}:)\d{1,2}(?:[.,]\d{1,3})?\]/g, "").trim();
}

function parseTimestampedLyrics(text) {
  const entries = [];
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const tags = Array.from(line.matchAll(/\[([^\]]+)\]/g)).map((match) => match[1]);
    if (!tags.length) continue;
    const times = tags
      .filter((tag) => String(tag).includes(":"))
      .map((tag) => secondsValue(tag, Number.NaN))
      .filter((value) => Number.isFinite(value) && value >= 0);
    if (!times.length) continue;
    const cleaned = stripLyricTimingTags(line);
    if (!lyricLineAllowed(cleaned)) continue;
    for (const start of times) entries.push({ start, text: cleaned });
  }
  return entries.sort((a, b) => a.start - b.start);
}

function rawTimedLyrics(payload) {
  for (const key of ["timed_lyrics", "lyrics_timeline", "subtitle_segments", "subtitles"]) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return parseTimestampedLyrics(rawLyricsText(payload));
}

function rawLyricsText(payload) {
  for (const key of ["lyrics", "subtitle_text", "caption_text"]) {
    const value = String(payload[key] || "").trim();
    if (value) return value;
  }
  return "";
}

function timedStart(item, fallback = 0) {
  return secondsValue(item.start_seconds ?? item.start ?? item.from ?? item.begin, fallback);
}

function timedEnd(item, fallback = 0) {
  return secondsValue(item.end_seconds ?? item.end ?? item.to ?? item.finish, fallback);
}

function lyricDurationHint(payload) {
  const timed = rawTimedLyrics(payload);
  let max = 0;
  for (const item of timed) {
    const start = timedStart(item, Number.NaN);
    const explicitEnd = timedEnd(item, Number.NaN);
    if (Number.isFinite(explicitEnd)) max = Math.max(max, explicitEnd);
    else if (Number.isFinite(start)) max = Math.max(max, start + 4);
  }
  return max > 0 ? Math.ceil(max) : 0;
}

function normalizeLyricTimeline(payload, targetDuration) {
  const target = Math.max(1, Number(targetDuration || 0));
  const timed = rawTimedLyrics(payload);
  if (timed.length) {
    const normalizedTimed = timed
      .map((item) => {
        const text = String(item.text || item.lyric || item.line || item.caption || "").trim();
        if (!lyricLineAllowed(text)) return null;
        const start = Math.max(0, timedStart(item, 0));
        return { start, text, raw: item };
      })
      .filter(Boolean)
      .sort((a, b) => a.start - b.start);
    return normalizedTimed
      .map((item, index) => {
        const fallbackEnd = index + 1 < normalizedTimed.length ? normalizedTimed[index + 1].start : item.start + 4;
        const end = Math.min(target, Math.max(item.start + 0.8, timedEnd(item.raw, fallbackEnd)));
        return { index: index + 1, start: item.start, end, text: item.text };
      })
      .filter((item) => item.start < target && item.end > item.start);
  }

  const lines = rawLyricsText(payload)
    .split(/\r?\n/)
    .map((line) => stripLyricTimingTags(line).trim())
    .filter(lyricLineAllowed);
  if (!lines.length) return [];
  const slot = target / lines.length;
  return lines.map((text, index) => ({
    index: index + 1,
    start: Number((index * slot).toFixed(3)),
    end: Number(Math.min(target, (index + 1) * slot).toFixed(3)),
    text,
  }));
}

function subtitleEnabled(payload, timeline) {
  if (payload.subtitle_enabled === false || payload.subtitles_enabled === false) return false;
  if (booleanEnabled(payload.subtitle_enabled) || booleanEnabled(payload.subtitles_enabled)) return timeline.length > 0;
  return timeline.length > 0 && (Boolean(rawLyricsText(payload)) || rawTimedLyrics(payload).length > 0);
}

function srtTime(value) {
  const totalMs = Math.max(0, Math.round(Number(value || 0) * 1000));
  const hours = Math.floor(totalMs / 3600000);
  const minutes = Math.floor((totalMs % 3600000) / 60000);
  const seconds = Math.floor((totalMs % 60000) / 1000);
  const millis = totalMs % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

function vttTime(value) {
  return srtTime(value).replace(",", ".");
}

function buildSubtitleSrt(timeline, targetDuration) {
  const target = Math.max(1, Number(targetDuration || 0));
  const lines = timeline
    .map((item, index) => {
      const start = Math.max(0, Math.min(target, Number(item.start || 0)));
      const end = Math.max(start + 0.8, Math.min(target, Number(item.end || start + 4)));
      const text = String(item.text || "").replace(/\r?\n/g, "\n").trim();
      if (!text) return "";
      return `${index + 1}\n${srtTime(start)} --> ${srtTime(end)}\n${text}\n`;
    })
    .filter(Boolean);
  return lines.length ? `${lines.join("\n")}\n` : "";
}

function buildSubtitleVtt(timeline, targetDuration) {
  const target = Math.max(1, Number(targetDuration || 0));
  const lines = timeline
    .map((item) => {
      const start = Math.max(0, Math.min(target, Number(item.start || 0)));
      const end = Math.max(start + 0.8, Math.min(target, Number(item.end || start + 4)));
      const text = String(item.text || "").replace(/\r?\n/g, "\n").trim();
      if (!text) return "";
      return `${vttTime(start)} --> ${vttTime(end)}\n${text}\n`;
    })
    .filter(Boolean);
  return lines.length ? `WEBVTT\n\n${lines.join("\n")}` : "";
}

function srtToVtt(srt) {
  const body = String(srt || "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((line) => !/^\d+\s*$/.test(line.trim()))
    .join("\n")
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2")
    .trim();
  return body ? `WEBVTT\n\n${body}\n` : "";
}

function subtitleMetadata(subtitleSrt, lyricTimeline, targetDuration) {
  if (!subtitleSrt) return {};
  return {
    subtitle_srt: subtitleSrt,
    subtitle_vtt: buildSubtitleVtt(lyricTimeline, targetDuration),
    lyrics_timeline: lyricTimeline,
  };
}

function lyricsForWindow(timeline, start, end) {
  return timeline.filter((item) => item.end > start && item.start < end).map((item) => item.text);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientUpstreamError(error) {
  const message = String(error?.message || error || "");
  return /(^|\s)(408|409|425|429|500|502|503|504)\b/.test(message) ||
    /RESOURCE_EXHAUSTED|UNAVAILABLE|rate limit|Too Many Requests|No available Gemini accounts|fetch failed|network|timeout|aborted/i.test(message);
}

async function retryTransient(label, attempts, delayMs, fn) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isTransientUpstreamError(error)) throw error;
      const waitMs = delayMs * attempt;
      console.warn(`${label} attempt ${attempt} failed, retrying in ${Math.round(waitMs / 1000)}s: ${String(error.message || error)}`);
      await sleep(waitMs);
    }
  }
  throw lastError;
}

function extractVideoUri(payload) {
  if (!payload) return "";
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const found = extractVideoUri(item);
      if (found) return found;
    }
    return "";
  }
  if (typeof payload === "object") {
    if (payload.video && typeof payload.video === "object") {
      const uri = payload.video.uri || payload.video.downloadUri;
      if (typeof uri === "string" && uri) return uri;
    }
    for (const key of ["uri", "downloadUri", "fileUri"]) {
      if (typeof payload[key] === "string" && /^https?:\/\//.test(payload[key])) return payload[key];
    }
    for (const value of Object.values(payload)) {
      const found = extractVideoUri(value);
      if (found) return found;
    }
  }
  return "";
}

function addPublicMediaUrl(item) {
  if (!item || typeof item !== "object") return item;
  const videoId = item.id || item.video_id;
  const filename = item.filename || item.file_name || item.name;
  if (videoId && filename && !item.public_url) {
    item.public_url = `${PUBLIC_BASE_URL}/media/${encodeURIComponent(videoId)}/${encodeURIComponent(filename)}`;
  }
  if (videoId && !item.subtitle_url) {
    item.subtitle_url = `${PUBLIC_BASE_URL}/subtitles/${encodeURIComponent(videoId)}.vtt`;
  }
  return item;
}

async function fetchJson(url, options = {}) {
  const timeoutMs = options.timeoutMs || 120000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  let text = "";
  try {
    response = await fetch(url, { ...options, signal: controller.signal });
    text = await response.text();
  } finally {
    clearTimeout(timer);
  }
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${JSON.stringify(payload).slice(0, 1200)}`);
  }
  return payload;
}

async function createPromptBundle(payload) {
  const subject = String(payload.video_subject || payload.prompt || "").trim();
  const language = payload.video_language || "zh-CN";
  const { baseUrl, apiKey, chatModel } = openAIConfig();
  const fallbackScript = subject;
  const orientation = payload.video_aspect === "16:9" ? "horizontal 16:9" : "vertical 9:16";
  const fallbackFirstFramePrompt = `Create a realistic cinematic ${orientation} opening keyframe. Topic: ${subject}. The subject is clearly preparing to move. Coherent lighting, no text, no watermark, no UI.`;
  const fallbackLastFramePrompt = `Create a realistic cinematic ${orientation} ending keyframe for the same scene and subject. Topic: ${subject}. The subject has completed a visibly different action pose. Keep identity, outfit, and location consistent. No text, no watermark, no UI.`;
  const fallbackVideoPrompt = `${subject}. Animate a clear physical action from the first keyframe to the last keyframe. Prioritize body motion, impact, and coherent continuity over camera movement. Avoid text overlays, subtitles, UI, logos, and watermarks.`;
  if (payload.first_frame_prompt || payload.last_frame_prompt || payload.video_prompt) {
    const firstFramePrompt = String(payload.first_frame_prompt || payload.image_prompt || fallbackFirstFramePrompt);
    const lastFramePrompt = String(payload.last_frame_prompt || fallbackLastFramePrompt);
    return {
      script: String(payload.script || fallbackScript),
      imagePrompt: firstFramePrompt,
      firstFramePrompt,
      lastFramePrompt,
      videoPrompt: String(payload.video_prompt || fallbackVideoPrompt),
    };
  }
  try {
    const result = await fetchJson(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: chatModel,
        messages: [
          {
            role: "system",
            content:
              "You create compact production prompts for AI keyframe-to-video. Return only valid JSON with script, first_frame_prompt, last_frame_prompt, video_prompt.",
          },
          {
            role: "user",
            content:
              `Subject: ${subject}\nLanguage: ${language}\n` +
              "Write one short Chinese script line, one detailed opening keyframe image prompt, one detailed ending keyframe image prompt, and one motion prompt. " +
              "The ending keyframe must show a materially different body/action pose while preserving identity and scene continuity. " +
              "Use concrete visual action. No subtitles, logos, UI, or watermark.",
          },
        ],
      }),
      timeoutMs: 120000,
    });
    const content = result.choices?.[0]?.message?.content || "";
    const match = content.match(/\{[\s\S]*\}/);
    const parsed = match ? JSON.parse(match[0]) : {};
    const firstFramePrompt = String(parsed.first_frame_prompt || parsed.image_prompt || fallbackFirstFramePrompt);
    const lastFramePrompt = String(parsed.last_frame_prompt || fallbackLastFramePrompt);
    return {
      script: String(parsed.script || fallbackScript),
      imagePrompt: firstFramePrompt,
      firstFramePrompt,
      lastFramePrompt,
      videoPrompt: String(parsed.video_prompt || fallbackVideoPrompt),
    };
  } catch (error) {
    return {
      script: fallbackScript,
      imagePrompt: fallbackFirstFramePrompt,
      firstFramePrompt: fallbackFirstFramePrompt,
      lastFramePrompt: fallbackLastFramePrompt,
      videoPrompt: fallbackVideoPrompt,
      prompt_error: String(error.message || error),
    };
  }
}

function fallbackStoryboard(payload, targetDuration, segmentCount) {
  const subject = String(payload.video_subject || payload.prompt || "").trim();
  const orientation = payload.video_aspect === "16:9" ? "horizontal 16:9" : "vertical 9:16";
  const visualBible =
    `Consistent cinematic ${orientation} visual bible for the full video. Same main subject, same outfit, same face, same environment, coherent lighting, no text, no watermark, no UI. Topic: ${subject}.`;
  const segments = Array.from({ length: segmentCount }, (_, index) => {
    const number = index + 1;
    return {
      index: number,
      title: `Segment ${number}`,
      first_frame_prompt:
        index === 0
          ? `${visualBible} Opening keyframe ${number}: the subject is ready to act, clear readable pose.`
          : "",
      last_frame_prompt: `${visualBible} Ending keyframe ${number}: the subject has completed a visibly different action beat. Preserve identity and location continuity from previous frame.`,
      video_prompt:
        `${subject}. Segment ${number} of ${segmentCount}. Animate clear body/action motion from the first keyframe to the last keyframe. ` +
        "Prioritize physical motion and continuity over camera-only motion. Avoid subtitles, logos, UI, and watermarks.",
    };
  });
  return {
    script: `${subject} (${Math.round(targetDuration)}s)`,
    visual_bible: visualBible,
    segments,
  };
}

function normalizeStoryboard(parsed, payload, targetDuration, segmentCount, manifest = null) {
  const fallback = fallbackStoryboard(payload, targetDuration, segmentCount);
  const rawSegments = Array.isArray(parsed?.segments) ? parsed.segments : [];
  const segments = [];
  for (let index = 0; index < segmentCount; index += 1) {
    const item = rawSegments[index] || {};
    const fb = fallback.segments[index];
    const seg = {
      index: index + 1,
      title: textOf(item.title, fb.title),
      first_frame_prompt: textOf(item.first_frame_prompt ?? item.opening_keyframe_prompt, fb.first_frame_prompt),
      last_frame_prompt: textOf(item.last_frame_prompt ?? item.ending_keyframe_prompt, fb.last_frame_prompt),
      video_prompt: textOf(item.video_prompt ?? item.motion_prompt, fb.video_prompt),
    };
    if (manifest) {
      // Segment 1 carries the opening shot; every segment carries its ending shot.
      if (index === 0) seg.first_shot_spec = normalizeShotSpec(findShotSpec(item, "first"), manifest, 0);
      const lastRaw = findShotSpec(item, "last");
      seg.last_shot_spec = normalizeShotSpec(lastRaw, manifest, index + 1);
      seg.last_shot_spec_source = lastRaw ? "llm" : "fallback";
    }
    segments.push(seg);
  }
  if (!segments[0].first_frame_prompt) segments[0].first_frame_prompt = fallback.segments[0].first_frame_prompt;
  return {
    script: textOf(parsed?.script, fallback.script),
    visual_bible: textOf(parsed?.visual_bible ?? parsed?.style_bible, fallback.visual_bible),
    segments,
  };
}

function lyricStoryboard(payload, targetDuration, segmentCount, lyricTimeline) {
  if (!lyricTimeline.length) return null;
  const subject = String(payload.video_subject || payload.prompt || "music video").trim();
  const orientation = payload.video_aspect === "16:9" ? "horizontal 16:9" : "vertical 9:16";
  const visualBible =
    String(payload.visual_bible || "").trim() ||
    `Consistent cinematic ${orientation} music-video visual bible. Persistent lead character, coherent wardrobe, location palette, lighting, and emotional tone. No rendered text, logos, UI, or watermarks; subtitles are added after video generation.`;
  const total = Math.max(1, Number(targetDuration || 0));
  const segments = Array.from({ length: segmentCount }, (_, index) => {
    const start = (index / segmentCount) * total;
    const end = ((index + 1) / segmentCount) * total;
    const lyrics = lyricsForWindow(lyricTimeline, start, end);
    const lyricText = lyrics.join(" / ") || subject;
    const number = index + 1;
    const action =
      `Segment ${number}/${segmentCount}, ${Math.round(start)}-${Math.round(end)}s. Lyrics/emotion: ${lyricText}. ` +
      "Show concrete character action and changing facial/body performance that matches this lyric beat, not only camera movement.";
    return {
      index: number,
      title: `Lyrics ${number}`,
      lyric_text: lyricText,
      first_frame_prompt:
        index === 0
          ? `${visualBible}\nOpening keyframe for ${subject}. ${action} The character is entering the emotional state of the first lyric beat.`
          : "",
      last_frame_prompt: `${visualBible}\nEnding keyframe for ${subject}. ${action} Preserve identity and scene continuity from the previous keyframe while changing pose/action clearly.`,
      video_prompt:
        `${visualBible}\n${action} Animate physical performance, interaction, environment response, and emotional transition between keyframes. ` +
        "Do not render lyric text inside the generated frames.",
    };
  });
  return {
    script: String(payload.script || rawLyricsText(payload) || subject),
    visual_bible: visualBible,
    segments,
  };
}

/* ---------- Story Mode: Blender greybox keyframes ---------- */

function storyModeRequested(payload) {
  return Boolean(BLENDER_STORY_WORKER_URL) && (booleanEnabled(payload.story_mode) || String(payload.keyframe_source || "") === "blender");
}

async function storyManifest() {
  if (storyManifestCache.value && Date.now() - storyManifestCache.at < 60000) return storyManifestCache.value;
  const value = await fetchJson(`${BLENDER_STORY_WORKER_URL}/api/v1/manifest`, { timeoutMs: 15000 });
  storyManifestCache = { at: Date.now(), value };
  return value;
}

/** Compact menu the storyboard LLM picks from. Ids only; it never sees angles or coordinates. */
function storyManifestSummary(manifest) {
  const lines = [];
  if (manifest.scene_guidance) lines.push(`scene_guidance: ${manifest.scene_guidance}`);
  for (const [sid, scene] of Object.entries(manifest.scenes || {})) {
    lines.push(`scene "${sid}": ${scene.description}`);
    lines.push(`  cameras: ${Object.entries(scene.cameras || {}).map(([k, v]) => `${k} (${v})`).join("; ")}`);
    lines.push(`  anchors: ${Object.entries(scene.anchors || {}).map(([k, v]) => `${k} (${v})`).join("; ")}`);
  }
  lines.push("poses:");
  for (const [pid, pose] of Object.entries(manifest.poses || {})) {
    const hint = pose.character_rotation_hint !== undefined ? ` [set character_rotation≈${pose.character_rotation_hint}]` : "";
    lines.push(`  ${pid}: ${pose.description}${hint}`);
  }
  return lines.join("\n");
}

function looksLikeShotSpec(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    ["scene_id", "scene", "camera", "pose_id", "pose", "character_anchor", "anchor"].some((k) => k in value);
}

// The storyboard model names these keys inconsistently between runs (last_shot_spec,
// ending_shot_spec, end_shot, shot_spec_last, nested under last_frame, ...). One miss used to
// silently send the whole job to the warehouse defaults, so pick by key intent instead.
function findShotSpec(item, kind) {
  if (!item || typeof item !== "object") return null;
  const wanted = kind === "first" ? /first|open|start|begin/i : /last|end|clos|final/i;
  const entries = Object.entries(item);
  const direct = entries.filter(([, v]) => looksLikeShotSpec(v));
  const byName = direct.find(([k]) => wanted.test(k));
  if (byName) return byName[1];
  if (kind === "last") {
    const generic = direct.find(([k]) => /shot/i.test(k) && !/first|open|start|begin/i.test(k));
    if (generic) return generic[1];
  }
  for (const [k, v] of entries) {
    if (v && typeof v === "object" && !Array.isArray(v) && wanted.test(k)) {
      const inner = Object.values(v).find(looksLikeShotSpec);
      if (inner) return inner;
    }
  }
  // Last resort: any spec-shaped object that is not clearly the opening one.
  const rest = direct.filter(([k]) => (kind === "first" ? wanted.test(k) : !/first|open|start|begin/i.test(k)));
  return rest.length ? rest[rest.length - 1][1] : null;
}

function pickId(value, ids, labels = {}) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim().replace(/\.blend$/i, "");
  if (ids.includes(text)) return text;
  const lower = text.toLowerCase();
  const byCase = ids.find((id) => id.toLowerCase() === lower);
  if (byCase) return byCase;
  const byLabel = Object.entries(labels).find(([, label]) => label && String(label) === text);
  return byLabel ? byLabel[0] : null;
}

function shotSpecsAsTextRequested(payload) {
  const v = payload?.shot_specs_as_text;
  return v === true || v === 1 || String(v || "").toLowerCase() === "true";
}

// Words-only version of a shot spec, for the non-Blender arm of a same-storyboard comparison:
// the text model is told the same scene, camera, position and pose the 3D render would enforce.
function shotSpecToText(spec, manifest) {
  if (!spec || !manifest) return "";
  const scene = manifest.scenes?.[spec.scene_id];
  const parts = [];
  if (scene?.description) parts.push(`Setting: ${scene.description}`);
  const cam = scene?.cameras?.[spec.camera];
  if (cam) parts.push(`Camera: ${spec.camera} — ${cam}`);
  const anchor = scene?.anchors?.[spec.character_anchor];
  if (anchor) parts.push(`Character position: ${anchor}`);
  const pose = manifest.poses?.[spec.pose_id];
  if (pose?.description) parts.push(`Pose: ${pose.description}`);
  if (Number(spec.character_rotation)) parts.push(`Character turned about ${spec.character_rotation} degrees from facing the camera.`);
  return parts.join(" ");
}

function normalizeShotSpec(raw, manifest, fallbackIndex) {
  const scenes = manifest.scenes || {};
  const sceneIds = Object.keys(scenes);
  const sceneLabels = Object.fromEntries(sceneIds.map((id) => [id, scenes[id]?.label]));
  const sceneId = pickId(raw?.scene_id ?? raw?.scene, sceneIds, sceneLabels) || sceneIds[0];
  const scene = scenes[sceneId] || { cameras: {}, anchors: {} };
  const cams = Object.keys(scene.cameras || {});
  const anchors = Object.keys(scene.anchors || {});
  const poses = Object.keys(manifest.poses || {});
  const poseLabels = Object.fromEntries(poses.map((id) => [id, manifest.poses[id]?.label]));
  const camera = pickId(raw?.camera ?? raw?.camera_id ?? raw?.cam, cams) || cams[fallbackIndex % Math.max(1, cams.length)] || cams[0];
  const anchor = pickId(raw?.character_anchor ?? raw?.anchor, anchors) || "anchor_center";
  const poseId = pickId(raw?.pose_id ?? raw?.pose, poses, poseLabels) || poses[fallbackIndex % Math.max(1, poses.length)] || poses[0];
  const rot = Number(raw?.character_rotation ?? raw?.rotation);
  return {
    scene_id: sceneId,
    camera,
    pose_id: poseId,
    character_anchor: camera === "cam_close" ? "anchor_center" : anchor,
    character_rotation: Number.isFinite(rot) ? Math.max(-180, Math.min(180, rot)) : Number(manifest.poses?.[poseId]?.character_rotation_hint || 0),
  };
}

async function renderStoryKeyframe(shotSpec, aspect, outPath, onStatus = () => {}) {
  const res = aspect === "16:9" ? [1920, 1080] : [1080, 1920];
  const submit = await fetchJson(`${BLENDER_STORY_WORKER_URL}/api/v1/shot`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...shotSpec, resolution: res }),
    timeoutMs: 30000,
  });
  const jobId = submit.job_id;
  if (!jobId) throw new Error(`blender worker returned no job_id: ${JSON.stringify(submit).slice(0, 300)}`);
  const deadline = Date.now() + BLENDER_STORY_TIMEOUT_SECONDS * 1000;
  let last = submit;
  while (Date.now() < deadline) {
    last = await fetchJson(`${BLENDER_STORY_WORKER_URL}/api/v1/shot/${encodeURIComponent(jobId)}`, { timeoutMs: 30000 });
    onStatus({ worker_job_id: jobId, worker_state: last.state, queue_position: last.queue_position });
    if (last.state === "complete") break;
    if (last.state === "failed") throw new Error(`blender render failed: ${last.error || "unknown"}`);
    await sleep(BLENDER_STORY_POLL_INTERVAL * 1000);
  }
  if (last.state !== "complete" || !last.image_b64) throw new Error(`blender render timed out after ${BLENDER_STORY_TIMEOUT_SECONDS}s`);
  const buffer = Buffer.from(last.image_b64, "base64");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, buffer);
  imageMimeTypes.set(outPath, "image/png");
  return { buffer, mimeType: "image/png", camera: last.camera, pose: last.pose, anchor: last.anchor, render_seconds: last.render_seconds };
}

/** 3x3 animatic grid for one segment: the worker interpolates pose, placement and camera from the
    segment's opening shot to its closing shot (same scene). Used for the preview page and to write
    the motion script that goes into the video prompt; Seedance via ezr.sh is first-frame only. */
async function renderStoryGrid(startSpec, endSpec, outPath, onStatus = () => {}) {
  const body = {
    scene_id: startSpec.scene_id,
    start: { ...startSpec },
    end: { ...endSpec, scene_id: startSpec.scene_id },
    panels: 9,
    panel_resolution: [486, 864],
    ease: "smooth",
  };
  const submit = await fetchJson(`${BLENDER_STORY_WORKER_URL}/api/v1/grid`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    timeoutMs: 30000,
  });
  const jobId = submit.job_id;
  if (!jobId) throw new Error(`blender worker returned no grid job_id: ${JSON.stringify(submit).slice(0, 300)}`);
  const deadline = Date.now() + BLENDER_STORY_TIMEOUT_SECONDS * 1000;
  let last = submit;
  while (Date.now() < deadline) {
    last = await fetchJson(`${BLENDER_STORY_WORKER_URL}/api/v1/shot/${encodeURIComponent(jobId)}`, { timeoutMs: 30000 });
    onStatus({ worker_job_id: jobId, worker_state: last.state, queue_position: last.queue_position });
    if (last.state === "complete") break;
    if (last.state === "failed") throw new Error(`blender grid render failed: ${last.error || "unknown"}`);
    await sleep(BLENDER_STORY_POLL_INTERVAL * 1000);
  }
  if (last.state !== "complete" || !last.image_b64) throw new Error(`blender grid render timed out after ${BLENDER_STORY_TIMEOUT_SECONDS}s`);
  const buffer = Buffer.from(last.image_b64, "base64");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, buffer);
  imageMimeTypes.set(outPath, "image/png");
  return { buffer, mimeType: "image/png", render_seconds: last.render_seconds, resolution: last.resolution };
}

/** Plain-language timeline of what changes between a segment's opening and closing shot, so the
    video model is told the motion explicitly (it only sees the opening frame). */
function storyMotionScript(startSpec, endSpec, manifest, durationSeconds) {
  if (!startSpec || !endSpec) return "";
  const scene = manifest.scenes?.[startSpec.scene_id] || {};
  const lines = [];
  const d = Math.round(Number(durationSeconds) || 8);
  if (endSpec.scene_id && endSpec.scene_id !== startSpec.scene_id) {
    const endScene = manifest.scenes?.[endSpec.scene_id];
    lines.push(`Motion script (0-${d}s): the whole clip stays in this location; the story then cuts to ${endScene?.label || endSpec.scene_id}, so end on a clear, held final pose.`);
  } else {
    const camA = scene.cameras?.[startSpec.camera], camB = scene.cameras?.[endSpec.camera];
    const cam = startSpec.camera === endSpec.camera
      ? `camera holds (${startSpec.camera}: ${camA || ""})`
      : `camera moves smoothly from ${startSpec.camera} (${camA || ""}) to ${endSpec.camera} (${camB || ""})`;
    const anchA = scene.anchors?.[startSpec.character_anchor], anchB = scene.anchors?.[endSpec.character_anchor];
    const rotA = Number(startSpec.character_rotation || 0), rotB = Number(endSpec.character_rotation || 0);
    const place = startSpec.character_anchor === endSpec.character_anchor && rotA === rotB
      ? `the character stays at ${startSpec.character_anchor} (${anchA || ""})`
      : `the character moves from ${startSpec.character_anchor} (${anchA || ""}) to ${endSpec.character_anchor} (${anchB || ""})${rotA !== rotB ? `, turning about ${Math.round(rotB - rotA)} degrees` : ""}`;
    const poseA = manifest.poses?.[startSpec.pose_id]?.description || startSpec.pose_id;
    const poseB = manifest.poses?.[endSpec.pose_id]?.description || endSpec.pose_id;
    const pose = startSpec.pose_id === endSpec.pose_id
      ? `the pose stays: ${poseA}`
      : `the body goes from "${poseA}" to "${poseB}"`;
    lines.push(`Motion script (0-${d}s, one continuous shot): ${cam}; ${place}; ${pose}. Complete the full transition within the clip so the LAST frame shows the end pose, position and framing. Real body motion, not camera-only.`);
  }
  return lines.join(" ");
}

/** One character turnaround per job (front / side / back), used as the identity reference on
    every restyle so the same person survives across shots. Text-to-image; no greybox involved. */
function storyTurnaroundPrompt(visualBible) {
  return [
    "Character design turnaround sheet of ONE character: three full-body views side by side on a single plain light-grey background — front view on the left, side profile in the middle, back view on the right. Same character, same wardrobe, same hair, same proportions in all three. Even soft studio light, no shadows on the backdrop, feet visible, neutral standing pose.",
    "Semi-realistic cinematic concept-art rendering. Face calm, not a photo of an identifiable real person.",
    "No text, no labels, no arrows, no props, no scenery, no extra people, no frames or borders.",
    visualBible ? `Character (from the visual bible): ${visualBible}` : "",
  ].filter(Boolean).join("\n");
}

/** Restyle prompt: appearance from the storyboard, structure locked to the greybox reference.
    Verbal pose/framing reinforcement measurably tightens adherence (step-0 variant B). */
function storyRestylePrompt(visualBible, framePrompt, shotSpec, manifest, hasTurnaround = false) {
  const pose = manifest.poses?.[shotSpec.pose_id];
  const scene = manifest.scenes?.[shotSpec.scene_id];
  const cam = scene?.cameras?.[shotSpec.camera];
  return [
    hasTurnaround
      ? "Image 1 is a grey clay render: it is the ONLY authority for pose, framing, camera angle, subject size and position. Image 2 is the character turnaround sheet: it is the ONLY authority for who the character is — face, hair, wardrobe, colours, accessories. Restyle image 1 into a photorealistic cinematic keyframe of the character from image 2."
      : "Restyle this grey clay-render reference into a photorealistic cinematic keyframe.",
    "CRITICAL: preserve the exact body pose, limb directions, camera angle and framing from the reference. Keep the subject at the SAME size and SAME position in frame as the clay figure (do not zoom in, do not enlarge or re-centre the person), and keep every prop and wall exactly where it is. Replace only materials, clothing, skin, hair, lighting detail and environment surfaces.",
    // Video models reject inputs that read as an identifiable real person; keep faces cinematic
    // and non-frontal so the keyframe passes downstream privacy screening.
    "Render the face as a stylised cinematic character, not a photo of a real identifiable person: favour three-quarter or profile angles, motion, hair or shadow across part of the face; never a sharp frontal passport-style face looking straight into the lens.",
    pose ? `The pose is: ${pose.description}` : "",
    cam ? `The shot is: ${cam}` : "",
    scene ? `The grey environment in the reference is: ${scene.description} Keep its architecture, terrain and silhouettes exactly where they are; re-dress surfaces, materials, light and atmosphere in the brief's style.` : "",
    visualBible ? `Visual bible: ${visualBible}` : "",
    framePrompt ? `This keyframe: ${framePrompt}` : "",
    "No text, no watermark, no UI, no extra people.",
  ].filter(Boolean).join("\n");
}

/** LLMs sometimes return nested objects where a string was requested; keep them readable. */
function textOf(value, fallback = "") {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return Object.values(value).filter((v) => typeof v === "string").join(" ") || JSON.stringify(value);
  } catch {
    return fallback;
  }
}

/** Story Mode keyframe producer: render greybox, restyle via reference edit, fall back to plain
    text-to-image so a worker outage degrades the shot instead of failing the whole job. */
async function generateStoryKeyframe(item, aspect, storyboard, manifest, hooks, setStatus, job) {
  const greyboxPath = item.path.replace(/keyframe-(\d+)\.png$/, "greybox-$1.png").replace(/shot-(\d+)-(first|last)\.png$/, "greybox-$1-$2.png");
  try {
    setStatus({ status: "rendering_greybox" });
    const grey = await renderStoryKeyframe(item.shotSpec, aspect, greyboxPath, (st) => setStatus({ status: "rendering_greybox", ...st }));
    if (Array.isArray(job.greybox_paths)) job.greybox_paths.push(greyboxPath);
    setStatus({ status: "restyling", greybox_render_seconds: grey.render_seconds });
    const refs = [{ buffer: grey.buffer, mimeType: grey.mimeType, filename: "greybox.png" }];
    const turnaround = job.turnaround_path && existsSync(job.turnaround_path) ? readFileSync(job.turnaround_path) : null;
    if (turnaround) refs.push({ buffer: turnaround, mimeType: imageMimeTypes.get(job.turnaround_path) || "image/png", filename: "turnaround.png" });
    const prompt = storyRestylePrompt(storyboard.visual_bible, item.prompt, item.shotSpec, manifest, Boolean(turnaround));
    const result = await editImageWithReference(prompt, aspect, item.path, refs, hooks);
    return { ...result, keyframe_source: turnaround ? "blender-greybox+turnaround+gpt-restyle" : "blender-greybox+gpt-restyle", shot_spec: item.shotSpec };
  } catch (error) {
    const reason = String(error.message || error);
    job.keyframe_last_error = reason;
    job.story_fallbacks = [...(job.story_fallbacks || []), { index: item.index + 1, reason: reason.slice(0, 240) }];
    setStatus({ status: "fallback_generation", error: reason.slice(0, 240) });
    const result = await generateImage(item.prompt, aspect, item.path, hooks);
    return { ...result, keyframe_source: "gpt-image-fallback", shot_spec: item.shotSpec };
  }
}

async function createStoryboard(payload, targetDuration, segmentCount, lyricTimeline = []) {
  if (Array.isArray(payload.storyboard_segments) && payload.storyboard_segments.length) {
    // A caller-supplied board lets two jobs (Blender story mode vs plain text keyframes) share the
    // exact same script, prompts and shot picks, so a comparison isolates the keyframe producer.
    const providedStory = storyModeRequested(payload);
    let providedManifest = null;
    if (providedStory || shotSpecsAsTextRequested(payload)) {
      try { providedManifest = await storyManifest(); } catch (error) { console.warn("storyboard manifest unavailable:", String(error.message || error)); }
    }
    return {
      ...normalizeStoryboard(
        { script: payload.script, visual_bible: payload.visual_bible, segments: payload.storyboard_segments },
        payload,
        targetDuration,
        segmentCount,
        providedManifest,
      ),
      story_mode: providedStory,
      storyboard_source: "provided",
    };
  }
  const story = storyModeRequested(payload);
  const manifest = story ? await storyManifest() : null;
  const fromLyrics = story ? null : lyricStoryboard(payload, targetDuration, segmentCount, lyricTimeline);
  if (fromLyrics) return fromLyrics;
  const subject = String(payload.video_subject || payload.prompt || "").trim();
  const language = payload.video_language || "zh-CN";
  const aspect = payload.video_aspect === "16:9" ? "16:9" : "9:16";
  const { baseUrl, apiKey, chatModel } = openAIConfig();
  const storySystem = story
    ? " The keyframes will be RENDERED from a fixed 3D scene, so for segment 1 also return first_shot_spec, and for every segment return last_shot_spec, each an object {scene_id, camera, pose_id, character_anchor, character_rotation} choosing ONLY from the provided menu. First pick the scene whose world fits the brief (follow the menu's scene_guidance); you MAY change scene_id when the story moves to a new location, but hold each scene for at least two consecutive segments so the video does not cut every shot. Vary camera and pose across segments to tell the story. Keyframe prompts should then describe appearance (wardrobe, skin, hair, lighting mood, surfaces) and how the 3D scene should be re-dressed in the brief's style, not pose or framing."
    : "";
  const storyUser = story ? `\n\nAvailable 3D menu:\n${storyManifestSummary(manifest)}\n` : "";
  const messages = [
    {
      role: "system",
      content:
        "You design production storyboards for GPT image keyframes and image-to-video. Return only valid JSON with script, visual_bible, and segments. Each segment needs title, first_frame_prompt only for segment 1, last_frame_prompt, and video_prompt." + storySystem +
        " Keep each prompt under 80 words and the whole reply a single JSON object.",
    },
    {
      role: "user",
      content:
        `Subject: ${subject}\nLanguage: ${language}\nAspect: ${aspect}\nTarget duration: ${targetDuration}s\nSegment count: ${segmentCount}\n` +
        "Create a continuous short-video storyboard. Use one persistent character/scene visual bible. " +
        "Generate only one opening keyframe prompt for segment 1, then one ending keyframe prompt per segment; the previous segment's ending frame will be reused as the next segment's opening frame. " +
        "Every ending frame must show a materially different body/action pose. Motion prompts must demand real subject movement, not just camera movement. " +
        "No subtitles, visible text, logos, UI, watermarks, or random identity changes." + storyUser,
    },
  ];
  // A 5-segment Chinese board is ~3k output tokens and one malformed reply used to degrade the
  // whole job to the generic fallback board, so: JSON mode, explicit budget, and two retries.
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const result = await fetchJson(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: chatModel,
          messages,
          max_completion_tokens: 8000,
          ...(attempt < 2 ? { response_format: { type: "json_object" } } : {}),
        }),
        timeoutMs: 180000,
      });
      const content = result.choices?.[0]?.message?.content || "";
      const match = content.match(/\{[\s\S]*\}/);
      if (!match) throw new Error("storyboard reply contained no JSON object");
      const parsed = JSON.parse(match[0]);
      if (!Array.isArray(parsed.segments) || !parsed.segments.length) throw new Error("storyboard JSON has no segments");
      return {
        ...normalizeStoryboard(parsed, payload, targetDuration, segmentCount, manifest),
        story_mode: story,
        storyboard_source: "llm",
        storyboard_attempts: attempt + 1,
        storyboard_raw: story ? content.slice(0, 12000) : undefined,
      };
    } catch (error) {
      lastError = error;
      console.warn(`storyboard attempt ${attempt + 1} failed: ${String(error.message || error).slice(0, 200)}`);
    }
  }
  return {
    ...normalizeStoryboard({}, payload, targetDuration, segmentCount, manifest),
    story_mode: story,
    storyboard_source: "fallback",
    prompt_error: String(lastError?.message || lastError),
  };
}

function planningRequested(payload) {
  return booleanEnabled(payload.plan_only) || booleanEnabled(payload.dry_run) || booleanEnabled(payload.preview_only) || booleanEnabled(payload.storyboard_preview);
}

function createPlanningPreview(payload) {
  const subject = String(payload.video_subject || payload.prompt || "").trim();
  const targetDuration = requestedTotalDuration(payload);
  const segmentCount = longSegmentCount(targetDuration);
  const segmentDuration = normalizeDuration(IMAGE_VIDEO_SEGMENT_SECONDS);
  const lyricTimeline = normalizeLyricTimeline(payload, targetDuration);
  const subtitleSrt = subtitleEnabled(payload, lyricTimeline) ? buildSubtitleSrt(lyricTimeline, targetDuration) : "";
  const storyboard =
    Array.isArray(payload.storyboard_segments) && payload.storyboard_segments.length
      ? normalizeStoryboard({ script: payload.script, visual_bible: payload.visual_bible, segments: payload.storyboard_segments }, payload, targetDuration, segmentCount)
      : lyricStoryboard(payload, targetDuration, segmentCount, lyricTimeline) || fallbackStoryboard(payload, targetDuration, segmentCount);
  return {
    plan_only: true,
    video_subject: subject,
    target_duration: targetDuration,
    segment_count: segmentCount,
    segment_duration: segmentDuration,
    keyframe_count: segmentCount + 1,
    subtitle_enabled: Boolean(subtitleSrt),
    subtitle_count: lyricTimeline.length,
    lyrics_timeline: lyricTimeline,
    subtitle_srt: subtitleSrt,
    subtitle_vtt: subtitleSrt ? buildSubtitleVtt(lyricTimeline, targetDuration) : "",
    script: storyboard.script,
    visual_bible: storyboard.visual_bible,
    storyboard_segments: storyboard.segments,
    image_model: IMAGE_MODEL,
    image_fallback_models: IMAGE_OPENAI_FALLBACK_MODELS,
    video_model: activeVideoModel(),
    max_duration: IMAGE_VIDEO_MAX_DURATION_SECONDS > 0 ? IMAGE_VIDEO_MAX_DURATION_SECONDS : null,
    max_segments: IMAGE_VIDEO_MAX_SEGMENTS > 0 ? IMAGE_VIDEO_MAX_SEGMENTS : null,
  };
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function generateImage(prompt, aspect, outPath, hooks = {}) {
  const { baseUrl, apiKey } = openAIConfig();
  const models = hooks.models || IMAGE_GENERATION_MODELS;
  let payload = null;
  let lastError = null;
  let usedModel = "";
  for (let attempt = 1; attempt <= IMAGE_GENERATION_RETRIES; attempt += 1) {
    const model = models[Math.min(attempt - 1, models.length - 1)] || IMAGE_MODEL;
    try {
      hooks.onAttempt?.({ attempt, maxAttempts: IMAGE_GENERATION_RETRIES, timeoutSeconds: IMAGE_OPENAI_TIMEOUT_SECONDS, model });
      payload = await fetchJson(`${baseUrl}/images/generations`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(imageGenerationBody(model, prompt, aspect)),
        timeoutMs: IMAGE_OPENAI_TIMEOUT_SECONDS * 1000,
      });
      lastError = null;
      usedModel = model;
      hooks.onSuccess?.({ attempt, maxAttempts: IMAGE_GENERATION_RETRIES, model });
      break;
    } catch (error) {
      lastError = error;
      hooks.onAttemptError?.({
        attempt,
        maxAttempts: IMAGE_GENERATION_RETRIES,
        timeoutSeconds: IMAGE_OPENAI_TIMEOUT_SECONDS,
        willRetry: attempt < IMAGE_GENERATION_RETRIES,
        model,
        error: error.message || String(error),
      });
      if (attempt < IMAGE_GENERATION_RETRIES) {
        await sleep(Math.min(30000, 3000 * attempt * attempt));
      }
    }
  }
  if (lastError) {
    throw new Error(`image generation failed after ${IMAGE_GENERATION_RETRIES} attempt(s): ${lastError.message || lastError}`);
  }
  const item = payload.data?.[0];
  if (!item) throw new Error("image generation returned no data");
  let buffer;
  if (item.b64_json) {
    buffer = Buffer.from(item.b64_json, "base64");
  } else if (item.url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    const response = await fetch(item.url, { signal: controller.signal }).finally(() => clearTimeout(timer));
    if (!response.ok) throw new Error(`image download failed: ${response.status}`);
    buffer = Buffer.from(await response.arrayBuffer());
  } else {
    throw new Error("image generation returned unsupported payload");
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, buffer);
  const finalModel = usedModel || IMAGE_MODEL;
  const mimeType = isSeedreamModel(finalModel)
    ? "image/png"
    : normalizeImageMime(`image/${IMAGE_OPENAI_OUTPUT_FORMAT || "png"}`);
  imageMimeTypes.set(outPath, mimeType);
  return { model: finalModel, mimeType, size: buffer.length, mode: "generation" };
}

async function editImageWithReference(prompt, aspect, outPath, references, hooks = {}) {
  const { baseUrl, apiKey } = openAIConfig();
  let payload = null;
  let lastError = null;
  let usedModel = "";
  const source = references[0];
  if (!source?.buffer?.length) throw new Error("reference image is empty");
  for (let attempt = 1; attempt <= IMAGE_GENERATION_RETRIES; attempt += 1) {
    const model = IMAGE_GENERATION_MODELS[Math.min(attempt - 1, IMAGE_GENERATION_MODELS.length - 1)] || IMAGE_MODEL;
    try {
      hooks.onAttempt?.({ attempt, maxAttempts: IMAGE_GENERATION_RETRIES, timeoutSeconds: IMAGE_OPENAI_TIMEOUT_SECONDS, model });
      const form = new FormData();
      form.append("model", model);
      form.append("prompt", prompt);
      form.append("size", imageSize(aspect));
      form.append("n", "1");
      if (IMAGE_OPENAI_QUALITY) form.append("quality", IMAGE_OPENAI_QUALITY);
      if (IMAGE_OPENAI_OUTPUT_FORMAT) form.append("output_format", IMAGE_OPENAI_OUTPUT_FORMAT);
      if (IMAGE_OPENAI_OUTPUT_COMPRESSION > 0) form.append("output_compression", String(IMAGE_OPENAI_OUTPUT_COMPRESSION));
      // OpenAI accepts several references as repeated `image[]` parts; a single one stays `image`.
      const refs = references.filter((r) => r?.buffer?.length);
      const field = refs.length > 1 ? "image[]" : "image";
      for (const [i, ref] of refs.entries()) {
        form.append(field, new Blob([ref.buffer], { type: ref.mimeType || "image/png" }), ref.filename || `reference-${i + 1}.png`);
      }
      payload = await fetchJson(`${baseUrl}/images/edits`, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}` },
        body: form,
        timeoutMs: IMAGE_OPENAI_TIMEOUT_SECONDS * 1000,
      });
      lastError = null;
      usedModel = model;
      hooks.onSuccess?.({ attempt, maxAttempts: IMAGE_GENERATION_RETRIES, model });
      break;
    } catch (error) {
      lastError = error;
      hooks.onAttemptError?.({
        attempt,
        maxAttempts: IMAGE_GENERATION_RETRIES,
        timeoutSeconds: IMAGE_OPENAI_TIMEOUT_SECONDS,
        willRetry: attempt < IMAGE_GENERATION_RETRIES,
        model,
        error: error.message || String(error),
      });
      if (attempt < IMAGE_GENERATION_RETRIES) {
        await sleep(Math.min(30000, 3000 * attempt * attempt));
      }
    }
  }
  if (lastError) {
    throw new Error(`image edit failed after ${IMAGE_GENERATION_RETRIES} attempt(s): ${lastError.message || lastError}`);
  }
  const item = payload.data?.[0];
  if (!item) throw new Error("image edit returned no data");
  let buffer;
  if (item.b64_json) {
    buffer = Buffer.from(item.b64_json, "base64");
  } else if (item.url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    const response = await fetch(item.url, { signal: controller.signal }).finally(() => clearTimeout(timer));
    if (!response.ok) throw new Error(`image download failed: ${response.status}`);
    buffer = Buffer.from(await response.arrayBuffer());
  } else {
    throw new Error("image edit returned unsupported payload");
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, buffer);
  const mimeType = normalizeImageMime(`image/${IMAGE_OPENAI_OUTPUT_FORMAT || "png"}`);
  imageMimeTypes.set(outPath, mimeType);
  return { model: usedModel || IMAGE_MODEL, mimeType, size: buffer.length, mode: "edit" };
}

function normalizeImageMime(mimeType) {
  const value = String(mimeType || "").split(";")[0].trim().toLowerCase();
  if (value === "image/jpg") return "image/jpeg";
  if (["image/png", "image/jpeg", "image/webp"].includes(value)) return value;
  return "image/png";
}

function decodeImageBase64(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
  if (match) {
    return { buffer: Buffer.from(match[2], "base64"), mimeType: normalizeImageMime(match[1]) };
  }
  return { buffer: Buffer.from(raw, "base64"), mimeType: "image/png" };
}

function extractReferenceImages(payload) {
  const refs = [];
  const candidates = [];
  if (payload.image_b64) candidates.push({ b64: payload.image_b64, filename: payload.image_filename });
  if (Array.isArray(payload.reference_images)) {
    for (const item of payload.reference_images) {
      if (typeof item === "string") candidates.push({ b64: item });
      else if (item && typeof item === "object") candidates.push(item);
    }
  }
  for (const item of candidates.slice(0, 4)) {
    const raw = item.b64 || item.data_url || item.data || "";
    if (!raw) continue;
    const decoded = decodeImageBase64(raw);
    if (!decoded.buffer.length) continue;
    refs.push({
      buffer: decoded.buffer,
      mimeType: normalizeImageMime(item.mime_type || item.mimeType || decoded.mimeType),
      filename: basename(String(item.filename || item.name || `reference-${refs.length + 1}.png`)),
    });
  }
  return refs;
}

function standaloneImagePrompt(payload, index, count) {
  const prompt = String(payload.prompt || payload.image_prompt || payload.video_subject || "").trim();
  if (!prompt) return "";
  const style = String(payload.style || payload.visual_style || "").trim();
  const brand = String(payload.brand || payload.brand_kit || "").trim();
  const format = String(payload.format || payload.asset_type || "").trim();
  const audience = String(payload.audience || "").trim();
  const negative = String(payload.negative_prompt || "").trim();
  return [
    "Create one production-ready visual asset.",
    `Brief: ${prompt}`,
    style ? `Visual style: ${style}` : "",
    brand ? `Brand rules: ${brand}` : "",
    format ? `Asset format: ${format}` : "",
    audience ? `Audience: ${audience}` : "",
    count > 1 ? `Variation ${index} of ${count}: keep the same core idea but change composition, staging, and detail.` : "",
    "Keep composition coherent, text legible when requested, no watermark, no UI chrome, no extra logos unless specified.",
    negative ? `Avoid: ${negative}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

async function createStandaloneImages(payload) {
  const prompt = String(payload.prompt || payload.image_prompt || payload.video_subject || "").trim();
  if (!prompt) throw new Error("prompt is required");
  const aspect = String(payload.aspect_ratio || payload.aspect || payload.video_aspect || "1:1");
  const count = Math.max(1, Math.min(4, Number(payload.n || payload.count || payload.image_count || 1)));
  const imageId = `img-${randomUUID()}`;
  const runDir = join(IMAGE_OUTPUT_DIR, imageId);
  mkdirSync(runDir, { recursive: true });
  const references = extractReferenceImages(payload);
  const images = [];
  const errors = [];
  await mapLimit(Array.from({ length: count }, (_, index) => index + 1), Math.min(count, IMAGE_GENERATION_CONCURRENCY), async (index) => {
    const filename = `image-${String(index).padStart(2, "0")}.${imageExtension()}`;
    const outPath = join(runDir, filename);
    const imagePrompt = standaloneImagePrompt(payload, index, count);
    let result;
    let referenceMode = references.length ? "edit" : "none";
    try {
      if (references.length) {
        try {
          result = await editImageWithReference(imagePrompt, aspect, outPath, references);
        } catch (error) {
          referenceMode = "fallback_generation";
          errors.push(`reference edit fallback for image-${index}: ${error.message || error}`);
          result = await generateImage(`${imagePrompt}\nUse the uploaded reference only as conceptual direction if unavailable to the model.`, aspect, outPath);
        }
      } else {
        result = await generateImage(imagePrompt, aspect, outPath);
      }
      const stat = statSync(outPath);
      const publicUrl = imagePublicUrl(imageId, filename);
      images.push({
        id: `${imageId}-${index}`,
        image_id: imageId,
        index,
        filename,
        prompt: imagePrompt,
        aspect_ratio: aspect,
        model: result.model,
        mode: result.mode,
        reference_mode: referenceMode,
        mime_type: result.mimeType,
        size: stat.size,
        public_url: publicUrl,
        download_url: publicUrl,
      });
    } catch (error) {
      errors.push(`image-${index}: ${error.message || error}`);
    }
  });
  images.sort((a, b) => a.index - b.index);
  if (!images.length) throw new Error(errors.join("; ") || "no images generated");
  return {
    job_id: imageId,
    state: "complete",
    progress: 100,
    prompt,
    aspect_ratio: aspect,
    count,
    image_model: IMAGE_MODEL,
    image_fallback_models: IMAGE_OPENAI_FALLBACK_MODELS,
    image_quality: IMAGE_OPENAI_QUALITY,
    image_output_format: IMAGE_OPENAI_OUTPUT_FORMAT,
    image_output_compression: IMAGE_OPENAI_OUTPUT_COMPRESSION,
    reference_count: references.length,
    images,
    errors,
  };
}

async function materializeProvidedImage(payload, prefix, outPath) {
  const b64 = payload[`${prefix}_image_b64`] || (prefix === "first" ? payload.image_b64 : "");
  const imageUrl = payload[`${prefix}_image_url`] || (prefix === "first" ? payload.image_url : "");
  if (b64) {
    const { buffer, mimeType } = decodeImageBase64(b64);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, buffer);
    imageMimeTypes.set(outPath, mimeType);
    return { provider: "provided-image", source: "base64", mimeType };
  }
  if (imageUrl) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);
    let response;
    let buffer;
    try {
      response = await fetch(String(imageUrl), { signal: controller.signal });
      if (!response.ok) throw new Error(`provided image download failed: ${response.status} ${response.statusText}`);
      buffer = Buffer.from(await response.arrayBuffer());
    } finally {
      clearTimeout(timer);
    }
    const mimeType = normalizeImageMime(response.headers.get("content-type"));
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, buffer);
    imageMimeTypes.set(outPath, mimeType);
    return { provider: "provided-image", source: "url", mimeType };
  }
  return null;
}

function geminiImagePayload(imagePath) {
  return {
    bytesBase64Encoded: readFileSync(imagePath).toString("base64"),
    mimeType: imageMimeTypes.get(imagePath) || "image/png",
  };
}

async function submitGeminiVideo(prompt, firstImagePath, lastImagePath, aspect, duration) {
  if (!GEMINI_VIDEO_API_KEY) throw new Error("GEMINI_VIDEO_API_KEY is not configured");
  const instance = {
    prompt,
    image: geminiImagePayload(firstImagePath),
  };
  if (lastImagePath && existsSync(lastImagePath)) {
    instance.lastFrame = geminiImagePayload(lastImagePath);
  }
  const body = JSON.stringify({
    instances: [instance],
    parameters: {
      aspectRatio: aspect === "16:9" ? "16:9" : "9:16",
      durationSeconds: duration,
      resolution: GEMINI_VIDEO_RESOLUTION,
      personGeneration: GEMINI_VIDEO_PERSON_GENERATION,
    },
  });
  return retryTransient("Gemini video submit", GEMINI_VIDEO_SUBMIT_RETRIES, GEMINI_VIDEO_SUBMIT_RETRY_DELAY_SECONDS * 1000, () =>
    fetchJson(`${GEMINI_VIDEO_BASE_URL}/models/${GEMINI_VIDEO_MODEL}:predictLongRunning`, {
      method: "POST",
      headers: {
        "x-goog-api-key": GEMINI_VIDEO_API_KEY,
        "content-type": "application/json",
      },
      body,
      timeoutMs: GEMINI_VIDEO_SUBMIT_TIMEOUT_SECONDS * 1000,
    }),
  );
}

async function pollGemini(operationName) {
  const deadline = Date.now() + GEMINI_VIDEO_TIMEOUT_SECONDS * 1000;
  let lastStatus = {};
  while (Date.now() < deadline) {
    lastStatus = await fetchJson(`${GEMINI_VIDEO_BASE_URL}/${String(operationName).replace(/^\/+/, "")}`, {
      headers: { "x-goog-api-key": GEMINI_VIDEO_API_KEY },
      timeoutMs: 60000,
    });
    if (lastStatus.done === true) {
      if (lastStatus.error) throw new Error(`Gemini video generation failed: ${JSON.stringify(lastStatus.error)}`);
      return lastStatus;
    }
    await sleep(GEMINI_VIDEO_POLL_INTERVAL * 1000);
  }
  throw new Error(`Gemini video generation timed out: ${JSON.stringify(lastStatus).slice(0, 1200)}`);
}

function proxiedGeminiVideoUri(uri, operationName) {
  const raw = String(uri || "");
  const googlePrefix = "https://generativelanguage.googleapis.com/v1beta/";
  if (!raw.startsWith(googlePrefix)) return raw;
  const relative = raw.slice(googlePrefix.length).replace(/^\/+/, "");
  const proxied = new URL(`${GEMINI_VIDEO_BASE_URL}/${relative}`);
  if (operationName) proxied.searchParams.set("operation", operationName);
  return proxied.toString();
}

async function downloadGeminiVideo(uri, outputPath, operationName) {
  const downloadUri = proxiedGeminiVideoUri(uri, operationName);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_VIDEO_DOWNLOAD_TIMEOUT_SECONDS * 1000);
  let response;
  try {
    response = await fetch(downloadUri, { headers: { "x-goog-api-key": GEMINI_VIDEO_API_KEY }, redirect: "follow", signal: controller.signal });
    if (!response.ok) throw new Error(`Gemini video download failed: ${response.status} ${response.statusText}`);
    if (!response.body) throw new Error("Gemini video download returned no body");
    mkdirSync(dirname(outputPath), { recursive: true });
    await pipeline(Readable.fromWeb(response.body), createWriteStream(outputPath));
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- OpenAI-style video backends (Seedance / Veo via relay) ----------
   Contract: POST {base}/video/generations {model, prompt, image} -> {task_id}
             GET  {base}/video/generations/{task_id} -> {data:{status, result_url|url, ...}}
   Aspect/duration ride inside the prompt as Ark-style --flags (top-level fields are ignored
   by the relay); without --ratio the default is 21:9. Unknown body fields are silently
   dropped and the request still bills, so never add speculative fields here. */

function openAIVideoConfig() {
  if (!OPENAI_VIDEO_BASE_URL || !OPENAI_VIDEO_API_KEY) throw new Error("OPENAI_VIDEO_BASE_URL / OPENAI_VIDEO_API_KEY is not configured");
  return { baseUrl: OPENAI_VIDEO_BASE_URL, apiKey: OPENAI_VIDEO_API_KEY };
}

function openAIVideoModel() {
  return VIDEO_BACKEND === "veo-openai" ? VEO_OPENAI_MODEL : SEEDANCE_MODEL;
}

function imageDataUrl(imagePath) {
  const mime = imageMimeTypes.get(imagePath) || "image/png";
  return `data:${mime};base64,${readFileSync(imagePath).toString("base64")}`;
}

function withArkFlags(prompt, aspect, duration) {
  const ratio = aspect === "16:9" ? "16:9" : "9:16";
  const seconds = Math.max(2, Math.min(12, Math.round(Number(duration) || 5)));
  return `${String(prompt || "").trim()} --ratio ${ratio} --duration ${seconds}`;
}

async function submitOpenAIVideo(prompt, firstImagePath, aspect, duration, modelOverride = "") {
  const { baseUrl, apiKey } = openAIVideoConfig();
  const model = modelOverride || openAIVideoModel();
  const isSeedance = VIDEO_BACKEND !== "veo-openai";
  const steered = isSeedance && SEEDANCE_AUDIO_HINT ? `${String(prompt || "").trim()} ${SEEDANCE_AUDIO_HINT}` : String(prompt || "").trim();
  const body = {
    model,
    prompt: isSeedance ? withArkFlags(steered, aspect, duration) : steered,
    image: imageDataUrl(firstImagePath),
  };
  const payload = await retryTransient(`${model} video submit`, GEMINI_VIDEO_SUBMIT_RETRIES, GEMINI_VIDEO_SUBMIT_RETRY_DELAY_SECONDS * 1000, () =>
    fetchJson(`${baseUrl}/video/generations`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      timeoutMs: GEMINI_VIDEO_SUBMIT_TIMEOUT_SECONDS * 1000,
    }),
  );
  const taskId = payload.task_id || payload.id;
  if (!taskId) throw new Error(`${model} submit returned no task_id: ${JSON.stringify(payload).slice(0, 600)}`);
  return { name: String(taskId), model };
}

function validHttpUrl(value) {
  const raw = String(value || "").trim();
  if (!/^https?:\/\//i.test(raw)) return "";
  try {
    return new URL(raw).toString();
  } catch {
    return "";
  }
}

/** The relay returns Veo content URLs on a host that resolves into the 198.18/15 proxy range
    and is unreachable here; the same path served from the configured base host works. */
function rewriteVideoResultHost(url) {
  const raw = String(url || "");
  if (!raw) return raw;
  try {
    const target = new URL(raw);
    const base = new URL(OPENAI_VIDEO_BASE_URL);
    if (target.host !== base.host && /easyrouter|ezr/i.test(target.host)) {
      target.protocol = base.protocol;
      target.host = base.host;
      return target.toString();
    }
  } catch {
    // Not a URL we can parse; hand it back untouched.
  }
  return raw;
}

async function pollOpenAIVideo(taskId) {
  const { baseUrl, apiKey } = openAIVideoConfig();
  const deadline = Date.now() + OPENAI_VIDEO_TIMEOUT_SECONDS * 1000;
  let last = {};
  while (Date.now() < deadline) {
    const payload = await fetchJson(`${baseUrl}/video/generations/${encodeURIComponent(taskId)}`, {
      headers: { authorization: `Bearer ${apiKey}` },
      timeoutMs: 60000,
    });
    last = payload.data && typeof payload.data === "object" ? payload.data : payload;
    const status = String(last.status || "").toUpperCase();
    const inner = last.data && typeof last.data === "object" ? last.data : {};
    // Failure must be checked first: on policy rejections the relay copies the error text
    // into result_url, so a "has url" shortcut would treat the failure as success.
    const innerFailed = String(inner.status || "").toLowerCase() === "failed" || Boolean(inner.error);
    if (status === "FAILURE" || status === "FAILED" || status === "ERROR" || last.error || innerFailed) {
      const code = inner.error?.code ? `${inner.error.code}: ` : "";
      throw new Error(`video generation failed: ${code}${last.fail_reason || inner.error?.message || JSON.stringify(last.error || last).slice(0, 800)}`);
    }
    const url = validHttpUrl(last.result_url) || validHttpUrl(last.url);
    if (status === "SUCCESS" || status === "SUCCEEDED" || status === "COMPLETED" || (url && status !== "IN_PROGRESS")) {
      if (!url) throw new Error(`video task ${taskId} succeeded without a result url: ${JSON.stringify(last).slice(0, 800)}`);
      return {
        done: true,
        video_url: rewriteVideoResultHost(url),
        needs_auth: !last.result_url,
        ratio: inner.ratio,
        duration: inner.duration,
        resolution: inner.resolution,
        seed: inner.seed,
        quota: last.quota,
        usage: inner.usage,
        upstream_model: last.properties?.upstream_model_name,
      };
    }
    await sleep(OPENAI_VIDEO_POLL_INTERVAL * 1000);
  }
  throw new Error(`video generation timed out: ${JSON.stringify(last).slice(0, 1200)}`);
}

async function downloadOpenAIVideo(result, outputPath) {
  const { apiKey } = openAIVideoConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_VIDEO_DOWNLOAD_TIMEOUT_SECONDS * 1000);
  try {
    // Signed TOS urls must not carry extra headers; relay-proxied urls need the bearer token.
    const headers = result.needs_auth ? { authorization: `Bearer ${apiKey}` } : {};
    const response = await fetch(result.video_url, { headers, redirect: "follow", signal: controller.signal });
    if (!response.ok) throw new Error(`video download failed: ${response.status} ${response.statusText}`);
    if (!response.body) throw new Error("video download returned no body");
    mkdirSync(dirname(outputPath), { recursive: true });
    await pipeline(Readable.fromWeb(response.body), createWriteStream(outputPath));
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- Backend-neutral facade used by the job runners ---------- */

function activeVideoModel() {
  return VIDEO_BACKEND === "gemini" ? GEMINI_VIDEO_MODEL : openAIVideoModel();
}

function activeVideoProvider() {
  if (VIDEO_BACKEND === "gemini") return "gemini";
  return VIDEO_BACKEND === "veo-openai" ? "veo" : "seedance";
}

/** Returns {name, model}. Gemini-native uses the operation name; OpenAI-style uses the task id.
    The submit arguments are kept on the handle so pollVideo can resubmit on a policy rejection. */
async function submitVideo(prompt, firstImagePath, lastImagePath, aspect, duration) {
  if (VIDEO_BACKEND === "gemini") {
    const op = await submitGeminiVideo(prompt, firstImagePath, lastImagePath, aspect, duration);
    return { name: op.name, model: GEMINI_VIDEO_MODEL };
  }
  let handle;
  try {
    handle = await submitOpenAIVideo(prompt, firstImagePath, aspect, duration);
  } catch (error) {
    const canFallback = VIDEO_BACKEND === "seedance" && SEEDANCE_FALLBACK_MODEL && SEEDANCE_FALLBACK_MODEL !== openAIVideoModel();
    if (!canFallback || !isAudioPolicyRejection(error)) throw error;
    handle = await submitOpenAIVideo(prompt, firstImagePath, aspect, duration, SEEDANCE_FALLBACK_MODEL);
    handle.fallback_from = openAIVideoModel();
    handle.fallback_reason = String(error.message || error).slice(0, 300);
  }
  return { ...handle, _resubmit: { prompt, firstImagePath, aspect, duration } };
}

/** Upstream policy rejections worth one retry on the fallback model (different screening thresholds):
    audio copyright on the output, or the input keyframe reading as an identifiable real person. */
function isAudioPolicyRejection(error) {
  const text = String(error?.message || error);
  return /OutputAudioSensitiveContentDetected|output audio may be related to copyright|InputImageSensitiveContentDetected|may contain real person/i.test(text);
}

/** Returns {video_url, needs_auth, archive_ref, ...}. archive_ref is what the remote archiver consumes. */
async function pollVideo(handle) {
  if (VIDEO_BACKEND === "gemini") {
    const finalOperation = await pollGemini(handle.name);
    const uri = extractVideoUri(finalOperation);
    if (!uri) throw new Error(`Gemini operation returned no video URI: ${JSON.stringify(finalOperation).slice(0, 1200)}`);
    return { video_url: uri, needs_auth: true, archive_ref: { gemini_uri: uri, operation_name: handle.name } };
  }
  let result;
  try {
    result = await pollOpenAIVideo(handle.name);
  } catch (error) {
    const canFallback = VIDEO_BACKEND === "seedance" && SEEDANCE_FALLBACK_MODEL && handle.model !== SEEDANCE_FALLBACK_MODEL && handle._resubmit;
    if (!canFallback || !isAudioPolicyRejection(error)) throw error;
    const r = handle._resubmit;
    const retry = await submitOpenAIVideo(r.prompt, r.firstImagePath, r.aspect, r.duration, SEEDANCE_FALLBACK_MODEL);
    handle.fallback_from = handle.model;
    handle.fallback_reason = String(error.message || error).slice(0, 300);
    handle.name = retry.name;
    handle.model = retry.model;
    result = await pollOpenAIVideo(handle.name);
  }
  // The relay appends ?operation= to non-Google urls, which would break a signed TOS url;
  // passing no operation_name keeps the url intact. Proxied urls need the bearer token, so
  // they are downloaded here and handed over as a local file instead.
  return { ...result, archive_ref: result.needs_auth ? null : { download_url: result.video_url, operation_name: "" } };
}

async function downloadVideo(pollResult, outputPath, handle) {
  if (VIDEO_BACKEND === "gemini") return downloadGeminiVideo(pollResult.video_url, outputPath, handle.name);
  return downloadOpenAIVideo(pollResult, outputPath);
}

async function transcodeForMobile(inputPath, outputPath) {
  return new Promise((resolve) => {
    const ffmpeg = spawn("ffmpeg", [
      "-y",
      "-i",
      inputPath,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-movflags",
      "+faststart",
      outputPath,
    ]);
    ffmpeg.on("error", () => resolve(inputPath));
    ffmpeg.on("close", (code) => {
      resolve(code === 0 && existsSync(outputPath) ? outputPath : inputPath);
    });
  });
}

async function archiveVideo(jobId, videoPath, title, metadata, kind = "gemini-video") {
  if (!VIDEO_STORAGE_BASE_URL || !VIDEO_STORAGE_TOKEN) return null;
  const form = new FormData();
  form.append("source_task_id", jobId);
  form.append("kind", kind);
  form.append("title", title || basename(videoPath));
  form.append("metadata", JSON.stringify({ archived_by: "moneyprinterturbo-node-gpt-gemini", provider: GEMINI_VIDEO_MODEL, ...metadata }));
  const bytes = readFileSync(videoPath);
  form.append("file", new Blob([bytes], { type: "video/mp4" }), basename(videoPath) || `${jobId}.mp4`);
  const payload = await fetchJson(`${VIDEO_STORAGE_BASE_URL}/api/v1/videos/upload`, {
    method: "POST",
    headers: { authorization: `Bearer ${VIDEO_STORAGE_TOKEN}` },
    body: form,
  });
  const result = payload.data && typeof payload.data === "object" ? payload.data : null;
  if (result && payload.deduped) result.deduped = true;
  return addPublicMediaUrl(result);
}

async function remoteArchiveGeminiVideo(jobId, uri, operationName, filename, metadata, archiveRef = null) {
  if (!REMOTE_VIDEO_ARCHIVER_URL || !REMOTE_VIDEO_ARCHIVER_TOKEN) return null;
  const ref = archiveRef || { gemini_uri: uri, operation_name: operationName };
  const payload = await fetchJson(REMOTE_VIDEO_ARCHIVER_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${REMOTE_VIDEO_ARCHIVER_TOKEN}`,
      "content-type": "application/json",
      "x-goog-api-key": GEMINI_VIDEO_API_KEY,
    },
    body: JSON.stringify({
      source_task_id: jobId,
      kind: `${activeVideoProvider()}-video`,
      ...ref,
      filename,
      folder_id: REMOTE_VIDEO_ARCHIVER_FOLDER_ID,
      public: REMOTE_VIDEO_ARCHIVER_PUBLIC,
      metadata: {
        archived_by: "moneyprinterturbo-node-remote-drive",
        provider: activeVideoModel(),
        ...metadata,
      },
    }),
    timeoutMs: REMOTE_VIDEO_ARCHIVER_TIMEOUT_SECONDS * 1000,
  });
  const data = payload.data && typeof payload.data === "object" ? payload.data : payload;
  return data.drive_video || data;
}

async function remoteConcatGeminiVideos(jobId, clips, filename, targetSeconds, metadata, options = {}) {
  if (!REMOTE_VIDEO_ARCHIVER_URL || !REMOTE_VIDEO_ARCHIVER_TOKEN) return null;
  const concatUrl = `${REMOTE_VIDEO_ARCHIVER_URL.replace(/\/drive$/, "/drive/concat")}`;
  const payload = await fetchJson(concatUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${REMOTE_VIDEO_ARCHIVER_TOKEN}`,
      "content-type": "application/json",
      "x-goog-api-key": GEMINI_VIDEO_API_KEY,
    },
    body: JSON.stringify({
      source_task_id: jobId,
      kind: `${activeVideoProvider()}-video-long`,
      clips,
      filename,
      target_seconds: targetSeconds,
      folder_id: REMOTE_VIDEO_ARCHIVER_FOLDER_ID,
      public: REMOTE_VIDEO_ARCHIVER_PUBLIC,
      subtitle_srt: options.subtitleSrt || undefined,
      audio_url: options.audioUrl || undefined,
      storage_base_url: VIDEO_STORAGE_BASE_URL || undefined,
      storage_token: VIDEO_STORAGE_TOKEN || undefined,
      public_api_base_url: PUBLIC_BASE_URL,
      metadata: {
        archived_by: "moneyprinterturbo-node-remote-drive-concat",
        provider: activeVideoModel(),
        ...metadata,
      },
    }),
    timeoutMs: REMOTE_VIDEO_ARCHIVER_TIMEOUT_SECONDS * 1000,
  });
  const data = payload.data && typeof payload.data === "object" ? payload.data : payload;
  if (data.storage_video) data.storage_video = addPublicMediaUrl(data.storage_video);
  return data.drive_video || data.storage_video ? data : { drive_video: data };
}

async function runLongImageVideoJob(jobId, payload, targetDuration) {
  const job = jobs.get(jobId);
  const subject = String(payload.video_subject || "").trim();
  const aspect = payload.video_aspect === "16:9" ? "16:9" : "9:16";
  const segmentCount = longSegmentCount(targetDuration);
  const segmentDuration = normalizeDuration(IMAGE_VIDEO_SEGMENT_SECONDS);
  const lyricTimeline = normalizeLyricTimeline(payload, targetDuration);
  const subtitleSrt = subtitleEnabled(payload, lyricTimeline) ? buildSubtitleSrt(lyricTimeline, targetDuration) : "";
  const audioUrl = String(payload.audio_url || payload.music_url || payload.song_audio_url || "").trim();
  const runId = `gpt-gemini-long-${jobId}`;
  const runDir = join(LOCAL_VIDEO_DIR, runId);
  const keyframePaths = Array.from({ length: segmentCount + 1 }, (_, index) => join(runDir, `keyframe-${String(index + 1).padStart(2, "0")}.png`));

  Object.assign(job, {
    state: "generating_storyboard",
    progress: 8,
    run_id: runId,
    target_duration: targetDuration,
    segment_count: segmentCount,
    segment_duration: segmentDuration,
    subtitle_enabled: Boolean(subtitleSrt),
    subtitle_count: lyricTimeline.length,
    audio_url_set: Boolean(audioUrl),
  });
  const storyboard = await createStoryboard(payload, targetDuration, segmentCount, lyricTimeline);
  Object.assign(job, {
    state: "generating_keyframes",
    progress: 18,
    script: storyboard.script,
    visual_bible: storyboard.visual_bible,
    storyboard_segments: storyboard.segments,
    lyrics_timeline: lyricTimeline,
    prompt_error: storyboard.prompt_error,
    storyboard_source: storyboard.storyboard_source,
    storyboard_attempts: storyboard.storyboard_attempts,
    storyboard_raw: storyboard.storyboard_raw,
  });
  if (payload.storyboard_only === true || String(payload.storyboard_only || "").toLowerCase() === "true") {
    // Dry run: hand back the board (with shot picks) so it can be replayed into several jobs.
    Object.assign(job, { state: "complete", progress: 100, storyboard_only: true, keyframe_source: storyboard.story_mode ? "blender-greybox+gpt-restyle" : "gpt-image" });
    if (storyboard.story_mode) job.shot_specs = storyboard.segments.flatMap((seg, i) => (i === 0 ? [{ index: 1, ...seg.first_shot_spec }] : []).concat([{ index: i + 2, ...seg.last_shot_spec }]));
    return;
  }

  const firstProvided = await materializeProvidedImage(payload, "first", keyframePaths[0]);
  const lastProvided = await materializeProvidedImage(payload, "last", keyframePaths[segmentCount]);
  const keyframeJobs = [];
  for (let index = 0; index < keyframePaths.length; index += 1) {
    if (index === 0 && firstProvided) continue;
    if (index === segmentCount && lastProvided) continue;
    const prompt =
      index === 0
        ? storyboard.segments[0].first_frame_prompt
        : `${storyboard.visual_bible}\n\nKeyframe ${index + 1} of ${segmentCount + 1}. ${storyboard.segments[index - 1].last_frame_prompt}`;
    const shotSpec = index === 0 ? storyboard.segments[0].first_shot_spec : storyboard.segments[index - 1].last_shot_spec;
    keyframeJobs.push({ index, path: keyframePaths[index], prompt, shotSpec });
  }
  const storyMode = Boolean(storyboard.story_mode);
  const shotText = !storyMode && shotSpecsAsTextRequested(payload);
  const storyManifestData = storyMode || shotText ? await storyManifest().catch(() => null) : null;
  if (storyMode) Object.assign(job, { keyframe_source: "blender-greybox+gpt-restyle", shot_specs: keyframeJobs.map((k) => ({ index: k.index + 1, ...k.shotSpec })), greybox_paths: [] });
  // `preview_only` already means the text-only plan endpoint; `story_preview` renders Blender greyboxes + animatics and the HTML sign-off page.
  const previewOnly = booleanEnabled(payload.story_preview);
  if (storyMode && storyManifestData) {
    // Per-segment animatic (opening -> closing shot) and the motion script derived from it.
    job.animatic_paths = [];
    job.motion_scripts = {};
    for (let index = 0; index < segmentCount; index += 1) {
      const seg = storyboard.segments[index];
      const startSpec = index === 0 ? seg.first_shot_spec : storyboard.segments[index - 1].last_shot_spec;
      const endSpec = seg.last_shot_spec;
      if (!startSpec || !endSpec) continue;
      const script = storyMotionScript(startSpec, endSpec, storyManifestData, segmentDuration);
      job.motion_scripts[index + 1] = script;
      seg.video_prompt = `${seg.video_prompt}\n\n${script}`;
      if (startSpec.scene_id !== endSpec.scene_id) continue;
      const gridPath = join(runDir, `animatic-${String(index + 1).padStart(2, "0")}.png`);
      Object.assign(job, { state: previewOnly ? "rendering_animatics" : "generating_keyframes", stage: `animatic ${index + 1}/${segmentCount}` });
      try {
        await renderStoryGrid(startSpec, endSpec, gridPath);
        job.animatic_paths.push(gridPath);
      } catch (error) {
        job.animatic_errors = { ...(job.animatic_errors || {}), [index + 1]: String(error.message || error) };
      }
    }
    if (previewOnly) {
      // Greyboxes only (no GPT, no video), then the HTML script preview the user signs off on.
      Object.assign(job, { state: "rendering_greyboxes", progress: 30 });
      for (const k of keyframeJobs) {
        const greyboxPath = join(runDir, `greybox-${String(k.index + 1).padStart(2, "0")}.png`);
        try {
          await renderStoryKeyframe(k.shotSpec, aspect, greyboxPath);
          job.greybox_paths.push(greyboxPath);
        } catch (error) {
          job.greybox_errors = { ...(job.greybox_errors || {}), [k.index + 1]: String(error.message || error) };
        }
      }
      const html = renderStoryPreviewHtml(job, storyboard, storyManifestData, runId, segmentDuration);
      const htmlPath = join(runDir, "preview.html");
      writeFileSync(htmlPath, html, "utf8");
      Object.assign(job, {
        state: "complete", progress: 100, story_preview: true, stage: null,
        preview_url: runAssetPublicUrl(runId, "preview.html"),
        preview_path: htmlPath,
        replay_payload: {
          video_subject: subject, video_aspect: aspect, video_language: payload.video_language || "zh-CN",
          duration: targetDuration, story_mode: true,
          script: storyboard.script, visual_bible: storyboard.visual_bible, storyboard_segments: storyboard.segments,
        },
      });
      return;
    }
    // Identity reference shared by every restyle (one text-to-image call per job).
    Object.assign(job, { stage: "turnaround" });
    const turnaroundPath = join(runDir, "turnaround.png");
    try {
      await generateImage(storyTurnaroundPrompt(storyboard.visual_bible), "16:9", turnaroundPath, { models: keyframeImageModels() });
      job.turnaround_path = turnaroundPath;
    } catch (error) {
      job.turnaround_error = String(error.message || error);
    }
    job.stage = null;
  }
  if (shotText && storyManifestData) {
    for (const k of keyframeJobs) {
      const text = shotSpecToText(k.shotSpec, storyManifestData);
      if (text) k.prompt = `${k.prompt}\n\n${text}`;
    }
    Object.assign(job, { keyframe_source: "gpt-image+shot-text", shot_specs: keyframeJobs.map((k) => ({ index: k.index + 1, ...k.shotSpec })) });
  }

  let completedKeyframes = keyframePaths.length - keyframeJobs.length;
  Object.assign(job, {
    keyframes_total: keyframePaths.length,
    keyframes_completed: completedKeyframes,
    keyframes_concurrency: IMAGE_GENERATION_CONCURRENCY,
    keyframes_in_progress: [],
    keyframe_last_error: null,
  });
  const updateKeyframeProgress = () => {
    completedKeyframes += 1;
    const ratio = completedKeyframes / keyframePaths.length;
    Object.assign(job, {
      keyframes_completed: completedKeyframes,
      progress: Math.round(18 + ratio * 27),
    });
  };
  if (completedKeyframes) Object.assign(job, { progress: Math.round(18 + (completedKeyframes / keyframePaths.length) * 27) });
  await mapLimit(keyframeJobs, IMAGE_GENERATION_CONCURRENCY, async (item) => {
    const keyframeNumber = item.index + 1;
    const startedAt = Date.now();
    const setKeyframeStatus = (patch) => {
      const current = Array.isArray(job.keyframes_in_progress) ? job.keyframes_in_progress : [];
      const rest = current.filter((entry) => entry.index !== keyframeNumber);
      job.keyframes_in_progress = [
        ...rest,
        {
          index: keyframeNumber,
          total: keyframePaths.length,
          elapsed_seconds: Math.round((Date.now() - startedAt) / 1000),
          updated_at: new Date().toISOString(),
          ...patch,
        },
      ].sort((a, b) => a.index - b.index);
    };
    setKeyframeStatus({ status: "queued", attempt: 0, max_attempts: IMAGE_GENERATION_RETRIES });
    const hooks = {
      models: keyframeImageModels(),
      onAttempt: ({ attempt, maxAttempts, timeoutSeconds, model }) => {
        setKeyframeStatus({ status: "requesting", attempt, max_attempts: maxAttempts, timeout_seconds: timeoutSeconds, model });
      },
      onAttemptError: ({ attempt, maxAttempts, timeoutSeconds, willRetry, error, model }) => {
        Object.assign(job, { keyframe_last_error: error });
        setKeyframeStatus({
          status: willRetry ? "retrying" : "failed",
          attempt,
          max_attempts: maxAttempts,
          timeout_seconds: timeoutSeconds,
          model,
          error,
        });
      },
      onSuccess: ({ attempt, maxAttempts, model }) => {
        setKeyframeStatus({ status: "complete", attempt, max_attempts: maxAttempts, model, error: null });
      },
    };
    if (storyMode && item.shotSpec) {
      const produced = await generateStoryKeyframe(item, aspect, storyboard, storyManifestData, hooks, setKeyframeStatus, job);
      job.keyframe_sources = { ...(job.keyframe_sources || {}), [keyframeNumber]: produced.keyframe_source };
      const sources = Object.values(job.keyframe_sources);
      job.keyframe_source = sources.every((v) => v === sources[0]) ? sources[0] : sources.every((v) => v === "gpt-image-fallback") ? "gpt-image-fallback" : "mixed";
    } else {
      await generateImage(item.prompt, aspect, item.path, hooks);
    }
    updateKeyframeProgress();
    job.keyframe_last_error = null;
    job.keyframes_in_progress = (job.keyframes_in_progress || []).filter((entry) => entry.index !== keyframeNumber);
    job.keyframe_last_completed = {
      index: keyframeNumber,
      total: keyframePaths.length,
      completed_at: new Date().toISOString(),
    };
  });

  Object.assign(job, {
    state: "generating_gemini_segments",
    progress: 48,
    materials: keyframePaths.map((path, index) => ({
      provider: index === 0 && firstProvided ? "provided-image" : index === segmentCount && lastProvided ? "provided-image" : "gpt-image",
      role: `keyframe_${index + 1}`,
      url: path,
      prompt: index === 0 ? storyboard.segments[0].first_frame_prompt : storyboard.segments[index - 1]?.last_frame_prompt,
    })),
  });

  const clips = [];
  for (let index = 0; index < segmentCount; index += 1) {
    const segment = storyboard.segments[index];
    Object.assign(job, {
      state: "generating_gemini_segments",
      progress: Math.round(48 + (index / segmentCount) * 34),
      current_segment: index + 1,
      segment_count: segmentCount,
      video_prompt: segment.video_prompt,
    });
    const handle = await submitVideo(segment.video_prompt, keyframePaths[index], keyframePaths[index + 1], aspect, segmentDuration);
    if (!handle.name) throw new Error(`video segment ${index + 1} returned no task handle: ${JSON.stringify(handle).slice(0, 1200)}`);
    Object.assign(job, {
      state: "polling_gemini_segments",
      progress: Math.round(52 + (index / segmentCount) * 30),
      current_segment: index + 1,
      current_operation_name: handle.name,
    });
    const result = await pollVideo(handle);
    const filename = `segment-${String(index + 1).padStart(2, "0")}.mp4`;
    let archiveRef = result.archive_ref;
    if (!archiveRef) {
      // Bearer-only result (Veo via relay): fetch it here and expose it through the gateway
      // so the Mac archiver can pull it without holding the video API key.
      const localClipPath = join(runDir, filename);
      await downloadVideo(result, localClipPath, handle);
      archiveRef = { download_url: runClipPublicUrl(runId, filename), operation_name: "" };
    }
    clips.push({
      index: index + 1,
      ...archiveRef,
      filename,
      title: segment.title,
      video_model: handle.model,
      quota: result.quota,
      ...(handle.fallback_from ? { video_fallback_from: handle.fallback_from } : {}),
    });
    Object.assign(job, {
      clips,
      progress: Math.round(55 + ((index + 1) / segmentCount) * 30),
    });
  }

  if (!REMOTE_VIDEO_ARCHIVER_URL) throw new Error("long video generation requires REMOTE_VIDEO_ARCHIVER_URL");
  Object.assign(job, { state: "archiving_drive_concat", progress: 90, clips });
  const concatResult = await remoteConcatGeminiVideos(
    jobId,
    clips,
    "gemini-video-long.mp4",
    targetDuration,
    {
      image_provider: "gpt-image",
      image_model: IMAGE_MODEL,
      video_provider: activeVideoProvider(),
      video_model: activeVideoModel(),
      target_duration: targetDuration,
      segment_count: segmentCount,
      segment_duration: segmentDuration,
      keyframe_count: keyframePaths.length,
      keyframe_mode: "continuous_reused_keyframes",
      subtitle_enabled: Boolean(subtitleSrt),
      subtitle_count: lyricTimeline.length,
      audio_url_set: Boolean(audioUrl),
      ...subtitleMetadata(subtitleSrt, lyricTimeline, targetDuration),
    },
    { subtitleSrt, audioUrl },
  );
  if (!concatResult?.drive_video && !concatResult?.storage_video) throw new Error("remote concat archive returned no drive_video or storage_video");
  Object.assign(job, {
    state: "complete",
    progress: 100,
    drive_video: concatResult.drive_video,
    storage_video: concatResult.storage_video,
    concat_archive: {
      clip_count: concatResult.clip_count,
      input_bytes: concatResult.input_bytes,
      output_bytes: concatResult.output_bytes,
      download_and_concat_seconds: concatResult.download_and_concat_seconds,
      upload_seconds: concatResult.upload_seconds,
      storage_upload_seconds: concatResult.storage_upload_seconds,
      subtitle_track: concatResult.subtitle_track,
      subtitle_burned: concatResult.subtitle_burned,
      audio_mixed: concatResult.audio_mixed,
    },
    image_model: IMAGE_MODEL,
    image_fallback_models: IMAGE_OPENAI_FALLBACK_MODELS,
    video_model: activeVideoModel(),
    message: "Long GPT keyframe + Gemini segment video completed and was archived.",
  });
}

async function runImageVideoJob(jobId, payload) {
  const job = jobs.get(jobId);
  try {
    const subject = String(payload.video_subject || "").trim();
    const aspect = payload.video_aspect === "16:9" ? "16:9" : "9:16";
    const targetDuration = requestedTotalDuration(payload);
    // Story Mode always goes through the storyboard path: it is the only one that produces
    // shot specs for the Blender worker. With segment_count=1 it is a single clip anyway.
    // single_clip: the caller wants one continuous clip (first-frame backends such as Seedance take up to 12 s);
    // without it, anything over 8 s goes through the segmented storyboard path.
    const singleClip = payload.single_clip === true && VIDEO_BACKEND !== "gemini";
    if ((targetDuration > 8 && !singleClip) || storyModeRequested(payload)) {
      await runLongImageVideoJob(jobId, payload, targetDuration);
      return;
    }
    let duration = singleClip && targetDuration > 8 ? Math.min(12, Math.round(targetDuration)) : normalizeDuration(payload.duration || payload.video_clip_duration);
    const runId = `gpt-gemini-${jobId}`;
    const runDir = join(LOCAL_VIDEO_DIR, runId);
    const firstImagePath = join(runDir, "shot-01-first.png");
    const lastImagePath = join(runDir, "shot-02-last.png");
    const rawVideoPath = join(runDir, "gemini-video-raw.mp4");
    const mobileVideoPath = join(runDir, "gemini-video.mp4");

    Object.assign(job, { state: "generating_prompt", progress: 10 });
    const prompts = await createPromptBundle(payload);
    Object.assign(job, {
      state: "generating_keyframes",
      progress: 25,
      script: prompts.script,
      image_prompt: prompts.imagePrompt,
      first_frame_prompt: prompts.firstFramePrompt,
      last_frame_prompt: prompts.lastFramePrompt,
    });

    const firstProvided = await materializeProvidedImage(payload, "first", firstImagePath);
    const lastProvided = await materializeProvidedImage(payload, "last", lastImagePath);
    let completedKeyframes = Number(Boolean(firstProvided)) + Number(Boolean(lastProvided));
    if (completedKeyframes > 0) Object.assign(job, { progress: completedKeyframes === 1 ? 38 : 45 });
    const markKeyframeDone = () => {
      completedKeyframes += 1;
      Object.assign(job, { progress: completedKeyframes === 1 ? 38 : 45 });
    };
    const keyframeTasks = [];
    if (!firstProvided) {
      keyframeTasks.push(generateImage(prompts.firstFramePrompt, aspect, firstImagePath, { models: keyframeImageModels() }).then(markKeyframeDone));
    }
    if (!lastProvided) {
      keyframeTasks.push(generateImage(prompts.lastFramePrompt, aspect, lastImagePath, { models: keyframeImageModels() }).then(markKeyframeDone));
    }
    await Promise.all(keyframeTasks);
    // Gemini-native first+last interpolation is fixed at 8s; first-frame-only backends keep the request.
    if (VIDEO_BACKEND === "gemini" && existsSync(lastImagePath)) duration = 8;
    Object.assign(job, {
      state: "generating_gemini_video",
      progress: 55,
      run_id: runId,
      materials: [
        { provider: firstProvided?.provider || "gpt-image", role: "first_frame", url: firstImagePath, duration: 0, prompt: prompts.firstFramePrompt, source: firstProvided?.source },
        { provider: lastProvided?.provider || "gpt-image", role: "last_frame", url: lastImagePath, duration: 0, prompt: prompts.lastFramePrompt, source: lastProvided?.source },
      ],
      video_prompt: prompts.videoPrompt,
      duration,
      video_model: activeVideoModel(),
    });

    const handle = await submitVideo(prompts.videoPrompt, firstImagePath, lastImagePath, aspect, duration);
    if (!handle.name) throw new Error(`video submit returned no task handle: ${JSON.stringify(handle).slice(0, 1200)}`);
    Object.assign(job, { state: "polling_gemini_video", progress: 70, operation_name: handle.name, video_model: handle.model });

    const pollResult = await pollVideo(handle);
    const videoUri = pollResult.video_url;
    // Bearer-only results (Veo via relay) are fetched here and re-served through the gateway
    // so the Mac archiver can reach them without the video API key.
    let archiveRef = pollResult.archive_ref;
    if (!archiveRef) {
      await downloadVideo(pollResult, rawVideoPath, handle);
      archiveRef = { download_url: runClipPublicUrl(runId, basename(rawVideoPath)), operation_name: "" };
    }
    Object.assign(job, {
      state: "downloading",
      progress: 85,
      result_video_url: videoUri,
      video_model: handle.model,
      video_quota: pollResult.quota,
      video_upstream_model: pollResult.upstream_model,
      ...(handle.fallback_from ? { video_fallback_from: handle.fallback_from, video_fallback_reason: handle.fallback_reason } : {}),
    });
    const lyricTimeline = normalizeLyricTimeline(payload, duration);
    const subtitleSrt = subtitleEnabled(payload, lyricTimeline) ? buildSubtitleSrt(lyricTimeline, duration) : "";
    const audioUrl = String(payload.audio_url || payload.music_url || payload.song_audio_url || "").trim();

    const archiveMetadata = {
      image_provider: "gpt-image",
      image_model: IMAGE_MODEL,
      video_provider: activeVideoProvider(),
      video_model: handle.model,
      duration,
      operation_name: handle.name,
      keyframe_mode: VIDEO_BACKEND === "gemini" ? "first_last_frame" : "first_frame",
      first_keyframe_provider: firstProvided?.provider || "gpt-image",
      last_keyframe_provider: lastProvided?.provider || "gpt-image",
      subtitle_enabled: Boolean(subtitleSrt),
      subtitle_count: lyricTimeline.length,
      audio_url_set: Boolean(audioUrl),
      ...subtitleMetadata(subtitleSrt, lyricTimeline, duration),
    };
    if (REMOTE_VIDEO_ARCHIVER_URL) {
      Object.assign(job, { state: "archiving_drive", progress: 86 });
      try {
        const archiveResult =
          subtitleSrt || audioUrl
            ? await remoteConcatGeminiVideos(
                jobId,
                [
                  {
                    index: 1,
                    ...archiveRef,
                    filename: "segment-01.mp4",
                    title: "Segment 1",
                  },
                ],
                "gemini-video.mp4",
                duration,
                archiveMetadata,
                { subtitleSrt, audioUrl },
              )
            : { drive_video: await remoteArchiveGeminiVideo(jobId, videoUri, handle.name, "gemini-video.mp4", archiveMetadata, archiveRef) };
        if (archiveResult?.drive_video || archiveResult?.storage_video) {
          Object.assign(job, {
            state: "complete",
            progress: 100,
            drive_video: archiveResult.drive_video,
            storage_video: archiveResult.storage_video,
            concat_archive:
              subtitleSrt || audioUrl
                ? {
                    clip_count: archiveResult.clip_count,
                    input_bytes: archiveResult.input_bytes,
                    output_bytes: archiveResult.output_bytes,
                    download_and_concat_seconds: archiveResult.download_and_concat_seconds,
                    upload_seconds: archiveResult.upload_seconds,
                    storage_upload_seconds: archiveResult.storage_upload_seconds,
                    subtitle_track: archiveResult.subtitle_track,
                    subtitle_burned: archiveResult.subtitle_burned,
                    audio_mixed: archiveResult.audio_mixed,
                  }
                : undefined,
            subtitle_enabled: Boolean(subtitleSrt),
            subtitle_count: lyricTimeline.length,
            lyrics_timeline: lyricTimeline,
            image_model: IMAGE_MODEL,
            image_fallback_models: IMAGE_OPENAI_FALLBACK_MODELS,
            video_model: handle.model,
            message: "GPT image and Gemini video generation completed and was archived by the relay.",
          });
          return;
        }
      } catch (error) {
        Object.assign(job, { drive_archive_error: String(error.message || error) });
      }
      Object.assign(job, { state: "downloading", progress: 85 });
    }

    // The video exists once pollVideo returned; everything below is archiving. An archive
    // failure (NAS down, relay timeout) must not turn a generated video into a failed job.
    let storageVideo = null;
    try {
      if (!existsSync(rawVideoPath)) await downloadVideo(pollResult, rawVideoPath, handle);
      Object.assign(job, { state: "transcoding", progress: 88, raw_video_path: rawVideoPath });
      const finalVideoPath = await transcodeForMobile(rawVideoPath, mobileVideoPath);
      Object.assign(job, { state: "archiving", progress: 92, result_video_path: finalVideoPath });
      storageVideo = await archiveVideo(jobId, finalVideoPath, subject || "gpt-gemini-video", {
        ...archiveMetadata,
        first_keyframe_provider: firstProvided?.provider || "gpt-image",
        last_keyframe_provider: lastProvided?.provider || "gpt-image",
        mobile_transcoded: finalVideoPath === mobileVideoPath,
      });
    } catch (error) {
      const archiveError = String(error.message || error);
      const localClip = [mobileVideoPath, rawVideoPath].find((p) => existsSync(p));
      if (!localClip && !videoUri) throw error;
      Object.assign(job, {
        state: "complete",
        progress: 100,
        archive_error: archiveError,
        archive_state: "failed",
        // Gateway-served copy outlives the provider's signed URL; keep the provider URL as a fallback.
        result_video_url: localClip ? runClipPublicUrl(runId, basename(localClip)) : videoUri,
        provider_video_url: videoUri,
        video_model: handle.model,
        message: `Video generated but archiving failed (${archiveError}); result_video_url is served by the gateway and is not archived.`,
      });
      return;
    }

    Object.assign(job, {
      state: "complete",
      progress: 100,
      storage_video: storageVideo,
      image_model: IMAGE_MODEL,
      image_fallback_models: IMAGE_OPENAI_FALLBACK_MODELS,
      image_quality: IMAGE_OPENAI_QUALITY,
      image_output_format: IMAGE_OPENAI_OUTPUT_FORMAT,
      image_output_compression: IMAGE_OPENAI_OUTPUT_COMPRESSION,
      video_model: handle.model,
      message: "GPT image and Gemini video generation completed through relay APIs.",
    });
  } catch (error) {
    Object.assign(job, { state: "failed", progress: 100, error: String(error.message || error) });
  }
}

async function proxyMedia(req, res, videoId, filename) {
  if (!VIDEO_STORAGE_BASE_URL) return json(res, 503, { detail: "VIDEO_STORAGE_BASE_URL is not configured" });
  const target = `${VIDEO_STORAGE_BASE_URL}/media/${encodeURIComponent(videoId)}/${encodeURIComponent(filename)}`;
  const headers = {};
  if (req.headers.range) headers.Range = req.headers.range;
  const upstream = await fetch(target, { method: req.method, headers });
  const responseHeaders = {
    "content-type": upstream.headers.get("content-type") || "video/mp4",
    "accept-ranges": upstream.headers.get("accept-ranges") || "bytes",
    "content-disposition": `inline; filename="${filename}"`,
    "x-robots-tag": "noindex",
  };
  for (const key of ["content-length", "content-range", "cache-control", "etag", "last-modified"]) {
    const value = upstream.headers.get(key);
    if (value) responseHeaders[key] = value;
  }
  res.writeHead(upstream.status, responseHeaders);
  if (req.method === "HEAD" || !upstream.body) return res.end();
  for await (const chunk of upstream.body) res.write(chunk);
  res.end();
}

async function storageVideoDetail(videoId) {
  if (!VIDEO_STORAGE_BASE_URL || !VIDEO_STORAGE_TOKEN) return null;
  const payload = await fetchJson(`${VIDEO_STORAGE_BASE_URL}/api/v1/videos/${encodeURIComponent(videoId)}`, {
    headers: { authorization: `Bearer ${VIDEO_STORAGE_TOKEN}` },
    timeoutMs: 30000,
  });
  const detail = payload.data && typeof payload.data === "object" ? payload.data : payload;
  return addPublicMediaUrl(detail);
}

async function proxySubtitle(req, res, videoId) {
  const detail = await storageVideoDetail(videoId);
  if (!detail) return json(res, 503, { detail: "VIDEO_STORAGE_BASE_URL or VIDEO_STORAGE_TOKEN is not configured" });
  const metadata = detail.metadata && typeof detail.metadata === "object" ? detail.metadata : {};
  let vtt = String(metadata.subtitle_vtt || "").trim();
  if (!vtt && metadata.subtitle_srt) vtt = srtToVtt(metadata.subtitle_srt);
  if (!vtt && Array.isArray(metadata.lyrics_timeline)) {
    vtt = buildSubtitleVtt(metadata.lyrics_timeline, Number(metadata.target_duration || metadata.target_seconds || 0));
  }
  if (!vtt) return json(res, 404, { detail: "subtitle track metadata not found for this video" });
  const body = Buffer.from(vtt.startsWith("WEBVTT") ? `${vtt.trim()}\n` : `WEBVTT\n\n${vtt.trim()}\n`, "utf8");
  res.writeHead(200, {
    "content-type": "text/vtt; charset=utf-8",
    "content-length": body.length,
    "cache-control": "public, max-age=31536000, immutable",
    "access-control-allow-origin": "*",
    "x-robots-tag": "noindex",
  });
  if (req.method === "HEAD") return res.end();
  res.end(body);
}

/** Public read of a clip the gateway already downloaded into a run dir. Exists so the Mac
    relay archiver can fetch relay-proxied (bearer-only) video results without holding the
    video API key. Restricted to .mp4 under LOCAL_VIDEO_DIR; ids are basename-sanitised. */
function serveRunClip(req, res, runId, filename) {
  const safeRunId = basename(String(runId || ""));
  const safeFilename = basename(String(filename || ""));
  if (!safeRunId || !safeFilename || !/\.mp4$/i.test(safeFilename)) return json(res, 404, { detail: "clip not found" });
  const clipPath = join(LOCAL_VIDEO_DIR, safeRunId, safeFilename);
  if (!existsSync(clipPath)) return json(res, 404, { detail: "clip not found" });
  const stat = statSync(clipPath);
  res.writeHead(200, {
    "content-type": "video/mp4",
    "content-length": stat.size,
    "cache-control": "private, max-age=3600",
    "access-control-allow-origin": "*",
    "x-robots-tag": "noindex",
  });
  if (req.method === "HEAD") return res.end();
  createReadStream(clipPath).pipe(res);
}

const RUN_ASSET_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".html": "text/html; charset=utf-8", ".json": "application/json" };

function serveRunAsset(req, res, runId, filename) {
  const safeRunId = basename(String(runId || ""));
  const safeFilename = basename(String(filename || ""));
  const ext = (safeFilename.match(/\.[a-z0-9]+$/i) || [""])[0].toLowerCase();
  if (!safeRunId || !safeFilename || !RUN_ASSET_TYPES[ext]) return json(res, 404, { detail: "asset not found" });
  const assetPath = join(LOCAL_VIDEO_DIR, safeRunId, safeFilename);
  if (!existsSync(assetPath)) return json(res, 404, { detail: "asset not found" });
  const stat = statSync(assetPath);
  res.writeHead(200, {
    "content-type": RUN_ASSET_TYPES[ext],
    "content-length": stat.size,
    "cache-control": "private, max-age=600",
    "access-control-allow-origin": "*",
    "x-robots-tag": "noindex",
  });
  if (req.method === "HEAD") return res.end();
  createReadStream(assetPath).pipe(res);
}

function runAssetPublicUrl(runId, filename) {
  return `${PUBLIC_BASE_URL}/run-assets/${encodeURIComponent(runId)}/${encodeURIComponent(filename)}`;
}

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/** Script preview page (the sign-off gate before any paid image/video call). */
function renderStoryPreviewHtml(job, storyboard, manifest, runId, segmentDuration) {
  const img = (p) => (p && existsSync(p) ? `<img src="${esc(runAssetPublicUrl(runId, basename(p)))}" loading="lazy">` : `<div class="missing">未渲染</div>`);
  const greyFor = (n) => (job.greybox_paths || []).find((p) => basename(p) === `greybox-${String(n).padStart(2, "0")}.png`);
  const animFor = (n) => (job.animatic_paths || []).find((p) => basename(p) === `animatic-${String(n).padStart(2, "0")}.png`);
  const specLine = (sp) => sp ? `${esc(manifest.scenes?.[sp.scene_id]?.label || sp.scene_id)} · ${esc(sp.camera)} · ${esc(sp.character_anchor)}${Number(sp.character_rotation) ? ` (${esc(sp.character_rotation)}°)` : ""} · ${esc(manifest.poses?.[sp.pose_id]?.label || sp.pose_id)}` : "—";
  const issues = [];
  storyboard.segments.forEach((seg, i) => {
    const a = i === 0 ? seg.first_shot_spec : storyboard.segments[i - 1].last_shot_spec;
    const b = seg.last_shot_spec;
    if (a && b && a.scene_id !== b.scene_id) issues.push(`第 ${i + 1} 段内换场景（${a.scene_id} → ${b.scene_id}）：视频模型只吃首帧，这一段会全程留在 ${a.scene_id}，下一段硬切。`);
    if (a && b && a.pose_id === b.pose_id && a.camera === b.camera && a.character_anchor === b.character_anchor) issues.push(`第 ${i + 1} 段起止镜头完全相同，动作只能靠文字提示。`);
    if (seg.last_shot_spec_source === "fallback") issues.push(`第 ${i + 1} 段尾镜头是网关默认值（LLM 未给出可用的 shot spec）。`);
    if (job.animatic_errors?.[i + 1]) issues.push(`第 ${i + 1} 段 animatic 渲染失败：${job.animatic_errors[i + 1]}`);
  });
  if (job.prompt_error) issues.push(`分镜 LLM 回退：${job.prompt_error}`);
  const cards = storyboard.segments.map((seg, i) => {
    const n = i + 1;
    const a = i === 0 ? seg.first_shot_spec : storyboard.segments[i - 1].last_shot_spec;
    return `<section class="seg">
      <h2>第 ${n} 段 · ${esc(seg.title)} <span class="dur">${esc(segmentDuration)} s</span></h2>
      <div class="row">
        <figure><figcaption>起始画面 (keyframe ${n})</figcaption>${img(greyFor(n))}<p>${specLine(a)}</p></figure>
        <figure class="anim"><figcaption>动作 animatic（3×3，起 → 止）</figcaption>${img(animFor(n))}</figure>
        <figure><figcaption>结束画面 (keyframe ${n + 1})</figcaption>${img(greyFor(n + 1))}<p>${specLine(seg.last_shot_spec)}</p></figure>
      </div>
      <dl>
        <dt>运动提示（含 motion script）</dt><dd>${esc(seg.video_prompt)}</dd>
        <dt>结束关键帧提示</dt><dd>${esc(seg.last_frame_prompt)}</dd>
        ${i === 0 ? `<dt>开场关键帧提示</dt><dd>${esc(seg.first_frame_prompt)}</dd>` : ""}
      </dl>
    </section>`;
  }).join("\n");
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>故事模式脚本预览 · ${esc(runId)}</title>
<style>
body{font:14px/1.6 -apple-system,"PingFang SC",sans-serif;background:#111;color:#eee;margin:0;padding:20px}
h1{font-size:20px;margin:0 0 6px}h2{font-size:16px;margin:0 0 10px}.dur{color:#fc8;font-weight:normal;margin-left:8px}
.meta{color:#bbb;margin-bottom:18px}.meta b{color:#eee}
.seg{background:#1b1b1f;border:1px solid #2a2a30;border-radius:10px;padding:14px;margin:0 0 16px}
.row{display:grid;grid-template-columns:1fr 1.6fr 1fr;gap:10px;align-items:start}
figure{margin:0}figcaption{color:#9ad;font-size:12px;margin-bottom:4px}img{width:100%;border-radius:6px;background:#000}
.missing{aspect-ratio:9/16;border:1px dashed #555;border-radius:6px;display:flex;align-items:center;justify-content:center;color:#777}
figure p{color:#ccc;font-size:12px;margin:4px 0 0}dl{margin:12px 0 0}dt{color:#9ad;font-size:12px;margin-top:8px}dd{margin:2px 0 0;white-space:pre-wrap;color:#ddd}
.issues{background:#2a1e12;border:1px solid #6b4a1e;border-radius:10px;padding:12px 16px;margin-bottom:18px}.issues li{margin:4px 0}
.foot{color:#999;font-size:12px;margin-top:20px}code{background:#000;padding:1px 5px;border-radius:4px}
@media(max-width:900px){.row{grid-template-columns:1fr}}
</style></head><body>
<h1>故事模式脚本预览</h1>
<div class="meta"><b>主题：</b>${esc(job.video_subject)}<br><b>剧本：</b>${esc(storyboard.script)}<br><b>Visual bible：</b>${esc(storyboard.visual_bible)}<br>
<b>${storyboard.segments.length} 段 × ${esc(segmentDuration)} s</b> · 画幅 ${esc(job.video_aspect || "9:16")} · 分镜来源 ${esc(job.storyboard_source || "llm")} · run <code>${esc(runId)}</code></div>
${issues.length ? `<div class="issues"><b>待确认项</b><ul>${issues.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></div>` : ""}
${cards}
<div class="foot">灰模与 animatic 均为 Blender 实时渲染，未调用任何付费接口。确认后用 <code>replay_payload</code>（作业 JSON 内）原样提交即开始生成：角色三视图 1 张 + 关键帧 ${storyboard.segments.length + 1} 张 + 视频 ${storyboard.segments.length} 段。</div>
</body></html>`;
}

function runClipPublicUrl(runId, filename) {
  return `${PUBLIC_BASE_URL}/run-clips/${encodeURIComponent(runId)}/${encodeURIComponent(filename)}`;
}

function serveGeneratedImage(req, res, imageId, filename) {
  const safeImageId = basename(String(imageId || ""));
  const safeFilename = basename(String(filename || ""));
  if (!safeImageId || !safeFilename) return json(res, 404, { detail: "generated image not found" });
  const imagePath = join(IMAGE_OUTPUT_DIR, safeImageId, safeFilename);
  if (!existsSync(imagePath)) return json(res, 404, { detail: "generated image not found" });
  const mimeType = imageMimeTypes.get(imagePath) || normalizeImageMime(`image/${safeFilename.split(".").pop() || IMAGE_OPENAI_OUTPUT_FORMAT}`);
  const stat = statSync(imagePath);
  res.writeHead(200, {
    "content-type": mimeType,
    "content-length": stat.size,
    "cache-control": "public, max-age=31536000, immutable",
    "access-control-allow-origin": "*",
    "x-robots-tag": "noindex",
  });
  if (req.method === "HEAD") return res.end();
  createReadStream(imagePath).pipe(res);
}

function openapi() {
  return {
    openapi: "3.1.0",
    info: { title: "MoneyPrinterTurbo GPT Image + Gemini Video API", version: "1.0.0" },
    paths: {
        "/api/v1/images": { post: { summary: "Generate GPT images for the visual canvas. Supports prompt, aspect_ratio, count, style, brand, and optional reference_images." } },
        "/api/v1/generated-images/{image_id}/{filename}": { get: { summary: "Read a generated image asset" } },
        "/api/v1/run-clips/{run_id}/{filename}": { get: { summary: "Read a downloaded video clip from a job run directory (mp4 only); used by the remote archiver" } },
        "/api/v1/run-assets/{run_id}/{filename}": { get: { summary: "Read a png/jpg/html asset from a job run directory (story-mode greyboxes, animatics, preview.html)" } },
        "/api/v1/image-videos": { post: { summary: "Create keyframe + video job (backend: seedance | veo-openai | gemini). Send story_mode=true to render keyframes from the fixed Blender scene (pose/camera/anchor chosen from the worker manifest) and restyle them with GPT-image before video. Send plan_only=true to preview the storyboard without spending." } },
        "/api/v1/image-videos/{job_id}": { get: { summary: "Get image video job" } },
        "/api/v1/media/{video_id}/{filename}": { get: { summary: "Proxy archived media with Range support" } },
        "/api/v1/subtitles/{video_id}.vtt": { get: { summary: "Return archived subtitle metadata as WebVTT for browser playback" } },
      },
  };
}

const studio = createStudioRouter({
  dataDir: envValue("STUDIO_DATA_DIR", join(homedir(), ".local", "share", "weiai-studio", "v3")),
  token: () => VIDEO_API_TOKEN,
  workerUrl: BLENDER_STORY_WORKER_URL,
  workerToken: envValue("STUDIO_WORKER_TOKEN"),
  codeWorkerUrl: envValue("STUDIO_CODE_WORKER_URL"),
  codeWorkerToken: envValue("STUDIO_CODE_WORKER_TOKEN", envValue("STUDIO_WORKER_TOKEN")),
  publicDemoProjectIds: envValue("PUBLIC_DEMO_PROJECT_IDS").split(",").map(value => value.trim()).filter(Boolean),
  jobsOptions: {
    ...(VIDEO_STORAGE_BASE_URL && VIDEO_STORAGE_TOKEN ? { archiveVideo: (id, path, title, metadata) => archiveVideo(id, path, title, { ...metadata, archived_by: "studio-v3", ...(metadata.studioJobKind === "export" ? { provider: "ffmpeg" } : {}) }, "studio-v3-video") } : {}),
  },
  legacyAssetOrigins: [PUBLIC_BASE_URL, envValue("IMAGE_PUBLIC_BASE_URL")].filter(Boolean),
  providerConfig: () => {
    let llm = {};
    const agentBase = envValue("AGENT_LLM_BASE_URL").replace(/\/+$/, "");
    const agentKey = envValue("AGENT_LLM_API_KEY");
    if (agentBase && agentKey) {
      const model = envValue("AGENT_LLM_MODELS", envValue("AGENT_LLM_MODEL", "claude-sonnet-5")).split(",").map(value => value.trim()).find(Boolean);
      llm = { baseUrl: agentBase, apiKey: agentKey, model: envValue("STUDIO_LLM_MODEL", model) };
    } else {
      try { const config = openAIConfig(); llm = { ...config, model: envValue("STUDIO_LLM_MODEL", config.chatModel) }; } catch { /* Explicitly unavailable in capabilities. */ }
    }
    return {
      backend: VIDEO_BACKEND,
      baseUrl: VIDEO_BACKEND === "gemini" ? GEMINI_VIDEO_BASE_URL : OPENAI_VIDEO_BASE_URL,
      apiKey: VIDEO_BACKEND === "gemini" ? GEMINI_VIDEO_API_KEY : OPENAI_VIDEO_API_KEY,
      model: activeVideoModel(), resolution: GEMINI_VIDEO_RESOLUTION, llm,
    };
  },
});

createServer(async (req, res) => {
  try {
    if (await studio.handle(req, res)) return;
    if (req.method === "OPTIONS") return json(res, 204, {});
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname === "/health" || url.pathname === "/api/v1/health") {
      return json(res, 200, {
        status: "ok",
        backend: "node-gpt-gemini",
        image_model: IMAGE_MODEL,
        image_fallback_models: IMAGE_OPENAI_FALLBACK_MODELS,
        image_generation_endpoint: true,
        image_quality: IMAGE_OPENAI_QUALITY,
        image_output_format: IMAGE_OPENAI_OUTPUT_FORMAT,
        image_output_compression: IMAGE_OPENAI_OUTPUT_COMPRESSION,
        video_model: activeVideoModel(),
        video_backend: VIDEO_BACKEND,
        video_provider: activeVideoProvider(),
        video_base_url: VIDEO_BACKEND === "gemini" ? GEMINI_VIDEO_BASE_URL : OPENAI_VIDEO_BASE_URL,
        video_key_set: VIDEO_BACKEND === "gemini" ? Boolean(GEMINI_VIDEO_API_KEY) : Boolean(OPENAI_VIDEO_API_KEY),
        keyframe_image_model: KEYFRAME_IMAGE_MODEL || null,
        seedance_fallback_model: VIDEO_BACKEND === "seedance" ? SEEDANCE_FALLBACK_MODEL || null : null,
        story_mode_available: Boolean(BLENDER_STORY_WORKER_URL),
        blender_story_worker_url: BLENDER_STORY_WORKER_URL || null,
        keyframe_mode: VIDEO_BACKEND === "gemini" ? "first_last_frame" : "first_frame",
        gemini_base_url: GEMINI_VIDEO_BASE_URL,
        gemini_key_set: Boolean(GEMINI_VIDEO_API_KEY),
        remote_drive_archive: Boolean(REMOTE_VIDEO_ARCHIVER_URL && REMOTE_VIDEO_ARCHIVER_TOKEN),
        max_image_video_duration_seconds: IMAGE_VIDEO_MAX_DURATION_SECONDS > 0 ? IMAGE_VIDEO_MAX_DURATION_SECONDS : null,
        max_image_video_segments: IMAGE_VIDEO_MAX_SEGMENTS > 0 ? IMAGE_VIDEO_MAX_SEGMENTS : null,
        image_video_segment_seconds: IMAGE_VIDEO_SEGMENT_SECONDS,
      });
    }
    if (url.pathname === "/api/v1/openapi.json" && req.method === "GET") return json(res, 200, openapi());
    const mediaMatch = url.pathname.match(/^\/api\/v1\/media\/([^/]+)\/(.+)$/);
    if (mediaMatch && ["GET", "HEAD"].includes(req.method || "")) {
      return proxyMedia(req, res, decodeURIComponent(mediaMatch[1]), decodeURIComponent(mediaMatch[2]));
    }
    const subtitleMatch = url.pathname.match(/^\/api\/v1\/subtitles\/([^/]+)\.vtt$/);
    if (subtitleMatch && ["GET", "HEAD"].includes(req.method || "")) {
      return proxySubtitle(req, res, decodeURIComponent(subtitleMatch[1]));
    }
    const generatedImageMatch = url.pathname.match(/^\/api\/v1\/generated-images\/([^/]+)\/(.+)$/);
    if (generatedImageMatch && ["GET", "HEAD"].includes(req.method || "")) {
      return serveGeneratedImage(req, res, decodeURIComponent(generatedImageMatch[1]), decodeURIComponent(generatedImageMatch[2]));
    }
    const runAssetMatch = url.pathname.match(/^\/api\/v1\/run-assets\/([^/]+)\/(.+)$/);
    if (runAssetMatch && (req.method === "GET" || req.method === "HEAD")) return serveRunAsset(req, res, decodeURIComponent(runAssetMatch[1]), decodeURIComponent(runAssetMatch[2]));
    const runClipMatch = url.pathname.match(/^\/api\/v1\/run-clips\/([^/]+)\/(.+)$/);
    if (runClipMatch && ["GET", "HEAD"].includes(req.method || "")) {
      return serveRunClip(req, res, decodeURIComponent(runClipMatch[1]), decodeURIComponent(runClipMatch[2]));
    }
    if (url.pathname === "/api/v1/images" && req.method === "POST") {
      if (!requireToken(req, res)) return;
      const payload = await readJson(req);
      const data = await createStandaloneImages(payload);
      return json(res, 200, { status: 200, message: "success", data });
    }
    if (url.pathname === "/api/v1/image-videos" && req.method === "POST") {
      if (!requireToken(req, res)) return;
      const payload = await readJson(req);
      const subject = String(payload.video_subject || "").trim();
      if (!subject) return json(res, 422, { detail: "video_subject is required" });
      if (planningRequested(payload)) {
        return json(res, 200, { status: 200, message: "plan_only", data: createPlanningPreview(payload) });
      }
      const jobId = randomUUID();
      const job = {
        job_id: jobId,
        state: "queued",
        progress: 0,
        video_subject: subject,
        backend: activeVideoProvider(),
        image_model: IMAGE_MODEL,
        image_fallback_models: IMAGE_OPENAI_FALLBACK_MODELS,
        image_quality: IMAGE_OPENAI_QUALITY,
        image_output_format: IMAGE_OPENAI_OUTPUT_FORMAT,
        image_output_compression: IMAGE_OPENAI_OUTPUT_COMPRESSION,
        video_model: activeVideoModel(),
        max_duration: IMAGE_VIDEO_MAX_DURATION_SECONDS > 0 ? IMAGE_VIDEO_MAX_DURATION_SECONDS : null,
        max_segments: IMAGE_VIDEO_MAX_SEGMENTS > 0 ? IMAGE_VIDEO_MAX_SEGMENTS : null,
      };
      jobs.set(jobId, job);
      setTimeout(() => runImageVideoJob(jobId, payload), 0);
      return json(res, 202, { status: 202, message: "accepted", data: job });
    }
    const jobMatch = url.pathname.match(/^\/api\/v1\/image-videos\/([^/]+)$/);
    if (jobMatch && req.method === "GET") {
      if (!requireToken(req, res)) return;
      const job = jobs.get(decodeURIComponent(jobMatch[1]));
      if (!job) return json(res, 404, { detail: "image video job not found" });
      return json(res, 200, { status: 200, message: "success", data: job });
    }
    return json(res, 404, { detail: "not found" });
  } catch (error) {
    return json(res, 500, { detail: String(error.message || error) });
  }
}).listen(PORT, "0.0.0.0", () => {
  console.log(`node gpt-gemini gateway listening on ${PORT}`);
});
