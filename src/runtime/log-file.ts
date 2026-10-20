import { close, constants, ftruncate, mkdirSync, openSync, write } from 'node:fs';
import { join } from 'node:path';
import { RUNTIME_LIMITS } from './protocol.js';

/** Readable rolling capture, never a ring-encoded file or a whole-file rewrite.
 * Slow storage drops queued chunks (with a marker) rather than blocking pipes or
 * growing memory. On rollover the same file starts a new bounded tail segment.
 */
export class BoundedRunLog {
  readonly path: string;
  private readonly fd: number;
  private readonly pending: Buffer[] = [];
  private pendingBytes = 0;
  private position = 0;
  private droppedBytes = 0;
  private busy = false;
  private closing = false;
  private closed = false;
  private done?: Promise<void>;
  private complete?: () => void;

  constructor(directory: string, filename: string, private readonly onError: (error: Error) => void) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.path = join(directory, filename);
    this.fd = openSync(this.path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  }

  append(input: Buffer): void {
    if (this.closing || this.closed || !input.length) return;
    const maximum = RUNTIME_LIMITS.logPendingBytes;
    if (input.length > maximum) { this.droppedBytes += input.length - maximum; input = input.subarray(input.length - maximum); }
    while (this.pending.length && this.pendingBytes + input.length > maximum) {
      const dropped = this.pending.shift()!;
      this.pendingBytes -= dropped.length;
      this.droppedBytes += dropped.length;
    }
    // Do not retain arbitrarily large backing buffers supplied by a stream.
    const data = Buffer.from(input);
    this.pending.push(data);
    this.pendingBytes += data.length;
    this.pump();
  }

  close(): Promise<void> {
    if (this.done) return this.done;
    this.done = new Promise((resolve) => { this.complete = resolve; });
    this.closing = true;
    if (this.closed) this.complete!(); else this.pump();
    return this.done;
  }

  private pump(): void {
    if (this.busy || this.closed) return;
    let data: Buffer | undefined;
    if (this.droppedBytes) {
      data = Buffer.from(`\n[dsh capture dropped ${this.droppedBytes} bytes: storage backpressure]\n`);
      this.droppedBytes = 0;
    } else {
      data = this.pending.shift();
      if (data) this.pendingBytes -= data.length;
    }
    if (!data) {
      if (this.closing) {
        this.busy = true;
        close(this.fd, (error) => {
          this.busy = false;
          this.closed = true;
          if (error) this.onError(error);
          this.complete?.();
        });
      }
      return;
    }
    this.busy = true;
    const output = data;
    if (this.position + output.length > RUNTIME_LIMITS.logFileBytes) {
      const rollover = Buffer.from('\n[dsh capture rolled: older output discarded]\n');
      ftruncate(this.fd, 0, (error) => {
        if (error) { this.failed(error); return; }
        this.position = 0;
        this.writeBuffer(Buffer.concat([rollover, output]));
      });
    } else this.writeBuffer(output);
  }

  private writeBuffer(data: Buffer, offset = 0): void {
    write(this.fd, data, offset, data.length - offset, this.position, (error, count) => {
      if (error || count === 0) { this.failed(error ?? new Error('Log capture write made no progress')); return; }
      this.position += count;
      if (offset + count < data.length) this.writeBuffer(data, offset + count);
      else { this.busy = false; this.pump(); }
    });
  }

  private failed(error: Error): void {
    this.pending.length = 0;
    this.pendingBytes = 0;
    this.droppedBytes = 0;
    this.closing = true;
    this.busy = false;
    this.onError(error);
    this.pump();
  }
}
