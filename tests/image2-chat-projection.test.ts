import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { displayToolText, projectConversationMessages } from '../lib/image2/chat-projection';
import { CraftStructuredResult } from '../components/image2/CraftToolsDialog';
import { craftJobStatus, type CraftJob } from '../lib/image2/craft-client';

test('persistent chat projects human messages without successful tool receipts or system prompts', () => {
  const messages = [
    { id: 'u', role: 'user', text: '把图案反色，再导出。' },
    { id: 't', role: 'tool', text: JSON.stringify({ output: { path: '/Users/person/project/native/file.pcraft' } }) },
    { id: 's', role: 'system', text: 'internal tool instructions' },
    { id: 'a', role: 'assistant', content: '已生成候选，请核对。' },
    { id: 'empty', role: 'assistant', text: '' },
  ];
  const snapshot = structuredClone(messages);
  assert.deepEqual(projectConversationMessages(messages), [
    { id: 'u', role: 'user', text: messages[0].text },
    { id: 'a', role: 'assistant', text: messages[3].content },
  ]);
  assert.deepEqual(messages, snapshot, 'projection never deletes the durable tool log');
});

test('tool failures remain readable with their code while internal file paths are redacted', () => {
  const projected = projectConversationMessages([
    { id: 'fail', role: 'tool', text: JSON.stringify({ error: "Cannot open '/Users/person/My Project/native/file.pcraft': damaged file", code: 'native_open_failed' }) },
    { id: 'nested', role: 'tool', text: JSON.stringify({ error: { message: '字体不可用' } }) },
    { id: 'broken', role: 'tool', text: '{internal receipt truncated' },
  ]);
  assert.equal(projected.length, 2); assert.equal(projected[0].error, true);
  assert.match(projected[0].text, /native_open_failed/); assert.match(projected[0].text, /damaged file/);
  assert.doesNotMatch(projected[0].text, /Users|My Project|file\.pcraft/); assert.match(projected[1].text, /字体不可用/);
});

test('old native structured result details do not expose host paths or alter ordinary URLs', () => {
  for (const path of ['/Users/person/My Project/file.pcraft', '/tmp/work/file.svg', '/var/lib/private/file', 'C:\\Users\\person\\file.png', 'file:///home/person/file']) {
    const html = renderToStaticMarkup(createElement(CraftStructuredResult, { value: { path } }));
    assert.doesNotMatch(html, /Users|My Project|\/tmp\/|\/var\/|\/home\//);
    assert.match(html, /内部文件/);
  }
  assert.equal(displayToolText('https://example.com/data/file.png'), 'https://example.com/data/file.png');
  assert.equal(displayToolText('workspace:/exports/result.png'), 'workspace:/exports/result.png');
  assert.equal(displayToolText('中文文本、导出失败'), '中文文本、导出失败');
  for (const quote of ['"', "'", '`']) {
    assert.equal(displayToolText(`无法打开 ${quote}/Users/person/My Project/input.svg${quote}，请重试`), `无法打开 ${quote}[内部文件]${quote}，请重试`);
  }
});

test('native branch acceptance labels distinguish reviewed task branches from the main document', () => {
  const complete: CraftJob = { id: 'job', documentId: 'branch', projectId: 'native', state: 'complete', accepted: true, progress: 1 };
  assert.equal(craftJobStatus(complete, true), '待整组接受');
  assert.equal(craftJobStatus(complete), '已接受');
  assert.equal(craftJobStatus({ ...complete, accepted: false }, true), '待整组接受');
  assert.equal(craftJobStatus({ ...complete, accepted: false, state: 'failed' }, true), '执行失败');
});
