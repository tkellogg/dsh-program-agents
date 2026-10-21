import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ConversationService, type ConversationDependencies } from '../src/host/conversations.js';
import { createProgramConversations } from '../src/app/conversations.js';
import type { JsonValue } from '../src/types.js';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'program-conversations-'));
  const handlers = new Map<string, Set<(...args: any[]) => void>>();
  const children: Array<{ id: string; mode: string }> = [];
  const operations: any[] = [], followers = new Set<{ child: string; push: (value: any) => void }>();
  let creates = 0, live = true, initiators = 0, closedFollowers = 0;
  const scope = { ownerId: 'owner', program: 'app' };
  const emit = (name: string, payload: unknown) => { for (const handler of handlers.get(name) ?? []) handler(payload); };
  const publish = (child: string, event: any) => { for (const follower of followers) if (follower.child === child) follower.push({ type: 'event', event }); };
  const controller = {
    page: async (request: any) => { operations.push({ kind: 'page', request }); return { records: [], hasMore: false }; },
    follow: async function* (request: any, signal: AbortSignal) {
      const queue: any[] = []; let wake: (() => void) | undefined;
      const follower = { child: request.address.childSessionId, push: (value: any) => { queue.push(value); wake?.(); } };
      followers.add(follower); operations.push({ kind: 'follow', request });
      const abort = () => wake?.(); signal.addEventListener('abort', abort, { once: true });
      try {
        yield { type: 'snapshot', header: { version: 4, id: follower.child, createdAt: 0, isSeeded: false, parentSession: 'owner', origin: 'subagent' }, cursor: -1, records: [], hasMore: false, projections: { asOfSeq: -1, values: {} }, assistantStream: { revision: 0 } } as any;
        while (!signal.aborted) { if (queue.length) yield queue.shift(); else await new Promise<void>(r => { wake = r; }); }
      } finally { signal.removeEventListener('abort', abort); followers.delete(follower); closedFollowers++; }
    },
  };
  const subagents = {
    listChildren: async () => children,
    prompt: async (request: any) => {
      operations.push({ kind: 'prompt', request });
      const messageId = 'message-' + operations.filter(o => o.kind === 'prompt').length;
      // The claim races prompt receipt and can precede a user/message or any step.
      emit('agent/inbox/claimed', { agent: { id: request.childSessionId }, message: { id: messageId, source: { kind: 'user', rpcId: request.requestId } }, turn: 7 });
      publish(request.childSessionId, { type: 'turn/start', seq: 0, time: 1, data: { turn: 6 } });
      publish(request.childSessionId, { type: 'turn/end', seq: 1, time: 2, data: { turn: 6, reason: { kind: 'completed' } } });
      publish(request.childSessionId, { type: 'turn/start', seq: 2, time: 3, data: { turn: 7 } });
      publish(request.childSessionId, { type: 'turn/end', seq: 3, time: 4, data: { turn: 7, reason: { kind: 'blocked' } } });
      return { messageId };
    },
    interrupt: (child: string, authority: unknown) => operations.push({ kind: 'interrupt', child, authority }),
  };
  const parent: any = { id: 'owner', ctx: {
    get: (name: string) => name === 'sessionController' ? controller : name === 'subagents' ? subagents : name === 'tools' ? { get: () => ({ parameters: { properties: { provider: {}, model: {}, reasoning_effort: {} } } }) } : undefined,
    on: (name: string, handler: (...args: any[]) => void, options: any) => {
      assert.equal(options.global, true); if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name)!.add(handler);
      return () => { handlers.get(name)!.delete(handler); };
    },
  } };
  const deps: ConversationDependencies = {
    parent: () => parent, isLive: agent => agent === parent && live,
    withInitiator: (agent, operation) => { assert.equal(agent, parent); initiators++; return operation(); },
    execute: async (agent, name, args: any) => { assert.equal(agent, parent); assert.equal(name, 'subagent'); const id = 'child-' + ++creates; children.push({ id, mode: 'continuable' }); operations.push({ kind: 'create', args }); return { subagentId: id }; },
    resolveModel: async (_scope, requested) => typeof requested === 'string' ? { provider: 'configured', model: requested } : requested,
  };
  let host = new ConversationService(directory, deps);
  const signal = new AbortController().signal;
  const call: any = (method: string, input: JsonValue = null, options: any = {}) => host.call(scope, method, input, options.signal ?? signal);
  const stream: any = (method: string, input: JsonValue = null, options: any = {}) => host.stream(scope, method, input, options.signal ?? signal);
  const client = createProgramConversations(call, stream);
  return { directory, client, scope, parent, operations, children, handlers, followers, controller, subagents, deps, signal,
    host: () => host, creates: () => creates, initiators: () => initiators, closedFollowers: () => closedFollowers,
    setLive: (value: boolean) => { live = value; },
    reopen: () => { host.dispose(); host = new ConversationService(directory, deps); },
    cleanup: async () => { host.dispose(); const target = resolve(directory); assert.ok(target.startsWith(resolve(tmpdir()) + '/program-conversations-')); await rm(target, { recursive: true, force: true }); },
  };
}

test('conversation open uses public subagent tool, stores program-private binding, and restores same identity', async () => {
  const f = await fixture(); try {
    const first = await f.client.open({ name: 'Chat', instructions: 'Help with inventory', model: 'chat' });
    assert.equal(first.id, 'child-1'); assert.deepEqual(first.model, { provider: 'configured', model: 'chat' });
    assert.deepEqual(f.operations[0].args.provider, 'configured'); assert.equal(f.operations[0].args.model, 'chat');
    assert.equal((await f.client.open({ name: 'Chat', instructions: 'Help with inventory', model: 'chat' })).id, first.id);
    assert.equal(f.creates(), 1);
    assert.deepEqual(await f.host().call({ ownerId: 'owner', program: 'other' }, 'conversations.get', { id: first.id }, f.signal), null);
    await assert.rejects(() => f.host().call({ ownerId: 'owner', program: 'other' }, 'conversations.history', { id: first.id, throughSeq: -1 }, f.signal), /bound/);
    await assert.rejects(() => f.client.open({ name: 'Chat', instructions: 'Help with inventory', model: 'different' }), (e: any) => e.code === 'MODEL_IMMUTABLE');
    await assert.rejects(() => f.client.open({ name: 'Chat', instructions: 'Changed', model: 'chat' }), /instructions/);
    f.reopen(); assert.equal((await f.client.get(first.id))?.id, first.id); assert.equal(f.creates(), 1);
    assert.equal((await f.client.list()).length, 1); assert.ok(f.initiators() > 0);
    assert.equal((await stat(join(f.directory, 'conversations.sqlite'))).mode & 0o777, 0o600);
  } finally { await f.cleanup(); }
});

test('ask subscribes before send and follows only its own claim-correlated turn, including pre-step rejection', async () => {
  const f = await fixture(); try {
    const chat = await f.client.open({ name: 'Chat' });
    const frames: any[] = [];
    for await (const frame of chat.ask({ text: 'Review', context: { revision: 5, state: { inventory: 3 } } }, { requestId: 'review-1' })) frames.push(frame);
    assert.deepEqual(frames.map(frame => frame.type), ['snapshot', 'receipt', 'event', 'event', 'event', 'event']);
    assert.equal(frames.at(-1).event.data.turn, 7);
    assert.equal(frames.at(-1).event.data.reason.kind, 'blocked');
    assert.deepEqual(frames[1], { type: 'receipt', requestId: 'review-1', messageId: 'message-1' });
    const order = f.operations.map(operation => operation.kind); assert.ok(order.indexOf('follow') < order.indexOf('prompt'));
    assert.equal(f.operations.find(operation => operation.kind === 'prompt').request.delivery, 'queue');
    assert.match(f.operations.find(operation => operation.kind === 'prompt').request.content[1].text, /untrusted/);
    assert.equal(f.followers.size, 0); assert.equal(f.handlers.get('agent/inbox/claimed')!.size, 0);
  } finally { await f.cleanup(); }
});

test('history uses native page at exact cut and send/interrupt retain normal DSH semantics', async () => {
  const f = await fixture(); try {
    const chat = await f.client.open({ name: 'Chat' });
    await chat.history({ throughSeq: 12, beforeSeq: 5, maxMessages: 3 });
    const page = f.operations.find(operation => operation.kind === 'page');
    assert.deepEqual(page.request, { address: { kind: 'subagent', parentSessionId: 'owner', childSessionId: chat.id, mode: 'continuable' }, throughSeq: 12, beforeSeq: 5, maxMessages: 3 });
    await chat.send({ text: 'Steer' }, { mode: 'steer', requestId: 'steer' });
    assert.equal(f.operations.find(operation => operation.kind === 'prompt').request.delivery, 'steer');
    await chat.interrupt(); const interrupt = f.operations.find(operation => operation.kind === 'interrupt');
    assert.equal(interrupt.authority.agent, f.parent); assert.equal(interrupt.authority.kind, 'ancestor');
    await assert.rejects(() => chat.history({ throughSeq: -2 }), /throughSeq/);
    await assert.rejects(() => chat.history({ throughSeq: 1, maxMessages: 101 }), /maxMessages/);
  } finally { await f.cleanup(); }
});

test('stream return and cancellation unsubscribe native follower; no accepted prompt is interrupted implicitly', async () => {
  const f = await fixture(); try {
    const chat = await f.client.open({ name: 'Chat' });
    const abort = new AbortController(); const iterator = chat.events({ signal: abort.signal })[Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value.type, 'snapshot');
    const next = iterator.next(); abort.abort(); await next; await iterator.return?.();
    assert.equal(f.followers.size, 0); assert.equal(f.closedFollowers(), 1);
    assert.equal(f.operations.some(operation => operation.kind === 'interrupt'), false);
    const second = chat.events()[Symbol.asyncIterator](); await second.next(); await second.return?.(); assert.equal(f.followers.size, 0);
  } finally { await f.cleanup(); }
});

test('bounds reject oversized frames and stale parent authority without leaking followers', async () => {
  const f = await fixture(); try {
    const chat = await f.client.open({ name: 'Chat' });
    f.controller.follow = async function* () { yield { type: 'snapshot', records: [{ data: 'x'.repeat(513 * 1024) }] } as any; };
    await assert.rejects(async () => { for await (const _ of chat.events()) {} }, (e: any) => e.code === 'LIMIT');
    f.setLive(false); await assert.rejects(() => chat.send({ text: 'No' }), /live parent/);
    assert.equal(f.followers.size, 0);
  } finally { await f.cleanup(); }
});

test('invalid request identities and oversized context never send, and failed snapshot does not admit ask', async () => {
  const f = await fixture(); try {
    const chat = await f.client.open({ name: 'Chat' });
    await assert.rejects(() => chat.send({ text: 'No', context: { state: 'x'.repeat(17 * 1024) } }), (e: any) => e.code === 'LIMIT');
    for (let i = 0; i < 5; i++) await assert.rejects(async () => { for await (const _ of f.host().stream(f.scope, 'conversations.ask', { id: chat.id, message: { text: 'No' }, requestId: '' }, f.signal)) {} }, /requestId/);
    f.controller.follow = async function* () { yield { type: 'snapshot', records: [{ data: 'x'.repeat(513 * 1024) }] } as any; };
    await assert.rejects(async () => { for await (const _ of chat.ask({ text: 'Must not send' })) {} }, (e: any) => e.code === 'LIMIT');
    assert.equal(f.operations.some(operation => operation.kind === 'prompt'), false);
    assert.equal(f.handlers.get('agent/inbox/claimed')?.size ?? 0, 0);
    assert.equal(f.handlers.get('agent/inbox/discarded')?.size ?? 0, 0);
  } finally { await f.cleanup(); }
});

test('accepted but discarded prompt fails explicitly instead of hanging or claiming another turn', async () => {
  const f = await fixture(); try {
    const chat = await f.client.open({ name: 'Chat' });
    f.subagents.prompt = async (request: any) => {
      for (const handler of f.handlers.get('agent/inbox/discarded') ?? []) handler({ agent: { id: request.childSessionId }, message: { id: 'discarded-1', source: { kind: 'user', rpcId: request.requestId } } });
      return { messageId: 'discarded-1' };
    };
    await assert.rejects(async () => { for await (const _ of chat.ask({ text: 'Work' })) {} }, (e: any) => e.code === 'PROMPT_DISCARDED');
    assert.equal(f.followers.size, 0);
  } finally { await f.cleanup(); }
});

test('unsupported native subagent model selection fails before reserving or creating', async () => {
  const f = await fixture(); try {
    const get = f.parent.ctx.get;
    f.parent.ctx.get = (name: string) => name === 'tools' ? { get: () => ({ parameters: { properties: { description: {}, prompt: {} } } }) } : get(name);
    await assert.rejects(() => f.client.open({ name: 'Selectable', model: 'chat' }), (e: any) => e.code === 'MODEL_SELECTION_UNAVAILABLE');
    assert.equal(f.creates(), 0);
    // Native policy refusal is known pre-dispatch, so the same name can inherit instead.
    assert.equal((await f.client.open({ name: 'Selectable' })).id, 'child-1');
  } finally { await f.cleanup(); }
});

test('unknown native create is reserved durably and never automatically repeated', async () => {
  const f = await fixture(); try {
    f.deps.execute = async () => { throw Error('transport lost after possible acceptance'); };
    await assert.rejects(() => f.client.open({ name: 'Unknown' }), /transport lost/);
    f.reopen(); await assert.rejects(() => f.client.open({ name: 'Unknown' }), (e: any) => e.code === 'DISPATCH_UNKNOWN');
    assert.equal(f.creates(), 0);
  } finally { await f.cleanup(); }
});
