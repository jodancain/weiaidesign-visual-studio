import { test, expect } from './studio-test';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const out = resolve(process.env.STUDIO_PLACEMENT_EVIDENCE || '../output/studio-v3-integrity-20261001/placement/green');
test('consecutive director captures remain separately clickable and restore their frame/camera after reload', async ({ page, request }) => {
  await mkdir(out, { recursive: true });
  const source = await readFile(resolve('components/studio/StudioWorkspace.tsx'));
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const created = await request.post('/api/v3/projects', { data: { name: `截图布局 integrity-${Date.now()}`, demo: true } });
  expect(created.ok()).toBeTruthy(); let project = (await created.json()).data;
  project.nodes = []; project.edges = []; project.shots = [];
  const scene = project.scenes[0]; scene.cameras = [scene.cameras[0], { ...structuredClone(scene.cameras[0]), id: crypto.randomUUID(), name: '布局恢复机位二', position: [-4, 2.5, 6] }];
  scene.cameras[0].name = '布局恢复机位一';
  const saved = await request.put(`/api/v3/projects/${project.id}`, { data: { baseRevision: project.revision, project } });
  expect(saved.ok(), await saved.text()).toBeTruthy();
  const getProject = async () => (await (await request.get(`/api/v3/projects/${project.id}`)).json()).data;
  await page.goto(`/video/studio?project=${project.id}`);
  await page.getByRole('button', { name: '导演台', exact: true }).click();
  const director = page.getByRole('dialog', { name: '三维导演台' });
  await expect(director.locator('canvas')).toBeVisible({ timeout: 30000 });
  await expect(director.locator('.sd-stage-status')).not.toContainText('加载');
  const expected = [{ frame: 11, mode: 'static', cameraId: scene.cameras[0].id, name: '布局恢复机位一' }, { frame: 37, mode: 'dynamic', cameraId: scene.cameras[1].id, name: '布局恢复机位二' }];
  for (const [index, capture] of expected.entries()) {
    await director.getByRole('button', { name: capture.name, exact: true }).click();
    await director.getByLabel('静态或动态编辑').selectOption(capture.mode);
    await director.getByLabel('播放位置').fill(String(capture.frame));
    await director.getByRole('button', { name: '保存当前镜头', exact: true }).click();
    await expect.poll(async () => (await getProject()).nodes.filter((node: any) => node.type === 'image' && node.assetId).length, { timeout: 30000 }).toBe(index + 1);
    await expect(page.locator('main.studio-root')).not.toHaveAttribute('inert');
  }
  project = await getProject();
  const cards = project.nodes.filter((node: any) => node.type === 'image');
  expect(cards).toHaveLength(2);
  for (const [index, card] of cards.entries()) {
    const asset = project.assets.find((item: any) => item.id === card.assetId);
    expect(asset.metadata.frame).toBe(expected[index].frame); expect(asset.metadata.cameraId).toBe(expected[index].cameraId); expect(asset.metadata.mode).toBe(expected[index].mode);
  }
  await director.getByRole('button', { name: '返回画布', exact: true }).click();
  const layout = async () => {
    await page.getByRole('button', { name: 'Fit View', exact: true }).click();
    await page.waitForTimeout(350);
    return page.evaluate((ids: string[]) => ids.map(id => { const node = document.querySelector(`.react-flow__node[data-id="${id}"]`)!; const rect = node.getBoundingClientRect(), x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
      return { id, x: rect.x, y: rect.y, width: rect.width, height: rect.height, center: { x, y }, hitNode: document.elementFromPoint(x, y)?.closest('.react-flow__node')?.getAttribute('data-id') || null }; }), cards.map((node: any) => node.id));
  };
  const positions = await layout(), [a, b] = positions;
  const overlap = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  await page.mouse.click(a.center.x, a.center.y);
  // Raw mouse dispatch does not await React's selection commit; retain the same semantic assertion after bounded settling.
  await expect.poll(() => page.locator('.react-flow__node.selected').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-id'))), { timeout: 3000 }).toContain(cards[0].id).catch(() => {});
  const clicked = await page.locator('.react-flow__node.selected').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-id')));
  const evidence = { at: new Date().toISOString(), projectId: project.id, sourceSha256: createHash('sha256').update(source).digest('hex'), cards, expected, positions, overlapArea: overlap, oldCardCenterClickSelectedIds: clicked, errors };
  await writeFile(resolve(out, 'placement-evidence.json'), JSON.stringify(evidence, null, 2));
  await page.screenshot({ path: resolve(out, 'consecutive-captures.png') });
  expect(overlap, 'new capture must not overlap the old image card').toBe(0);
  expect(positions.map(p => p.hitNode), 'each image center must hit its own semantic node').toEqual(cards.map((node: any) => node.id));
  expect(clicked).toContain(cards[0].id);
  const restores = [];
  for (const reload of [false, true]) {
    if (reload) { await page.reload(); await expect(page.locator('.studio-project-trigger')).toHaveText(project.name); }
    for (const [index, card] of cards.entries()) {
      const current = await layout(), point = current[index];
      expect(point.hitNode).toBe(card.id);
      await page.mouse.click(point.center.x, point.center.y);
      await expect(page.locator(`.react-flow__node[data-id="${card.id}"]`)).toHaveClass(/selected/);
      await expect(page.locator('.studio-inspector select')).toHaveValue(card.assetId);
      await page.getByRole('button', { name: '回到此帧圈选 3D 对象', exact: true }).click();
      await expect(director).toBeVisible(); await expect(director.getByLabel('播放位置')).toHaveValue(String(expected[index].frame));
      await expect(director.getByLabel('静态或动态编辑')).toHaveValue(expected[index].mode);
      await expect(director.locator('.sd-camera-row.active')).toHaveText(expected[index].name);
      restores.push({ reload, assetId: card.assetId, ...expected[index] });
      await director.getByRole('button', { name: '返回画布', exact: true }).click();
    }
  }
  await writeFile(resolve(out, 'placement-restores.json'), JSON.stringify({ projectId: project.id, restores, errors }, null, 2));
  await page.screenshot({ path: resolve(out, 'captures-after-refresh.png') }); expect(errors).toEqual([]);
});
