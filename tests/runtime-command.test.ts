import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { ProgramError, ProgramSupervisor, RUNTIME_LIMITS, type ProgramDefinition } from '../src/runtime/index.js';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const hasCode = (code: string) => (error: unknown) => error instanceof ProgramError && error.code === code;
async function until<T>(read: () => T, accept: (value: T) => boolean, timeout = 8000): Promise<T> {
  const deadline = Date.now() + timeout;
  let value: T;
  do { value = read(); if (accept(value)) return value; await delay(10); } while (Date.now() < deadline);
  assert.fail(`Timed out; last value: ${JSON.stringify(value)}`);
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}
function temporary(t: { after(fn: () => void): void }): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-runtime-command-test-')));
  t.after(() => {
    // Verify the exact resolved disposable directory before recursive cleanup.
    assert.equal(realpathSync(path), path);
    assert.ok(path.startsWith(`${realpathSync(tmpdir())}/dsh-runtime-command-test-`));
    rmSync(path, { recursive: true, force: true });
  });
  return path;
}

test('ordinary node --watch starts without SDK/IPC, exposes metadata/logs, and fences restart/stop groups', async (t) => {
  const logDirectory = temporary(t);
  process.env.RUNTIME_COMMAND_SECRET = 'must-not-inherit';
  const command = [process.execPath, '--watch', fixture('command-watch.mjs'), 'literal ; $(echo injected)'];
  const supervisor = new ProgramSupervisor({ programs: { watch: { command, name: 'Watched app', description: 'Ordinary watch process', env: { EXPLICIT: 'configured' }, urls: [
    { id: 'ui', title: 'UI', type: 'ui', url: 'http://127.0.0.1:9876' },
    { id: 'api', title: 'API', type: 'api', url: 'https://example.com/api', docs: '/tmp/openapi.json' },
    { id: 'docs', title: 'Docs', type: 'docs', url: '/tmp/docs folder/README.md' },
  ] } }, logDirectory, stopTimeoutMs: 100 });
  t.after(async () => { delete process.env.RUNTIME_COMMAND_SECRET; await supervisor.dispose(); });
  const definition = supervisor.definitionsList()[0]!;
  assert.deepEqual(definition.command, command);
  assert.equal(definition.name, 'Watched app');
  assert.ok(definition.urls.every((resource) => resource.available === false));
  definition.command[0] = 'mutated';
  definition.urls[0]!.url = 'https://invalid.example/';
  const first = await supervisor.start({ program: 'watch', ownerId: 'owner', input: { ignored: 'no IPC input' } });
  assert.equal(first.state, 'running');
  assert.equal(first.name, 'Watched app');
  assert.equal(first.label, 'Watched app');
  assert.equal(first.description, 'Ordinary watch process');
  assert.deepEqual(first.command, command);
  assert.ok(first.resources.every((resource) => resource.available));
  assert.equal(first.resources[0]!.url, 'http://127.0.0.1:9876/');
  assert.ok(first.logsPath && isAbsolute(first.logsPath));
  assert.equal(statSync(first.logsPath).mode & 0o777, 0o600);
  const output = () => readFileSync(first.logsPath!, 'utf8');
  await until(output, (text) => text.includes('"ready":true') && text.includes('stderr ready'));
  const info = JSON.parse(output().split('\n').find((line) => line.startsWith('{"ready"'))!);
  // Node --watch has its own private worker IPC; the supervised watcher itself
  // has no SDK channel and needs neither an import nor a startup hello.
  assert.equal(typeof info.ipc, 'string');
  assert.equal(info.secret, null);
  assert.equal(info.nodeOptions, null);
  assert.equal(info.path, Boolean(process.env.PATH));
  assert.equal(info.home, process.env.HOME);
  assert.equal(info.explicit, 'configured');
  assert.deepEqual(info.argv, ['literal ; $(echo injected)']);
  assert.notEqual(info.workerPid, first.pid);
  await assert.rejects(supervisor.send(first.id, 'owner', 'message'), hasCode('UNSUPPORTED_OPERATION'));
  await assert.rejects(supervisor.stop(first.id, 'intruder'), hasCode('NOT_FOUND'));
  const second = await supervisor.restart(first.id, 'owner');
  assert.equal(second.id, first.id);
  assert.equal(second.generation, 2);
  assert.notEqual(second.pid, first.pid);
  assert.notEqual(second.logsPath, first.logsPath);
  assert.equal(alive(first.pid!), false);
  assert.equal(alive(info.workerPid), false);
  await until(() => readFileSync(second.logsPath!, 'utf8'), (text) => text.includes('"ready":true'));
  const secondInfo = JSON.parse(readFileSync(second.logsPath!, 'utf8').split('\n').find((line) => line.startsWith('{"ready"'))!);
  const stopped = await supervisor.stop(second.id, 'owner');
  assert.equal(stopped.state, 'stopped');
  assert.ok(stopped.resources.every((resource) => resource.available === false));
  assert.equal(alive(second.pid!), false);
  assert.equal(alive(secondInfo.workerPid), false);
  assert.ok(readFileSync(stopped.logsPath!, 'utf8').includes('stderr ready'));
});

test('node --watch reloads edited source without a new generation or parent notification', async (t) => {
  const directory = temporary(t);
  const source = join(directory, 'watched.mjs');
  const render = (version: number) => `console.log(JSON.stringify({version:${version},workerPid:process.pid}));setInterval(()=>{},1000);\n`;
  writeFileSync(source, render(1));
  let parentNotifications = 0;
  const supervisor = new ProgramSupervisor({
    programs: { app: { command: [process.execPath, '--watch', source], urls: [{ id: 'ui', title: 'Watched UI', type: 'ui', url: 'http://127.0.0.1:9876/' }] } },
    logDirectory: join(directory, 'logs'),
    onParentMessage: async () => { parentNotifications++; },
    stopTimeoutMs: 100,
  });
  t.after(() => supervisor.dispose());
  const run = await supervisor.start({ program: 'app', ownerId: 'owner' });
  const records = () => readFileSync(run.logsPath!, 'utf8').split('\n').filter((line) => line.startsWith('{"version":')).map((line) => JSON.parse(line) as { version: number; workerPid: number });
  const before = (await until(records, (items) => items.some((item) => item.version === 1))).find((item) => item.version === 1)!;
  writeFileSync(source, render(2));
  const after = (await until(records, (items) => items.some((item) => item.version === 2))).find((item) => item.version === 2)!;
  assert.notEqual(after.workerPid, before.workerPid);
  await until(() => alive(before.workerPid), (value) => value === false);
  const reloaded = supervisor.get(run.id);
  assert.equal(reloaded.id, run.id);
  assert.equal(reloaded.generation, 1);
  assert.equal(reloaded.pid, run.pid, 'Foreground watcher remains the supervised process');
  assert.equal(reloaded.state, 'running');
  assert.equal(reloaded.logsPath, run.logsPath);
  assert.ok(reloaded.resources.every((resource) => resource.available));
  assert.equal(parentNotifications, 0, 'Passive watcher output must not wake the parent');
  await supervisor.stop(run.id, 'owner');
  assert.equal(alive(after.workerPid), false);
  assert.equal(alive(run.pid!), false);
});

test('define validates bounded exact definitions, copies metadata, and restart uses the newest definition', async (t) => {
  const supervisor = new ProgramSupervisor({ programs: {}, stopTimeoutMs: 80 });
  t.after(() => supervisor.dispose());
  const invalid: unknown[] = [
    {}, { entry: 'app.mjs', command: ['node'] }, { command: [] }, { command: 'node app.mjs' }, { command: [''] }, { command: ['node', '\0'] }, { command: ['node'], args: ['x'] }, { command: ['node', , 'argument'] },
    { command: ['node'], urls: [{ id: 'ui', title: 'x', type: 'ui', url: 'javascript:alert(1)' }] },
    { command: ['node'], urls: [{ id: 'docs', title: 'x', type: 'docs', url: 'file:///tmp/docs' }] },
    { command: ['node'], urls: [{ id: 'api', title: 'x', type: 'api', url: 'https://example.com/', docs: 'some prose' }] },
    { command: ['node'], allowedCapabilities: 'all' },
  ];
  for (const definition of invalid) assert.throws(() => supervisor.define('app', definition as ProgramDefinition), hasCode('INVALID_CONFIG'));
  const firstCommand = [process.execPath, '-e', 'setInterval(()=>{},1000)'];
  supervisor.define('app', { command: firstCommand, name: 'Original' });
  firstCommand[0] = 'unconfigured-mutation';
  const first = await supervisor.start({ program: 'app', ownerId: 'owner' });
  supervisor.define('app', { command: [process.execPath, '-e', 'console.log("replacement");setInterval(()=>{},1000)'], name: 'Replacement', description: 'New metadata' });
  assert.equal(supervisor.get(first.id).name, 'Original');
  const second = await supervisor.restart(first.id, 'owner');
  assert.equal(second.name, 'Replacement');
  assert.equal(second.description, 'New metadata');
  assert.equal(alive(first.pid!), false);
  for (let index = 1; index < RUNTIME_LIMITS.definitions; index++) supervisor.define(`p${index}`, { command: ['node', '-v'] });
  assert.equal(supervisor.definitionsList().length, 256);
  assert.throws(() => supervisor.define('overflow', { command: ['node'] }), hasCode('LIMIT'));
  supervisor.define('app', { command: ['node', '-v'] });
  assert.throws(() => new ProgramSupervisor({ programs: Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`p${index}`, { command: ['node'] }])) }), hasCode('INVALID_CONFIG'));
});

test('command argv is literal and never implicit shell code; missing executable fails cleanly', async (t) => {
  const supervisor = new ProgramSupervisor({ programs: {
    literal: { command: [process.execPath, '-p', 'JSON.stringify(process.argv.slice(1))', '--', '$(touch /tmp/forbidden)', '; exit 91', '*', '"quoted"'] },
    shell: { command: ['printf should-not-run; exit 0'] },
  }, stopTimeoutMs: 80 });
  t.after(() => supervisor.dispose());
  const run = await supervisor.start({ program: 'literal', ownerId: 'owner' });
  const done = await until(() => supervisor.get(run.id), (snapshot) => snapshot.state === 'completed');
  assert.deepEqual(JSON.parse(readFileSync(done.logsPath!, 'utf8').trim()), ['$(touch /tmp/forbidden)', '; exit 91', '*', '"quoted"']);
  await assert.rejects(supervisor.start({ program: 'shell', ownerId: 'owner' }), hasCode('STARTUP_FAILED'));
  await until(() => supervisor.list().find((snapshot) => snapshot.program === 'shell')!, (snapshot) => snapshot.state === 'failed');
});

test('typed SDK resources retain optional metadata while legacy entries still work', async (t) => {
  const supervisor = new ProgramSupervisor({ programs: { sdk: { entry: fixture('typed-resources.mjs'), urls: [{ id: 'ui', title: 'Static', type: 'ui', url: 'https://example.com/' }] } }, stopTimeoutMs: 80 });
  t.after(() => supervisor.dispose());
  assert.deepEqual(supervisor.definitionsList()[0]!.command, [process.execPath, fixture('typed-resources.mjs')]);
  const run = await supervisor.start({ program: 'sdk', ownerId: 'owner' });
  const done = await until(() => supervisor.get(run.id), (snapshot) => snapshot.state === 'completed');
  assert.deepEqual(done.result, ['INVALID_URL', 'INVALID_URL', 'INVALID_URL', 'INVALID_URL', 'INVALID_INPUT']);
  assert.equal(done.resources.length, 3);
  assert.equal(done.resources.find((resource) => resource.id === 'api')!.docs, 'https://example.com/openapi.json');
  assert.equal(done.resources.find((resource) => resource.id === 'docs')!.url, '/tmp/program docs/README.md');
  assert.ok(done.resources.every((resource) => resource.available === false));
});

test('private disk capture stays bounded under flood and supplied logsPath remains descriptor-only', async (t) => {
  const logDirectory = temporary(t);
  const ownedPath = join(logDirectory, 'program-owned-directory');
  const supervisor = new ProgramSupervisor({ programs: { flood: { command: [process.execPath, '-e', `const chunk='x'.repeat(65536);let count=0;const flood=()=>{let ok=true;while(ok&&count++<500)ok=process.stdout.write(chunk);if(count<=500)process.stdout.once('drain',flood);else {process.stderr.write('CAPTURE_END\\n');setInterval(()=>{},1000)}};flood();`], logsPath: ownedPath } }, logDirectory, stopTimeoutMs: 80 });
  t.after(() => supervisor.dispose());
  const run = await supervisor.start({ program: 'flood', ownerId: 'owner' });
  assert.equal(run.logsPath, ownedPath);
  await until(() => supervisor.get(run.id).logs, (logs) => logs.some((entry) => entry.text.includes('CAPTURE_END')));
  const stopped = await supervisor.stop(run.id, 'owner');
  assert.ok(stopped.logs.length <= RUNTIME_LIMITS.logs);
  const files = readdirSync(logDirectory);
  assert.equal(files.length, 1);
  const capture = join(logDirectory, files[0]!);
  assert.ok(statSync(capture).size <= RUNTIME_LIMITS.logFileBytes);
  assert.equal(statSync(capture).mode & 0o777, 0o600);
  const tail = readFileSync(capture, 'utf8');
  assert.ok(tail.includes('CAPTURE_END'));
  assert.match(tail, /dsh capture (?:rolled|dropped)/);
});

test('owner reauthorization permits new starts but never revives a restart awaiting revoked cleanup', async (t) => {
  const supervisor = new ProgramSupervisor({ programs: { app: { command: [process.execPath, '-e', 'process.on("SIGTERM",()=>{});console.log("ready");setInterval(()=>{},1000)'] } }, stopTimeoutMs: 100 });
  t.after(() => supervisor.dispose());
  const first = await supervisor.start({ program: 'app', ownerId: 'owner' });
  await until(() => supervisor.get(first.id).logs, (logs) => logs.some((entry) => entry.text.includes('ready')));
  const restart = supervisor.restart(first.id, 'owner');
  const rejection = assert.rejects(restart, hasCode('OWNER_REVOKED'));
  const revocation = supervisor.revokeOwner('owner');
  assert.throws(() => supervisor.allowOwner('owner'), hasCode('BUSY'));
  await revocation;
  supervisor.allowOwner('owner');
  await rejection;
  assert.equal(supervisor.get(first.id).generation, 1);
  const next = await supervisor.start({ program: 'app', ownerId: 'owner' });
  assert.equal(next.state, 'running');
  // Reauthorizing an already-active owner is an idempotent no-op.
  supervisor.allowOwner('owner');
  await supervisor.stop(next.id, 'owner');
});
