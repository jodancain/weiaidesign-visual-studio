import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { gzipSync, gunzipSync } from 'node:zlib';
import { unzipSync, zipSync } from 'fflate';
import { craftEngine, craftEngines, craftLaunchArgs, isCraftCommandSafe, isCraftToolSafe, craftCommandUnavailableReason } from './craft-catalog.mjs';
import { craftSandboxCommand } from './craft-sandbox.mjs';

const BUNDLE_MIME = 'application/vnd.image2.craft-bundle+json';
const MAX_FILE = 64 * 1024 * 1024;
const MAX_TOTAL = 128 * 1024 * 1024;
const MAX_ARGS = 2 * 1024 * 1024;
const MAX_STEPS = 48;
const GENERIC = new Set(['command_run', 'run_command', 'execute', 'execute_command']);
const PATH_KEY = /^(?:path|paths|file|files|filename|directory|dir|folder|out_dir|output|output_path|input_path|source_path|destination|variables|fontPath|imagePath|audioPath|videoPath|presetPath)$/i;
const LOCATION_KEY = /(?:Path|File|Dir|Folder|_path|_file|_dir|_folder)$/;
const error = (code, message, statusCode = 400) => Object.assign(new Error(message), { code, statusCode });
const abortCheck = signal => { if (signal?.aborted) throw error('CRAFT_CANCELLED', 'ArtCraft task cancelled', 409); };
const inside = (root, target) => target === root || target.startsWith(`${root}${path.sep}`);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const plain = v => !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

export function validateCraftSchema(value, schema = {}, root = schema, depth = 0) {
  if (depth > 32) throw error('CRAFT_ARGS_INVALID', 'Arguments exceed the nesting limit');
  if (schema.$ref) {
    const resolved = schema.$ref.startsWith('#/') && schema.$ref.slice(2).split('/').reduce((v, k) => v?.[k.replace(/~1/g, '/').replace(/~0/g, '~')], root);
    if (!resolved) throw error('CRAFT_SCHEMA_UNSUPPORTED', 'The native tool schema cannot be resolved');
    return validateCraftSchema(value, resolved, root, depth + 1);
  }
  if (schema.anyOf || schema.oneOf) {
    const results = (schema.anyOf ?? schema.oneOf).filter(branch => { try { validateCraftSchema(value, branch, root, depth + 1); return true; } catch { return false; } });
    if (!results.length || (schema.oneOf && results.length !== 1)) throw error('CRAFT_ARGS_INVALID', 'Arguments do not match the native tool schema');
  }
  if (schema.allOf) for (const branch of schema.allOf) validateCraftSchema(value, branch, root, depth + 1);
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  const fits = type => ({ object: plain(value), array: Array.isArray(value), string: typeof value === 'string', number: typeof value === 'number' && Number.isFinite(value), integer: Number.isInteger(value), boolean: typeof value === 'boolean', null: value === null })[type] ?? true;
  if (types.length && !types.some(fits)) throw error('CRAFT_ARGS_INVALID', `Expected ${types.join(' or ')}`);
  if (schema.enum && !schema.enum.some(v => JSON.stringify(v) === JSON.stringify(value))) throw error('CRAFT_ARGS_INVALID', 'Value is outside the native tool enum');
  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value)) throw error('CRAFT_ARGS_INVALID', 'Unexpected constant value');
  if (typeof value === 'number' && ((schema.minimum != null && value < schema.minimum) || (schema.maximum != null && value > schema.maximum))) throw error('CRAFT_ARGS_INVALID', 'Number is outside the native tool bounds');
  if (Array.isArray(value)) {
    if (value.length > 10000 || value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) throw error('CRAFT_ARGS_INVALID', 'Array length is outside the native tool bounds');
    for (const item of value) validateCraftSchema(item, schema.items ?? {}, root, depth + 1);
  } else if (plain(value)) {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) throw error('CRAFT_ARGS_INVALID', `Missing required argument: ${key}`);
    for (const [key, item] of Object.entries(value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw error('CRAFT_ARGS_INVALID', 'Unsafe object key');
      if (schema.additionalProperties === false && !Object.hasOwn(schema.properties ?? {}, key)) throw error('CRAFT_ARGS_INVALID', `Unknown argument: ${key}`);
      validateCraftSchema(item, schema.properties?.[key] ?? (plain(schema.additionalProperties) ? schema.additionalProperties : {}), root, depth + 1);
    }
  } else if (typeof value === 'string' && (value.length > MAX_ARGS || value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity))) throw error('CRAFT_ARGS_INVALID', 'String length exceeds the limit');
}

export function validateCraftBudgets(command, args) {
  const rasterWork = /(?:render|export|resize|imageSize|canvasSize|doc_new|file\.new|new_document|comp\.new|doc_create)/i.test(command);
  const visit = value => {
    if (!plain(value)) { if (Array.isArray(value)) for (const item of value) visit(item); return; }
    if (rasterWork) {
      for (const [key, item] of Object.entries(value)) {
        if (/^(?:width|height|max_side|maxSide|pixelWidth|pixelHeight|output_width|output_height)$/.test(key) && typeof item === 'number' && (item < 0 || item > 8192)) throw error('CRAFT_RESOURCE_BUDGET', 'Raster dimensions must be within 0–8192 pixels or page units');
        if (/^(?:scale|pixelRatio|dpiScale)$/.test(key) && typeof item === 'number' && (item <= 0 || item > 8)) throw error('CRAFT_RESOURCE_BUDGET', 'Render/export scale must be within 0–8');
      }
      if (typeof value.width === 'number' && typeof value.height === 'number' && value.width * value.height * (typeof value.scale === 'number' ? value.scale ** 2 : 1) > 16 * 1024 * 1024) throw error('CRAFT_RESOURCE_BUDGET', 'Raster jobs are limited to 16 megapixels');
      if (typeof value.pages === 'number' && value.pages > 200) throw error('CRAFT_RESOURCE_BUDGET', 'A native task may create at most 200 pages');
    }
    if (typeof value.sample_rate === 'number' && value.sample_rate > 192000) throw error('CRAFT_RESOURCE_BUDGET', 'Sample rate exceeds the native job limit');
    for (const item of Object.values(value)) visit(item);
  };
  visit(args);
}

function safeName(name) {
  if (typeof name !== 'string' || !/^[\p{L}\p{N}_. -]{1,140}$/u.test(name) || name === '.' || name === '..' || name.startsWith('.')) throw error('CRAFT_PATH_INVALID', 'Use a plain output filename without directories');
  return name;
}

export function resolveCraftArguments(args, { inputs = new Map(), workDir, results = [], allowedTextKeys = [] }, depth = 0, key = '') {
  if (depth > 24) throw error('CRAFT_ARGS_INVALID', 'Arguments exceed the nesting limit');
  if (plain(args) && Object.keys(args).length === 1 && typeof args.assetId === 'string') {
    const value = inputs.get(args.assetId);
    if (!value) throw error('CRAFT_ASSET_UNKNOWN', 'Input asset is not attached to this task');
    return value;
  }
  if (plain(args) && Object.keys(args).length === 1 && typeof args.outputName === 'string') return path.join(workDir, 'exports', safeName(args.outputName));
  if (plain(args) && Object.keys(args).length === 1 && typeof args.resultRef === 'string') {
    const parts = /^(\d+)\.([\w.]+)$/.exec(args.resultRef);
    if (!parts || Number(parts[1]) >= results.length) throw error('CRAFT_RESULT_REF_INVALID', 'Result reference must point to a completed earlier step');
    let value = results[Number(parts[1])];
    for (const part of parts[2].split('.')) { if (['__proto__', 'prototype', 'constructor'].includes(part)) throw error('CRAFT_RESULT_REF_INVALID', 'Unsafe result reference'); value = value?.[part]; }
    if (value === undefined || (typeof value === 'string' && (PATH_KEY.test(key) || LOCATION_KEY.test(key)))) throw error('CRAFT_RESULT_REF_INVALID', 'Result reference is absent or cannot supply a file path');
    return resolveCraftArguments(structuredClone(value), { inputs, workDir, results, allowedTextKeys }, depth + 1, key);
  }
  if (Array.isArray(args)) return args.map(item => resolveCraftArguments(item, { inputs, workDir, results, allowedTextKeys }, depth + 1, key));
  if (plain(args)) return Object.fromEntries(Object.entries(args).map(([k, v]) => {
    if (['__proto__', 'prototype', 'constructor'].includes(k)) throw error('CRAFT_ARGS_INVALID', 'Unsafe object key');
    return [k, resolveCraftArguments(v, { inputs, workDir, results, allowedTextKeys }, depth + 1, k)];
  }));
  if (typeof args === 'string') {
    // Property paths such as transform/position are data, not filesystem paths.
    const svgGeometry = key === 'path' && /^[Mm]\s*[-+.\d][MmZzLlHhVvCcSsQqTtAa\d\s,.eE+\-]*$/.test(args);
    if ((PATH_KEY.test(key) || LOCATION_KEY.test(key)) && args && !allowedTextKeys.includes(key) && !svgGeometry && !(key === 'path' && /^(?:transform|effects|masks|contents|text|material)\//.test(args))) throw error('CRAFT_PATH_INVALID', 'File paths must use an attached assetId or outputName');
    if (/^(?:file|https?|ftp|smb|ssh|data):/i.test(args) && /(?:url|uri|source|href|link|src)/i.test(key)) throw error('CRAFT_NETWORK_DENIED', 'External resources are not available in ArtCraft jobs');
  }
  return args;
}

function unwrap(reply) {
  if (reply?.isError) throw error('CRAFT_NATIVE_ERROR', (reply.content ?? []).filter(v => v.type === 'text').map(v => v.text).join('\n').slice(0, 8000) || 'Native engine command failed', 422);
  if (reply?.structuredContent != null) return reply.structuredContent;
  const texts = (reply?.content ?? []).filter(v => v.type === 'text').map(v => v.text);
  for (const text of texts) { try { return JSON.parse(text); } catch { /* Native tools may return plain text. */ } }
  return texts.length === 1 ? texts[0] : texts;
}

class StdioClient {
  constructor(command, { workDir, signal, timeoutMs, maxOutputBytes }) {
    this.nextId = 0; this.pending = new Map(); this.buffer = ''; this.stderr = ''; this.total = 0; this.closed = false;
    this.child = spawn(command.file, command.args, { cwd: command.cwd ?? workDir, env: command.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
    const fail = cause => { for (const item of this.pending.values()) item.reject(cause); this.pending.clear(); this.failure = cause; };
    this.child.on('error', e => fail(error('CRAFT_PROCESS_ERROR', e.message, 503)));
    this.child.stdin.on('error', e => fail(error('CRAFT_PROCESS_ERROR', `Native input stream closed: ${e.message}`, 503)));
    this.child.on('exit', (code, sig) => { this.closed = true; this.exitCode = code; this.exitSignal = sig; fail(error('CRAFT_PROCESS_EXIT', `Native engine exited (${sig ?? code}): ${this.stderr.slice(-2000)}`, 503)); });
    this.child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk.toString()).slice(-12000); });
    const decoder = new StringDecoder('utf8');
    this.child.stdout.on('data', chunk => {
      this.total += chunk.length;
      if (this.total > maxOutputBytes) { fail(error('CRAFT_OUTPUT_LIMIT', 'Native response exceeded its byte budget', 422)); this.stop(); return; }
      this.buffer += decoder.write(chunk);
      let end;
      while ((end = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { fail(error('CRAFT_PROTOCOL_ERROR', 'Native engine returned invalid JSON-RPC', 503)); this.stop(); return; }
        const item = this.pending.get(message.id);
        if (!item) continue;
        this.pending.delete(message.id);
        if (message.error) item.reject(error('CRAFT_PROTOCOL_ERROR', String(message.error.message).slice(0, 2000), 422)); else item.resolve(message.result);
      }
    });
    this.timer = setTimeout(() => { fail(error('CRAFT_TIMEOUT', 'Native engine exceeded the execution time limit', 408)); this.stop(); }, timeoutMs);
    this.timer.unref?.();
    this.abort = () => { fail(error('CRAFT_CANCELLED', 'ArtCraft task cancelled', 409)); this.stop(); };
    signal?.addEventListener('abort', this.abort, { once: true }); this.signal = signal;
    if (signal?.aborted) this.abort();
  }
  call(method, params = {}) {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, e => { if (e) { this.pending.delete(id); reject(error('CRAFT_PROCESS_ERROR', e.message, 503)); } });
    });
  }
  async initialize() {
    const result = await this.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'weiai-image2', version: '2.0' } });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
    return result;
  }
  tool(name, args = {}) { return this.call('tools/call', { name, arguments: args }); }
  async finish() {
    if (!this.closed) {
      this.child.stdin.end();
      let timer;
      await Promise.race([new Promise(resolve => this.child.once('exit', resolve)), new Promise(resolve => { timer = setTimeout(resolve, 10000); })]);
      clearTimeout(timer);
    }
    this.stop();
    if (!this.closed || this.exitCode !== 0) throw error('CRAFT_SHUTDOWN_INCOMPLETE', 'Native engine did not finish saving before exit; no checkpoint was accepted', 503);
  }
  stop() {
    clearTimeout(this.timer); this.signal?.removeEventListener('abort', this.abort);
    if (!this.closed && this.child.pid) { try { process.kill(process.platform === 'win32' ? this.child.pid : -this.child.pid, 'SIGKILL'); } catch { /* Already gone. */ } }
  }
}

async function readBounded(file, max = MAX_FILE) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max) throw error('CRAFT_FILE_INVALID', 'Native file is not a bounded regular file', 422);
  return fs.readFile(file);
}

async function walk(root, prefix = '', list = [], budget = { bytes: 0 }) {
  for (const entry of await fs.readdir(path.join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw error('CRAFT_FILE_INVALID', 'Native jobs may not produce symbolic links', 422);
    if (entry.isDirectory()) await walk(root, relative, list, budget);
    else if (entry.isFile()) {
      const bytes = await readBounded(path.join(root, relative)); budget.bytes += bytes.length;
      if (budget.bytes > MAX_TOTAL || list.length >= 2000) throw error('CRAFT_OUTPUT_LIMIT', 'Native workspace exceeds its storage budget', 422);
      list.push({ relative, bytes });
    }
  }
  return list;
}

function remapJson(bytes, oldRoot, newRoot) {
  const contentKey = /^(?:text|name|title|label|caption|description|value|string)$/i;
  const remap = (value, key = '') => typeof value === 'string' && !contentKey.test(key) && value.startsWith(`${oldRoot}/`)
    ? `${newRoot}${value.slice(oldRoot.length)}`
    : Array.isArray(value) ? value.map(item => remap(item, key))
      : plain(value) ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, remap(v, k)])) : value;
  try { return Buffer.from(JSON.stringify(remap(JSON.parse(bytes.toString('utf8'))))); } catch { return bytes; }
}

function remapNative(bytes, oldRoot, newRoot, depth = 0) {
  if (depth > 2 || !oldRoot || oldRoot === newRoot) return bytes;
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return gzipSync(remapNative(gunzipSync(bytes, { maxOutputLength: MAX_FILE }), oldRoot, newRoot, depth + 1));
  if (bytes.subarray(0, 4).equals(Buffer.from('PK\x03\x04'))) {
    let sum = 0;
    const entries = unzipSync(bytes, { filter: entry => { sum += entry.originalSize; if (sum > MAX_FILE) throw error('CRAFT_FILE_INVALID', 'Native archive exceeds its expanded size budget'); return true; } });
    let changed = false;
    for (const [name, data] of Object.entries(entries)) if (name.endsWith('.json')) { const mapped = remapJson(Buffer.from(data), oldRoot, newRoot); if (!mapped.equals(Buffer.from(data))) { entries[name] = mapped; changed = true; } }
    return changed ? Buffer.from(zipSync(entries)) : bytes;
  }
  const split = bytes.indexOf(Buffer.from('\n\0VCBLOBS\0'));
  if (split >= 0) return Buffer.concat([remapJson(bytes.subarray(0, split), oldRoot, newRoot), bytes.subarray(split)]);
  return remapJson(bytes, oldRoot, newRoot);
}

export async function restoreCraftBundle(nativeFile, workDir, engineId) {
  const packed = await readBounded(nativeFile);
  let bundle;
  try { bundle = JSON.parse(gunzipSync(packed, { maxOutputLength: MAX_TOTAL * 1.5 }).toString('utf8')); } catch { throw error('CRAFT_CHECKPOINT_INVALID', 'Expected a valid ArtCraft workspace checkpoint'); }
  if (bundle.version !== 1 || bundle.engineId !== engineId || !Array.isArray(bundle.files) || bundle.files.length > 2000) throw error('CRAFT_CHECKPOINT_INVALID', 'Checkpoint engine or format mismatch');
  let sum = 0;
  for (const entry of bundle.files) {
    if (!plain(entry) || typeof entry.path !== 'string' || !/^(?:inputs|native|library|exports)\//.test(entry.path) || entry.path.split('/').some(v => !v || v === '.' || v === '..') || entry.path.includes('\\')) throw error('CRAFT_CHECKPOINT_INVALID', 'Checkpoint contains an unsafe path');
    const target = path.resolve(workDir, entry.path);
    if (!inside(workDir, target)) throw error('CRAFT_CHECKPOINT_INVALID', 'Checkpoint path escapes its workspace');
    let bytes = Buffer.from(entry.data, 'base64'); sum += bytes.length;
    if (bytes.length > MAX_FILE || sum > MAX_TOTAL || digest(bytes) !== entry.sha256) throw error('CRAFT_CHECKPOINT_INVALID', 'Checkpoint file integrity or size check failed');
    if (!entry.path.startsWith('inputs/')) bytes = remapNative(bytes, bundle.workDir, workDir);
    await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes, { flag: 'wx' });
  }
  return bundle;
}

function mime(name) {
  return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf', wav: 'audio/wav', flac: 'audio/flac', aiff: 'audio/aiff', mp4: 'video/mp4', json: 'application/json', txt: 'text/plain', csv: 'text/csv', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })[path.extname(name).slice(1).toLowerCase()] ?? 'application/octet-stream';
}

export function craftPublicSchema(schema, name) {
  const cloned = structuredClone(schema ?? { type: 'object' });
  const visit = (node, key = '') => {
    if (!plain(node)) return;
    if ((PATH_KEY.test(key) || LOCATION_KEY.test(key)) && !/property path|SVG path|menu path/i.test(node.description ?? '')) {
      const role = /save|export|bounce|render|output|write/i.test(name) || /output|destination|out_dir/i.test(key) ? 'output' : 'input-asset';
      node['x-craft-role'] = role;
      node.description = `${node.description ?? ''} Use ${role === 'input-asset' ? '{assetId: owned asset ID}' : '{outputName: plain filename}'}, never a filesystem path.`.trim();
    }
    for (const [childKey, child] of Object.entries(node.properties ?? {})) visit(child, childKey);
    if (plain(node.items)) visit(node.items, key);
    if (Array.isArray(node.prefixItems)) for (const child of node.prefixItems) visit(child, key);
    for (const branch of ['anyOf', 'oneOf', 'allOf']) for (const child of node[branch] ?? []) visit(child, key);
    for (const definitions of [node.$defs, node.definitions]) for (const child of Object.values(definitions ?? {})) visit(child);
    if (plain(node.additionalProperties)) visit(node.additionalProperties);
  };
  visit(cloned); return cloned;
}

function commandSchema(entry) {
  if (plain(entry.inputSchema)) return entry.inputSchema;
  if (plain(entry.schema)) return entry.schema;
  if (plain(entry.params) && (entry.params.type || entry.params.properties || entry.params.$ref)) return entry.params;
  return undefined;
}

function commandAvailable(engine, entry) {
  return isCraftCommandSafe(entry.id, entry.description ?? '', engine.id) && !(engine.id === 'pdfcraft' && !entry.tool);
}

export function createCraftRuntime({ binDir = process.env.IMAGE2_CRAFT_BIN_DIR, timeoutMs = 120000, maxOutputBytes = 64 * 1024 * 1024, sandbox = craftSandboxCommand } = {}) {
  const cache = new Map();
  const inflightCatalog = new Map();
  const failedCatalog = new Map();
  async function binary(engine) {
    if (!binDir) throw error('CRAFT_NOT_CONFIGURED', 'ArtCraft native engines are not configured', 503);
    const root = await fs.realpath(binDir);
    const manifest = JSON.parse(await readBounded(path.join(root, 'manifest.json'), 1024 * 1024));
    const entry = manifest.engines?.find(item => item.id === engine.id);
    if (manifest.platform !== process.platform || manifest.arch !== process.arch || !entry || entry.sourceCommit !== engine.commit || entry.binary !== `${engine.id}-cli` || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw error('CRAFT_BINARY_MISMATCH', 'Native engine does not match the pinned build manifest', 503);
    const file = await fs.realpath(path.join(root, entry.binary));
    if (!inside(root, file)) throw error('CRAFT_BINARY_MISMATCH', 'Native executable escapes the configured binary directory', 503);
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size !== entry.bytes) throw error('CRAFT_BINARY_MISMATCH', 'Native executable size does not match the build manifest', 503);
    const stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${entry.sha256}`;
    if (cache.get(`binary:${engine.id}`) !== stamp) { if (digest(await fs.readFile(file)) !== entry.sha256) throw error('CRAFT_BINARY_MISMATCH', 'Native executable integrity check failed', 503); cache.set(`binary:${engine.id}`, stamp); }
    return { file, version: { sourceCommit: engine.commit, sha256: entry.sha256, platform: manifest.platform, arch: manifest.arch } };
  }
  async function start(engine, workDir, signal, limit = timeoutMs) {
    const build = await binary(engine);
    await fs.mkdir(path.join(workDir, 'library'), { recursive: true });
    const command = await sandbox(build.file, craftLaunchArgs(engine, workDir), { workDir });
    const client = new StdioClient(command, { workDir, signal, timeoutMs: limit, maxOutputBytes });
    try { const initialized = await client.initialize(); return { client, build, initialized }; } catch (e) { client.stop(); throw e; }
  }
  async function discover(client, engine) {
    const raw = await client.call('tools/list');
    const tools = Array.isArray(raw.tools) ? raw.tools : [];
    const listTool = tools.find(item => item.name === engine.list);
    const list = unwrap(await client.tool(engine.list, listTool?.inputSchema?.properties?.schemas ? { schemas: true } : {}));
    const commands = (Array.isArray(list) ? list : list?.commands ?? []).filter(item => item && typeof item.id === 'string');
    return { tools, commands };
  }
  async function engineCapability(engineId) {
    const engine = craftEngine(engineId);
    const base = {
      id: engine.id, name: engine.name, category: engine.category, nativeExtension: engine.nativeExtension,
      sourceCommit: engine.commit, repository: engine.repository, checkpointFormat: 'craftbundle', supportsSteps: true,
      limitations: engine.id === 'pdfcraft' ? ['Added page text is limited by the pinned native engine to WinAnsi Western European characters and Helvetica/Times/Courier. Chinese text insertion is unsupported; reading existing Chinese PDF content is a separate capability.'] : [],
      defaults: { new: engine.new?.[0] ?? null, preview: engine.preview?.[0] ?? null, inspect: engine.inspect },
      limits: { maxSteps: MAX_STEPS, maxFileBytes: MAX_FILE, maxWorkspaceBytes: MAX_TOTAL },
    };
    let workDir; let client;
    try {
      const build = await binary(engine); const key = `catalog:${engine.id}:${build.version.sha256}`;
      if (cache.has(key)) return { ...base, ...cache.get(key) };
      const failed = failedCatalog.get(key);
      if (failed && failed.until > Date.now()) return { ...base, ...failed.result };
      failedCatalog.delete(key);
      if (inflightCatalog.has(key)) return { ...base, ...await inflightCatalog.get(key) };
      let resolveDiscovery; let rejectDiscovery;
      const discovering = new Promise((resolve, reject) => { resolveDiscovery = resolve; rejectDiscovery = reject; });
      discovering.catch(() => {}); inflightCatalog.set(key, discovering);
      try {
        workDir = await fs.mkdtemp(path.join(os.tmpdir(), `image2-${engine.id}-catalog-`));
        ({ client } = await start(engine, workDir, undefined, 30000));
        const catalog = await discover(client, engine);
        const unavailable = item => {
          const name = item.id ?? item.name;
          const reason = craftCommandUnavailableReason(name, item.description, engine.id) ?? 'CRAFT_MANAGED_JOB_UNSUPPORTED';
          return { name, reason, processor: reason === 'CRAFT_MODEL_NOT_CONFIGURED' ? 'dedicated-model' : 'native-cpu' };
        };
        const result = {
          available: true, version: build.version, sandboxed: true,
          tools: catalog.tools.filter(item => isCraftToolSafe(item, engine.id)).map(item => ({
            ...item, processor: 'native-cpu', inputSchema: craftPublicSchema(item.inputSchema, item.name),
          })),
          commands: catalog.commands.filter(item => commandAvailable(engine, item)).map(item => {
            const schema = commandSchema(item);
            return { ...item, processor: 'native-cpu', schemaUnavailable: !schema,
              ...(!schema ? { schemaUnavailableReason: 'upstream_parameter_documentation_only' } : {}),
              inputSchema: craftPublicSchema(schema ?? { type: 'object' }, item.id) };
          }),
          unavailableTools: catalog.tools.filter(item => !isCraftToolSafe(item, engine.id)).map(unavailable),
          unavailableCommands: catalog.commands.filter(item => !commandAvailable(engine, item)).map(unavailable),
        };
        cache.set(key, result); resolveDiscovery(result); return { ...base, ...result };
      } catch (e) {
        const failure = { available: false, version: build.version, reason: e.code ?? 'CRAFT_UNAVAILABLE', message: e.message, tools: [], commands: [] };
        failedCatalog.set(key, { until: Date.now() + 5000, result: failure });
        rejectDiscovery(e); return { ...base, ...failure };
      } finally { inflightCatalog.delete(key); }
    } catch (e) { return { ...base, available: false, reason: e.code ?? 'CRAFT_UNAVAILABLE', message: e.message, tools: [], commands: [] }; }
    finally { client?.stop(); if (workDir) await fs.rm(workDir, { recursive: true, force: true }); }
  }
  async function capabilities({ engineId } = {}) {
    if (engineId) return [await engineCapability(engineId)];
    const engines = craftEngines(); const rows = [];
    // Bounded parallel discovery keeps a failed unrelated engine from serially
    // delaying the complete catalog, while preserving deterministic catalog order.
    for (let index = 0; index < engines.length; index += 3) rows.push(...await Promise.all(engines.slice(index, index + 3).map(engine => engineCapability(engine.id))));
    return rows;
  }

  async function execute({ engineId, workDir: requestedDir, steps, inputFiles = [], nativeFile, signal }) {
    const engine = craftEngine(engineId);
    if (!Array.isArray(steps) || !steps.length || steps.length > MAX_STEPS || JSON.stringify(steps).length > MAX_ARGS) throw error('CRAFT_STEPS_INVALID', `Submit 1–${MAX_STEPS} bounded command steps`);
    await fs.mkdir(requestedDir, { recursive: true }); const workDir = await fs.realpath(requestedDir);
    const restored = nativeFile ? await restoreCraftBundle(nativeFile, workDir, engineId) : null;
    for (const dir of ['inputs', 'native', 'exports']) await fs.mkdir(path.join(workDir, dir), { recursive: true });
    // Restored exports remain dependency assets inside the checkpoint. Only files
    // actually written by this job may become new revision exports.
    const exportBaseline = new Map();
    for (const entry of await walk(path.join(workDir, 'exports'))) {
      const stat = await fs.stat(path.join(workDir, 'exports', entry.relative), { bigint: true });
      exportBaseline.set(entry.relative, { hash: digest(entry.bytes), mtime: stat.mtimeNs, ctime: stat.ctimeNs, inode: stat.ino });
    }
    const inputs = new Map();
    for (const item of inputFiles) {
      if (!item.assetId || typeof item.assetId !== 'string') throw error('CRAFT_ASSET_UNKNOWN', 'Every input requires an owned asset reference');
      const bytes = await readBounded(item.path);
      const ext = path.extname(item.filename ?? item.path).slice(0, 16).replace(/[^.a-zA-Z0-9]/g, '');
      const target = path.join(workDir, 'inputs', `${digest(Buffer.from(item.assetId)).slice(0, 24)}${ext}`);
      await fs.writeFile(target, bytes); inputs.set(item.assetId, target);
    }
    abortCheck(signal);
    let client; const results = []; const warnings = []; const files = []; const receipt = { engineId, startedAt: new Date().toISOString(), steps: [], externalModelCalls: 0, processor: 'native-cpu' };
    try {
      const started = await start(engine, workDir, signal); client = started.client; receipt.version = started.build.version;
      const catalog = await discover(client, engine); const tools = new Map(catalog.tools.map(tool => [tool.name, tool])); const commands = new Map(catalog.commands.map(command => [command.id, command]));
      let documentId;
      let finalPreviewArgs = engine.preview?.[1];
      const registeredFonts = [];
      const collect = (reply, capturePreview = false) => {
        for (const block of capturePreview ? reply.content ?? [] : []) if (block.type === 'image' && ['image/png', 'image/jpeg', 'image/webp'].includes(block.mimeType)) {
          const bytes = Buffer.from(block.data, 'base64'); if (bytes.length > MAX_FILE) throw error('CRAFT_OUTPUT_LIMIT', 'Native preview exceeds its storage budget');
          files.push({ name: `preview-${files.length + 1}.${block.mimeType.split('/')[1]}`, mime: block.mimeType, bytes, role: 'preview' });
        }
        return unwrap(reply);
      };
      const run = async (command, args = {}, internal = false, capturePreview = false) => {
        abortCheck(signal);
        // The service job already runs asynchronously. Keep the native process
        // alive until these file-producing commands have actually finished.
        if ((engine.id === 'filmcraft' && ['file.exportMedia', 'sequence.renderVideo', 'sequence.renderAudio', 'sequence.renderInToOut'].includes(command)) || (engine.id === 'effectcraft' && command === 'renderQueue.render')) args = { ...args, wait: true };
        validateCraftBudgets(command, args);
        if (engine.id === 'pdfcraft' && command === 'form_set_actions' && Array.isArray(args.actions) && args.actions.some(action => plain(action) && typeof action.javascript === 'string')) throw error('CRAFT_SCRIPT_DISABLED', 'Managed PDF form actions cannot install executable JavaScript');
        if (engine.id === 'soundcraft' && command === 'mix.insert' && /^(?:vst3|clap|au):/i.test(args.plugin ?? '')) throw error('CRAFT_PLUGIN_DISABLED', 'Managed native jobs only load built-in audio effects');
        if (engine.id === 'lightcraft' && /mask/i.test(command)) {
          const check = value => { if (!plain(value)) { if (Array.isArray(value)) value.forEach(check); return; } if (['object', 'prompt'].includes(String(value.kind ?? '').toLowerCase()) && !value.seg) throw error('CRAFT_MODEL_NOT_CONFIGURED', 'Object and prompt masks require a configured SAM model or a supplied segmentation'); Object.values(value).forEach(check); };
          check(args);
        }
        let tool = tools.get(command); let nativeArgs = args;
        if (!tool) {
          const entry = commands.get(command);
          if (!entry || (!internal && !commandAvailable(engine, entry))) throw error('CRAFT_COMMAND_UNAVAILABLE', `Command is not enabled for managed jobs: ${command}`);
          const schema = commandSchema(entry);
          if (schema) validateCraftSchema(args, schema);
          tool = tools.get(engine.run);
          nativeArgs = engine.run === 'command_run' ? { id: command, params: args } : { command, params: args };
          if (engine.id === 'photocraft' && tool?.inputSchema?.properties?.wait) nativeArgs.wait = true;
        } else if (!internal && !isCraftToolSafe(tool, engine.id)) throw error('CRAFT_COMMAND_UNAVAILABLE', `Tool is not enabled for managed jobs: ${command}`);
        if (!tool) throw error('CRAFT_PROTOCOL_ERROR', 'Native command execution tool is missing', 503);
        validateCraftSchema(nativeArgs, tool.inputSchema ?? {});
        const result = collect(await client.tool(tool.name, nativeArgs), capturePreview);
        if (result?.pending === true) throw error('CRAFT_INTERACTION_REQUIRED', 'This native command needs a desktop dialog and cannot complete as a managed task', 422);
        // WordCraft's font.add updates a process-local font database. Persist
        // only the actual font assets, never a general startup command script.
        if (engine.id === 'wordcraft' && command === 'font.add') {
          if (!Array.isArray(result?.families)) throw error('CRAFT_ARGS_INVALID', 'Adding a native font requires an attached font asset or font bytes');
          const bytes = typeof args.path === 'string' ? await readBounded(args.path) : typeof args.data === 'string' ? Buffer.from(args.data, 'base64') : null;
          if (!bytes?.length || bytes.length > MAX_FILE) throw error('CRAFT_FILE_INVALID', 'Native font asset exceeds the storage limit');
          const extension = path.extname(args.path ?? args.name ?? '').toLowerCase();
          const relative = `inputs/registered-font-${digest(bytes)}${/^\.(ttf|otf|ttc|woff2?)$/.test(extension) ? extension : '.ttf'}`;
          await fs.writeFile(path.join(workDir, relative), bytes);
          if (!registeredFonts.some(font => font.path === relative)) {
            if (registeredFonts.length >= 128) throw error('CRAFT_RESOURCE_BUDGET', 'A native document may register at most 128 custom fonts');
            registeredFonts.push({ path: relative, families: result.families.filter(family => typeof family === 'string').slice(0, 128) });
          }
        }
        if (engine.id === 'wordcraft' && command === 'font.remove') for (let index = registeredFonts.length - 1; index >= 0; index--) if (registeredFonts[index].families.includes(args.family)) registeredFonts.splice(index, 1);
        if (engine.docId && (command === engine.open || command === engine.new?.[0])) documentId = result?.doc ?? result?.id ?? result?.document?.id;
        return result;
      };
      if (restored?.registeredFonts !== undefined) {
        if (engine.id !== 'wordcraft' || !Array.isArray(restored.registeredFonts) || restored.registeredFonts.length > 128) throw error('CRAFT_CHECKPOINT_INVALID', 'Invalid native font registrations');
        for (const font of restored.registeredFonts) {
          if (!plain(font) || !/^inputs\/registered-font-[a-f0-9]{64}\.(?:ttf|otf|ttc|woff2?)$/.test(font.path)) throw error('CRAFT_CHECKPOINT_INVALID', 'Native font registration must reference a managed font asset');
          await run('font.add', { path: path.join(workDir, font.path) }, true);
        }
      }
      if (restored && !engine.library) await run(engine.open, { path: path.join(workDir, 'native', `document.${engine.extension}`) }, true);
      else if (!restored && engine.new && !steps.some(step => ['new', engine.new[0], engine.open].includes(step.command))) await run(engine.new[0], engine.new[1], true);
      for (const step of steps) {
        if (!plain(step) || typeof step.command !== 'string' || !plain(step.args ?? {})) throw error('CRAFT_STEPS_INVALID', 'Each step needs a command and object args');
        let command = step.command; let rawArgs = step.args ?? {};
        if (GENERIC.has(command)) {
          command = rawArgs.id ?? rawArgs.command; rawArgs = rawArgs.params ?? {};
          if (!commands.has(command) || !commandAvailable(engine, commands.get(command))) throw error('CRAFT_COMMAND_UNAVAILABLE', 'Generic command must name an allowed native command');
        }
        if (command === 'new') { if (!engine.new) { results.push({ library: true }); continue; } [command, rawArgs] = [engine.new[0], { ...engine.new[1], ...rawArgs }]; }
        if (command === 'inspect') command = engine.inspect;
        if (command === 'preview') { if (!engine.preview) throw error('CRAFT_PREVIEW_UNAVAILABLE', 'This engine exposes structured state instead of a visual preview'); [command, rawArgs] = [engine.preview[0], { ...engine.preview[1], ...rawArgs }]; }
        const allowedTextKeys = (engine.id === 'soundcraft' && command === 'track.output') || (engine.id === 'filmcraft' && command === 'mixer.setStrip') ? ['output'] : [];
        const args = resolveCraftArguments(rawArgs, { inputs, workDir, results, allowedTextKeys });
        const start = Date.now(); const result = await run(command, args); results.push(result); receipt.steps.push({ command, durationMs: Date.now() - start, status: 'completed' });
        if (command === engine.preview?.[0] && (!args.format || /^(?:png|jpeg|jpg|webp)$/i.test(args.format))) {
          // Keep the chosen page and preview size, but do not silently rewrite an
          // explicitly named export while refreshing the final-state preview.
          finalPreviewArgs = Object.fromEntries(Object.entries({ ...engine.preview[1], ...args }).filter(([key]) => !PATH_KEY.test(key) && !LOCATION_KEY.test(key)));
        }
      }
      abortCheck(signal);
      if (!engine.library) {
        const saveArgs = { path: path.join(workDir, 'native', `document.${engine.extension}`) };
        if (engine.docId) { if (!documentId) { const list = unwrap(await client.tool('doc_list', {})); documentId = (Array.isArray(list) ? list : list.documents ?? list.docs ?? [])[0]?.id; } saveArgs.doc = documentId; }
        if (engine.id === 'soundcraft') saveArgs.replace = true;
        await run(engine.save, saveArgs, true);
      }
      let state;
      try { state = await run(engine.inspect, {}, true); } catch (e) { warnings.push(`State inspection: ${e.message}`); }
      // A preview requested before later edits is intermediate evidence, never the
      // accepted candidate. Always render the state after the complete step list.
      if (engine.preview) { try { await run(engine.preview[0], finalPreviewArgs, true, true); } catch (e) { warnings.push(`Preview: ${e.message}`); } }
      await client.finish(); client = null; abortCheck(signal);
      const stored = []; const storedBudget = { bytes: 0 };
      for (const dir of ['inputs', 'native', 'library', 'exports']) for (const entry of await walk(path.join(workDir, dir), '', [], storedBudget)) stored.push({ path: `${dir}/${entry.relative}`, data: entry.bytes.toString('base64'), sha256: digest(entry.bytes) });
      const checkpointBytes = gzipSync(Buffer.from(JSON.stringify({ version: 1, engineId, engineVersion: receipt.version, ...(registeredFonts.length ? { registeredFonts } : {}), workDir, files: stored })));
      if (checkpointBytes.length > MAX_FILE) throw error('CRAFT_OUTPUT_LIMIT', 'Native checkpoint exceeds its storage budget', 422);
      for (const entry of await walk(path.join(workDir, 'exports'))) {
        const before = exportBaseline.get(entry.relative);
        const stat = await fs.stat(path.join(workDir, 'exports', entry.relative), { bigint: true });
        // Re-exporting identical bytes is still a current output when the engine
        // rewrote the file. Untouched restored files remain checkpoint-only.
        if (!before || before.hash !== digest(entry.bytes) || before.mtime !== stat.mtimeNs || before.ctime !== stat.ctimeNs || before.inode !== stat.ino) files.push({ name: entry.relative, mime: mime(entry.relative), bytes: entry.bytes, role: 'export' });
      }
      if (!engine.library) { const native = await readBounded(path.join(workDir, 'native', `document.${engine.extension}`)); files.push({ name: `document.${engine.extension}`, mime: mime(`document.${engine.extension}`), bytes: native, role: 'native' }); }
      if (files.reduce((sum, item) => sum + item.bytes.length, checkpointBytes.length) > MAX_TOTAL) throw error('CRAFT_OUTPUT_LIMIT', 'Native outputs exceed their storage budget', 422);
      receipt.finishedAt = new Date().toISOString(); receipt.stepsCompleted = receipt.steps.length;
      return { result: results, files, checkpoint: { name: 'checkpoint.craftbundle', mime: BUNDLE_MIME, bytes: checkpointBytes }, receipt, state, warnings };
    } finally { client?.stop(); }
  }
  return { capabilities, catalog: capabilities, engineCapability, execute };
}
