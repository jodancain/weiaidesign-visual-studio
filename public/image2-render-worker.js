/* Shared software renderer. Runtime and core are copied from pinned local dependencies. */
let enginePromise;
let modulesPromise;
let sequence = 0;
const resources = new Map();
const pendingResources = new Map();
const resourceCosts = new WeakMap();
const cacheLimit = 128 * 1024 * 1024;
let cacheBytes = 0;
function cost(resource) {
  if (!resourceCosts.has(resource)) resourceCosts.set(resource, 256 + (resource.pixels?.byteLength || 0) + (resource.paths || []).reduce((bytes, path) => bytes + 128 + String(path.d || '').length * 2, 0));
  return resourceCosts.get(resource);
}
function remember(key, resource) {
  const bytes = cost(resource);
  if (bytes > cacheLimit) return;
  if (resources.has(key)) cacheBytes -= cost(resources.get(key));
  resources.delete(key); resources.set(key, resource); cacheBytes += bytes;
  while (cacheBytes > cacheLimit) {
    const oldest = resources.keys().next().value;
    cacheBytes -= cost(resources.get(oldest)); resources.delete(oldest);
  }
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
        const binary = atob(resource.pixelsBase64 || resource.pixels);
        resource.pixels = Uint8Array.from(binary, char => char.charCodeAt(0));
        delete resource.pixelsBase64;
        if (![resource.width, resource.height].every(n => Number.isSafeInteger(n) && n > 0 && n <= 32768) || resource.width * resource.height * 4 !== resource.pixels.byteLength) throw new Error('画面资源像素尺寸不一致');
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
