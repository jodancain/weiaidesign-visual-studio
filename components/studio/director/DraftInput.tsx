'use client';
import { useEffect, useRef, useState, type InputHTMLAttributes } from 'react';

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'onBlur' | 'onKeyDown'> & { value: string | number; onCommit: (value: string) => unknown | Promise<unknown> };

/** Keep incomplete numbers and typed text local; a field confirmation is one undoable command. */
export default function DraftInput({ value, onCommit, type = 'text', ...props }: Props) {
  const source = String(value), [draft, setDraft] = useState(source), [message, setMessage] = useState('');
  const dirty = useRef(false), base = useRef(source), latest = useRef(source), pending = useRef(false), composing = useRef(false); latest.current = source;
  useEffect(() => { if (!dirty.current) { setDraft(source); base.current = source; setMessage(''); } else if (!pending.current && source !== base.current) setMessage('值已更新；Enter 应用当前输入，Esc 采用新值'); }, [source]);
  const reset = () => { dirty.current = false; setDraft(latest.current); base.current = latest.current; setMessage(''); };
  const commit = async (explicit: boolean) => {
    if (!dirty.current || pending.current || composing.current) return;
    if (!explicit && latest.current !== base.current) { setMessage('值已更新；Enter 应用当前输入，Esc 采用新值'); return; }
    if (props.required && !draft.trim()) { setMessage('此项不能为空'); return; }
    if (type === 'number' || type === 'range') { const number = Number(draft); if (!draft.trim() || !Number.isFinite(number) || (props.min !== undefined && number < Number(props.min)) || (props.max !== undefined && number > Number(props.max))) { setMessage('请输入范围内的有效数值'); return; } }
    if (draft === latest.current) return reset(); pending.current = true; setMessage('');
    try { const result = await onCommit(draft); if (result === false) { setMessage('保存失败，输入已保留；Enter 重试'); return; } dirty.current = false; base.current = latest.current; setDraft(latest.current); }
    catch { setMessage('保存失败，输入已保留；Enter 重试'); }
    finally { pending.current = false; }
  };
  return <span className="sd-draft-field"><input {...props} type={type} value={draft} aria-invalid={!!message} title={message || props.title || 'Enter 确认，Esc 取消；离开输入框也会保存'} onFocus={() => { if (!dirty.current) base.current = latest.current; }} onChange={event => { dirty.current = true; setDraft(event.target.value); setMessage(''); }} onBlur={() => void commit(false)} onPointerUp={type === 'range' ? () => void commit(true) : undefined} onKeyUp={type === 'range' ? () => void commit(true) : undefined} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={event => { if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return; if (event.key === 'Enter') { event.preventDefault(); void commit(true); } else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); reset(); } }} />{message && <small role="alert">{message}</small>}</span>;
}
