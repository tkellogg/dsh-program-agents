import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { SendQueue } from '../src/runtime/protocol.js';
import { CapabilityRegistry, ProgramError, ProgramSupervisor, RUNTIME_LIMITS, type ProgramSnapshot } from '../src/runtime/index.js';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const terminal = new Set(['failed', 'stopped', 'completed']);
async function until<T>(read: () => T, accept: (value: T) => boolean, timeout = 6000): Promise<T> {
  const deadline = Date.now() + timeout;
  let value: T;
  do {
    value = read();
    if (accept(value)) return value;
    await delay(10);
  } while (Date.now() < deadline);
  assert.fail(`Timed out; last value: ${JSON.stringify(value)}`);
}
const finished = (supervisor: ProgramSupervisor, id: string) => until(() => supervisor.get(id), (run) => terminal.has(run.state));
const hasCode = (code: string) => (error: unknown) => error instanceof ProgramError && error.code === code;

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}

test('real child: hello, inbox, status, parent identity, snapshots, completion and resource expiry', async (t) => {
  const notifications: Array<{ owner: string; message: unknown; generation: number }> = [];
  const events: ProgramSnapshot[] = [];
  const supervisor = new ProgramSupervisor({ programs: { app: { entry: fixture('interactive.mjs') } }, onParentMessage: async (owner, message, run) => { notifications.push({ owner, message, generation: run.generation }); }, onEvent: (event) => events.push(event.run), stopTimeoutMs: 100 });
  t.after(() => supervisor.dispose());
  const run = await supervisor.start({ program: 'app', ownerId: 'owner-A', input: { hello: 'world' } });
  assert.equal(run.state, 'running');
  assert.equal(run.generation, 1);
  assert.ok(run.pid && alive(run.pid));
  await until(() => supervisor.get(run.id), (snapshot) => snapshot.resources.length === 1 && snapshot.state === 'blocked');
  await supervisor.send(run.id, 'owner-A', { op: 'echo', value: [1, 2] });
  await until(() => notifications.length, (count) => count === 1);
  assert.deepEqual(notifications[0], { owner: 'owner-A', message: { echo: [1, 2], generation: 1 }, generation: 1 });
  const mutable = supervisor.get(run.id);
  mutable.resources[0]!.url = 'https://attacker.invalid/';
  mutable.logs.push({ sequence: 999, stream: 'system', text: 'not real' });
  assert.equal(supervisor.get(run.id).resources[0]!.url, 'http://127.0.0.1:43210/');
  assert.equal(supervisor.get(run.id).logs.length, 0);
  assert.equal(supervisor.list('owner-B').length, 0);
  assert.throws(() => supervisor.get(run.id, 'owner-B'), hasCode('NOT_FOUND'));
  await assert.rejects(supervisor.send(run.id, 'owner-B', 'x'), hasCode('NOT_FOUND'));
  await assert.rejects(supervisor.stop(run.id, 'owner-B'), hasCode('NOT_FOUND'));
  await assert.rejects(supervisor.restart(run.id, 'owner-B'), hasCode('NOT_FOUND'));
  await supervisor.send(run.id, 'owner-A', { op: 'complete' });
  const done = await finished(supervisor, run.id);
  assert.equal(done.state, 'completed');
  assert.deepEqual(done.result, { input: { hello: 'world' }, generation: 1 });
  assert.equal(done.resources[0]!.available, false);
  assert.ok(done.endedAt);
  assert.equal(alive(run.pid!), false);
  assert.ok(done.messages.some((message) => message.direction === 'parent'));
  assert.ok(done.messages.some((message) => message.direction === 'program'));
  await until(() => events, (value) => value.some((event) => event.state === 'completed'));
});

test('allowlisted model/tool stubs receive captured identity and minimal environment', async (t) => {
  const registry = new CapabilityRegistry();
  const calls: string[] = [];
  registry.register({ name: 'models.call', description: 'Test model', handler: async (input, context) => { assert.equal(context.run.ownerId, 'parent'); assert.equal(context.signal.aborted, false); calls.push('model'); return { input, answer: 'stub answer' }; } });
  registry.register({ name: 'tools.call', description: 'Test tools', inputSchema: { type: 'object' }, handler: async (input) => { calls.push('tool'); return input; } });
  registry.register({ name: 'private.call', description: 'Not visible', handler: async () => { assert.fail('Forbidden capability executed'); } });
  process.env.RUNTIME_SECRET = 'parent-only-secret';
  const supervisor = new ProgramSupervisor({ programs: { app: { entry: fixture('capabilities.mjs'), allowedCapabilities: ['models.call', 'tools.call'], env: { EXPLICIT: 'configured' } } }, capabilities: registry, stopTimeoutMs: 100 });
  t.after(async () => { delete process.env.RUNTIME_SECRET; await supervisor.dispose(); });
  const run = await supervisor.start({ program: 'app', ownerId: 'parent', input: 'question' });
  const done = await finished(supervisor, run.id);
  assert.equal(done.state, 'completed', done.error);
  const result = done.result as Record<string, unknown>;
  assert.deepEqual(result.names, ['models.call', 'tools.call']);
  assert.deepEqual(result.result, { input: { prompt: 'question', secret: null }, answer: 'stub answer' });
  assert.equal(result.denied, 'FORBIDDEN');
  assert.deepEqual(calls, ['model', 'tool']);
});

test('URL schemes are validated without fetching, HTTP(S) only and terminal resources disabled', async (t) => {
  const supervisor = new ProgramSupervisor({ programs: { app: { entry: fixture('urls.mjs') } }, stopTimeoutMs: 100 });
  t.after(() => supervisor.dispose());
  const run = await supervisor.start({ program: 'app', ownerId: 'owner' });
  const done = await finished(supervisor, run.id);
  assert.equal(done.state, 'completed', done.error);
  assert.deepEqual(done.result, { rejected: Array(6).fill('INVALID_URL') });
  assert.deepEqual(done.resources.map((resource) => [resource.id, resource.available]), [['secure', false], ['local', false]]);
});

test('hard-blocked event loop is forcibly killed and restart fences the previous process group', async (t) => {
  const supervisor = new ProgramSupervisor({ programs: { app: { entry: fixture('blocked.mjs') } }, stopTimeoutMs: 80 });
  t.after(() => supervisor.dispose());
  const first = await supervisor.start({ program: 'app', ownerId: 'owner' });
  await until(() => supervisor.get(first.id).status, (status) => status === 'event loop blocked');
  const started = Date.now();
  const restart = supervisor.restart(first.id, 'owner');
  await assert.rejects(supervisor.restart(first.id, 'owner'), hasCode('BUSY'));
  const second = await restart;
  assert.ok(Date.now() - started >= 60, 'Must wait for forced exit before restart');
  assert.equal(second.id, first.id);
  assert.equal(second.generation, 2);
  assert.notEqual(second.pid, first.pid);
  assert.equal(alive(first.pid!), false);
  assert.equal(alive(second.pid!), true);
  const stopped = await supervisor.stop(second.id, 'owner');
  assert.equal(stopped.state, 'stopped');
  assert.equal(alive(second.pid!), false);
});

test('owner revocation fences a restart waiting for the old generation to exit', async (t) => {
  const supervisor = new ProgramSupervisor({ programs: { app: { entry: fixture('blocked.mjs') } }, stopTimeoutMs: 80 });
  t.after(() => supervisor.dispose());
  const first = await supervisor.start({ program: 'app', ownerId: 'owner' });
  await until(() => supervisor.get(first.id).status, (status) => status === 'event loop blocked');
  const restart = supervisor.restart(first.id, 'owner');
  const rejection = assert.rejects(restart, hasCode('OWNER_REVOKED'));
  await supervisor.revokeOwner('owner');
  await rejection;
  assert.equal(supervisor.get(first.id).generation, 1);
  assert.equal(supervisor.get(first.id).state, 'stopped');
  assert.equal(alive(first.pid!), false);
  await assert.rejects(supervisor.start({ program: 'app', ownerId: 'owner' }), hasCode('OWNER_REVOKED'));
  await assert.rejects(supervisor.restart(first.id, 'owner'), hasCode('OWNER_REVOKED'));
});

test('stdout and stderr flood is drained, bounded and observer updates coalesced', async (t) => {
  let updates = 0;
  const supervisor = new ProgramSupervisor({ programs: { app: { entry: fixture('flood.mjs') } }, onEvent: () => { updates++; }, stopTimeoutMs: 100 });
  t.after(() => supervisor.dispose());
  const run = await supervisor.start({ program: 'app', ownerId: 'owner' });
  await until(() => supervisor.get(run.id), (snapshot) => snapshot.status === 'flood finished' && snapshot.logs.length > 0);
  await delay(250);
  const snapshot = supervisor.get(run.id);
  assert.ok(snapshot.logs.length <= RUNTIME_LIMITS.logs);
  assert.ok(snapshot.logs.reduce((sum, log) => sum + Buffer.byteLength(log.text), 0) <= RUNTIME_LIMITS.logBytes);
  assert.ok(snapshot.logs.every((log) => Buffer.byteLength(log.text) <= RUNTIME_LIMITS.logEntryBytes + 3));
  assert.ok(updates < 40, `Expected coalesced changes, got ${updates}`);
  assert.ok(snapshot.logs.at(-1)!.sequence > snapshot.logs.length, 'Older output must have been evicted');
  await supervisor.send(run.id, 'owner', 'complete');
  assert.equal((await finished(supervisor, run.id)).state, 'completed');
});

test('cancellation revokes asynchronous host calls and suppresses late replies/messages', async (t) => {
  const registry = new CapabilityRegistry();
  let resolve!: (value: null) => void;
  let signal: AbortSignal | undefined;
  let notifications = 0;
  registry.register({ name: 'slow.call', description: 'Slow', handler: async (_input, context) => { signal = context.signal; return new Promise((yes) => { resolve = yes; }); } });
  const supervisor = new ProgramSupervisor({ programs: { app: { entry: fixture('cancel.mjs'), allowedCapabilities: ['slow.call'] } }, capabilities: registry, onParentMessage: async () => { notifications++; }, stopTimeoutMs: 80 });
  t.after(() => supervisor.dispose());
  const run = await supervisor.start({ program: 'app', ownerId: 'owner' });
  await until(() => signal, (value) => value !== undefined);
  await supervisor.stop(run.id, 'owner');
  assert.equal(signal!.aborted, true);
  resolve(null);
  await delay(50);
  assert.equal(notifications, 0);
  assert.equal(supervisor.get(run.id).state, 'stopped');
});

test('stale generations have no authority and child-selected parent identity is ignored', async (t) => {
  const notifications: Array<{ owner: string; body: unknown }> = [];
  const supervisor = new ProgramSupervisor({ programs: { app: { entry: fixture('raw-ipc.mjs') } }, onParentMessage: async (owner, body) => { notifications.push({ owner, body }); }, stopTimeoutMs: 80 });
  t.after(() => supervisor.dispose());
  const stale = await supervisor.start({ program: 'app', ownerId: 'real-owner', input: 'stale' });
  await until(() => supervisor.get(stale.id).status, (status) => status === 'stale frames ignored');
  assert.equal(notifications.length, 0);
  assert.equal(supervisor.get(stale.id).state, 'blocked');
  const identity = await supervisor.start({ program: 'app', ownerId: 'real-owner', input: 'parent-identity' });
  await until(() => notifications.length, (count) => count === 1);
  assert.deepEqual(notifications[0], { owner: 'real-owner', body: 'message' });
  await supervisor.stop(identity.id, 'real-owner');
});

for (const mode of ['invalid', 'oversized', 'duplicate']) {
  test(`invalid IPC fails closed: ${mode}`, async (t) => {
    let effects = 0;
    const registry = new CapabilityRegistry();
    registry.register({ name: 'effect.call', description: 'Count once', handler: async () => { effects++; return null; } });
    const supervisor = new ProgramSupervisor({ programs: { app: { entry: fixture('raw-ipc.mjs'), allowedCapabilities: ['effect.call'] } }, capabilities: registry, stopTimeoutMs: 80 });
    t.after(() => supervisor.dispose());
    const run = await supervisor.start({ program: 'app', ownerId: 'owner', input: mode });
    const done = await finished(supervisor, run.id);
    assert.equal(done.state, 'failed');
    assert.match(done.error!, /Invalid IPC/);
    assert.equal(effects, mode === 'duplicate' ? 1 : 0);
    await delay(30);
    assert.equal(supervisor.get(run.id).generation, 1, 'No automatic restart');
  });
}

test('inbox, input, process concurrency and retained history are bounded', async (t) => {
  const supervisor = new ProgramSupervisor({ programs: { app: { entry: fixture('no-inbox.mjs') } }, maxRuns: 1, maxHistory: 1, stopTimeoutMs: 80 });
  t.after(() => supervisor.dispose());
  await assert.rejects(supervisor.start({ program: 'app', ownerId: 'owner', input: 'x'.repeat(70000) }), hasCode('LIMIT'));
  const run = await supervisor.start({ program: 'app', ownerId: 'owner' });
  await until(() => supervisor.get(run.id).status, (status) => status === 'not reading inbox');
  await assert.rejects(supervisor.start({ program: 'app', ownerId: 'owner' }), hasCode('LIMIT'));
  for (let i = 0; i < RUNTIME_LIMITS.inbox; i++) await supervisor.send(run.id, 'owner', i);
  await assert.rejects(supervisor.send(run.id, 'owner', 'overflow'), hasCode('BACKPRESSURE'));
  assert.ok(supervisor.get(run.id).messages.length <= RUNTIME_LIMITS.messages);
  await supervisor.stop(run.id, 'owner');
  const next = await supervisor.start({ program: 'app', ownerId: 'owner' });
  await supervisor.stop(next.id, 'owner');
  assert.equal(supervisor.list().length, 1);
  assert.throws(() => supervisor.get(run.id), hasCode('NOT_FOUND'));
});

test('frame overhead limits reject locally without leaking a child, call slot or inbox sequence', async (t) => {
  const notices: unknown[] = [];
  const supervisor = new ProgramSupervisor({ programs: { inbox: { entry: fixture('interactive.mjs') }, calls: { entry: fixture('frame-limit.mjs') } }, onParentMessage: async (_owner, body) => { notices.push(body); }, stopTimeoutMs: 80 });
  t.after(() => supervisor.dispose());
  await assert.rejects(supervisor.start({ program: 'inbox', ownerId: 'owner', input: 'x'.repeat(65450) }), /byte limit/);
  const failed = supervisor.list()[0]!;
  assert.equal(failed.state, 'failed');
  assert.equal(failed.pid, undefined, 'Frame must be validated before spawning');
  const run = await supervisor.start({ program: 'inbox', ownerId: 'owner' });
  await assert.rejects(supervisor.send(run.id, 'owner', 'x'.repeat(65450)), hasCode('LIMIT'));
  await supervisor.send(run.id, 'owner', { op: 'echo', value: 'valid after rejection' });
  await until(() => notices.length, (count) => count === 1);
  assert.deepEqual(notices[0], { echo: 'valid after rejection', generation: 1 });
  const calls = await supervisor.start({ program: 'calls', ownerId: 'owner' });
  const done = await finished(supervisor, calls.id);
  assert.equal(done.state, 'completed', done.error);
  assert.equal(done.result, 'LIMIT');
  assert.deepEqual(notices[1], { result: 'LIMIT' });
});

test('startup hello deadline and aborted startup kill import-blocked processes', async (t) => {
  const supervisor = new ProgramSupervisor({ programs: { app: { entry: fixture('import-blocked.mjs') } }, startupTimeoutMs: 150, stopTimeoutMs: 80 });
  t.after(() => supervisor.dispose());
  await assert.rejects(supervisor.start({ program: 'app', ownerId: 'owner' }), /startup hello timed out/);
  await until(() => supervisor.list(), (runs) => runs.length === 1 && runs[0]!.state === 'failed');
  assert.equal(alive(supervisor.list()[0]!.pid!), false);
  const controller = new AbortController();
  const start = supervisor.start({ program: 'app', ownerId: 'owner' }, controller.signal);
  controller.abort();
  await assert.rejects(start, hasCode('ABORTED'));
  await until(() => supervisor.list(), (runs) => runs.every((run) => terminal.has(run.state)));
  assert.ok(supervisor.list().every((run) => !alive(run.pid!)));
});

test('deadlines cancel handlers and noncooperative host work retains bounded slots across restarts', async (t) => {
  let effects = 0;
  const signals: AbortSignal[] = [];
  const registry = new CapabilityRegistry();
  registry.register({ name: 'never.call', description: 'Never settles', handler: async (_input, context) => { effects++; signals.push(context.signal); return new Promise(() => {}); } });
  const supervisor = new ProgramSupervisor({ programs: { sequential: { entry: fixture('deadlines.mjs'), allowedCapabilities: ['never.call'] }, parallel: { entry: fixture('pending-many.mjs'), allowedCapabilities: ['never.call'] } }, capabilities: registry, callTimeoutMs: 15, stopTimeoutMs: 60 });
  t.after(() => supervisor.dispose());
  const run = await supervisor.start({ program: 'sequential', ownerId: 'owner' });
  const done = await finished(supervisor, run.id);
  assert.equal(done.state, 'completed', done.error);
  assert.deepEqual(done.result, [...Array(32).fill('TIMEOUT'), ...Array(4).fill('LIMIT')]);
  assert.equal(effects, RUNTIME_LIMITS.pendingCalls);
  assert.ok(signals.every((signal) => signal.aborted));
  const next = await supervisor.restart(run.id, 'owner');
  const nextDone = await finished(supervisor, next.id);
  assert.deepEqual(nextDone.result, Array(36).fill('LIMIT'));
  assert.equal(effects, RUNTIME_LIMITS.pendingCalls, 'Cancelled old-generation handlers continue occupying global slots');
});

test('stop and normal completion terminate descendants in the same process group', { skip: process.platform === 'win32' }, async (t) => {
  const descendants: number[] = [];
  const supervisor = new ProgramSupervisor({ programs: { app: { entry: fixture('process-group.mjs') } }, onParentMessage: async (_owner, body) => { descendants.push((body as { descendantPid: number }).descendantPid); }, stopTimeoutMs: 80 });
  t.after(() => supervisor.dispose());
  const first = await supervisor.start({ program: 'app', ownerId: 'owner' });
  await until(() => descendants.length, (count) => count === 1);
  await supervisor.stop(first.id, 'owner');
  assert.equal(alive(descendants[0]!), false);
  const second = await supervisor.restart(first.id, 'owner');
  await until(() => descendants.length, (count) => count === 2);
  await supervisor.send(second.id, 'owner', 'complete');
  assert.equal((await finished(supervisor, second.id)).state, 'completed');
  assert.equal(alive(descendants[1]!), false);
});

test('entry import errors are reported and no process is automatically restarted', async (t) => {
  const supervisor = new ProgramSupervisor({ programs: { missing: { entry: fixture('missing-default.mjs') }, nonexistent: { entry: fixture('does-not-exist.mjs') } }, stopTimeoutMs: 80 });
  t.after(() => supervisor.dispose());
  await assert.rejects(supervisor.start({ program: 'missing', ownerId: 'owner' }), /default main/);
  await assert.rejects(supervisor.start({ program: 'nonexistent', ownerId: 'owner' }), /Cannot find/);
  await until(() => supervisor.list(), (runs) => runs.length === 2 && runs.every((run) => run.state === 'failed'));
  assert.ok(supervisor.list().every((run) => run.generation === 1 && !alive(run.pid!)));
});

test('SDK rejects use without actual IPC; JSON and send queue limits fail safely', async () => {
  const sdk = await import('../src/sdk/index.js');
  assert.throws(() => sdk.runProgram(async () => null), hasCode('NO_IPC'));
  const callbacks: Array<(error: Error | null) => void> = [];
  const queue = new SendQueue({ connected: true, send: (_message, callback) => { callbacks.push(callback); return false; } });
  const pending = Array.from({ length: RUNTIME_LIMITS.queuedSends }, () => queue.send({ message: 'hello' }));
  await assert.rejects(queue.send({ message: 'overflow' }), hasCode('BACKPRESSURE'));
  for (const callback of callbacks) callback(null);
  await Promise.all(pending);
  const cancelled = queue.send({ message: 'cancelled' });
  queue.close();
  await assert.rejects(cancelled, hasCode('DISCONNECTED'));
  await assert.rejects(queue.send({ message: 'closed' }), hasCode('DISCONNECTED'));
});

test('compiled runtime launches its built bootstrap with no tsx loader dependency', { skip: !existsSync(fileURLToPath(new URL('../dist/runtime/index.js', import.meta.url))) }, async () => {
  const code = `
    import { ProgramSupervisor } from './dist/runtime/index.js';
    const supervisor = new ProgramSupervisor({ programs: { app: { entry: ${JSON.stringify(fixture('native-types.ts'))} } }, stopTimeoutMs: 100 });
    try {
      const run = await supervisor.start({ program: 'app', ownerId: 'owner', input: 'native' });
      while (!['completed','failed'].includes(supervisor.get(run.id).state)) await new Promise(r => setTimeout(r, 10));
      const done = supervisor.get(run.id);
      if (done.state !== 'completed' || done.result.input !== 'native') throw new Error(JSON.stringify(done));
      console.log('built bootstrap works');
    } finally { await supervisor.dispose(); }
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /built bootstrap works/);
});

test('native TypeScript default entry and registry exports work', async (t) => {
  const registry = new CapabilityRegistry();
  const remove = registry.register({ name: 'example.call', description: 'Example', inputSchema: { type: 'string' }, handler: async (input) => input });
  assert.deepEqual(registry.list(), [{ name: 'example.call', description: 'Example', inputSchema: { type: 'string' } }]);
  assert.throws(() => registry.register({ name: 'example.call', description: '', handler: async () => null }), hasCode('DUPLICATE_CAPABILITY'));
  remove(); remove();
  assert.deepEqual(registry.list(), []);
  assert.throws(() => registry.register({ name: 'parent.send', description: '', handler: async () => null }), hasCode('INVALID_CAPABILITY'));
  const supervisor = new ProgramSupervisor({ programs: { app: { entry: fixture('native-types.ts') } }, stopTimeoutMs: 80 });
  t.after(() => supervisor.dispose());
  const run = await supervisor.start({ program: 'app', ownerId: 'owner', input: [1, 2] });
  const done = await finished(supervisor, run.id);
  assert.equal(done.state, 'completed', done.error);
  assert.deepEqual(done.result, { input: [1, 2], generation: 1 });
});
