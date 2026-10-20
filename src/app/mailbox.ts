import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import type { JsonValue } from '../types.js';
import { assertJson, ProgramError } from '../runtime/protocol.js';

/** Namespace persists across run/watch generations. claimant must come from the host, never a request body. */
export interface MessageScope { ownerId: string; program: string; claimant?: string }
export interface MessageReceipt {
  id: string;
  status: 'accepted' | 'claimed' | 'acked';
  acceptedAt: string;
  claimedAt?: string;
  ackedAt?: string;
  leaseUntil?: string;
  attempts: number;
}
export interface InboxMessage {
  id: string;
  from: string;
  body: JsonValue;
  createdAt: string;
  correlationId?: string;
  leaseToken: string;
  receipt: MessageReceipt;
}
export interface ReceiveOptions { waitMs?: number; leaseMs?: number }
export interface MessageStoreOptions { maxPendingPerProgram?: number; maxMessages?: number; clock?: () => number }
interface Row {
  id: string; owner_id: string; program: string; sender: string; body: string;
  correlation_id: string | null; created_at: number; claimed_at: number | null;
  acked_at: number | null; lease_until: number | null; lease_token: string | null;
  claimant: string | null; attempts: number;
}

/** Durable at-least-once queue. Acceptance is not app processing; only explicit ack records that. */
export class MessageStore {
  private readonly db: DatabaseSync;
  private readonly maxPending: number;
  private readonly maxMessages: number;
  private readonly clock: () => number;
  private closed = false;

  constructor(path: string, options: MessageStoreOptions = {}) {
    this.maxPending = options.maxPendingPerProgram ?? 1000;
    this.maxMessages = options.maxMessages ?? 10_000;
    this.clock = options.clock ?? Date.now;
    if (!Number.isSafeInteger(this.maxPending) || this.maxPending < 1 || this.maxPending > 10_000 || !Number.isSafeInteger(this.maxMessages) || this.maxMessages < this.maxPending || this.maxMessages > 100_000) throw new ProgramError('INVALID_CONFIG', 'Invalid message store limits');
    if (path !== ':memory:') {
      path = resolve(path);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 1000;
      CREATE TABLE IF NOT EXISTS app_messages (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, program TEXT NOT NULL,
        sender TEXT NOT NULL, body TEXT NOT NULL, correlation_id TEXT,
        created_at INTEGER NOT NULL, claimed_at INTEGER, acked_at INTEGER,
        lease_until INTEGER, lease_token TEXT, claimant TEXT,
        attempts INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS app_messages_inbox ON app_messages(owner_id, program, acked_at, created_at);
    `);
  }

  send(scope: MessageScope, message: { from: string; body: JsonValue; correlationId?: string }): MessageReceipt {
    this.checkScope(scope);
    if (typeof message.from !== 'string' || !message.from || message.from.length > 1024 || message.correlationId !== undefined && (typeof message.correlationId !== 'string' || message.correlationId.length > 256)) throw new ProgramError('INVALID_INPUT', 'Invalid message metadata');
    assertJson(message.body);
    // Reserve framing space for id, receipt timestamps, and the opaque claim token.
    // Never accept durable work that cannot later cross the bounded bridge.
    if (Buffer.byteLength(JSON.stringify(message)) > 60 * 1024) throw new ProgramError('LIMIT', 'Inbox message exceeds 60 KiB');
    return this.transaction(() => {
      const count = this.db.prepare('SELECT count(*) AS count FROM app_messages WHERE owner_id=? AND program=? AND acked_at IS NULL').get(scope.ownerId, scope.program) as { count: number };
      if (count.count >= this.maxPending) throw new ProgramError('BACKPRESSURE', 'Program inbox is full');
      // Receipts are retained across restarts, but are a bounded operational history.
      const total = (this.db.prepare('SELECT count(*) AS count FROM app_messages').get() as { count: number }).count;
      if (total >= this.maxMessages) this.db.prepare('DELETE FROM app_messages WHERE id IN (SELECT id FROM app_messages WHERE acked_at IS NOT NULL ORDER BY acked_at LIMIT ?)').run(total - this.maxMessages + 1);
      if ((this.db.prepare('SELECT count(*) AS count FROM app_messages').get() as { count: number }).count >= this.maxMessages) throw new ProgramError('BACKPRESSURE', 'Message store is full');
      const id = randomUUID();
      this.db.prepare('INSERT INTO app_messages (id,owner_id,program,sender,body,correlation_id,created_at) VALUES (?,?,?,?,?,?,?)').run(id, scope.ownerId, scope.program, message.from, JSON.stringify(message.body), message.correlationId ?? null, this.clock());
      return this.receipt(scope, id)!;
    });
  }

  async receive(scope: MessageScope, options: ReceiveOptions = {}, signal?: AbortSignal): Promise<InboxMessage | null> {
    this.checkScope(scope);
    const waitMs = this.bound(options.waitMs ?? 0, 'waitMs', 0, 30_000);
    const leaseMs = this.bound(options.leaseMs ?? 30_000, 'leaseMs', 1, 300_000);
    const deadline = Date.now() + waitMs;
    do {
      if (signal?.aborted) throw new ProgramError('CANCELLED', 'Inbox receive was cancelled');
      this.checkScope(scope);
      const found = this.transaction(() => {
        const now = this.clock();
        const row = this.db.prepare('SELECT * FROM app_messages WHERE owner_id=? AND program=? AND acked_at IS NULL AND (lease_until IS NULL OR lease_until<=?) ORDER BY created_at,rowid LIMIT 1').get(scope.ownerId, scope.program, now) as unknown as Row | undefined;
        if (!row) return null;
        const token = randomBytes(32).toString('base64url');
        this.db.prepare('UPDATE app_messages SET claimed_at=?,lease_until=?,lease_token=?,claimant=?,attempts=attempts+1 WHERE id=?').run(now, now + leaseMs, token, scope.claimant ?? '', row.id);
        return { id: row.id, from: row.sender, body: JSON.parse(row.body) as JsonValue, createdAt: new Date(row.created_at).toISOString(), ...(row.correlation_id === null ? {} : { correlationId: row.correlation_id }), leaseToken: token, receipt: this.receipt(scope, row.id)! };
      });
      if (found || Date.now() >= deadline) return found;
      try { await delay(Math.min(100, Math.max(1, deadline - Date.now())), undefined, { signal }); }
      catch { throw new ProgramError('CANCELLED', 'Inbox receive was cancelled'); }
    } while (true);
  }

  ack(scope: MessageScope, id: string, leaseToken: string): MessageReceipt {
    return this.transaction(() => {
      const row = this.claim(scope, id, leaseToken);
      this.db.prepare('UPDATE app_messages SET acked_at=?,lease_until=NULL,lease_token=NULL,claimant=NULL WHERE id=?').run(this.clock(), row.id);
      return this.receipt(scope, id)!;
    });
  }

  nack(scope: MessageScope, id: string, leaseToken: string): MessageReceipt {
    return this.transaction(() => {
      const row = this.claim(scope, id, leaseToken);
      this.db.prepare('UPDATE app_messages SET lease_until=NULL,lease_token=NULL,claimant=NULL WHERE id=?').run(row.id);
      return this.receipt(scope, id)!;
    });
  }

  receipt(scope: MessageScope, id: string): MessageReceipt | null {
    this.checkScope(scope);
    const row = this.row(scope, id);
    if (!row) return null;
    const active = row.lease_until !== null && row.lease_until > this.clock();
    return { id: row.id, status: row.acked_at !== null ? 'acked' : active ? 'claimed' : 'accepted', acceptedAt: new Date(row.created_at).toISOString(), ...(row.claimed_at === null ? {} : { claimedAt: new Date(row.claimed_at).toISOString() }), ...(row.acked_at === null ? {} : { ackedAt: new Date(row.acked_at).toISOString() }), ...(!active ? {} : { leaseUntil: new Date(row.lease_until!).toISOString() }), attempts: row.attempts };
  }

  /** Release only this revoked run's claims; namespace and unacked messages survive. */
  releaseClaims(scope: MessageScope): void {
    this.checkScope(scope);
    this.db.prepare('UPDATE app_messages SET lease_until=NULL,lease_token=NULL,claimant=NULL WHERE owner_id=? AND program=? AND claimant=? AND acked_at IS NULL').run(scope.ownerId, scope.program, scope.claimant ?? '');
  }

  close(): void { if (this.closed) return; this.closed = true; this.db.close(); }

  private row(scope: MessageScope, id: string): Row | undefined {
    if (typeof id !== 'string' || id.length > 256) throw new ProgramError('INVALID_INPUT', 'Invalid message id');
    return this.db.prepare('SELECT * FROM app_messages WHERE owner_id=? AND program=? AND id=?').get(scope.ownerId, scope.program, id) as unknown as Row | undefined;
  }
  private claim(scope: MessageScope, id: string, token: string): Row {
    this.checkScope(scope);
    const row = this.row(scope, id);
    if (!row) throw new ProgramError('NOT_FOUND', 'Message not found');
    if (typeof token !== 'string' || !row.lease_token || Buffer.byteLength(token) !== Buffer.byteLength(row.lease_token) || !timingSafeEqual(Buffer.from(token), Buffer.from(row.lease_token)) || row.claimant !== (scope.claimant ?? '') || row.lease_until === null || row.lease_until <= this.clock() || row.acked_at !== null) throw new ProgramError('LEASE_LOST', 'Claim lease is invalid, expired, or belongs to another run');
    return row;
  }
  private checkScope(scope: MessageScope): void {
    if (this.closed) throw new ProgramError('DISPOSED', 'Message store is closed');
    if (!scope || typeof scope.ownerId !== 'string' || !scope.ownerId || scope.ownerId.length > 1024 || typeof scope.program !== 'string' || !scope.program || scope.program.length > 256 || scope.claimant !== undefined && (typeof scope.claimant !== 'string' || scope.claimant.length > 2048)) throw new ProgramError('INVALID_INPUT', 'Invalid message namespace');
  }
  private bound(value: number, name: string, min: number, max: number): number {
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new ProgramError('INVALID_INPUT', `${name} must be an integer from ${min} to ${max}`);
    return value;
  }
  private transaction<T>(fn: () => T): T {
    if (this.closed) throw new ProgramError('DISPOSED', 'Message store is closed');
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
