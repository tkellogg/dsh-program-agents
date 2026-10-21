import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connectProgram, ProgramError } from '../src/app/index.js';
import { AppBridgeServer } from '../src/app/server.js';
import type { JsonValue, ProgramSnapshot } from '../src/types.js';

const snapshot = (id = 'run', generation = 1): ProgramSnapshot => ({ id, generation, program: 'app', ownerId: 'owner', label: 'App', state: 'running', startedAt: new Date().toISOString(), logs: [], resources: [], messages: [] });
const hasCode = (code: string) => (error: unknown) => error instanceof ProgramError && error.code === code;
const configured = (env: Record<string, string>) => ({ url: env.DSH_PROGRAM_BRIDGE_URL, token: env.DSH_PROGRAM_BRIDGE_TOKEN, logger: { stdout: false as const } });

async function direct(env: Record<string, string>, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${env.DSH_PROGRAM_BRIDGE_URL}/call`, { method: 'POST', headers: { Authorization: `Bearer ${env.DSH_PROGRAM_BRIDGE_TOKEN}`, 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

test('bridge uses authoritative run identity and all named helpers preserve exact payloads', async (t) => {
  const seen: Array<{ method: string; input: JsonValue }> = [];
  const server = new AppBridgeServer({ handler: async (context, method, input) => {
    assert.equal(context.run.ownerId, 'owner');
    assert.equal(context.run.id, 'run');
    assert.equal(context.run.generation, 1);
    seen.push({ method, input });
    // Mutating a handler's context must not mutate later authority.
    context.run.ownerId = 'intruder';
    return { method, input };
  } });
  t.after(() => server.dispose());
  await server.ready;
  const env = server.register(snapshot(), { command: ['node', 'app.js'] }).env;
  const client = connectProgram(configured(env));
  assert.equal('functions' in client, false);
  await client.tools.listTools({cursor:'0'});
  await client.tools.callTool({name:'sum',arguments:{x:1}});
  await client.mcp.list();
  await client.mcp.call('calendar', 'create', { title: 'Meeting' });
  await client.agents.list();
  await client.agents.get('child');
  await client.agents.send('child', { question: 'answer?' }, { correlationId: 'request' });
  await client.supervisor.send('help', { correlationId: 'request' });
  await client.sendSupervisor('help-again');
  await client.models.call({ prompt: 'Hi' });
  await client.tools.call('lookup', { key: 'value' });
  await client.inbox.receive({ waitMs: 10, leaseMs: 1000 });
  await client.inbox.ack({ id: 'message', leaseToken: 'secret' });
  await client.inbox.nack('message', 'secret');
  await client.inbox.receipt('message');
  assert.deepEqual(seen, [
    { method: 'tools.listTools', input: {cursor:'0'} },
    { method: 'tools.callTool', input: { name: 'sum', arguments: { x: 1 } } },
    { method: 'mcp.list', input: null },
    { method: 'mcp.call', input: { server: 'calendar', tool: 'create', args: { title: 'Meeting' } } },
    { method: 'agents.list', input: null },
    { method: 'agents.get', input: { id: 'child' } },
    { method: 'agents.send', input: { id: 'child', body: { question: 'answer?' }, correlationId: 'request' } },
    { method: 'supervisor.send', input: { body: 'help', correlationId: 'request' } },
    { method: 'supervisor.send', input: { body: 'help-again' } },
    { method: 'models.call', input: { prompt: 'Hi' } },
    { method: 'tools.call', input: { name: 'lookup', args: { key: 'value' } } },
    { method: 'inbox.receive', input: { waitMs: 10, leaseMs: 1000 } },
    { method: 'inbox.ack', input: { id: 'message', leaseToken: 'secret' } },
    { method: 'inbox.nack', input: { id: 'message', leaseToken: 'secret' } },
    { method: 'inbox.receipt', input: { id: 'message' } },
  ]);
});

test('bridge rejects browser auth, malformed envelopes, oversized requests, and stale tokens', async (t) => {
  let calls = 0;
  const server = new AppBridgeServer({ handler: async () => { calls++; return null; } });
  t.after(() => server.dispose());
  await server.ready;
  const run = snapshot();
  const env = server.register(run, { command: ['node'] }).env;
  assert.match(env.DSH_PROGRAM_BRIDGE_URL!, /^http:\/\/127\.0\.0\.1:\d+$/);
  const invalid = { ...env, DSH_PROGRAM_BRIDGE_TOKEN: 'invalid' };
  assert.equal((await direct(invalid, { method: 'agents.list', input: null })).status, 401);
  assert.equal((await direct(env, { method: 'agents.list', input: null }, { Origin: 'http://127.0.0.1:3080' })).status, 403);
  assert.equal((await direct(env, { method: 'agents.list', input: null, ownerId: 'intruder' })).status, 400);
  assert.equal((await direct(env, 'not-json')).status, 400);
  assert.equal((await direct(env, { method: 'tools.callTool', input: 'x'.repeat(65536) })).status, 413);
  assert.equal(calls, 0);
  await connectProgram(configured(env)).call('agents.list');
  assert.equal(calls, 1);
  server.revoke(run);
  assert.equal((await direct(env, { method: 'agents.list', input: null })).status, 401);
  const next = server.register(snapshot('run', 2), { command: ['node'] }).env;
  assert.notEqual(next.DSH_PROGRAM_BRIDGE_TOKEN, env.DSH_PROGRAM_BRIDGE_TOKEN);
  await connectProgram(configured(next)).call('agents.list');
  server.revoke(run); // stale revoke cannot revoke a newer generation.
  await connectProgram(configured(next)).call('agents.list');
});

test('deadline slots remain occupied until non-cooperative handlers settle and revoke aborts promptly', async (t) => {
  let finish!: (value: JsonValue) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let handlerSignal!: AbortSignal;
  const server = new AppBridgeServer({ maxOutstanding: 1, timeoutMs: 40, handler: async (_context, _method, _input, signal) => {
    handlerSignal = signal;
    entered();
    return new Promise<JsonValue>((resolve) => { finish = resolve; });
  } });
  t.after(() => server.dispose());
  await server.ready;
  const run = snapshot();
  const env = server.register(run, { command: ['node'] }).env;
  const client = connectProgram(configured(env));
  const timed = client.call('tools.callTool');
  await started;
  await assert.rejects(timed, hasCode('TIMEOUT'));
  assert.equal(handlerSignal.aborted, true);
  await assert.rejects(client.call('tools.callTool'), hasCode('BACKPRESSURE'));
  finish(null);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const secondStarted = new Promise<void>((resolve) => { entered = resolve; });
  const active = client.call('tools.callTool');
  await secondStarted;
  server.revoke(run);
  assert.equal(handlerSignal.aborted, true);
  await assert.rejects(active, hasCode('REVOKED'));
  finish(null);
});

test('client abort is independent per call and does not retry effects', async (t) => {
  let calls = 0;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const server = new AppBridgeServer({ handler: async (_context, method, _input, signal) => {
    calls++;
    if (method === 'fast') return 'ok';
    entered();
    return new Promise<JsonValue>((resolve) => { signal.addEventListener('abort', () => resolve(null), { once: true }); });
  } });
  t.after(() => server.dispose());
  await server.ready;
  const env = server.register(snapshot(), { command: ['node'] }).env;
  const client = connectProgram(configured(env));
  const controller = new AbortController();
  const slow = client.call('slow', null, { signal: controller.signal });
  await started;
  assert.equal(await client.call('fast'), 'ok');
  controller.abort();
  await assert.rejects(slow, hasCode('CANCELLED'));
  assert.equal(calls, 2);
  await assert.rejects(client.call('fast', null, { signal: AbortSignal.abort() }), hasCode('CANCELLED'));
  assert.equal(calls, 2);
});

test('client fails closed without configuration and never accepts remote or credentialed URLs', () => {
  const previous = { url: process.env.DSH_PROGRAM_BRIDGE_URL, token: process.env.DSH_PROGRAM_BRIDGE_TOKEN };
  delete process.env.DSH_PROGRAM_BRIDGE_URL;
  delete process.env.DSH_PROGRAM_BRIDGE_TOKEN;
  try {
    assert.throws(() => connectProgram(), hasCode('NOT_CONFIGURED'));
    for (const url of ['https://example.com', 'http://localhost:3000', 'http://127.0.0.1:3000/path', 'http://user:pass@127.0.0.1:3000/']) assert.throws(() => connectProgram({ url, token: 'secret' }), hasCode('INVALID_CONFIG'));
  } finally {
    if (previous.url === undefined) delete process.env.DSH_PROGRAM_BRIDGE_URL; else process.env.DSH_PROGRAM_BRIDGE_URL = previous.url;
    if (previous.token === undefined) delete process.env.DSH_PROGRAM_BRIDGE_TOKEN; else process.env.DSH_PROGRAM_BRIDGE_TOKEN = previous.token;
  }
});
