import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context, Service } from '@deepseek-ai/cordis';
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools';
import { LlmRuntime } from '@deepseek-ai/dsh-llm';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as plugin from '../src/host/index.js';
import type { ProgramSnapshot } from '../src/types.js';

type Route = { path: string; fetch(request: Request): Promise<Response> };
const rpcRequest = (method: string, payload: unknown, extra: Record<string, unknown> = {}) => new Request(`http://localhost/api/programAgents/${method}`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ type: 'client-request', rpcId: 'integration-check', method: `programAgents/${method}`, payload, ...extra }),
});

test('real Cordis + DSH ToolRuntime enforce policy and exact routes do not replace Gateway', async () => {
  const root = new Context(); const directory = await mkdtemp(join(tmpdir(), 'program-dsh-real-'));
  const routes = new Map<string, Route>(); let calls = 0;
  const owner: any = { id: 'owner', steer: () => {}, inject: () => {}, ctx: root };
  class FakeAgents extends Service { constructor(c: Context) { super(c, 'agents'); } get(id: string) { return id === 'owner' ? owner : undefined; } withInitiator(_a: any, f: () => unknown) { return f(); } }
  class FakePrompt extends Service { constructor(c: Context) { super(c, 'systemPrompt'); } tools() {} }
  class Connection extends Service {
    constructor(c: Context) { super(c, 'connection'); }
    fetch = { register: (route: Route) => { routes.set(route.path, route); return async () => { routes.delete(route.path); }; } };
    rpc = { handle() { throw new Error('Dedicated channels are broken in rc.2'); }, intercept() { throw new Error('Gateway must retain its interceptor'); } };
  }
  const providers = [];
  providers.push(await root.plugin(FakePrompt), await root.plugin(FakeAgents), await root.plugin(LlmRuntime), await root.plugin(ToolRuntime), await root.plugin(Connection));
  const fork = await root.plugin(plugin, { auditDirectory: directory, programs: { example: { entry: resolve('examples/dashboard.ts'), tools: ['fixture_read'], allowedCapabilities: ['tools.call'] } } });
  try {
    assert.ok(fork); assert.ok(root.programAgents);
    assert.deepEqual([...routes.keys()], ['list', 'start', 'stop', 'restart', 'events'].map(method => `/api/programAgents/${method}`));
    root.tools.register(defineTool({ name: 'fixture_read', description: 'read fixture', parameters: {}, output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] }, execute: async () => { calls++; return 'ok'; } }));
    const adapter = root.programAgents.adapter; adapter['owners'].set('owner', owner);
    const run: ProgramSnapshot = { id: 'fixture', generation: 1, program: 'example', ownerId: 'owner', label: 'test', state: 'running', startedAt: new Date().toISOString(), logs: [], resources: [], messages: [] };
    const method = adapter.capabilities.get('tools.call')!;
    const controller = new AbortController(); await method.handler({ name: 'fixture_read', args: {} }, { run, signal: controller.signal }); assert.equal(calls, 1);
    const unguard = root.tools.guard(() => 'denied by integration guard');
    const denied = await method.handler({ name: 'fixture_read', args: {} }, { run, signal: controller.signal }) as any;
    assert.equal(denied.isError, true); assert.equal(calls, 1); unguard();
    const list = routes.get('/api/programAgents/list')!;
    const ownerReply = await (await list.fetch(rpcRequest('list', { sessionId: 'owner' }))).json(); assert.equal(ownerReply.result.ok, true);
    const malformed = await (await list.fetch(rpcRequest('list', { sessionId: 'owner', extra: true }))).json(); assert.equal(malformed.result.ok, false);
  } finally {
    await fork.dispose(); assert.equal(routes.size, 0);
    for (const provider of providers.reverse()) await provider.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

// Optional installed-carrier regression. Ordinary npm consumers need no host
// install; maintainers can select the actual running release without importing
// its credentials, launching its server, or modifying the installed package.
let connectionEntry = process.env.DSH_TEST_CONNECTION_ENTRY;
if (!connectionEntry) {
  try { connectionEntry = createRequire(import.meta.url).resolve('@deepseek-ai/dsh-client-connection'); } catch {}
}
test('installed Connection exact routes gate owners, preserve Gateway and dispose with plugin', { skip: !connectionEntry }, async () => {
  const { HostConnectionService } = await import(pathToFileURL(connectionEntry!).href);
  const root = new Context(); const directory = await mkdtemp(join(tmpdir(), 'program-installed-carrier-'));
  root.provide('tools', { register() { return () => {}; } });
  root.provide('agents', { get() { return undefined; } }); root.provide('llm', {});
  let connection: any;
  const provider = await root.plugin({ name: 'installed-connection-fixture', apply(ctx) {
    // No BrowserAuth.create(), credential access, webServer, or network listener.
    connection = new HostConnectionService(ctx, [], { isAuthenticated() { return false; }, authenticateApi() { return undefined; } });
  } });
  const fork = await root.plugin(plugin, { auditDirectory: directory, programs: {} });
  try {
    const shared = connection.createSharedFetchHandler('/api');
    let dispatched = 0; root.programAgents.supervisor.list = () => { dispatched++; return []; };
    const owner = connection.browserPeer;
    const agent = { principal: { kind: 'agent' } };
    assert.deepEqual(connection.admit({ headers: { host: 'localhost' } }), { rejection: 401 });
    const forbidden = await shared.fetch(rpcRequest('list', { sessionId: 'owner' }), agent);
    assert.equal(forbidden.status, 403); assert.equal(dispatched, 0, 'Non-owner must be rejected before plugin callback');
    const admitted = await shared.fetch(rpcRequest('list', { sessionId: 'owner' }), owner);
    assert.equal(admitted.status, 200);
    assert.deepEqual(await admitted.json(), { type: 'server-response', rpcId: 'integration-check', result: { ok: true, value: { runs: [], programs: [] } } });
    assert.equal(dispatched, 1);
    const eventRequest=()=>new Request('http://localhost/api/programAgents/events',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sessionId:'owner'})});
    assert.equal((await shared.fetch(eventRequest(),agent)).status,403);
    const pushed=await shared.fetch(eventRequest(),owner);assert.equal(pushed.headers.get('content-type'),'text/event-stream; charset=utf-8');const reader=pushed.body.getReader();assert.match(new TextDecoder().decode((await reader.read()).value),/event: snapshot/);await reader.cancel();
    assert.equal(dispatched,2);
    const mismatch = await shared.fetch(rpcRequest('list', { sessionId: 'owner' }, { method: 'programAgents/stop' }), owner);
    assert.equal((await mismatch.json()).result.ok, false); assert.equal(dispatched, 2);
    const malformed = await shared.fetch(rpcRequest('list', { sessionId: 'owner', extra: true }), owner);
    assert.equal((await malformed.json()).result.ok, false); assert.equal(dispatched, 2);

    let gatewayCalls = 0;
    const removeGateway = root.get('connection').rpc.intercept('/api', (endpoint: string) => endpoint === 'fixtureGateway/list', async () => { gatewayCalls++; return { ok: true, value: 'gateway-preserved' }; });
    const gatewayRequest = () => new Request('http://localhost/api/fixtureGateway/list', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'gateway-check', method: 'fixtureGateway/list', payload: {} }) });
    assert.equal((await (await shared.fetch(gatewayRequest(), owner)).json()).result.value, 'gateway-preserved');
    assert.equal(gatewayCalls, 1);
    await fork.dispose();
    assert.equal((await shared.fetch(rpcRequest('list', { sessionId: 'owner' }), owner)).status, 404);
    assert.equal(dispatched, 2);
    assert.equal((await (await shared.fetch(gatewayRequest(), owner)).json()).result.value, 'gateway-preserved');
    assert.equal(gatewayCalls, 2); await removeGateway();
  } finally {
    await fork.dispose(); await provider.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
