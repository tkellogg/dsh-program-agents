import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import type { ConversationHandle, ConversationMessage, ConversationOpenOptions, ProgramConversations } from '../src/conversations.js';
import { mountAgentSidebar } from '../skills/program-agents/references/chat-sidebar/backend.js';

const origin = 'http://127.0.0.1:4567';
function fixture() {
  const calls = { opens: [] as ConversationOpenOptions[], sends: [] as Array<{ message: ConversationMessage; options: unknown }>, histories: [] as unknown[], interrupts: 0, nexts: 0, returns: 0, signal: undefined as AbortSignal | undefined };
  const handle: ConversationHandle = {
    id: 'only-this-child', name: 'App assistant',
    async history(options) { calls.histories.push(options); return { records: [], hasMore: false }; },
    events(options) {
      calls.signal = options?.signal;
      return { [Symbol.asyncIterator]() { return {
        async next() { calls.nexts++; return { done: false, value: { type: 'snapshot', header: { id: 'only-this-child', version: 4, createdAt: 0, isSeeded: false }, cursor: -1, records: [], hasMore: false, projections: { asOfSeq: -1, values: {} } } } as never; },
        async return() { calls.returns++; return { done: true, value: undefined }; },
      }; } };
    },
    async send(message, options) { calls.sends.push({ message, options }); return { requestId: options!.requestId!, messageId: 'accepted-user-message' }; },
    async *ask() { throw new Error('UI stream must be independent of ask'); },
    async interrupt() { calls.interrupts++; return { accepted: true }; },
  };
  const conversations: ProgramConversations = { async open(options) { calls.opens.push(options); await Promise.resolve(); return handle; }, async get() { assert.fail('No arbitrary conversation lookup'); }, async list() { assert.fail('No browser conversation list'); } };
  const app = new Hono();
  mountAgentSidebar(app, { appOrigin: origin, conversation: { name: 'App assistant', instructions: 'stable persona', model: 'smart-model' }, conversations, sanitizePageState(input) {
    if (!input || typeof input !== 'object' || !('selectedId' in input) || typeof input.selectedId !== 'string') throw new Error('Invalid app state');
    return { selectedId: input.selectedId };
  } });
  const request = (path: string, options: RequestInit = {}) => app.request(origin + '/api/assistant' + path, { ...options, headers: { Origin: origin, 'X-Agent-Sidebar': '1', 'Content-Type': 'application/json', ...options.headers } });
  return { app, calls, request };
}
const message = (overrides = {}) => JSON.stringify({ text: 'Help', requestId: 'client-request-1', context: { revision: 1, state: { selectedId: 'item-42', secret: 'must-not-cross' } }, ...overrides });

test('mount does not open a child; first chat requests share one lazy open and only proxy the scoped conversation', async () => {
  const { calls, request } = fixture();
  assert.equal(calls.opens.length, 0);
  const idleInterrupt = await request('/interrupt', { method: 'POST', body: '{}' });
  assert.equal(idleInterrupt.status, 200); assert.equal(calls.opens.length, 0);
  const results = await Promise.all([request('/messages', { method: 'POST', body: message() }), request('/messages', { method: 'POST', body: message({ requestId: 'client-request-2' }) })]);
  assert.deepEqual(results.map(result => result.status), [202, 202]);
  assert.equal(calls.opens.length, 1);
  assert.deepEqual(calls.opens[0], { name: 'App assistant', instructions: 'stable persona', model: 'smart-model' });
  assert.deepEqual(calls.sends[0]?.message, { text: 'Help', context: { revision: 1, state: { selectedId: 'item-42' } } });
  assert.equal((calls.sends[0]?.options as { mode: string }).mode, 'queue');
  assert.deepEqual(await results[0]!.json(), { requestId: 'client-request-1', messageId: 'accepted-user-message' });
});

test('Origin, host and custom header checks reject CSRF including same-site localhost ports', async () => {
  const { app, calls } = fixture();
  const raw = (headers: HeadersInit, method = 'POST') => app.request(origin + '/api/assistant/messages', { method, headers, ...(method === 'POST' ? { body: message() } : {}) });
  for (const headers of ([
    { Origin: 'http://127.0.0.1:9999', 'X-Agent-Sidebar': '1', 'Content-Type': 'application/json' },
    { 'X-Agent-Sidebar': '1', 'Content-Type': 'application/json' },
    { Origin: origin, 'Content-Type': 'application/json' },
    { Origin: origin, 'X-Agent-Sidebar': '1', Host: 'evil.test', 'Content-Type': 'application/json' },
    { Origin: 'null', 'X-Agent-Sidebar': '1', 'Content-Type': 'application/json' },
  ] as HeadersInit[])) assert.equal((await raw(headers)).status, 403);
  const wrongUrl = await app.request('http://evil.test/api/assistant/messages', { method: 'POST', headers: { Origin: origin, 'X-Agent-Sidebar': '1', 'Content-Type': 'application/json' }, body: message() });
  assert.equal(wrongUrl.status, 403); assert.equal(calls.opens.length, 0);
});

test('browser GET missing Origin requires same-origin Fetch Metadata AND custom header', async () => {
  const { app, calls } = fixture();
  const url = origin + '/api/assistant/history?throughSeq=-1';
  for (const headers of ([{ 'X-Agent-Sidebar': '1' }, { 'X-Agent-Sidebar': '1', 'Sec-Fetch-Site': 'same-site' }, { 'Sec-Fetch-Site': 'same-origin' }, { Origin: 'http://evil.test', 'X-Agent-Sidebar': '1', 'Sec-Fetch-Site': 'same-origin' }] as HeadersInit[])) assert.equal((await app.request(url, { headers })).status, 403);
  assert.equal(calls.opens.length, 0);
  const response = await app.request(url, { headers: { 'X-Agent-Sidebar': '1', 'Sec-Fetch-Site': 'same-origin' } });
  assert.equal(response.status, 200); assert.equal(response.headers.get('access-control-allow-origin'), null);
});

test('rejects invalid JSON, unknown fields, bad request IDs and oversized multibyte state before opening child', async () => {
  const { request, calls } = fixture();
  for (const [body, status] of [
    ['not JSON', 400], [message({ requestId: 'has spaces' }), 400], [message({ text: ' ' }), 400], [message({ id: 'arbitrary-other-child' }), 400],
    [message({ context: { state: { selectedId: '☃'.repeat(6000) } } }), 413],
    [message({ context: { state: { unknownField: 'no selectedId' } } }), 400],
    [message({ context: { revision: {}, state: { selectedId: 'ok' } } }), 400],
    [message({ text: 'x'.repeat(33 * 1024) }), 413],
  ] as const) assert.equal((await request('/messages', { method: 'POST', body })).status, status);
  assert.equal(calls.opens.length, 0);
  assert.equal((await request('/messages', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: message() })).status, 415);
});

test('request byte cap applies to chunked bodies, not only declared content-length', async () => {
  const { app, calls } = fixture();
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(32 * 1024))); controller.enqueue(new Uint8Array([1])); controller.close(); } });
  const request = new Request(origin + '/api/assistant/messages', { method: 'POST', headers: { Origin: origin, 'X-Agent-Sidebar': '1', 'Content-Type': 'application/json' }, body, duplex: 'half' } as RequestInit);
  assert.equal((await app.request(request)).status, 413); assert.equal(calls.opens.length, 0);
});

test('history uses explicit bounded cursor; malformed range never opens child', async () => {
  const { request, calls } = fixture();
  for (const query of ['', '?throughSeq=-2', '?throughSeq=0&beforeSeq=2', '?throughSeq=1&maxMessages=101', '?throughSeq=NaN']) assert.equal((await request('/history' + query)).status, 400);
  assert.equal(calls.opens.length, 0);
  assert.equal((await request('/history?throughSeq=42&beforeSeq=10&maxMessages=20')).status, 200);
  assert.deepEqual(calls.histories, [{ throughSeq: 42, beforeSeq: 10, maxMessages: 20 }]);
});

test('SSE remains pull-driven, native frames unwrapped, cancellation aborts native subscription', async () => {
  const { request, calls } = fixture();
  const response = await request('/events');
  assert.equal(response.status, 200); assert.ok(response.headers.get('content-type')?.includes('text/event-stream'));
  assert.equal(calls.nexts, 0); // no eager draining before browser reads
  const reader = response.body!.getReader();
  const item = await reader.read();
  assert.equal(calls.nexts, 1);
  const sse = new TextDecoder().decode(item.value);
  assert.ok(sse.startsWith('event: native\ndata: {"type":"snapshot"'));
  await reader.cancel(); assert.equal(calls.returns, 1); assert.equal(calls.signal?.aborted, true);
});

test('HTTP stream slots are bounded and released on cancellation', async () => {
  const { request } = fixture();
  const first = await request('/events'), second = await request('/events');
  assert.equal((await request('/events')).status, 429);
  await first.body!.cancel();
  const third = await request('/events'); assert.equal(third.status, 200);
  await second.body!.cancel(); await third.body!.cancel();
});

test('native receipt failures are never auto-retried or exposed verbatim', async () => {
  let sends = 0;
  const app = new Hono();
  const handle = { async send() { sends++; throw new Error('PRIVATE bridge credential'); } } as unknown as ConversationHandle;
  mountAgentSidebar(app, { appOrigin: origin, conversation: { name: 'assistant' }, sanitizePageState: () => ({}), conversations: { async open() { return handle; }, async get() { return handle; }, async list() { return []; } } });
  const response = await app.request(origin + '/api/assistant/messages', { method: 'POST', headers: { Origin: origin, 'X-Agent-Sidebar': '1', 'Content-Type': 'application/json' }, body: message() });
  assert.equal(response.status, 502); assert.equal(sends, 1); assert.equal((await response.text()).includes('PRIVATE'), false);
});
