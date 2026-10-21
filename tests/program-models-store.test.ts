import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProgramModelStore } from '../src/host/models.js';
import { parseModelSelection, parseModelsDeclaration, modelSelectionsEqual } from '../src/models.js';

const scope = { ownerId: 'parent-a', program: 'program-a' };
const smart = { provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'xhigh' };
const cheap = { provider: 'local-mlx', model: 'Qwen3.8-27B-4bit' };
const slots = () => ({
  'smart-model': { description: 'Complex reasoning and implementation.', default: { ...smart } },
  'cheap-local': { description: 'Fast local classification and routine text.', default: { ...cheap } },
});
const code = (name: string) => (error: unknown) => error instanceof Error && 'code' in error && error.code === name;

test('named declarations retain defaults, descriptions and detached exact model routes', () => {
  const store = new ProgramModelStore(':memory:');
  try {
    const input = slots();
    const views = store.declare(scope, input);
    assert.deepEqual(views.map(view => view.id), ['cheap-local', 'smart-model']);
    assert.deepEqual(store.resolve(scope, 'smart-model'), smart);
    assert.equal(store.get(scope, 'smart-model').revision, 1);
    assert.equal(store.get(scope, 'smart-model').overridden, false);
    input['smart-model'].default.model = 'caller-mutated';
    views[1].selection.model = 'view-mutated';
    views[1].default.provider = 'view-mutated';
    assert.deepEqual(store.resolve(scope, 'smart-model'), smart);
    assert.equal(store.declare(scope, slots())[1].revision, 1, 'identical declarations are idempotent');
  } finally { store.close(); }
});

test('overrides are human-owned, revision-fenced and survive declaration edits and removal', () => {
  const store = new ProgramModelStore(':memory:');
  try {
    store.declare(scope, slots());
    const first = store.set(scope, 'smart-model', cheap, 1);
    assert.equal(first.revision, 2);
    assert.equal(first.overridden, true);
    assert.deepEqual(first.selection, cheap);
    assert.equal(store.set(scope, 'smart-model', cheap, 2).revision, 2, 'same override is a no-op');
    assert.throws(() => store.set(scope, 'smart-model', cheap, 1), code('CONFLICT'));
    const next = slots(); next['smart-model'].default.model = 'future-smart';
    next['smart-model'].description = 'A revised purpose.';
    const edited = store.declare(scope, next).find(view => view.id === 'smart-model')!;
    assert.equal(edited.revision, 3);
    assert.deepEqual(edited.selection, cheap);
    assert.equal(edited.default.model, 'future-smart');
    store.declare(scope, { 'cheap-local': slots()['cheap-local'] });
    assert.throws(() => store.resolve(scope, 'smart-model'), code('NOT_FOUND'));
    assert.equal(store.list(scope).length, 1);
    const restored = store.declare(scope, slots()).find(view => view.id === 'smart-model')!;
    assert.equal(restored.revision, 5);
    assert.deepEqual(restored.selection, cheap);
    const reset = store.reset(scope, 'smart-model', 5);
    assert.equal(reset.revision, 6);
    assert.equal(reset.overridden, false);
    assert.deepEqual(reset.selection, smart);
    assert.equal(store.reset(scope, 'smart-model', 6).revision, 6);
  } finally { store.close(); }
});

test('owner and opaque program scopes cannot read or write each other', () => {
  const store = new ProgramModelStore(':memory:');
  try {
    const otherOwner = { ...scope, ownerId: 'parent-b' };
    const otherProgram = { ...scope, program: 'program-b' };
    store.declare(scope, slots());
    assert.deepEqual(store.list(otherOwner), []);
    assert.deepEqual(store.list(otherProgram), []);
    assert.throws(() => store.set(otherOwner, 'smart-model', cheap, 1), code('NOT_FOUND'));
    assert.throws(() => store.get(otherProgram, 'smart-model'), code('NOT_FOUND'));
    store.declare(otherOwner, slots());
    store.set(scope, 'smart-model', cheap, 1);
    assert.deepEqual(store.resolve(otherOwner, 'smart-model'), smart);
    assert.throws(() => store.list({ ownerId: '', program: 'x' }), code('INVALID_INPUT'));
    assert.throws(() => store.get(scope, 'smart-model\u0000'), /slot id/);
  } finally { store.close(); }
});

test('private SQLite preferences survive new store instances and concurrent writers conflict', () => {
  const directory = mkdtempSync(join(tmpdir(), 'program-models-'));
  const path = join(directory, 'models.sqlite');
  let first: ProgramModelStore | undefined, second: ProgramModelStore | undefined;
  try {
    first = new ProgramModelStore(path); first.declare(scope, slots());
    second = new ProgramModelStore(path);
    first.set(scope, 'smart-model', cheap, 1);
    assert.throws(() => second!.set(scope, 'smart-model', smart, 1), code('CONFLICT'));
    second.close(); second = undefined;
    first.close(); first = undefined;
    second = new ProgramModelStore(path);
    assert.deepEqual(second.resolve(scope, 'smart-model'), cheap);
    assert.equal(second.get(scope, 'smart-model').revision, 2);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    second.declare(scope, { 'cheap-local': slots()['cheap-local'] });
    second.close(); second = new ProgramModelStore(path);
    assert.throws(() => second!.get(scope, 'smart-model'), code('NOT_FOUND'), 'removed slots stay hidden after restart');
    const restored = second.declare(scope, slots()).find(view => view.id === 'smart-model')!;
    assert.equal(restored.revision, 4, 'tombstone revisions survive restart and prevent stale revision reuse');
    assert.equal(restored.overridden, true);
    assert.deepEqual(restored.selection, cheap, 'removed/redeclared slot retains its durable user preference');
    assert.throws(() => second!.reset(scope, 'smart-model', 2), code('CONFLICT'));
    second.close(); assert.throws(() => second!.list(scope), code('CLOSED'));
    second.close();
  } finally {
    first?.close(); second?.close();
    // The test owns this exact path returned by mkdtempSync above.
    assert.equal(directory.startsWith(join(tmpdir(), 'program-models-')), true);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('limits and malformed snapshots fail atomically without removing prior declarations', () => {
  const store = new ProgramModelStore(':memory:', { maxRows: 2 });
  try {
    store.declare(scope, slots());
    const tooMany = Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`slot-${index}`, slots()['smart-model']]));
    assert.throws(() => store.declare(scope, tooMany), /32 model slots/);
    assert.throws(() => store.declare(scope, { extra: slots()['smart-model'] }), code('BACKPRESSURE'));
    assert.equal(store.list(scope).length, 2);
    assert.throws(() => store.set(scope, 'smart-model', { ...smart, reasoningEffort: '' }, 1), /reasoning effort/);
    assert.throws(() => store.set(scope, 'smart-model', cheap, 0), code('INVALID_INPUT'));
    assert.throws(() => store.declare(scope, { bad: { description: '', default: smart } }), /description/);
    assert.equal(store.get(scope, 'smart-model').revision, 1);
  } finally { store.close(); }
});

test('snapshot byte cap prevents successful writes from becoming unreadable on the app bridge', () => {
  const store = new ProgramModelStore(':memory:');
  try {
    store.declare(scope, slots());
    const huge = Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`large-${index}`, {
      description: 'x'.repeat(700), default: { provider: 'p'.repeat(250), model: 'm'.repeat(250) },
    }]));
    assert.throws(() => store.declare(scope, huge), /snapshot exceeds/);
    assert.equal(store.list(scope).length, 2, 'failed transaction restores the prior snapshot');
  } finally { store.close(); }
});

test('browser-safe validators reject malformed fields without normalizing opaque ids', () => {
  assert.deepEqual(parseModelSelection({ provider: 'vendor', model: 'org/name:tag' }), { provider: 'vendor', model: 'org/name:tag' });
  assert.throws(() => parseModelSelection({ ...smart, token: 'not-allowed' }), /Unknown/);
  assert.throws(() => parseModelSelection({ ...smart, provider: 'bad\nprovider' }), /provider/);
  assert.throws(() => parseModelsDeclaration({ 'invalid slot': slots()['smart-model'] }), /slot id/);
  assert.throws(() => parseModelsDeclaration({ valid: { ...slots()['smart-model'], selection: cheap } }), /Unknown/);
  assert.equal(modelSelectionsEqual(smart, { ...smart }), true);
  assert.equal(modelSelectionsEqual(smart, { ...smart, reasoningEffort: 'high' }), false);
  assert.equal(modelSelectionsEqual(undefined, undefined), true);
  assert.equal(modelSelectionsEqual(undefined, cheap), false);
});
