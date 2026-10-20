import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import test from 'node:test';
import { createProgramClient, type RpcTransport } from '../src/client/transport.js';

// Optional read-only compatibility check against an installed DSH bundle. It
// executes in an isolated VM with a fake carrier; no live DSH routes or secrets.
const installedBundle = process.env.DSH_CLIENT_CONNECTION_BUNDLE;
test('installed DSH Connection browser carrier accepts dedicated program channel and direct named args', { skip: !installedBundle }, async () => {
  let factory: ((require: (name: string) => never) => { installConnection(ctx: unknown, options: unknown): void }) | undefined;
  const source = await readFile(installedBundle!, 'utf8');
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load(module: { id: string; factory: typeof factory }) {
      assert.equal(module.id, '@deepseek-ai/dsh-client-connection'); factory = module.factory;
    } } },
    crypto: webcrypto, AbortController, URL, Headers, setTimeout, clearTimeout, console,
  }, { filename: 'installed-dsh-client-connection.js' });
  assert.ok(factory);
  const connectionModule = factory(name => { throw new Error(`Unexpected external ${name}`); });
  let rpc: RpcTransport | undefined;
  const requests: Array<{ path: string; envelope: { type: string; rpcId: string; method: string; payload: unknown } }> = [];
  connectionModule.installConnection({ provide(name: string, handle: { rpc: RpcTransport }) { assert.equal(name, 'connection'); rpc = handle.rpc; } }, {
    transport: { async fetch(path: string, init: RequestInit) {
      assert.equal(init.method, 'POST');
      const envelope = JSON.parse(init.body as string);
      requests.push({ path, envelope });
      return new Response(JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value: envelope.method === 'list' ? { runs: [] } : undefined } }), { headers: { 'content-type': 'application/json' } });
    } },
  });
  const client = createProgramClient(rpc!, 'session-live');
  assert.deepEqual(await client.list(new AbortController().signal), { runs: [], truncated: false });
  assert.equal(requests[0]?.path, 'program-agents/list');
  assert.equal(requests[0]?.envelope.type, 'client-request');
  assert.equal(requests[0]?.envelope.method, 'list');
  assert.deepEqual(requests[0]?.envelope.payload, { sessionId: 'session-live' });
});
