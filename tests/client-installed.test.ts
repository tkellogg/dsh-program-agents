import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import test from 'node:test';
import { createProgramClient, type RpcTransport } from '../src/client/transport.js';

// Optional read-only compatibility against installed DSH. Isolated fake carrier;
// no live routes/secrets. Streaming intentionally uses the native HTTP fallback:
// rc.2's public ConnectionHandle exposes no HTTP streaming request facade.
const installedBundle = process.env.DSH_CLIENT_CONNECTION_BUNDLE;
test('installed DSH browser carrier accepts named action args and native mount-aware SSE fallback', { skip: !installedBundle }, async () => {
  let factory: ((require: (name: string) => never) => { installConnection(ctx: unknown, options: unknown): void }) | undefined;
  const source = await readFile(installedBundle!, 'utf8');
  const requests: Array<{ path: string; envelope: { type: string; rpcId: string; method: string; payload: unknown } }> = [];
  const browserFetch = async (path: string, init: RequestInit) => {
    const envelope = JSON.parse(init.body as string); requests.push({ path, envelope });
    return new Response(JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value: envelope.method === 'programAgents/list' ? { runs: [], programs: [] } : undefined } }), { headers: { 'content-type': 'application/json' } });
  };
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load(module: { id: string; factory: typeof factory }) { assert.equal(module.id, '@deepseek-ai/dsh-client-connection'); factory = module.factory; } } },
    fetch: browserFetch, crypto: webcrypto, AbortController, URL, Headers, setTimeout, clearTimeout, console,
  }, { filename: 'installed-dsh-client-connection.js' });
  assert.ok(factory); const module = factory(name => { throw new Error(`Unexpected external ${name}`); });
  let connection!: { rpc: RpcTransport; fetch?: unknown; http?: unknown };
  module.installConnection({ provide(name: string, handle: typeof connection) { assert.equal(name, 'connection'); connection = handle; } }, {});
  assert.equal(connection.fetch, undefined); assert.equal(connection.http, undefined);
  const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch'), originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  let streamRequest: { url: string; init: RequestInit } | undefined;
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { baseURI: 'https://host.test/prefix/' } });
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: async (input: URL, init: RequestInit) => {
    streamRequest = { url: input.href, init };
    return new Response('event: snapshot\ndata: {"runs":[],"programs":[]}\n\n', { headers: { 'content-type': 'text/event-stream' } });
  } });
  try {
    const client = createProgramClient(connection, 'session-live'), signal = new AbortController().signal;
    assert.deepEqual(await client.list(signal), { runs: [], programs: [], items: [], truncated: false });
    await client.action('start', { program: 'registered:opaque-key', name: 'App', description: '', command: [], urls: [] }, signal);
    const run = { id: 'p1', generation: 2, program: 'worker', ownerId: 'session-live', label: '', state: 'running' as const, startedAt: '', resources: [] };
    await client.action('stop', run, signal); await client.action('restart', run, signal);
    assert.deepEqual(requests.map(({ path, envelope }) => [path, envelope.type, envelope.method, envelope.payload]), [
      ['api/programAgents/list', 'client-request', 'programAgents/list', { sessionId: 'session-live' }],
      ['api/programAgents/start', 'client-request', 'programAgents/start', { sessionId: 'session-live', program: 'registered:opaque-key' }],
      ['api/programAgents/stop', 'client-request', 'programAgents/stop', { sessionId: 'session-live', id: 'p1', generation: 2 }],
      ['api/programAgents/restart', 'client-request', 'programAgents/restart', { sessionId: 'session-live', id: 'p1', generation: 2 }],
    ]);
    let snapshots = 0; await client.subscribe(() => { snapshots++; }, signal); assert.equal(snapshots, 1);
    assert.equal(streamRequest?.url, 'https://host.test/prefix/api/programAgents/events');
    assert.equal(streamRequest?.init.credentials, 'same-origin'); assert.equal(streamRequest?.init.redirect, 'error');
    assert.deepEqual(JSON.parse(streamRequest?.init.body as string), { sessionId: 'session-live' });
  } finally {
    if (originalFetch) Object.defineProperty(globalThis, 'fetch', originalFetch); else Reflect.deleteProperty(globalThis, 'fetch');
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument); else Reflect.deleteProperty(globalThis, 'document');
  }
});
