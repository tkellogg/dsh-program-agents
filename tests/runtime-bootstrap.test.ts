import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { ProgramSupervisor } from '../src/runtime/index.js';

test('trusted bootstrap directory override launches the SDK for bundled hosts', async (t) => {
  const supervisor = new ProgramSupervisor({
    programs: { app: { entry: fileURLToPath(new URL('./fixtures/native-types.ts', import.meta.url)) } },
    bootstrapDirectory: fileURLToPath(new URL('../src/runtime/', import.meta.url)),
    stopTimeoutMs: 80,
  });
  t.after(() => supervisor.dispose());
  const run = await supervisor.start({ program: 'app', ownerId: 'owner', input: 'override' });
  const deadline = Date.now() + 6000;
  while (supervisor.get(run.id).state !== 'completed' && Date.now() < deadline) await delay(10);
  assert.equal(supervisor.get(run.id).state, 'completed');
  assert.deepEqual(supervisor.get(run.id).result, { input: 'override', generation: 1 });
});
