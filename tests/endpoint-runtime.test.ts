import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { ProgramError, ProgramSupervisor, type EndpointNetworking, type ProgramDefinition, type ProgramSnapshot } from '../src/runtime/index.js';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const idle = [process.execPath, '-e', 'setInterval(()=>{},1000)'];
const hasCode = (code: string) => (error: unknown) => error instanceof ProgramError && error.code === code;
async function until<T>(read: () => T, accept: (value: T) => boolean, timeout = 8000): Promise<T> {
  const deadline = Date.now() + timeout;
  let value: T;
  do { value = read(); if (accept(value)) return value; await delay(10); } while (Date.now() < deadline);
  assert.fail(`Timed out; last value: ${JSON.stringify(value)}`);
}
function records(run: ProgramSnapshot): Array<Record<string, any>> {
  return readFileSync(run.logsPath!, 'utf8').split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line));
}
const bound = (run: ProgramSnapshot, id = 'web') => until(() => records(run).find((record) => record.kind === 'bound' && record.id === id), (record) => record !== undefined);
async function listen(port = 0): Promise<Server> {
  const server = createServer((_request, response) => response.end('occupied'));
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return server;
}
async function close(server: Server): Promise<void> {
  if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
const port = (server: Server) => (server.address() as AddressInfo).port;

function appDefinition(): ProgramDefinition {
  return {
    command: idle, endpoints: { web: { port: 'dynamic' } },
    urls: [
      { id: 'ui', title: 'Dashboard', type: 'ui', endpoint: 'web', path: '/dashboard?q=one#section' },
      { id: 'api', title: 'API', type: 'api', endpoint: 'web', path: '/api', docs: '/tmp/openapi.json' },
      { id: 'legacy', title: 'Existing', type: 'docs', url: 'https://example.com/docs' },
    ],
  };
}

test('endpoint definitions and recipes are bounded, exact, copied, and unevaluated in descriptors', async (t) => {
  const definition = appDefinition();
  const supervisor = new ProgramSupervisor({ programs: { app: definition }, stopTimeoutMs: 80 });
  t.after(() => supervisor.dispose());
  definition.endpoints!.web!.port = 9876;
  definition.urls![0]!.path = '/mutated';
  const descriptor = supervisor.definitionsList()[0]!;
  assert.deepEqual(descriptor.endpoints, { web: { port: 'dynamic' } });
  assert.deepEqual(descriptor.urls[0], { id: 'ui', title: 'Dashboard', type: 'ui', url: '', endpoint: 'web', path: '/dashboard?q=one#section', available: false });
  assert.deepEqual(descriptor.urls[1], { id: 'api', title: 'API', type: 'api', url: '', endpoint: 'web', path: '/api', docs: '/tmp/openapi.json', available: false });
  assert.equal(descriptor.urls[2]!.url, 'https://example.com/docs');
  assert.equal(descriptor.urls[0]!.address, undefined);
  descriptor.endpoints!.web!.port = 12345;
  descriptor.urls[0]!.endpoint = 'changed';
  assert.equal(supervisor.definitionsList()[0]!.endpoints!.web!.port, 'dynamic');
  assert.equal(supervisor.definitionsList()[0]!.urls[0]!.endpoint, 'web');
  const invalidEndpoints: unknown[] = [
    null, [], 'web', { web: null }, { web: {} }, { web: { port: 0 } }, { web: { port: -1 } },
    { web: { port: 65536 } }, { web: { port: 2.5 } }, { web: { port: NaN } }, { web: { port: Infinity } },
    { web: { port: '0' } }, { web: { port: 'dynamic', host: '0.0.0.0' } },
    { 'invalid.name': { port: 'dynamic' } }, { '1web': { port: 'dynamic' } }, { ['w'.repeat(65)]: { port: 'dynamic' } },
    Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`web${index}`, { port: 'dynamic' }])),
  ];
  for (const endpoints of invalidEndpoints) assert.throws(() => supervisor.define('invalid', { command: idle, endpoints } as ProgramDefinition), hasCode('INVALID_CONFIG'));
  const invalidUrls: unknown[] = [
    { id: 'x', title: 'x', type: 'ui' },
    { id: 'x', title: 'x', type: 'ui', url: 'https://example.com', endpoint: 'web' },
    { id: 'x', title: 'x', type: 'ui', url: 'https://example.com', path: '/' },
    { id: 'x', title: 'x', type: 'ui', endpoint: 'missing' },
    { id: 'x', title: 'x', type: 'ui', endpoint: 'web', path: '//attacker.invalid' },
    { id: 'x', title: 'x', type: 'ui', endpoint: 'web', path: 'https://attacker.invalid/' },
    { id: 'x', title: 'x', type: 'ui', endpoint: 'web', path: '/\\attacker.invalid' },
    { id: 'x', title: 'x', type: 'ui', endpoint: 'web', path: '/%0aheader' },
    { id: 'x', title: 'x', type: 'ui', endpoint: 'web', path: '/%5cattacker.invalid' },
    { id: 'x', title: 'x', type: 'ui', endpoint: 'web', path: '/bad path' },
    { id: 'x', title: 'x', type: 'ui', endpoint: 'web', path: '/\n' },
    { id: 'x', title: 'x', type: 'ui', endpoint: 'web', path: `/${'x'.repeat(4096)}` },
    { id: 'x', title: 'x', type: 'ui', endpoint: 'web', address: { port: 1 } },
    { id: 'x', title: 'x', type: 'ui', endpoint: 'web', docs: 'relative.md' },
    { id: 'x', title: 'x', type: 'other', endpoint: 'web' },
  ];
  for (const resource of invalidUrls) assert.throws(() => supervisor.define('invalid', { command: idle, endpoints: { web: { port: 'dynamic' } }, urls: [resource] } as ProgramDefinition), hasCode('INVALID_CONFIG'));
  supervisor.define('defaults', { command: idle, endpoints: { web: { port: 'dynamic' } }, urls: [{ id: 'ui', title: '', type: 'ui', endpoint: 'web' }] });
  assert.equal(supervisor.definitionsList().find((item) => item.program === 'defaults')!.urls[0]!.path, '/');
  supervisor.define('maximum', { command: idle, endpoints: Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`web${index}`, { port: 'dynamic' as const }])) });
});

test('networking is trusted bounded policy with browser/http defaults and valid IPv6 listener syntax', async (t) => {
  const invalid: unknown[] = [
    null, [], 'public', { extra: true }, { bindHost: 'browser' }, { bindHost: '' }, { bindHost: null },
    { bindHost: 'https://host' }, { bindHost: 'host:3000' }, { bindHost: 'host\n' },
    { publicHost: '0.0.0.0' }, { publicHost: '::' }, { publicHost: '[::]' }, { publicHost: 'http://host' },
    { publicHost: 'user@host' }, { publicHost: 'host/path' }, { publicHost: 'x'.repeat(254) },
    { protocol: 'ws' }, { protocol: null },
  ];
  for (const networking of invalid) assert.throws(() => new ProgramSupervisor({ programs: {}, networking: networking as EndpointNetworking }), hasCode('INVALID_CONFIG'));
  const networking: EndpointNetworking = { bindHost: '[::1]', publicHost: '2001:db8::7', protocol: 'https' };
  const supervisor = new ProgramSupervisor({ programs: { app: appDefinition() }, networking, stopTimeoutMs: 80 });
  t.after(() => supervisor.dispose());
  networking.bindHost = '0.0.0.0';
  const run = await supervisor.start({ program: 'app', ownerId: 'owner' });
  assert.deepEqual(run.endpoints, [{ id: 'web', bindHost: '::1', requestedPort: 0, publicHost: '[2001:db8::7]', protocol: 'https' }]);
  supervisor.reportEndpoint(run.id, 'owner', { id: 'web', port: 32001 });
  assert.deepEqual(supervisor.get(run.id).resources[0]!.address, { endpoint: 'web', host: '[2001:db8::7]', protocol: 'https', port: 32001, path: '/dashboard?q=one#section' });
  assert.equal(supervisor.get(run.id).resources[0]!.url, '');
});

test('OS-selected app port is reported only after bind and never reused from an occupied old generation', async (t) => {
  const bridgeRuns: ProgramSnapshot[] = [];
  const revoked: ProgramSnapshot[] = [];
  const supervisor = new ProgramSupervisor({
    programs: { app: { ...appDefinition(), command: [process.execPath, fixture('endpoint-listener.mjs')], env: { DSH_PROGRAM_ENDPOINTS_JSON: '[{"id":"stale","port":9999}]', DSH_PROGRAM_BRIDGE_TOKEN: 'stale' } } },
    stopTimeoutMs: 80,
    bridge: {
      environment: (run) => { bridgeRuns.push(run); return { DSH_PROGRAM_ENDPOINTS_JSON: 'bridge-stale', DSH_PROGRAM_BRIDGE_TOKEN: 'fresh' }; },
      revoke: (run) => { revoked.push(run); },
    },
  });
  t.after(() => supervisor.dispose());
  const first = await supervisor.start({ program: 'app', ownerId: 'owner' });
  assert.deepEqual(first.endpoints, [{ id: 'web', bindHost: '127.0.0.1', requestedPort: 0, publicHost: 'browser', protocol: 'http' }]);
  assert.equal(first.resources[0]!.available, false, 'Process startup is not endpoint readiness');
  assert.equal(first.resources[1]!.available, false);
  assert.equal(first.resources[2]!.available, true, 'Legacy literal resources retain startup behavior');
  const firstBound = (await bound(first))!;
  assert.ok(firstBound.port > 0);
  assert.equal(firstBound.requestedPort, 0);
  assert.equal(supervisor.get(first.id).resources[0]!.available, false, 'OS bind without a report must not publish a resource');
  const environment = records(first).find((record) => record.kind === 'environment')!;
  assert.deepEqual(environment.bindings, first.endpoints, 'Runtime bindings survive both environment scrub and bridge setup');
  assert.equal(environment.bridgeToken, 'fresh');
  const response = await fetch(`http://127.0.0.1:${firstBound.port}/api`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { endpoint: 'web', pid: firstBound.pid });
  const reported = supervisor.reportEndpoint(first.id, 'owner', { id: 'web', port: firstBound.port });
  reported.port = 1;
  const published = supervisor.get(first.id);
  assert.equal(published.resources[0]!.url, '', 'Never publish server-local loopback as a browser href');
  assert.deepEqual(published.resources[0]!.address, { endpoint: 'web', host: 'browser', protocol: 'http', port: firstBound.port, path: '/dashboard?q=one#section' });
  assert.equal(published.resources[1]!.address!.path, '/api');
  assert.equal(published.endpoints![0]!.port, firstBound.port);
  assert.ok(published.resources.every((resource) => resource.available));
  const stopped = await supervisor.stop(first.id, 'owner');
  assert.ok(stopped.resources.every((resource) => !resource.available));
  assert.equal(stopped.resources[0]!.address, undefined);
  assert.equal(stopped.resources[0]!.endpoint, 'web');
  assert.equal(stopped.endpoints![0]!.port, undefined);
  const occupiedOldPort = await listen(firstBound.port);
  t.after(() => close(occupiedOldPort));
  const second = await supervisor.restart(first.id, 'owner');
  assert.equal(second.generation, 2);
  assert.equal(second.endpoints![0]!.requestedPort, 0);
  assert.equal(second.endpoints![0]!.port, undefined);
  assert.equal(second.resources[0]!.address, undefined);
  assert.equal(second.resources[0]!.available, false);
  const secondBound = (await bound(second))!;
  assert.notEqual(secondBound.port, firstBound.port, 'App OS bind(0) selects a free port even while old port is occupied');
  supervisor.reportEndpoint(second.id, 'owner', { id: 'web', port: secondBound.port });
  assert.equal(supervisor.get(second.id).resources[0]!.address!.port, secondBound.port);
  assert.deepEqual(bridgeRuns.map((run) => [run.generation, run.endpoints![0]!.requestedPort, run.endpoints![0]!.port]), [[1, 0, undefined], [2, 0, undefined]]);
  assert.equal(revoked.length, 1);
  await supervisor.stop(second.id, 'owner');
});

test('same-generation watch workers can replace ports and conditional old-worker unpublish cannot revoke new binding', async (t) => {
  const supervisor = new ProgramSupervisor({ programs: { app: appDefinition() }, stopTimeoutMs: 80 });
  const firstListener = await listen();
  const nextListener = await listen();
  t.after(async () => { await supervisor.dispose(); await close(firstListener); await close(nextListener); });
  const run = await supervisor.start({ program: 'app', ownerId: 'owner' });
  supervisor.reportEndpoint(run.id, 'owner', { id: 'web', port: port(firstListener) });
  supervisor.reportEndpoint(run.id, 'owner', { id: 'web', port: port(nextListener) });
  supervisor.unpublishEndpoint(run.id, 'owner', 'web', port(firstListener));
  const updated = supervisor.get(run.id);
  assert.equal(updated.generation, 1);
  assert.equal(updated.resources[0]!.address!.port, port(nextListener));
  assert.equal(updated.resources[0]!.available, true);
  supervisor.unpublishEndpoint(run.id, 'owner', 'web', port(nextListener));
  const unpublished = supervisor.get(run.id);
  assert.equal(unpublished.endpoints![0]!.port, undefined);
  assert.equal(unpublished.resources[0]!.address, undefined);
  assert.equal(unpublished.resources[0]!.available, false);
  assert.equal(unpublished.resources[0]!.endpoint, 'web');
  assert.equal(unpublished.resources[0]!.path, '/dashboard?q=one#section');
  assert.equal(unpublished.resources[2]!.available, true);
  supervisor.reportEndpoint(run.id, 'owner', { id: 'web', port: port(nextListener) });
  supervisor.unpublishEndpoint(run.id, 'owner', 'web');
  assert.equal(supervisor.get(run.id).resources[0]!.available, false);
});

test('endpoint operations require exact owner, configured ids, bounded exact reports, and current live state', async (t) => {
  const supervisor = new ProgramSupervisor({ programs: { app: appDefinition() }, stopTimeoutMs: 80 });
  t.after(() => supervisor.dispose());
  const run = await supervisor.start({ program: 'app', ownerId: 'owner' });
  for (const operation of [
    () => supervisor.endpointBindings(run.id, 'intruder'),
    () => supervisor.reportEndpoint(run.id, 'intruder', { id: 'web', port: 1234 }),
    () => supervisor.unpublishEndpoint(run.id, 'intruder', 'web'),
    () => supervisor.endpointBindings(run.id, undefined as unknown as string),
    () => supervisor.reportEndpoint(run.id, undefined as unknown as string, { id: 'web', port: 1234 }),
  ]) assert.throws(operation, hasCode('NOT_FOUND'));
  for (const report of [null, {}, { id: 'web' }, { id: 'web', port: 0 }, { id: 'web', port: -1 }, { id: 'web', port: 65536 }, { id: 'web', port: NaN }, { id: 'web', port: Infinity }, { id: 'web', port: 1.5 }, { id: 'web', port: '3000' }, { id: 'web', port: 1234, host: 'attacker.invalid' }, { id: 'web', port: 1234, generation: 99 }, { id: 'bad.id', port: 1234 }]) {
    assert.throws(() => supervisor.reportEndpoint(run.id, 'owner', report as { id: string; port: number }), hasCode('INVALID_INPUT'));
  }
  assert.throws(() => supervisor.reportEndpoint(run.id, 'owner', { id: 'missing', port: 1234 }), hasCode('UNKNOWN_ENDPOINT'));
  assert.throws(() => supervisor.unpublishEndpoint(run.id, 'owner', 'missing'), hasCode('UNKNOWN_ENDPOINT'));
  for (const badPort of [0, NaN, 65536, 1.5]) assert.throws(() => supervisor.unpublishEndpoint(run.id, 'owner', 'web', badPort), hasCode('INVALID_INPUT'));
  const mutable = supervisor.endpointBindings(run.id, 'owner');
  mutable[0]!.requestedPort = 1;
  mutable[0]!.publicHost = 'mutated.invalid';
  assert.equal(supervisor.endpointBindings(run.id, 'owner')[0]!.requestedPort, 0);
  assert.equal(supervisor.endpointBindings(run.id, 'owner')[0]!.publicHost, 'browser');
  supervisor.reportEndpoint(run.id, 'owner', { id: 'web', port: 1234 });
  await supervisor.stop(run.id, 'owner');
  assert.throws(() => supervisor.endpointBindings(run.id, 'owner'), hasCode('NOT_RUNNING'));
  assert.throws(() => supervisor.reportEndpoint(run.id, 'owner', { id: 'web', port: 1234 }), hasCode('NOT_RUNNING'));
  assert.throws(() => supervisor.unpublishEndpoint(run.id, 'owner', 'web'), hasCode('NOT_RUNNING'));
});

test('fixed listener requests remain explicit, runtime does not probe/reserve them, and reports must match', async (t) => {
  const occupied = await listen();
  const fixedPort = port(occupied);
  const supervisor = new ProgramSupervisor({ programs: { app: { command: idle, endpoints: { web: { port: fixedPort }, other: { port: 'dynamic' } }, urls: [
    { id: 'ui', title: 'UI', type: 'ui', endpoint: 'web' },
    { id: 'api', title: 'API', type: 'api', endpoint: 'other', path: '/api' },
  ] } }, stopTimeoutMs: 80 });
  t.after(async () => { await supervisor.dispose(); await close(occupied); });
  const run = await supervisor.start({ program: 'app', ownerId: 'owner' });
  assert.equal(run.endpoints![0]!.requestedPort, fixedPort, 'Supervisor starts without probing or reserving the occupied app port');
  assert.throws(() => supervisor.reportEndpoint(run.id, 'owner', { id: 'web', port: fixedPort === 65535 ? 65534 : fixedPort + 1 }), hasCode('INVALID_INPUT'));
  supervisor.reportEndpoint(run.id, 'owner', { id: 'web', port: fixedPort });
  assert.equal(supervisor.get(run.id).resources[0]!.available, true);
  assert.equal(supervisor.get(run.id).resources[1]!.available, false, 'Only recipes referencing reported endpoint become available');
  const restarted = await supervisor.restart(run.id, 'owner');
  assert.equal(restarted.endpoints![0]!.requestedPort, fixedPort);
  assert.equal(restarted.endpoints![0]!.port, undefined);
  assert.equal(restarted.resources[0]!.address, undefined);
});

test('SDK resource publication cannot replace or remove a configured recipe', async (t) => {
  const supervisor = new ProgramSupervisor({ programs: { app: { ...appDefinition(), command: undefined, entry: fixture('endpoint-resource-collision.mjs') } }, stopTimeoutMs: 80 });
  t.after(() => supervisor.dispose());
  const run = await supervisor.start({ program: 'app', ownerId: 'owner' });
  const ready = await until(() => supervisor.get(run.id), (snapshot) => snapshot.status !== undefined);
  assert.deepEqual(JSON.parse(ready.status!), ['FORBIDDEN', 'FORBIDDEN', 'INVALID_INPUT']);
  assert.equal(ready.resources[0]!.url, '');
  assert.equal(ready.resources[0]!.endpoint, 'web');
  assert.equal(ready.resources[0]!.available, false, 'SDK hello does not mark recipes ready');
  supervisor.reportEndpoint(run.id, 'owner', { id: 'web', port: 32002 });
  assert.equal(supervisor.get(run.id).resources[0]!.available, true);
  await supervisor.send(run.id, 'owner', 'complete');
  const done = await until(() => supervisor.get(run.id), (snapshot) => snapshot.state === 'completed');
  assert.equal(done.resources[0]!.address, undefined);
  assert.equal(done.endpoints![0]!.port, undefined);
  assert.equal(done.resources[0]!.available, false);
});

test('owner revocation clears all endpoint bindings and recipes before another generation is allowed', async (t) => {
  const supervisor = new ProgramSupervisor({ programs: { app: appDefinition() }, stopTimeoutMs: 80 });
  t.after(() => supervisor.dispose());
  const run = await supervisor.start({ program: 'app', ownerId: 'owner' });
  supervisor.reportEndpoint(run.id, 'owner', { id: 'web', port: 32003 });
  await supervisor.revokeOwner('owner');
  const revoked = supervisor.get(run.id);
  assert.equal(revoked.resources[0]!.address, undefined);
  assert.equal(revoked.resources[0]!.url, '');
  assert.equal(revoked.resources[0]!.available, false);
  assert.equal(revoked.endpoints![0]!.port, undefined);
  assert.throws(() => supervisor.reportEndpoint(run.id, 'owner', { id: 'web', port: 32004 }), hasCode('OWNER_REVOKED'));
  supervisor.allowOwner('owner');
  const next = await supervisor.restart(run.id, 'owner');
  assert.equal(next.endpoints![0]!.requestedPort, 0);
  assert.equal(next.endpoints![0]!.port, undefined);
  assert.equal(next.resources[0]!.available, false);
});
