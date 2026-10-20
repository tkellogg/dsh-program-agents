import assert from 'node:assert/strict';
import test from 'node:test';
import { CLIENT_LIMITS, parseRunList, resourceLink, runControls, safeResourceUrl, type ProgramItem, type ProgramRun, type ProgramState } from '../src/client/model.js';
import { consumeSnapshots, createProgramClient, ProgramApiError, type RpcTransport } from '../src/client/transport.js';

const run = (overrides: Partial<ProgramRun> = {}): ProgramRun => ({ id: 'p1', generation: 2, ownerId: 'session-a', program: 'worker', label: 'Worker', state: 'running', startedAt: '', resources: [], ...overrides });
const item = (overrides: Partial<ProgramItem> = {}): ProgramItem => ({ program: 'worker', name: 'Worker', description: '', command: [], urls: [], run: run(), ...overrides });
const resource = { id: 'a', title: 'App', type: 'ui' as const, url: 'http://localhost:3333', available: true };
const sse = (chunks: Array<string | Uint8Array>, cancel?: () => void) => new Response(new ReadableStream<Uint8Array>({ start(controller) { for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk); controller.close(); }, cancel }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });

test('resource links accept only absolute HTTP(S) and disable stale, terminal or pending resources', () => {
  for (const unsafe of ['javascript:alert(1)', 'data:text/html,x', 'file:///tmp/a', '/tmp/docs.md', '//example.com', '/relative', 'https://a:secret@example.com', 'https://example.com\\@evil.test', 'https://example.com\n', ' https://example.com', 'https://', 'ftp://example.com', '', null]) assert.equal(safeResourceUrl(unsafe), undefined, String(unsafe));
  assert.equal(safeResourceUrl('https://example.com/a?q=b#c'), 'https://example.com/a?q=b#c');
  assert.equal(safeResourceUrl('HTTPS://EXAMPLE.COM'), 'https://example.com/');
  for (const state of ['starting', 'stopping', 'stopped', 'completed', 'failed'] as ProgramState[]) assert.equal(resourceLink(item({ run: run({ state }) }), resource), undefined);
  assert.equal(resourceLink(item(), resource, true), undefined);
  for (const pending of ['start', 'stop', 'restart'] as const) assert.equal(resourceLink(item(), resource, false, pending), undefined);
  assert.equal(resourceLink(item({ run: undefined }), resource), undefined);
  assert.equal(resourceLink(item(), { ...resource, available: false }), undefined);
  assert.equal(resourceLink(item({ run: run({ state: 'blocked' }) }), resource), 'http://localhost:3333/');
});
test('configured and terminal entries offer Start; active runs offer Stop and Restart', () => {
  assert.deepEqual(runControls('configured'), { start: true, stop: false, restart: false });
  for (const state of ['running', 'blocked', 'starting'] as const) assert.deepEqual(runControls(state), { start: false, stop: true, restart: true });
  assert.deepEqual(runControls('stopping'), { start: false, stop: false, restart: false });
  for (const state of ['stopped', 'completed', 'failed'] as const) assert.deepEqual(runControls(state), { start: true, stop: false, restart: true });
  assert.deepEqual(runControls('running', true), { start: false, stop: false, restart: false });
  assert.deepEqual(runControls('configured', false, true), { start: false, stop: false, restart: false });
});
test('descriptors merge latest owned runs by opaque program key, not historical run count', () => {
  const parsed = parseRunList({ programs: [{ program: 'opaque:key/7', name: 'User app', description: 'A nice app', command: ['node', 'app.ts'], urls: [{ ...resource, type: 'api', docs: '/tmp/API.md' }], logsPath: '/tmp/app.log' }, { program: 'idle', name: 'Configured', command: [], urls: [] }], runs: [
    run({ id: 'old', generation: 1, program: 'opaque:key/7', startedAt: '2026-01-01', state: 'completed' }),
    run({ program: 'opaque:key/7', startedAt: '2026-01-02', logsPath: '/tmp/new.log', resources: [{ ...resource, type: 'api', available: false }] }),
    { ...run({ ownerId: 'foreign', id: 'secret' }), name: 'PRIVATE' },
  ] }, 'session-a');
  assert.equal(parsed.items.length, 2); assert.equal(parsed.items[0]?.name, 'User app');
  assert.equal(parsed.items[0]?.program, 'opaque:key/7'); assert.equal(parsed.items[0]?.run?.id, 'p1');
  assert.equal(parsed.items[0]?.logsPath, '/tmp/new.log'); assert.equal(parsed.items[0]?.urls[0]?.available, false);
  assert.equal(parsed.items[0]?.urls[0]?.docs, '/tmp/API.md');
  assert.equal(parsed.items[1]?.run, undefined); assert.equal(JSON.stringify(parsed).includes('PRIVATE'), false);
  const legacy = parseRunList({ runs: [run({ generation: 1 }), run(), run({ id: 'other', startedAt: '2000' })] }, 'session-a');
  assert.equal(legacy.items.length, 1); assert.equal(legacy.items[0]?.name, 'Worker');
  assert.equal(legacy.runs.length, 2);
});
test('history bound reserves the latest owned run for every program', () => {
  const history = Array.from({ length: CLIENT_LIMITS.runs + 20 }, (_, i) => run({ id: `history${i}`, generation: i + 1, startedAt: '2026' }));
  const parsed = parseRunList({ runs: [...history, run({ id: 'other', program: 'other', startedAt: '2000' })] }, 'session-a');
  assert.equal(parsed.items.length, 2); assert.ok(parsed.items.some(item => item.run?.id === 'other'));
  assert.equal(parsed.items.find(item => item.program === 'worker')?.run?.generation, CLIENT_LIMITS.runs + 20);
});
test('boundary bounds compact metadata and discards logs/messages/results entirely', () => {
  const raw = { ...run(), label: 'x'.repeat(10_000), logs: [{ text: 'SECRET LOG' }], messages: [{ body: 'SECRET MESSAGE' }], result: 'SECRET RESULT', resources: Array(1_000).fill({ ...resource, docs: '/tmp/docs.md' }) };
  const parsed = parseRunList({ runs: Array.from({ length: 200 }, (_, i) => ({ ...raw, id: `p${i}`, program: `worker${i}` })), programs: [] }, 'session-a');
  assert.equal(parsed.runs.length, CLIENT_LIMITS.runs); assert.equal(parsed.truncated, true);
  assert.equal(parsed.runs[0]?.label.length, 200); assert.equal(parsed.runs[0]?.resources.length, CLIENT_LIMITS.resources);
  assert.equal(JSON.stringify(parsed).includes('SECRET'), false);
  assert.throws(() => parseRunList({ runs: [run({ generation: 0 })] }, 'session-a'), /generation/);
  assert.throws(() => parseRunList({ runs: [run({ state: 'unknown' as ProgramState })] }, 'session-a'), /state/);
  assert.throws(() => parseRunList({ runs: 'bad' }, 'session-a'), /invalid list/);
});
test('client RPC uses direct named args for configured Start and generation-fenced Stop/Restart', async () => {
  const calls: Array<{ channel: string; endpoint: string; payload: unknown; signal?: AbortSignal }> = [];
  const rpc: RpcTransport = { async call(channel, endpoint, payload, signal) { calls.push({ channel, endpoint, payload, signal }); return { ok: true, value: endpoint === 'programAgents/list' ? { runs: [run()], programs: [] } : undefined }; } };
  const client = createProgramClient({ rpc }, 'session-a'), signal = new AbortController().signal;
  assert.equal((await client.list(signal)).items.length, 1);
  await client.action('start', item({ program: 'opaque-key', run: undefined }), signal);
  await client.action('stop', run(), signal); await client.action('restart', run(), signal);
  assert.deepEqual(calls.map(call => [call.channel, call.endpoint, call.payload]), [
    ['/api', 'programAgents/list', { sessionId: 'session-a' }],
    ['/api', 'programAgents/start', { sessionId: 'session-a', program: 'opaque-key' }],
    ['/api', 'programAgents/stop', { sessionId: 'session-a', id: 'p1', generation: 2 }],
    ['/api', 'programAgents/restart', { sessionId: 'session-a', id: 'p1', generation: 2 }],
  ]);
  assert.ok(calls.every(call => call.signal instanceof AbortSignal && !call.signal.aborted));
  await assert.rejects(client.action('stop', run({ ownerId: 'session-b' }), signal), /does not belong/);
  await assert.rejects(client.action('restart', item({ run: undefined }), signal), /no current run/); assert.equal(calls.length, 4);
});
test('client deadlines abort unresponsive RPC without retrying effects; already aborted requests do not call', async () => {
  let calls = 0; let observed: AbortSignal | undefined;
  const client = createProgramClient({ call(_channel, _endpoint, _payload, signal) { calls++; observed = signal; return new Promise(() => {}); } }, 'session-a', undefined, 5);
  await assert.rejects(client.action('stop', run(), new AbortController().signal), /timed out/);
  assert.equal(calls, 1); assert.equal(observed?.aborted, true);
  const abort = new AbortController(); abort.abort(); await assert.rejects(client.list(abort.signal), /cancelled/); assert.equal(calls, 1);
});
test('host failures preserve API error without alternate transport or retries', async () => {
  let calls = 0;
  const client = createProgramClient({ async call() { calls++; return { ok: false, error: { code: 'unavailable', message: 'Host plugin missing.' } }; } }, 'session-a');
  await assert.rejects(client.list(new AbortController().signal), error => error instanceof ProgramApiError && error.code === 'unavailable' && /missing/.test(error.message)); assert.equal(calls, 1);
});
test('SSE parses fragmented UTF-8, CRLF, comments and multiline snapshots, ignores incomplete/unknown events', async () => {
  const values: unknown[] = [], encoder = new TextEncoder();
  const bytes = encoder.encode(': heartbeat\r\n\r\nevent: other\ndata: nope\n\nevent: snapshot\r\ndata: {"runs": [],\r\ndata: "programs": [], "name": "☃"}\r\n\r\nevent: snapshot\ndata: {"runs": []}\n\nevent: snapshot\ndata: {"incomplete":true}');
  await consumeSnapshots(sse(Array.from(bytes, byte => new Uint8Array([byte]))), value => values.push(value), new AbortController().signal);
  assert.deepEqual(values, [{ runs: [], programs: [], name: '☃' }, { runs: [] }]);
});
test('SSE frame byte bound rejects oversized unterminated, multibyte and complete frames', async () => {
  for (const chunks of [['event: snapshot\ndata: ' + 'x'.repeat(CLIENT_LIMITS.frameBytes)], ['data: ' + '☃'.repeat(CLIENT_LIMITS.frameBytes / 2) + '\n\n'], ['event: snapshot\ndata: "' + 'x'.repeat(CLIENT_LIMITS.frameBytes) + '"\n\n']]) {
    await assert.rejects(consumeSnapshots(sse(chunks), () => assert.fail('Oversized snapshot delivered'), new AbortController().signal), /too large/);
  }
  await assert.rejects(consumeSnapshots(sse(['event: snapshot\ndata: not json\n\n']), () => {}, new AbortController().signal), /JSON/);
  await assert.rejects(consumeSnapshots(new Response('no', { status: 401 }), () => {}, new AbortController().signal), /unavailable/);
});
test('stream fetch is mount aware same-origin POST with native fallback, abort cancels the reader', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { baseURI: 'https://host.test/mount/' } });
  let observed: RequestInit | undefined, observedUrl = '', cancelled = false, push!: ReadableStreamDefaultController<Uint8Array>;
  const client = createProgramClient({ async call() { assert.fail('Streaming must not poll RPC'); } }, 'session-a', async (url, init) => {
    observedUrl = url.href; observed = init;
    return new Response(new ReadableStream<Uint8Array>({ start(controller) { push = controller; }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } });
  });
  try {
    const abort = new AbortController(), snapshots: unknown[] = [];
    const reading = client.subscribe(value => snapshots.push(value), abort.signal);
    await Promise.resolve(); await Promise.resolve();
    assert.equal(observedUrl, 'https://host.test/mount/api/programAgents/events'); assert.equal(observed?.method, 'POST');
    assert.equal(observed?.credentials, 'same-origin'); assert.equal(observed?.redirect, 'error'); assert.equal(observed?.signal, abort.signal);
    assert.deepEqual(JSON.parse(observed?.body as string), { sessionId: 'session-a' });
    push.enqueue(new TextEncoder().encode('event: snapshot\ndata: {"runs":[],"programs":[]}\n\n'));
    for (let i = 0; i < 6; i++) await Promise.resolve();
    assert.equal(snapshots.length, 1); abort.abort(); await assert.rejects(reading, /cancelled/); assert.equal(cancelled, true);
  } finally { if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document'); }
});
