'use client';
import { useState } from 'react';

export type StudioAccessGateProps = { onAuthenticated: () => void | Promise<void> };

export default function StudioAccessGate({ onAuthenticated }: StudioAccessGateProps) {
  const [token, setToken] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  return <section aria-label="视频工作台访问门禁" style={{ width: 'min(420px, 90vw)', margin: '12vh auto', padding: 28, border: '1px solid #343b4b', borderRadius: 16, background: '#181c26', color: '#e4e6ef' }}>
    <h2 style={{ margin: '0 0 12px', fontSize: 20 }}>进入视频工作台</h2><p style={{ color: '#aab2c7', lineHeight: 1.6 }}>输入此安装的访问码以加载项目和媒体。</p>
    <form onSubmit={async event => { event.preventDefault(); if (busy || !token) return; setBusy(true); setError(''); try { const response = await fetch('/api/v3/session', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) }); const result = await response.json(); if (!response.ok) throw new Error(result.detail || '暂时无法验证访问码'); setToken(''); await onAuthenticated(); } catch (cause) { setError(cause instanceof Error ? cause.message : '暂时无法连接，请重试'); } finally { setBusy(false); } }}>
      <label style={{ display: 'block', marginBottom: 8 }}>安装访问码<input aria-label="安装访问码" type="password" autoComplete="current-password" value={token} onChange={event => setToken(event.target.value)} disabled={busy} required style={{ display: 'block', width: '100%', boxSizing: 'border-box', marginTop: 8, padding: 10, border: '1px solid #4b5368', borderRadius: 7, background: '#11151e', color: 'inherit' }} /></label>
      {error && <p role="alert" style={{ color: '#ffb6b6' }}>{error}</p>}<button type="submit" disabled={busy || !token} style={{ padding: '9px 18px', marginTop: 8, border: '1px solid #9c81d8', borderRadius: 7, background: '#443759', color: 'inherit', cursor: 'pointer' }}>{busy ? '正在验证…' : '进入工作台'}</button>
    </form>
  </section>;
}
