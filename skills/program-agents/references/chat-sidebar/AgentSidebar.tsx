import * as React from 'react';
import { consumeNativeSSE, initialSidebarState, object, prependHistory, reduceFrame, SIDEBAR_LIMITS, transcriptRows, utf8Bytes, type DisplayBlock, type PageContext, type SidebarState } from './protocol.js';
import type { ConversationReceipt, SessionPage } from '@tkellogg/dsh-program-agents/app';
import './agent-sidebar.css';

export interface AgentSidebarProps {
  /** Same-origin API path. With a Vite dev proxy, proxy this path to your app backend. */
  basePath?: string;
  title?: string;
  /** Called ONLY when the human submits a new message; never from an effect or render loop. */
  getPageContext?: () => PageContext | undefined;
}
type Connection = 'idle' | 'loading' | 'connected' | 'disconnected' | 'error';
type Pending = { requestId: string; text: string; outcome: 'sending' | 'accepted' | 'unknown' | 'rejected'; messageId?: string };
const headers = { 'X-Agent-Sidebar': '1' };
function apiPath(basePath: string): string {
  if (!/^\/[A-Za-z0-9/_-]+$/.test(basePath) || basePath.endsWith('/')) throw new Error('AgentSidebar requires a same-origin absolute API path');
  return basePath;
}
function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('Cancelled', 'AbortError')); return; }
    const done = () => { signal.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(done, milliseconds);
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new DOMException('Cancelled', 'AbortError')); };
    signal.addEventListener('abort', abort, { once: true });
  });
}
function Blocks({ blocks, showReasoning }: { blocks: readonly DisplayBlock[]; showReasoning: boolean }) {
  return <>{blocks.map((block, index) => {
    if (block.type === 'reasoning') return showReasoning ? <details key={index}><summary>Model-provided reasoning (if available)</summary><pre>{block.text}</pre></details> : null;
    if (block.type === 'tool-call') return <details key={index}><summary>Tool: {block.name}</summary><pre>{block.arguments}</pre></details>;
    return <p key={index}>{block.text}</p>;
  })}</>;
}

/** App-owned sidebar only: does not modify DSH's composer or full conversation renderer. */
export function AgentSidebar({ basePath = '/api/assistant', title = 'App assistant', getPageContext }: AgentSidebarProps) {
  const api = apiPath(basePath);
  const [state, setState] = React.useState(initialSidebarState);
  const stateRef = React.useRef<SidebarState>(state);
  const contextRef = React.useRef(getPageContext); contextRef.current = getPageContext;
  const [activated, setActivated] = React.useState(false);
  const [generation, setGeneration] = React.useState(0);
  const [connection, setConnection] = React.useState<Connection>('idle');
  const [error, setError] = React.useState('');
  const [text, setText] = React.useState('');
  const [pending, setPending] = React.useState<Pending[]>([]);
  const [sending, setSending] = React.useState(false);
  const [loadingHistory, setLoadingHistory] = React.useState(false);
  const [showReasoning, setShowReasoning] = React.useState(false);
  const mounted = React.useRef(false);
  const controllers = React.useRef(new Set<AbortController>());
  const commit = (next: SidebarState) => { stateRef.current = next; if (mounted.current) setState(next); };
  React.useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; for (const controller of controllers.current) controller.abort(); controllers.current.clear(); };
  }, []);
  React.useEffect(() => {
    if (!activated) return;
    const abort = new AbortController();
    controllers.current.add(abort);
    let attempt = 0;
    const run = async () => {
      while (!abort.signal.aborted) {
        if (mounted.current) setConnection(attempt === 0 ? 'loading' : 'disconnected');
        try {
          const response = await fetch(`${api}/events`, { headers, credentials: 'same-origin', signal: abort.signal, redirect: 'error' });
          await consumeNativeSSE(response, frame => {
            if (abort.signal.aborted) return;
            commit(reduceFrame(stateRef.current, frame));
            if (frame.type === 'snapshot') { attempt = 0; setConnection('connected'); setError(''); }
          }, abort.signal);
          if (!abort.signal.aborted) throw new Error('Assistant stream ended');
        } catch {
          if (abort.signal.aborted) break;
          attempt++;
          if (mounted.current) { setConnection('disconnected'); setError('Disconnected. Reconnecting for a fresh history snapshot; messages are never automatically retried.'); }
          try { await wait(Math.min(30_000, 500 * 2 ** Math.min(attempt - 1, 6)) + Math.random() * 250, abort.signal); }
          catch { break; }
        }
      }
    };
    void run();
    return () => { abort.abort(); controllers.current.delete(abort); };
  }, [api, activated, generation]);

  const request = async (path: string, init: RequestInit): Promise<Response> => {
    const abort = new AbortController(); controllers.current.add(abort);
    const timer = setTimeout(() => abort.abort(), 30_000);
    try {
      const response = await fetch(`${api}${path}`, { ...init, credentials: 'same-origin', redirect: 'error', signal: abort.signal, headers: { ...headers, ...init.headers } });
      // Keep the deadline/unmount signal alive through the JSON body, not only headers.
      const reader = response.body?.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let body = ''; let bytes = 0;
      if (reader) try {
        for (;;) {
          const item = await reader.read(); if (item.done) break;
          bytes += item.value.byteLength;
          if (bytes > SIDEBAR_LIMITS.frameBytes) throw new Error('Assistant response exceeds limit');
          body += decoder.decode(item.value, { stream: true });
        }
        body += decoder.decode();
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      return new Response(body, { status: response.status, headers: response.headers });
    } finally { clearTimeout(timer); controllers.current.delete(abort); }
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!text.trim() || sending) return;
    // Serialize now, before sending: later app renders cannot mutate this turn's snapshot.
    let body: string; const requestId = crypto.randomUUID(); const sentText = text;
    try {
      const context = contextRef.current?.();
      body = JSON.stringify({ text: sentText, requestId, ...(context === undefined ? {} : { context }) });
      if (utf8Bytes(body) > SIDEBAR_LIMITS.requestBytes) throw new Error('Message plus context exceeds 32 KiB');
      if (context && utf8Bytes(JSON.stringify(context.state)) > SIDEBAR_LIMITS.stateBytes) throw new Error('Page state exceeds 16 KiB');
    } catch {
      setConnection('error'); setError('Cannot send: the current page snapshot must be JSON, at most 16 KiB, and the complete request at most 32 KiB.'); return;
    }
    setActivated(true); setSending(true); setError(''); setText('');
    setPending(items => [...items, { requestId, text: sentText, outcome: 'sending' as const }].slice(-50));
    let definitelyRejected = false;
    try {
      const response = await request('/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      definitelyRejected = response.status >= 400 && response.status < 500;
      if (!response.ok) throw new Error('Send failed');
      const receipt: unknown = await response.json();
      if (!object(receipt) || receipt.requestId !== requestId || typeof receipt.messageId !== 'string') throw new Error('Invalid receipt');
      if (mounted.current) setPending(items => items.map(item => item.requestId === requestId ? { ...item, outcome: 'accepted', messageId: (receipt as unknown as ConversationReceipt).messageId } : item));
    } catch {
      if (mounted.current) {
        setPending(items => items.map(item => item.requestId === requestId ? { ...item, outcome: definitelyRejected ? 'rejected' : 'unknown' } : item));
        setError(definitelyRejected ? 'The backend rejected this message. Review the page context and app authorization.' : 'Send outcome unknown: keep the request ID below, reconnect, and inspect history before deciding whether to resend. Reusing an ID does not guarantee deduplication.');
      }
    } finally { if (mounted.current) setSending(false); }
  };
  const older = async () => {
    if (loadingHistory || !state.hasMore || !state.records.length) return;
    const throughSeq = state.throughSeq; const beforeSeq = state.records[0]!.seq;
    setLoadingHistory(true);
    try {
      const response = await request(`/history?throughSeq=${throughSeq}&beforeSeq=${beforeSeq}&maxMessages=20`, { method: 'GET' });
      if (!response.ok) throw new Error('History unavailable');
      const page = await response.json() as SessionPage;
      if (!Array.isArray(page.records) || typeof page.hasMore !== 'boolean') throw new Error('Invalid history');
      if (mounted.current) commit(prependHistory(stateRef.current, page, throughSeq));
    } catch { if (mounted.current) setError('Could not load older history. Reconnect if the transcript window is full.'); }
    finally { if (mounted.current) setLoadingHistory(false); }
  };
  const interrupt = async () => {
    try {
      const response = await request('/interrupt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (!response.ok) throw new Error('Interrupt unavailable');
    } catch { if (mounted.current) setError('Interrupt outcome unknown. Inspect the live status; external effects are not undone.'); }
  };
  const rows = transcriptRows(state);
  const unmatched = pending.filter(item => !rows.some(row => row.messageId === item.messageId && item.messageId !== undefined || row.requestId === item.requestId));
  return <aside className="agent-sidebar" aria-label={title}>
    <header><h2>{title}</h2><span className="agent-sidebar__status" role="status">{connection === 'connected' ? state.status : connection}</span></header>
    <div className="agent-sidebar__controls">
      <button type="button" onClick={() => { setActivated(true); setGeneration(value => value + 1); }}>{activated ? 'Reconnect / inspect history' : 'Open chat'}</button>
      <button type="button" disabled={connection !== 'connected' || state.status !== 'running'} onClick={() => { void interrupt(); }}>Interrupt</button>
      <label><input type="checkbox" checked={showReasoning} onChange={event => setShowReasoning(event.target.checked)} />Show model-provided reasoning</label>
    </div>
    {error && <p className="agent-sidebar__error" role="alert">{error}</p>}
    <div className="agent-sidebar__feed" aria-label="Conversation history" aria-busy={connection === 'loading'}>
      {state.hasMore && <button type="button" disabled={loadingHistory} onClick={() => { void older(); }}>{loadingHistory ? 'Loading history…' : 'Load older history'}</button>}
      {!rows.length && <p>{activated ? 'Waiting for the conversation snapshot…' : 'Idle. Open chat or send a message to create or resume this app’s assistant.'}</p>}
      {rows.map(row => <article key={row.key} className={`agent-sidebar__row agent-sidebar__row--${row.role}`}><strong>{row.role}{row.transient ? ' · streaming' : ''}</strong><Blocks blocks={row.blocks} showReasoning={showReasoning} /></article>)}
      {unmatched.map(item => <article key={item.requestId} className="agent-sidebar__row agent-sidebar__row--user"><strong>You · {item.outcome}</strong><p>{item.text}</p><small>Request ID: {item.requestId}</small></article>)}
    </div>
    <form onSubmit={event => { void submit(event); }}>
      <label htmlFor="app-assistant-message">Message</label>
      <textarea id="app-assistant-message" value={text} onChange={event => setText(event.target.value)} rows={3} maxLength={24_000} placeholder="Ask about this page…" />
      <button type="submit" disabled={sending || !text.trim()}>{sending ? 'Sending…' : 'Send'}</button>
      <small>Only a snapshot at Send is shared. Chat does not continuously watch your page.</small>
    </form>
  </aside>;
}
