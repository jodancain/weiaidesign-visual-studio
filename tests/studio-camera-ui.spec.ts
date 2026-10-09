import { test, expect, type APIRequestContext, type Page } from './studio-test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const out = resolve(process.cwd(), process.env.STUDIO_EVIDENCE_DIR || '../output/studio-v3-integrity-20261001/web');

async function openProject(page: Page, request: APIRequestContext, aspect: '16:9' | '9:16') {
  const created = await request.post('/api/v3/projects', { data: { name: `INTEGRITY camera ${aspect}`, demo: true } });
  expect(created.ok()).toBeTruthy(); const project = (await created.json()).data;
  project.aspect = aspect; const camera = project.scenes[0].cameras[0];
  Object.assign(camera, { position: [4, 3, 8], target: [1, 1.8, -2], focalLength: 75, sensorWidth: 36 });
  const saved = await request.put(`/api/v3/projects/${project.id}`, { data: { baseRevision: project.revision, project } });
  expect(saved.ok(), await saved.text()).toBeTruthy();
  const get = async () => (await (await request.get(`/api/v3/projects/${project.id}`)).json()).data;
  await page.goto(`/video/studio?project=${project.id}`); await page.getByRole('button', { name: '导演台', exact: true }).click();
  const panel = page.getByRole('dialog', { name: '三维导演台' }); await expect(panel.locator('canvas')).toBeVisible();
  await expect(panel.locator('.sd-stage-status')).not.toContainText('加载');
  await expect.poll(async () => { const box = await panel.locator('canvas').boundingBox(); return box ? box.width / box.height : 0; }).toBeCloseTo(aspect === '16:9' ? 16 / 9 : 9 / 16, 2);
  return { project, camera, get, panel };
}

for (const aspect of ['16:9', '9:16'] as const) test(`saving a selected ${aspect} camera retains its real target and focal length through reload`, async ({ page, request }) => {
  await mkdir(out, { recursive: true }); const { project, camera, get, panel } = await openProject(page, request, aspect);
  await panel.locator('.sd-camera-row').first().click();
  const before = (await get()).scenes[0].cameras.length;
  await panel.getByRole('button', { name: '＋保存新机位', exact: true }).click();
  await expect.poll(async () => (await get()).scenes[0].cameras.length).toBe(before + 1);
  const added = (await get()).scenes[0].cameras.at(-1);
  await writeFile(resolve(out, `camera-${aspect.replace(':', '-')}-save.json`), JSON.stringify({ projectId: project.id, expected: camera, actual: added }, null, 2));
  expect(added.position).toEqual(camera.position);
  for (let i = 0; i < 3; i++) expect(added.target[i]).toBeCloseTo(camera.target[i], 8);
  expect(added.focalLength).toBeCloseTo(75, 8); expect(added.sensorWidth).toBe(36);
  await page.reload(); await page.getByRole('button', { name: '导演台', exact: true }).click();
  await panel.getByRole('button', { name: added.name, exact: true }).click();
  await expect(panel.getByLabel('焦距 mm', { exact: true })).toHaveValue('75');
  // Reopening mounts a fresh R3F canvas. Its initial intrinsic 300x150 bounds
  // precede the viewport ResizeObserver; require the real project aperture.
  await expect.poll(async () => {
    const box = await panel.locator('canvas').boundingBox();
    return box && box.width > 100 && box.height > 100 ? box.width / box.height : 0;
  }, { timeout: 15000 }).toBeCloseTo(aspect === '16:9' ? 16 / 9 : 9 / 16, 2);
  await page.screenshot({ path: resolve(out, `camera-${aspect.replace(':', '-')}-after.png`) });
  await panel.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => (await get()).scenes[0].cameras.length).toBe(before);
  await expect(panel.locator('.sd-camera-row.active')).toHaveCount(1);
  await panel.getByRole('button', { name: '重做', exact: true }).click();
  await expect.poll(async () => (await get()).scenes[0].cameras.length).toBe(before + 1);
  expect((await get()).scenes[0].cameras.at(-1)).toEqual(added);
});

test('panned observation capture persists its own camera and differs from selected-camera capture', async ({ page, request }) => {
  await mkdir(out, { recursive: true }); const { project, camera, get, panel } = await openProject(page, request, '9:16');
  await panel.getByRole('button', { name: '环视', exact: true }).click();
  const canvas = (await panel.locator('canvas').boundingBox())!;
  expect(canvas.width / canvas.height).toBeCloseTo(9 / 16, 2);
  await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
  await page.mouse.down({ button: 'right' }); await page.mouse.move(canvas.x + canvas.width / 2 + 45, canvas.y + canvas.height / 2 - 30, { steps: 10 }); await page.mouse.up({ button: 'right' });
  await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
  await page.mouse.down(); await page.mouse.move(canvas.x + canvas.width / 2 + 30, canvas.y + canvas.height / 2, { steps: 10 }); await page.mouse.up();
  await page.waitForTimeout(500);
  const originalCount = (await get()).scenes[0].cameras.length;
  const observationStarted = Date.now();
  await panel.getByRole('button', { name: '保存观察视角', exact: true }).click();
  await expect.poll(async () => (await get()).assets.filter((a: any) => a.metadata?.captureView === 'observation').length, { timeout: 30000 }).toBe(1);
  const observationPersistMs = Date.now() - observationStarted;
  let saved = await get(); const observed = saved.assets.find((a: any) => a.metadata?.captureView === 'observation'), observedCamera = saved.scenes[0].cameras.find((c: any) => c.id === observed.metadata.cameraId);
  expect(saved.scenes[0].cameras).toHaveLength(originalCount + 1);
  expect(observedCamera.target).not.toEqual([0, 1, 0]); expect(observedCamera.id).not.toBe(camera.id);
  expect(observed.metadata.width).toBe(720); expect(observed.metadata.height).toBe(1280);
  expect(observed.metadata.sceneRevision).toBe(saved.scenes[0].revision);
  expect(observed.metadata.camera.position).toEqual(observedCamera.position);
  // Upload commits the asset before addNode's debounced project save. Wait for
  // the complete capture card to persist before testing reload restoration.
  await expect.poll(async () => (await get()).nodes.some((node: any) => node.assetId === observed.id), { timeout: 30000 }).toBe(true);
  saved = await get();
  await expect(page.locator('main.studio-root')).not.toHaveAttribute('inert');
  await panel.getByRole('button', { name: '返回画布', exact: true }).click();
  await page.reload();
  const captureNode = saved.nodes.find((node: any) => node.assetId === observed.id); await page.getByRole('button', { name: 'Fit View', exact: true }).click(); await page.locator(`.react-flow__node[data-id="${captureNode.id}"]`).click();
  await page.getByRole('button', { name: '回到此帧圈选 3D 对象', exact: true }).click();
  await expect(panel).toBeVisible(); await expect(panel.getByRole('button', { name: observedCamera.name, exact: true })).toHaveClass(/active/);
  await panel.locator('.sd-camera-row').first().click();
  const selectedStarted = Date.now();
  await panel.getByRole('button', { name: '保存当前镜头', exact: true }).click();
  await expect.poll(async () => (await get()).assets.filter((a: any) => a.metadata?.captureView === 'selected-camera').length, { timeout: 30000 }).toBe(1);
  const selectedPersistMs = Date.now() - selectedStarted;
  saved = await get(); const selected = saved.assets.find((a: any) => a.metadata?.captureView === 'selected-camera');
  await expect.poll(async () => (await get()).nodes.some((node: any) => node.assetId === selected.id), { timeout: 30000 }).toBe(true);
  expect(selected.metadata.cameraId).toBe(camera.id); expect(selected.metadata.camera.focalLength).toBeCloseTo(75, 8);
  expect(observed.metadata.camera.matrixWorld).not.toEqual(selected.metadata.camera.matrixWorld);
  expect(observed.hash).not.toEqual(selected.hash);
  await writeFile(resolve(out, 'camera-observation-capture.json'), JSON.stringify({ projectId: project.id, observationPersistMs, selectedPersistMs, observedCamera, observation: observed.metadata, selected: selected.metadata }, null, 2));
  await page.screenshot({ path: resolve(out, 'camera-observation-restored.png') });
});

test('failed new-camera save preserves the current selection and reports the failure', async ({ page, request }) => {
  const { get, panel } = await openProject(page, request, '16:9'); await panel.locator('.sd-camera-row').first().click();
  const before = (await get()).scenes[0].cameras;
  await page.route('**/commands', route => route.fulfill({ status: 503, json: { detail: 'camera test unavailable' } }));
  await panel.getByRole('button', { name: '＋保存新机位', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('camera test unavailable');
  expect((await get()).scenes[0].cameras).toEqual(before);
  await expect(panel.locator('.sd-camera-row.active')).toHaveCount(1);
  await expect(panel.getByLabel('焦距 mm', { exact: true })).toHaveValue('75');
});
