import * as Ajv2020Module from 'ajv/dist/2020.js';
import type { JsonValue } from './types.js';
import { assertJson, ProgramError } from './runtime/protocol.js';

/** Selection/creation is performed by the parent router, never by the durable store. */
export type AgentTarget = string | { id: string } | { name: string; instructions?: string } | { create: { name: string; instructions?: string } };
/** JSON Schema Draft 2020-12, not the intentionally limited logging schema language. */
export type JSONSchema = Record<string, JsonValue> | boolean;
export type ResponseSchema = JSONSchema;
export type RequestStatus = 'pending' | 'answered' | 'cancelled' | 'expired' | 'failed' | 'dispatch-unknown';
export interface RequestScope { ownerId: string; program: string }
export interface ResponseReceipt { id: string; requestId: string; status: 'answered'; agentId: string; answeredAt: string }
export interface RequestRecord {
  /** Server-generated opaque UUID. The id alias is provided for receipt-style callers. */
  id: string;
  requestId: string;
  ownerId: string;
  program: string;
  /** Optional caller-provided idempotency key; this is not the server request identity. */
  requestKey?: string;
  target: JsonValue;
  body: JsonValue;
  responseSchema: ResponseSchema;
  prompt?: string;
  status: RequestStatus;
  agentId?: string;
  createdAt: string;
  deadline: string;
  dispatchAcceptedAt?: string;
  answeredAt?: string;
  closedAt?: string;
  response?: JsonValue;
  receipt?: ResponseReceipt;
  error?: string;
}
export interface CreateRequestOptions {
  /** Idempotency key scoped to ownerId + program; returned requestId is always a UUID. */
  requestId?: string;
  requestKey?: string;
  target: JsonValue;
  body: JsonValue;
  responseSchema?: ResponseSchema;
  prompt?: string;
  timeoutMs?: number;
}
export interface RequestWaitOptions { waitMs?: number }
export const REQUEST_LIMITS = Object.freeze({
  schemaBytes: 16 * 1024,
  schemaDepth: 32,
  /** Reserve four nesting levels for request/response and transport envelopes. */
  payloadDepth: 28,
  payloadNodes: 9900,
  bodyBytes: 48 * 1024,
  requestBytes: 56 * 1024,
  promptBytes: 8 * 1024,
  defaultTimeoutMs: 120_000,
  maxTimeoutMs: 3_600_000,
  maxWaitMs: 30_000,
  pollMs: 50,
  maxRequests: 10_000,
  maxPendingPerProgram: 128,
  maxPending: 1024,
});
export const DEFAULT_RESPONSE_SCHEMA: ResponseSchema = Object.freeze({ type: 'string' });
export type ResponseValidator = (body: unknown) => void;

/** Validate payloads before persistence, reserving depth and nodes for bridge framing. */
export function assertRequestPayload(value: unknown): asserts value is JsonValue {
  assertJson(value);
  // assertJson has already excluded cycles, accessors, sparse arrays and non-JSON.
  let nodes = 0;
  const visit = (item: JsonValue, depth: number): void => {
    if (++nodes > REQUEST_LIMITS.payloadNodes || depth > REQUEST_LIMITS.payloadDepth) throw new ProgramError('LIMIT', 'Request payload complexity exceeds framing-safe limits (depth 28, 9900 nodes)');
    if (item && typeof item === 'object') for (const child of Object.values(item)) visit(child, depth + 1);
  };
  visit(value, 0);
}

// Ajv is CommonJS in NodeNext. Both native ESM and TS runners expose one of these.
const Ajv2020 = (Ajv2020Module.default ?? Ajv2020Module.Ajv2020) as unknown as typeof Ajv2020Module.Ajv2020;
const schemaMaps = new Set(['$defs', 'definitions', 'properties', 'patternProperties', 'dependentSchemas']);
const schemaArrays = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
const schemaChildren = new Set(['items', 'additionalProperties', 'contains', 'propertyNames', 'unevaluatedProperties', 'unevaluatedItems', 'not', 'if', 'then', 'else', 'contentSchema']);
function safeMessage(value: unknown): string {
  let message: string;
  try { message = value instanceof Error ? value.message : String(value); }
  catch { message = 'Validation failed'; }
  return message.slice(0, 512).replace(/[\u0000-\u001f\u007f]/g, ' ');
}
function checkReferences(schema: JSONSchema): void {
  if (typeof schema === 'boolean') return;
  for (const keyword of ['$ref', '$dynamicRef', '$recursiveRef']) {
    const ref = schema[keyword];
    if (ref !== undefined && (typeof ref !== 'string' || !ref.startsWith('#'))) throw new ProgramError('INVALID_SCHEMA', 'Only local fragment schema references are supported; remote references are not fetched');
  }
  if (schema.$async !== undefined) throw new ProgramError('INVALID_SCHEMA', 'Asynchronous response schemas are not supported');
  for (const [key, value] of Object.entries(schema)) {
    if (schemaMaps.has(key) && value && typeof value === 'object' && !Array.isArray(value)) {
      for (const child of Object.values(value)) if (typeof child === 'boolean' || child && typeof child === 'object' && !Array.isArray(child)) checkReferences(child as JSONSchema);
    } else if (schemaArrays.has(key) && Array.isArray(value)) {
      for (const child of value) if (typeof child === 'boolean' || child && typeof child === 'object' && !Array.isArray(child)) checkReferences(child as JSONSchema);
    } else if (schemaChildren.has(key) && (typeof value === 'boolean' || value && typeof value === 'object' && !Array.isArray(value))) checkReferences(value as JSONSchema);
  }
}

/**
 * Compile a real Draft 2020-12 schema. No coercion, default insertion, property
 * removal, remote loading or format plugins. Unknown formats/keywords fail closed.
 * Input/schema bounds constrain state, not CPU: trusted program regexes can still
 * be expensive, and validation is not a sandbox or an execution time guarantee.
 */
export function createResponseValidator(schema: ResponseSchema = DEFAULT_RESPONSE_SCHEMA): ResponseValidator {
  let validate: ReturnType<InstanceType<typeof Ajv2020>['compile']>;
  try {
    assertJson(schema);
    if (typeof schema !== 'boolean' && (!schema || typeof schema !== 'object' || Array.isArray(schema))) throw new Error('Expected a JSON Schema object or boolean');
    if (Buffer.byteLength(JSON.stringify(schema)) > REQUEST_LIMITS.schemaBytes) throw new Error('Response schema exceeds 16 KiB');
    // assertJson above enforces the shared depth-32 and finite JSON boundaries.
    checkReferences(schema);
    const ajv = new Ajv2020({ strict: true, allErrors: false, coerceTypes: false, removeAdditional: false, useDefaults: false, validateFormats: true, addUsedSchema: false });
    validate = ajv.compile(JSON.parse(JSON.stringify(schema)) as ResponseSchema);
  } catch (error) {
    throw new ProgramError('INVALID_SCHEMA', `Invalid response schema: ${safeMessage(error)}`);
  }
  return (body: unknown): void => {
    try {
      assertRequestPayload(body);
      if (Buffer.byteLength(JSON.stringify(body)) > REQUEST_LIMITS.bodyBytes) throw new Error('Response exceeds 48 KiB');
    } catch (error) {
      throw new ProgramError('INVALID_RESPONSE', `Invalid response JSON: ${safeMessage(error)}`);
    }
    let valid: boolean;
    try { valid = validate(body) as boolean; }
    catch (error) { throw new ProgramError('INVALID_RESPONSE', `Response validation failed: ${safeMessage(error)}`); }
    if (!valid) {
      const error = validate.errors?.[0];
      const detail = error ? `${error.instancePath || '/'} ${error.message ?? 'does not match the response schema'}` : 'does not match the response schema';
      throw new ProgramError('INVALID_RESPONSE', `Response ${safeMessage(detail)}`);
    }
  };
}
