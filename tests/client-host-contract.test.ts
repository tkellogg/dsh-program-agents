import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import * as host from '../src/host/index.js';
import { createProgramClient, type RpcTransport } from '../src/client/transport.js';
import type { ProgramSnapshot } from '../src/types.js';

type Route = { path: string; methods: readonly string[]; requestBody: string; fetch(request: Request): Promise<Response> };

// The physical Connection carrier is stubbed here; actual rc.2 owner admission
// and exact-route disposal are covered separately in dsh-integration.test.ts.
test('client and host exact Fetch RPC agree and reject owner/generation/schema escapes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-client-contract-'));
  const ctx = new Context();
  const routes = new Map<string, Route>();
  ctx.provide('tools', { register() { return () => {}; } });
  const owner = { id: 'session-a' };
  ctx.provide('agents', { get(id: string) { return id === owner.id ? owner : undefined; } });
  ctx.provide('llm', {});
  ctx.provide('connection', {
    fetch: { register(route: Route) {
      assert.equal(route.requestBody, 'buffered');
      assert.deepEqual(route.methods, ['POST']);
      assert.equal(routes.has(route.path), false);
      routes.set(route.path, route);
      return async () => { routes.delete(route.path); };
    } },
    rpc: { handle() { throw new Error('Do not register the broken rc.2 dedicated channel.'); }, intercept() { throw new Error('Do not replace DSH Gateway.'); } },
  });
  const fiber = ctx.plugin(host, { auditDirectory: directory, programs: {} });
  try {
    await fiber.await();
    assert.deepEqual([...routes.keys()], ['list', 'send', 'stop', 'restart'].map(method => `/api/programAgents/${method}`));
    const service = ctx.programAgents;
    const snapshot: ProgramSnapshot = { id: 'p1', generation: 2, ownerId: 'session-a', program: 'worker', label: 'Worker', state: 'running', startedAt: '', logs: [], resources: [], messages: [] };
    service.adapter['owners'].set('session-a', owner as never);
    const effects: string[] = [];
    service.supervisor.list = (ownerId?: string) => ownerId === snapshot.ownerId ? [{ ...snapshot }] : [];
    service.supervisor.get = (id, ownerId) => {
      if (id !== snapshot.id || ownerId !== snapshot.ownerId) throw new Error('Program not found');
      return { ...snapshot };
    };
    service.supervisor.send = async (_id, _ownerId, body) => { effects.push(`send:${JSON.stringify(body)}`); };
    service.supervisor.stop = async () => { effects.push('stop'); return { ...snapshot, state: 'stopped' }; };
    service.supervisor.restart = async () => { effects.push('restart'); return { ...snapshot, generation: 3 }; };
    const signal = new AbortController().signal;
    let requestId = 0;
    const invoke = async (endpoint: string, payload: unknown, requestSignal = signal) => {
      const path = `/api/programAgents/${endpoint}`;
      const route = routes.get(path);
      assert.ok(route, `No route for ${endpoint}`);
      const rpcId = `contract-${++requestId}`;
      const response = await route.fetch(new Request(`http://localhost${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: requestSignal,
        body: JSON.stringify({ type: 'client-request', rpcId, method: `programAgents/${endpoint}`, payload }),
      }));
      assert.equal(response.status, 200);
      const envelope = await response.json();
      assert.equal(envelope.type, 'server-response'); assert.equal(envelope.rpcId, rpcId);
      return envelope.result;
    };
    const transport: RpcTransport = { call(channel, endpoint, payload, requestSignal) {
      assert.equal(channel, '/api'); assert.ok(endpoint.startsWith('programAgents/'));
      return invoke(endpoint.slice('programAgents/'.length), payload, requestSignal);
    } };
    const client = createProgramClient(transport, 'session-a');
    const runs = await client.list(signal); assert.equal(runs.runs[0]?.generation, 2);
    await client.action('send', runs.runs[0]!, { hello: true }, signal);
    await client.action('stop', runs.runs[0]!, undefined, signal);
    await client.action('restart', runs.runs[0]!, undefined, signal);
    assert.deepEqual(effects, ['send:{"hello":true}', 'stop', 'restart']); effects.length = 0;
    const args = { sessionId: 'session-a', id: 'p1', generation: 2 };
    for (const [endpoint, payload] of [
      ['stop', { ...args, sessionId: 'session-b' }],
      ['restart', { ...args, generation: 1 }],
      ['send', args],
      ['stop', { ...args, body: {} }],
      ['list', { args: { sessionId: 'session-a' } }],
      ['list', { sessionId: 'session-a', extra: 1 }],
    ] as const) {
      const result = await invoke(endpoint, payload);
      assert.equal(result.ok, false, JSON.stringify({ endpoint, payload }));
    }
    assert.equal(routes.has('/api/programAgents/start'), false);
    assert.deepEqual(effects, []);
    service.adapter['owners'].delete('session-a');
    const disposed = await invoke('restart', args); assert.equal(disposed.ok, false); assert.match(disposed.error?.message ?? '', /no longer live/);
    assert.deepEqual(effects, []);

    const listRoute = routes.get('/api/programAgents/list')!;
    const request = (body: string, contentType = 'application/json') => new Request('http://localhost/api/programAgents/list', { method: 'POST', headers: { 'content-type': contentType }, body });
    assert.equal((await listRoute.fetch(request('{}', 'text/plain'))).status, 415);
    assert.equal((await listRoute.fetch(request('x'.repeat(131073)))).status, 413);
    for (const envelope of [
      '{',
      JSON.stringify({ type: 'client-request', rpcId: 'bad-method', method: 'programAgents/stop', payload: { sessionId: 'session-a' } }),
      JSON.stringify({ type: 'client-request', rpcId: 3, method: 'programAgents/list', payload: { sessionId: 'session-a' } }),
      JSON.stringify({ type: 'client-request', rpcId: 'extra', method: 'programAgents/list', payload: { sessionId: 'session-a' }, extra: true }),
      JSON.stringify({ type: 'client-request', rpcId: 'x'.repeat(257), method: 'programAgents/list', payload: { sessionId: 'session-a' } }),
    ]) {
      const response = await listRoute.fetch(request(envelope));
      const reply = await response.json();
      assert.equal(reply.type, 'server-response'); assert.equal(reply.result.ok, false);
    }
    const cancelled = new AbortController(); cancelled.abort();
    assert.equal((await invoke('list', { sessionId: 'session-a' }, cancelled.signal)).ok, false);
  } finally {
    await fiber.dispose();
    assert.equal(routes.size, 0);
    await rm(directory, { recursive: true, force: true });
  }
});
