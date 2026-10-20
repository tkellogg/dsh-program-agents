import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import * as host from '../src/host/index.js';
import { createProgramClient, type RpcTransport } from '../src/client/transport.js';
import type { ProgramSnapshot } from '../src/types.js';

// Wire the real host plugin into a real disposable Cordis context, but stub the
// Connection physical carrier and supervisor effects. No program or live host.
test('client and host dedicated RPC agree and reject principal/owner/generation/schema escapes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-client-contract-'));
  const ctx = new Context();
  let handler: ((endpoint: string, payload: unknown, signal: AbortSignal, peer: { principal: { kind: string } }) => Promise<unknown>) | undefined;
  let registered = 0;
  ctx.provide('tools', { register() { return () => {}; } });
  const owner = { id: 'session-a' };
  ctx.provide('agents', { get(id: string) { return id === owner.id ? owner : undefined; } });
  ctx.provide('llm', {});
  ctx.provide('connection', { rpc: { handle(channel: string, value: typeof handler) {
    assert.equal(channel, '/program-agents'); registered++; handler = value;
    return async () => { handler = undefined; };
  }, intercept() { throw new Error('Do not intercept DSH Gateway.'); } } });
  const fiber = ctx.plugin(host, { auditDirectory: directory, programs: {} });
  try {
    await fiber.await(); assert.equal(registered, 1); assert.ok(handler);
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
    const invoke = async (endpoint: string, payload: unknown, kind = 'owner') => handler!(endpoint, payload, signal, { principal: { kind } }) as Promise<{ ok: boolean; value?: unknown; error?: { message: string } }>;
    const transport: RpcTransport = { call(channel, endpoint, payload, signal) {
      assert.equal(channel, '/program-agents');
      return handler!(endpoint, payload, signal!, { principal: { kind: 'owner' } }) as ReturnType<RpcTransport['call']>;
    } };
    const client = createProgramClient(transport, 'session-a');
    const runs = await client.list(signal); assert.equal(runs.runs[0]?.generation, 2);
    await client.action('send', runs.runs[0]!, { hello: true }, signal);
    await client.action('stop', runs.runs[0]!, undefined, signal);
    await client.action('restart', runs.runs[0]!, undefined, signal);
    assert.deepEqual(effects, ['send:{"hello":true}', 'stop', 'restart']); effects.length = 0;
    const args = { sessionId: 'session-a', id: 'p1', generation: 2 };
    for (const [endpoint, payload, kind] of [
      ['list', { sessionId: 'session-a' }, 'agent'],
      ['stop', args, 'agent'],
      ['start', { sessionId: 'session-a', program: 'worker' }, 'owner'],
      ['stop', { ...args, sessionId: 'session-b' }, 'owner'],
      ['restart', { ...args, generation: 1 }, 'owner'],
      ['send', args, 'owner'],
      ['stop', { ...args, body: {} }, 'owner'],
      ['list', { args: { sessionId: 'session-a' } }, 'owner'],
      ['list', { sessionId: 'session-a', extra: 1 }, 'owner'],
    ] as const) {
      const result = await invoke(endpoint, payload, kind);
      assert.equal(result.ok, false, JSON.stringify({ endpoint, payload, kind }));
    }
    assert.deepEqual(effects, []);
    service.adapter['owners'].delete('session-a');
    const disposed = await invoke('restart', args); assert.equal(disposed.ok, false); assert.match(disposed.error?.message ?? '', /no longer live/);
    assert.deepEqual(effects, []);
  } finally {
    await fiber.dispose();
    assert.equal(handler, undefined);
    await rm(directory, { recursive: true, force: true });
  }
});
