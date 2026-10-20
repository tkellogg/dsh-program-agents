import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { errorFingerprint, isJson, isStandardLogRecord, MAX_LOG_LINE_BYTES, parseLogLine, redact, type JsonValue, type StandardLogRecord } from './standard.js';
import { LogSchemaRegistry } from './schemas.js';

export interface LogPointer { path?: string; offset?: number; run?: string | { id: string; generation: number } }
export interface ErrorGroup {
  fingerprint: string;
  count: number;
  sample: StandardLogRecord;
  range: { first: string; last: string };
  source?: LogPointer;
}
export interface ErrorBatch extends StandardLogRecord {
  log_type: 'dsh.program.error-batch.v1';
  data: {
    key: string;
    groups: ErrorGroup[];
    count: number;
    range: { first: string; last: string };
    dropped: number;
    [key: string]: unknown;
  } & JsonValue;
}
export interface ErrorBufferOptions {
  /** Parent supplies an owner+program-scoped key, never a global singleton. */
  key: string;
  directory: string;
  /** Resolve only when the recipient has actually accepted the batch. */
  deliver: (batch: ErrorBatch, signal?: AbortSignal) => Promise<unknown> | unknown;
  deliveryTimeoutMs?: number;
  enabled?: boolean;
  bufferMs?: number;
  maxBatch?: number;
  cooldownMs?: number;
  retryMs?: number;
  maxOutboxBytes?: number;
  maxOutboxBatches?: number;
  maxPendingGroups?: number;
  clock?: () => number;
  onError?: (error: unknown) => void;
}
interface PendingGroup extends ErrorGroup { due: number }
interface State {
  version: 1;
  key: string;
  pending: PendingGroup[];
  outbox: ErrorBatch[];
  seen: Array<[string, number]>;
  cooldown: Array<[string, number]>;
  dropped: number;
}
function number(value: number | undefined, fallback: number, minimum = 0): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error('Invalid error monitoring bound');
  return value;
}
function isStandardPointer(value: LogPointer): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return (!('path' in value) || typeof value.path === 'string') && (!('offset' in value) || Number.isSafeInteger(value.offset) && value.offset! >= 0) && (!('run' in value) || typeof value.run === 'string' || !!value.run && typeof value.run.id === 'string' && Number.isSafeInteger(value.run.generation) && value.run.generation >= 0);
}
const baseOnlyRegistry = new LogSchemaRegistry();
function sample(record: StandardLogRecord): StandardLogRecord {
  const clean = redact(record as unknown as JsonValue) as unknown as StandardLogRecord;
  if (isJson(clean,6) && Buffer.byteLength(JSON.stringify(clean)) <= 4096) return clean;
  // Retain identity and diagnostics, not large payloads, stacks or extensions.
  const result: StandardLogRecord = {timestamp:record.timestamp,level:'ERROR',log_type:record.log_type,message:record.message.slice(0,512)};
  if (record.error) result.error = {name:record.error.name.slice(0,128),message:record.error.message.slice(0,512),...(record.error.code !== undefined ? {code:typeof record.error.code === 'string' ? record.error.code.slice(0,128) : record.error.code} : {})};
  if (record.event_id) result.event_id = record.event_id.slice(0,128);
  return result;
}
/** Durable, bounded, per-program at-least-once delivery. No parent routing policy here. */
export class ErrorBuffer {
  readonly ready: Promise<void>;
  readonly outboxPath: string;
  private state: State;
  private queue: Promise<void>;
  private timer?: NodeJS.Timeout;
  private closed = false;
  private closing = false;
  private lastFailure: unknown;
  private startupFailure: unknown;
  private queuedAdds = 0;
  private ingressDropped = 0;
  private delivery?: AbortController;
  /** A deadline releases the waiter, never this real callback resource slot. */
  private activeHandler?: Promise<unknown>;
  private closeUntil = 0;
  private readonly now: () => number;
  constructor(private readonly options: ErrorBufferOptions) {
    if (!options.key || options.key.length > 1024) throw new Error('A bounded scoped ErrorBuffer key is required');
    number(options.bufferMs,1000); number(options.cooldownMs,30000); number(options.retryMs,1000,1); number(options.deliveryTimeoutMs,10_000,1);
    number(options.maxBatch,20,1); number(options.maxOutboxBytes,1024*1024,MAX_LOG_LINE_BYTES * 2);
    number(options.maxOutboxBatches,64,1); number(options.maxPendingGroups,200,1);
    this.now = options.clock ?? Date.now;
    const name = createHash('sha256').update(options.key).digest('hex');
    this.outboxPath = resolve(options.directory, `${name}.json`);
    this.state = {version:1,key:options.key,pending:[],outbox:[],seen:[],cooldown:[],dropped:0};
    this.ready = this.load();
    this.queue = this.ready.catch(error => { this.startupFailure = error; this.lastFailure = error; this.report(error); });
  }
  private report(error: unknown): void { try { this.options.onError?.(error); } catch { /* reporting cannot break durability */ } }
  private async load(): Promise<void> {
    await mkdir(resolve(this.options.directory), {recursive:true,mode:0o700});
    let text: string;
    try {
      const info = await stat(this.outboxPath);
      if (info.size > number(this.options.maxOutboxBytes,1024*1024) * 2) throw new Error('Monitoring outbox exceeds configured bound');
      text = await readFile(this.outboxPath,'utf8');
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    const decoded: unknown = JSON.parse(text);
    if (!isJson(decoded) || !decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error('Invalid monitoring outbox JSON');
    const raw = decoded as unknown as State;
    if (raw.version !== 1 || raw.key !== this.options.key || !Array.isArray(raw.pending) || !Array.isArray(raw.outbox) || !Array.isArray(raw.seen) || !Array.isArray(raw.cooldown) || !Number.isSafeInteger(raw.dropped) || raw.dropped < 0) throw new Error('Invalid monitoring outbox');
    if (raw.outbox.some(batch => !parseLogLine(JSON.stringify(batch)) || batch.log_type !== 'dsh.program.error-batch.v1') || raw.pending.some(group => !group || typeof group.fingerprint !== 'string' || !Number.isSafeInteger(group.count) || group.count < 1 || !Number.isFinite(group.due) || !group.range || typeof group.range.first !== 'string' || typeof group.range.last !== 'string' || !isStandardLogRecord(group.sample,baseOnlyRegistry))) throw new Error('Invalid monitoring outbox payload');
    if (raw.seen.some(x => !Array.isArray(x) || typeof x[0] !== 'string' || !Number.isFinite(x[1])) || raw.cooldown.some(x => !Array.isArray(x) || typeof x[0] !== 'string' || !Number.isFinite(x[1]))) throw new Error('Invalid monitoring deduplication state');
    if (raw.pending.some(group => group.source && !isStandardPointer(group.source))) throw new Error('Invalid monitoring source pointer');
    this.state = raw;
    this.trim();
    if (this.options.enabled !== false && (raw.pending.length || raw.outbox.length)) this.schedule(0);
  }
  /** Fast enqueue. flush()/close() await persistence; failures remain observable. */
  add(record: StandardLogRecord, pointer?: LogPointer): boolean {
    if (this.closed || this.closing || this.options.enabled === false || record.level !== 'ERROR' || record.log_type === 'dsh.program.error-batch.v1' || !isStandardLogRecord(record)) return false;
    if (this.queuedAdds >= number(this.options.maxPendingGroups,200,1) * 2) { this.ingressDropped++; return false; }
    this.queuedAdds++;
    const clean = sample(record);
    const eventId = record.event_id?.slice(0,1024);
    const timestamp = record.timestamp;
    const fingerprint = errorFingerprint(record);
    const now = this.now();
    const source: LogPointer = {};
    if (pointer?.path) source.path = pointer.path.slice(0,4096);
    if (pointer?.run) source.run = typeof pointer.run === 'string' ? pointer.run.slice(0,256) : {id:pointer.run.id.slice(0,256),generation:pointer.run.generation};
    if (pointer?.offset !== undefined && Number.isSafeInteger(pointer.offset) && pointer.offset >= 0) source.offset = pointer.offset;
    this.enqueue(async () => {
      try {
        if (this.startupFailure) throw this.startupFailure;
        this.state.dropped += this.ingressDropped; this.ingressDropped = 0;
        this.state.seen = this.state.seen.filter(([, until]) => until > now);
        if (eventId && this.state.seen.some(([id]) => id === eventId)) return;
        if (eventId) this.state.seen.push([eventId, now + 24*60*60*1000]);
        this.state.seen = this.state.seen.slice(-4096);
        const existing = this.state.pending.find(group => group.fingerprint === fingerprint);
        if (existing) { existing.count++; existing.range.last = timestamp; }
        else {
          const cooldown = this.state.cooldown.find(([key]) => key === fingerprint)?.[1] ?? 0;
          this.state.pending.push({fingerprint,count:1,sample:clean,range:{first:timestamp,last:timestamp},...(Object.keys(source).length ? {source} : {}),due:Math.max(now + number(this.options.bufferMs,1000),cooldown)});
        }
        this.trim(); await this.persist(); this.schedule();
      } finally { this.queuedAdds--; }
    });
    return true;
  }
  private enqueue(work: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(work).catch(error => { this.lastFailure = error; this.report(error); if (!this.startupFailure) this.schedule(number(this.options.retryMs,1000,1)); });
    return this.queue;
  }
  private trim(): void {
    const maxGroups = number(this.options.maxPendingGroups,200,1);
    while (this.state.pending.length > maxGroups) this.state.dropped += this.state.pending.shift()!.count;
    const maxBatches = number(this.options.maxOutboxBatches,64,1);
    const maxBytes = number(this.options.maxOutboxBytes,1024*1024);
    while (this.state.outbox.length > maxBatches || Buffer.byteLength(JSON.stringify(this.state)) > maxBytes) {
      if (this.state.outbox.length) { const removed = this.state.outbox.shift()!; this.state.dropped += removed.data.count + removed.data.dropped; }
      else if (this.state.pending.length) this.state.dropped += this.state.pending.shift()!.count;
      else if (this.state.seen.length) this.state.seen.shift();
      else if (this.state.cooldown.length) this.state.cooldown.shift();
      else break;
    }
    this.state.cooldown = this.state.cooldown.filter(([, until]) => until > this.now()).slice(-4096);
  }
  private async persist(): Promise<void> {
    this.trim();
    const temp = `${this.outboxPath}.tmp-${process.pid}-${randomUUID()}`;
    const file = await open(temp,'wx',0o600);
    try { await file.writeFile(JSON.stringify(this.state),'utf8'); await file.sync(); } finally { await file.close(); }
    // Resolved target is the constructor's scoped, hashed outbox path.
    await rename(temp,this.outboxPath);
  }
  private schedule(delay?: number): void {
    if (this.closed || this.closing || this.options.enabled === false) return;
    if (this.timer) clearTimeout(this.timer);
    if (delay === undefined) {
      const due = Math.min(...this.state.pending.map(group => group.due));
      delay = this.state.outbox.length ? number(this.options.retryMs,1000,1) : Math.max(0,due - this.now());
      if (!Number.isFinite(delay)) return;
    }
    this.timer = setTimeout(() => { this.timer = undefined; void this.enqueue(() => this.drain(false)); },Math.min(delay,2147483647));
    this.timer.unref();
  }
  private makeBatch(groups: PendingGroup[]): ErrorBatch {
    const first = groups.map(g => g.range.first).sort()[0];
    const last = groups.map(g => g.range.last).sort().at(-1)!;
    return {
      timestamp:new Date(this.now()).toISOString(),level:'ERROR',log_type:'dsh.program.error-batch.v1',
      message:`${groups.reduce((sum,g) => sum + g.count,0)} program error(s) in ${groups.length} group(s)`,event_id:randomUUID(),
      data:{key:this.options.key,groups:groups.map(({due:_,...group}) => group),count:groups.reduce((sum,g) => sum + g.count,0),range:{first,last},dropped:this.state.dropped},
    } as ErrorBatch;
  }
  private async deliver(batch: ErrorBatch): Promise<void> {
    if (this.activeHandler) throw new Error('Monitoring delivery callback is still active');
    const controller = new AbortController(); this.delivery = controller;
    const handler = Promise.resolve().then(() => this.options.deliver(batch,controller.signal));
    this.activeHandler = handler;
    const release = () => {
      if (this.activeHandler === handler) this.activeHandler = undefined;
      if (this.delivery === controller) this.delivery = undefined;
    };
    // Both settlement paths release the slot, without creating an unhandled rejection.
    void handler.then(release,release);
    let timeout: NodeJS.Timeout | undefined;
    let abort: (() => void) | undefined;
    try {
      const interrupted = new Promise<never>((_,reject) => {
        abort = () => reject(controller.signal.reason ?? new Error('Monitoring delivery aborted'));
        controller.signal.addEventListener('abort',abort,{once:true});
        timeout = setTimeout(() => controller.abort(new Error('Monitoring delivery deadline exceeded')),this.closing ? Math.max(1,this.closeUntil - Date.now()) : number(this.options.deliveryTimeoutMs,10_000,1));
      });
      await Promise.race([handler,interrupted]);
    } finally {
      if (timeout) clearTimeout(timeout);
      if (abort) controller.signal.removeEventListener('abort',abort);
      // Keep activeHandler/delivery until the actual callback settles, even if aborted.
    }
  }
  private async drain(force: boolean): Promise<void> {
    if (this.startupFailure) throw this.startupFailure;
    if (this.options.enabled === false) return;
    this.state.dropped += this.ingressDropped; this.ingressDropped = 0;
    const now = this.now();
    let eligible = this.state.pending.filter(group => force || group.due <= now);
    while (eligible.length) {
      const groups: PendingGroup[] = [];
      for (const group of eligible.slice(0,Math.min(20,number(this.options.maxBatch,20,1)))) {
        const candidate = this.makeBatch([...groups,group]);
        if (Buffer.byteLength(JSON.stringify(candidate)) > MAX_LOG_LINE_BYTES - 1) break;
        groups.push(group);
      }
      if (!groups.length) { const discarded = eligible[0]; this.state.dropped += discarded.count; this.state.pending = this.state.pending.filter(g => g !== discarded); }
      else {
        const batch = this.makeBatch(groups); this.state.dropped = 0;
        this.state.pending = this.state.pending.filter(g => !groups.includes(g));
        for (const group of groups) {
          this.state.cooldown = this.state.cooldown.filter(([key]) => key !== group.fingerprint);
          this.state.cooldown.push([group.fingerprint,now + number(this.options.cooldownMs,30000)]);
        }
        this.state.outbox.push(batch);
      }
      eligible = this.state.pending.filter(group => force || group.due <= now);
    }
    // Persist before attempting delivery. An interrupted receipt can replay an event_id.
    await this.persist();
    if (force && this.closing) this.closeUntil = Date.now() + 100;
    while (this.state.outbox.length && (!this.closing || Date.now() < this.closeUntil)) {
      const batch = this.state.outbox[0];
      try { await this.deliver(batch); }
      catch (error) { this.report(error); break; }
      this.state.outbox.shift(); await this.persist();
    }
    this.schedule();
  }
  /** Await queued ingestion becoming durable without forcing delivery/cooldown. */
  async checkpoint(): Promise<void> {
    await this.queue;
    if (this.lastFailure) { const error = this.lastFailure; this.lastFailure = undefined; throw error; }
  }
  /** Force the normal buffer window, but preserve per-fingerprint cooldown. */
  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    await this.enqueue(async () => {
      const now = this.now();
      for (const group of this.state.pending) {
        const cooldown = this.state.cooldown.find(([key]) => key === group.fingerprint)?.[1] ?? 0;
        if (cooldown <= now) group.due = now;
      }
      await this.drain(false);
    });
    if (this.lastFailure) { const error = this.lastFailure; this.lastFailure = undefined; throw error; }
  }
  /** Final errors bypass cooldown; rejected deliveries stay on disk for restart. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closing = true; this.closeUntil = Date.now() + 100;
    this.delivery?.abort(new Error('Monitoring is closing; delivery retained for restart'));
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    await this.enqueue(() => this.drain(true));
    this.closed = true;
    if (this.lastFailure) { const error = this.lastFailure; this.lastFailure = undefined; throw error; }
  }
}
