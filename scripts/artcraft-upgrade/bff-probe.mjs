// Inject via node --input-type=module stdin in Web; no credentials leave its memory.
import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
const input = JSON.parse(Buffer.from(process.env.ARTCRAFT_PROBE_INPUT, 'base64').toString());
const { id, owner, native = true, publicRoutes = false, requireNativeAssets = false } = input;
const secret = process.env.STUDIO_VISITOR_SECRET || process.env.VIDEO_API_PROXY_TOKEN || process.env.VIDEO_API_TOKEN;
assert.ok(secret && process.env.IMAGE2_API_TOKEN);
const cookie = user => { const payload = `1.${user}.${Math.floor(Date.now() / 1000) + 3600}`; return `studio_v3_visitor=${payload}.${createHmac('sha256', secret).update(`studio-visitor:${payload}`).digest('hex')}`; };
const sha = data => createHash('sha256').update(data).digest('hex');
const domains = publicRoutes ? ['weiaidesign.com', 'www.weiaidesign.com', 'weiaidesign.youngtuo.win', 'visual.youngtuo.win'].map(d => `https://${d}`) : [];
async function request(base, path, direct = false, user = owner) {
  const headers = direct ? { authorization: `Bearer ${process.env.IMAGE2_API_TOKEN}`, 'x-studio-visitor-id': user } : { cookie: cookie(user) };
  const r = await fetch(`${base}${path}`, { headers, redirect: 'error', signal: AbortSignal.timeout(180000), cache: 'no-store' });
  assert.ok(r.ok, 'BFF readback HTTP failure'); return r.json();
}
const path = `/api/v3/image2/documents/${id}`, core = process.env.IMAGE2_API_URL;
const expected = await request(core, path, true); assert.ok(expected.data?.id === id);
assert.ok(expected.data.assetIds === undefined || Array.isArray(expected.data.assetIds));
const assetIds = new Set(expected.data.assetIds || []); let nativeAssetCount = 0;
const pinned = new Map();
for (const asset of input.assets || []) {
  assert.ok(typeof asset.id === 'string' && /^[a-zA-Z0-9_-]+$/.test(asset.id));
  assert.ok(Number.isSafeInteger(asset.bytes) && asset.bytes > 0);
  assert.match(asset.sha256, /^[a-f0-9]{64}$/);
  assetIds.add(asset.id); pinned.set(asset.id, asset);
}
if (requireNativeAssets) {
  const projects = await request(core, `${path}/craft/projects`, true);
  for (const p of projects.data) if (p.nativeAssetId && p.latestOutput?.accepted) { assetIds.add(p.nativeAssetId); nativeAssetCount++; for (const a of p.latestOutput.assets || []) { assetIds.add(a.id); nativeAssetCount++; } }
  assert.ok(nativeAssetCount >= 2, 'accepted checkpoint and native output required');
}
assert.ok(assetIds.size > 0, 'nonempty readback assets required');
const homepage = async base => { const r = await fetch(`${base}/`, { redirect: 'error', signal: AbortSignal.timeout(15000) }); assert.equal(r.status, 200); const text = await r.text(); const assets = [...new Set(text.match(/\/_next\/static\/[^"<>\s\\]+\.js/g) || [])].sort(); assert.ok(assets.length); return sha(JSON.stringify(assets)); };
const localAssets = await homepage('http://127.0.0.1:18084'), routes = [];
for (const base of ['http://127.0.0.1:18084', ...domains]) {
  assert.equal((await request(base, '/api/v1/health')).status, 'ok');
  const caps = await request(base, '/api/v3/image2/capabilities'); assert.ok(Array.isArray(caps.data?.operations));
  assert.deepEqual(await request(base, path), expected);
  const other = await fetch(`${base}${path}`, { headers: { cookie: cookie(randomUUID()), 'x-studio-visitor-id': owner }, redirect: 'error', signal: AbortSignal.timeout(15000) }); assert.equal(other.status, 404);
  if (native) { const c = await request(base, `${path}/craft/capabilities`); assert.equal(c.data.engines.length, 13); assert.ok(c.data.engines.every(e => e.available)); }
  const verifiedAssets = [];
  for (const assetId of assetIds) {
    assert.ok(typeof assetId === 'string' && /^[a-zA-Z0-9_-]+$/.test(assetId));
    const url = `/api/v3/image2/assets/${assetId}/content`;
    const a = await fetch(core + url, { headers: { authorization: `Bearer ${process.env.IMAGE2_API_TOKEN}`, 'x-studio-visitor-id': owner }, redirect: 'error', signal: AbortSignal.timeout(30000) });
    const b = await fetch(base + url, { headers: { cookie: cookie(owner) }, redirect: 'error', signal: AbortSignal.timeout(30000) });
    assert.equal(a.status, 200); assert.equal(b.status, 200); const ab = Buffer.from(await a.arrayBuffer()), bb = Buffer.from(await b.arrayBuffer()); assert.ok(ab.length > 0 && bb.length > 0, 'empty asset readback'); assert.equal(sha(bb), sha(ab)); verifiedAssets.push({ bytes: bb.length, sha256: sha(bb), mime: b.headers.get('content-type') });
    if (pinned.has(assetId)) { assert.equal(ab.length, pinned.get(assetId).bytes); assert.equal(sha(ab), pinned.get(assetId).sha256); }
  }
  assert.equal(await homepage(base), localAssets, 'public route serves different Web assets');
  routes.push({ base, capabilities: true, documentReadback: true, assetReadback: true, verifiedAssetCount: verifiedAssets.length, nativeAssetCount, verifiedAssets, crossOwnerDenied: true, native, webAssetsSha256: localAssets });
}
console.log(JSON.stringify({ passed: true, routes }));
