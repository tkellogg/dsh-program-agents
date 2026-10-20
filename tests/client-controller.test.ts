import assert from 'node:assert/strict';
import test from 'node:test';
import { actionKey, createPanelController } from '../src/client/controller.js';
import type { ProgramRun, RunList } from '../src/client/model.js';
import type { ProgramClient } from '../src/client/transport.js';
const run = (generation = 1, state: ProgramRun['state'] = 'running'): ProgramRun => ({ id: 'p1', generation, state, program: 'worker', ownerId: 's1', label: 'Worker', startedAt: '', logs: [], messages: [], resources: [] });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
test('latest read wins even when the carrier ignores cancellation', async () => {
  const reads = [deferred<RunList>(), deferred<RunList>()];
  const signals: AbortSignal[] = [];
  const client: ProgramClient = { sessionId: 's1', list: signal => { signals.push(signal); return reads[signals.length - 1]!.promise; }, action: async () => {} };
  const controller = createPanelController(client, 0);
  controller.start(); const refresh = controller.refresh();
  assert.equal(signals[0]?.aborted, true);
  reads[1]!.resolve({ runs: [run(2)], truncated: false }); await refresh;
  reads[0]!.resolve({ runs: [run(1)], truncated: false }); await flush();
  assert.equal(controller.getSnapshot().runs[0]?.generation, 2);
  controller.stop();
});
test('controller marks history stale on read failure and aborts on hide/unmount', async () => {
  let fail = false; const signals: AbortSignal[] = [];
  const client: ProgramClient = { sessionId: 's1', async list(signal) { signals.push(signal); if (fail) throw new Error('disconnected'); return { runs: [run()], truncated: false }; }, action: async () => {} };
  const controller = createPanelController(client, 0); controller.start(); await flush();
  assert.equal(controller.getSnapshot().stale, false);
  fail = true; await controller.refresh();
  assert.equal(controller.getSnapshot().stale, true); assert.match(controller.getSnapshot().error ?? '', /disconnected/); assert.equal(controller.getSnapshot().runs.length, 1);
  controller.setVisible(false); assert.equal(signals.at(-1)?.aborted, true);
  fail = false; controller.setVisible(true); await flush(); assert.equal(controller.getSnapshot().stale, false);
  controller.stop(); assert.equal(signals.at(-1)?.aborted, true); assert.equal(controller.getSnapshot().stale, true);
});
test('actions are single-flight, generation fenced and not retried after a failure', async () => {
  let latest = run(); const mutation = deferred<void>(); let actionCalls = 0;
  const client: ProgramClient = { sessionId: 's1', async list() { return { runs: [latest], truncated: false }; }, async action() { actionCalls++; await mutation.promise; } };
  const controller = createPanelController(client, 0); controller.start(); await flush();
  const first = controller.action('stop', latest);
  assert.equal(controller.getSnapshot().pending[actionKey(latest)], 'stop');
  assert.equal(await controller.action('stop', latest), false); assert.equal(actionCalls, 1);
  mutation.reject(new Error('Stop failed. Check status before retry.')); assert.equal(await first, false);
  assert.match(controller.getSnapshot().actionErrors[actionKey(latest)] ?? '', /Stop failed/);
  assert.equal(actionCalls, 1); assert.equal(controller.getSnapshot().pending[actionKey(latest)], undefined);
  const old = latest; latest = run(2); await controller.refresh();
  assert.equal(await controller.action('stop', old), false); assert.equal(actionCalls, 1);
  assert.equal(controller.getSnapshot().actionErrors[actionKey(old)], undefined);
  controller.stop();
});
test('successful send refreshes data; closed controllers cannot mutate', async () => {
  let actions = 0, reads = 0;
  const client: ProgramClient = { sessionId: 's1', async list() { reads++; return { runs: [run()], truncated: false }; }, async action() { actions++; } };
  const controller = createPanelController(client, 0); controller.start(); await flush();
  assert.equal(await controller.action('send', run(), 'hello'), true); assert.equal(reads, 2); assert.equal(actions, 1);
  controller.stop(); assert.equal(await controller.action('send', run(), 'hello'), false); assert.equal(actions, 1);
});
