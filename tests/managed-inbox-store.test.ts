import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MessageStore } from '../src/app/mailbox.js';
import { ProgramError } from '../src/runtime/protocol.js';

const scope = { ownerId: 'owner', program: 'managed', claimant: 'run:1' };
const hasCode = (code: string) => (error: unknown) => error instanceof ProgramError && error.code === code;

test('durable renew is fenced by owner/program/run/token and cannot resurrect an expired lease', async (t) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'managed-inbox-store-')));
  t.after(() => {
    assert.equal(realpathSync(directory), directory);
    assert.ok(directory.startsWith(`${realpathSync(tmpdir())}/managed-inbox-store-`));
    rmSync(directory, { recursive: true, force: true });
  });
  const file = join(directory, 'messages.sqlite');
  let now = 1_000;
  const first = new MessageStore(file, { clock: () => now });
  const accepted = first.send(scope, { from: 'parent', body: { durable: true } });
  const claimed = await first.receive(scope, { leaseMs: 500 });
  assert.ok(claimed);
  now = 1_400;
  const renewed = first.renew(scope, claimed.id, claimed.leaseToken, 500);
  assert.equal(renewed.leaseUntil, new Date(1_900).toISOString());
  assert.equal(renewed.attempts, 1);
  first.close();

  const second = new MessageStore(file, { clock: () => now });
  t.after(() => second.close());
  assert.deepEqual(second.receipt(scope, accepted.id), renewed);
  assert.equal(await second.receive(scope), null);
  assert.throws(() => second.renew({ ...scope, ownerId: 'other' }, claimed.id, claimed.leaseToken, 500), hasCode('NOT_FOUND'));
  assert.throws(() => second.renew({ ...scope, program: 'other' }, claimed.id, claimed.leaseToken, 500), hasCode('NOT_FOUND'));
  assert.throws(() => second.renew({ ...scope, claimant: 'run:2' }, claimed.id, claimed.leaseToken, 500), hasCode('LEASE_LOST'));
  assert.throws(() => second.renew(scope, claimed.id, 'bad-token', 500), hasCode('LEASE_LOST'));
  now = 1_899;
  assert.equal(second.renew(scope, claimed.id, claimed.leaseToken, 1).leaseUntil, new Date(1_900).toISOString());
  now = 1_900;
  for (const settle of [() => second.renew(scope, claimed.id, claimed.leaseToken, 500), () => second.ack(scope, claimed.id, claimed.leaseToken), () => second.nack(scope, claimed.id, claimed.leaseToken)]) assert.throws(settle, hasCode('LEASE_LOST'));
  const replacementScope = { ...scope, claimant: 'run:2' };
  const replacement = await second.receive(replacementScope, { leaseMs: 500 });
  assert.ok(replacement);
  assert.notEqual(replacement.leaseToken, claimed.leaseToken);
  assert.equal(replacement.receipt.attempts, 2);
  assert.throws(() => second.renew(scope, claimed.id, claimed.leaseToken, 500), hasCode('LEASE_LOST'));
  assert.equal(second.ack(replacementScope, replacement.id, replacement.leaseToken).status, 'acked');
  for (const settle of [() => second.renew(replacementScope, replacement.id, replacement.leaseToken, 500), () => second.ack(replacementScope, replacement.id, replacement.leaseToken), () => second.nack(replacementScope, replacement.id, replacement.leaseToken)]) assert.throws(settle, hasCode('LEASE_LOST'));
});

test('MessageStore validates runtime bounds and uses the 60 second default lease', async (t) => {
  const store = new MessageStore(':memory:', { clock: () => 10_000 });
  t.after(() => store.close());
  store.send(scope, { from: 'parent', body: 'work' });
  const message = await store.receive(scope);
  assert.ok(message);
  assert.equal(message.receipt.leaseUntil, new Date(70_000).toISOString());
  for (const value of [null, '500', -1, 0, 0.5, NaN, Infinity, 300_001, Number.MAX_SAFE_INTEGER]) assert.throws(() => store.renew(scope, message.id, message.leaseToken, value as number), hasCode('INVALID_INPUT'));
  for (const value of [null, '1', -1, 0.5, NaN, Infinity, 30_001]) await assert.rejects(store.receive(scope, { waitMs: value as number }), hasCode('INVALID_INPUT'));
  for (const value of [null, '1', -1, 0, 0.5, NaN, Infinity, 300_001]) await assert.rejects(store.receive(scope, { leaseMs: value as number }), hasCode('INVALID_INPUT'));
  await assert.rejects(store.receive(scope, null as never), hasCode('INVALID_INPUT'));
  assert.throws(() => new MessageStore(':memory:', { maxMessages: null as never }), hasCode('INVALID_CONFIG'));
  assert.throws(() => new MessageStore(':memory:', { clock: 1 as never }), hasCode('INVALID_CONFIG'));
  store.nack(scope, message.id, message.leaseToken);
  assert.throws(() => store.renew(scope, message.id, message.leaseToken, 500), hasCode('LEASE_LOST'));
});
