import assert from 'node:assert/strict';
import test from 'node:test';
import { CLIENT_LIMITS, formatJson, parseMessage, parseRunList, resourceLink, runControls, safeResourceUrl, type ProgramRun, type ProgramState } from '../src/client/model.js';
import { createProgramClient, ProgramApiError, type RpcTransport } from '../src/client/transport.js';

function run(overrides: Partial<ProgramRun> = {}): ProgramRun {
  return { id: 'p1', generation: 2, ownerId: 'session-a', program: 'worker', label: 'Worker', state: 'running', startedAt: '', logs: [], messages: [], resources: [], ...overrides };
}
test('resource links accept only absolute HTTP(S) without credentials or control characters', () => {
  for (const unsafe of ['javascript:alert(1)', 'data:text/html,x', 'file:///tmp/a', '//example.com', '/relative', 'https://a:secret@example.com', 'https://example.com\\@evil.test', 'https://example.com\n', ' https://example.com', 'https://', 'ftp://example.com', '', null]) {
    assert.equal(safeResourceUrl(unsafe), undefined, String(unsafe));
  }
  assert.equal(safeResourceUrl('https://example.com/a?q=b#c'), 'https://example.com/a?q=b#c');
  assert.equal(safeResourceUrl('http://127.0.0.1:8080'), 'http://127.0.0.1:8080/');
  assert.equal(safeResourceUrl('HTTPS://EXAMPLE.COM'), 'https://example.com/');
});
test('resources are unavailable in stale, terminal, startup, or stopping generations', () => {
  const resource = { id: 'a', title: 'UI', url: 'http://localhost:3333', available: true };
  for (const state of ['starting', 'stopping', 'stopped', 'completed', 'failed'] as ProgramState[]) assert.equal(resourceLink(run({ state }), resource), undefined);
  assert.equal(resourceLink(run(), resource, true), undefined);
  assert.equal(resourceLink(run(), resource, false, 'stop'), undefined);
  assert.equal(resourceLink(run(), resource, false, 'restart'), undefined);
  assert.equal(resourceLink(run(), { ...resource, available: false }), undefined);
  assert.equal(resourceLink(run({ state: 'blocked' }), resource), 'http://localhost:3333/');
});
test('controls have explicit state and pending/stale gates', () => {
  assert.deepEqual(runControls('running'), { send: true, stop: true, restart: false });
  assert.deepEqual(runControls('blocked'), { send: true, stop: true, restart: false });
  assert.deepEqual(runControls('starting'), { send: false, stop: true, restart: false });
  assert.deepEqual(runControls('stopping'), { send: false, stop: false, restart: false });
  for (const state of ['stopped', 'completed', 'failed'] as ProgramState[]) assert.deepEqual(runControls(state), { send: false, stop: false, restart: true });
  assert.deepEqual(runControls('running', true), { send: false, stop: false, restart: false });
  assert.deepEqual(runControls('stopped', false, true), { send: false, stop: false, restart: false });
});
test('snapshot boundary filters foreign owners, malformed generations and duplicate ids', () => {
  const foreign = run({ id: 'foreign', ownerId: 'session-b', label: 'SECRET' });
  const parsed = parseRunList({ runs: [foreign, run(), run()] }, 'session-a');
  assert.deepEqual(parsed.runs.map(item => item.id), ['p1']);
  assert.equal(JSON.stringify(parsed).includes('SECRET'), false);
  assert.throws(() => parseRunList({ runs: [run({ generation: 0 })] }, 'session-a'), /generation/);
  assert.throws(() => parseRunList({ runs: [run({ state: 'unknown' as ProgramState })] }, 'session-a'), /state/);
  assert.throws(() => parseRunList({ runs: 'bad' }, 'session-a'), /invalid list/);
});
test('snapshot boundary bounds runs, text, resources, log volume and messages', () => {
  const oversized = run({
    label: 'x'.repeat(10_000),
    logs: Array.from({ length: 5_000 }, (_, sequence) => ({ sequence, stream: 'stdout', text: 'x'.repeat(20_000) })),
    messages: Array.from({ length: 5_000 }, () => ({ direction: 'program', body: {}, at: '' })),
    resources: Array.from({ length: 5_000 }, () => ({ id: 'a', title: 'A', available: true, url: 'https://example.com' })),
  });
  const result = parseRunList({ runs: Array.from({ length: 200 }, (_, i) => ({ ...oversized, id: `p${i}` })) }, 'session-a');
  assert.equal(result.runs.length, CLIENT_LIMITS.runs); assert.equal(result.truncated, true);
  const first = result.runs[0]!;
  assert.ok(first.label.length < 300); assert.ok(first.logs.length <= CLIENT_LIMITS.logs);
  assert.ok(first.logs.map(log => log.text).join('').length <= CLIENT_LIMITS.logCharacters + 20);
  assert.equal(first.logs.at(-1)?.sequence, 4_999);
  assert.equal(first.messages.length, CLIENT_LIMITS.messages); assert.equal(first.resources.length, CLIENT_LIMITS.resources);
  assert.ok(formatJson({ body: 'x'.repeat(1_000_000), nest: Array(1_000).fill('x') }).length <= CLIENT_LIMITS.messageCharacters + 20);
});
test('message mode is explicit and bounded', () => {
  assert.equal(parseMessage('{"x":1}', false), '{"x":1}');
  assert.deepEqual(parseMessage('{"x":1}', true), { x: 1 });
  assert.equal(parseMessage('null', true), null);
  assert.throws(() => parseMessage('oops', true), /valid JSON/);
  assert.throws(() => parseMessage('  ', false), /Enter a message/);
  assert.throws(() => parseMessage('x'.repeat(CLIENT_LIMITS.inputCharacters + 1), false), /limited/);
});
test('client uses the authenticated Connection carrier and generation-scoped named args', async () => {
  const calls: Array<{ channel: string; endpoint: string; payload: unknown; signal?: AbortSignal }> = [];
  const rpc: RpcTransport = { async call(channel, endpoint, payload, signal) { calls.push({ channel, endpoint, payload, signal }); return { ok: true, value: endpoint === 'list' ? { runs: [run()] } : undefined }; } };
  const client = createProgramClient(rpc, 'session-a'); const signal = new AbortController().signal;
  const result = await client.list(signal); assert.equal(result.runs.length, 1);
  await client.action('send', run(), { text: 'hello' }, signal);
  await client.action('stop', run(), undefined, signal);
  await client.action('restart', run({ state: 'stopped' }), undefined, signal);
  assert.deepEqual(calls.map(call => [call.channel, call.endpoint, call.payload]), [
    ['/program-agents', 'list', { sessionId: 'session-a' }],
    ['/program-agents', 'send', { sessionId: 'session-a', id: 'p1', generation: 2, body: { text: 'hello' } }],
    ['/program-agents', 'stop', { sessionId: 'session-a', id: 'p1', generation: 2 }],
    ['/program-agents', 'restart', { sessionId: 'session-a', id: 'p1', generation: 2 }],
  ]);
  assert.ok(calls.every(call => call.signal instanceof AbortSignal && !call.signal.aborted));
  await assert.rejects(client.action('stop', run({ ownerId: 'session-b' }), undefined, signal), /does not belong/);
  assert.equal(calls.length, 4);
});
test('client deadlines cancel the carrier even if it never settles, without retrying effects', async () => {
  let calls = 0; let observed: AbortSignal | undefined;
  const client = createProgramClient({ call(_channel, _endpoint, _payload, signal) {
    calls++; observed = signal; return new Promise(() => {});
  } }, 'session-a', 5);
  await assert.rejects(client.action('stop', run(), undefined, new AbortController().signal), /timed out/);
  assert.equal(calls, 1); assert.equal(observed?.aborted, true);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(client.list(cancelled.signal), /cancelled/); assert.equal(calls, 1);
});
test('client surfaces host failures without inventing another transport or retry', async () => {
  let calls = 0;
  const client = createProgramClient({ async call() { calls++; return { ok: false, error: { code: 'unavailable', message: 'Host plugin missing.' } }; } }, 'session-a');
  await assert.rejects(client.list(new AbortController().signal), error => error instanceof ProgramApiError && error.code === 'unavailable' && /missing/.test(error.message));
  assert.equal(calls, 1);
});
