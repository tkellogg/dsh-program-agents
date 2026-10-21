import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { RequestStore } from '../src/host/requests.js';
import { REQUEST_LIMITS, type RequestScope } from '../src/requests.js';
import { assertJson, ProgramError } from '../src/runtime/protocol.js';
import type { JsonValue } from '../src/types.js';

const scope: RequestScope = { ownerId: 'parent', program: 'app' };
const otherOwner: RequestScope = { ownerId: 'other-parent', program: 'app' };
const otherProgram: RequestScope = { ownerId: 'parent', program: 'other-app' };
const code = (expected: string) => (error: unknown): boolean => error instanceof ProgramError && error.code === expected;
const input = () => ({ target: { id: 'worker' }, body: { question: 'life?' }, prompt: 'Answer the question', responseSchema: { type: 'integer' }, timeoutMs: 1000 });

test('request rows and immutable first response survive reopen without redispatch', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'agent-requests-')), 'private', 'requests.sqlite');
  let now = 10_000;
  let store = new RequestStore(path, { clock: () => now });
  const created = store.create(scope, { ...input(), requestId: 'job-1' });
  assert.match(created.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(created.id, created.requestId);
  assert.equal(created.requestKey, 'job-1');
  assert.notEqual(created.requestId, 'job-1');
  assert.equal(created.status, 'pending');
  assert.deepEqual(created.body, input().body);
  assert.deepEqual(created.responseSchema, input().responseSchema);
  assert.equal(created.prompt, input().prompt);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  store.assign(scope, created.id, 'worker');
  store.close();
  store = new RequestStore(path, { clock: () => now });
  assert.equal(store.get(scope, created.id)?.agentId, 'worker');
  assert.equal(store.listPending(scope).length, 1);
  assert.equal(store.getByKey(scope, 'job-1')?.id, created.id);
  now += 10;
  const accepted = store.reply(scope, created.id, 'worker', 42);
  assert.equal(accepted.status, 'answered');
  assert.equal(accepted.requestId, created.id);
  assert.equal(accepted.agentId, 'worker');
  assert.equal(accepted.answeredAt, new Date(now).toISOString());
  // Transport receipt can race behind a response; it never overwrites it.
  assert.equal(store.dispatchAccepted(scope, created.id).status, 'answered');
  assert.equal(store.cancel(scope, created.id).status, 'answered');
  assert.equal(store.fail(scope, created.id, 'too late').status, 'answered');
  assert.equal(store.dispatchUnknown(scope, created.id).status, 'answered');
  store.close();
  store = new RequestStore(path, { clock: () => now });
  const recovered = store.get(scope, created.id)!;
  assert.equal(recovered.response, 42);
  assert.deepEqual(recovered.receipt, accepted);
  assert.ok(recovered.dispatchAcceptedAt);
  assert.equal(store.listPending().length, 0);
  now += 10_000;
  assert.deepEqual(store.reply(scope, created.id, 'worker', 42), accepted);
  assert.throws(() => store.reply(scope, created.id, 'worker', 43), code('ALREADY_REPLIED'));
  assert.throws(() => store.reply(scope, created.id, 'worker', 'wrong type'), code('ALREADY_REPLIED'));
  store.close();
});

test('all access is owner/program-scoped; only exact assigned identity can reply', () => {
  const store = new RequestStore(':memory:');
  const request = store.create(scope, input());
  assert.equal(store.get(otherOwner, request.id), null);
  assert.equal(store.get(otherProgram, request.id), null);
  assert.throws(() => store.assign(otherOwner, request.id, 'intruder'), code('NOT_FOUND'));
  assert.throws(() => store.reply(otherProgram, request.id, 'worker', 42), code('NOT_FOUND'));
  assert.throws(() => store.cancel(otherOwner, request.id), code('NOT_FOUND'));
  assert.throws(() => store.reply(scope, request.id, 'worker', 42), code('NOT_ASSIGNED'));
  assert.throws(() => store.dispatchAccepted(scope, request.id), code('NOT_ASSIGNED'));
  store.assign(scope, request.id, 'worker');
  assert.equal(store.assign(scope, request.id, 'worker').agentId, 'worker');
  assert.throws(() => store.assign(scope, request.id, 'other-worker'), code('ALREADY_ASSIGNED'));
  assert.throws(() => store.reply(scope, request.id, 'other-worker', 42), code('WRONG_AGENT'));
  assert.equal(store.get(scope, request.id)?.status, 'pending');
  assert.throws(() => store.reply(scope, request.id, 'worker', '42'), code('INVALID_RESPONSE'));
  assert.equal(store.get(scope, request.id)?.status, 'pending');
  store.reply(scope, request.id, 'worker', 42);
  assert.throws(() => store.reply(scope, request.id, 'other-worker', 42), code('WRONG_AGENT'));
  store.close();
});

test('idempotency binds normalized input and never accepts changed semantics', () => {
  const store = new RequestStore(':memory:');
  const request = store.create(scope, { ...input(), requestId: 'stable' });
  assert.equal(store.create(scope, { ...input(), requestKey: 'stable' }).id, request.id);
  assert.throws(() => store.create(scope, { ...input(), requestId: 'stable', body: { question: 'different?' } }), code('IDEMPOTENCY_CONFLICT'));
  assert.throws(() => store.create(scope, { ...input(), requestId: 'stable', target: 'different' }), code('IDEMPOTENCY_CONFLICT'));
  assert.throws(() => store.create(scope, { ...input(), requestId: 'stable', responseSchema: true }), code('IDEMPOTENCY_CONFLICT'));
  assert.throws(() => store.create(scope, { ...input(), requestId: 'stable', prompt: 'different' }), code('IDEMPOTENCY_CONFLICT'));
  assert.throws(() => store.create(scope, { ...input(), requestId: 'stable', timeoutMs: 2000 }), code('IDEMPOTENCY_CONFLICT'));
  assert.notEqual(store.create(otherOwner, { ...input(), requestId: 'stable' }).id, request.id);
  assert.notEqual(store.create(otherProgram, { ...input(), requestId: 'stable' }).id, request.id);
  assert.notEqual(store.create(scope, input()).id, store.create(scope, input()).id);
  const defaulted = store.create(scope, { target: 'worker', body: 'question', requestId: 'defaulted' });
  assert.equal(store.create(scope, { target: 'worker', body: 'question', requestId: 'defaulted', timeoutMs: 120_000, responseSchema: { type: 'string' } }).id, defaulted.id);
  const ordered = store.create(scope, { target: 'worker', body: { a: 1, b: 2 }, requestId: 'ordered' });
  assert.equal(store.create(scope, { target: 'worker', body: { b: 2, a: 1 }, requestId: 'ordered' }).id, ordered.id);
  store.close();
});

test('two connections cannot overwrite accepted response; canonical duplicates share one receipt', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'agent-requests-concurrent-')), 'requests.sqlite');
  const first = new RequestStore(path);
  const second = new RequestStore(path);
  const request = first.create(scope, { target: 'worker', body: null, responseSchema: { type: 'object', properties: { a: { type: 'integer' }, b: { type: 'integer' } }, required: ['a', 'b'], additionalProperties: false } });
  first.assign(scope, request.id, 'worker');
  const receipt = second.reply(scope, request.id, 'worker', { a: 1, b: 2 });
  assert.deepEqual(first.reply(scope, request.id, 'worker', { b: 2, a: 1 }), receipt);
  assert.throws(() => first.reply(scope, request.id, 'worker', { a: 3, b: 2 }), code('ALREADY_REPLIED'));
  assert.deepEqual(first.get(scope, request.id)?.response, { a: 1, b: 2 });
  first.close(); second.close();
});

test('deadline is durable, cancellation is terminal, and ambiguous dispatch can still reply', async () => {
  let now = 100;
  const store = new RequestStore(':memory:', { clock: () => now });
  const request = store.create(scope, input());
  store.assign(scope, request.id, 'worker');
  now = 1100;
  assert.throws(() => store.reply(scope, request.id, 'worker', 42), code('EXPIRED'));
  assert.equal(store.get(scope, request.id)?.status, 'expired');
  assert.equal(store.get(scope, request.id)?.closedAt, new Date(1100).toISOString());
  assert.throws(() => store.assign(scope, request.id, 'different'), code('ALREADY_ASSIGNED'));
  const cancelled = store.create(scope, input());
  store.assign(scope, cancelled.id, 'worker');
  assert.equal(store.cancel(scope, cancelled.id).status, 'cancelled');
  assert.equal(store.cancel(scope, cancelled.id).status, 'cancelled');
  assert.throws(() => store.reply(scope, cancelled.id, 'worker', 42), code('REQUEST_CLOSED'));
  const failed = store.create(scope, input());
  assert.equal(store.fail(scope, failed.id, 'network unavailable').status, 'failed');
  assert.equal(store.fail(scope, failed.id).error, 'network unavailable');
  const unknown = store.create(scope, input());
  store.assign(scope, unknown.id, 'worker');
  assert.equal(store.dispatchUnknown(scope, unknown.id).status, 'dispatch-unknown');
  assert.equal((await store.wait(scope, unknown.id, { waitMs: 30_000 })).status, 'dispatch-unknown');
  assert.equal(store.listPending(scope).length, 1);
  assert.equal(store.reply(scope, unknown.id, 'worker', 42).status, 'answered');
  const expires = store.create(scope, input());
  store.dispatchUnknown(scope, expires.id);
  now += 1000;
  assert.equal(store.get(scope, expires.id)?.status, 'expired');
  assert.equal(store.listPending(scope).length, 0);
  store.close();
});

test('bounded wait polls durable state, supports abort and closes promptly', async () => {
  const store = new RequestStore(':memory:');
  const request = store.create(scope, input());
  store.assign(scope, request.id, 'worker');
  const waiting = store.wait(scope, request.id, { waitMs: 1000 });
  store.reply(scope, request.id, 'worker', 42);
  assert.equal((await waiting).status, 'answered');
  const pending = store.create(scope, input());
  assert.equal((await store.wait(scope, pending.id, { waitMs: 1 })).status, 'pending');
  await assert.rejects(store.wait(scope, pending.id, { waitMs: 30_001 }), code('INVALID_INPUT'));
  await assert.rejects(store.wait(otherOwner, pending.id, { waitMs: 0 }), code('NOT_FOUND'));
  const abort = new AbortController();
  const cancelled = store.wait(scope, pending.id, { waitMs: 30_000 }, abort.signal);
  abort.abort();
  await assert.rejects(cancelled, code('CANCELLED'));
  assert.equal(store.get(scope, pending.id)?.status, 'pending');
  const closed = store.wait(scope, pending.id, { waitMs: 30_000 });
  store.close();
  await assert.rejects(closed, code('DISPOSED'));
  store.close();
  assert.throws(() => store.get(scope, pending.id), code('DISPOSED'));
});

test('active bounds refuse overflow, terminal-only retention pruning leaves live rows alone', () => {
  let now = 0;
  const store = new RequestStore(':memory:', { clock: () => now, maxPendingPerProgram: 1, maxPending: 2, maxRequests: 3 });
  const first = store.create(scope, input());
  assert.throws(() => store.create(scope, input()), code('BACKPRESSURE'));
  store.dispatchUnknown(scope, first.id);
  assert.throws(() => store.create(scope, input()), code('BACKPRESSURE'));
  const second = store.create(otherOwner, input());
  assert.throws(() => store.create(otherProgram, input()), code('BACKPRESSURE'));
  store.cancel(scope, first.id);
  const third = store.create(scope, input());
  assert.equal(store.get(otherOwner, second.id)?.status, 'pending');
  store.cancel(scope, third.id);
  const fourth = store.create(scope, input());
  assert.equal(store.get(scope, first.id), null);
  assert.equal(store.get(otherOwner, second.id)?.status, 'pending');
  assert.equal(store.get(scope, fourth.id)?.status, 'pending');
  now = 1000;
  const fifth = store.create(scope, input());
  assert.equal(store.get(scope, fourth.id)?.status, 'expired');
  assert.equal(store.listPending().length, 1);
  assert.equal(store.get(scope, fifth.id)?.status, 'pending');
  store.close();
  const full = new RequestStore(':memory:', { maxRequests: 1 });
  const active = full.create(scope, input());
  assert.throws(() => full.create(otherOwner, input()), code('BACKPRESSURE'));
  assert.equal(full.get(scope, active.id)?.status, 'pending');
  full.close();
});

test('lower limits do not let duplicate keys consume active capacity or resurrect expired work', () => {
  let now = 0;
  const store = new RequestStore(':memory:', { clock: () => now, maxPendingPerProgram: 1, maxPending: 1 });
  const request = store.create(scope, { ...input(), requestId: 'stable' });
  assert.equal(store.create(scope, { ...input(), requestId: 'stable' }).id, request.id);
  now = 1000;
  assert.equal(store.create(scope, { ...input(), requestId: 'stable' }).status, 'expired');
  assert.equal(store.getByKey(scope, 'stable')?.id, request.id);
  assert.notEqual(store.create(scope, input()).id, request.id);
  store.close();
  assert.throws(() => new RequestStore(':memory:', { maxRequests: 10_001 }), code('INVALID_CONFIG'));
  assert.throws(() => new RequestStore(':memory:', { maxPendingPerProgram: 129 }), code('INVALID_CONFIG'));
  assert.throws(() => new RequestStore(':memory:', { maxPending: 1025 }), code('INVALID_CONFIG'));
});

test('payload framing depth is checked before persistence and reply acceptance', () => {
  const nested = (depth: number): JsonValue => {
    let value: JsonValue = 'leaf';
    for (let index = 0; index < depth; index++) value = { child: value };
    return value;
  };
  const store = new RequestStore(':memory:');
  // All three would pass the standalone shared JSON depth limit of 32.
  assertJson(nested(32));
  for (const depth of [29, 32]) {
    assert.throws(() => store.create(scope, { target: 'worker', body: nested(depth), responseSchema: true }), code('LIMIT'));
    assert.throws(() => store.create(scope, { target: nested(depth), body: null, responseSchema: true }), code('LIMIT'));
  }
  const request = store.create(scope, { target: 'worker', body: nested(REQUEST_LIMITS.payloadDepth), responseSchema: true });
  store.assign(scope, request.id, 'worker');
  for (const depth of [29, 32]) {
    assert.throws(() => store.reply(scope, request.id, 'worker', nested(depth)), code('INVALID_RESPONSE'));
    assert.equal(store.get(scope, request.id)?.status, 'pending');
  }
  store.reply(scope, request.id, 'worker', nested(REQUEST_LIMITS.payloadDepth));
  const recovered = store.get(scope, request.id)!;
  assertJson({ ok: true, result: { requestId: request.id, status: recovered.status, response: recovered.response! } });
  // Four nested wrappers remain representable, not only the current bridge two.
  assertJson({ one: { two: { three: { four: recovered.response! } } } });
  store.close();
});

test('payload node budget reserves room for response metadata and transport envelope', () => {
  const store = new RequestStore(':memory:');
  const request = store.create(scope, { target: 'worker', body: null, responseSchema: true });
  store.assign(scope, request.id, 'worker');
  assert.throws(() => store.reply(scope, request.id, 'worker', Array(9999).fill(0)), code('INVALID_RESPONSE'));
  assert.equal(store.get(scope, request.id)?.status, 'pending');
  store.reply(scope, request.id, 'worker', Array(REQUEST_LIMITS.payloadNodes - 1).fill(0));
  assertJson({ ok: true, result: { requestId: request.id, response: store.get(scope, request.id)!.response! } });
  store.close();
});

test('input/answer bounds and default schema keep individual bridge values representable', () => {
  const store = new RequestStore(':memory:');
  const request = store.create(scope, { target: 'worker', body: 'x'.repeat(REQUEST_LIMITS.bodyBytes - 2) });
  assert.deepEqual(request.responseSchema, { type: 'string' });
  store.assign(scope, request.id, 'worker');
  assert.throws(() => store.reply(scope, request.id, 'worker', 42), code('INVALID_RESPONSE'));
  assert.throws(() => store.reply(scope, request.id, 'worker', 'x'.repeat(REQUEST_LIMITS.bodyBytes)), code('INVALID_RESPONSE'));
  assert.equal(store.get(scope, request.id)?.status, 'pending');
  store.reply(scope, request.id, 'worker', 'x'.repeat(REQUEST_LIMITS.bodyBytes - 2));
  assert.throws(() => store.create(scope, { target: 'worker', body: 'x'.repeat(REQUEST_LIMITS.bodyBytes) }), code('LIMIT'));
  assert.throws(() => store.create(scope, { target: 'worker', body: 'x'.repeat(REQUEST_LIMITS.bodyBytes - 2), responseSchema: { type: 'string', description: 'x'.repeat(12 * 1024) } }), code('LIMIT'));
  assert.throws(() => store.create(scope, { target: 'worker', body: null, timeoutMs: REQUEST_LIMITS.maxTimeoutMs + 1 }), code('INVALID_INPUT'));
  assert.throws(() => store.create(scope, { target: 'worker', body: null, timeoutMs: 0 }), code('INVALID_INPUT'));
  assert.throws(() => store.create(scope, { target: 'worker', body: null, requestId: 'x'.repeat(257) }), code('INVALID_INPUT'));
  assert.throws(() => store.create(scope, { target: 'worker', body: null, responseSchema: { type: 'made-up' } }), code('INVALID_SCHEMA'));
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  assert.throws(() => store.create(scope, { target: 'worker', body: null, responseSchema: cycle as never }), code('INVALID_SCHEMA'));
  assert.equal(REQUEST_LIMITS.maxRequests, 10_000);
  assert.equal(REQUEST_LIMITS.maxPendingPerProgram, 128);
  assert.equal(REQUEST_LIMITS.maxPending, 1024);
  store.close();
});
