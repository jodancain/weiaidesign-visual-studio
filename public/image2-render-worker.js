/* Shared software renderer. Runtime and core are copied from pinned local dependencies. */
let enginePromise;
let modulesPromise;
let sequence = 0;
const resources = new Map();
const pendingResources = new Map();
const resourceCosts = new WeakMap();
const rasterPoolKeys = new WeakMap();
const rasterPool = new Map();
const bufferReferences = new Map();
const cacheLimit = 128 * 1024 * 1024;
let cacheBytes = 0;
function metadataCost(resource) {
  if (!resourceCosts.has(resource)) resourceCosts.set(resource, 256 + (resource.paths || []).reduce((bytes, path) => bytes + 128 + String(path.d || '').length * 2, 0));
  return resourceCosts.get(resource);
}
function cost(resource) { return metadataCost(resource) + (resource.pixels?.buffer.byteLength || 0); }
function forget(key) {
  const resource = resources.get(key);
  if (!resource) return;
  cacheBytes -= metadataCost(resource);
  if (resource.pixels) {
    const buffer = resource.pixels.buffer, reference = bufferReferences.get(buffer);
    if (--reference.count === 0) {
      cacheBytes -= buffer.byteLength;
      bufferReferences.delete(buffer);
      for (const poolKey of reference.poolKeys) if (rasterPool.get(poolKey)?.buffer === buffer) rasterPool.delete(poolKey);
    }
  }
  resources.delete(key);
}
function remember(key, resource) {
  const bytes = cost(resource);
  if (bytes > cacheLimit) return;
  forget(key);
  resources.set(key, resource); cacheBytes += metadataCost(resource);
  if (resource.pixels) {
    const buffer = resource.pixels.buffer, poolKey = rasterPoolKeys.get(resource);
    if (!bufferReferences.has(buffer)) {
      bufferReferences.set(buffer, { count: 0, poolKeys: new Set() });
      cacheBytes += buffer.byteLength;
    }
    const reference = bufferReferences.get(buffer); reference.count++;
    if (poolKey) { reference.poolKeys.add(poolKey); rasterPool.set(poolKey, resource.pixels); }
  }
  while (cacheBytes > cacheLimit) {
    const oldest = resources.keys().next().value;
    forget(oldest);
  }
}
function decodeRaster(resource, document, content) {
  if (![resource.width, resource.height].every(n => Number.isSafeInteger(n) && n > 0 && n <= 32768)) throw new Error('画面资源像素尺寸不一致');
  const binary = atob(resource.pixelsBase64 || resource.pixels);
  if (resource.width * resource.height * 4 !== binary.length) throw new Error('画面资源像素尺寸不一致');
  let pixels;
  const source = resource.sourceAssetId || content.assetId;
  // Bounds and roles belong to individual resources. Only owner-checked, immutable pixel payloads share storage.
  if (typeof source === 'string' && source && typeof resource.hash === 'string' && /^[a-f0-9]{64}$/i.test(resource.hash)) {
    const poolKey = JSON.stringify([document.id, source, resource.hash.toLowerCase(), resource.width, resource.height]);
    const shared = rasterPool.get(poolKey);
    if (shared) {
      for (let i = 0; i < binary.length; i++) if (binary.charCodeAt(i) !== shared[i]) throw new Error('画面资源内容与不可变标识不一致');
      pixels = shared;
    }
    rasterPoolKeys.set(resource, poolKey);
  }
  if (!pixels) {
    pixels = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) pixels[i] = binary.charCodeAt(i);
  }
  resource.pixels = pixels;
  delete resource.pixelsBase64;
}
function modules() {
  return modulesPromise ||= Promise.all([
    import('/vendor/image2/core-1/render-graph.mjs'),
    import('/vendor/image2/core-1/render-software.mjs'),
  ]);
}
function engine() {
  if (!enginePromise) {
    importScripts('/vendor/image2/canvaskit-0.42.0/canvaskit.js');
    enginePromise = CanvasKitInit({ locateFile: name => `/vendor/image2/canvaskit-0.42.0/${name}` });
  }
  return enginePromise;
}
async function resolve(content, context, document, requestId) {
  const key = JSON.stringify([document.id, content.id, content.kind, content.assetId, context.role, context.layer.id, context.layer.localBounds]);
  if (sequence !== requestId) throw new Error('cancelled');
  if (resources.has(key)) {
    const resource = resources.get(key); resources.delete(key); resources.set(key, resource);
    return resource;
  }
  if (!pendingResources.has(key)) pendingResources.set(key, (async () => {
    try {
      const params = new URLSearchParams({ revision: String(document.revision), layerId: context.layer.id, role: context.role });
      const response = await fetch(`/api/v3/image2/documents/${encodeURIComponent(document.id)}/render-resource/${encodeURIComponent(content.id)}?${params}`, { credentials: 'same-origin' });
      const body = await response.json();
  if (!response.ok) throw new Error(body.detail || body.error?.message || (typeof body.error === 'string' ? body.error : '') || '画面资源不可用');
      const resource = body.data || body.resource || body;
      if (!resource || !['raster', 'paths'].includes(resource.kind)) throw new Error('画面资源格式不可用');
      if (resource.kind === 'raster') {
        decodeRaster(resource, document, content);
      } else if (!Array.isArray(resource.paths)) throw new Error('画面路径资源不可用');
      // Accepted immutable data can warm the cache even when its requesting frame was superseded.
      remember(key, resource);
      return resource;
    } finally { pendingResources.delete(key); }
  })());
  const resource = await pendingResources.get(key);
  if (sequence !== requestId) throw new Error('cancelled');
  return resource;
}
self.onmessage = async ({ data }) => {
  if (data.type === 'cancel') { sequence++; return; }
  if (data.type !== 'render') return;
  const requestId = ++sequence;
  try {
    const [[graphModule, softwareModule], kit] = await Promise.all([modules(), engine()]);
    if (sequence !== requestId) return;
    const graph = await graphModule.prepareRenderGraph(data.document, (content, context) => resolve(content, context, data.document, requestId), { bounds: data.bounds, maxResourcePixels: 40000000 });
    const frame = await softwareModule.renderSoftware(kit, graph, { bounds: data.bounds, pixelScale: data.pixelScale, maxPixels: 16000000, cancelled: () => sequence !== requestId });
    if (sequence !== requestId) return;
    const pixels = frame.pixels;
    self.postMessage({ type: 'frame', id: data.id, documentId: data.document.id, revision: data.document.revision, bounds: data.bounds, width: frame.width, height: frame.height, pixels: pixels.buffer, renderVersion: frame.renderVersion }, [pixels.buffer]);
  } catch (error) {
    if (sequence === requestId) self.postMessage({ type: 'error', id: data.id, message: String(error.message || error) });
  }
};
