import assert from 'node:assert/strict';
import dns from 'node:dns';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import { connectProgram, createProgramEndpoints, ProgramError, type ProgramEndpointBinding } from '../src/app/index.js';
import { AppBridgeServer, type AppBridgeServerOptions } from '../src/app/server.js';
import type { JsonValue, ProgramSnapshot } from '../src/types.js';

const configured: ProgramEndpointBinding = { id: 'web', bindHost: '127.0.0.1', requestedPort: 0, publicHost: 'browser', protocol: 'http' };
const hasCode = (code: string) => (error: unknown) => error instanceof ProgramError && error.code === code;
const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
const asJson = (value: unknown) => value as JsonValue;
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

async function bridgeClient(t: TestContext, handler: AppBridgeServerOptions['handler']) {
  const bridge = new AppBridgeServer({ handler });
  t.after(() => bridge.dispose());
  await bridge.ready;
  const run: ProgramSnapshot = { id: 'run', generation: 1, program: 'app', ownerId: 'parent', label: 'App', state: 'running', startedAt: new Date().toISOString(), logs: [], messages: [], resources: [] };
  const { env } = bridge.register(run, { command: ['node', 'app.mjs'] });
  return connectProgram({ url: env.DSH_PROGRAM_BRIDGE_URL, token: env.DSH_PROGRAM_BRIDGE_TOKEN, logger: { stdout: false } });
}

function trackServer(t: TestContext, server = createServer((_request, response) => response.end('endpoint ok'))) {
  t.after(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
  return server;
}
async function bind(server: Server, port = 0) {
  await new Promise<void>((resolve, reject) => {
    const fail = (error: Error) => { server.removeListener('listening', ready); reject(error); };
    const ready = () => { server.removeListener('error', fail); resolve(); };
    server.once('error', fail);
    server.once('listening', ready);
    server.listen(port, '127.0.0.1');
  });
  return (server.address() as AddressInfo).port;
}

const listeners = (server: Server) => ['error', 'listening', 'close'].map((event) => server.listenerCount(event));

// This is deliberately a bridge, not a fake app-owned configuration source.
// The app environment and previous watch worker's published port cannot override it.
test('app endpoint listen binds authoritative host/OS port and publishes only the actual listening port', async (t) => {
  const previous = process.env.DSH_PROGRAM_ENDPOINTS_JSON;
  process.env.DSH_PROGRAM_ENDPOINTS_JSON = JSON.stringify([{ ...configured, bindHost: '192.0.2.1', requestedPort: 1 }]);
  t.after(() => { if (previous === undefined) delete process.env.DSH_PROGRAM_ENDPOINTS_JSON; else process.env.DSH_PROGRAM_ENDPOINTS_JSON = previous; });
  const server = trackServer(t);
  const baseline = listeners(server);
  const seen: Array<{ method: string; input: JsonValue }> = [];
  let published: number | undefined;
  const app = await bridgeClient(t, async (_context, method, input) => {
    seen.push({ method, input });
    if (method === 'endpoints.list') return asJson([{ ...configured, port: 9 }]);
    const args = input as { id: string; port: number };
    assert.equal(args.id, 'web');
    if (method === 'endpoints.publish') {
      assert.equal(server.listening, true);
      const address = server.address() as AddressInfo;
      assert.equal(address.address, configured.bindHost);
      assert.equal(args.port, address.port);
      assert.notEqual(args.port, 0);
      published = args.port;
      return asJson({ ...configured, port: args.port });
    }
    if (method === 'endpoints.unpublish') {
      assert.equal(args.port, published);
      assert.equal(server.listening, false);
      return asJson(configured);
    }
    throw new Error(`Unexpected ${method}`);
  });
  const listening = await app.endpoints.listen('web', server);
  assert.equal(listening.host, '127.0.0.1');
  assert.equal(listening.port, published);
  assert.equal(listening.localUrl, `http://127.0.0.1:${published}/`);
  assert.equal(await (await fetch(listening.localUrl)).text(), 'endpoint ok');
  assert.equal(server.listenerCount('error'), baseline[0]);
  assert.equal(server.listenerCount('listening'), baseline[1]);
  await listening.close();
  await listening.close();
  assert.deepEqual(listeners(server), baseline);
  assert.deepEqual(seen, [
    { method: 'endpoints.list', input: null },
    { method: 'endpoints.publish', input: { id: 'web', port: published! } },
    { method: 'endpoints.unpublish', input: { id: 'web', port: published! } },
  ]);
});

test('app endpoint wrappers preserve the coordinated exact payloads', async (t) => {
  const seen: Array<{ method: string; input: JsonValue }> = [];
  const app = await bridgeClient(t, async (_context, method, input) => {
    seen.push({ method, input });
    return asJson(method === 'endpoints.list' ? [configured] : configured);
  });
  assert.deepEqual(await app.endpoints.list(), [configured]);
  assert.deepEqual(await app.endpoints.publish('web', { port: 4321 }), configured);
  await app.endpoints.unpublish('web', { port: 4321 });
  await app.endpoints.unpublish('web');
  assert.deepEqual(seen, [
    { method: 'endpoints.list', input: null },
    { method: 'endpoints.publish', input: { id: 'web', port: 4321 } },
    { method: 'endpoints.unpublish', input: { id: 'web', port: 4321 } },
    { method: 'endpoints.unpublish', input: { id: 'web' } },
  ]);
});

test('app endpoint fixed-port collision fails once without advertising or leaking listeners', async (t) => {
  const occupied = trackServer(t);
  const port = await bind(occupied);
  const server = trackServer(t);
  const baseline = listeners(server);
  const seen: string[] = [];
  const app = await bridgeClient(t, async (_context, method) => {
    seen.push(method);
    return asJson([{ ...configured, requestedPort: port }]);
  });
  await assert.rejects(app.endpoints.listen('web', server), (error: unknown) => (error as NodeJS.ErrnoException).code === 'EADDRINUSE');
  assert.deepEqual(seen, ['endpoints.list']);
  assert.equal(server.listening, false);
  assert.deepEqual(listeners(server), baseline);
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), 'endpoint ok');
});

test('app endpoint publication failure closes the listener and compensates exact port without retry', async (t) => {
  const server = trackServer(t);
  const baseline = listeners(server);
  const seen: Array<{ method: string; input: JsonValue }> = [];
  let port = 0;
  const app = await bridgeClient(t, async (_context, method, input) => {
    seen.push({ method, input });
    if (method === 'endpoints.list') return asJson([configured]);
    if (method === 'endpoints.publish') {
      port = (input as { port: number }).port;
      assert.equal(server.listening, true);
      throw new ProgramError('UNAVAILABLE', 'publication failed');
    }
    assert.equal(method, 'endpoints.unpublish');
    assert.equal(server.listening, false);
    return asJson(configured);
  });
  await assert.rejects(app.endpoints.listen('web', server), hasCode('UNAVAILABLE'));
  assert.deepEqual(seen, [
    { method: 'endpoints.list', input: null },
    { method: 'endpoints.publish', input: { id: 'web', port } },
    { method: 'endpoints.unpublish', input: { id: 'web', port } },
  ]);
  assert.ok(port > 0);
  assert.equal(server.listening, false);
  assert.deepEqual(listeners(server), baseline);
  const replacement = trackServer(t);
  assert.equal(await bind(replacement, port), port);
});

test('app endpoint close during publication unpublishes after publication and never returns stale handle', async (t) => {
  const server = trackServer(t);
  const baseline = listeners(server);
  const entered = deferred();
  const release = deferred();
  const seen: string[] = [];
  let port = 0;
  const app = await bridgeClient(t, async (_context, method, input) => {
    seen.push(method);
    if (method === 'endpoints.list') return asJson([configured]);
    if (method === 'endpoints.publish') {
      port = (input as { port: number }).port;
      entered.resolve();
      await release.promise;
      seen.push('published');
      return asJson({ ...configured, port });
    }
    assert.equal(method, 'endpoints.unpublish');
    assert.deepEqual(input, { id: 'web', port });
    assert.ok(seen.includes('published'));
    return asJson(configured);
  });
  const pending = app.endpoints.listen('web', server);
  const rejected = assert.rejects(pending, hasCode('UNAVAILABLE'));
  await entered.promise;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await nextTurn();
  assert.deepEqual(seen, ['endpoints.list', 'endpoints.publish']);
  release.resolve();
  await rejected;
  assert.deepEqual(seen, ['endpoints.list', 'endpoints.publish', 'published', 'endpoints.unpublish']);
  assert.deepEqual(listeners(server), baseline);
});

test('closing an older watch listener unpublishes only its port, preserving its replacement', async (t) => {
  const oldServer = trackServer(t);
  const newServer = trackServer(t);
  let published: number | undefined;
  const unpublished = deferred();
  const app = await bridgeClient(t, async (_context, method, input) => {
    if (method === 'endpoints.list') return asJson([{ ...configured, ...(published === undefined ? {} : { port: published }) }]);
    const { port } = input as { port: number };
    if (method === 'endpoints.publish') published = port;
    else {
      assert.equal(method, 'endpoints.unpublish');
      if (published === port) published = undefined;
      unpublished.resolve();
    }
    return asJson({ ...configured, ...(published === undefined ? {} : { port: published }) });
  });
  const old = await app.endpoints.listen('web', oldServer);
  const replacement = await app.endpoints.listen('web', newServer);
  assert.notEqual(old.port, replacement.port);
  assert.equal(published, replacement.port);
  // Raw framework/server closure, not just the convenience handle, unpublishes.
  await new Promise<void>((resolve) => oldServer.close(() => resolve()));
  await unpublished.promise;
  assert.equal(published, replacement.port);
  await old.close();
  await replacement.close();
  assert.equal(published, undefined);
});

test('app endpoint cancellation is call-scoped, performs no retries, and cleans a bound listener', async (t) => {
  const server = trackServer(t);
  const baseline = listeners(server);
  const entered = deferred();
  const serverCancelled = deferred();
  const methods: string[] = [];
  let port = 0;
  const app = await bridgeClient(t, async (_context, method, input, signal) => {
    methods.push(method);
    if (method === 'endpoints.list') return asJson([configured]);
    if (method === 'endpoints.publish') {
      port = (input as { port: number }).port;
      entered.resolve();
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => { serverCancelled.resolve(); resolve(); }, { once: true });
      });
      return asJson({ ...configured, port });
    }
    assert.equal(method, 'endpoints.unpublish');
    assert.deepEqual(input, { id: 'web', port });
    return asJson(configured);
  });
  const controller = new AbortController();
  const pending = app.endpoints.listen('web', server, { signal: controller.signal });
  const rejected = assert.rejects(pending, hasCode('CANCELLED'));
  await entered.promise;
  assert.equal(server.listening, true);
  controller.abort();
  await rejected;
  await serverCancelled.promise;
  assert.deepEqual(methods, ['endpoints.list', 'endpoints.publish', 'endpoints.unpublish']);
  assert.equal(server.listening, false);
  assert.deepEqual(listeners(server), baseline);
  assert.deepEqual(await app.endpoints.list(), [configured]);
  const count = methods.length;
  await assert.rejects(app.endpoints.list({ signal: AbortSignal.abort() }), hasCode('CANCELLED'));
  await assert.rejects(app.endpoints.publish('web', { port: 1234 }, { signal: AbortSignal.abort() }), hasCode('CANCELLED'));
  await assert.rejects(app.endpoints.unpublish('web', {}, { signal: AbortSignal.abort() }), hasCode('CANCELLED'));
  await assert.rejects(app.endpoints.listen('web', server, { signal: AbortSignal.abort() }), hasCode('CANCELLED'));
  assert.equal(methods.length, count);
});

test('cancelling while hostname resolution is pending cannot leave a late unpublished listener', async (t) => {
  const server = trackServer(t);
  const baseline = listeners(server);
  const entered = deferred();
  const originalLookup = dns.lookup;
  let complete!: (error: NodeJS.ErrnoException | null, address: string, family: number) => void;
  t.after(() => { dns.lookup = originalLookup; });
  // Delay only the app bind hostname, keeping real loopback bridge networking.
  dns.lookup = ((host: string, options: unknown, callback: typeof complete) => {
    if (host !== 'dsh-endpoint-cancel.test') return Reflect.apply(originalLookup, dns, [host, options, callback]);
    complete = callback;
    entered.resolve();
  }) as typeof dns.lookup;
  const methods: string[] = [];
  const app = await bridgeClient(t, async (_context, method) => {
    methods.push(method);
    return asJson([{ ...configured, bindHost: 'dsh-endpoint-cancel.test' }]);
  });
  const controller = new AbortController();
  const pending = app.endpoints.listen('web', server, { signal: controller.signal });
  const rejected = assert.rejects(pending, hasCode('CANCELLED'));
  await entered.promise;
  controller.abort();
  await rejected;
  dns.lookup = originalLookup;
  complete(null, '127.0.0.1', 4);
  await nextTurn();
  assert.deepEqual(methods, ['endpoints.list']);
  assert.equal(server.listening, false);
  assert.deepEqual(listeners(server), baseline);
});

test('app endpoint configuration and bind failures leave caller listeners untouched', async (t) => {
  const server = trackServer(t);
  const ownError = () => {};
  const ownListening = () => {};
  const ownClose = () => {};
  server.on('error', ownError).on('listening', ownListening).on('close', ownClose);
  const baseline = listeners(server);
  let mode: 'missing' | 'malformed' | 'bind' = 'missing';
  const app = await bridgeClient(t, async (_context, method) => {
    assert.equal(method, 'endpoints.list');
    if (mode === 'missing') return [];
    if (mode === 'malformed') return asJson([{ ...configured, requestedPort: -1 }]);
    return asJson([{ ...configured, bindHost: '192.0.2.1' }]);
  });
  await assert.rejects(app.endpoints.listen('web', server), hasCode('NOT_FOUND'));
  assert.deepEqual(listeners(server), baseline);
  mode = 'malformed';
  await assert.rejects(app.endpoints.listen('web', server), hasCode('INVALID_RESPONSE'));
  assert.deepEqual(listeners(server), baseline);
  mode = 'bind';
  await assert.rejects(app.endpoints.listen('web', server), (error: unknown) => (error as NodeJS.ErrnoException).code === 'EADDRNOTAVAIL');
  assert.deepEqual(listeners(server), baseline);
  assert.equal(server.listening, false);
});

test('endpoint helper rejects already-bound or concurrently-managed servers without taking ownership', async (t) => {
  const server = trackServer(t);
  let calls = 0;
  const entered = deferred();
  const release = deferred();
  const app = await bridgeClient(t, async (_context, method) => {
    calls++;
    assert.equal(method, 'endpoints.list');
    entered.resolve();
    await release.promise;
    return [];
  });
  const pending = app.endpoints.listen('web', server);
  const rejected = assert.rejects(pending, hasCode('NOT_FOUND'));
  await entered.promise;
  await assert.rejects(app.endpoints.listen('web', server), hasCode('BUSY'));
  release.resolve();
  await rejected;
  const port = await bind(server);
  await assert.rejects(app.endpoints.listen('web', server), hasCode('BUSY'));
  assert.equal(calls, 1);
  assert.equal((server.address() as AddressInfo).port, port);
});

test('setup errors arriving in the listening tick cannot be hidden by a resolved listening promise', async (t) => {
  const server = trackServer(t);
  const failure = new Error('failed immediately after listening');
  server.once('listening', () => { queueMicrotask(() => server.emit('error', failure)); });
  const methods: string[] = [];
  const endpoints = createProgramEndpoints(async <T>(method: string): Promise<T> => {
    methods.push(method);
    return asJson(method === 'endpoints.list' ? [configured] : configured) as T;
  });
  await assert.rejects(endpoints.listen('web', server), (error: unknown) => error === failure);
  assert.deepEqual(methods, ['endpoints.list']);
  assert.equal(server.listening, false);
});

test('typed endpoint helpers produce a local loopback URL for wildcard binds', async (t) => {
  const server = trackServer(t);
  const seen: JsonValue[] = [];
  const endpoints = createProgramEndpoints(async <T>(_method: string, input?: JsonValue): Promise<T> => {
    seen.push(input ?? null);
    return asJson(_method === 'endpoints.list' ? [{ ...configured, bindHost: '0.0.0.0' }] : configured) as T;
  });
  const handle = await endpoints.listen('web', server);
  assert.equal(handle.host, '0.0.0.0');
  assert.equal(handle.localUrl, `http://127.0.0.1:${handle.port}/`);
  assert.equal(await (await fetch(handle.localUrl)).text(), 'endpoint ok');
  await handle.close();
  assert.deepEqual(seen, [null, { id: 'web', port: handle.port }, { id: 'web', port: handle.port }]);
});
