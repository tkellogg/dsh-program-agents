import type{ModelSlotView,ModelSelection}from'../models.js';
import { CLIENT_LIMITS, parseRunList, type ProgramAction, type ProgramItem, type ProgramRun, type RunList } from './model.js';

/** Public structural face of DSH ClientConnectionRpc; supplied by ctx.connection. */
export interface RpcTransport {
  call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<
    { readonly ok: true; readonly value: unknown } |
    { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }
  >;
}
export type StreamingFetch = (input: URL, init: RequestInit) => Promise<Response>;
export interface ProgramModelCatalog{default:ModelSelection;routableProviders:readonly string[];groups:readonly{id:string;name:string;models:readonly{id:string;name:string;description?:string;reasoning?:{efforts:readonly{id:string;name:string}[];defaultEffort?:string}}[]}[];failures:readonly{id:string;name:string;message:string}[]}
export interface ProgramModelConfiguration{slots:ModelSlotView[];catalog:ProgramModelCatalog}
export interface ProgramClient {
  readonly sessionId: string;
  list(signal: AbortSignal): Promise<RunList>;
  subscribe(snapshot: (value: RunList) => void, signal: AbortSignal): Promise<void>;
  action(action: ProgramAction, target: ProgramItem | ProgramRun, signal: AbortSignal): Promise<void>;
  modelConfiguration?(program:string,signal:AbortSignal):Promise<ProgramModelConfiguration>;
  setModel?(program:string,slot:string,selection:ModelSelection|null,revision:number,signal:AbortSignal):Promise<ModelSlotView>;
}
export class ProgramApiError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = 'ProgramApiError'; this.code = code; }
}
const cancelled = () => new ProgramApiError('cancelled', 'Program agents request cancelled.');
/** Abort even when a broken carrier ignores its signal. Always remove our listener. */
async function abortable<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw cancelled();
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([operation(), new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(cancelled());
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    })]);
  } finally { if (onAbort) signal.removeEventListener('abort', onAbort); }
}
/** Bounded SSE parser: comments are heartbeats, only complete snapshot events apply. */
export async function consumeSnapshots(response: Response, snapshot: (value: unknown) => void, signal: AbortSignal): Promise<void> {
  if (!response.ok || !/^text\/event-stream(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') || !response.body) throw new ProgramApiError('stream', 'Program agents connection unavailable.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let line = '', event = '', data: string[] = [], frameBytes = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  const completeLine = () => {
    const text = line.endsWith('\r') ? line.slice(0, -1) : line;
    line = '';
    if (!text) {
      if (event === 'snapshot' && data.length) snapshot(JSON.parse(data.join('\n')));
      event = ''; data = []; frameBytes = 0;
    } else if (!text.startsWith(':')) {
      const separator = text.indexOf(':');
      const field = separator < 0 ? text : text.slice(0, separator);
      let value = separator < 0 ? '' : text.slice(separator + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') event = value;
      if (field === 'data') data.push(value);
    }
  };
  try {
    while (!signal.aborted) {
      const { done, value } = await abortable(() => reader.read(), signal);
      if (done) break;
      let start = 0;
      for (let index = 0; index < value.length; index++) {
        if (value[index] !== 10) continue;
        frameBytes += index + 1 - start;
        if (frameBytes > CLIENT_LIMITS.frameBytes) throw new ProgramApiError('stream', 'Program agents snapshot is too large.');
        line += decoder.decode(value.subarray(start, index), { stream: true });
        completeLine(); start = index + 1;
      }
      frameBytes += value.length - start;
      if (frameBytes > CLIENT_LIMITS.frameBytes) throw new ProgramApiError('stream', 'Program agents snapshot is too large.');
      line += decoder.decode(value.subarray(start), { stream: true });
    }
    if (signal.aborted) throw cancelled();
    // EOF without a blank line is an incomplete event, never an authoritative state.
  } finally {
    signal.removeEventListener('abort', abort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
/** rc.2's public ConnectionHandle has RPC but no streaming HTTP facade. Use the
 * documented same-origin browser carrier fallback; no private connection fields. */
export function createProgramClient(connection: { rpc: RpcTransport } | RpcTransport, sessionId: string, streamingFetch: StreamingFetch = (input, init) => globalThis.fetch(input, init), timeoutMs = 20_000): ProgramClient {
  if (!sessionId) throw new Error('Program agents require a selected Session.');
  const rpc = 'rpc' in connection ? connection.rpc : connection;
  const call = async (method: string, payload: unknown, signal: AbortSignal): Promise<unknown> => {
    const abort = new AbortController();
    const cancel = () => abort.abort();
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) abort.abort();
    const deadline = setTimeout(cancel, timeoutMs);
    try {
      const reply = await abortable(() => rpc.call('/api', `programAgents/${method}`, payload, abort.signal), abort.signal);
      if (!reply.ok) throw new ProgramApiError(reply.error.code, reply.error.message);
      return reply.value;
    } catch (error) {
      if (abort.signal.aborted && !signal.aborted) throw new ProgramApiError('timeout', 'Program action timed out. Check status before retrying.');
      throw error;
    } finally { clearTimeout(deadline); signal.removeEventListener('abort', cancel); }
  };
  return {
    sessionId,
    async modelConfiguration(program,signal){return await call('models',{sessionId,program},signal)as ProgramModelConfiguration;},
    async setModel(program,slot,selection,revision,signal){return await call('modelSet',{sessionId,program,slot,selection,revision},signal)as ModelSlotView;},
    async list(signal) { return parseRunList(await call('list', { sessionId }, signal), sessionId); },
    async subscribe(snapshot, signal) {
      const url = new URL('api/programAgents/events', document.baseURI);
      const response = await abortable(() => streamingFetch(url, {
        method: 'POST', credentials: 'same-origin', redirect: 'error', cache: 'no-store',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify({ sessionId }), signal,
      }), signal);
      await consumeSnapshots(response, value => { if (!signal.aborted) snapshot(parseRunList(value, sessionId)); }, signal);
    },
    async action(action, target, signal) {
      const run = 'ownerId' in target ? target : target.run;
      if (run && run.ownerId !== sessionId) throw new Error('Program does not belong to this Session.');
      if (action !== 'start' && !run) throw new Error('Program has no current run.');
      await call(action, action === 'start' ? { sessionId, program: target.program } : { sessionId, id: run!.id, generation: run!.generation }, signal);
    },
  };
}
