import { test, expect } from './studio-test';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

test('anonymous ownership survives refresh, media needs no browser bearer, and another anonymous visitor cannot read the project', async ({ page, request, browser }) => {
  const directory = resolve(process.cwd(), process.env.STUDIO_EVIDENCE_DIR || '../output/studio-v3-validation-20261001'); await mkdir(directory, { recursive: true });
  const created = await request.post('/api/v3/projects', { data: { name: '匿名归属页面独立验收', demo: true } }); expect(created.ok()).toBeTruthy(); const project = (await created.json()).data;
  const uploaded = await request.post(`/api/v3/projects/${project.id}/assets`, { data: { name: 'anonymous-owner-pixel.png', kind: 'image', mime: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=' } }); expect(uploaded.ok()).toBe(true); const asset = (await uploaded.json()).data.asset;
  const browserAuth: boolean[] = []; page.on('request', req => { if (req.url().includes('/api/v3/')) browserAuth.push(!!req.headers().authorization); });
  await page.goto(`/video/studio?project=${project.id}`); await expect(page.getByRole('button', { name: project.name, exact: true })).toBeVisible();
  await expect(page.getByLabel('安装访问码')).toHaveCount(0);
  const signed = (await page.context().cookies()).find(cookie => cookie.name === 'studio_v3_visitor'); expect(!!signed?.httpOnly).toBe(true);
  expect(await page.evaluate(() => document.cookie.includes('studio_v3_visitor'))).toBe(false);
  if (new URL(page.url()).protocol === 'https:') expect(signed?.secure).toBe(true);
  expect(signed?.sameSite).toBe('Strict'); expect(signed?.path).toBe('/api/v3');
  await page.reload(); await expect(page.getByRole('button', { name: project.name, exact: true })).toBeVisible();
  const restoredCookie = (await page.context().cookies()).find(cookie => cookie.name === 'studio_v3_visitor');
  const fingerprint = (value: string) => createHash('sha256').update(value).digest('hex');
  expect(Boolean(signed && restoredCookie)).toBe(true);
  const identityBefore = fingerprint(signed!.value.split('.')[1] || ''), identityAfter = fingerprint(restoredCookie!.value.split('.')[1] || '');
  expect(identityAfter).toBe(identityBefore); expect(restoredCookie!.expires).toBeGreaterThanOrEqual(signed!.expires);
  const cookieEvidence = signed ? { name: signed.name, domain: signed.domain, path: signed.path, httpOnly: signed.httpOnly, secure: signed.secure, sameSite: signed.sameSite, expiresBefore: signed.expires, expiresAfter: restoredCookie!.expires, valueSha256Before: fingerprint(signed.value), valueSha256After: fingerprint(restoredCookie!.value), identitySha256: identityBefore, refreshSameIdentity: true } : null;
  const decoded = await page.evaluate(async url => { const image = new Image(); image.src = url; await image.decode(); return { width: image.naturalWidth, height: image.naturalHeight }; }, asset.url); expect(decoded).toEqual({ width: 1, height: 1 });
  const jobs = await page.evaluate(async id => (await fetch(`/api/v3/projects/${id}/jobs`)).status, project.id); expect(jobs).toBe(200);
  const other = await browser.newContext({ baseURL: new URL(page.url()).origin });
  try {
    expect((await other.request.get('/api/v3/session')).ok()).toBe(true);
    expect((await other.request.get(`/api/v3/projects/${project.id}`)).status()).toBe(404);
    expect((await other.request.get(`/api/v3/projects/${project.id}/jobs`)).status()).toBe(404);
    expect((await other.request.get(asset.url)).status()).toBe(404);
    const own = await other.request.post('/api/v3/projects', { data: { name: '第二位匿名访客', demo: false } }); expect(own.ok()).toBe(true); const theirs = (await own.json()).data;
    expect((await request.get(`/api/v3/projects/${theirs.id}`)).status()).toBe(404);
  } finally { await other.close(); }
  expect(browserAuth.some(Boolean)).toBe(false);
  await page.screenshot({ path: `${directory}/studio-anonymous-owner.png` }); await writeFile(`${directory}/studio-access-ui-evidence.json`, JSON.stringify({ projectId: project.id, cookie: cookieEvidence, origin: new URL(page.url()).origin, anonymous: true, httpOnly: true, refreshRestored: true, crossVisitorReadStatus: 404, browserBearerSent: false, jobsStatus: jobs, assetDecoded: decoded, otherVisitorAssetStatus: 404 }, null, 2));
});

test('configured public demo stays readonly while copying creates an editable owned project', async ({ page, request }) => {
  const demos = await request.get('/api/v3/demos'); expect(demos.ok()).toBeTruthy();
  const demo = (await demos.json()).data[0]; if (process.env.STUDIO_REQUIRE_PUBLIC_DEMO === '1') expect(demo, 'deployment requires an explicitly public demo').toBeTruthy(); test.skip(!demo, 'No explicitly allowlisted public demo exists in this environment');
  await page.goto(`/video/studio?project=${demo.id}`);
  await expect(page.getByRole('button', { name: '复制为我的工程', exact: true })).toBeVisible();
  const original = (await (await request.get(`/api/v3/projects/${demo.id}`)).json()).data;
  expect(original.access).toEqual({ readOnly: true, canCopy: true });
  expect((await request.put(`/api/v3/projects/${demo.id}`, { data: { baseRevision: original.revision, project: { ...original, name: 'must reject' } } })).status()).toBe(403);
  await page.getByRole('button', { name: '复制为我的工程', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('project')).not.toBe(demo.id);
  const copyId = new URL(page.url()).searchParams.get('project')!;
  const copy = (await (await request.get(`/api/v3/projects/${copyId}`)).json()).data; expect(copy.access?.readOnly).not.toBe(true);
  const saved = await request.put(`/api/v3/projects/${copyId}`, { data: { baseRevision: copy.revision, project: { ...copy, name: '属于我的示例副本' } } }); expect(saved.ok()).toBe(true);
  const after = (await (await request.get(`/api/v3/projects/${demo.id}`)).json()).data;
  // Legitimate background renders may append immutable assets and advance the
  // revision while a visitor copies the demo. Its authored content must remain unchanged.
  expect(after.revision).toBeGreaterThanOrEqual(original.revision);
  for (const key of ['name', 'aspect', 'fps', 'totalFrames', 'nodes', 'edges', 'scenes', 'shots', 'sequence']) expect(after[key], `source demo ${key} is unchanged`).toEqual(original[key]);
  await page.reload(); await expect(page.getByRole('button', { name: '属于我的示例副本', exact: true })).toBeVisible();
});
