import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { JsonValue, ProgramDefinition, ProgramSnapshot } from '../types.js';
import { assertJson, exactKeys, isRecord, jsonClone, ProgramError, safeError, validName } from '../runtime/protocol.js';

export interface AppBridgeContext { run: ProgramSnapshot; definition: ProgramDefinition }
export interface AppBridgeServerOptions {
  handler(context: AppBridgeContext, method: string, input: JsonValue, signal: AbortSignal): Promise<JsonValue>;
  /** Hard ceilings are 32 outstanding handlers and 120 seconds. */
  maxOutstanding?: number;
  timeoutMs?: number;
}
interface Registration extends AppBridgeContext { token: string; controllers: Set<AbortController> }
const MAX_BYTES = 64 * 1024;
const key = (run: Pick<ProgramSnapshot, 'id' | 'generation'>): string => `${run.id}:${run.generation}`;

/** Parent-owned loopback bridge for trusted processes; this is not an OS sandbox. */
export class AppBridgeServer {
  readonly ready: Promise<void>;
  private readonly server;
  private readonly registrations = new Map<string, Registration>();
  private readonly tokens = new Map<string, Registration>();
  private readonly maxOutstanding: number;
  private readonly timeoutMs: number;
  private outstanding = 0;
  private disposed = false;
  private closing?: Promise<void>;
  private address?: string;

  constructor(private readonly options: AppBridgeServerOptions) {
    this.maxOutstanding = options.maxOutstanding ?? 32;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    if (!Number.isSafeInteger(this.maxOutstanding) || this.maxOutstanding < 1 || this.maxOutstanding > 32 || !Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 120_000) throw new ProgramError('INVALID_CONFIG', 'Invalid bridge limits');
    this.server = createServer({ maxHeaderSize: 16 * 1024 }, (request, response) => { void this.handle(request, response); });
    this.server.maxConnections = 128;
    this.server.headersTimeout = 10_000;
    this.server.requestTimeout = 10_000;
    this.server.keepAliveTimeout = 1000;
    this.ready = new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        const address = this.server.address();
        if (!address || typeof address === 'string') { reject(new ProgramError('UNAVAILABLE', 'Bridge did not bind loopback')); return; }
        this.address = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
    void this.ready.catch(() => {});
  }

  register(run: ProgramSnapshot, definition: ProgramDefinition): { env: Record<string, string> } {
    if (this.disposed || !this.address) throw new ProgramError('UNAVAILABLE', 'Await bridge.ready before starting programs');
    if (this.registrations.has(key(run))) throw new ProgramError('BUSY', 'Program generation already has bridge credentials');
    if (this.registrations.size >= 256) throw new ProgramError('LIMIT', 'Bridge registration limit exceeded');
    const token = randomBytes(32).toString('base64url');
    const registration = { run: jsonClone(run), definition: structuredClone(definition), token, controllers: new Set<AbortController>() };
    this.registrations.set(key(run), registration);
    this.tokens.set(token, registration);
    return { env: { DSH_PROGRAM_BRIDGE_URL: this.address, DSH_PROGRAM_BRIDGE_TOKEN: token, DSH_PROGRAM_RUN_ID: run.id, DSH_PROGRAM_GEN: String(run.generation) } };
  }

  revoke(run: Pick<ProgramSnapshot, 'id' | 'generation'>): void {
    const registration = this.registrations.get(key(run));
    if (!registration) return;
    this.registrations.delete(key(run));
    this.tokens.delete(registration.token);
    for (const controller of registration.controllers) controller.abort(new ProgramError('REVOKED', 'Program generation is no longer active; effect outcome may be unknown'));
    registration.controllers.clear();
  }

  dispose(): Promise<void> {
    if (this.closing) return this.closing;
    this.disposed = true;
    for (const registration of this.registrations.values()) this.revoke(registration.run);
    this.closing = (async () => {
      await this.ready.catch(() => {});
      await new Promise<void>((resolve) => {
        this.server.close(() => resolve());
        this.server.closeAllConnections();
      });
    })();
    return this.closing;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let registration: Registration | undefined;
    let controller: AbortController | undefined;
    let timer: NodeJS.Timeout | undefined;
    let reserved = false;
    let handlerStarted = false;
    const disconnect = () => controller?.abort(new ProgramError('CANCELLED', 'Caller disconnected; effect outcome may be unknown'));
    try {
      if (this.disposed) throw new ProgramError('UNAVAILABLE', 'Bridge is closed');
      if (request.method !== 'POST' || request.url !== '/call') { this.reply(response, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Unknown bridge route' } }); return; }
      // Browser origins/cookies are not bridge credentials. No CORS or ambient auth.
      if (request.headers.origin !== undefined || request.headers['sec-fetch-site'] !== undefined || request.headers.host !== new URL(this.address!).host) throw new ProgramError('FORBIDDEN', 'Bridge accepts direct loopback clients only');
      const authorization = request.headers.authorization;
      registration = typeof authorization === 'string' && authorization.startsWith('Bearer ') ? this.tokens.get(authorization.slice(7)) : undefined;
      if (!registration) throw new ProgramError('UNAUTHORIZED', 'Missing, invalid, or revoked program credentials');
      if (this.outstanding >= this.maxOutstanding) throw new ProgramError('BACKPRESSURE', 'Bridge outstanding call limit exceeded');
      this.outstanding++;
      reserved = true;
      controller = new AbortController();
      registration.controllers.add(controller);
      timer = setTimeout(() => controller!.abort(new ProgramError('TIMEOUT', 'Bridge deadline exceeded; effect outcome may be unknown')), this.timeoutMs);
      request.once('aborted', disconnect);
      response.once('close', disconnect);
      const input = await this.read(request, controller.signal);
      assertJson(input);
      if (!isRecord(input) || !exactKeys(input, ['method', 'input']) || !validName(input.method)) throw new ProgramError('INVALID_INPUT', 'Expected {method,input}');
      if (controller.signal.aborted) throw controller.signal.reason;
      const activeRegistration = registration;
      const activeController = controller;
      const pending = Promise.resolve().then(() => this.options.handler({ run: jsonClone(activeRegistration.run), definition: structuredClone(activeRegistration.definition) }, input.method as string, input.input as JsonValue, activeController.signal));
      handlerStarted = true;
      // The slot survives timeout/disconnection until the actual host handler settles.
      // A handler ignoring AbortSignal cannot create unbounded detached work.
      void pending.finally(() => { this.outstanding--; }).catch(() => {});
      const output = await this.abortable(pending, controller.signal);
      if (this.tokens.get(registration.token) !== registration) throw new ProgramError('REVOKED', 'Program generation is no longer active');
      assertJson(output);
      this.reply(response, 200, { ok: true, result: output });
    } catch (error) {
      const code = error instanceof ProgramError ? error.code : 'CALL_FAILED';
      const status = code === 'UNAUTHORIZED' || code === 'REVOKED' ? 401 : code === 'FORBIDDEN' ? 403 : code === 'BACKPRESSURE' ? 429 : code === 'TIMEOUT' ? 504 : code === 'LIMIT' ? 413 : code === 'INVALID_INPUT' || code === 'INVALID_JSON' ? 400 : 500;
      this.reply(response, status, { ok: false, error: { code, message: safeError(error) } });
    } finally {
      if (reserved && !handlerStarted) this.outstanding--;
      if (timer) clearTimeout(timer);
      if (controller) registration?.controllers.delete(controller);
      request.removeListener('aborted', disconnect);
      response.removeListener('close', disconnect);
      // Drain rejected bodies without buffering them, allowing a bounded keep-alive.
      if (!request.complete) request.resume();
    }
  }

  private read(request: IncomingMessage, signal: AbortSignal): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let done = false;
      const finish = (error?: unknown, value?: unknown) => {
        if (done) return;
        done = true;
        request.removeListener('data', data);
        request.removeListener('end', end);
        request.removeListener('error', failure);
        signal.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(value);
      };
      const failure = (error: unknown) => finish(error);
      const abort = () => finish(signal.reason);
      const data = (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BYTES) { finish(new ProgramError('LIMIT', 'Bridge request exceeds 64 KiB')); return; }
        chunks.push(chunk);
      };
      const end = () => {
        try { finish(undefined, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { finish(new ProgramError('INVALID_JSON', 'Malformed bridge JSON')); }
      };
      request.on('data', data);
      request.once('end', end);
      request.once('error', failure);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  }

  private abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }

  private reply(response: ServerResponse, status: number, payload: JsonValue): void {
    if (response.destroyed || response.writableEnded) return;
    let body = JSON.stringify(payload);
    if (Buffer.byteLength(body) > MAX_BYTES) { status = 413; body = JSON.stringify({ ok: false, error: { code: 'LIMIT', message: 'Bridge response exceeds 64 KiB' } }); }
    response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(body);
  }
}
