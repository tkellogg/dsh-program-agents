import type { Serializable } from 'node:child_process';
import type { JsonValue } from '../types.js';

/** Fixed hard ceilings apply independently to each process/generation. */
export const RUNTIME_LIMITS = Object.freeze({
  ipcBytes: 64 * 1024,
  jsonDepth: 32,
  jsonNodes: 10_000,
  pendingCalls: 32,
  queuedSends: 64,
  inbox: 64,
  logs: 200,
  logBytes: 128 * 1024,
  logEntryBytes: 4096,
  logFileBytes: 16 * 1024 * 1024,
  logPendingBytes: 256 * 1024,
  definitions: 256,
  messages: 100,
  resources: 32,
  parentMessagesPerSecond: 10,
  protocolMessagesPerSecond: 256,
  statusLength: 1024,
  labelLength: 256,
});

export class ProgramError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ProgramError';
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function assertJson(value: unknown): asserts value is JsonValue {
  let nodes = 0;
  const seen = new Set<object>();
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > RUNTIME_LIMITS.jsonNodes || depth > RUNTIME_LIMITS.jsonDepth) {
      throw new ProgramError('LIMIT', 'JSON complexity limit exceeded');
    }
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || item === null || seen.has(item)) {
      throw new ProgramError('INVALID_JSON', 'Expected finite, acyclic JSON data');
    }
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
      throw new ProgramError('INVALID_JSON', 'Expected plain JSON objects');
    }
    seen.add(item);
    if (Array.isArray(item)) {
      for (let i = 0; i < item.length; i++) {
        if (!(i in item)) throw new ProgramError('INVALID_JSON', 'Sparse arrays are not JSON');
        visit(item[i], depth + 1);
      }
    } else {
      for (const key of Object.keys(item)) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
        if (!('value' in descriptor)) throw new ProgramError('INVALID_JSON', 'JSON accessors are not supported');
        visit(descriptor.value, depth + 1);
      }
    }
    seen.delete(item);
  };
  visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > RUNTIME_LIMITS.ipcBytes) {
    throw new ProgramError('LIMIT', 'JSON byte limit exceeded');
  }
}

export function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function safeError(error: unknown): string {
  let message: string;
  try { message = error instanceof Error ? error.message : String(error); }
  catch { message = 'Unknown error'; }
  return message.slice(0, RUNTIME_LIMITS.statusLength);
}

export function validName(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_.:-]{0,127}$/.test(value);
}

export interface Identity {
  runId: string;
  generation: number;
  token: string;
}

export interface Envelope extends Identity {
  v: 1;
  type: string;
  [key: string]: JsonValue;
}

export function envelope(identity: Identity, type: string, fields: Record<string, JsonValue> = {}): Envelope {
  const value = { ...fields, ...identity, v: 1 as const, type };
  assertJson(value);
  return value;
}

/** Named methods have exact boundaries, not arbitrary extra identity/authority fields. */
export function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key));
}

export function matches(message: Record<string, unknown>, identity: Identity): boolean {
  return message.v === 1 && message.runId === identity.runId && message.generation === identity.generation && message.token === identity.token;
}

/** An IPC write stays counted until Node's callback; never queue an unbounded backlog. */
export class SendQueue {
  private pending = 0;
  private closed = false;
  private readonly rejects = new Set<(error: Error) => void>();

  constructor(private readonly transport: {
    connected?: boolean;
    send?: (message: Serializable, callback: (error: Error | null) => void) => boolean;
  }) {}

  assertWritable(): void {
    if (this.closed || !this.transport.connected || !this.transport.send) throw new ProgramError('DISCONNECTED', 'Program IPC is closed');
    if (this.pending >= RUNTIME_LIMITS.queuedSends) throw new ProgramError('BACKPRESSURE', 'Program IPC send queue is full');
  }

  send(message: JsonValue | Envelope): Promise<void> {
    try { this.assertWritable(); assertJson(message); } catch (error) { return Promise.reject(error); }
    this.pending++;
    return new Promise<void>((resolve, reject) => {
      let done = false;
      const finish = (error?: Error | null) => {
        if (done) return;
        done = true;
        this.pending--;
        this.rejects.delete(cancel);
        if (error) reject(error); else resolve();
      };
      const cancel = (error: Error) => finish(error);
      this.rejects.add(cancel);
      try { this.transport.send!(message as Serializable, finish); } catch (error) { finish(error instanceof Error ? error : new Error(safeError(error))); }
    });
  }

  close(reason = 'Program IPC is closed'): void {
    this.closed = true;
    for (const reject of this.rejects) reject(new ProgramError('DISCONNECTED', reason));
  }
}
