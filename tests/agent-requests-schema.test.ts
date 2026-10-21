import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createResponseValidator, type ResponseSchema } from '../src/requests.js';
import { ProgramError } from '../src/runtime/protocol.js';
const code = (expected: string) => (error: unknown): boolean => error instanceof ProgramError && error.code === expected;

test('response schema defaults to plain string and supports boolean schemas', () => {
  createResponseValidator()('hello');
  assert.throws(() => createResponseValidator()(42), code('INVALID_RESPONSE'));
  createResponseValidator(true)({ arbitrary: [null, true, 1] });
  assert.throws(() => createResponseValidator(false)('no'), code('INVALID_RESPONSE'));
  assert.throws(() => createResponseValidator(null as never), code('INVALID_SCHEMA'));
  assert.throws(() => createResponseValidator([] as never), code('INVALID_SCHEMA'));
});

test('Draft 2020-12 local refs, composition, conditional and unevaluated properties are real JSON Schema', () => {
  const schema: ResponseSchema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $defs: { positive: { type: 'integer', exclusiveMinimum: 0 } },
    type: 'object',
    properties: { kind: { enum: ['small', 'large'] }, count: { $ref: '#/$defs/positive' } },
    required: ['kind', 'count'],
    if: { properties: { kind: { const: 'small' } } },
    then: { properties: { count: { type: 'integer', maximum: 3 } } },
    else: { properties: { count: { type: 'integer', minimum: 4 } } },
    unevaluatedProperties: false,
  };
  const validate = createResponseValidator(schema);
  validate({ kind: 'small', count: 2 }); validate({ kind: 'large', count: 5 });
  assert.throws(() => validate({ kind: 'small', count: 4 }), code('INVALID_RESPONSE'));
  assert.throws(() => validate({ kind: 'large', count: 2 }), code('INVALID_RESPONSE'));
  assert.throws(() => validate({ kind: 'large', count: 5, extra: true }), code('INVALID_RESPONSE'));
  assert.throws(() => validate({ kind: 'small', count: 0 }), code('INVALID_RESPONSE'));
  const tuple = createResponseValidator({ type: 'array', prefixItems: [{ type: 'integer' }, { type: 'string' }], minItems: 2, maxItems: 2, items: false });
  tuple([1, 'two']);
  assert.throws(() => tuple(['one', 2]), code('INVALID_RESPONSE'));
});

test('schema validation is strict, local-only, synchronous and does not guess formats', () => {
  for (const schema of [
    { type: 'madeup' }, { type: 'string', misspelledKeyword: true },
    { type: 'string', format: 'email' }, { type: 'string', format: 'some-unknown-format' },
    { $ref: 'https://example.com/schema' }, { $ref: 'other.json#/$defs/foo' },
    { $dynamicRef: 'https://example.com/schema#foo' }, { $async: true, type: 'string' },
    { type: 'object', properties: { a: { $ref: 'https://example.com/schema' } } },
    { type: 'object', $defs: { remote: { $ref: 'remote.json' } } },
    { $ref: '#/$defs/missing' },
  ]) assert.throws(() => createResponseValidator(schema as ResponseSchema), code('INVALID_SCHEMA'));
  // Literal data containing a '$ref' is not a reference keyword.
  createResponseValidator({ const: { $ref: 'https://example.com/literal' } })({ $ref: 'https://example.com/literal' });
});

test('validation never coerces, inserts defaults, or removes additional properties', () => {
  const validate = createResponseValidator({ type: 'object', properties: { count: { type: 'integer', default: 3 } }, additionalProperties: false });
  const empty = {};
  validate(empty);
  assert.deepEqual(empty, {});
  const wrong = { count: '3' };
  assert.throws(() => validate(wrong), code('INVALID_RESPONSE'));
  assert.deepEqual(wrong, { count: '3' });
  const extra = { count: 3, extra: true };
  assert.throws(() => validate(extra), code('INVALID_RESPONSE'));
  assert.deepEqual(extra, { count: 3, extra: true });
});

test('schema/response byte and complexity errors are safe bounded ProgramErrors', () => {
  assert.throws(() => createResponseValidator({ description: 'x'.repeat(16 * 1024) }), code('INVALID_SCHEMA'));
  let deep: ResponseSchema = { type: 'string' };
  for (let index = 0; index < 33; index++) deep = { not: deep };
  assert.throws(() => createResponseValidator(deep), code('INVALID_SCHEMA'));
  const cycle: Record<string, unknown> = {}; cycle.not = cycle;
  assert.throws(() => createResponseValidator(cycle as never), code('INVALID_SCHEMA'));
  const validate = createResponseValidator({ type: 'object', properties: { ['x'.repeat(4000)]: { type: 'string' } }, additionalProperties: false });
  try { validate({ ['x'.repeat(4000)]: 42 }); assert.fail('must reject'); }
  catch (error) {
    assert.ok(error instanceof ProgramError);
    assert.equal(error.code, 'INVALID_RESPONSE');
    assert.ok(error.message.length < 1024);
  }
  assert.throws(() => createResponseValidator(true)('x'.repeat(48 * 1024)), code('INVALID_RESPONSE'));
  assert.throws(() => createResponseValidator(true)(NaN), code('INVALID_RESPONSE'));
  assert.throws(() => createResponseValidator(true)({ get unsafe() { throw new Error('must not evaluate accessor'); } }), code('INVALID_RESPONSE'));
});
