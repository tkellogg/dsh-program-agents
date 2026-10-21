import test from 'node:test';
import assert from 'node:assert/strict';
import { createProgramModels, type ModelBridgeCall } from '../src/app/models.js';
import type { JsonValue } from '../src/types.js';

const selection = { provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'xhigh' };
const declarations = { 'smart-model': { description: 'Complex reasoning.', default: selection } };

test('app model facade declares and resolves named slots without inference or mutation APIs', async () => {
  const calls: Array<{ method: string; input?: JsonValue; options?: unknown }> = [];
  const call: ModelBridgeCall = async <T>(method: string, input?: JsonValue, options?: unknown) => {
    calls.push({ method, input, options });
    return (method === 'models.resolve' ? selection : []) as T;
  };
  const models = createProgramModels(call), signal = new AbortController().signal;
  const options = { signal, timeoutMs: 123 };
  await models.declare(declarations, options);
  await models.list(options);
  assert.deepEqual(await models.resolve('smart-model', options), selection);
  assert.deepEqual(await models.get('smart-model', options), selection);
  assert.deepEqual(calls.map(item => item.method), ['models.declare', 'models.list', 'models.resolve', 'models.resolve']);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].input)), { slots: declarations });
  assert.deepEqual(calls[1].input, {});
  assert.deepEqual(calls[2].input, { slot: 'smart-model' });
  for (const item of calls) assert.equal(item.options, options);
  assert.equal('set' in models, false);
  assert.equal('reset' in models, false);
  assert.equal('setOverride' in models, false);
  assert.equal(models.get, models.resolve);
});

test('slot calls and preexisting explicit provider/model calls are each one unchanged bridge call', async () => {
  const calls: Array<{ method: string; input?: JsonValue }> = [];
  const call: ModelBridgeCall = async <T>(method: string, input?: JsonValue) => {
    calls.push({ method, input });
    return { blocks: [{ type: 'text', text: 'fixture' }] } as T;
  };
  const models = createProgramModels(call);
  const bySlot = { slot: 'smart-model', prompt: 'Classify this.', maxTokens: 20 };
  const explicit = { ...selection, prompt: 'Think about this.', system: 'Be concise.' };
  const legacy: JsonValue = { provider: 'another', model: 'opaque/model', prompt: 'Explicit route.' };
  await models.call(bySlot); await models.call(explicit); await models.call(legacy);
  assert.deepEqual(calls.map(item => item.method), ['models.call', 'models.call', 'models.call']);
  assert.equal(calls[0].input, bySlot);
  assert.equal(calls[1].input, explicit);
  assert.equal(calls[2].input, legacy);
});

test('local input validation sends no bridge request for invalid declarations or ids', async () => {
  let count = 0;
  const call: ModelBridgeCall = async <T>() => { count++; return null as T; };
  const models = createProgramModels(call);
  assert.throws(() => models.declare({ slot: { description: '', default: selection } }), /description/);
  assert.throws(() => models.resolve('invalid slot'), /slot id/);
  assert.equal(count, 0);
});
