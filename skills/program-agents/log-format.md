# Versioned structured JSONL logging and monitoring

## Wire standard v1

A log is UTF-8 JSON Lines: exactly one JSON object per newline. The standard base is:

```ts
interface StandardLogRecord {
  timestamp: string; // ISO/RFC3339 date-time with timezone
  level: 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR';
  log_type: string;
  message: string;
  operation_id?: string;
  event_id?: string;
  error?: { name: string; message: string; stack?: string;
            code?: string | number; fingerprint?: string };
  data?: JsonValue;
  fatal?: boolean;
  [extension: string]: unknown; // finite JSON values only
}
```

`log_type` identifies an immutable, versioned semantic payload schema, not severity. Examples: `dsh.program.error.v1`, `dsh.http.request.v1`, `com.example.inventory.sync.v1`. Use a lowercase dotted namespace ending in `.vN`, with N a positive integer; applications should use their own reverse-DNS prefix. Schema changes require a new version, never reinterpret the same name. The `dsh` namespace is reserved for core contracts.

`parseLogLine(line, registry?)` returns a valid record or `undefined`. It rejects malformed JSON, invalid base fields, lines over 64 KiB (UTF-8 bytes), nesting deeper than 32, non-finite numbers and invalid **known** payloads. Unknown correctly namespaced/versioned types are accepted when the base and JSON are valid. Unknown extension fields are allowed. Runtime JSON validation rejects loss-prone direct callers (`undefined`, Date/class instances, sparse arrays, cycles). ERROR detection uses `level === 'ERROR'` under **any** log type. `fatal` and `data.unhandled` are optional advisory metadata, not prerequisites for reporting. Batch records themselves are not fed back into error monitoring.

The standalone base [JSON Schema](schemas/standard-log-record.v1.schema.json) describes the full record. The other schemas describe only the `data` payload:

| Type | Data contract |
| --- | --- |
| `dsh.program.error.v1` | Optional extensible object ([schema](schemas/dsh.program.error.v1.schema.json)); errors may also omit `error`. |
| `dsh.http.request.v1` | Required `method`, `path`, `status` (100–599); optional nonnegative `duration_ms`; extensions allowed ([schema](schemas/dsh.http.request.v1.schema.json)). |
| `dsh.program.error-batch.v1` | Required scoped `key`, `groups`, total `count`, timestamp `range`, `dropped` ([schema](schemas/dsh.program.error-batch.v1.schema.json)). |

`LogSchemaRegistry.register(logType, payloadSchema, {optional?})` validates known payloads without heavyweight dependencies. Registering an identical schema again is allowed; replacing a schema throws. `get()` returns a copy. Supported JSON Schema subset: type, properties, required, additionalProperties, items, enum, const, oneOf, min/maxLength, minimum/maximum, min/maxItems, pattern and descriptive metadata. Unsupported keywords fail registration rather than silently weakening validation. A new registry has no core definitions; use `defaultLogRegistry` for built-ins or register the exported core payload schemas explicitly. Schemas are trusted host/app configuration, not log-provided instructions.

## Application logger

Register global handlers explicitly with `installGlobalErrorHandlers(logger,{timeoutMs:500})` (exported by `/monitoring` and `/app`). It logs one standard fatal ERROR for uncaught exceptions/rejections, attempts a bounded flush, then exits nonzero. It never swallows a corrupted process or resumes execution. Disable by calling the returned disposer during orderly shutdown; do not register duplicate global handlers. The host also emits a synthetic process ERROR on nonzero exit, covering uninstrumented programs. A watched worker's fatal ERROR is monitored even when its watcher remains alive.

```ts
import { createLogger } from '@tkellogg/dsh-program-agents/monitoring';
const logger = createLogger({ logsPath: './logs', stdout: true, private: true });
logger.info('request complete', { method: 'GET', path: '/health', status: 200 },
            { log_type: 'dsh.http.request.v1', operation_id: 'request-42' });
logger.error('inventory sync failed', { warehouse: 'west' }, {
  log_type: 'com.example.inventory.sync.v1', error: new Error('timeout'), fatal: false,
});
await logger.flush();
await logger.close();
```

Exports: `createLogger(options?)`, `StructuredLogger`, `.debug/info/warn/error(message, data?, metadata?)`, `.record(fullRecord)`, `.flush()`, `.close()`. Methods synchronously validate/enqueue and return the emitted record. `warn` emits `WARNING`. ERROR defaults to `dsh.program.error.v1`; other convenience methods default to `dsh.program.log.v1`. Metadata can provide namespaced type, operation ID, event ID, normalized Error, timestamp and JSON extensions. `record` preserves the supplied severity. A new event ID is generated when absent, and both stdout and file receive exactly the same bytes/event ID. Callers can use it to suppress duplicate transport observations.

Default output is stdout; file output is opt-in. `logsPath: './logs'` writes `./logs/app-log.jsonl`; alternatively set `file` to an exact filename (not both). `stdout: false` enables file-only logging. `stdout` may also be a Writable for embedding. Rotation occurs at a UTC day boundary or before exceeding `maxBytes` (default 10 MiB); `maxFiles` defaults to five **total**, active file plus `.1` through `.4`, newest first. One valid record may exceed a configured tiny rotation size but never 64 KiB. Set `private: true` for 0700 newly created directories/0600 active files. File writes are serialized, handles closed after each write, and errors surface from flush/close. Existing directory permissions are not changed.

Stdout respects write callbacks/backpressure through one serialized writer; its queue is bounded (`maxQueueBytes`, default 1 MiB). Overflow throws rather than silently dropping or accumulating unbounded promises. Flush before producing more. Caller-owned stdout is not ended on close. File is written before stdout so a blocked stdout does not prevent the current record reaching the file.

Common credential keys are recursively redacted, case/separator-insensitively, including password/passphrase, secret/client secret, API/private keys, access/refresh/ID tokens, authorization, cookies and credentials. **All header objects are redacted**, not merely Authorization. Redaction also applies to extensions and error metadata. This is defense in depth: arbitrary free-text messages, URLs, error stacks and unusual key names can still contain secrets; never supply credentials in them.

The deterministic SHA-256 error fingerprint covers `[log_type, message, error.name, error.message, error.code]`. It excludes timestamp, stack, event ID, source and arbitrary data. Incoming fingerprint claims are not trusted for grouping. Errors without an `error` object are still reported and grouped; the logger creates a normalized error object for ERROR convenience output.

## Parent-owned ErrorBuffer

```ts
const buffer = new ErrorBuffer({
  key: `${ownerId}:${programName}`, // stable across runs, scoped to parent+program
  directory: monitoringStateDirectory,
  deliver: async (batch, signal) => { /* route and await actual accepted receipt */ },
  bufferMs: 1000, cooldownMs: 30_000, maxBatch: 20,
});
await buffer.ready;
buffer.add(record, { path: logPath, offset: byteOffset,
                     run: { id: runId, generation: 1 } });
await buffer.checkpoint(); // input durable, without forcing delivery
await buffer.flush();      // force buffer window, preserve fingerprint cooldown
await buffer.close();      // capture stop errors, bypass cooldown, bounded final delivery
```

This module does not choose supervisor agents or launch LLM calls. The parent supplies the delivery callback and routing policy. Use a distinct stable `key` per owner+program, and instantiate saved keys at startup to drain persisted work even if a program is not restarted. One live writer owns each key; a second concurrent instance for the same key is unsupported.

Only valid ERROR records enter. Repeated event IDs (stdout plus file, or replay) are suppressed for 24 hours with a bounded 4096-entry cache. Without event IDs, equal fingerprints group as occurrences rather than pretending exact-once deduplication. Different occurrences of the same fingerprint increment counts/ranges. Normal delivery waits one second; after a delivery batch is queued, repeated fingerprints are retained until their 30-second cooldown expires, not silently discarded. `flush` makes ordinary groups eligible immediately but preserves cooldown. Shutdown turns all remaining groups into durable outbox batches and allows at most 100 ms for final callbacks; unresolved deliveries stay on disk.

Batches are full standard ERROR records with `log_type: 'dsh.program.error-batch.v1'`, unique stable `event_id`, and data containing:

- `key`, total occurrence `count`, first/last timestamp `range`, and capacity-loss `dropped`;
- at most 20 `groups`, each with fingerprint, count, representative redacted `sample`, range, and optional `{path, offset, run}` source;
- at most 64 KiB total encoded batch. Large samples are reduced to identity/message/error fields (payload/stack/extensions omitted) rather than copying a large log payload into every notification.

Pending groups, dedup IDs, cooldowns and outbox are atomically replaced in a private per-key JSON state file; writes fsync before replacement. `checkpoint`/`flush` surface filesystem/load failures. Malformed state is not overwritten silently. Successful callback receipt removes a batch only after delivery; rejection/deadline retains it and retries (`retryMs`, default 1 s). The delivery timeout defaults to 10 s (`deliveryTimeoutMs`) and an optional AbortSignal lets cooperating hosts cancel. Close aborts the current callback and bounds final attempts. Each buffer retains exactly one real callback resource slot until that callback actually settles, even after a deadline or cancellation. Retries/flushes cannot launch overlapping replacement callbacks while that slot is occupied; the outbox remains durable. Noncooperative callbacks can continue externally but cannot accumulate unbounded parallel work or prevent bounded close. Once the callback settles, normal retries resume with the same batch event ID.

The outbox is bounded (`maxOutboxBytes`: default 1 MiB; `maxOutboxBatches`: 64); pending groups default to 200. Async ingress is bounded to twice the pending-group limit. Overflow evicts oldest work and records occurrence loss in `dropped`; add returns false on ingress overflow/disabled/invalid records. Loss counts persist and appear in the next emitted batch. This is bounded **at-least-once**, not exactly-once: an interrupted acknowledgment may replay the same batch event ID. The recipient should persist an acceptance receipt keyed by event ID. Disk failure/power loss before checkpoint is not a durability acknowledgment.

## Tail-able files

`LogTailer` (alias `JsonlMonitor`) accepts `{logsPath, onRecord, readExisting?, pollMs?, run?, cursorPath?, onError?}` and exposes `.ready`, `.poll()` and `.close()`. A directory follows its `app-log.jsonl`; an explicit file path follows that file. An absent path ending in `.jsonl` is treated as a file, otherwise as a directory. Prefer existing paths or `.jsonl` filenames to avoid ambiguity.

By default existing content is skipped (initial EOF) to prevent historical alert replay. `readExisting: true` starts at byte zero. Files created after attachment start at byte zero. Attach and await `.ready` **before launching** the process to capture immediate current-run file errors while keeping historical replay disabled. Stdout capture may independently ingest errors before file attachment.

Reads are bounded to 64 KiB chunks and 512 KiB per poll, never full-file reads; partial lines retain at most 64 KiB. Oversized/malformed lines are ignored until a newline. A 250 ms default timer is acceptable file following, not UI polling. Inode changes drain the old open inode before attaching its replacement; shrinking files reset the decoder/offset for copy-truncate rotation. A truncate-and-regrow that exceeds the previous size entirely between observations cannot be reliably detected using stat alone. Renamed old-file late writes after switching are not followed indefinitely.

Optional `cursorPath` atomically persists completed-line offsets by inode/device. On restart matching cursors resume rather than initial-seeking EOF. Callback promises are awaited before cursor advancement: when feeding a durable ErrorBuffer, call `add`, then return/await `buffer.checkpoint()` from `onRecord`. Callback failure replays the bounded uncommitted chunk; persisted event IDs suppress duplicate observations. Invalid lines can advance cursors. Partial lines never do. Cursor files contain only pointers, not records; the buffer's durable pending/outbox owns delivery. Close does a final bounded poll, clears timers, closes handles and awaits callbacks. Close the tailer before the buffer so final file errors are captured.
