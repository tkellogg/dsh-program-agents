// SERVER ONLY. Never import this module (or connectProgram) into the browser bundle.
import { connectProgram, type ConversationHandle, type ConversationMessage, type ConversationOpenOptions, type JsonValue, type ProgramConversations } from '@tkellogg/dsh-program-agents/app';
import type { Context, Hono } from 'hono';
import { canonicalJson, object, SIDEBAR_LIMITS, utf8Bytes, type NativeFrame } from './protocol.js';

export interface AgentSidebarOptions<PageState extends JsonValue> {
  /** Exact public app origin, including port. Do not derive this from incoming Host/Origin. */
  appOrigin: string;
  basePath?: string;
  conversation: ConversationOpenOptions;
  /** Mandatory application allowlist. Treat input as hostile; return a fresh minimal object. */
  sanitizePageState: (input: unknown) => PageState;
  /** Injection for app ownership/testing. Default connectProgram() remains backend-only and lazy. */
  conversations?: ProgramConversations;
  /** Add real app authentication here for non-loopback deployments. CSRF checks are not auth. */
  authorize?: (request: Request) => boolean | Promise<boolean>;
  /** Log codes/operation IDs, not raw prompt/context, credentials, headers, or arbitrary stacks. */
  onError?: (operation: string, error: unknown) => void;
}
class HttpFailure extends Error { constructor(readonly status: 400 | 401 | 403 | 413 | 415 | 429, message: string) { super(message); } }
function integer(value: string | undefined, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (!value || !/^-?\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new HttpFailure(400, 'Invalid history cursor');
  return Number(value);
}
async function readJson(request: Request): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw new HttpFailure(415, 'Expected application/json');
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > SIDEBAR_LIMITS.requestBytes)) throw new HttpFailure(413, 'Request exceeds 32 KiB');
  if (!request.body) throw new HttpFailure(400, 'Expected JSON body');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const item = await reader.read(); if (item.done) break;
      size += item.value.byteLength;
      if (size > SIDEBAR_LIMITS.requestBytes) { await reader.cancel(); throw new HttpFailure(413, 'Request exceeds 32 KiB'); }
      chunks.push(item.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new HttpFailure(400, 'Invalid JSON'); }
}
function messageInput<PageState extends JsonValue>(input: unknown, sanitize: (value: unknown) => PageState): { message: ConversationMessage; requestId: string } {
  if (!object(input) || typeof input.text !== 'string' || !input.text.trim() || typeof input.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.requestId)) throw new HttpFailure(400, 'Expected text and an opaque requestId');
  if (Object.keys(input).some(key => !['text', 'requestId', 'context'].includes(key))) throw new HttpFailure(400, 'Unknown message field');
  const message: ConversationMessage = { text: input.text };
  if (input.context !== undefined) {
    if (!object(input.context) || !Object.hasOwn(input.context, 'state') || Object.keys(input.context).some(key => !['state', 'revision'].includes(key))) throw new HttpFailure(400, 'Invalid page context');
    const revision = input.context.revision;
    if (revision !== undefined && !((typeof revision === 'string' && revision.length <= 256) || (typeof revision === 'number' && Number.isSafeInteger(revision)))) throw new HttpFailure(400, 'Invalid page revision');
    try {
      // Bound both the submitted state and the allowlisted output, measured in UTF-8 bytes.
      if (utf8Bytes(canonicalJson(input.context.state)) > SIDEBAR_LIMITS.stateBytes) throw new HttpFailure(413, 'Page state exceeds 16 KiB');
      const state = sanitize(input.context.state);
      const serialized = canonicalJson(state);
      if (utf8Bytes(serialized) > SIDEBAR_LIMITS.stateBytes) throw new HttpFailure(413, 'Page state exceeds 16 KiB');
      message.context = { ...(revision === undefined ? {} : { revision }), state: JSON.parse(serialized) as PageState };
      // Native context admission also counts the small revision/state envelope.
      if (utf8Bytes(canonicalJson(message.context)) > SIDEBAR_LIMITS.stateBytes) throw new HttpFailure(413, 'Page context envelope exceeds 16 KiB');
    } catch (error) {
      if (error instanceof HttpFailure) throw error;
      throw new HttpFailure(400, 'Page state failed the application allowlist');
    }
  }
  return { message, requestId: input.requestId };
}

/** Mount one app-owned conversation, not an arbitrary session/bridge proxy. No startup child. */
export function mountAgentSidebar<PageState extends JsonValue>(app: Hono, options: AgentSidebarOptions<PageState>) {
  const origin = new URL(options.appOrigin);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== options.appOrigin || origin.username || origin.password) throw new Error('appOrigin must be an exact HTTP(S) origin');
  const basePath = options.basePath ?? '/api/assistant';
  if (!/^\/[A-Za-z0-9/_-]+$/.test(basePath) || basePath.endsWith('/')) throw new Error('Invalid sidebar basePath');
  // Freeze creation identity/instructions. Changing them does not rewrite an existing child.
  const conversationOptions = { ...options.conversation };
  let singleton: Promise<ConversationHandle> | undefined;
  let activeStreams = 0;
  let pendingSends = 0;
  const conversation = (): Promise<ConversationHandle> => {
    if (!singleton) {
      singleton = Promise.resolve().then(() => (options.conversations ?? connectProgram().conversations).open(conversationOptions));
      // A rejected open may be retried on a later explicit chat request, never in a startup loop.
      void singleton.catch(() => { singleton = undefined; });
    }
    return singleton;
  };
  app.use(`${basePath}/*`, async (c, next) => {
    c.header('Cache-Control', 'no-store'); c.header('X-Content-Type-Options', 'nosniff');
    const request = c.req.raw;
    const host = request.headers.get('host');
    if (new URL(request.url).origin !== origin.origin || (host !== null && host.toLowerCase() !== origin.host)) return c.json({ error: 'Wrong app host' }, 403);
    const suppliedOrigin = request.headers.get('origin');
    const explicitSameOrigin = suppliedOrigin === options.appOrigin;
    // Browsers omit Origin on same-origin GET and forbid JavaScript from setting it.
    // Only this GET-only Fetch-Metadata + non-simple-header exception is permitted.
    const sameOriginGet = request.method === 'GET' && suppliedOrigin === null && request.headers.get('sec-fetch-site') === 'same-origin';
    if ((!explicitSameOrigin && !sameOriginGet) || request.headers.get('x-agent-sidebar') !== '1') return c.json({ error: 'Same-origin sidebar request required' }, 403);
    if (options.authorize && !await options.authorize(request)) return c.json({ error: 'Authentication required' }, 401);
    await next();
  });
  const guarded = (operation: string, handler: (c: Context) => Promise<Response>) => async (c: Context): Promise<Response> => {
    try { return await handler(c); }
    catch (error) {
      if (error instanceof HttpFailure) return c.json({ error: error.message }, error.status);
      options.onError?.(operation, error);
      // A bridge error can contain private details. The browser sees only this stable summary.
      return c.json({ error: `${operation} failed; inspect history before retrying a send` }, 502);
    }
  };
  app.post(`${basePath}/messages`, guarded('Send', async c => {
    const input = messageInput(await readJson(c.req.raw), options.sanitizePageState);
    if (pendingSends >= 8) throw new HttpFailure(429, 'Too many pending sends');
    pendingSends++;
    try {
      const handle = await conversation();
      // No retries: a timeout/disconnect can happen after native admission. Always queue a new turn.
      const receipt = await handle.send(input.message, { requestId: input.requestId, mode: 'queue', signal: c.req.raw.signal });
      return c.json(receipt, 202);
    } finally { pendingSends--; }
  }));
  app.get(`${basePath}/history`, guarded('History', async c => {
    const throughSeq = integer(c.req.query('throughSeq'));
    const beforeSeq = c.req.query('beforeSeq') === undefined ? undefined : integer(c.req.query('beforeSeq'));
    const maxMessages = integer(c.req.query('maxMessages'), 20);
    if (throughSeq < -1 || (beforeSeq !== undefined && (beforeSeq < 0 || beforeSeq > throughSeq + 1)) || maxMessages < 1 || maxMessages > 100) throw new HttpFailure(400, 'Invalid history range');
    const handle = await conversation();
    return c.json(await handle.history({ throughSeq, ...(beforeSeq === undefined ? {} : { beforeSeq }), maxMessages }, { signal: c.req.raw.signal }));
  }));
  app.post(`${basePath}/interrupt`, guarded('Interrupt', async c => {
    const body = await readJson(c.req.raw);
    if (!object(body) || Object.keys(body).length) throw new HttpFailure(400, 'Expected empty JSON object');
    // Interrupting an unopened sidebar is a no-op, not a reason to create a child.
    if (!singleton) return c.json({ accepted: true });
    return c.json(await (await singleton).interrupt({ signal: c.req.raw.signal }));
  }));
  app.get(`${basePath}/events`, guarded('Subscribe', async c => {
    if (activeStreams >= 2) throw new HttpFailure(429, 'Too many sidebar subscriptions');
    activeStreams++;
    const abort = new AbortController();
    let iterator: AsyncIterator<NativeFrame> | undefined;
    let closing: Promise<IteratorResult<NativeFrame>> | undefined;
    const closeIterator = () => closing ??= iterator?.return?.();
    let ended = false;
    const cleanup = () => {
      if (ended) return;
      ended = true; activeStreams--; abort.abort();
      c.req.raw.signal.removeEventListener('abort', requestAbort);
      // Release even when the browser disconnects between pulls (no pending next()).
      void closeIterator()?.catch(() => {});
    };
    const requestAbort = () => cleanup();
    c.req.raw.signal.addEventListener('abort', requestAbort, { once: true });
    if (c.req.raw.signal.aborted) cleanup();
    try {
      const handle = await conversation();
      iterator = handle.events({ signal: abort.signal, maxMessages: 20 })[Symbol.asyncIterator]();
      if (abort.signal.aborted) { await closeIterator(); throw new Error('Subscription cancelled'); }
      const encoder = new TextEncoder();
      // Pull, don't eagerly drain native events into an unbounded application queue.
      // The bridge also bounds its queue and eventually disconnects a slow browser.
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const item = await iterator!.next();
            if (item.done) { cleanup(); controller.close(); return; }
            const json = JSON.stringify(item.value);
            if (utf8Bytes(json) > SIDEBAR_LIMITS.frameBytes) throw new Error('Native frame exceeds sidebar limit');
            controller.enqueue(encoder.encode(`event: native\ndata: ${json}\n\n`));
          } catch (error) {
            const wasAborted = abort.signal.aborted; cleanup();
            if (!wasAborted) options.onError?.('Subscribe', error);
            controller.error(new Error('Assistant subscription disconnected'));
          }
        },
        async cancel() { cleanup(); await closeIterator(); },
      }, { highWaterMark: 0 });
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' } });
    } catch (error) { cleanup(); throw error; }
  }));
  return { basePath };
}
