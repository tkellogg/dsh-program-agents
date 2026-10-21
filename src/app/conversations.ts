import { randomUUID } from 'node:crypto';
import type { JsonValue } from '../types.js';
import type { CallOptions } from './index.js';
import type { ConversationFrame, ConversationHandle, ConversationInfo, ConversationMessage, ConversationReceipt, ConversationSendOptions, ProgramConversations, SessionFollowFrame, SessionPage } from '../conversations.js';
import { ProgramError } from '../runtime/protocol.js';
export type * from '../conversations.js';

export type ConversationBridgeCall = <T = JsonValue>(method: string, input?: JsonValue, options?: CallOptions) => Promise<T>;
export type ConversationBridgeStream = (method: string, input?: JsonValue, options?: CallOptions) => AsyncIterable<JsonValue>;

/** App-side handles contain no credentials, Agent objects, model calls, or tool loop. */
export function createProgramConversations(call: ConversationBridgeCall, stream: ConversationBridgeStream): ProgramConversations {
  const sendInput = (id: string, message: ConversationMessage, options: ConversationSendOptions = {}): JsonValue => ({
    id, message: message as unknown as JsonValue, requestId: options.requestId ?? randomUUID(), ...(options.mode === undefined ? {} : { mode: options.mode }),
  });
  const handle = (info: ConversationInfo): ConversationHandle => Object.freeze({
    ...info,
    history: (options, callOptions) => call<SessionPage>('conversations.history', { id: info.id, ...options }, callOptions),
    events: (options = {}) => stream('conversations.events', { id: info.id, ...(options.maxMessages === undefined ? {} : { maxMessages: options.maxMessages }) }, { signal: options.signal }) as unknown as AsyncIterable<SessionFollowFrame>,
    send: (message, options = {}) => call<ConversationReceipt>('conversations.send', sendInput(info.id, message, options), { signal: options.signal }),
    ask: (message, options = {}) => {
      if ('mode' in options && options.mode !== 'queue') throw new ProgramError('INVALID_INPUT', 'Conversation ask requires a queued, distinct turn; use send for steering');
      return stream('conversations.ask', sendInput(info.id, message, { requestId: options.requestId, signal: options.signal }), { signal: options.signal }) as unknown as AsyncIterable<ConversationFrame>;
    },
    interrupt: options => call<{ accepted: true }>('conversations.interrupt', { id: info.id }, options),
  } satisfies ConversationHandle);
  return {
    open: async (options, callOptions) => handle(await call<ConversationInfo>('conversations.open', options as unknown as JsonValue, callOptions)),
    get: async (id, options) => { const info = await call<ConversationInfo | null>('conversations.get', { id }, options); return info ? handle(info) : null; },
    list: options => call<ConversationInfo[]>('conversations.list', {}, options),
  };
}
