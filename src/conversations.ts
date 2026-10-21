import type { ModelSelection } from './models.js';
import type { JsonValue } from './types.js';
import type { SessionFollowFrame, SessionPage } from '@deepseek-ai/dsh-api-session-controller/types';

export type { SessionFollowFrame, SessionPage } from '@deepseek-ai/dsh-api-session-controller/types';
export type { ModelSelection } from './models.js';

/** A real, continuable DSH child, privately bound to this parent + program. */
export interface ConversationOpenOptions {
  name: string;
  instructions?: string;
  /** Creation-time route or a declared program model slot. Existing routes are immutable. */
  model?: ModelSelection | string;
}
export interface ConversationInfo { id: string; name: string; model?: ModelSelection }
export interface ConversationMessage {
  text: string;
  /** App-owned data, delivered as untrusted context on this exact prompt. */
  context?: { revision?: string | number; state: JsonValue };
}
export interface ConversationReceipt { requestId: string; messageId: string }
export interface ConversationHistoryOptions {
  /** Inclusive durable cut from the opening native snapshot; -1 means empty. */
  throughSeq: number;
  beforeSeq?: number;
  maxMessages?: number;
}
export interface ConversationEventsOptions { signal?: AbortSignal; maxMessages?: number }
export interface ConversationSendOptions {
  signal?: AbortSignal;
  requestId?: string;
  /** Queue owns a separate turn. Steering joins the nearest active step. */
  mode?: 'queue' | 'steer';
}
/** Native history/stream vocabulary, plus the accepted prompt's durable identity. */
export type ConversationFrame = SessionFollowFrame | ({ type: 'receipt' } & ConversationReceipt);
export interface ConversationHandle extends ConversationInfo {
  history(options: ConversationHistoryOptions, callOptions?: { signal?: AbortSignal; timeoutMs?: number }): Promise<SessionPage>;
  /** Reconnection starts with a fresh native snapshot, not token replay. */
  events(options?: ConversationEventsOptions): AsyncIterable<SessionFollowFrame>;
  send(message: ConversationMessage, options?: ConversationSendOptions): Promise<ConversationReceipt>;
  /** Subscribe before queueing; ends at this accepted message's native turn/end. */
  ask(message: ConversationMessage, options?: Omit<ConversationSendOptions, 'mode'>): AsyncIterable<ConversationFrame>;
  /** Requests cancellation; pending work survives and external effects are not undone. */
  interrupt(options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<{ accepted: true }>;
}
export interface ProgramConversations {
  open(options: ConversationOpenOptions, callOptions?: { signal?: AbortSignal; timeoutMs?: number }): Promise<ConversationHandle>;
  get(id: string, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<ConversationHandle | null>;
  list(options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<ConversationInfo[]>;
}
export const CONVERSATION_LIMITS = Object.freeze({
  bindings: 1024, perProgram: 64, activeStreams: 32, streamsPerProgram: 4,
  frameBytes: 512 * 1024, messageBytes: 48 * 1024, contextBytes: 16 * 1024,
  defaultMessages: 20, maxMessages: 100,
});
