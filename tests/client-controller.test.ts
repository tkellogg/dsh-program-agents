import assert from 'node:assert/strict';
import test from 'node:test';
import { actionKey, createPanelController } from '../src/client/controller.js';
import { parseRunList, type ProgramItem, type ProgramRun, type RunList } from '../src/client/model.js';
import type { ProgramClient } from '../src/client/transport.js';
const run = (generation = 1, state: ProgramRun['state'] = 'running'): ProgramRun => ({ id: 'p1', generation, state, program: 'worker', ownerId: 's1', label: 'Worker', startedAt: '', resources: [] });
const snapshot = (generation = 1, state: ProgramRun['state'] = 'running') => parseRunList({ runs: [run(generation, state)], programs: [{ program: 'worker', name: 'Worker', command: [], urls: [] }] }, 's1');
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function harness() {
  const streams: Array<{ push(value: RunList): void; signal: AbortSignal; end: ReturnType<typeof deferred<void>> }> = [];
  let listCalls = 0, actionCalls = 0;
  let mutation: (action: string, item: ProgramItem | ProgramRun, signal: AbortSignal) => Promise<void> = async () => {};
  const client: ProgramClient = {
    sessionId: 's1', async list() { listCalls++; throw new Error('Controller must never list-poll'); },
    subscribe(push, signal) { const end = deferred<void>(); streams.push({ push, signal, end }); return end.promise; },
    action(action, item, signal) { actionCalls++; return mutation(action, item, signal); },
  };
  return { client, streams, get listCalls() { return listCalls; }, get actionCalls() { return actionCalls; }, setMutation(next: typeof mutation) { mutation = next; } };
}
test('latest stream epoch wins even if an old carrier ignores cancellation', async () => {
  const h = harness(), controller = createPanelController(h.client, 1);
  controller.start(); assert.equal(h.streams.length, 1);
  h.streams[0]!.push(snapshot()); assert.equal(controller.getSnapshot().stale, false);
  controller.setVisible(false); assert.equal(h.streams[0]!.signal.aborted, true);
  controller.setVisible(true); assert.equal(h.streams.length, 2);
  h.streams[1]!.push(snapshot(2)); h.streams[0]!.push(snapshot(1));
  assert.equal(controller.getSnapshot().runs[0]?.generation, 2); assert.equal(h.listCalls, 0);
  controller.stop(); h.streams[1]!.push(snapshot(3)); assert.equal(controller.getSnapshot().runs[0]?.generation, 2);
});
test('stream failure marks history stale, reconnects with a full baseline, never list-polls', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(), controller = createPanelController(h.client, 1);
  controller.start(); h.streams[0]!.push(snapshot());
  h.streams[0]!.end.reject(new Error('Connection lost')); await flush();
  assert.equal(controller.getSnapshot().stale, true); assert.match(controller.getSnapshot().error ?? '', /Connection lost/);
  h.streams[0]!.push(snapshot(99)); assert.equal(controller.getSnapshot().runs[0]?.generation, 1);
  t.mock.timers.tick(1); await flush();
  assert.equal(h.streams.length, 2); h.streams[1]!.push(snapshot(2));
  assert.equal(controller.getSnapshot().stale, false); assert.equal(controller.getSnapshot().error, undefined); assert.equal(h.listCalls, 0);
  controller.stop();
});
test('hidden tab aborts stream and retry timer, visibility resumes one stream, stop aborts actions', async () => {
  const h = harness(), controller = createPanelController(h.client, 1_000);
  controller.setVisible(false); controller.start(); assert.equal(h.streams.length, 0);
  controller.setVisible(true); h.streams[0]!.push(snapshot());
  let actionSignal: AbortSignal | undefined; const pending = deferred<void>();
  h.setMutation(async (_action, _item, signal) => { actionSignal = signal; await pending.promise; });
  const action = controller.action('restart', controller.getSnapshot().items[0]!);
  controller.setVisible(false); assert.equal(h.streams[0]!.signal.aborted, true); assert.equal(controller.getSnapshot().stale, true);
  assert.equal(await controller.action('stop', run()), false);
  h.streams[0]!.end.reject(new Error('late disconnect')); await flush(); assert.equal(h.streams.length, 1);
  controller.setVisible(true); assert.equal(h.streams.length, 2);
  controller.stop(); assert.equal(h.streams[1]!.signal.aborted, true); assert.equal(actionSignal?.aborted, true);
  pending.resolve(); assert.equal(await action, false); assert.equal(h.listCalls, 0);
});
test('actions are single-flight, generation fenced and failures never replay the effect', async () => {
  const h = harness(), controller = createPanelController(h.client);
  const mutation = deferred<void>(); h.setMutation(async () => { await mutation.promise; });
  controller.start(); h.streams[0]!.push(snapshot());
  const target = controller.getSnapshot().items[0]!;
  const first = controller.action('stop', target);
  assert.equal(controller.getSnapshot().pending[actionKey(target)], 'stop');
  assert.equal(await controller.action('restart', target), false); assert.equal(h.actionCalls, 1);
  mutation.reject(new Error('Stop uncertain. Check status.')); assert.equal(await first, false);
  assert.equal(h.actionCalls, 1); assert.equal(h.streams.length, 2); assert.equal(controller.getSnapshot().stale, true);
  assert.match(controller.getSnapshot().actionErrors[actionKey(target)] ?? '', /Stop uncertain/);
  assert.equal(controller.getSnapshot().pending[actionKey(target)], undefined);
  h.streams[1]!.push(snapshot(2));
  assert.equal(await controller.action('stop', target), false); assert.equal(h.actionCalls, 1);
  assert.equal(controller.getSnapshot().actionErrors[actionKey(target)], undefined); controller.stop();
});
test('configured Start is double-click single-flight; successful actions await push and never refresh', async () => {
  const h = harness(), controller = createPanelController(h.client);
  const pending = deferred<void>(); h.setMutation(async () => { await pending.promise; });
  controller.start(); h.streams[0]!.push(parseRunList({ runs: [], programs: [{ program: 'worker', name: 'Worker', command: [], urls: [] }] }, 's1'));
  const configured = controller.getSnapshot().items[0]!;
  const first = controller.action('start', configured);
  assert.equal(await controller.action('start', configured), false); assert.equal(h.actionCalls, 1);
  pending.resolve(); assert.equal(await first, true); assert.equal(h.streams.length, 1); assert.equal(h.listCalls, 0);
  assert.equal(controller.getSnapshot().pending.worker, 'start');
  assert.equal(await controller.action('start', configured), false); assert.equal(h.actionCalls, 1);
  h.streams[0]!.push(parseRunList({ runs: [], programs: [{ program: 'worker', name: 'Changed description', command: [], urls: [] }] }, 's1'));
  assert.equal(await controller.action('start', configured), false); // unrelated metadata is not a launch transition
  h.streams[0]!.push(snapshot()); assert.equal(controller.getSnapshot().pending.worker, undefined);
  assert.equal(await controller.action('start', configured), false);
  controller.stop(); assert.equal(await controller.action('stop', run()), false);
});
