import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHTML } from 'linkedom';
import { createElement as h, act } from 'react';
import { createRoot } from 'react-dom/client';
import { ProgramAgentsPanel, ProgramAgentsDock } from '../src/client/view.js';
import { apply, inject } from '../src/client/index.js';
import { createProgramClient, type RpcTransport } from '../src/client/transport.js';
import type { ProgramRun } from '../src/client/model.js';

const baseRun = (overrides: Partial<ProgramRun> = {}): ProgramRun => ({ id: 'raw-uuid-never-display', generation: 7, ownerId: 'session-a', program: 'opaque-program-key', label: 'Legacy worker', state: 'running', startedAt: '', resources: [
  { id: 'good', title: 'App', type: 'ui', url: 'http://127.0.0.1:8080/app', available: true },
  { id: 'api', title: 'API', type: 'api', url: 'http://127.0.0.1:8080/api', docs: '/tmp/API.md', available: true },
  { id: 'bad', title: 'Unsafe', type: 'docs', url: 'file:///tmp/a', available: true },
  { id: 'local-docs', title: 'Local docs', type: 'docs', url: '/tmp/README.md', available: true },
], ...overrides });
const descriptor = { program: 'opaque-program-key', name: 'Worker', description: 'Does useful work', command: ['node', 'worker.ts'], urls: [], logsPath: '/tmp/program.log' };
const fullState = (run = baseRun()) => ({ runs: [{ ...run, logs: [{ text: 'PRIVATE LOG' }], messages: [{ body: 'PRIVATE MESSAGE' }], result: 'PRIVATE RESULT' }, baseRun({ id: 'foreign', ownerId: 'session-b', label: 'PRIVATE SESSION' })], programs: [descriptor] });
function setup() {
  const { document, window } = parseHTML('<!doctype html><html><head><base href="https://host.test/mount/"></head><body><div data-composer-seat><div id="root"></div><textarea aria-label="Chat composer"></textarea></div></body></html>');
  const original = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window, document, navigator: { userAgent: 'node' }, HTMLElement: window.HTMLElement, HTMLIFrameElement: window.HTMLIFrameElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    original.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const container = document.getElementById('root')!, root = createRoot(container);
  const click = async (label: string) => {
    const target = [...container.querySelectorAll('button')].find(button => button.textContent === label || button.textContent?.includes(label));
    assert.ok(target, `Missing button ${label}`);
    await act(async () => { target.dispatchEvent(new window.Event('click', { bubbles: true })); });
  };
  return { document, window, container, root, click, async cleanup() {
    await act(async () => root.unmount());
    for (const [key, value] of original) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); }
  } };
}
function carrier(initial: unknown = fullState(), sessionId = 'session-a') {
  const calls: Array<{ endpoint: string; payload: unknown }> = [];
  const streams: Array<{ controller: ReadableStreamDefaultController<Uint8Array>; signal: AbortSignal }> = [];
  let effect: () => Promise<void> = async () => {};
  const rpc: RpcTransport = { async call(_channel, endpoint, payload) { calls.push({ endpoint, payload }); await effect(); return { ok: true, value: undefined }; } };
  const push = (value: unknown, index = streams.length - 1) => streams[index]!.controller.enqueue(new TextEncoder().encode(`event: snapshot\ndata: ${JSON.stringify(value)}\n\n`));
  const client = createProgramClient({ rpc }, sessionId, async (_url, init) => new Response(new ReadableStream<Uint8Array>({ start(controller) { streams.push({ controller, signal: init.signal as AbortSignal }); controller.enqueue(new TextEncoder().encode(`event: snapshot\ndata: ${JSON.stringify(initial)}\n\n`)); } }), { headers: { 'content-type': 'text/event-stream' } }));
  return { client, calls, streams, push, setEffect(next: typeof effect) { effect = next; } };
}
test('actual DOM is a tiny bounded composer foldout with typed safe links and no message/log/Refresh UI', async () => {
  const dom = setup(), host = carrier();
  try {
    await act(async () => dom.root.render(h(ProgramAgentsPanel, { client: host.client })));
    const section = dom.container.querySelector('section')!;
    assert.equal(section.closest('[data-composer-seat]')?.querySelector('[aria-label="Chat composer"]') !== null, true);
    assert.equal(dom.container.textContent, '▸ Program agents (1)');
    assert.equal(dom.container.querySelector('article'), null); assert.equal(dom.container.querySelector('style'), null);
    assert.equal(section.getAttribute('style')?.includes('fixed'), false);
    await dom.click('Program agents');
    const text = dom.container.textContent!;
    assert.ok(text.includes('Worker')); assert.ok(text.includes('running')); assert.ok(text.includes('UI')); assert.ok(text.includes('API'));
    for (const forbidden of ['Refresh', 'Send', 'Message', 'Recent logs', 'PRIVATE', 'generation', 'raw-uuid', 'opaque-program-key', 'sandbox', 'Does useful work', '/tmp/program.log']) assert.equal(text.includes(forbidden), false, forbidden);
    assert.equal(dom.container.querySelector('form, textarea, input, pre, iframe, script, img'), null);
    assert.equal(dom.container.querySelector('[data-program-foldout]')?.getAttribute('style')?.includes('max-height:min(240px, 35vh)'), true);
    const links = [...dom.container.querySelectorAll('a')]; assert.equal(links.length, 2);
    assert.deepEqual(links.map(link => link.textContent), ['UI', 'API']);
    for (const link of links) { assert.equal(link.getAttribute('target'), '_blank'); assert.equal(link.getAttribute('rel'), 'noopener noreferrer'); assert.ok(link.getAttribute('href')?.startsWith('http')); }
    await dom.click('More'); assert.ok(dom.container.textContent?.includes('Does useful work')); assert.ok(dom.container.textContent?.includes('node worker.ts'));
    assert.ok(dom.container.textContent?.includes('/tmp/program.log')); assert.ok(dom.container.textContent?.includes('/tmp/API.md'));
    assert.ok(dom.container.textContent?.includes('/tmp/README.md')); assert.equal(dom.container.querySelector('a[href="/tmp/README.md"]'), null);
    assert.equal(dom.container.querySelector('a[href^="file:"]'), null); assert.equal(dom.container.querySelector('a[href="/tmp/API.md"]'), null);
    assert.ok([...dom.container.querySelectorAll('button')].some(button => button.textContent === 'Copy'));
  } finally { await dom.cleanup(); }
});
test('foldout and per-program More survive streaming generation changes; latest count deduplicates history', async () => {
  const dom = setup(), host = carrier();
  try {
    await act(async () => dom.root.render(h(ProgramAgentsPanel, { client: host.client })));
    await dom.click('Program agents'); await dom.click('More');
    await act(async () => host.push({ programs: [descriptor], runs: [baseRun({ generation: 8, state: 'completed', startedAt: '2026' }), baseRun({ id: 'older', generation: 1, startedAt: '2000' })] }));
    assert.equal(dom.container.querySelector('button[aria-expanded="true"]')?.textContent, '▾ Program agents (1)');
    assert.equal(dom.container.querySelectorAll('article').length, 1); assert.ok(dom.container.textContent?.includes('Does useful work'));
    assert.equal(dom.container.querySelectorAll('a').length, 0);
    const start = [...dom.container.querySelectorAll('button')].find(button => button.textContent === 'Start')!;
    assert.equal(start.hasAttribute('disabled'), false); assert.ok(dom.container.textContent?.includes('Restart'));
    await dom.click('Start'); assert.deepEqual(host.calls.at(-1), { endpoint: 'programAgents/start', payload: { sessionId: 'session-a', program: 'opaque-program-key' } });
    assert.equal(host.calls.some(call => call.endpoint.endsWith('/list')), false);
  } finally { await dom.cleanup(); }
});
test('configured Start and active Stop+Restart issue exact fenced args, pending single-flight disables links', async () => {
  const dom = setup(), host = carrier({ runs: [], programs: [descriptor] });
  let resolve!: () => void;
  host.setEffect(() => new Promise<void>(yes => { resolve = yes; }));
  try {
    await act(async () => dom.root.render(h(ProgramAgentsPanel, { client: host.client })));
    await dom.click('Program agents'); assert.ok(dom.container.textContent?.includes('configured'));
    assert.equal([...dom.container.querySelectorAll('button')].some(button => button.textContent === 'Restart'), false);
    await dom.click('Start'); await dom.click('Starting…'); assert.equal(host.calls.length, 1);
    await act(async () => resolve());
    await act(async () => host.push(fullState()));
    const stop = [...dom.container.querySelectorAll('button')].find(button => button.textContent === 'Stop')!;
    const restart = [...dom.container.querySelectorAll('button')].find(button => button.textContent === 'Restart')!;
    assert.equal(stop.hasAttribute('disabled'), false); assert.equal(restart.hasAttribute('disabled'), false);
    await dom.click('Restart'); assert.equal(dom.container.querySelectorAll('a').length, 0);
    assert.deepEqual(host.calls.at(-1), { endpoint: 'programAgents/restart', payload: { sessionId: 'session-a', id: 'raw-uuid-never-display', generation: 7 } });
    await act(async () => resolve());
    await act(async () => host.push(fullState(baseRun({ generation: 8 }))));
    await dom.click('Stop'); assert.deepEqual(host.calls.at(-1), { endpoint: 'programAgents/stop', payload: { sessionId: 'session-a', id: 'raw-uuid-never-display', generation: 8 } });
    await act(async () => resolve());
  } finally { await dom.cleanup(); }
});
test('disconnect keeps row history but revokes links/actions, visibility aborts and baseline self-heals', async () => {
  const dom = setup(), host = carrier();
  try {
    await act(async () => dom.root.render(h(ProgramAgentsPanel, { client: host.client })));
    await dom.click('Program agents'); assert.equal(dom.container.querySelectorAll('a').length, 2);
    await act(async () => host.streams[0]!.controller.error(new Error('Connection lost')));
    assert.ok(dom.container.textContent?.includes('Reconnecting…')); assert.equal(dom.container.querySelectorAll('a').length, 0);
    assert.ok(dom.container.textContent?.includes('Worker'));
    assert.ok([...dom.container.querySelectorAll('button')].filter(button => ['Stop', 'Restart'].includes(button.textContent ?? '')).every(button => button.hasAttribute('disabled')));
    Object.defineProperty(dom.document, 'visibilityState', { configurable: true, value: 'hidden' });
    await act(async () => dom.document.dispatchEvent(new dom.window.Event('visibilitychange')));
    assert.equal(host.streams[0]!.signal.aborted, true);
    Object.defineProperty(dom.document, 'visibilityState', { configurable: true, value: 'visible' });
    await act(async () => dom.document.dispatchEvent(new dom.window.Event('visibilitychange')));
    assert.equal(host.streams.length, 2); assert.equal(dom.container.querySelectorAll('a').length, 2);
    assert.equal(dom.container.querySelector('button[aria-expanded="true"]')?.textContent, '▾ Program agents (1)');
  } finally { await dom.cleanup(); }
});
test('Session switch remounts dock, aborts previous stream and prevents owner content flashes', async () => {
  const dom = setup(), a = carrier(fullState());
  const b = carrier({ runs: [], programs: [{ ...descriptor, name: 'Other session' }] }, 'session-b');
  try {
    await act(async () => dom.root.render(h(ProgramAgentsDock, { programClient: a.client })));
    await dom.click('Program agents'); assert.ok(dom.container.textContent?.includes('Worker'));
    await act(async () => dom.root.render(h(ProgramAgentsDock, { programClient: b.client })));
    assert.equal(a.streams[0]!.signal.aborted, true); assert.equal(dom.container.textContent?.includes('Worker'), false); assert.equal(dom.container.querySelector('article'), null);
    await dom.click('Program agents'); assert.ok(dom.container.textContent?.includes('Other session'));
  } finally { await dom.cleanup(); }
});
test('plugin retains strict Session composer dock registration using actual public connection RPC', () => {
  let declared = '', registered: { name: string; id: string; inject(sessionId: string): { programClient: unknown } } | undefined, component: unknown;
  apply({ connection: { rpc: { async call() { return { ok: true, value: { runs: [] } }; } } }, slots: {
    inject(name, callback) { declared = name; return callback(); }, register(options, view) { registered = options; component = view; },
  } });
  assert.deepEqual(inject, ['slots', 'connection']); assert.equal(declared, 'conversation.input.dock');
  assert.equal(registered?.name, declared); assert.equal(registered?.id, 'program-agents'); assert.equal(component, ProgramAgentsDock);
  assert.equal((registered?.inject('session-selected').programClient as { sessionId: string }).sessionId, 'session-selected');
});
