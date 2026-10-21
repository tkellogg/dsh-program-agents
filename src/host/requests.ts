import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import type { JsonValue } from '../types.js';
import { assertJson, ProgramError } from '../runtime/protocol.js';
import { assertRequestPayload, createResponseValidator, DEFAULT_RESPONSE_SCHEMA, REQUEST_LIMITS, type CreateRequestOptions, type RequestRecord, type RequestScope, type RequestStatus, type RequestWaitOptions, type ResponseReceipt, type ResponseSchema, type ResponseValidator } from '../requests.js';

export type { CreateRequestOptions, RequestRecord, RequestScope, RequestStatus, RequestWaitOptions, ResponseReceipt } from '../requests.js';
export interface RequestStoreOptions {
  maxRequests?: number;
  maxPendingPerProgram?: number;
  maxPending?: number;
  clock?: () => number;
}
interface Row {
  id: string; owner_id: string; program: string; request_key: string | null;
  fingerprint: string; target: string; body: string; response_schema: string;
  prompt: string | null; status: RequestStatus; agent_id: string | null;
  created_at: number; deadline: number; dispatch_accepted_at: number | null;
  answered_at: number | null; closed_at: number | null; response: string | null;
  response_hash: string | null; response_id: string | null; error: string | null;
}
const live = (status: RequestStatus): boolean => status === 'pending' || status === 'dispatch-unknown';
function canonical(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }

/**
 * Durable request/reply state only. No transport, agent creation, dispatch retry,
 * or execution lease lives here. Reopening a store never replays pending work.
 * The first valid assigned-agent reply is irreversible, not exactly-once agent
 * execution. A transport-ambiguous request can still accept its eventual reply.
 */
export class RequestStore {
  private readonly db: DatabaseSync;
  private readonly maxRequests: number;
  private readonly maxPendingPerProgram: number;
  private readonly maxPending: number;
  private readonly clock: () => number;
  private readonly validators = new Map<string, ResponseValidator>();
  private readonly closeSignal = new AbortController();
  private closed = false;

  constructor(path: string, options: RequestStoreOptions = {}) {
    this.maxRequests = this.configLimit(options.maxRequests ?? REQUEST_LIMITS.maxRequests, 'maxRequests', REQUEST_LIMITS.maxRequests);
    this.maxPendingPerProgram = this.configLimit(options.maxPendingPerProgram ?? REQUEST_LIMITS.maxPendingPerProgram, 'maxPendingPerProgram', REQUEST_LIMITS.maxPendingPerProgram);
    this.maxPending = this.configLimit(options.maxPending ?? REQUEST_LIMITS.maxPending, 'maxPending', REQUEST_LIMITS.maxPending);
    this.clock = options.clock ?? Date.now;
    if (path !== ':memory:') { path = resolve(path); mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); }
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 1000;
      CREATE TABLE IF NOT EXISTS agent_requests (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, program TEXT NOT NULL,
        request_key TEXT, fingerprint TEXT NOT NULL, target TEXT NOT NULL,
        body TEXT NOT NULL, response_schema TEXT NOT NULL, prompt TEXT,
        status TEXT NOT NULL CHECK(status IN ('pending','answered','cancelled','expired','failed','dispatch-unknown')),
        agent_id TEXT, created_at INTEGER NOT NULL, deadline INTEGER NOT NULL,
        dispatch_accepted_at INTEGER, answered_at INTEGER, closed_at INTEGER,
        response TEXT, response_hash TEXT, response_id TEXT, error TEXT,
        UNIQUE(owner_id,program,request_key)
      );
      CREATE INDEX IF NOT EXISTS agent_requests_scope ON agent_requests(owner_id,program,status,created_at);
      CREATE INDEX IF NOT EXISTS agent_requests_deadline ON agent_requests(status,deadline);
    `);
  }

  create(scope: RequestScope, input: CreateRequestOptions): RequestRecord {
    this.checkScope(scope);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ProgramError('INVALID_INPUT', 'Expected request options');
    const requestKey = input.requestKey ?? input.requestId;
    if (input.requestKey !== undefined && input.requestId !== undefined && input.requestKey !== input.requestId) throw new ProgramError('INVALID_INPUT', 'Conflicting request idempotency keys');
    if (requestKey !== undefined) this.text(requestKey, 'request idempotency key', 256);
    assertRequestPayload(input.target); assertRequestPayload(input.body);
    if (Buffer.byteLength(JSON.stringify(input.target)) > REQUEST_LIMITS.promptBytes) throw new ProgramError('LIMIT', 'Request target exceeds 8 KiB');
    if (Buffer.byteLength(JSON.stringify(input.body)) > REQUEST_LIMITS.bodyBytes) throw new ProgramError('LIMIT', 'Request body exceeds 48 KiB');
    if (input.prompt !== undefined && (typeof input.prompt !== 'string' || Buffer.byteLength(input.prompt) > REQUEST_LIMITS.promptBytes)) throw new ProgramError('INVALID_INPUT', 'Request prompt must be a string no larger than 8 KiB');
    const timeoutMs = this.bound(input.timeoutMs ?? REQUEST_LIMITS.defaultTimeoutMs, 'timeoutMs', 1, REQUEST_LIMITS.maxTimeoutMs);
    const schema = input.responseSchema === undefined ? DEFAULT_RESPONSE_SCHEMA : input.responseSchema;
    this.validator(schema);
    // Reserve at least 8 KiB for routing identity, deadline and the reply contract.
    // Independent body/schema limits alone could persist undispatchable work.
    const content = { target: input.target, body: input.body, responseSchema: schema, prompt: input.prompt ?? null, timeoutMs };
    // Account for aggregate nodes and schema depth in a framed contract as well
    // as isolated payloads. Never accept input that cannot later be dispatched.
    assertJson({ request: content, framingReserve: Array(64).fill(null) });
    if (Buffer.byteLength(JSON.stringify(content)) > REQUEST_LIMITS.requestBytes) throw new ProgramError('LIMIT', 'Combined request input exceeds 56 KiB');
    const fingerprint = hash(canonical(content));
    return this.transaction(() => {
      const now = this.clock();
      this.expire(now);
      if (requestKey !== undefined) {
        const existing = this.keyRow(scope, requestKey);
        if (existing) {
          if (existing.fingerprint !== fingerprint) throw new ProgramError('IDEMPOTENCY_CONFLICT', 'Request idempotency key is already bound to different input');
          return this.record(existing);
        }
      }
      const pending = (this.db.prepare("SELECT count(*) AS count FROM agent_requests WHERE owner_id=? AND program=? AND status IN ('pending','dispatch-unknown')").get(scope.ownerId, scope.program) as { count: number }).count;
      if (pending >= this.maxPendingPerProgram) throw new ProgramError('BACKPRESSURE', 'Program has too many active requests');
      const global = (this.db.prepare("SELECT count(*) AS count FROM agent_requests WHERE status IN ('pending','dispatch-unknown')").get() as { count: number }).count;
      if (global >= this.maxPending) throw new ProgramError('BACKPRESSURE', 'Global active request limit reached');
      const total = (this.db.prepare('SELECT count(*) AS count FROM agent_requests').get() as { count: number }).count;
      if (total >= this.maxRequests) this.db.prepare("DELETE FROM agent_requests WHERE id IN (SELECT id FROM agent_requests WHERE status NOT IN ('pending','dispatch-unknown') ORDER BY closed_at,created_at,rowid LIMIT ?)").run(total - this.maxRequests + 1);
      if ((this.db.prepare('SELECT count(*) AS count FROM agent_requests').get() as { count: number }).count >= this.maxRequests) throw new ProgramError('BACKPRESSURE', 'Request store is full; active requests cannot be pruned');
      const id = randomUUID();
      this.db.prepare('INSERT INTO agent_requests (id,owner_id,program,request_key,fingerprint,target,body,response_schema,prompt,status,created_at,deadline) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(id, scope.ownerId, scope.program, requestKey ?? null, fingerprint, JSON.stringify(input.target), JSON.stringify(input.body), JSON.stringify(schema), input.prompt ?? null, 'pending', now, now + timeoutMs);
      return this.record(this.row(scope, id)!);
    });
  }

  /** Durable binding MUST precede dispatch. It cannot be changed or cleared. */
  assign(scope: RequestScope, id: string, agentId: string): RequestRecord {
    this.text(agentId, 'agent id', 1024);
    return this.change(scope, id, row => {
      if (row.agent_id === agentId) return;
      if (row.agent_id !== null) throw new ProgramError('ALREADY_ASSIGNED', 'Request is bound to another agent');
      this.assertLive(row);
      this.db.prepare('UPDATE agent_requests SET agent_id=? WHERE id=?').run(agentId, row.id);
    });
  }

  reply(scope: RequestScope, id: string, senderId: string, body: JsonValue): ResponseReceipt {
    this.checkScope(scope); this.text(senderId, 'sender id', 1024);
    const result = this.transaction((): ResponseReceipt | ProgramError => {
      this.expire(this.clock());
      const row = this.required(scope, id);
      if (row.agent_id === null) return new ProgramError('NOT_ASSIGNED', 'Request has not been assigned to an agent');
      if (row.agent_id !== senderId) return new ProgramError('WRONG_AGENT', 'Only the exact assigned agent may reply to this request');
      if (!live(row.status) && row.status !== 'answered') return new ProgramError(row.status === 'expired' ? 'EXPIRED' : 'REQUEST_CLOSED', `Request is ${row.status}`);
      if (row.status === 'answered') {
        try {
          assertJson(body);
          if (Buffer.byteLength(JSON.stringify(body)) <= REQUEST_LIMITS.bodyBytes && row.response_hash === hash(canonical(body))) return this.receipt(row);
        } catch { /* A malformed retry is necessarily different from the accepted JSON. */ }
        return new ProgramError('ALREADY_REPLIED', 'A different reply has already been accepted');
      }
      // Invalid replies never close the pending request or reserve a response slot.
      this.validator(JSON.parse(row.response_schema) as ResponseSchema)(body);
      const responseHash = hash(canonical(body));
      const now = this.clock();
      if (now >= row.deadline) {
        this.expire(now);
        return new ProgramError('EXPIRED', 'Request deadline has passed');
      }
      const responseId = hash(`${row.id}\0${senderId}\0${responseHash}`);
      this.db.prepare("UPDATE agent_requests SET status='answered',response=?,response_hash=?,response_id=?,answered_at=?,closed_at=?,error=NULL WHERE id=? AND status IN ('pending','dispatch-unknown')").run(JSON.stringify(body), responseHash, responseId, now, now, row.id);
      return this.receipt(this.row(scope, id)!);
    });
    if (result instanceof ProgramError) throw result;
    return result;
  }

  get(scope: RequestScope, id: string): RequestRecord | null {
    this.checkScope(scope);
    return this.transaction(() => { this.expire(this.clock()); const row = this.row(scope, id); return row ? this.record(row) : null; });
  }

  /** Lookup before create/dispatch to distinguish a recovered request from new work. */
  getByKey(scope: RequestScope, requestKey: string): RequestRecord | null {
    this.checkScope(scope); this.text(requestKey, 'request idempotency key', 256);
    return this.transaction(() => { this.expire(this.clock()); const row = this.keyRow(scope, requestKey); return row ? this.record(row) : null; });
  }

  async wait(scope: RequestScope, id: string, options: RequestWaitOptions = {}, signal?: AbortSignal): Promise<RequestRecord> {
    this.checkScope(scope);
    const waitMs = this.bound(options.waitMs ?? REQUEST_LIMITS.maxWaitMs, 'waitMs', 0, REQUEST_LIMITS.maxWaitMs);
    const end = Date.now() + waitMs;
    const combined = signal ? AbortSignal.any([signal, this.closeSignal.signal]) : this.closeSignal.signal;
    for (;;) {
      if (this.closed) throw new ProgramError('DISPOSED', 'Request store is closed');
      if (signal?.aborted) throw new ProgramError('CANCELLED', 'Request wait was cancelled');
      const row = this.get(scope, id);
      if (!row) throw new ProgramError('NOT_FOUND', 'Request not found');
      if (row.status !== 'pending' || Date.now() >= end) return row;
      try { await delay(Math.min(REQUEST_LIMITS.pollMs, Math.max(1, end - Date.now()), Math.max(1, Date.parse(row.deadline) - this.clock())), undefined, { signal: combined }); }
      catch { throw new ProgramError(this.closed ? 'DISPOSED' : 'CANCELLED', this.closed ? 'Request store is closed' : 'Request wait was cancelled'); }
    }
  }

  cancel(scope: RequestScope, id: string): RequestRecord {
    return this.change(scope, id, row => {
      if (!live(row.status)) return;
      this.db.prepare("UPDATE agent_requests SET status='cancelled',closed_at=?,error=NULL WHERE id=?").run(this.clock(), row.id);
    });
  }
  fail(scope: RequestScope, id: string, error = 'Request failed'): RequestRecord {
    return this.change(scope, id, row => {
      if (!live(row.status)) return;
      this.db.prepare("UPDATE agent_requests SET status='failed',closed_at=?,error=? WHERE id=?").run(this.clock(), this.errorText(error), row.id);
    });
  }
  dispatchUnknown(scope: RequestScope, id: string, error = 'Dispatch outcome is unknown; automatic redispatch is disabled'): RequestRecord {
    return this.change(scope, id, row => {
      if (!live(row.status)) return;
      this.db.prepare("UPDATE agent_requests SET status='dispatch-unknown',error=? WHERE id=?").run(this.errorText(error), row.id);
    });
  }
  dispatchAccepted(scope: RequestScope, id: string): RequestRecord {
    return this.change(scope, id, row => {
      if (row.agent_id === null) throw new ProgramError('NOT_ASSIGNED', 'Assign an agent before recording dispatch');
      // A reply may race ahead of the transport receipt; never overwrite it.
      if (row.dispatch_accepted_at === null) this.db.prepare('UPDATE agent_requests SET dispatch_accepted_at=? WHERE id=?').run(this.clock(), row.id);
    });
  }

  /** Inspection only, including ambiguous dispatches. Nothing here authorizes replay. */
  listPending(scope?: RequestScope): RequestRecord[] {
    if (scope) this.checkScope(scope); else this.checkOpen();
    return this.transaction(() => {
      this.expire(this.clock());
      const rows = scope
        ? this.db.prepare("SELECT * FROM agent_requests WHERE owner_id=? AND program=? AND status IN ('pending','dispatch-unknown') ORDER BY created_at,rowid").all(scope.ownerId, scope.program)
        : this.db.prepare("SELECT * FROM agent_requests WHERE status IN ('pending','dispatch-unknown') ORDER BY created_at,rowid").all();
      return (rows as unknown as Row[]).map(row => this.record(row));
    });
  }

  close(): void { if (this.closed) return; this.closed = true; this.closeSignal.abort(); this.validators.clear(); this.db.close(); }

  private change(scope: RequestScope, id: string, fn: (row: Row) => void): RequestRecord {
    this.checkScope(scope);
    const result = this.transaction((): RequestRecord | ProgramError => {
      this.expire(this.clock());
      const row = this.required(scope, id);
      try { fn(row); }
      catch (error) { if (error instanceof ProgramError) return error; throw error; }
      return this.record(this.row(scope, id)!);
    });
    if (result instanceof ProgramError) throw result;
    return result;
  }
  private expire(now: number): void {
    this.db.prepare("UPDATE agent_requests SET status='expired',closed_at=deadline,error='Request deadline has passed' WHERE status IN ('pending','dispatch-unknown') AND deadline<=?").run(now);
  }
  private assertLive(row: Row): void {
    if (!live(row.status)) throw new ProgramError(row.status === 'expired' ? 'EXPIRED' : 'REQUEST_CLOSED', `Request is ${row.status}`);
  }
  private validator(schema: ResponseSchema): ResponseValidator {
    try {
      assertJson(schema);
      if (Buffer.byteLength(JSON.stringify(schema)) > REQUEST_LIMITS.schemaBytes) throw new Error('Response schema exceeds 16 KiB');
    } catch { throw new ProgramError('INVALID_SCHEMA', 'Response schema must be finite JSON no larger than 16 KiB and depth 32'); }
    const key = canonical(schema);
    let validate = this.validators.get(key);
    if (!validate) {
      validate = createResponseValidator(schema);
      if (this.validators.size >= 128) this.validators.delete(this.validators.keys().next().value!);
      this.validators.set(key, validate);
    }
    return validate;
  }
  private row(scope: RequestScope, id: string): Row | undefined {
    this.text(id, 'request id', 256);
    return this.db.prepare('SELECT * FROM agent_requests WHERE owner_id=? AND program=? AND id=?').get(scope.ownerId, scope.program, id) as unknown as Row | undefined;
  }
  private keyRow(scope: RequestScope, key: string): Row | undefined {
    return this.db.prepare('SELECT * FROM agent_requests WHERE owner_id=? AND program=? AND request_key=?').get(scope.ownerId, scope.program, key) as unknown as Row | undefined;
  }
  private required(scope: RequestScope, id: string): Row {
    const row = this.row(scope, id);
    if (!row) throw new ProgramError('NOT_FOUND', 'Request not found');
    return row;
  }
  private record(row: Row): RequestRecord {
    return {
      id: row.id, requestId: row.id, ownerId: row.owner_id, program: row.program,
      ...(row.request_key === null ? {} : { requestKey: row.request_key }),
      target: JSON.parse(row.target) as JsonValue, body: JSON.parse(row.body) as JsonValue,
      responseSchema: JSON.parse(row.response_schema) as ResponseSchema,
      ...(row.prompt === null ? {} : { prompt: row.prompt }), status: row.status,
      ...(row.agent_id === null ? {} : { agentId: row.agent_id }),
      createdAt: new Date(row.created_at).toISOString(), deadline: new Date(row.deadline).toISOString(),
      ...(row.dispatch_accepted_at === null ? {} : { dispatchAcceptedAt: new Date(row.dispatch_accepted_at).toISOString() }),
      ...(row.answered_at === null ? {} : { answeredAt: new Date(row.answered_at).toISOString() }),
      ...(row.closed_at === null ? {} : { closedAt: new Date(row.closed_at).toISOString() }),
      ...(row.response === null ? {} : { response: JSON.parse(row.response) as JsonValue }),
      ...(row.status === 'answered' ? { receipt: this.receipt(row) } : {}),
      ...(row.error === null ? {} : { error: row.error }),
    };
  }
  private receipt(row: Row): ResponseReceipt { return { id: row.response_id!, requestId: row.id, status: 'answered', agentId: row.agent_id!, answeredAt: new Date(row.answered_at!).toISOString() }; }
  private checkOpen(): void { if (this.closed) throw new ProgramError('DISPOSED', 'Request store is closed'); }
  private checkScope(scope: RequestScope): void {
    this.checkOpen();
    if (!scope || typeof scope.ownerId !== 'string' || !scope.ownerId || scope.ownerId.length > 1024 || typeof scope.program !== 'string' || !scope.program || scope.program.length > 256) throw new ProgramError('INVALID_INPUT', 'Invalid request namespace');
  }
  private text(value: string, name: string, max: number): void { if (typeof value !== 'string' || !value || value.length > max) throw new ProgramError('INVALID_INPUT', `Invalid ${name}`); }
  private bound(value: number, name: string, min: number, max: number): number {
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new ProgramError('INVALID_INPUT', `${name} must be an integer from ${min} to ${max}`);
    return value;
  }
  private configLimit(value: number, name: string, max: number): number {
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new ProgramError('INVALID_CONFIG', `${name} must be an integer from 1 to ${max}`);
    return value;
  }
  private errorText(value: string): string { return (typeof value === 'string' ? value : 'Request failed').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 1024); }
  private transaction<T>(fn: () => T): T {
    this.checkOpen(); this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
