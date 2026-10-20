import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHTML } from 'linkedom';
import { createElement as h, act } from 'react';
import { createRoot } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import { ProgramAgentsPanel, ProgramAgentsDock } from '../src/client/view.js';
import { apply, inject } from '../src/client/index.js';
import { createProgramClient, type RpcTransport } from '../src/client/transport.js';
import type { ProgramRun } from '../src/client/model.js';

const baseRun = (overrides: Partial<ProgramRun> = {}): ProgramRun => ({ id: 'p1', generation: 1, ownerId: 'session-a', program: 'worker', label: 'Worker', state: 'running', startedAt: '', logs: [{ sequence: 1, stream: 'stdout', text: '<script>bad()</script>' }], messages: [{ direction: 'program', body: { note: 'ready' }, at: 'now' }], resources: [
  { id: 'good', title: 'App', url: 'http://127.0.0.1:8080/app', available: true },
  { id: 'bad', title: 'Unsafe', url: 'javascript:alert(1)', available: true },
], ...overrides });
function setup() {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  const original = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window, document, navigator: { userAgent: 'node' }, HTMLElement: window.HTMLElement, HTMLIFrameElement: window.HTMLIFrameElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    original.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const container = document.getElementById('root')!;
  const root = createRoot(container);
  const click = async (label: string) => {
    const target = [...container.querySelectorAll('button')].find(button => button.textContent === label || button.textContent?.includes(label));
    assert.ok(target, `Missing button ${label}`);
    await act(async () => { target.dispatchEvent(new window.Event('click', { bubbles: true })); });
  };
  return { document, window, container, root, click,
    async cleanup() {
      await act(async () => root.unmount());
      for (const [key, descriptor] of original) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
    },
  };
}
test('actual DOM card renders safe external links, inert unsafe URLs, escaped logs and pending/errors', async () => {
  const dom = setup();
  let current = baseRun(); let fail = false; let rejectStop: ((error: Error) => void) | undefined;
  const calls: Array<{ endpoint: string; payload: unknown }> = [];
  const transport: RpcTransport = { async call(_channel, endpoint, payload) {
    calls.push({ endpoint, payload });
    if (endpoint === 'programAgents/list') return { ok: true, value: { runs: [current, baseRun({ id: 'secret', ownerId: 'session-b', label: 'PRIVATE SESSION' })] } };
    if (fail) return { ok: false, error: { code: 'failure', message: 'Host refused action.' } };
    return new Promise((_resolve, reject) => { rejectStop = reject; });
  } };
  const client = createProgramClient(transport, 'session-a');
  try {
    await act(async () => dom.root.render(h(ProgramAgentsPanel, { client, pollIntervalMs: 0 })));
    await dom.click('Program agents');
    assert.ok(dom.container.textContent?.includes('Worker')); assert.ok(dom.container.textContent?.includes('generation 1'));
    assert.equal(dom.container.textContent?.includes('PRIVATE SESSION'), false);
    const links = [...dom.container.querySelectorAll('a')]; assert.equal(links.length, 1);
    assert.equal(links[0]?.getAttribute('target'), '_blank'); assert.equal(links[0]?.getAttribute('rel'), 'noopener noreferrer');
    assert.equal(links[0]?.getAttribute('href'), 'http://127.0.0.1:8080/app');
    assert.equal(dom.container.querySelector('script, iframe, img'), null);
    assert.ok(dom.container.textContent?.includes('<script>bad()</script>')); assert.ok(dom.container.textContent?.includes('Unsafe — unavailable'));
    await dom.click('Stop');
    assert.ok(dom.container.textContent?.includes('Stopping…')); assert.equal(dom.container.querySelectorAll('a').length, 0);
    assert.deepEqual(calls.at(-1), { endpoint: 'programAgents/stop', payload: { sessionId: 'session-a', id: 'p1', generation: 1 } });
    await act(async () => { rejectStop?.(new Error('Stop deadline reached.')); });
    assert.ok(dom.container.textContent?.includes('Stop deadline reached.')); assert.equal(dom.container.querySelectorAll('a').length, 1);
    current = baseRun({ generation: 2, state: 'completed' });
    await dom.click('Refresh');
    assert.ok(dom.container.textContent?.includes('generation 2')); assert.equal(dom.container.querySelectorAll('a').length, 0);
    const stop = [...dom.container.querySelectorAll('button')].find(button => button.textContent === 'Stop')!;
    const restart = [...dom.container.querySelectorAll('button')].find(button => button.textContent === 'Restart')!;
    assert.equal(stop.hasAttribute('disabled'), true); assert.equal(restart.hasAttribute('disabled'), false);
    fail = true; await dom.click('Restart'); assert.ok(dom.container.textContent?.includes('Host refused action.'));
  } finally { await dom.cleanup(); }
});
test('actual DOM sends text/JSON messages once and keeps invalid JSON local', async () => {
  const dom = setup(); const sends: unknown[] = [];
  const client = createProgramClient({ async call(_channel, endpoint, payload) {
    if (endpoint === 'programAgents/send') sends.push(payload);
    return { ok: true, value: endpoint === 'programAgents/list' ? { runs: [baseRun()] } : undefined };
  } }, 'session-a');
  try {
    await act(async () => dom.root.render(h(ProgramAgentsPanel, { client, pollIntervalMs: 0 })));
    await dom.click('Program agents');
    const text = dom.container.querySelector('textarea') as unknown as HTMLTextAreaElement;
    const form = dom.container.querySelector('form')!;
    const checkbox = dom.container.querySelector('input[type="checkbox"]') as unknown as HTMLInputElement;
    await act(async () => { text.value = 'hello'; Simulate.change(text); });
    await act(async () => { form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); });
    assert.deepEqual(sends, [{ sessionId: 'session-a', id: 'p1', generation: 1, body: 'hello' }]);
    assert.equal(text.value, '');
    await act(async () => { checkbox.checked = true; Simulate.change(checkbox); text.value = 'bad-json'; Simulate.change(text); });
    await act(async () => { form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); });
    assert.ok(dom.container.textContent?.includes('Message is not valid JSON.')); assert.equal(sends.length, 1);
    await act(async () => { text.value = '{"ok":true}'; Simulate.change(text); });
    await act(async () => { form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); });
    assert.deepEqual(sends[1], { sessionId: 'session-a', id: 'p1', generation: 1, body: { ok: true } });
  } finally { await dom.cleanup(); }
});
test('actual DOM shows unavailable state and blocks stale links/controls on transport loss', async () => {
  const dom = setup(); let unavailable = false;
  const transport: RpcTransport = { async call() { if (unavailable) throw new Error('Connection lost'); return { ok: true, value: { runs: [baseRun()] } }; } };
  try {
    const client = createProgramClient(transport, 'session-a');
    await act(async () => dom.root.render(h(ProgramAgentsPanel, { client, pollIntervalMs: 0 })));
    await dom.click('Program agents'); assert.equal(dom.container.querySelectorAll('a').length, 1);
    unavailable = true; await dom.click('Refresh');
    assert.ok(dom.container.textContent?.includes('Connection lost')); assert.equal(dom.container.querySelectorAll('a').length, 0);
    assert.equal(dom.container.querySelector('textarea')?.hasAttribute('disabled'), true);
    assert.ok(dom.container.textContent?.includes('Worker'));
  } finally { await dom.cleanup(); }
});
test('Session switch remounts the dock without previous owner snapshots or drafts', async () => {
  const dom = setup();
  const client = (sessionId: string) => createProgramClient({ async call() { return { ok: true, value: { runs: [baseRun({ ownerId: sessionId, label: sessionId })] } }; } }, sessionId);
  try {
    await act(async () => dom.root.render(h(ProgramAgentsDock, { programClient: client('session-a') })));
    await dom.click('Program agents'); assert.ok(dom.container.textContent?.includes('session-a'));
    await act(async () => dom.root.render(h(ProgramAgentsDock, { programClient: client('session-b') })));
    assert.equal(dom.container.textContent?.includes('session-a'), false);
    await dom.click('Program agents'); assert.ok(dom.container.textContent?.includes('session-b'));
  } finally { await dom.cleanup(); }
});
test('plugin registers a real strict Session conversation dock contribution', () => {
  let declared = '', registered: { name: string; id: string; inject(sessionId: string): { programClient: unknown } } | undefined;
  let component: unknown;
  apply({
    connection: { rpc: { async call() { return { ok: true, value: { runs: [] } }; } } },
    slots: {
      inject(name, callback) { declared = name; return callback(); },
      register(options, view) { registered = options; component = view; },
    },
  });
  assert.deepEqual(inject, ['slots', 'connection']); assert.equal(declared, 'conversation.input.dock');
  assert.equal(registered?.name, declared); assert.equal(registered?.id, 'program-agents'); assert.equal(component, ProgramAgentsDock);
  assert.equal((registered?.inject('session-selected').programClient as { sessionId: string }).sessionId, 'session-selected');
});
