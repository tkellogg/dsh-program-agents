import type { JsonValue } from '../types.js';
import { assertJson, isRecord, ProgramError, validName } from '../runtime/protocol.js';
import { createLogger, type LoggerOptions } from '../monitoring/logger.js';
import type { InboxMessage, MessageReceipt, ReceiveOptions } from './mailbox.js';
import { createProgramEndpoints } from './endpoints.js';

export {installGlobalErrorHandlers}from'../monitoring/fatal.js';
export { createLogger, StructuredLogger, type LoggerOptions, type LogMetadata } from '../monitoring/logger.js';
export type { InboxMessage, MessageReceipt, ReceiveOptions } from './mailbox.js';
export type { JsonValue } from '../types.js';
export { ProgramError } from '../runtime/protocol.js';
export { createProgramEndpoints, listenProgramEndpoint, type ProgramEndpoints, type ProgramEndpointBinding, type PublishEndpointOptions, type UnpublishEndpointOptions, type ListeningProgramEndpoint, type EndpointBridgeCall } from './endpoints.js';
export interface CallOptions { signal?: AbortSignal; timeoutMs?: number }
export interface ConnectProgramOptions {
  url?: string;
  token?: string;
  runId?: string;
  generation?: number;
  timeoutMs?: number;
  logger?: LoggerOptions;
}
export interface FunctionInfo { name: string; description?: string; inputSchema?: JsonValue }
export interface AgentInfo { id: string; name?: string; [key: string]: JsonValue | undefined }
export interface McpToolInfo { server: string; tool: string; name: string; description?: string; inputSchema?: JsonValue }
export interface SendOptions extends CallOptions { correlationId?: string }

/** Explicit connection only: ordinary programs require no SDK and gain no implicit permission. */
export function connectProgram(options: ConnectProgramOptions = {}) {
  const rawUrl = options.url ?? process.env.DSH_PROGRAM_BRIDGE_URL;
  const token = options.token ?? process.env.DSH_PROGRAM_BRIDGE_TOKEN;
  if (!rawUrl || !token) throw new ProgramError('NOT_CONFIGURED', 'Program bridge is not configured; launch under a bridge-enabled supervisor or pass url and token explicitly');
  let url: URL;
  try { url = new URL(rawUrl); }
  catch { throw new ProgramError('INVALID_CONFIG', 'Invalid program bridge URL'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash || typeof token !== 'string' || token.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(token)) throw new ProgramError('INVALID_CONFIG', 'Program bridge requires a direct 127.0.0.1 HTTP endpoint and opaque token');
  const defaultTimeout = options.timeoutMs ?? 120_000;
  if (!Number.isSafeInteger(defaultTimeout) || defaultTimeout < 1 || defaultTimeout > 120_000) throw new ProgramError('INVALID_CONFIG', 'Bridge timeout must be between 1 and 120000 ms');
  const generationText = process.env.DSH_PROGRAM_GEN;
  const generation = options.generation ?? (generationText === undefined ? undefined : Number(generationText));
  if (generation !== undefined && (!Number.isSafeInteger(generation) || generation < 1)) throw new ProgramError('INVALID_CONFIG', 'Invalid bridge generation');
  let pending = 0;
  const logger = createLogger(options.logger);

  const call = async <T = JsonValue>(method: string, input: JsonValue = null, callOptions: CallOptions = {}): Promise<T> => {
    if (!validName(method)) throw new ProgramError('INVALID_INPUT', 'Invalid bridge method');
    assertJson(input);
    const body = JSON.stringify({ method, input });
    if (Buffer.byteLength(body) > 64 * 1024) throw new ProgramError('LIMIT', 'Bridge request exceeds 64 KiB');
    const timeoutMs = callOptions.timeoutMs ?? defaultTimeout;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new ProgramError('INVALID_INPUT', 'Bridge timeout must be between 1 and 120000 ms');
    if (callOptions.signal?.aborted) throw new ProgramError('CANCELLED', 'Bridge call was cancelled before sending');
    if (pending >= 32) throw new ProgramError('BACKPRESSURE', 'Program bridge pending call limit exceeded');
    pending++;
    const controller = new AbortController();
    const abort = () => controller.abort(new ProgramError('CANCELLED', 'Bridge call cancelled; effect outcome may be unknown'));
    const timer = setTimeout(() => controller.abort(new ProgramError('TIMEOUT', 'Bridge deadline exceeded; effect outcome may be unknown')), timeoutMs);
    callOptions.signal?.addEventListener('abort', abort, { once: true });
    if (callOptions.signal?.aborted) abort();
    try {
      // Never retry effects or follow redirects with a run credential.
      const response = await fetch(new URL('/call', url), { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body, signal: controller.signal, redirect: 'error' });
      const reader = response.body?.getReader();
      if (!reader) throw new ProgramError('INVALID_RESPONSE', 'Bridge returned no response body');
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const item = await reader.read();
          if (item.done) break;
          bytes += item.value.length;
          if (bytes > 64 * 1024) { await reader.cancel(); throw new ProgramError('LIMIT', 'Bridge response exceeds 64 KiB'); }
          chunks.push(item.value);
        }
      } finally { reader.releaseLock(); }
      let payload: unknown;
      try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new ProgramError('INVALID_RESPONSE', 'Bridge returned malformed JSON'); }
      assertJson(payload);
      if (!isRecord(payload) || typeof payload.ok !== 'boolean') throw new ProgramError('INVALID_RESPONSE', 'Invalid bridge response envelope');
      if (!payload.ok) {
        if (!isRecord(payload.error) || typeof payload.error.code !== 'string' || typeof payload.error.message !== 'string') throw new ProgramError('INVALID_RESPONSE', 'Invalid bridge error envelope');
        throw new ProgramError(payload.error.code, payload.error.message);
      }
      if (!response.ok || !Object.hasOwn(payload, 'result')) throw new ProgramError('INVALID_RESPONSE', 'Invalid bridge success response');
      return payload.result as T;
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      throw error;
    } finally {
      pending--;
      clearTimeout(timer);
      callOptions.signal?.removeEventListener('abort', abort);
    }
  };
  const sendSupervisor = (body: JsonValue, sendOptions: SendOptions = {}) => call<JsonValue>('supervisor.send', { body, ...(sendOptions.correlationId === undefined ? {} : { correlationId: sendOptions.correlationId }) }, sendOptions);
  const claimArgs = (message: Pick<InboxMessage, 'id' | 'leaseToken'> | string, leaseToken?: string): { id: string; leaseToken: string } => {
    const result = typeof message === 'string' ? { id: message, leaseToken } : message;
    if (!result || typeof result.id !== 'string' || typeof result.leaseToken !== 'string') throw new ProgramError('INVALID_INPUT', 'Ack/nack requires the received message or its id and leaseToken');
    return { id: result.id, leaseToken: result.leaseToken };
  };
  return {
    id: options.runId ?? process.env.DSH_PROGRAM_RUN_ID,
    generation,
    call,
    logger,
    endpoints: createProgramEndpoints(call),
    sendSupervisor,
    supervisor: { send: sendSupervisor },
    functions: {
      list: (callOptions?: CallOptions) => call<FunctionInfo[]>('functions.list', null, callOptions),
      call: <T = JsonValue>(name: string, args: JsonValue = null, callOptions?: CallOptions) => call<T>('functions.call', { name, args }, callOptions),
    },
    agents: {
      list: (callOptions?: CallOptions) => call<AgentInfo[]>('agents.list', null, callOptions),
      get: (id: string, callOptions?: CallOptions) => call<AgentInfo | null>('agents.get', { id }, callOptions),
      send: (id: string, body: JsonValue, sendOptions: SendOptions = {}) => call<JsonValue>('agents.send', { id, body, ...(sendOptions.correlationId === undefined ? {} : { correlationId: sendOptions.correlationId }) }, sendOptions),
    },
    mcp: {
      list: (callOptions?: CallOptions) => call<McpToolInfo[]>('mcp.list', null, callOptions),
      call: <T = JsonValue>(server: string, tool: string, args: JsonValue = null, callOptions?: CallOptions) => call<T>('mcp.call', { server, tool, args }, callOptions),
    },
    models: { call: <T = JsonValue>(input: JsonValue, callOptions?: CallOptions) => call<T>('models.call', input, callOptions) },
    tools: { call: <T = JsonValue>(name: string, args: JsonValue = null, callOptions?: CallOptions) => call<T>('tools.call', { name, args }, callOptions) },
    inbox: {
      receive: (receiveOptions: ReceiveOptions & CallOptions = {}) => {
        const { waitMs, leaseMs, ...callOptions } = receiveOptions;
        return call<InboxMessage | null>('inbox.receive', { ...(waitMs === undefined ? {} : { waitMs }), ...(leaseMs === undefined ? {} : { leaseMs }) }, callOptions);
      },
      ack: (message: Pick<InboxMessage, 'id' | 'leaseToken'> | string, leaseToken?: string, callOptions?: CallOptions) => call<MessageReceipt>('inbox.ack', claimArgs(message, leaseToken), callOptions),
      nack: (message: Pick<InboxMessage, 'id' | 'leaseToken'> | string, leaseToken?: string, callOptions?: CallOptions) => call<MessageReceipt>('inbox.nack', claimArgs(message, leaseToken), callOptions),
      receipt: (id: string, callOptions?: CallOptions) => call<MessageReceipt | null>('inbox.receipt', { id }, callOptions),
    },
  };
}
export type ProgramConnection = ReturnType<typeof connectProgram>;

/** Convenience for a one-off escalation; uses explicit bridge env and does not retry. */
export function sendSupervisor(body: JsonValue, options: SendOptions = {}): Promise<JsonValue> {
  return connectProgram().sendSupervisor(body, options);
}
