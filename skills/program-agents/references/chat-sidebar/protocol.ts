// Browser-safe: all SDK imports are types; no bridge client or Node builtins here.
import type { ConversationFrame, JsonValue, SessionFollowFrame, SessionPage } from '@tkellogg/dsh-program-agents/app';

export type NativeFrame = SessionFollowFrame;
export type NativeEvent = Extract<NativeFrame, { type: 'event' }>['event'];
type Snapshot = Extract<NativeFrame, { type: 'snapshot' }>;
export type PageContext = { revision?: string | number; state: JsonValue };
export const SIDEBAR_LIMITS = Object.freeze({ requestBytes: 32 * 1024, stateBytes: 16 * 1024, frameBytes: 512 * 1024, records: 1000, liveCharacters: 256 * 1024 });
export type DisplayBlock = { type: 'text' | 'reasoning'; text: string } | { type: 'tool-call'; id: string; name: string; arguments: string };
export interface LiveAttempt {
  attemptId: string; turn: number; step: number; startedAfterSeq: number; nextIndex: number;
  blocks: Readonly<Record<number, DisplayBlock>>;
}
export interface SidebarState {
  sessionId?: string;
  /** Fixed pagination cut from the most recent snapshot, not the moving live cursor. */
  throughSeq: number;
  cursor: number;
  records: readonly NativeEvent[];
  hasMore: boolean;
  streamRevision: number;
  active?: LiveAttempt;
  status: 'idle' | 'running';
  /** Native ask receipts are correlation, not an exactly-once guarantee. */
  receipts: Readonly<Record<string, string>>;
}
export const initialSidebarState = (): SidebarState => ({ throughSeq: -1, cursor: -1, records: [], hasMore: false, streamRevision: 0, status: 'idle', receipts: {} });
export function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
export function utf8Bytes(value: string): number { return new TextEncoder().encode(value).byteLength; }

/** Deterministic JSON data only. Useful for app-side revision fingerprints, NOT instructions. */
export function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 32) throw new Error('JSON is too deeply nested');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(item => canonicalJson(item, depth + 1)).join(',') + ']';
  if (object(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(value[key], depth + 1)).join(',') + '}';
  }
  throw new Error('Expected plain JSON data');
}

function block(value: unknown): DisplayBlock | undefined {
  if (!object(value)) return;
  if ((value.type === 'text' || value.type === 'reasoning') && typeof value.text === 'string') return { type: value.type, text: value.text };
  if (value.type === 'tool-call' && typeof value.id === 'string' && typeof value.name === 'string' && typeof value.arguments === 'string') return { type: value.type, id: value.id, name: value.name, arguments: value.arguments };
}
/** Native text-delta uses text, not delta; block-end replaces accumulated text. */
function foldChunk(blocks: Readonly<Record<number, DisplayBlock>>, value: unknown): Readonly<Record<number, DisplayBlock>> {
  if (!object(value) || !Number.isSafeInteger(value.index) || (value.index as number) < 0) return blocks;
  const index = value.index as number;
  if (index > 1024) throw new Error('Too many stream blocks; reconnect');
  const previous = blocks[index];
  let next: DisplayBlock | undefined;
  if ((value.type === 'text-delta' || value.type === 'reasoning-delta') && typeof value.text === 'string') {
    const type = value.type === 'text-delta' ? 'text' : 'reasoning';
    next = { type, text: (previous?.type === type ? previous.text : '') + value.text };
  } else if (value.type === 'tool-call-delta' && typeof value.id === 'string' && typeof value.argumentsDelta === 'string') {
    next = { type: 'tool-call', id: value.id, name: typeof value.name === 'string' ? value.name : previous?.type === 'tool-call' ? previous.name : 'Tool', arguments: (previous?.type === 'tool-call' ? previous.arguments : '') + value.argumentsDelta };
  } else if (value.type === 'block-end') next = block(value.block);
  if (!next) return blocks;
  const result = { ...blocks, [index]: next };
  if (Object.values(result).reduce((size, item) => size + (item.type === 'tool-call' ? item.arguments.length + item.name.length : item.text.length), 0) > SIDEBAR_LIMITS.liveCharacters) throw new Error('Live output limit reached; reconnect');
  return result;
}

/** Native snapshot.stream is compact, unlike live chunk frames. Do not render it as deltas. */
function expandCompact(records: readonly unknown[]): unknown[] {
  const result: unknown[] = [];
  for (const record of records) {
    if (!object(record)) throw new Error('Invalid compact stream record');
    if (record.type === 'chunk') result.push(record.chunk);
    else if ((record.type === 'text-chunks' || record.type === 'reasoning-chunks') && Array.isArray(record.texts)) {
      for (const text of record.texts) result.push({ type: record.type === 'text-chunks' ? 'text-delta' : 'reasoning-delta', index: record.index, text });
    } else if (record.type === 'tool-call-chunks' && Array.isArray(record.args)) {
      for (const argumentsDelta of record.args) result.push({ type: 'tool-call-delta', index: record.index, id: record.id, name: record.name, argumentsDelta });
    } else throw new Error('Unknown compact stream record; update the reference');
    if (result.length > 100_000) throw new Error('Compact stream exceeds reference limit');
  }
  return result;
}
function baseline(snapshot: Snapshot): LiveAttempt | undefined {
  const attempt = snapshot.assistantStream?.activeAttempt;
  if (!attempt) return;
  const chunks = expandCompact(attempt.stream);
  if (chunks.length !== attempt.nextIndex) throw new Error('Invalid native attempt baseline');
  return { attemptId: attempt.attemptId, turn: attempt.turn, step: attempt.step, startedAfterSeq: attempt.startedAfterSeq, nextIndex: attempt.nextIndex, blocks: chunks.reduce<Readonly<Record<number, DisplayBlock>>>((blocks, chunk) => foldChunk(blocks, chunk), {}) };
}
function statusAfter(status: SidebarState['status'], event: NativeEvent): SidebarState['status'] {
  if (event.type === 'turn/start') return 'running';
  if (event.type === 'turn/end') return 'idle';
  return status;
}
function mergeRecords(records: readonly NativeEvent[], additions: readonly NativeEvent[]): NativeEvent[] {
  const bySeq = new Map(records.map(event => [event.seq, event]));
  for (const event of additions) bySeq.set(event.seq, event);
  const result = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  if (result.length > SIDEBAR_LIMITS.records) throw new Error('Transcript window full; reconnect for a fresh bounded window');
  return result;
}

/** Pure fold of the installed native SessionFollowFrame vocabulary. Snapshot is replacement. */
export function reduceFrame(state: SidebarState, frame: ConversationFrame): SidebarState {
  if (frame.type === 'receipt') return { ...state, receipts: Object.fromEntries(Object.entries({ ...state.receipts, [frame.requestId]: frame.messageId }).slice(-128)) };
  if (frame.type === 'snapshot') {
    const records = mergeRecords([], frame.records.map(record => record.event));
    const active = baseline(frame);
    return { ...initialSidebarState(), sessionId: frame.header.id, throughSeq: frame.cursor, cursor: frame.cursor, records, hasMore: frame.hasMore, streamRevision: frame.assistantStream?.revision ?? 0, active, status: active ? 'running' : records.reduce(statusAfter, 'idle'), receipts: state.receipts };
  }
  if (!state.sessionId) throw new Error('Expected a native snapshot first');
  if (frame.type === 'event') {
    if (frame.event.seq <= state.cursor) return state; // repeated durable entry, not repeated token deltas
    if (frame.event.seq !== state.cursor + 1) throw new Error('Durable stream gap; reconnect');
    return { ...state, cursor: frame.event.seq, records: mergeRecords(state.records, [frame.event]), status: statusAfter(state.status, frame.event) };
  }
  const live = frame.frame;
  // Agent replacement restarts its process-local revision counter. Never keep a stale prefix.
  if (live.type === 'start' && live.revision === 1 && state.streamRevision !== 0) throw new Error('Assistant lifecycle reset; reconnect');
  if (live.revision <= state.streamRevision) return state;
  if (live.revision !== state.streamRevision + 1) throw new Error('Assistant stream gap; reconnect');
  const updated = { ...state, streamRevision: live.revision };
  if (live.type === 'start') {
    if (state.active) throw new Error('Overlapping attempt; reconnect');
    return { ...updated, active: { attemptId: live.attemptId, turn: live.turn, step: live.step, startedAfterSeq: live.startedAfterSeq, nextIndex: 0, blocks: {} } };
  }
  const active = state.active;
  // The host may attach after a start. Unknown transient suffixes cannot be reconstructed.
  if (!active || active.attemptId !== live.attemptId) return updated;
  if (live.index !== active.nextIndex) throw new Error('Assistant chunk gap; reconnect');
  if (live.type === 'chunk') return { ...updated, active: { ...active, nextIndex: active.nextIndex + 1, blocks: foldChunk(active.blocks, live.chunk) } };
  if (live.outcome.kind === 'committed') {
    const settlementSeq = live.outcome.seq;
    const settlement = state.records.find(event => event.seq === settlementSeq);
    if (!settlement || settlement.type !== live.outcome.eventType || !object(settlement.data) || settlement.data.turn !== active.turn || settlement.data.step !== active.step) throw new Error('Missing native attempt settlement; reconnect');
  }
  // Durable settlement seq is authoritative; it replaces this exact transient attempt.
  return { ...updated, active: undefined };
}
export function prependHistory(state: SidebarState, page: SessionPage, throughSeq: number): SidebarState {
  if (throughSeq !== state.throughSeq) return state; // a reconnect superseded the in-flight page
  return { ...state, records: mergeRecords(state.records, page.records.map(record => record.event).filter(event => event.seq <= throughSeq)), hasMore: page.hasMore };
}
export interface TranscriptRow { key: string; role: 'user' | 'assistant' | 'tool' | 'status'; blocks: readonly DisplayBlock[]; messageId?: string; requestId?: string; transient?: boolean }
function messageBlocks(value: unknown): DisplayBlock[] {
  if (!object(value) || !Array.isArray(value.content)) return [];
  return value.content.flatMap(value => { const parsed = block(value); return parsed ? [parsed] : []; });
}
export function transcriptRows(state: SidebarState): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  for (const event of state.records) {
    const data = object(event.data) ? event.data : {};
    // Human transcript keeps append-origin events; compaction/replacement copies are model-only.
    if ((event.type === 'user/message' || event.type === 'assistant/message' || event.type === 'tool/result') && event.surfaceOp !== 'append') continue;
    if (event.type === 'assistant/message' && state.active && event.seq > state.active.startedAfterSeq && data.turn === state.active.turn && data.step === state.active.step) continue; // staged until end.outcome.seq retires the live attempt
    if (event.type === 'user/message' || event.type === 'assistant/message' || event.type === 'tool/result') {
      const message = event.type === 'user/message' ? data : data.message;
      const source = object(message) && object(message.source) ? message.source : {};
      rows.push({ key: `event:${event.seq}`, role: event.type === 'user/message' ? 'user' : event.type === 'assistant/message' ? 'assistant' : 'tool', blocks: messageBlocks(message), messageId: object(message) && typeof message.id === 'string' ? message.id : undefined, requestId: typeof source.rpcId === 'string' ? source.rpcId : undefined });
    } else if (event.type === 'tool/call' && typeof data.callId === 'string' && typeof data.name === 'string' && typeof data.arguments === 'string') {
      // Many assistants also carry tool-call blocks: show the explicit call only when absent there.
      if (!rows.some(row => row.blocks.some(block => block.type === 'tool-call' && block.id === data.callId))) rows.push({ key: `event:${event.seq}`, role: 'tool', blocks: [{ type: 'tool-call', id: data.callId, name: data.name, arguments: data.arguments }] });
    } else if (event.type === 'turn/end') {
      const reason = object(data.reason) && typeof data.reason.kind === 'string' ? data.reason.kind : 'finished';
      rows.push({ key: `event:${event.seq}`, role: 'status', blocks: [{ type: 'text', text: `Turn ${reason}` }] });
    } else if (event.type === 'assistant/attempt') rows.push({ key: `event:${event.seq}`, role: 'status', blocks: [{ type: 'text', text: 'Model attempt settled without a message' }] });
  }
  if (state.active) rows.push({ key: `attempt:${state.active.attemptId}`, role: 'assistant', transient: true, blocks: Object.values(state.active.blocks) });
  return rows;
}

/** Bounded fetch-SSE reader. Reconnection opens a NEW snapshot; there is no Last-Event-ID replay. */
export async function consumeNativeSSE(response: Response, accept: (frame: NativeFrame) => void, signal: AbortSignal): Promise<void> {
  if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream') || !response.body) throw new Error(`Assistant stream unavailable (${response.status})`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const deliver = (packet: string) => {
    let event = 'message'; const data: string[] = [];
    for (const line of packet.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trimStart();
      if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (!data.length) return;
    if (event === 'sidebar-error') throw new Error('Assistant stream disconnected; reconnect to inspect history');
    if (event !== 'native') return;
    const frame: unknown = JSON.parse(data.join('\n'));
    if (!object(frame) || !['snapshot', 'event', 'assistant-stream'].includes(String(frame.type))) throw new Error('Invalid native frame');
    // Native bridge is the schema-validation boundary; never interpret arbitrary HTML here.
    accept(frame as unknown as NativeFrame);
  };
  try {
    while (!signal.aborted) {
      const item = await reader.read();
      if (item.done) { buffer += decoder.decode(); break; }
      buffer += decoder.decode(item.value, { stream: true });
      // CRLF may be split across reads. Normalize complete packets, not each chunk.
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const packet = buffer.slice(0, match.index).replace(/\r\n/g, '\n');
        if (utf8Bytes(packet) > SIDEBAR_LIMITS.frameBytes + 128) throw new Error('Assistant frame exceeds limit');
        buffer = buffer.slice(match.index + match[0].length); deliver(packet);
      }
      if (utf8Bytes(buffer) > SIDEBAR_LIMITS.frameBytes + 128) throw new Error('Assistant frame exceeds limit');
    }
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {}); reader.releaseLock();
  }
  if (signal.aborted) throw new DOMException('Assistant subscription cancelled', 'AbortError');
  // An incomplete last frame is never committed. Caller reconnects on EOF.
}
