import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ProgramSupervisor } from '../src/runtime/supervisor.js';
import { AppBridgeServer } from '../src/app/server.js';
import { connectProgram, ProgramError } from '../src/app/index.js';
import type { ProgramSnapshot } from '../src/types.js';

const fixture = fileURLToPath(new URL('./fixtures/app-bridge.mjs', import.meta.url));
const hasCode = (code: string) => (error: unknown) => error instanceof ProgramError && error.code === code;
function outputReady(run: ProgramSnapshot, source: Map<string, string>): { ready: boolean; id: string; generation: number; ipc: string; nodeOptions: string | null; result: unknown } | undefined {
  const text = source.get(`${run.id}:${run.generation}`) ?? '';
  const line = text.split('\n').find((entry) => entry.startsWith('{"ready":true'));
  return line ? JSON.parse(line) : undefined;
}

test('actual command and SDK children use fresh run-scoped credentials, output hooks, and revoke on stop', async (t) => {
  const server = new AppBridgeServer({ handler: async (context, method, input) => {
    assert.equal(context.run.ownerId, 'owner');
    assert.equal(method, 'tools.callTool');
    return { echoed: input, generation: context.run.generation };
  } });
  await server.ready;
  const envs = new Map<string, Record<string, string>>();
  const revoked: string[] = [];
  const output = new Map<string, string>();
  const waiters = new Map<string, () => void>();
  const supervisor = new ProgramSupervisor({
    programs: {
      command: { command: [process.execPath, '--import', import.meta.resolve('tsx'), fixture], env: { DSH_PROGRAM_BRIDGE_TOKEN: 'stale', NODE_OPTIONS: '' }, supervision: { restart: 'never' } },
      sdk: { entry: fixture, env: { APP_SDK: '1' } },
    },
    stopTimeoutMs: 100,
    bridge: {
      environment: (run, definition) => { const env = server.register(run, definition).env; envs.set(`${run.id}:${run.generation}`, env); return env; },
      revoke: (run) => { revoked.push(`${run.id}:${run.generation}`); server.revoke(run); },
    },
    onOutput: (run, chunk, stream) => {
      const key = `${run.id}:${run.generation}`;
      if (stream === 'stdout') output.set(key, (output.get(key) ?? '') + chunk);
      if (outputReady(run, output)) waiters.get(key)?.();
    },
  });
  t.after(async () => { await supervisor.dispose(); await server.dispose(); });
  const ready = async (run: ProgramSnapshot) => {
    if (!outputReady(run, output)) await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('App fixture did not connect')), 5000);
      waiters.set(`${run.id}:${run.generation}`, () => { clearTimeout(timer); resolve(); });
    });
    return outputReady(run, output)!;
  };
  const command = await supervisor.start({ program: 'command', ownerId: 'owner' });
  assert.equal(command.supervision?.restart, 'never');
  const first = await ready(command);
  assert.equal(first.ipc, 'undefined');
  assert.equal(first.id, command.id);
  assert.equal(first.generation, 1);
  assert.equal(first.nodeOptions, '');
  const restarted = await supervisor.restart(command.id, 'owner');
  await ready(restarted);
  assert.deepEqual(revoked, [`${command.id}:1`]);
  const oldEnv = envs.get(`${command.id}:1`)!;
  const nextEnv = envs.get(`${command.id}:2`)!;
  assert.notEqual(oldEnv.DSH_PROGRAM_BRIDGE_TOKEN, nextEnv.DSH_PROGRAM_BRIDGE_TOKEN);
  await assert.rejects(connectProgram({ url: oldEnv.DSH_PROGRAM_BRIDGE_URL, token: oldEnv.DSH_PROGRAM_BRIDGE_TOKEN }).call('tools.callTool'), hasCode('UNAUTHORIZED'));
  const sdk = await supervisor.start({ program: 'sdk', ownerId: 'owner' });
  const sdkInfo = await ready(sdk);
  assert.equal(sdkInfo.ipc, 'function');
  assert.equal(sdkInfo.generation, 1);
  await supervisor.stop(restarted.id, 'owner');
  await supervisor.revokeOwner('owner');
  assert.equal(revoked.filter((entry) => entry === `${command.id}:1`).length, 1);
  assert.ok(revoked.includes(`${command.id}:2`));
  assert.ok(revoked.includes(`${sdk.id}:1`));
});

test('bridge setup failure and spawn failure revoke credentials exactly once before failed start returns', async (t) => {
  const order: string[] = [];
  const supervisor = new ProgramSupervisor({ programs: { app: { command: ['/does-not-exist/dsh-app-test'] } }, bridge: {
    environment: () => { order.push('environment'); return { DSH_PROGRAM_BRIDGE_TOKEN: 'credential' }; },
    revoke: () => { order.push('revoke'); },
  }, stopTimeoutMs: 100 });
  t.after(() => supervisor.dispose());
  await assert.rejects(supervisor.start({ program: 'app', ownerId: 'owner' }));
  assert.deepEqual(order, ['environment', 'revoke']);
  const invalid = new ProgramSupervisor({ programs: { app: { command: [process.execPath] } }, bridge: {
    environment: () => { throw new Error('setup failed after registration'); },
    revoke: () => { order.push('revoke-setup'); },
  } });
  t.after(() => invalid.dispose());
  await assert.rejects(invalid.start({ program: 'app', ownerId: 'owner' }), /setup failed/);
  assert.equal(order.at(-1), 'revoke-setup');
});

test('bridge environment cannot inject NODE_OPTIONS and output observer exceptions cannot stop cleanup', async (t) => {
  let revoked = false;
  const invalid = new ProgramSupervisor({ programs: { app: { command: [process.execPath] } }, bridge: {
    environment: () => ({ NODE_OPTIONS: '--inspect' }), revoke: () => { revoked = true; },
  } });
  t.after(() => invalid.dispose());
  await assert.rejects(invalid.start({ program: 'app', ownerId: 'owner' }), /Invalid program bridge environment/);
  assert.equal(revoked, true);
  const supervisor = new ProgramSupervisor({ programs: { app: { command: [process.execPath, '-e', 'console.log("x".repeat(10000));setInterval(()=>{},1000)'] } }, onOutput: () => { throw new Error('bad observer'); }, stopTimeoutMs: 100 });
  t.after(() => supervisor.dispose());
  const run = await supervisor.start({ program: 'app', ownerId: 'owner' });
  assert.equal((await supervisor.stop(run.id, 'owner')).state, 'stopped');
});
