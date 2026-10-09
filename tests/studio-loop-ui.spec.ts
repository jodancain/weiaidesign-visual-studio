import { test, expect } from './studio-test';

test('a slow renderer capability probe does not block opening or saving a project', async ({ page, request }) => {
  const project = (await (await request.post('/api/v3/projects', { data: { name: '渲染服务慢响应仍可编辑', demo: false } })).json()).data;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/v3/capabilities', async route => { await gate; await route.continue(); });
  try {
    await page.goto(`/video/studio?project=${project.id}`);
    await expect(page.locator('.studio-project-trigger')).toHaveText(project.name);
    await page.getByRole('button', { name: '文本', exact: true }).click();
    await page.locator('.studio-inspector textarea').fill('等待渲染能力时仍可保存');
    await expect(page.locator('.studio-save-status')).toContainText('已保存');
    const saved = (await (await request.get(`/api/v3/projects/${project.id}`)).json()).data;
    expect(saved.nodes.some((node: any) => node.text === '等待渲染能力时仍可保存')).toBe(true);
  } finally { release(); }
});

test('a delayed startup response cannot replace a project created while loading', async ({ page, request }) => {
  const old = (await (await request.post('/api/v3/projects', { data: { name: '慢速初始化项目', demo: false } })).json()).data;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let seen = false;
  await page.route(`**/api/v3/projects/${old.id}`, async route => {
    if (route.request().method() === 'GET' && !seen) { seen = true; await gate; }
    await route.continue();
  });
  await page.goto(`/video/studio?project=${old.id}`);
  await expect.poll(() => seen).toBe(true);
  await page.locator('.studio-project-trigger').click();
  await page.getByRole('button', { name: '新建空白项目', exact: true }).click();
  await expect(page.locator('.studio-project-trigger')).toHaveText('未命名项目');
  const createdId = await page.evaluate(() => localStorage.getItem('studio-v3-last-project'));
  expect(createdId).not.toBe(old.id);
  release();
  await expect(page.locator('.studio-loading')).toHaveCount(0);
  // Observe the late HTTP response, not just the newly created project's brief render.
  await expect.poll(() => page.locator('.studio-project-trigger').textContent()).toBe('未命名项目');
  await page.waitForTimeout(300);
  await expect(page.locator('.studio-project-trigger')).toHaveText('未命名项目');
  expect(new URL(page.url()).searchParams.get('project')).toBe(createdId);
  await page.reload();
  await expect(page.locator('.studio-project-trigger')).toHaveText('未命名项目');
});

test('leaving while an autosave is in flight retains the unsaved-change warning', async ({ page, request }) => {
  const project = (await (await request.post('/api/v3/projects', { data: { name: '保存中离开保护', demo: false } })).json()).data;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let seen = false;
  await page.route(`**/api/v3/projects/${project.id}`, async route => {
    if (route.request().method() === 'PUT' && !seen) { seen = true; await gate; }
    await route.continue();
  });
  await page.goto(`/video/studio?project=${project.id}`);
  await page.getByRole('button', { name: '文本', exact: true }).click();
  await page.locator('.studio-inspector textarea').fill('等待服务器确认的草稿');
  await expect.poll(() => seen).toBe(true);
  const pending = await page.evaluate(id => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return { warned: event.defaultPrevented, draft: localStorage.getItem(`studio-v3-draft:${id}`) };
  }, project.id);
  release();
  await expect(page.locator('.studio-save-status')).toContainText('已保存');
  expect(pending.draft).toContain('等待服务器确认的草稿');
  expect(pending.warned).toBe(true);
  expect(await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; })).toBe(false);
});

test('switching and creating projects keeps refresh bound to the visible project', async ({ page, request }) => {
  const suffix = Date.now();
  const create = async (name: string) => (await (await request.post('/api/v3/projects', { data: { name, demo: false } })).json()).data;
  const first = await create(`循环验收 A ${suffix}`), second = await create(`循环验收 B ${suffix}`);
  await page.goto(`/video/studio?project=${first.id}&mode=test`);
  await expect(page.locator('.studio-project-trigger')).toHaveText(first.name);
  await page.locator('.studio-project-trigger').click();
  await page.locator('.studio-project-menu').getByRole('button', { name: second.name, exact: true }).click();
  await expect(page.locator('.studio-project-trigger')).toHaveText(second.name);
  await page.reload();
  await expect(page.locator('.studio-project-trigger')).toHaveText(second.name);
  expect(new URL(page.url()).searchParams.get('project')).toBe(second.id);
  expect(new URL(page.url()).searchParams.get('mode')).toBe('test');
  await page.locator('.studio-project-trigger').click();
  await page.getByRole('button', { name: '新建空白项目', exact: true }).click();
  await expect(page.locator('.studio-project-trigger')).toHaveText('未命名项目');
  const createdId = new URL(page.url()).searchParams.get('project');
  expect(createdId).not.toBe(second.id);
  await page.reload();
  await expect(page.locator('.studio-project-trigger')).toHaveText('未命名项目');
  expect(new URL(page.url()).searchParams.get('project')).toBe(createdId);
});

test('a failed autosave preserves the newest draft and can be retried without losing text', async ({ page, request }) => {
  const project = (await (await request.post('/api/v3/projects', { data: { name: '失败重试验收', demo: false } })).json()).data;
  let rejectWrites = true;
  await page.route(`**/api/v3/projects/${project.id}`, async route => {
    if (route.request().method() === 'PUT' && rejectWrites) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ detail: 'isolated connection failure' }) });
    return route.continue();
  });
  await page.goto(`/video/studio?project=${project.id}`);
  await page.getByRole('button', { name: '文本', exact: true }).click();
  await page.locator('.studio-inspector textarea').fill('网络失败时的最新文字，必须保留。');
  await expect(page.locator('.studio-save-status')).toContainText('保存失败');
  const draft = await page.evaluate(id => JSON.parse(localStorage.getItem(`studio-v3-draft:${id}`) || '{}'), project.id);
  expect(draft.nodes.some((node: any) => node.text === '网络失败时的最新文字，必须保留。')).toBe(true);
  rejectWrites = false;
  await page.locator('.studio-inspector textarea').fill('恢复连接后的最终文字，不得被旧请求覆盖。');
  await expect(page.locator('.studio-save-status')).toContainText('已保存');
  await page.reload();
  await expect(page.locator('.studio-card-text')).toContainText('恢复连接后的最终文字，不得被旧请求覆盖。');
  expect(await page.evaluate(id => localStorage.getItem(`studio-v3-draft:${id}`), project.id)).toBeNull();
});

test('seeking during sequence playback pauses on the requested frame and replay starts at zero', async ({ page, request }) => {
  const project = (await (await request.post('/api/v3/projects', { data: { name: '播放拖轴验收', demo: true } })).json()).data;
  await page.goto(`/video/studio?project=${project.id}`);
  await page.locator('.studio-topbar').getByRole('button', { name: '时间线', exact: true }).click();
  const timeline = page.getByRole('region', { name: '成片时间线' });
  await timeline.getByTitle('播放', { exact: true }).click();
  await page.waitForTimeout(400);
  await timeline.getByTitle('最后一帧', { exact: true }).click();
  await page.waitForTimeout(300);
  await expect(timeline.locator('.studio-timecode')).toHaveText('00:09:23 / 00:10:00');
  await expect(timeline.getByTitle('播放', { exact: true })).toBeVisible();
  await timeline.getByTitle('播放', { exact: true }).click();
  await expect(timeline.getByTitle('暂停', { exact: true })).toBeVisible();
  await page.waitForTimeout(200);
  await expect(timeline.locator('.studio-timecode')).toContainText('00:00:');
  await timeline.getByTitle('第一帧', { exact: true }).click();
  await page.waitForTimeout(200);
  await expect(timeline.locator('.studio-timecode')).toHaveText('00:00:00 / 00:10:00');
  await expect(timeline.getByTitle('播放', { exact: true })).toBeVisible();
});
