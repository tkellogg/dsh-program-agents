import { fork, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import type { JsonValue, ProgramDefinition, ProgramDescriptor, ProgramSnapshot, ProgramSupervisorOptions, StartProgramOptions } from '../types.js';
import { CapabilityRegistry } from './registry.js';
import { definitionCommand, normalizeDefinition, normalizeResource } from './definitions.js';
import { BoundedRunLog } from './log-file.js';
import { assertJson, envelope, exactKeys, isRecord, jsonClone, matches, ProgramError, RUNTIME_LIMITS, safeError, SendQueue, validName, type Identity } from './protocol.js';

const terminalStates = new Set(['completed', 'failed', 'stopped']);

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  // Startup may fail before start() has installed its await; retain rejection safely.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

interface PendingCall { controller: AbortController; timer: NodeJS.Timeout }
interface Run {
  snapshot: ProgramSnapshot;
  definition: ProgramDefinition;
  logFile?: BoundedRunLog;
  logClose?: Promise<void>;
  finishing: boolean;
  input: JsonValue;
  identity: Identity;
  child?: ChildProcess;
  queue?: SendQueue;
  controller: AbortController;
  hello: Deferred<ProgramSnapshot>;
  closed: Deferred<void>;
  helloReceived: boolean;
  exitObserved: boolean;
  closeObserved: boolean;
  closeProven: boolean;
  shutdownStarted: boolean;
  intended?: 'completed' | 'failed' | 'stopped';
  calls: Map<number, PendingCall>;
  lastCallId: number;
  inbox: Map<number, Deferred<void>>;
  nextInboxId: number;
  protocolWindow: number;
  protocolCount: number;
  parentWindow: number;
  parentCount: number;
  logBytes: number;
  sequence: number;
  startupTimer?: NodeJS.Timeout;
  stopTimer?: NodeJS.Timeout;
  closeTimer?: NodeJS.Timeout;
  eventTimer?: NodeJS.Timeout;
  restarting: boolean;
  bridgeRegistered?: boolean;
}

/** Process isolation for trusted programs, not an OS security sandbox. */
export class ProgramSupervisor {
  private readonly runs = new Map<string, Run>();
  private readonly definitions = new Map<string, ProgramDefinition>();
  private readonly capabilities;
  private readonly maxRuns: number;
  private readonly maxHistory: number;
  private readonly startupTimeoutMs: number;
  private readonly stopTimeoutMs: number;
  private readonly callTimeoutMs: number;
  private disposed = false;
  private disposing?: Promise<void>;
  // Includes cancelled handlers that have not cooperatively settled, even across
  // restarts. A misbehaving host extension cannot leak unlimited detached work.
  private inflightHandlers = 0;
  private readonly revokedOwners = new Set<string>();
  private readonly ownerEpochs = new Map<string, number>();
  private logDirectory?: string;

  constructor(private readonly options: ProgramSupervisorOptions) {
    if (process.platform === 'win32') throw new ProgramError('UNSUPPORTED_PLATFORM', 'Program supervision requires POSIX process-group termination; Windows is not supported');
    this.maxRuns = this.positive(options.maxRuns ?? 16, 'maxRuns');
    this.maxHistory = this.positive(options.maxHistory ?? 32, 'maxHistory', true);
    this.startupTimeoutMs = this.positive(options.startupTimeoutMs ?? 10_000, 'startupTimeoutMs');
    this.stopTimeoutMs = this.positive(options.stopTimeoutMs ?? 1000, 'stopTimeoutMs');
    this.callTimeoutMs = this.positive(options.callTimeoutMs ?? 30_000, 'callTimeoutMs');
    this.capabilities = options.capabilities ?? new CapabilityRegistry();
    if (!isRecord(options.programs) || Object.keys(options.programs).length > RUNTIME_LIMITS.definitions) throw new ProgramError('INVALID_CONFIG', 'At most 256 program definitions may be configured');
    if (options.logDirectory !== undefined) {
      if (typeof options.logDirectory !== 'string' || !options.logDirectory || options.logDirectory.includes('\0')) throw new ProgramError('INVALID_CONFIG', 'Invalid log directory');
      this.logDirectory = resolve(options.logDirectory);
    }
    if (options.bootstrapDirectory !== undefined && (typeof options.bootstrapDirectory !== 'string' || !options.bootstrapDirectory || options.bootstrapDirectory.includes('\0'))) throw new ProgramError('INVALID_CONFIG', 'Invalid bootstrap directory');
    for (const [program, definition] of Object.entries(options.programs)) this.define(program, definition);
  }

  /** Register or replace a trusted definition. Existing generations keep their definition. */
  define(program: string, definition: ProgramDefinition): void {
    this.assertAvailable();
    if (!this.definitions.has(program) && this.definitions.size >= RUNTIME_LIMITS.definitions) throw new ProgramError('LIMIT', 'Maximum configured programs reached');
    this.definitions.set(program, normalizeDefinition(program, definition));
  }

  definitionsList(): ProgramDescriptor[] {
    return [...this.definitions].map(([program, definition]) => ({
      program,
      name: definition.name ?? program,
      description: definition.description ?? '',
      command: definitionCommand(definition),
      urls: (definition.urls ?? []).map((resource) => normalizeResource(resource)),
      ...(definition.logsPath === undefined ? {} : { logsPath: definition.logsPath }),
      ...(definition.supervision === undefined ? {} : { supervision: structuredClone(definition.supervision) }),
    }));
  }

  async start(request: StartProgramOptions, signal?: AbortSignal): Promise<ProgramSnapshot> {
    this.assertAvailable();
    if (!isRecord(request) || !exactKeys(request, ['program', 'ownerId'], ['input', 'label'])) throw new ProgramError('INVALID_INPUT', 'Invalid program start request');
    const definition = this.definitions.get(request.program);
    if (!definition) throw new ProgramError('UNKNOWN_PROGRAM', `Program is not configured: ${request.program}`);
    if (typeof request.ownerId !== 'string' || !request.ownerId || request.ownerId.length > 1024) throw new ProgramError('INVALID_OWNER', 'An opaque nonempty owner id is required');
    this.assertOwner(request.ownerId);
    if (request.label !== undefined && (typeof request.label !== 'string' || request.label.length > RUNTIME_LIMITS.labelLength)) throw new ProgramError('LIMIT', 'Program label is too long');
    const input = request.input === undefined ? null : request.input;
    assertJson(input);
    if (signal?.aborted) throw new ProgramError('ABORTED', 'Program start was cancelled');
    this.assertCapacity();
    const id = randomUUID();
    const run = this.makeRun({ id, generation: 1, program: request.program, ownerId: request.ownerId, label: request.label ?? definition.name ?? request.program, state: 'starting', startedAt: new Date().toISOString(), logs: [], messages: [], resources: [] }, definition, jsonClone(input));
    this.runs.set(id, run);
    this.launch(run);
    const abort = () => this.beginShutdown(run, 'stopped', 'Program start was cancelled');
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    try { return await run.hello.promise; }
    finally { signal?.removeEventListener('abort', abort); }
  }

  list(ownerId?: string): ProgramSnapshot[] {
    return [...this.runs.values()].filter((run) => ownerId === undefined || run.snapshot.ownerId === ownerId).map((run) => this.snapshot(run));
  }

  get(id: string, ownerId?: string): ProgramSnapshot { return this.snapshot(this.lookup(id, ownerId)); }

  async send(id: string, ownerId: string, body: JsonValue): Promise<void> {
    this.assertAvailable();
    assertJson(body);
    const run = this.lookup(id, ownerId);
    if (!this.live(run) || !run.helloReceived) throw new ProgramError('NOT_RUNNING', 'Program is not running');
    if (run.definition.command) throw new ProgramError('UNSUPPORTED_OPERATION', 'Ordinary command programs have no SDK inbox');
    if (run.inbox.size >= RUNTIME_LIMITS.inbox) throw new ProgramError('BACKPRESSURE', 'Program inbox is full');
    const sequence = run.nextInboxId + 1;
    // Validation/preflight failures cannot consume a sequence: otherwise the next
    // valid message would look like a missing or reordered inbox frame.
    const message = envelope(run.identity, 'inbox', { sequence, body: jsonClone(body) });
    run.queue!.assertWritable();
    run.nextInboxId = sequence;
    const delivery = deferred<void>();
    run.inbox.set(sequence, delivery);
    try {
      await run.queue!.send(message);
      // Acknowledgment is generated only when the child consumes the message, bounding both sides.
      this.recordMessage(run, 'parent', body);
    } catch (error) {
      run.inbox.delete(sequence);
      delivery.reject(error);
      if (this.live(run)) this.beginShutdown(run, 'failed', `Inbox transport failed: ${safeError(error)}`);
      throw error;
    }
  }

  async stop(id: string, ownerId: string): Promise<ProgramSnapshot> {
    const run = this.lookup(id, ownerId);
    if (!run.closeProven) {
      this.beginShutdown(run, 'stopped');
      await run.closed.promise;
    }
    return this.snapshot(run);
  }

  async restart(id: string, ownerId: string): Promise<ProgramSnapshot> {
    this.assertAvailable();
    this.assertOwner(ownerId);
    const ownerEpoch = this.ownerEpoch(ownerId);
    const old = this.lookup(id, ownerId);
    if (old.restarting) throw new ProgramError('BUSY', 'A restart is already in progress');
    old.restarting = true;
    try {
      if (!old.closeProven) {
        this.beginShutdown(old, 'stopped');
        await old.closed.promise;
      }
      if (!old.closeProven || this.groupExists(old)) throw new ProgramError('EXIT_UNPROVEN', 'Previous process-group exit could not be proven');
      this.assertAvailable();
      this.assertOwner(ownerId);
      if (ownerEpoch !== this.ownerEpoch(ownerId)) throw new ProgramError('OWNER_REVOKED', 'The previous owner generation was revoked');
      this.assertCapacity();
      if (!Number.isSafeInteger(old.snapshot.generation + 1)) throw new ProgramError('LIMIT', 'Program generation limit reached');
      const definition = this.definitions.get(old.snapshot.program)!;
      const run = this.makeRun({ id, generation: old.snapshot.generation + 1, program: old.snapshot.program, ownerId, label: old.snapshot.label, state: 'starting', startedAt: new Date().toISOString(), logs: [], messages: [], resources: [] }, definition, old.input);
      run.restarting = true;
      this.runs.set(id, run);
      this.launch(run);
      try { return await run.hello.promise; }
      finally { run.restarting = false; }
    } finally { old.restarting = false; }
  }

  /** Revoke an owner's authority until explicit host reauthorization; fence old operations. */
  async revokeOwner(ownerId: string): Promise<void> {
    // Retain bounded tombstones so a revoked session cannot resurrect even after
    // its terminal snapshots have been evicted.
    if (!this.revokedOwners.has(ownerId)) {
      if (!this.ownerEpochs.has(ownerId) && this.ownerEpochs.size >= 4096) {
        // Fail closed rather than forget a revocation or admit unbounded memory.
        await this.dispose();
        throw new ProgramError('LIMIT', 'Owner revocation history exhausted; supervisor disposed');
      }
      this.revokedOwners.add(ownerId);
      const epoch = this.ownerEpoch(ownerId);
      if (!Number.isSafeInteger(epoch + 1)) { await this.dispose(); throw new ProgramError('LIMIT', 'Owner generation limit reached; supervisor disposed'); }
      this.ownerEpochs.set(ownerId, epoch + 1);
    }
    const runs = [...this.runs.values()].filter((run) => run.snapshot.ownerId === ownerId && !run.closeProven);
    const results = await Promise.allSettled(runs.map(async (run) => { this.beginShutdown(run, 'stopped', 'Program owner was revoked'); await run.closed.promise; }));
    const failed = results.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }

  /** Host-only reauthorization after a replacement owner is independently verified. */
  allowOwner(ownerId: string): void {
    this.assertAvailable();
    if (typeof ownerId !== 'string' || !ownerId || ownerId.length > 1024) throw new ProgramError('INVALID_OWNER', 'An opaque nonempty owner id is required');
    if (!this.revokedOwners.has(ownerId)) return;
    if ([...this.runs.values()].some((run) => run.snapshot.ownerId === ownerId && !run.closeProven)) throw new ProgramError('BUSY', 'Previous owner processes have not proven closure');
    this.revokedOwners.delete(ownerId);
    // Keep epochs so operations already awaiting old exits cannot regain authority.
  }

  dispose(): Promise<void> {
    if (this.disposing) return this.disposing;
    this.disposed = true;
    this.disposing = (async () => {
      const runs = [...this.runs.values()];
      const results = await Promise.allSettled(runs.map(async (run) => {
        if (!run.closeProven) { this.beginShutdown(run, 'stopped'); await run.closed.promise; }
      }));
      for (const run of runs) { if (run.eventTimer) clearTimeout(run.eventTimer); run.eventTimer = undefined; }
      const failed = results.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    })();
    return this.disposing;
  }

  private positive(value: number, name: string, zero = false): number {
    if (!Number.isSafeInteger(value) || value < (zero ? 0 : 1)) throw new ProgramError('INVALID_CONFIG', `${name} must be a ${zero ? 'nonnegative' : 'positive'} integer`);
    return value;
  }

  private makeRun(snapshot: ProgramSnapshot, definition: ProgramDefinition, input: JsonValue): Run {
    snapshot.name = definition.name ?? snapshot.program;
    snapshot.description = definition.description ?? '';
    snapshot.command = definitionCommand(definition);
    snapshot.resources = (definition.urls ?? []).map((resource) => normalizeResource(resource));
    if (definition.logsPath !== undefined) snapshot.logsPath = definition.logsPath;
    if (definition.supervision !== undefined) snapshot.supervision = structuredClone(definition.supervision);
    return { snapshot, definition, finishing: false, input, identity: { runId: snapshot.id, generation: snapshot.generation, token: randomBytes(24).toString('hex') }, controller: new AbortController(), hello: deferred(), closed: deferred(), helloReceived: false, exitObserved: false, closeObserved: false, closeProven: false, shutdownStarted: false, calls: new Map(), lastCallId: 0, inbox: new Map(), nextInboxId: 0, protocolWindow: Date.now(), protocolCount: 0, parentWindow: Date.now(), parentCount: 0, logBytes: 0, sequence: 0, restarting: false };
  }

  private launch(run: Run): void {
    try {
      // SDK input framing is validated before any process is created. Commands
      // have no bootstrap, IPC, implicit shell, or readiness protocol.
      const command = run.definition.command;
      const init = command ? undefined : envelope(run.identity, 'init', { input: run.input, callTimeoutMs: this.callTimeoutMs });
      this.logDirectory ??= mkdtempSync(join(tmpdir(), 'dsh-program-agents-'));
      run.logFile = new BoundedRunLog(this.logDirectory, `${run.snapshot.id}-${run.snapshot.generation}.log`, (error) => this.log(run, 'system', `Log capture failed: ${safeError(error)}`));
      run.snapshot.logsPath ??= run.logFile.path;
      const env: NodeJS.ProcessEnv = {};
      // Deliberately omit credentials, NODE_OPTIONS, and host loader/debug flags.
      // HOME enables package-manager caches for ordinary trusted watched commands.
      const inherited = ['PATH', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'TZ', ...(command ? ['HOME'] : [])];
      for (const key of inherited) if (process.env[key] !== undefined) env[key] = process.env[key];
      Object.assign(env, run.definition.env);
      // Never inherit a previous run's credentials, even from an explicit command environment.
      for (const key of Object.keys(env)) if (key.startsWith('DSH_PROGRAM_')) delete env[key];
      if (this.options.bridge) {
        // Mark before invoking so partial setup failures are also revoked.
        run.bridgeRegistered = true;
        const bridgeEnv = this.options.bridge.environment(this.snapshot(run), structuredClone(run.definition));
        if (!isRecord(bridgeEnv) || Object.keys(bridgeEnv).length > 16 || Object.entries(bridgeEnv).some(([key, value]) => !/^DSH_PROGRAM_[A-Z_]+$/.test(key) || typeof value !== 'string' || value.includes('\0') || value.length > 8192)) throw new ProgramError('INVALID_CONFIG', 'Invalid program bridge environment');
        Object.assign(env, bridgeEnv);
      }
      let child: ChildProcess;
      if (command) {
        child = spawn(command[0]!, command.slice(1), { cwd: run.definition.cwd, env, detached: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      } else {
        const directory = this.options.bootstrapDirectory;
        const built = directory === undefined ? fileURLToPath(new URL('./bootstrap.js', import.meta.url)) : resolve(directory, 'bootstrap.js');
        const bootstrap = existsSync(built) ? built : directory === undefined ? fileURLToPath(new URL('./bootstrap.ts', import.meta.url)) : resolve(directory, 'bootstrap.ts');
        // Source execution uses tsx only for .js specifiers in our TS sources.
        const execArgv = bootstrap.endsWith('.ts') ? ['--import', import.meta.resolve('tsx')] : [];
        child = fork(bootstrap, [run.definition.entry!, ...(run.definition.args ?? [])], { cwd: run.definition.cwd, env, execArgv, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'json' });
        run.queue = new SendQueue(child);
      }
      run.child = child;
      run.snapshot.pid = child.pid;
      this.attachLog(run, child.stdout, 'stdout');
      this.attachLog(run, child.stderr, 'stderr');
      if (command) child.once('spawn', () => this.ready(run));
      else child.on('message', (message) => this.onMessage(run, message));
      child.on('error', (error) => this.beginShutdown(run, 'failed', safeError(error)));
      child.on('exit', (code, signal) => {
        run.exitObserved = true;
        if (!run.intended) {
          run.intended = command && code === 0 ? 'completed' : 'failed';
          if (run.intended === 'failed') run.snapshot.error = `Program exited ${command ? '' : 'before completion '}(${signal ?? `code ${code}`})`;
        }
        this.revoke(run);
        // Natural exits must also terminate descendants, including watcher workers.
        this.signalGroup(run, 'SIGKILL');
      });
      child.on('close', () => {
        run.closeObserved = true;
        if (!run.intended) { run.intended = 'failed'; run.snapshot.error = 'Program closed before startup'; }
        this.revoke(run);
        run.logClose = run.logFile?.close();
        this.proveClosed(run);
      });
      if (!command) {
        child.on('disconnect', () => {
          if (!run.shutdownStarted && !run.closeObserved) this.beginShutdown(run, 'failed', 'Program IPC disconnected before completion');
        });
        run.startupTimer = setTimeout(() => this.beginShutdown(run, 'failed', 'Program startup hello timed out'), this.startupTimeoutMs);
        void run.queue!.send(init!).catch((error) => this.beginShutdown(run, 'failed', safeError(error)));
      }
      this.changed(run);
    } catch (error) {
      if (run.child?.pid) { this.beginShutdown(run, 'failed', safeError(error)); return; }
      run.snapshot.error = safeError(error);
      run.intended = 'failed';
      run.closeObserved = true;
      this.finishClosed(run);
    }
  }

  private ready(run: Run): void {
    if (!this.live(run) || run.helloReceived) return;
    run.helloReceived = true;
    clearTimeout(run.startupTimer);
    run.snapshot.state = 'running';
    for (const resource of run.snapshot.resources) resource.available = true;
    this.changed(run);
    run.hello.resolve(this.snapshot(run));
  }

  private attachLog(run: Run, stream: NodeJS.ReadableStream | null, name: 'stdout' | 'stderr'): void {
    if (!stream) return;
    const decoder = new StringDecoder('utf8');
    stream.on('data', (buffer: Buffer) => {
      run.logFile?.append(buffer);
      const text = decoder.write(buffer);
      this.output(run, text, name);
      // Keep only a bounded tail of each incoming chunk, while always draining the pipe.
      this.log(run, name, text);
    });
    stream.on('end', () => {
      const text = decoder.end();
      this.output(run, text, name);
      this.log(run, name, text);
    });
  }

  private output(run: Run, text: string, stream: 'stdout' | 'stderr'): void {
    if (!text || !this.options.onOutput) return;
    try { this.options.onOutput(this.snapshot(run), text, stream); }
    catch { /* Output observers cannot interrupt pipe draining or process cleanup. */ }
  }

  private log(run: Run, stream: 'stdout' | 'stderr' | 'system', text: string): void {
    if (!text) return;
    let data = Buffer.from(text, 'utf8');
    if (data.length > RUNTIME_LIMITS.logEntryBytes) data = data.subarray(data.length - RUNTIME_LIMITS.logEntryBytes);
    const bounded = data.toString('utf8');
    const bytes = Buffer.byteLength(bounded);
    run.snapshot.logs.push({ sequence: ++run.sequence, stream, text: bounded });
    run.logBytes += bytes;
    while (run.snapshot.logs.length > RUNTIME_LIMITS.logs || run.logBytes > RUNTIME_LIMITS.logBytes) run.logBytes -= Buffer.byteLength(run.snapshot.logs.shift()!.text);
    this.changed(run);
  }

  private onMessage(run: Run, value: unknown): void {
    if (!this.current(run) || !isRecord(value)) { if (this.current(run) && !run.shutdownStarted) this.protocolFailure(run, 'Malformed IPC envelope'); return; }
    try { assertJson(value); } catch (error) { this.protocolFailure(run, safeError(error)); return; }
    // Old/fabricated generation messages have no authority, even if their call id is new.
    if (!matches(value, run.identity)) return;
    if (!this.live(run)) return;
    const now = Date.now();
    if (now - run.protocolWindow >= 1000) { run.protocolWindow = now; run.protocolCount = 0; }
    if (++run.protocolCount > RUNTIME_LIMITS.protocolMessagesPerSecond) { this.protocolFailure(run, 'IPC message rate limit exceeded'); return; }
    if (value.type === 'hello') {
      if (run.helloReceived) { this.protocolFailure(run, 'Duplicate startup hello'); return; }
      this.ready(run);
      return;
    }
    if (!run.helloReceived) {
      if (value.type === 'failed') this.beginShutdown(run, 'failed', typeof value.error === 'string' ? value.error : 'Program import failed');
      else this.protocolFailure(run, 'IPC message before startup hello');
      return;
    }
    if (value.type === 'call') {
      if (!Number.isSafeInteger(value.callId) || (value.callId as number) <= run.lastCallId || !validName(value.method) || !('input' in value)) { this.protocolFailure(run, 'Invalid or repeated capability call'); return; }
      run.lastCallId = value.callId as number;
      void this.call(run, value.callId as number, value.method, value.input as JsonValue);
    } else if (value.type === 'cancel') {
      if (!Number.isSafeInteger(value.callId)) { this.protocolFailure(run, 'Invalid cancellation id'); return; }
      const pending = run.calls.get(value.callId as number);
      if (pending) { pending.controller.abort(new ProgramError('CANCELLED', 'Child cancelled capability call')); clearTimeout(pending.timer); }
    } else if (value.type === 'inboxAck') {
      if (!Number.isSafeInteger(value.sequence) || !run.inbox.has(value.sequence as number)) { this.protocolFailure(run, 'Invalid inbox acknowledgment'); return; }
      run.inbox.get(value.sequence as number)!.resolve();
      run.inbox.delete(value.sequence as number);
    } else if (value.type === 'complete') {
      if (!('result' in value)) { this.protocolFailure(run, 'Missing completion result'); return; }
      run.snapshot.result = jsonClone(value.result as JsonValue);
      this.beginShutdown(run, 'completed');
    } else if (value.type === 'failed') {
      this.beginShutdown(run, 'failed', typeof value.error === 'string' ? value.error : 'Program failed');
    } else this.protocolFailure(run, 'Unknown IPC message type');
  }

  private async call(run: Run, callId: number, method: string, input: JsonValue): Promise<void> {
    if (run.calls.size >= RUNTIME_LIMITS.pendingCalls || this.inflightHandlers >= RUNTIME_LIMITS.pendingCalls) {
      await this.reply(run, callId, false, 'Capability concurrency limit exceeded', 'LIMIT');
      return;
    }
    this.inflightHandlers++;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new ProgramError('TIMEOUT', 'Capability deadline exceeded; effect outcome may be unknown'));
      // Retain the slot until the host handler settles: cancellation is cooperative,
      // and a handler ignoring AbortSignal must not allow unbounded replacement calls.
      void this.reply(run, callId, false, 'Capability deadline exceeded; effect outcome may be unknown', 'TIMEOUT');
    }, this.callTimeoutMs);
    const pending = { controller, timer };
    run.calls.set(callId, pending);
    try {
      const output = await this.invoke(run, method, input, controller.signal);
      assertJson(output);
      // Include framing overhead in result validation. Oversized host results are
      // a call error, not a reason to kill an otherwise well-behaved program.
      envelope(run.identity, 'response', { callId, ok: true, result: output });
      if (run.calls.get(callId) === pending && !controller.signal.aborted && this.live(run)) await this.reply(run, callId, true, output);
    } catch (error) {
      if (!timedOut && run.calls.get(callId) === pending && !controller.signal.aborted && this.live(run)) await this.reply(run, callId, false, safeError(error), error instanceof ProgramError ? error.code : 'CAPABILITY_FAILED');
    } finally {
      this.inflightHandlers--;
      clearTimeout(timer);
      if (run.calls.get(callId) === pending) run.calls.delete(callId);
    }
  }

  private async invoke(run: Run, method: string, input: JsonValue, signal: AbortSignal): Promise<JsonValue> {
    if (!this.live(run) || signal.aborted) throw new ProgramError('CANCELLED', 'Generation is no longer active');
    if (method === 'capabilities.list') {
      if (input !== null) throw new ProgramError('INVALID_INPUT', 'Capability list takes null input');
      const allowed = new Set(run.definition.allowedCapabilities);
      const metadata = this.capabilities.list().filter((entry) => allowed.has(entry.name));
      assertJson(metadata);
      return metadata;
    }
    if (method === 'status.set') {
      if (!isRecord(input) || !exactKeys(input, ['state'], ['detail']) || (input.state !== 'running' && input.state !== 'blocked') || (input.detail !== undefined && (typeof input.detail !== 'string' || input.detail.length > RUNTIME_LIMITS.statusLength))) throw new ProgramError('INVALID_INPUT', 'Invalid status');
      run.snapshot.state = input.state;
      if (typeof input.detail === 'string') run.snapshot.status = input.detail; else delete run.snapshot.status;
      this.changed(run);
      return null;
    }
    if (method === 'parent.send') {
      const now = Date.now();
      if (now - run.parentWindow >= 1000) { run.parentWindow = now; run.parentCount = 0; }
      if (++run.parentCount > RUNTIME_LIMITS.parentMessagesPerSecond) throw new ProgramError('RATE_LIMIT', 'Parent notification rate limit exceeded');
      if (!this.options.onParentMessage) throw new ProgramError('UNAVAILABLE', 'Parent messaging is not configured');
      await this.options.onParentMessage(run.snapshot.ownerId, jsonClone(input), this.snapshot(run), signal);
      if (!this.live(run) || signal.aborted) throw new ProgramError('CANCELLED', 'Generation ended while notifying parent; delivery outcome may be unknown');
      this.recordMessage(run, 'program', input);
      return null;
    }
    if (method === 'resources.publish') {
      const resource = normalizeResource(input, true);
      const old = run.snapshot.resources.findIndex((other) => other.id === resource.id);
      if (old === -1 && run.snapshot.resources.length >= RUNTIME_LIMITS.resources) throw new ProgramError('LIMIT', 'Resource limit exceeded');
      if (old === -1) run.snapshot.resources.push(resource); else run.snapshot.resources[old] = resource;
      this.changed(run);
      return null;
    }
    if (method === 'resources.unpublish') {
      if (!isRecord(input) || !exactKeys(input, ['id']) || !validName(input.id)) throw new ProgramError('INVALID_INPUT', 'Invalid resource id');
      run.snapshot.resources = run.snapshot.resources.filter((resource) => resource.id !== input.id);
      this.changed(run);
      return null;
    }
    if (!run.definition.allowedCapabilities?.includes(method)) throw new ProgramError('FORBIDDEN', `Capability is not allowlisted: ${method}`);
    const capability = this.capabilities.get(method);
    if (!capability) throw new ProgramError('UNKNOWN_CAPABILITY', `Capability is not registered: ${method}`);
    return capability.handler(jsonClone(input), { run: this.snapshot(run), signal });
  }

  private async reply(run: Run, callId: number, ok: boolean, value: JsonValue, code?: string): Promise<void> {
    if (!this.live(run)) return;
    try {
      await run.queue!.send(envelope(run.identity, 'response', ok ? { callId, ok, result: value } : { callId, ok, error: value, code: code ?? 'CAPABILITY_FAILED' }));
    } catch (error) { if (this.live(run)) this.beginShutdown(run, 'failed', safeError(error)); }
  }

  private beginShutdown(run: Run, intended: 'stopped' | 'completed' | 'failed', error?: string): void {
    if (run.closeProven || run.shutdownStarted) return;
    run.shutdownStarted = true;
    run.intended = intended;
    if (error) run.snapshot.error = error.slice(0, RUNTIME_LIMITS.statusLength);
    run.snapshot.state = 'stopping';
    clearTimeout(run.startupTimer);
    run.hello.reject(new ProgramError(intended === 'stopped' ? 'ABORTED' : 'STARTUP_FAILED', error ?? 'Program stopped before startup'));
    this.revoke(run);
    this.changed(run);
    if (!run.child?.pid) {
      // A failed fork can emit close asynchronously; no process id means no group was spawned.
      run.closeObserved = true;
      this.finishClosed(run);
      return;
    }
    if (run.queue) void run.queue.send(envelope(run.identity, 'cancelRun')).catch(() => {});
    this.signalGroup(run, 'SIGTERM');
    run.stopTimer = setTimeout(() => this.signalGroup(run, 'SIGKILL'), this.stopTimeoutMs);
    run.closeTimer = setTimeout(() => {
      if (run.closeProven) return;
      this.signalGroup(run, 'SIGKILL');
      run.snapshot.state = 'failed';
      run.snapshot.error = 'Process-group exit could not be proven; restart is disabled';
      this.changed(run);
      run.closed.reject(new ProgramError('EXIT_UNPROVEN', run.snapshot.error));
    }, this.stopTimeoutMs * 2 + 1000);
  }

  private revoke(run: Run): void {
    if (run.bridgeRegistered) {
      run.bridgeRegistered = false;
      try { this.options.bridge?.revoke(this.snapshot(run)); }
      catch { /* Revocation observers cannot obstruct mandatory process cleanup. */ }
    }
    if (!run.controller.signal.aborted) run.controller.abort(new ProgramError('CANCELLED', 'Program generation ended'));
    for (const pending of run.calls.values()) { clearTimeout(pending.timer); pending.controller.abort(new ProgramError('CANCELLED', 'Program generation ended; effect outcome may be unknown')); }
    run.calls.clear();
    for (const delivery of run.inbox.values()) delivery.reject(new ProgramError('DISCONNECTED', 'Program inbox closed'));
    run.inbox.clear();
    for (const resource of run.snapshot.resources) resource.available = false;
  }

  private proveClosed(run: Run): void {
    if (run.closeProven) return;
    if (!this.groupExists(run)) { this.finishClosed(run); return; }
    this.signalGroup(run, 'SIGKILL');
    const deadline = Date.now() + this.stopTimeoutMs + 1000;
    const check = () => {
      if (run.closeProven) return;
      if (!this.groupExists(run)) { this.finishClosed(run); return; }
      if (Date.now() >= deadline) {
        run.snapshot.state = 'failed';
        run.snapshot.error = 'Process-group exit could not be proven; restart is disabled';
        this.changed(run);
        run.closed.reject(new ProgramError('EXIT_UNPROVEN', run.snapshot.error));
        return;
      }
      setTimeout(check, 25);
    };
    setTimeout(check, 25);
  }

  private finishClosed(run: Run): void {
    if (run.closeProven || run.finishing) return;
    run.finishing = true;
    clearTimeout(run.startupTimer);
    clearTimeout(run.stopTimer);
    clearTimeout(run.closeTimer);
    run.queue?.close();
    this.revoke(run);
    run.logClose ??= run.logFile?.close() ?? Promise.resolve();
    void run.logClose.then(() => {
      run.closeProven = true;
      run.closeObserved = true;
      run.snapshot.state = run.intended ?? 'failed';
      run.snapshot.endedAt = new Date().toISOString();
      run.hello.reject(new ProgramError('STARTUP_FAILED', run.snapshot.error ?? 'Program closed before startup hello'));
      this.changed(run);
      run.closed.resolve();
      this.prune();
    });
  }

  private groupExists(run: Run): boolean {
    if (!run.child?.pid) return false;
    if (process.platform === 'win32') return !run.exitObserved && !run.closeObserved;
    try { process.kill(-run.child.pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
  }

  private signalGroup(run: Run, signal: NodeJS.Signals): void {
    if (!run.child?.pid) return;
    try {
      if (process.platform === 'win32') run.child.kill(signal);
      else process.kill(-run.child.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') this.log(run, 'system', `Unable to signal process group: ${safeError(error)}`);
    }
  }

  private recordMessage(run: Run, direction: 'parent' | 'program', body: JsonValue): void {
    run.snapshot.messages.push({ direction, body: jsonClone(body), at: new Date().toISOString() });
    while (run.snapshot.messages.length > RUNTIME_LIMITS.messages) run.snapshot.messages.shift();
    this.changed(run);
  }

  private changed(run: Run): void {
    if (!this.options.onEvent || run.eventTimer || this.disposed) return;
    run.eventTimer = setTimeout(() => {
      run.eventTimer = undefined;
      if (!this.current(run) || this.disposed) return;
      try { this.options.onEvent?.({ type: 'changed', run: this.snapshot(run) }); }
      catch { /* Observers cannot crash or control program supervision. */ }
    }, 25);
    run.eventTimer.unref();
  }

  private protocolFailure(run: Run, message: string): void { this.beginShutdown(run, 'failed', `Invalid IPC: ${message}`); }
  private current(run: Run): boolean { return this.runs.get(run.snapshot.id) === run; }
  private live(run: Run): boolean { return this.current(run) && !run.shutdownStarted && !run.controller.signal.aborted && !terminalStates.has(run.snapshot.state); }
  private snapshot(run: Run): ProgramSnapshot { return jsonClone(run.snapshot); }
  private lookup(id: string, ownerId?: string): Run {
    const run = this.runs.get(id);
    if (!run || (ownerId !== undefined && run.snapshot.ownerId !== ownerId)) throw new ProgramError('NOT_FOUND', 'Program not found');
    return run;
  }
  private ownerEpoch(ownerId: string): number { return this.ownerEpochs.get(ownerId) ?? 0; }
  private assertOwner(ownerId: string): void { if (this.revokedOwners.has(ownerId)) throw new ProgramError('OWNER_REVOKED', 'Program owner is no longer live'); }
  private assertAvailable(): void { if (this.disposed) throw new ProgramError('DISPOSED', 'Program supervisor is disposed'); }
  private assertCapacity(): void {
    if ([...this.runs.values()].filter((run) => !run.closeProven).length >= this.maxRuns) throw new ProgramError('LIMIT', 'Maximum concurrent programs reached');
  }
  private prune(): void {
    const history = [...this.runs.values()].filter((run) => run.closeProven && !run.restarting);
    while (history.length > this.maxHistory) {
      const old = history.shift()!;
      this.runs.delete(old.snapshot.id);
      if (old.eventTimer) clearTimeout(old.eventTimer);
    }
  }
}
