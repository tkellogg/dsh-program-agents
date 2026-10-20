import type { CapabilityMetadata, JsonValue, ProgramContext, ProgramMain } from '../types.js';
import { assertJson, envelope, isRecord, matches, ProgramError, RUNTIME_LIMITS, safeError, SendQueue, validName, type Identity } from '../runtime/protocol.js';

const registrationKey = Symbol.for('dsh-program-agents.bootstrap-main');
type Registration = { main?: ProgramMain };
const root = globalThis as typeof globalThis & { [registrationKey]?: Registration };

/** Internal bootstrap hook also supports modules that call runProgram instead of exporting default. */
export function beginRegistration(): Registration {
  const registration: Registration = {};
  root[registrationKey] = registration;
  return registration;
}
export function endRegistration(): void { delete root[registrationKey]; }

class Inbox implements AsyncIterable<{ body: JsonValue }> {
  private readonly entries: Array<{ sequence: number; body: JsonValue }> = [];
  private readonly readers: Array<{ resolve: (value: IteratorResult<{ body: JsonValue }>) => void; reject: (error: Error) => void }> = [];
  private closed = false;
  constructor(private readonly ack: (sequence: number) => void) {}

  push(sequence: number, body: JsonValue): void {
    if (this.closed) return;
    const reader = this.readers.shift();
    if (reader) { this.ack(sequence); reader.resolve({ done: false, value: { body } }); }
    else {
      if (this.entries.length >= RUNTIME_LIMITS.inbox) throw new ProgramError('LIMIT', 'Program inbox limit exceeded');
      this.entries.push({ sequence, body });
    }
  }

  close(): void {
    this.closed = true;
    this.entries.length = 0;
    for (const reader of this.readers.splice(0)) reader.resolve({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<{ body: JsonValue }> {
    return {
      next: () => {
        const entry = this.entries.shift();
        if (entry) { this.ack(entry.sequence); return Promise.resolve({ done: false, value: { body: entry.body } }); }
        if (this.closed) return Promise.resolve({ done: true, value: undefined });
        if (this.readers.length >= RUNTIME_LIMITS.inbox) return Promise.reject(new ProgramError('LIMIT', 'Too many pending inbox readers'));
        return new Promise((resolve, reject) => this.readers.push({ resolve, reject }));
      },
      return: () => { this.close(); return Promise.resolve({ done: true, value: undefined }); },
    };
  }
}

interface Pending {
  resolve: (value: JsonValue) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class ChildConnection {
  private identity?: Identity;
  private input: JsonValue = null;
  private callTimeoutMs = 30_000;
  private readonly controller = new AbortController();
  private readonly queue: SendQueue;
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;
  private nextInboxSequence = 1;
  private started = false;
  private ended = false;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private readonly ready: Promise<void>;
  private readonly inbox: Inbox;

  constructor() {
    if (typeof process.send !== 'function' || !process.connected) throw new ProgramError('NO_IPC', 'Program SDK requires an actual supervised child IPC connection');
    this.queue = new SendQueue(process);
    this.ready = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    void this.ready.catch(() => {});
    this.inbox = new Inbox((sequence) => { void this.send('inboxAck', { sequence }).catch((error) => this.abort(error)); });
    process.on('message', this.message);
    process.once('disconnect', this.disconnected);
    process.once('SIGTERM', this.terminated);
    process.once('SIGINT', this.terminated);
  }

  async execute(load: () => Promise<ProgramMain>): Promise<void> {
    if (this.started) throw new ProgramError('ALREADY_STARTED', 'Program main has already started');
    this.started = true;
    try {
      await this.ready;
      const main = await load();
      if (typeof main !== 'function') throw new ProgramError('INVALID_ENTRY', 'Program entry must export a default main(ctx) function');
      if (this.controller.signal.aborted) return;
      const identity = this.identity!;
      const context: ProgramContext = {
        id: identity.runId,
        generation: identity.generation,
        input: this.input,
        signal: this.controller.signal,
        inbox: this.inbox,
        parent: { send: async (body) => { await this.call('parent.send', body); } },
        status: async (state, detail) => { await this.call('status.set', detail === undefined ? { state } : { state, detail }); },
        resources: {
          publish: async (resource) => { await this.call('resources.publish', resource); },
          unpublish: async (id) => { await this.call('resources.unpublish', { id }); },
        },
        capabilities: {
          list: async () => await this.call('capabilities.list', null) as unknown as CapabilityMetadata[],
          call: (name, input) => {
            if (['capabilities.list', 'parent.send', 'status.set', 'resources.publish', 'resources.unpublish'].includes(name)) return Promise.reject(new ProgramError('FORBIDDEN', 'Use the typed intrinsic SDK method'));
            return this.call(name, input);
          },
        },
        models: { call: (input) => this.call('models.call', input) },
        tools: { call: (name, args) => this.call('tools.call', { name, args }) },
      };
      await this.send('hello');
      const result = await main(Object.freeze(context));
      if (!this.controller.signal.aborted) {
        assertJson(result === undefined ? null : result);
        await this.send('complete', { result: result === undefined ? null : result });
      }
    } catch (error) {
      if (!this.controller.signal.aborted && this.identity) {
        // Startup import errors can precede hello. Send hello then failure so the host
        // still receives a protocol-valid failure, never a fabricated successful result.
        try { await this.send('failed', { error: safeError(error) }); } catch { /* Host is already gone. */ }
      }
      this.abort(error instanceof Error ? error : new Error(safeError(error)));
    }
  }

  private call(method: string, input: JsonValue): Promise<JsonValue> {
    if (this.controller.signal.aborted || this.ended) return Promise.reject(new ProgramError('CANCELLED', 'Program generation is no longer active'));
    if (!validName(method)) return Promise.reject(new ProgramError('INVALID_CAPABILITY', 'Invalid capability name'));
    try { assertJson(input); } catch (error) { return Promise.reject(error); }
    if (this.pending.size >= RUNTIME_LIMITS.pendingCalls) return Promise.reject(new ProgramError('LIMIT', 'Capability concurrency limit exceeded'));
    const callId = this.nextId + 1;
    let request;
    try { request = envelope(this.identity!, 'call', { callId, method, input }); }
    catch (error) { return Promise.reject(error); }
    this.nextId = callId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(callId);
        void this.send('cancel', { callId }).catch(() => {});
        reject(new ProgramError('TIMEOUT', 'Capability deadline exceeded; effect outcome may be unknown'));
      }, this.callTimeoutMs + 100);
      this.pending.set(callId, { resolve, reject, timer });
      void this.queue.send(request).catch((error) => {
        const pending = this.pending.get(callId);
        if (pending) { clearTimeout(pending.timer); this.pending.delete(callId); pending.reject(error instanceof Error ? error : new Error(safeError(error))); }
      });
    });
  }

  private readonly message = (value: unknown): void => {
    try {
      assertJson(value);
      if (!isRecord(value)) throw new ProgramError('PROTOCOL', 'Malformed host envelope');
      if (!this.identity) {
        if (value.type !== 'init' || value.v !== 1 || typeof value.runId !== 'string' || typeof value.token !== 'string' || !Number.isSafeInteger(value.generation) || (value.generation as number) < 1 || !('input' in value) || !Number.isSafeInteger(value.callTimeoutMs) || (value.callTimeoutMs as number) < 1) throw new ProgramError('PROTOCOL', 'Expected supervised IPC initialization');
        this.identity = { runId: value.runId, token: value.token, generation: value.generation as number };
        this.input = value.input as JsonValue;
        this.callTimeoutMs = value.callTimeoutMs as number;
        this.readyResolve();
        return;
      }
      if (!matches(value, this.identity)) return;
      if (value.type === 'cancelRun') { this.abort(new ProgramError('CANCELLED', 'Supervisor cancelled generation')); return; }
      if (this.ended) return;
      if (value.type === 'response') {
        if (!Number.isSafeInteger(value.callId) || typeof value.ok !== 'boolean') throw new ProgramError('PROTOCOL', 'Invalid capability response');
        const pending = this.pending.get(value.callId as number);
        if (!pending) return; // Timed-out responses cannot revive a call.
        this.pending.delete(value.callId as number);
        clearTimeout(pending.timer);
        if (value.ok && 'result' in value) pending.resolve(value.result as JsonValue);
        else pending.reject(new ProgramError(typeof value.code === 'string' ? value.code : 'CAPABILITY_FAILED', typeof value.error === 'string' ? value.error : 'Capability failed'));
      } else if (value.type === 'inbox') {
        if (value.sequence !== this.nextInboxSequence++ || !('body' in value)) throw new ProgramError('PROTOCOL', 'Invalid inbox sequence');
        this.inbox.push(value.sequence as number, value.body as JsonValue);
      } else throw new ProgramError('PROTOCOL', 'Unknown host message');
    } catch (error) { this.abort(error instanceof Error ? error : new Error(safeError(error))); }
  };

  private send(type: string, fields: Record<string, JsonValue> = {}): Promise<void> {
    if (!this.identity) return Promise.reject(new ProgramError('NO_IPC', 'Program initialization has not arrived'));
    return this.queue.send(envelope(this.identity, type, fields));
  }

  private readonly disconnected = (): void => this.abort(new ProgramError('DISCONNECTED', 'Supervisor IPC disconnected'));
  private readonly terminated = (): void => this.abort(new ProgramError('CANCELLED', 'Program process terminated'));

  private abort(error: Error): void {
    if (this.ended) return;
    this.ended = true;
    this.readyReject(error);
    this.controller.abort(error);
    this.inbox.close();
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    this.queue.close();
    process.removeListener('message', this.message);
    process.removeListener('SIGTERM', this.terminated);
    process.removeListener('SIGINT', this.terminated);
    // Exit without keeping the inherited IPC handle alive; arbitrary program timers
    // may still require the supervisor's process-group SIGKILL deadline.
    if (process.connected) process.disconnect();
  }
}

export function standaloneRun(main: ProgramMain): void {
  if (typeof main !== 'function') throw new ProgramError('INVALID_ENTRY', 'runProgram requires a main(ctx) function');
  if (root[registrationKey]) {
    if (root[registrationKey]!.main) throw new ProgramError('ALREADY_STARTED', 'Only one main may be registered');
    root[registrationKey]!.main = main;
    return;
  }
  const connection = new ChildConnection();
  void connection.execute(async () => main);
}
