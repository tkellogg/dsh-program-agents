import { open, stat, mkdir, rename, type FileHandle } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { JsonlDecoder, MAX_LOG_LINE_BYTES, type StandardLogRecord } from './standard.js';
import type { LogPointer } from './error-buffer.js';

export interface LogTailerOptions {
  logsPath: string;
  onRecord: (record: StandardLogRecord, pointer: LogPointer) => unknown | Promise<unknown>;
  /** Existing history is skipped by default. Newly created files always start at zero. */
  readExisting?: boolean;
  pollMs?: number;
  run?: LogPointer['run'];
  /** Optional durable completed-line cursor; ErrorBuffer event IDs dedup replay. */
  cursorPath?: string;
  onError?: (error: unknown) => void;
}
interface Cursor { version: 1; path: string; dev: number; ino: number; offset: number }
/** Bounded file reads, inode-aware rotation, truncation and partial-line handling. */
export class LogTailer {
  readonly ready: Promise<void>;
  private path: string;
  private handle?: FileHandle;
  private identity?: {dev:number;ino:number};
  private offset = 0;
  private committed = 0;
  private cursor?: Cursor;
  private first = true;
  private closed = false;
  private timer?: NodeJS.Timeout;
  private work: Promise<void> = Promise.resolve();
  private decoder: JsonlDecoder;
  private records: Array<{record:StandardLogRecord;offset:number}> = [];
  constructor(private readonly options: LogTailerOptions) {
    if (options.pollMs !== undefined && (!Number.isSafeInteger(options.pollMs) || options.pollMs < 1)) throw new Error('Invalid polling interval');
    this.path = resolve(options.logsPath);
    this.decoder = new JsonlDecoder((record,offset) => this.records.push({record,offset}));
    this.ready = this.start();
  }
  private report(error: unknown): void { try { this.options.onError?.(error); } catch {} }
  private async start(): Promise<void> {
    try { if ((await stat(this.path)).isDirectory()) this.path = resolve(this.path,'app-log.jsonl'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; if (!/\.jsonl$/i.test(this.path)) this.path = resolve(this.path,'app-log.jsonl'); }
    if (this.options.cursorPath) {
      try {
        const handle = await open(resolve(this.options.cursorPath),'r');
        try {
          if ((await handle.stat()).size > 8192) throw new Error('Oversize log cursor');
          const cursor = JSON.parse(await handle.readFile('utf8')) as Cursor;
          if (cursor.version === 1 && cursor.path === this.path && Number.isSafeInteger(cursor.dev) && Number.isSafeInteger(cursor.ino) && Number.isSafeInteger(cursor.offset) && cursor.offset >= 0) this.cursor = cursor;
        } finally { await handle.close(); }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    await this.poll();
    if (!this.closed) { this.timer = setInterval(() => { void this.poll().catch(error => this.report(error)); },this.options.pollMs ?? 250); this.timer.unref(); }
  }
  /** Exposed for deterministic shutdown/tests; overlapping polls serialize. */
  poll(): Promise<void> {
    this.work = this.work.then(() => this.closed ? undefined : this.tick());
    this.work = this.work.catch(error => { this.report(error); throw error; });
    // Preserve a recoverable queue after transient filesystem/callback failures.
    const result = this.work; this.work = result.catch(() => {}); return result;
  }
  private async attach(): Promise<boolean> {
    let handle: FileHandle;
    try { handle = await open(this.path,'r'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { this.first = false; return false; } throw error; }
    const info = await handle.stat();
    if (!info.isFile()) { await handle.close(); return false; }
    this.handle = handle; this.identity = {dev:info.dev,ino:info.ino};
    const cursorMatches = this.cursor && this.cursor.dev === info.dev && this.cursor.ino === info.ino && this.cursor.offset <= info.size;
    this.offset = cursorMatches ? this.cursor!.offset : this.first && !this.options.readExisting ? info.size : 0;
    this.committed = this.offset; this.first = false; this.decoder.reset();
    if (this.offset > 0 && !cursorMatches) {
      const last = Buffer.alloc(1); await handle.read(last,0,1,this.offset - 1);
      if (last[0] !== 10) this.decoder.discardPartialLine();
    }
    return true;
  }
  private async readAvailable(): Promise<boolean> {
    const handle = this.handle!;
    const info = await handle.stat();
    if (info.size < this.offset) { this.offset = 0; this.committed = 0; this.decoder.reset(); }
    const chunk = Buffer.alloc(MAX_LOG_LINE_BYTES);
    // Maximum 512 KiB per poll, regardless of file size.
    for (let i = 0; i < 8; i++) {
      const {bytesRead} = await handle.read(chunk,0,chunk.length,this.offset);
      if (!bytesRead) return true;
      const start = this.offset;
      this.decoder.push(chunk.subarray(0,bytesRead),start);
      this.offset += bytesRead;
      const records = this.records; this.records = [];
      try {
        for (const {record,offset} of records) await this.options.onRecord(record,{path:this.path,offset,...(this.options.run ? {run:this.options.run} : {})});
      } catch (error) {
        // Replay this bounded chunk on callback failure; event_id consumers dedup.
        this.offset = this.committed; this.decoder.reset(); throw error;
      }
      // Commit through the last newline, including malformed/oversize lines.
      const newline = chunk.subarray(0,bytesRead).lastIndexOf(10);
      if (newline >= 0) this.committed = start + newline + 1;
      await this.persistCursor();
      if (bytesRead < chunk.length) return true;
    }
    return false;
  }
  private async persistCursor(): Promise<void> {
    if (!this.options.cursorPath || !this.identity) return;
    const target = resolve(this.options.cursorPath);
    await mkdir(dirname(target),{recursive:true,mode:0o700});
    const temp = `${target}.tmp-${process.pid}`;
    const handle = await open(temp,'w',0o600);
    try { await handle.writeFile(JSON.stringify({version:1,path:this.path,...this.identity,offset:this.committed})); await handle.sync(); }
    finally { await handle.close(); }
    // Target is the resolved configured cursor path.
    await rename(temp,target);
  }
  private async tick(): Promise<void> {
    if (!this.handle && !await this.attach()) return;
    const eof = await this.readAvailable();
    let current;
    try { current = await stat(this.path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return; }
    if (this.identity?.dev === current.dev && this.identity.ino === current.ino || !eof) return;
    await this.handle!.close(); this.handle = undefined; this.decoder.reset();
    if (await this.attach()) await this.readAvailable();
  }
  async close(): Promise<void> {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    try { await this.ready; await this.poll(); }
    finally {
      this.closed = true;
      if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
      await this.work;
      if (this.handle) { await this.handle.close(); this.handle = undefined; }
    }
  }
}
export { LogTailer as JsonlMonitor };
