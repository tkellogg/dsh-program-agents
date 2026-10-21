import type { JsonValue } from '../types.js';
import { ProgramError } from '../runtime/protocol.js';
import type { CallOptions } from './index.js';
import type { InboxMessage, MessageReceipt, ReceiveOptions } from './mailbox.js';

export type InboxBridgeCall = <T = JsonValue>(method: string, input?: JsonValue, options?: CallOptions) => Promise<T>;
export interface InboxReceiveOptions extends ReceiveOptions, CallOptions {}
export interface ManagedReceiveOptions extends InboxReceiveOptions {
  /** Callback deadline, independently of individual bridge calls. Default 120s; maximum 1h. */
  processingTimeoutMs?: number;
}
export type ReadonlyInboxJson = string | number | boolean | null | readonly ReadonlyInboxJson[] | { readonly [key: string]: ReadonlyInboxJson };
/** The callback cannot access the claim token or any settlement operation. */
export type HandlerMessage = Readonly<Omit<InboxMessage, 'leaseToken' | 'body' | 'receipt'>> & {
  readonly body: ReadonlyInboxJson;
  readonly receipt: Readonly<MessageReceipt>;
};
export interface InboxHandlerContext { readonly signal: AbortSignal }
export type InboxHandler<R> = (message: HandlerMessage, context: InboxHandlerContext) => R | PromiseLike<R>;
type Claim = Pick<InboxMessage, 'id' | 'leaseToken'>;

export interface ProgramInbox {
  receive<R>(handler: InboxHandler<R>): Promise<R | null>;
  receive<R>(options: ManagedReceiveOptions | undefined, handler: InboxHandler<R>): Promise<R | null>;
  /** @deprecated Prefer receive(options, handler), which owns renewal and settlement. */
  receive(options?: InboxReceiveOptions): Promise<InboxMessage | null>;
  /** Low-level manual claim: the caller must renew and settle its own live lease. */
  claim(options?: InboxReceiveOptions): Promise<InboxMessage | null>;
  /** Low-level renewal, fenced by the exact live claim token and run. */
  renew(message: Claim, leaseMs: number, options?: CallOptions): Promise<MessageReceipt>;
  /** Low-level, single-attempt ACK. A rejected call may already have committed. */
  ack(message: Claim | string, leaseToken?: string, options?: CallOptions): Promise<MessageReceipt>;
  /** Low-level, single-attempt NACK. Requires the exact, unexpired claim. */
  nack(message: Claim | string, leaseToken?: string, options?: CallOptions): Promise<MessageReceipt>;
  /** Low-level durable status lookup; acceptance is not successful processing. */
  receipt(id: string, options?: CallOptions): Promise<MessageReceipt | null>;
}

/** ACK may have committed before its response was lost. Neither retry nor NACK is safe. */
export class SettlementUnknownError extends ProgramError {
  readonly outcome = 'unknown' as const;
  readonly operation = 'ack' as const;
  readonly cause: unknown;
  constructor(readonly messageId: string, cause: unknown) {
    super('SETTLEMENT_UNKNOWN', `ACK outcome is unknown for inbox message ${messageId}; do not repeat its callback or automatically retry settlement`);
    this.name = 'SettlementUnknownError';
    this.cause = cause;
  }
}

const bound = (value: unknown, name: string, min: number, max: number): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new ProgramError('INVALID_INPUT', `${name} must be an integer from ${min} to ${max}`);
  return value;
};
const cancelled = () => new ProgramError('CANCELLED', 'Inbox processing was cancelled; a running callback must cooperate with context.signal');
const processingTimeout = () => new ProgramError('TIMEOUT', 'Inbox processing deadline exceeded; a running callback may still have effects after its lease expires');
const frozen = <T>(value: T): T => {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
};
const claimArgs = (message: Claim | string, leaseToken?: string): Claim => {
  const value = typeof message === 'string' ? { id: message, leaseToken } : message;
  if (!value || typeof value.id !== 'string' || !value.id || value.id.length > 256 || typeof value.leaseToken !== 'string' || !value.leaseToken || value.leaseToken.length > 256) throw new ProgramError('INVALID_INPUT', 'Ack/nack requires the claimed message or its id and leaseToken');
  return { id: value.id, leaseToken: value.leaseToken };
};
const optionsFor = (options: InboxReceiveOptions, managed: boolean) => {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new ProgramError('INVALID_INPUT', 'Invalid inbox receive options');
  const waitMs = bound(options.waitMs === undefined ? 0 : options.waitMs, 'waitMs', 0, 30_000);
  const leaseMs = bound(options.leaseMs === undefined ? 60_000 : options.leaseMs, 'leaseMs', managed ? 500 : 1, 300_000);
  const timeoutMs = options.timeoutMs === undefined ? undefined : bound(options.timeoutMs, 'timeoutMs', 1, 120_000);
  if (options.signal !== undefined && (!options.signal || typeof options.signal.aborted !== 'boolean' || typeof options.signal.addEventListener !== 'function' || typeof options.signal.removeEventListener !== 'function')) throw new ProgramError('INVALID_INPUT', 'Invalid inbox cancellation signal');
  return { waitMs, leaseMs, timeoutMs, signal: options.signal };
};

/**
 * Managed processing invokes the callback once per claim, renews while it runs, and ACKs
 * only a fulfilled, uninterrupted callback. No bridge effect or callback is retried.
 *
 * This is NOT exactly-once processing: crashes, lease loss, and uncooperative callbacks
 * can cause redelivery and overlapping external effects. Use application idempotency.
 * Cancellation rejects receive promptly but does not NACK a still-running callback.
 * Its claim is renewed only until the processing deadline; then renewal stops and the
 * last lease expires naturally. A late callback never ACKs. Each helper retains one
 * of its 32 slots until the actual callback settles, even after the caller has left.
 */
export function createProgramInbox(call: InboxBridgeCall): ProgramInbox {
  let active = 0;
  const claim = async (options: InboxReceiveOptions = {}): Promise<InboxMessage | null> => {
    const { waitMs, leaseMs, timeoutMs, signal } = optionsFor(options, false);
    return call<InboxMessage | null>('inbox.receive', { ...(options.waitMs === undefined ? {} : { waitMs }), ...(options.leaseMs === undefined ? {} : { leaseMs }) }, { timeoutMs, signal });
  };
  const settle = (method: 'inbox.ack' | 'inbox.nack', message: Claim | string, leaseToken?: string, options?: CallOptions) => call<MessageReceipt>(method, claimArgs(message, leaseToken), options);

  const managed = async <R>(options: ManagedReceiveOptions, handler: InboxHandler<R>): Promise<R | null> => {
    const { waitMs, leaseMs, timeoutMs, signal } = optionsFor(options, true);
    const processingTimeoutMs = bound(options.processingTimeoutMs === undefined ? 120_000 : options.processingTimeoutMs, 'processingTimeoutMs', 1, 3_600_000);
    if (signal?.aborted) throw cancelled();
    if (active >= 32) throw new ProgramError('BACKPRESSURE', 'Inbox managed callback limit exceeded');
    active++;
    let message: InboxMessage | null;
    try {
      // A claim is acquired before any user code runs. The processing deadline starts
      // after acquisition, independently of long-poll and individual RPC deadlines.
      message = await call<InboxMessage | null>('inbox.receive', { waitMs, leaseMs }, { timeoutMs, signal });
      if (message !== null) {
        claimArgs(message);
        const receipt = message.receipt;
        if (!receipt || receipt.id !== message.id || receipt.status !== 'claimed' || typeof receipt.leaseUntil !== 'string' || !Number.isFinite(Date.parse(receipt.leaseUntil)) || Date.parse(receipt.leaseUntil) <= Date.now()) throw new ProgramError('INVALID_RESPONSE', 'Inbox receive did not confirm a live claim');
      }
    } catch (error) { active--; throw error; }
    if (message === null) {
      active--;
      if (signal?.aborted) throw cancelled();
      return null;
    }

    const processingDeadline = performance.now() + processingTimeoutMs;
    const context = new AbortController();
    const renewalController = new AbortController();
    let failed = false;
    let failure: unknown;
    let ackStarted = false;
    let renewalStopped = false;
    let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let renewal: Promise<void> | undefined;
    let rejectInterrupted!: (error: unknown) => void;
    const interrupted = new Promise<never>((_resolve, reject) => { rejectInterrupted = reject; });
    void interrupted.catch(() => {});
    const removeAbort = () => signal?.removeEventListener('abort', onAbort);
    const stopRenewal = (abortPending = false) => {
      renewalStopped = true;
      clearTimeout(heartbeatTimer);
      heartbeatTimer = undefined;
      if (abortPending) renewalController.abort();
    };
    const interrupt = (error: unknown, stop = false) => {
      if (stop) {
        stopRenewal(true);
        clearTimeout(deadlineTimer);
        deadlineTimer = undefined;
      }
      if (!context.signal.aborted) context.abort(error);
      // Once ACK was attempted, only its response can determine the result. A lost
      // response is SettlementUnknownError, never a misleading cancellation + NACK.
      if (ackStarted || failed) return;
      failed = true;
      failure = error;
      removeAbort();
      rejectInterrupted(error);
    };
    const onAbort = () => interrupt(cancelled());
    const heartbeatMs = Math.floor(leaseMs / 3);
    const schedule = () => {
      if (!renewalStopped) heartbeatTimer = setTimeout(() => {
        heartbeatTimer = undefined;
        renewal = (async () => {
          try {
            const receipt = await call<MessageReceipt>('inbox.renew', { id: message.id, leaseToken: message.leaseToken, leaseMs }, { signal: renewalController.signal, timeoutMs: Math.min(timeoutMs ?? 120_000, heartbeatMs) });
            if (!receipt || receipt.id !== message.id || receipt.status !== 'claimed' || typeof receipt.leaseUntil !== 'string' || !Number.isFinite(Date.parse(receipt.leaseUntil)) || Date.parse(receipt.leaseUntil) <= Date.now()) throw new ProgramError('INVALID_RESPONSE', 'Inbox renewal did not confirm a live claim');
          } catch (error) {
            if (!renewalController.signal.aborted) interrupt(error, true);
          }
        })();
        void renewal.then(schedule);
      }, heartbeatMs);
    };
    const cleanup = () => {
      clearTimeout(deadlineTimer);
      deadlineTimer = undefined;
      stopRenewal(true);
      removeAbort();
    };
    const nack = async () => {
      // Never reuse the cancelled callback signal for settlement. One bounded,
      // best-effort NACK is made only AFTER actual user code has stopped running.
      try { await settle('inbox.nack', message, undefined, { timeoutMs: timeoutMs ?? 120_000 }); }
      catch { /* Expiry/revocation may already have fenced this claim. No retries. */ }
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    deadlineTimer = setTimeout(() => {
      deadlineTimer = undefined;
      interrupt(processingTimeout(), true);
      removeAbort();
    }, processingTimeoutMs);
    if (signal?.aborted) onAbort();
    schedule();

    const work = (async (): Promise<R> => {
      try {
        let result!: R;
        try {
          if (failed) throw failure;
          const { leaseToken: _token, ...visible } = message;
          result = await handler(frozen(visible), Object.freeze({ signal: context.signal }));
        } catch (error) {
          if (!failed) { failed = true; failure = error; }
          if (!context.signal.aborted) context.abort(failure);
        }
        // Drain the one possible renewal before making a settlement decision. A
        // late renewal failure must not be hidden by a callback's successful return.
        stopRenewal();
        if (renewal) await renewal;
        if (signal?.aborted && !failed) { failed = true; failure = cancelled(); }
        // A synchronous callback may monopolize the event loop past its deadline,
        // preventing the timer from running. It still must never acquire an ACK.
        if (!failed && performance.now() >= processingDeadline) { failed = true; failure = processingTimeout(); }
        if (failed) {
          cleanup();
          await nack();
          throw failure;
        }
        ackStarted = true;
        clearTimeout(deadlineTimer);
        deadlineTimer = undefined;
        try {
          const receipt = await settle('inbox.ack', message, undefined, { timeoutMs, signal });
          if (!receipt || receipt.id !== message.id || receipt.status !== 'acked') throw new ProgramError('INVALID_RESPONSE', 'Inbox ACK did not confirm settlement');
        } catch (error) { throw new SettlementUnknownError(message.id, error); }
        return result;
      } finally {
        cleanup();
        active--;
      }
    })();
    return Promise.race([work, interrupted]);
  };

  function receive<R>(handler: InboxHandler<R>): Promise<R | null>;
  function receive<R>(options: ManagedReceiveOptions | undefined, handler: InboxHandler<R>): Promise<R | null>;
  function receive(options?: InboxReceiveOptions): Promise<InboxMessage | null>;
  function receive<R>(optionsOrHandler: ManagedReceiveOptions | InboxHandler<R> = {}, handler?: InboxHandler<R>): Promise<R | InboxMessage | null> {
    if (typeof optionsOrHandler === 'function') {
      if (handler !== undefined) return Promise.reject(new ProgramError('INVALID_INPUT', 'Receive expects one handler'));
      return managed({}, optionsOrHandler);
    }
    if (handler === undefined) return claim(optionsOrHandler);
    if (typeof handler !== 'function') return Promise.reject(new ProgramError('INVALID_INPUT', 'Receive handler must be a function'));
    return managed(optionsOrHandler, handler);
  }
  return {
    receive,
    claim,
    renew: async (message, leaseMs, options) => call<MessageReceipt>('inbox.renew', { ...claimArgs(message), leaseMs: bound(leaseMs, 'leaseMs', 1, 300_000) }, options),
    ack: (message, token, options) => settle('inbox.ack', message, token, options),
    nack: (message, token, options) => settle('inbox.nack', message, token, options),
    receipt: (id, options) => call<MessageReceipt | null>('inbox.receipt', { id }, options),
  };
}
