import assert from 'node:assert/strict';
import test from 'node:test';
import { createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm';
import { AssistantStreamAccumulator } from '@deepseek-ai/dsh-llm/assistant-stream';
import { LlmAttemptId, ToolCallId } from '@deepseek-ai/dsh-llm/brand';
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session';
import type { SessionFollowFrame } from '../src/conversations.js';
import { canonicalJson, consumeNativeSSE, initialSidebarState, prependHistory, reduceFrame, SIDEBAR_LIMITS, transcriptRows, type NativeEvent } from '../skills/program-agents/references/chat-sidebar/protocol.js';

type Snapshot = Extract<SessionFollowFrame, { type: 'snapshot' }>;
const snapshot = (overrides: Partial<Snapshot> = {}): Snapshot => ({ type: 'snapshot', header: { version: 4, id: SessionId('sidebar-session'), createdAt: 0, isSeeded: false }, cursor: -1, records: [], hasMore: false, projections: { asOfSeq: -1, values: {} }, assistantStream: { revision: 0 }, ...overrides });
const event = (seq: number, type: string, data: unknown, surfaceOp?: 'append'): Extract<SessionFollowFrame, { type: 'event' }> => ({ type: 'event', event: { seq, time: seq, type, data: data as NativeEvent['data'], ...(surfaceOp ? { surfaceOp } : {}) } });
const attemptId = LlmAttemptId('native-attempt');
const start = (revision = 1): SessionFollowFrame => ({ type: 'assistant-stream', frame: { type: 'start', revision, attemptId, startedAfterSeq: -1, turn: 1, step: 0 } });
const chunk = (revision: number, index: number, value: unknown): SessionFollowFrame => ({ type: 'assistant-stream', frame: { type: 'chunk', revision, attemptId, index, time: revision, chunk: value as NativeEvent['data'] } });
const assistant = (text: string) => createAssistantMessage({ content: [{ type: 'text', text }], source: { provider: 'fixture', model: 'fixture' } });

test('native user data is direct, assistant data.message, tool calls/status are visible; replacement copies are not', () => {
  const callId = ToolCallId('call-1');
  const user = createUserMessage({ content: [{ type: 'text', text: '<script>literal text</script>' }], source: { kind: 'user', rpcId: 'request-1' as never } });
  const answer = createAssistantMessage({ content: [{ type: 'reasoning', text: 'optional model output' }, { type: 'text', text: 'Answer' }, { type: 'tool-call', id: callId, name: 'lookup', arguments: '{"q":"x"}' }], source: { provider: 'fixture', model: 'fixture' } });
  const records = [event(0, 'user/message', user, 'append'), event(1, 'assistant/message', { turn: 1, step: 0, message: answer, stream: [] }, 'append'), event(2, 'tool/call', { turn: 1, step: 0, callId, name: 'lookup', arguments: '{"q":"x"}' }), event(3, 'tool/result', { turn: 1, step: 0, message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'Found it' }], isError: false }) }, 'append'), event(4, 'turn/end', { turn: 1, reason: { kind: 'completed' } }), { ...event(5, 'assistant/message', { turn: 1, step: 0, message: assistant('model-only copy'), stream: [] }), event: { ...event(5, 'assistant/message', {}).event, data: { message: assistant('model-only copy') } as unknown as NativeEvent['data'], surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 } } }];
  const state = reduceFrame(initialSidebarState(), snapshot({ cursor: 5, records }));
  const rows = transcriptRows(state);
  assert.deepEqual(rows.map(row => row.role), ['user', 'assistant', 'tool', 'status']);
  assert.equal(rows[0]?.messageId, user.id); assert.equal(rows[0]?.requestId, 'request-1');
  assert.equal(rows[1]?.blocks[0]?.type, 'reasoning');
  assert.equal(rows[2]?.blocks[0]?.type, 'text');
  assert.ok(JSON.stringify(rows).includes('<script>literal text</script>'));
  assert.equal(JSON.stringify(rows).includes('model-only copy'), false);
});

test('snapshot replaces the entire prior baseline and expands actual native compact stream records', () => {
  const accumulator = new AssistantStreamAccumulator();
  accumulator.push({ time: 10, chunk: { type: 'text-delta', index: 0, text: 'Hello ' } });
  accumulator.push({ time: 11, chunk: { type: 'text-delta', index: 0, text: 'world' } });
  accumulator.push({ time: 12, chunk: { type: 'reasoning-delta', index: 1, text: 'optional' } });
  assert.equal(accumulator.snapshot()[0]?.type, 'text-chunks');
  let state = reduceFrame(initialSidebarState(), snapshot({ cursor: 0, records: [event(0, 'assistant/message', { message: assistant('stale') }, 'append')] }));
  state = reduceFrame(state, snapshot({ cursor: 2, assistantStream: { revision: 7, activeAttempt: { attemptId, startedAfterSeq: SessionSeq(2), turn: 2, step: 0, nextIndex: 3, stream: accumulator.snapshot() as unknown as NativeEvent['data'][] } } }));
  assert.equal(state.records.length, 0); assert.equal(state.cursor, 2); assert.equal(state.streamRevision, 7);
  assert.deepEqual(state.active?.blocks, { 0: { type: 'text', text: 'Hello world' }, 1: { type: 'reasoning', text: 'optional' } });
});

test('live native deltas use text, block-end replaces, dense indices and revisions are enforced', () => {
  let state = reduceFrame(reduceFrame(initialSidebarState(), snapshot()), start());
  state = reduceFrame(state, chunk(2, 0, { type: 'text-delta', index: 0, text: 'prefix' }));
  state = reduceFrame(state, chunk(3, 1, { type: 'block-end', index: 0, block: { type: 'text', text: 'whole' } }));
  assert.equal(state.active?.blocks[0]?.type === 'text' && state.active.blocks[0].text, 'whole');
  assert.equal(reduceFrame(state, chunk(3, 1, { type: 'text-delta', index: 0, text: 'duplicate' })), state);
  assert.throws(() => reduceFrame(state, chunk(5, 2, { type: 'text-delta', index: 0, text: 'gap' })), /stream gap/);
  assert.throws(() => reduceFrame(state, chunk(4, 5, { type: 'text-delta', index: 0, text: 'gap' })), /chunk gap/);
  assert.throws(() => reduceFrame(state, event(1, 'turn/start', { turn: 1 })), /Durable stream gap/);
  assert.throws(() => reduceFrame(state, start(1)), /lifecycle reset/);
});

test('end outcome.seq retires exactly the live attempt after durable settlement, without duplicate assistant text', () => {
  let state = reduceFrame(reduceFrame(initialSidebarState(), snapshot()), start());
  state = reduceFrame(state, chunk(2, 0, { type: 'text-delta', index: 0, text: 'Transient' }));
  state = reduceFrame(state, event(0, 'assistant/message', { turn: 1, step: 0, message: assistant('Durable'), stream: [] }, 'append'));
  assert.equal(transcriptRows(state).length, 1); assert.equal(transcriptRows(state)[0]?.transient, true);
  state = reduceFrame(state, { type: 'assistant-stream', frame: { type: 'end', revision: 3, attemptId, index: 1, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 0 } } });
  assert.equal(state.active, undefined); assert.equal(transcriptRows(state).length, 1); assert.equal(transcriptRows(state)[0]?.transient, undefined);
  assert.deepEqual(transcriptRows(state)[0]?.blocks, [{ type: 'text', text: 'Durable' }]);
});

test('abandonment clears transient output; missing durable settlement requires a fresh baseline', () => {
  const state = reduceFrame(reduceFrame(initialSidebarState(), snapshot()), start());
  const end = { type: 'assistant-stream', frame: { type: 'end', revision: 2, attemptId, index: 0, outcome: { kind: 'abandoned' } } } as const;
  assert.equal(reduceFrame(state, end).active, undefined);
  assert.throws(() => reduceFrame(state, { ...end, frame: { ...end.frame, outcome: { kind: 'committed', eventType: 'assistant/attempt', seq: 0 } } }), /Missing native attempt settlement/);
});

test('history pagination uses fixed snapshot cut; reconnect discards stale in-flight pages', () => {
  let state = reduceFrame(initialSidebarState(), snapshot({ cursor: 2, records: [event(2, 'turn/end', { turn: 1, reason: { kind: 'completed' } })], hasMore: true }));
  state = reduceFrame(state, event(3, 'turn/start', { turn: 2 }));
  const page = { records: [event(0, 'turn/start', { turn: 1 }), event(1, 'step/start', { turn: 1, step: 0 })], hasMore: false };
  state = prependHistory(state, page, 2);
  assert.equal(state.throughSeq, 2); assert.equal(state.cursor, 3); assert.deepEqual(state.records.map(event => event.seq), [0, 1, 2, 3]);
  const reconnected = reduceFrame(state, snapshot({ cursor: 4 }));
  assert.equal(prependHistory(reconnected, page, 2), reconnected);
});

test('canonical JSON is browser-pure deterministic data, not insertion order or non-JSON', () => {
  assert.equal(canonicalJson({ z: 1, a: { y: 2, b: 3 } }), canonicalJson({ a: { b: 3, y: 2 }, z: 1 }));
  for (const value of [NaN, Infinity, undefined, new Date(), { a: undefined }]) assert.throws(() => canonicalJson(value));
});

test('fetch SSE accepts fragmented native JSON/UTF8/CRLF; ignores unknown events and incomplete terminal data', async () => {
  const bytes = new TextEncoder().encode(': heartbeat\r\n\r\nevent: other\r\ndata: nope\r\n\r\nevent: native\r\ndata: ' + JSON.stringify(snapshot({ records: [event(0, 'notice', { text: '☃' })] })) + '\r\n\r\nevent: native\ndata: {"type":"snapshot"');
  const response = new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
  const frames: SessionFollowFrame[] = [];
  await consumeNativeSSE(response, frame => frames.push(frame), new AbortController().signal);
  assert.equal(frames.length, 1); assert.equal(frames[0]?.type, 'snapshot');
});

test('fetch SSE abort cancels the browser reader, and frame buffers are bounded', async () => {
  let cancelled = false;
  const abort = new AbortController();
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } });
  const task = consumeNativeSSE(response, () => assert.fail(), abort.signal); abort.abort();
  await assert.rejects(task, /cancelled/); assert.equal(cancelled, true);
  const large = new Response('event: native\ndata: ' + 'x'.repeat(SIDEBAR_LIMITS.frameBytes + 129), { headers: { 'content-type': 'text/event-stream' } });
  await assert.rejects(consumeNativeSSE(large, () => assert.fail(), new AbortController().signal), /exceeds limit/);
});
