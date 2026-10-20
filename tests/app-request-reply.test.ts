import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppBridgeServer } from '../src/app/server.js';
import { MessageStore } from '../src/app/mailbox.js';
import { connectProgram, type InboxMessage } from '../src/app/index.js';
import type { JsonValue, ProgramSnapshot } from '../src/types.js';

// The host handler is intentionally explicit: the bridge is a transport, not an
// arbitrary command surface, and only the host supplies sender and queue scope.
test('app-to-agent request reply crosses bridge with correlation and separately acknowledged receipt', async (t) => {
  const store = new MessageStore(':memory:');
  const run: ProgramSnapshot = { id: 'run', generation: 1, program: 'app', ownerId: 'parent', label: 'App', state: 'running', startedAt: new Date().toISOString(), logs: [], messages: [], resources: [] };
  const scope = { ownerId: run.ownerId, program: run.program, claimant: `${run.id}:${run.generation}` };
  let replyId = '';
  const server = new AppBridgeServer({ handler: async (context, method, input, signal) => {
    assert.equal(context.run.ownerId, 'parent');
    const args = input as Record<string, JsonValue>;
    if (method === 'agents.send') {
      assert.equal(args.id, 'worker-agent');
      assert.equal(args.correlationId, 'job-123');
      const receipt = store.send(scope, { from: 'worker-agent', body: { answer: 42 }, correlationId: String(args.correlationId) });
      replyId = receipt.id;
      return { delivery: 'agent-accepted', correlationId: args.correlationId };
    }
    if (method === 'inbox.receive') return await store.receive(scope, args, signal) as unknown as JsonValue;
    if (method === 'inbox.ack') return store.ack(scope, String(args.id), String(args.leaseToken)) as unknown as JsonValue;
    if (method === 'inbox.receipt') return store.receipt(scope, String(args.id)) as unknown as JsonValue;
    throw new Error('Not granted');
  } });
  t.after(async () => { await server.dispose(); store.close(); });
  await server.ready;
  const env = server.register(run, { command: ['node'] }).env;
  const app = connectProgram({ url: env.DSH_PROGRAM_BRIDGE_URL, token: env.DSH_PROGRAM_BRIDGE_TOKEN, logger: { stdout: false } });
  const sent = await app.agents.send('worker-agent', { question: 'life?' }, { correlationId: 'job-123' });
  assert.deepEqual(sent, { delivery: 'agent-accepted', correlationId: 'job-123' });
  assert.equal((await app.inbox.receipt(replyId))?.status, 'accepted');
  const reply = await app.inbox.receive({ waitMs: 100 });
  assert.ok(reply);
  assert.equal(reply.correlationId, 'job-123');
  assert.equal(reply.from, 'worker-agent');
  assert.deepEqual(reply.body, { answer: 42 });
  assert.equal((await app.inbox.receipt(reply.id))?.status, 'claimed');
  const ack = await app.inbox.ack(reply as InboxMessage);
  assert.equal(ack.status, 'acked');
  assert.equal((await app.inbox.receipt(reply.id))?.status, 'acked');
});
