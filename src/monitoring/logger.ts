import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, stat, chmod } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Writable } from 'node:stream';
import { errorFingerprint, isJson, isStandardLogRecord, MAX_LOG_LINE_BYTES, redact, type JsonValue, type LogLevel, type StandardLogError, type StandardLogRecord } from './standard.js';
import { defaultLogRegistry, type LogSchemaRegistry } from './schemas.js';

export interface LoggerOptions {
  stdout?: boolean | Writable;
  /** Opt-in file output; logsPath is a directory containing app-log.jsonl. */
  file?: string;
  logsPath?: string;
  maxBytes?: number;
  /** Total file count, including the active file. Defaults to 5. */
  maxFiles?: number;
  private?: boolean;
  maxQueueBytes?: number;
  clock?: () => Date;
  registry?: LogSchemaRegistry;
}
export interface LogMetadata {
  log_type?: string;
  timestamp?: string;
  operation_id?: string;
  event_id?: string;
  error?: StandardLogError | Error;
  fatal?: boolean;
  [extension: string]: unknown;
}
function positive(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${name}`);
  return value;
}
function normalizeError(error: StandardLogError | Error): StandardLogError {
  if (!(error instanceof Error)) return error;
  const result: StandardLogError = { name:error.name, message:error.message };
  if (error.stack) result.stack = error.stack;
  const code = (error as Error & { code?: unknown }).code;
  if (typeof code === 'string' || typeof code === 'number') result.code = code;
  return result;
}
class RotatingFile {
  private bytes = 0;
  private day = '';
  private initialized = false;
  readonly path: string;
  constructor(file: string, private readonly options: LoggerOptions) { this.path = resolve(file); }
  async write(line: string, now: Date): Promise<void> {
    if (!this.initialized) {
      await mkdir(dirname(this.path), { recursive:true, ...(this.options.private ? {mode:0o700} : {}) });
      try { const s = await stat(this.path); this.bytes = s.size; this.day = s.mtime.toISOString().slice(0,10); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      this.initialized = true;
    }
    const today = now.toISOString().slice(0,10);
    const length = Buffer.byteLength(line);
    if (this.bytes && (this.bytes + length > positive(this.options.maxBytes, 10 * 1024 * 1024, 'maxBytes') || this.day !== today)) {
      const count = positive(this.options.maxFiles, 5, 'maxFiles');
      if (count === 1) { const f = await open(this.path, 'w', this.options.private ? 0o600 : 0o666); await f.close(); }
      else {
        // Every target is the resolved configured path plus a fixed numeric suffix.
        for (let i = count - 2; i >= 0; i--) {
          const from = i === 0 ? this.path : `${this.path}.${i}`;
          const to = `${this.path}.${i + 1}`;
          try { await rename(from, to); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
      }
      this.bytes = 0;
    }
    const handle = await open(this.path, 'a', this.options.private ? 0o600 : 0o666);
    try { if (this.options.private) await chmod(this.path, 0o600); await handle.writeFile(line, 'utf8'); }
    finally { await handle.close(); }
    this.bytes += length; this.day = today;
  }
}
/** Serialized writes respect stdout backpressure, with a bounded application queue. */
export class StructuredLogger {
  private queue: Promise<void> = Promise.resolve();
  private pendingBytes = 0;
  private failure: unknown;
  private closed = false;
  private readonly file?: RotatingFile;
  private readonly stdout?: Writable;
  constructor(private readonly options: LoggerOptions = {}) {
    positive(options.maxBytes, 10 * 1024 * 1024, 'maxBytes');
    positive(options.maxFiles, 5, 'maxFiles');
    positive(options.maxQueueBytes, 1024 * 1024, 'maxQueueBytes');
    if (options.file && options.logsPath) throw new Error('Use file or logsPath, not both');
    const file = options.file ?? (options.logsPath ? resolve(options.logsPath, 'app-log.jsonl') : undefined);
    if (file) this.file = new RotatingFile(file, options);
    this.stdout = options.stdout === false ? undefined : options.stdout && typeof options.stdout !== 'boolean' ? options.stdout : process.stdout;
  }
  debug(message: string, data?: JsonValue, metadata?: LogMetadata): StandardLogRecord { return this.log('DEBUG', message, data, metadata); }
  info(message: string, data?: JsonValue, metadata?: LogMetadata): StandardLogRecord { return this.log('INFO', message, data, metadata); }
  warn(message: string, data?: JsonValue, metadata?: LogMetadata): StandardLogRecord { return this.log('WARNING', message, data, metadata); }
  error(message: string, data?: JsonValue, metadata?: LogMetadata): StandardLogRecord { return this.log('ERROR', message, data, metadata); }
  private log(level: LogLevel, message: string, data?: JsonValue, metadata: LogMetadata = {}): StandardLogRecord {
    const record = { ...metadata, timestamp:metadata.timestamp ?? (this.options.clock?.() ?? new Date()).toISOString(), level, log_type:metadata.log_type ?? (level === 'ERROR' ? 'dsh.program.error.v1' : 'dsh.program.log.v1'), message } as StandardLogRecord;
    if (data !== undefined) record.data = data;
    if (metadata.error) record.error = normalizeError(metadata.error);
    return this.record(record);
  }
  record(input: StandardLogRecord): StandardLogRecord {
    if (this.closed) throw new Error('Logger is closed');
    if (!isJson(input)) throw new Error('Log record must contain finite, bounded JSON values');
    const record = redact(input) as unknown as StandardLogRecord;
    record.event_id ??= randomUUID();
    if (record.level === 'ERROR') {
      record.error ??= {name:'Error',message:record.message};
      record.error.fingerprint = errorFingerprint(record);
    }
    if (!isStandardLogRecord(record, this.options.registry ?? defaultLogRegistry)) throw new Error('Invalid standard log record or registered payload');
    const line = JSON.stringify(record) + '\n';
    const size = Buffer.byteLength(line);
    if (size > MAX_LOG_LINE_BYTES) throw new Error('Log line exceeds 64 KiB');
    if (this.pendingBytes + size > positive(this.options.maxQueueBytes, 1024 * 1024, 'maxQueueBytes')) throw new Error('Log queue capacity exceeded; await flush()');
    this.pendingBytes += size;
    this.queue = this.queue.then(async () => {
      try {
        // File first: a blocked stdout must not prevent this record becoming durable.
        if (this.file) await this.file.write(line, this.options.clock?.() ?? new Date());
        if (this.stdout) await new Promise<void>((yes, no) => {
          const stream = this.stdout!;
          const onError = (error: Error) => { stream.off('error', onError); no(error); };
          stream.once('error', onError);
          try { stream.write(line, error => { stream.off('error', onError); error ? no(error) : yes(); }); }
          catch (error) { stream.off('error', onError); no(error); }
        });
      } catch (error) { this.failure ??= error; }
      finally { this.pendingBytes -= size; }
    });
    return record;
  }
  async flush(): Promise<void> { await this.queue; if (this.failure) { const error = this.failure; this.failure = undefined; throw error; } }
  async close(): Promise<void> { this.closed = true; await this.flush(); }
}
export function createLogger(options: LoggerOptions = {}): StructuredLogger { return new StructuredLogger(options); }
