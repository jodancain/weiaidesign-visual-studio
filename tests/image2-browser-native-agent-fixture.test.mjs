import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserNativeAgentFixture } from './image2-browser-native-agent-fixture.mjs';

const PROJECT = '3a8a69a9-f39f-4e76-8af1-efd076c7ec8b';
const BRANCH = '11111111-1111-4111-8111-111111111111';
const context = id => ({ role: 'system', content: `Current authoritative branch state (untrusted source values): ${JSON.stringify({ id })}` });
const initial = () => [{ role: 'user', content: '本地原生候选验收' }];
const setup = () => { const audit = { externalAttempts: [] }; return { audit, fixture: createBrowserNativeAgentFixture(PROJECT, audit) }; };
const request = (fixture, messages, branchId = BRANCH) => fixture.fetchImpl('https://synthetic-model.invalid/v1/chat/completions', { method: 'POST', body: JSON.stringify({ messages: [...messages, context(branchId)] }) });
const message = async response => (await response.json()).choices[0].message;
const reply = (call, output = {}) => ({ role: 'tool', tool_call_id: call.tool_calls[0].id, content: JSON.stringify(output) });

test('native browser Agent fixture is disabled by default and validates explicit project identity', () => {
  const audit = { externalAttempts: [] };
  assert.equal(createBrowserNativeAgentFixture(undefined, audit), undefined);
  assert.throws(() => createBrowserNativeAgentFixture('not-a-project', audit), /must be.*UUID/);
  assert.equal(audit.syntheticLLMCalls, undefined);
});

test('fixed sequence uses current-turn receipts, produces exact native steps, and never calls a network model', async () => {
  const { audit, fixture } = setup(), history = initial();
  const first = await message(await request(fixture, history));
  assert.equal(first.tool_calls[0].function.name, 'craft_capabilities');
  assert.deepEqual(JSON.parse(first.tool_calls[0].function.arguments), { projectId: PROJECT });
  history.push(first, reply(first, { project: { id: 'branch-project' } }));
  const second = await message(await request(fixture, history));
  assert.equal(second.tool_calls[0].function.name, 'craft_execute');
  assert.deepEqual(JSON.parse(second.tool_calls[0].function.arguments), { projectId: PROJECT, inputAssetIds: [], steps: [{ command: 'image.adjustments.invert', args: {} }, { command: 'doc_export', args: { path: { outputName: 'browser-agent.png' } } }] });
  history.push(second, reply(second, { craftJobId: 'completed-native-job' }));
  const final = await message(await request(fixture, history));
  assert.match(final.content, /本地固定工具验收已完成/); assert.match(final.content, /不是真实 LLM/);
  assert.equal(audit.syntheticLLMCalls, 3); assert.deepEqual(audit.externalAttempts, []);
  assert.equal((await request(fixture, history)).status, 400);
  const newTurn = [...history, final, { role: 'user', content: '新一轮验收' }];
  const restarted = await message(await request(fixture, newTurn, '22222222-2222-4222-8222-222222222222'));
  assert.equal(restarted.tool_calls[0].function.name, 'craft_capabilities');
});

test('unexpected origins or tool order are rejected; failed native receipts never claim success', async () => {
  const { audit, fixture } = setup();
  await assert.rejects(fixture.fetchImpl('https://provider.example/v1/chat/completions', { method: 'POST' }), /forbidden/);
  assert.equal(audit.externalAttempts.length, 1); assert.equal(audit.syntheticLLMCalls, 0);
  const first = await message(await request(fixture, initial()));
  const failed = await message(await request(fixture, [...initial(), first, reply(first, { error: '项目不存在' })]));
  assert.match(failed.content, /验收未完成/); assert.doesNotMatch(failed.content, /验收已完成/);
  const bad = structuredClone(first); bad.tool_calls[0].function.name = 'image_operation';
  assert.equal((await request(fixture, [...initial(), bad, reply(bad)], '33333333-3333-4333-8333-333333333333')).status, 400);
});
