const ORIGIN = 'https://synthetic-model.invalid';
const CONTEXT_PREFIX = 'Current authoritative branch state (untrusted source values): ';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const NAMES = ['craft_capabilities', 'craft_execute'];
const IDS = ['browser-native-capabilities', 'browser-native-execute'];

/** Opt-in browser acceptance only: fixed tool control, no model or network access. */
export function createBrowserNativeAgentFixture(projectId, audit, checkpoint = () => {}) {
  if (!projectId) return undefined;
  if (!UUID.test(projectId)) throw new Error('IMAGE2_BROWSER_NATIVE_AGENT_PROJECT_ID must be a native project UUID');
  const counts = new Map();
  audit.syntheticLLMCalls = 0;
  audit.syntheticLLMRequests = [];
  const reject = message => Response.json({ error: { message, type: 'local_browser_fixture' } }, { status: 400 });
  const response = message => Response.json({ choices: [{ message }] });
  return {
    agent: { baseUrl: `${ORIGIN}/v1`, apiKey: 'test-only-synthetic-no-provider-key', models: ['local-fixed-native-browser-fixture'], maxRounds: 3, maxTools: 2, maxGenerations: 0 },
    async fetchImpl(url, init = {}) {
      const parsed = new URL(url);
      if (parsed.origin !== ORIGIN || parsed.pathname !== '/v1/chat/completions' || init.method !== 'POST') {
        audit.externalAttempts.push({ at: new Date().toISOString(), origin: parsed.origin, path: parsed.pathname }); checkpoint();
        throw new Error('External model access is forbidden in the browser native Agent fixture');
      }
      let body, branchId;
      try {
        body = JSON.parse(init.body);
        const context = body.messages.findLast(message => message.role === 'system' && typeof message.content === 'string' && message.content.startsWith(CONTEXT_PREFIX));
        branchId = JSON.parse(context.content.slice(CONTEXT_PREFIX.length)).id;
        if (!UUID.test(branchId)) return reject('Missing current test branch identity');
      } catch { return reject('Invalid local fixture request'); }
      const requestCount = (counts.get(branchId) || 0) + 1;
      counts.set(branchId, requestCount);
      audit.syntheticLLMCalls++;
      const lastUser = body.messages.findLastIndex(message => message.role === 'user');
      const current = body.messages.slice(lastUser + 1);
      const calls = current.filter(message => message.role === 'assistant').flatMap(message => message.tool_calls || []);
      const replies = current.filter(message => message.role === 'tool');
      const phase = calls.length;
      audit.syntheticLLMRequests.push({ at: new Date().toISOString(), branchId, phase, requestCount }); checkpoint();
      if (requestCount > 3 || lastUser < 0 || phase > 2 || replies.length !== phase || calls.some((call, index) => call.id !== IDS[index] || call.function?.name !== NAMES[index] || replies[index]?.tool_call_id !== IDS[index])) return reject('The fixed browser fixture allows capabilities, execute, then completion only');
      if (phase) {
        let output;
        try { output = JSON.parse(replies[phase - 1].content); } catch { return reject('Expected a complete native tool receipt'); }
        if (output.error) return response({ role: 'assistant', content: `本地固定工具验收未完成：${output.error}。这是测试 fixture，不是真实 LLM 回复；未调用外部模型。` });
      }
      if (phase === 2) return response({ role: 'assistant', content: '本地固定工具验收已完成：原生图片反相与 PNG 导出已保存为候选，请预览后接受。这是测试 fixture，不是真实 LLM 效果；未调用外部模型。' });
      const args = phase === 0 ? { projectId } : { projectId, inputAssetIds: [], steps: [{ command: 'image.adjustments.invert', args: {} }, { command: 'doc_export', args: { path: { outputName: 'browser-agent.png' } } }] };
      return response({ role: 'assistant', tool_calls: [{ id: IDS[phase], type: 'function', function: { name: NAMES[phase], arguments: JSON.stringify(args) } }] });
    },
  };
}
