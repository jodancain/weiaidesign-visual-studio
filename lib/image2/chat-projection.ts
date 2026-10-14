import type { ConversationMessage } from './types';

/** Internal receipts may contain old host paths; never expose them in chat or result details. */
export function displayToolText(value: string): string {
  const root = String.raw`(?:file:\/\/\/|\/(?:Users|home|tmp|private|var|data|opt|root|workspace|workspaces|app|srv|mnt)\/|[A-Za-z]:[\\/])`;
  if (new RegExp(`^${root}`).test(value)) return '[内部文件]';
  // A quoted path may contain spaces. Process it before the unquoted fallback.
  return value
    .replace(new RegExp(`(["'\x60])${root}[^\\n\\r]*?\\1`, 'g'), '$1[内部文件]$1')
    .replace(new RegExp(`(?<![A-Za-z0-9:])${root}[^\\s"'\x60<>，。；！？）)\\]}]+`, 'g'), '[内部文件]');
}

export interface DisplayConversationMessage { id: string; role: 'user' | 'assistant'; text: string; error?: boolean }

/** Keep the durable log intact; only human conversation and readable failures enter the chat UI. */
export function projectConversationMessages(messages: ConversationMessage[]): DisplayConversationMessage[] {
  return messages.flatMap<DisplayConversationMessage>(message => {
    const text = String(message.text || message.content || '');
    if (message.role === 'user' || message.role === 'assistant') {
      return text.trim() ? [{ id: message.id, role: message.role, text: message.role === 'user' ? text : displayToolText(text) }] : [];
    }
    if (message.role !== 'tool') return [];
    try {
      const receipt = JSON.parse(text);
      if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) || !receipt.error) return [];
      const error = typeof receipt.error === 'string' ? receipt.error : typeof receipt.error.message === 'string' ? receipt.error.message : '操作未完成，请查看任务结果。';
      const code = typeof receipt.code === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(receipt.code) ? `（${receipt.code}）` : '';
      return [{ id: message.id, role: 'assistant', text: `工具执行失败${code}：${displayToolText(error)}`, error: true }];
    } catch { return []; }
  });
}
