import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { test, type TestContext } from 'node:test';
import { connectProgram } from '../src/app/index.js';
import { createProgramInbox, SettlementUnknownError, type InboxBridgeCall } from '../src/app/inbox.js';
import { MessageStore } from '../src/app/mailbox.js';
import { AppBridgeServer, type AppBridgeServerOptions } from '../src/app/server.js';
import { ProgramError } from '../src/runtime/protocol.js';
import type { JsonValue, ProgramSnapshot } from '../src/types.js';

const scope = { ownerId: 'parent', program: 'app', claimant: 'run:1' };
const hasCode = (code: string) => (error: unknown) => error instanceof ProgramError && error.code === code;
const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
const asJson = (value: unknown): JsonValue => value as JsonValue;

function storeBridge(store: MessageStore, seen: string[] = []): InboxBridgeCall {
  return async <T>(method: string, input?: JsonValue, options?: { signal?: AbortSignal }): Promise<T> => {
    seen.push(method);
    const args = input as { id: string; leaseToken: string; leaseMs: number; waitMs: number };
    if (method === 'inbox.receive') return await store.receive(scope, args, options?.signal) as T;
    if (method === 'inbox.renew') return store.renew(scope, args.id, args.leaseToken, args.leaseMs) as T;
    if (method === 'inbox.ack') return store.ack(scope, args.id, args.leaseToken) as T;
    if (method === 'inbox.nack') return store.nack(scope, args.id, args.leaseToken) as T;
    if (method === 'inbox.receipt') return store.receipt(scope, args.id) as T;
    throw new Error(`Unexpected ${method}`);
  };
}

async function realClient(t: TestContext, handler: AppBridgeServerOptions['handler']) {
  const bridge = new AppBridgeServer({ handler });
  t.after(() => bridge.dispose());
  await bridge.ready;
  const run: ProgramSnapshot = { id: 'run', generation: 1, program: 'app', ownerId: 'parent', label: 'Managed app', state: 'running', startedAt: new Date().toISOString(), logs: [], messages: [], resources: [] };
  const { env } = bridge.register(run, { command: ['node', 'app.mjs'] });
  return connectProgram({ url: env.DSH_PROGRAM_BRIDGE_URL, token: env.DSH_PROGRAM_BRIDGE_TOKEN, logger: { stdout: false } });
}

test('real server/client and standalone helper await callback before ACK and preserve its result', async (t) => {
  const store = new MessageStore(':memory:');
  t.after(() => store.close());
  const seen: string[] = [];
  const call = storeBridge(store, seen);
  const app = await realClient(t, async (_ctx, method, input, signal) => call(method, input, { signal }));
  const inbox = createProgramInbox(app.call);
  const accepted = store.send(scope, { from: 'agent', body: { nested: ['work'] }, correlationId: 'request' });
  const entered = deferred();
  const finish = deferred();
  let callbacks = 0;
  const controller = new AbortController();
  const baseline = getEventListeners(controller.signal, 'abort').length;
  const processing = inbox.receive({ leaseMs: 500, signal: controller.signal }, async (message, context) => {
    callbacks++;
    assert.equal(message.id, accepted.id);
    assert.equal('leaseToken' in message, false);
    assert.equal('ack' in message, false);
    assert.ok(Object.isFrozen(message));
    assert.ok(Object.isFrozen(message.body));
    assert.ok(Object.isFrozen(message.receipt));
    assert.equal(context.signal.aborted, false);
    entered.resolve();
    await finish.promise;
    return { processed: message.id };
  });
  await entered.promise;
  assert.equal(store.receipt(scope, accepted.id)?.status, 'claimed');
  assert.deepEqual(seen, ['inbox.receive']);
  finish.resolve();
  assert.deepEqual(await processing, { processed: accepted.id });
  assert.equal(callbacks, 1);
  assert.equal(store.receipt(scope, accepted.id)?.status, 'acked');
  assert.deepEqual(seen, ['inbox.receive', 'inbox.ack']);
  assert.equal(getEventListeners(controller.signal, 'abort').length, baseline);
  assert.equal(await inbox.receive(async () => { throw new Error('must not run'); }), null);
});

test('real server/client legacy receive and claim remain explicit low-level operations', async (t) => {
  const store = new MessageStore(':memory:');
  t.after(() => store.close());
  const call = storeBridge(store);
  const app = await realClient(t, async (_ctx, method, input, signal) => call(method, input, { signal }));
  const inbox = createProgramInbox(app.call);
  const accepted = store.send(scope, { from: 'parent', body: 'manual' });
  const claimed = await inbox.receive({ leaseMs: 1000 });
  assert.ok(claimed?.leaseToken);
  await inbox.nack(claimed);
  const next = await inbox.claim({ leaseMs: 1000 });
  assert.ok(next);
  assert.equal((await inbox.renew(next, 2000)).status, 'claimed');
  await inbox.ack(next.id, next.leaseToken);
  assert.equal((await inbox.receipt(accepted.id))?.status, 'acked');
});

test('callback throws once, auto-NACKs once, and never auto-repeats', async (t) => {
  const store = new MessageStore(':memory:');
  t.after(() => store.close());
  const accepted = store.send(scope, { from: 'parent', body: 'fail' });
  const seen: string[] = [];
  const inbox = createProgramInbox(storeBridge(store, seen));
  const failure = new Error('handler failure');
  let callbacks = 0;
  await assert.rejects(inbox.receive(async () => { callbacks++; throw failure; }), (error) => error === failure);
  assert.equal(callbacks, 1);
  assert.deepEqual(seen, ['inbox.receive', 'inbox.nack']);
  assert.equal(store.receipt(scope, accepted.id)?.status, 'accepted');
  assert.equal(store.receipt(scope, accepted.id)?.attempts, 1);
});

test('heartbeat renews without repeated callbacks and cleans timers after success', async (t) => {
  let now = Date.now();
  const store = new MessageStore(':memory:', { clock: () => now });
  t.after(() => store.close());
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const accepted = store.send(scope, { from: 'parent', body: 'long' });
  const seen: string[] = [];
  const inbox = createProgramInbox(storeBridge(store, seen));
  const finish = deferred();
  let callbacks = 0;
  const processing = inbox.receive({ leaseMs: 600, processingTimeoutMs: 5000 }, async () => { callbacks++; await finish.promise; return 42; });
  await flush();
  for (let i = 0; i < 5; i++) {
    now += 200;
    t.mock.timers.tick(200);
    await flush();
    assert.equal(await store.receive({ ...scope, claimant: 'other' }), null);
    assert.equal(store.receipt(scope, accepted.id)?.leaseUntil, new Date(now + 600).toISOString());
  }
  assert.equal(callbacks, 1);
  assert.equal(seen.filter((method) => method === 'inbox.renew').length, 5);
  finish.resolve();
  assert.equal(await processing, 42);
  const count = seen.length;
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(seen.length, count);
  assert.equal(seen.at(-1), 'inbox.ack');
});

test('heartbeat failure aborts context, never ACKs even a late successful callback, and NACK waits for it', async (t) => {
  const store = new MessageStore(':memory:');
  t.after(() => store.close());
  t.mock.timers.enable({ apis: ['setTimeout'] });
  store.send(scope, { from: 'parent', body: 'lease-fail' });
  const seen: string[] = [];
  const bridge = storeBridge(store, seen);
  const failure = new ProgramError('LEASE_LOST', 'renew failed');
  const inbox = createProgramInbox(async <T>(method: string, input?: JsonValue, options?: {}) => {
    if (method === 'inbox.renew') { seen.push(method); throw failure; }
    return bridge<T>(method, input, options);
  });
  const finish = deferred();
  let signal!: AbortSignal;
  const controller = new AbortController();
  const processing = inbox.receive({ leaseMs: 600, signal: controller.signal }, async (_message, ctx) => { signal = ctx.signal; await finish.promise; return 'late'; });
  const rejected = assert.rejects(processing, (error) => error === failure);
  await flush();
  t.mock.timers.tick(200);
  await flush();
  await rejected;
  assert.equal(signal.aborted, true);
  assert.deepEqual(seen, ['inbox.receive', 'inbox.renew']);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  finish.resolve();
  await flush();
  assert.deepEqual(seen, ['inbox.receive', 'inbox.renew', 'inbox.nack']);
  t.mock.timers.tick(200_000);
  await flush();
  assert.equal(seen.length, 3);
});

test('callback completion drains an in-flight renewal failure before deciding to ACK', async (t) => {
  const store = new MessageStore(':memory:');
  t.after(() => store.close());
  t.mock.timers.enable({ apis: ['setTimeout'] });
  store.send(scope, { from: 'parent', body: 'renew-race' });
  const seen: string[] = [];
  const call = storeBridge(store, seen);
  const releaseRenewal = deferred();
  const finish = deferred();
  const failure = new ProgramError('LEASE_LOST', 'late renewal failure');
  const inbox = createProgramInbox(async <T>(method: string, input?: JsonValue, options?: {}) => {
    if (method === 'inbox.renew') { seen.push(method); await releaseRenewal.promise; throw failure; }
    return call<T>(method, input, options);
  });
  const processing = inbox.receive({ leaseMs: 600 }, async () => { await finish.promise; return 'callback done'; });
  const rejected = assert.rejects(processing, (error) => error === failure);
  await flush();
  t.mock.timers.tick(200);
  await flush();
  finish.resolve();
  await flush();
  assert.deepEqual(seen, ['inbox.receive', 'inbox.renew']);
  releaseRenewal.resolve();
  await rejected;
  await flush();
  assert.deepEqual(seen, ['inbox.receive', 'inbox.renew', 'inbox.nack']);
});

test('lost ACK response is SettlementUnknownError with cause, no NACK, no retry, and one callback', async (t) => {
  const store = new MessageStore(':memory:');
  t.after(() => store.close());
  const accepted = store.send(scope, { from: 'parent', body: 'commit-then-disconnect' });
  const seen: string[] = [];
  const bridge = storeBridge(store, seen);
  const cause = new Error('ACK response lost after durable commit');
  const inbox = createProgramInbox(async <T>(method: string, input?: JsonValue, options?: {}) => {
    const result = await bridge<T>(method, input, options);
    if (method === 'inbox.ack') throw cause;
    return result;
  });
  let callbacks = 0;
  await assert.rejects(inbox.receive(async () => { callbacks++; return 'done'; }), (error) => {
    assert.ok(error instanceof SettlementUnknownError);
    assert.equal(error.messageId, accepted.id);
    assert.equal(error.outcome, 'unknown');
    assert.equal(error.operation, 'ack');
    assert.equal(error.cause, cause);
    return true;
  });
  assert.equal(callbacks, 1);
  assert.equal(store.receipt(scope, accepted.id)?.status, 'acked');
  assert.deepEqual(seen, ['inbox.receive', 'inbox.ack']);
});

test('cancelled noncooperative callback retains live lease until deadline, never NACKs early or ACKs late', async (t) => {
  let now = Date.now();
  const store = new MessageStore(':memory:', { clock: () => now });
  t.after(() => store.close());
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const accepted = store.send(scope, { from: 'parent', body: 'noncooperative' });
  const seen: string[] = [];
  const inbox = createProgramInbox(storeBridge(store, seen));
  const controller = new AbortController();
  const finish = deferred();
  let signal!: AbortSignal;
  const processing = inbox.receive({ signal: controller.signal, leaseMs: 600, processingTimeoutMs: 1000 }, async (_message, ctx) => { signal = ctx.signal; await finish.promise; return 'too late'; });
  const rejected = assert.rejects(processing, hasCode('CANCELLED'));
  await flush();
  controller.abort();
  await rejected;
  assert.equal(signal.aborted, true);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.deepEqual(seen, ['inbox.receive']);
  for (let i = 0; i < 4; i++) {
    now += 200;
    t.mock.timers.tick(200);
    await flush();
    assert.equal(await store.receive({ ...scope, claimant: 'other' }), null);
  }
  now += 200;
  t.mock.timers.tick(200);
  await flush();
  assert.equal(seen.filter((method) => method === 'inbox.renew').length, 4);
  now += 600;
  t.mock.timers.tick(600);
  await flush();
  const replacementScope = { ...scope, claimant: 'other' };
  const replacement = await store.receive(replacementScope);
  assert.equal(replacement?.id, accepted.id);
  // At-least-once explicitly permits redelivery after bounded lease maintenance,
  // despite still-running user code. Its eventual return cannot settle the new claim.
  finish.resolve();
  await flush();
  assert.equal(seen.includes('inbox.ack'), false);
  assert.equal(seen.filter((method) => method === 'inbox.nack').length, 1);
  assert.equal(store.receipt(scope, accepted.id)?.status, 'claimed');
  store.ack(replacementScope, replacement!.id, replacement!.leaseToken);
});

test('processing deadline aborts once, rejects promptly, and only releases callback slot when actual code settles', async (t) => {
  const store = new MessageStore(':memory:');
  t.after(() => store.close());
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (let i = 0; i < 34; i++) store.send(scope, { from: 'parent', body: i });
  const seen: string[] = [];
  const inbox = createProgramInbox(storeBridge(store, seen));
  const finishes = Array.from({ length: 32 }, () => deferred());
  const controllers = Array.from({ length: 32 }, () => new AbortController());
  let actual = 0;
  let maxActual = 0;
  let aborts = 0;
  const rejected = finishes.map((finish, i) => {
    const processing = inbox.receive({ signal: controllers[i].signal, processingTimeoutMs: 25 }, async (_message, ctx) => {
      actual++;
      maxActual = Math.max(actual, maxActual);
      ctx.signal.addEventListener('abort', () => { aborts++; }, { once: true });
      await finish.promise;
      actual--;
      return true;
    });
    return assert.rejects(processing, hasCode('TIMEOUT'));
  });
  await flush();
  assert.equal(actual, 32);
  t.mock.timers.tick(25);
  await flush();
  await Promise.all(rejected);
  assert.equal(aborts, 32);
  for (const controller of controllers) assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(seen.includes('inbox.nack'), false);
  for (let i = 0; i < 50; i++) await assert.rejects(inbox.receive(async () => { actual++; throw new Error('must not enter'); }), hasCode('BACKPRESSURE'));
  assert.equal(actual, 32);
  assert.equal(maxActual, 32);
  finishes[0].resolve();
  await flush();
  assert.equal(actual, 31);
  assert.equal(await inbox.receive(async () => 'one available slot'), 'one available slot');
  for (const finish of finishes) finish.resolve();
  await flush();
  assert.equal(actual, 0);
  const count = seen.length;
  t.mock.timers.tick(4_000_000);
  await flush();
  assert.equal(seen.length, count);
});

test('cancellation before claim and while polling never invokes or replays callback', async (t) => {
  const store = new MessageStore(':memory:');
  t.after(() => store.close());
  const call = storeBridge(store);
  const app = await realClient(t, async (_ctx, method, input, signal) => asJson(await call(method, input, { signal })));
  const inbox = createProgramInbox(app.call);
  let calls = 0;
  const handler = async () => { calls++; return true; };
  await assert.rejects(inbox.receive({ signal: AbortSignal.abort() }, handler), hasCode('CANCELLED'));
  const controller = new AbortController();
  const pending = inbox.receive({ waitMs: 30_000, signal: controller.signal }, handler);
  const rejected = assert.rejects(pending, hasCode('CANCELLED'));
  controller.abort();
  await rejected;
  assert.equal(calls, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('real bridge heartbeat preserves claim, then cancellation waits for cooperative callback before NACK', async (t) => {
  const store = new MessageStore(':memory:');
  t.after(() => store.close());
  const accepted = store.send(scope, { from: 'parent', body: 'network-heartbeat' });
  const seen: string[] = [];
  const renewed = deferred();
  const nacked = deferred();
  const call = storeBridge(store, seen);
  const app = await realClient(t, async (_ctx, method, input, signal) => {
    const value = await call(method, input, { signal });
    if (method === 'inbox.renew') renewed.resolve();
    if (method === 'inbox.nack') nacked.resolve();
    return value;
  });
  const inbox = app.inbox;
  const controller = new AbortController();
  let callbacks = 0;
  const processing = inbox.receive({ leaseMs: 500, processingTimeoutMs: 5000, signal: controller.signal }, async (_message, ctx) => {
    callbacks++;
    await new Promise<void>((resolve) => ctx.signal.addEventListener('abort', () => resolve(), { once: true }));
    return 'cooperated';
  });
  const rejected = assert.rejects(processing, hasCode('CANCELLED'));
  await renewed.promise;
  assert.equal(store.receipt(scope, accepted.id)?.status, 'claimed');
  controller.abort();
  await rejected;
  await nacked.promise;
  assert.equal(callbacks, 1);
  assert.equal(seen.includes('inbox.ack'), false);
  assert.equal(seen.filter((method) => method === 'inbox.nack').length, 1);
  assert.equal(store.receipt(scope, accepted.id)?.status, 'accepted');
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('real ACK commit followed by caller abort reports unknown and never compensates or repeats', async (t) => {
  const store = new MessageStore(':memory:');
  t.after(() => store.close());
  const accepted = store.send(scope, { from: 'parent', body: 'durable-ack-lost' });
  const seen: string[] = [];
  const committed = deferred();
  const respond = deferred();
  t.after(() => respond.resolve());
  const call = storeBridge(store, seen);
  const app = await realClient(t, async (_ctx, method, input, signal) => {
    const value = await call(method, input, { signal });
    if (method === 'inbox.ack') { committed.resolve(); await respond.promise; }
    return value;
  });
  const inbox = createProgramInbox(app.call);
  const controller = new AbortController();
  let callbacks = 0;
  const processing = inbox.receive({ signal: controller.signal }, async () => { callbacks++; return 'effect committed'; });
  const rejected = assert.rejects(processing, (error) => {
    assert.ok(error instanceof SettlementUnknownError);
    assert.equal(error.messageId, accepted.id);
    assert.equal(error.outcome, 'unknown');
    assert.ok(error.cause instanceof ProgramError);
    assert.equal(error.cause.code, 'CANCELLED');
    return true;
  });
  await committed.promise;
  controller.abort();
  await rejected;
  respond.resolve();
  assert.equal(callbacks, 1);
  assert.equal(store.receipt(scope, accepted.id)?.status, 'acked');
  assert.deepEqual(seen, ['inbox.receive', 'inbox.ack']);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('malformed claim receipt never invokes callback or settlement', async (t) => {
  const store = new MessageStore(':memory:');
  t.after(() => store.close());
  store.send(scope, { from: 'parent', body: 'bad-claim-response' });
  const seen: string[] = [];
  const call = storeBridge(store, seen);
  const inbox = createProgramInbox(async <T>(method: string, input?: JsonValue, options?: {}) => {
    const value = await call<any>(method, input, options);
    if (method === 'inbox.receive' && value) value.receipt.status = 'accepted';
    return value as T;
  });
  let callbacks = 0;
  await assert.rejects(inbox.receive(async () => { callbacks++; }), hasCode('INVALID_RESPONSE'));
  assert.equal(callbacks, 0);
  assert.deepEqual(seen, ['inbox.receive']);
});

test('synchronous callback cannot ACK after monopolizing event loop past its deadline', async (t) => {
  const store = new MessageStore(':memory:');
  t.after(() => store.close());
  store.send(scope, { from: 'parent', body: 'blocking' });
  const seen: string[] = [];
  const inbox = createProgramInbox(storeBridge(store, seen));
  await assert.rejects(inbox.receive({ processingTimeoutMs: 1 }, () => {
    const until = performance.now() + 5;
    while (performance.now() < until) { /* Deliberately noncooperative synchronous code. */ }
    return true;
  }), hasCode('TIMEOUT'));
  assert.deepEqual(seen, ['inbox.receive', 'inbox.nack']);
});

test('managed bounds reject before claim and malformed ACK is unknown, not NACK', async (t) => {
  const store = new MessageStore(':memory:');
  t.after(() => store.close());
  const seen: string[] = [];
  const bridge = storeBridge(store, seen);
  const inbox = createProgramInbox(bridge);
  for (const options of [{ leaseMs: 499 }, { leaseMs: 300_001 }, { leaseMs: null }, { processingTimeoutMs: 0 }, { processingTimeoutMs: 3_600_001 }, { processingTimeoutMs: '1000' }, { timeoutMs: 0 }, { waitMs: 30_001 }, { signal: {} }]) await assert.rejects(inbox.receive(options as never, async () => 1), hasCode('INVALID_INPUT'));
  assert.deepEqual(seen, []);
  store.send(scope, { from: 'parent', body: 'malformed ack' });
  const invalidAck = createProgramInbox(async <T>(method: string, input?: JsonValue, options?: {}) => method === 'inbox.ack' ? null as T : bridge<T>(method, input, options));
  await assert.rejects(invalidAck.receive(async () => true), (error) => error instanceof SettlementUnknownError);
  assert.deepEqual(seen, ['inbox.receive']);
});
