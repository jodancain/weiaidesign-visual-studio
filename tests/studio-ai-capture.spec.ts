import { test, expect, type Page, type APIRequestContext } from './studio-test';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

const out = resolve(process.env.STUDIO_AI_CAPTURE_EVIDENCE || '../output/studio-v3-integrity-20261001/media/a02-ui-contract/green');
const prompt = '只把选中的方块颜色改成 #f26b38，世界X增加0.20米；保留其他对象、属性、相机和动画。参考绑定的灰模截图，整次编辑应可一次撤销。';
type RequestRecord = { method: string; url: string; body: Record<string, unknown>; blockedBeforeNetwork: true };

async function setup(page: Page, request: APIRequestContext) {
  await mkdir(out, { recursive: true });
  const captured: RequestRecord[] = [], errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  // Never synthesize AI success or let these contract checks reach a provider.
  await page.route('**/api/v3/**/ai', async route => {
    captured.push({ method: route.request().method(), url: route.request().url(), body: route.request().postDataJSON(), blockedBeforeNetwork: true });
    await route.abort('blockedbyclient');
  });
  const created = await request.post('/api/v3/projects', { data: { name: `AI screenshot UI contract ${Date.now()}`, demo: false } });
  expect(created.ok()).toBeTruthy(); let project = (await created.json()).data;
  const scene = project.scenes[0], cubeId = randomUUID(), sphereId = randomUUID();
  const object = (id: string, name: string, kind: string, x: number, color: string) => ({ id, name, kind, color, visible: true, locked: false, transform: { position: [x, .5, 0], rotation: [0, 0, 0, 1], scale: [.8, .8, .8] } });
  scene.objects = [object(cubeId, '限定方块', 'box', -.85, '#aeb4bd'), object(sphereId, '保持不变球体', 'sphere', .85, '#34b477')];
  scene.tracks = []; scene.clips = [];
  scene.cameras = [{ id: scene.cameras[0].id, name: '截图绑定机位', position: [0, 1.7, 5], target: [0, .5, 0], focalLength: 35, sensorWidth: 36 }, { id: randomUUID(), name: '另一个机位', position: [4, 2, 5], target: [0, .5, 0], focalLength: 35, sensorWidth: 36 }];
  scene.activeCameraId = scene.cameras[0].id; project.nodes = []; project.edges = []; project.shots = []; project.sequence.clips = [];
  const saved = await request.put(`/api/v3/projects/${project.id}`, { data: { baseRevision: project.revision, project } }); expect(saved.ok(), await saved.text()).toBeTruthy();
  const get = async () => (await (await request.get(`/api/v3/projects/${project.id}`)).json()).data;
  await page.goto(`/video/studio?project=${project.id}`);
  await page.getByRole('button', { name: '导演台', exact: true }).click();
  const panel = page.getByRole('dialog', { name: '三维导演台' });
  await expect(panel.locator('canvas')).toBeVisible({ timeout: 30000 }); await expect(panel.locator('.sd-stage-status')).not.toContainText('加载');
  await panel.getByRole('button', { name: '截图绑定机位', exact: true }).click(); await panel.getByLabel('静态或动态编辑').selectOption('static'); await panel.getByLabel('播放位置').fill('0');
  await panel.getByRole('button', { name: '保存当前镜头', exact: true }).click();
  await expect.poll(async () => (await get()).nodes.filter((node: any) => node.type === 'image' && node.assetId).length, { timeout: 30000 }).toBe(1);
  await expect(page.locator('main.studio-root')).not.toHaveAttribute('inert');
  project = await get(); const node = project.nodes.find((node: any) => node.type === 'image'), asset = project.assets.find((asset: any) => asset.id === node.assetId);
  expect(asset.metadata.provenance).toBe('three-scene-capture'); expect(asset.metadata.objectIds).toEqual([cubeId, sphereId]);
  await panel.getByRole('button', { name: '返回画布', exact: true }).click();
  async function openCapture() {
    const card = page.locator(`.react-flow__node[data-id="${node.id}"]`); await expect(card).toBeVisible(); await card.click(); await expect(card).toHaveClass(/selected/);
    await expect(page.locator('.studio-inspector select')).toHaveValue(asset.id);
    await page.getByRole('button', { name: '回到此帧圈选 3D 对象', exact: true }).click(); await expect(panel).toBeVisible();
    await expect(panel.getByLabel('播放位置')).toHaveValue('0'); await expect(panel.getByLabel('静态或动态编辑')).toHaveValue('static'); await expect(panel.locator('.sd-camera-row.active')).toHaveText('截图绑定机位');
    await expect(panel.getByText(/已引用截图/)).toBeVisible();
    await expect(panel.locator('.sd-stage-status')).not.toContainText('加载');
  }
  async function boxSelectCube() {
    await panel.getByRole('button', { name: '框选', exact: true }).click(); const rect = (await panel.locator('.sd-shotframe').boundingBox())!;
    await page.mouse.move(rect.x + rect.width * .18, rect.y + rect.height * .18); await page.mouse.down(); await page.mouse.move(rect.x + rect.width * .45, rect.y + rect.height * .60, { steps: 15 }); await page.mouse.up();
    await expect(panel.locator('.sd-tree-row.active')).toHaveAttribute('data-object-id', cubeId);
  }
  async function send() { await panel.getByLabel('AI编辑选中对象').fill(prompt); await panel.getByRole('button', { name: '应用 AI 修改', exact: true }).click(); await expect(panel.getByRole('alert')).toBeVisible(); await expect(panel.getByLabel('AI编辑选中对象')).toHaveValue(prompt); }
  async function evidence(name: string, details: Record<string, unknown>) {
    const source = await readFile(resolve('components/studio/StudioWorkspace.tsx'));
    await page.screenshot({ path: resolve(out, `${name}.png`) });
    await writeFile(resolve(out, `${name}.json`), JSON.stringify({ at: new Date().toISOString(), projectId: project.id, baseURL: new URL(page.url()).origin, sourceSHA256: createHash('sha256').update(source).digest('hex'), cubeId, nodeId: node.id, assetId: asset.id, metadata: asset.metadata, captured, errors, actualProviderCalls: 0, ...details }, null, 2));
  }
  return { panel, get, project, cubeId, node, asset, captured, errors, openCapture, boxSelectCube, send, evidence };
}

test('capture entry sends the visible object selection and bound image; ordinary director entry sends no image', async ({ page, request }) => {
  const f = await setup(page, request); await f.openCapture(); await f.boxSelectCube(); const before = await f.get(); await f.send();
  await expect.poll(() => f.captured.length).toBe(1);
  await f.evidence('bound-request', { beforeRevision: before.revision, afterRevision: (await f.get()).revision });
  expect(f.captured[0].body).toMatchObject({ selectionIds: [f.cubeId], selectedNodeIds: [f.node.id], scope: 'scene', frame: 0, mode: 'static', partSelection: [], cameraId: f.asset.metadata.cameraId, shotView: true });
  expect(await f.get()).toEqual(before);
  await f.panel.getByRole('button', { name: '返回画布', exact: true }).click();
  await expect(page.locator(`.react-flow__node[data-id="${f.node.id}"]`)).toHaveClass(/selected/);
  await page.getByRole('button', { name: '导演台', exact: true }).click(); await f.panel.locator(`.sd-tree-row[data-object-id="${f.cubeId}"] button`).first().click(); await f.send();
  await expect.poll(() => f.captured.length).toBe(2); expect(f.captured[1].body).toMatchObject({ selectionIds: [f.cubeId], selectedNodeIds: [], scope: 'scene' });
  expect(await f.get()).toEqual(before); expect(f.errors).toEqual([]); await f.evidence('ordinary-entry', { fullProjectUnchanged: true });
});

test('changing frame mode camera or observation view blocks the screenshot-bound AI request before networking', async ({ page, request }) => {
  const f = await setup(page, request), checks: Record<string, unknown>[] = [];
  for (const change of ['frame', 'mode', 'camera', 'observation'] as const) {
    await f.openCapture(); await f.boxSelectCube();
    if (change === 'frame') await f.panel.getByLabel('播放位置').fill('1');
    if (change === 'mode') await f.panel.getByLabel('静态或动态编辑').selectOption('dynamic');
    if (change === 'camera') await f.panel.getByRole('button', { name: '另一个机位', exact: true }).click();
    if (change === 'observation') await f.panel.getByRole('button', { name: '镜头视角', exact: true }).click();
    await f.send(); const error = await f.panel.getByRole('alert').innerText();
    expect(error).toMatch(/截图|参考图|灰模/); expect(error).toMatch(/重新|不一致|变更|过期/); expect(f.captured).toHaveLength(0);
    checks.push({ change, error, apiRequests: 0 }); await f.evidence(`blocked-${change}`, { checks });
    await f.panel.getByRole('button', { name: '返回画布', exact: true }).click();
  }
  expect(f.errors).toEqual([]); await f.evidence('context-mismatches', { checks });
});

test('editing the scene invalidates its bound screenshot and blocks both sending and reopening', async ({ page, request }) => {
  const f = await setup(page, request); await f.openCapture(); await f.boxSelectCube();
  const name = f.panel.getByLabel('名称', { exact: true }); await name.fill('已修改版本方块'); await name.press('Enter');
  await expect.poll(async () => (await f.get()).scenes[0].objects[0].name).toBe('已修改版本方块'); await expect(page.locator('main.studio-root')).not.toHaveAttribute('inert');
  const fresh = await f.get(); expect(fresh.scenes[0].revision).toBeGreaterThan(f.asset.metadata.sceneRevision);
  await f.send(); const error = await f.panel.getByRole('alert').innerText(); expect(error).toMatch(/截图|参考图|灰模/); expect(error).toMatch(/重新|不一致|变更|过期/); expect(f.captured).toHaveLength(0);
  await f.evidence('blocked-scene-revision', { error, currentSceneRevision: fresh.scenes[0].revision });
  await f.panel.getByRole('button', { name: '返回画布', exact: true }).click(); await page.locator(`.react-flow__node[data-id="${f.node.id}"]`).click();
  await page.getByRole('button', { name: '回到此帧圈选 3D 对象', exact: true }).click(); await expect(f.panel).not.toBeVisible(); await expect(page.locator('.studio-toast[role=alert]')).toContainText('已变更');
  expect(f.captured).toHaveLength(0); expect(f.errors).toEqual([]); await f.evidence('blocked-reopen', { currentSceneRevision: fresh.scenes[0].revision });
});

test('changing project aspect invalidates the screenshot even when scene revision is unchanged', async ({ page, request }) => {
  const f = await setup(page, request); await page.getByLabel('画面比例').selectOption('9:16');
  await expect.poll(async () => (await f.get()).aspect).toBe('9:16');
  const fresh = await f.get(); expect(fresh.scenes[0].revision).toBe(f.asset.metadata.sceneRevision);
  await page.locator(`.react-flow__node[data-id="${f.node.id}"]`).click(); await expect(page.locator('.studio-inspector select')).toHaveValue(f.asset.id);
  await page.getByRole('button', { name: '回到此帧圈选 3D 对象', exact: true }).click();
  await expect(f.panel).not.toBeVisible(); await expect(page.locator('.studio-toast[role=alert]')).toContainText('项目画幅与引用截图不一致');
  expect(f.captured).toHaveLength(0); expect(f.errors).toEqual([]);
  await f.evidence('blocked-aspect', { currentAspect: fresh.aspect, screenshotAspect: f.asset.metadata.aspect, sceneRevisionUnchanged: true });
});

test('first capture remains measurable and clickable through selection changes and real save replies', async ({ page, request }) => {
  const f = await setup(page, request), card = page.locator(`.react-flow__node[data-id="${f.node.id}"]`), rounds = [];
  // No fitView, reload, forced click, or artificial dimensions: preserve the original hidden-card trigger.
  await expect(card).toBeVisible();
  for (let round = 0; round < 5; round++) {
    await card.click(); await expect(card).toHaveClass(/selected/);
    const label = `保存后仍可见 ${round}`; await page.locator('.studio-inspector').getByLabel('名称', { exact: true }).fill(label);
    await expect.poll(async () => (await f.get()).nodes.find((node: any) => node.id === f.node.id)?.label).toBe(label);
    await expect(card).toBeVisible();
    const pane = (await page.locator('.react-flow__pane').boundingBox())!; await page.mouse.click(pane.x + 120, pane.y + 180); await expect(card).not.toHaveClass(/selected/);
    await expect(card).toBeVisible(); await card.click(); await expect(card).toHaveClass(/selected/);
    const measurement = await card.evaluate(element => ({ visibility: getComputedStyle(element).visibility, width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height }));
    expect(measurement.visibility).toBe('visible'); expect(measurement.width).toBeGreaterThan(0); expect(measurement.height).toBeGreaterThan(0);
    rounds.push({ round, label, measurement });
  }
  expect(f.captured).toHaveLength(0); expect(f.errors).toEqual([]); await f.evidence('node-measurement-persistence', { rounds, originalHiddenStateNotBypassed: true });
});
