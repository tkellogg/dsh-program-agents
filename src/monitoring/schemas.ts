import type { JsonValue } from '../types.js';

/** Deliberately small JSON Schema subset; unsupported keywords fail registration. */
export interface PayloadSchema {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  properties?: Record<string, PayloadSchema>;
  required?: string[];
  additionalProperties?: boolean | PayloadSchema;
  items?: PayloadSchema;
  enum?: JsonValue[];
  const?: JsonValue;
  oneOf?: PayloadSchema[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
  description?: string;
  $id?: string;
  $schema?: string;
  title?: string;
}
const keywords = new Set(['type','properties','required','additionalProperties','items','enum','const','oneOf','minLength','maxLength','minimum','maximum','minItems','maxItems','pattern','description','$id','$schema','title']);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
function checkSchema(schema: PayloadSchema, depth = 0): void {
  if (depth > 32 || !schema || typeof schema !== 'object' || Array.isArray(schema) || ![Object.prototype,null].includes(Object.getPrototypeOf(schema))) throw new Error('Invalid payload schema');
  for (const key of Object.keys(schema)) if (!keywords.has(key)) throw new Error(`Unsupported schema keyword: ${key}`);
  if (schema.type !== undefined && !['object','array','string','number','integer','boolean','null'].includes(schema.type)) throw new Error('Invalid schema type');
  for (const key of ['minLength','maxLength','minItems','maxItems'] as const) if (schema[key] !== undefined && (!Number.isSafeInteger(schema[key]) || schema[key]! < 0)) throw new Error(`Invalid schema ${key}`);
  for (const key of ['minimum','maximum'] as const) if (schema[key] !== undefined && !Number.isFinite(schema[key])) throw new Error(`Invalid schema ${key}`);
  for (const key of ['description','pattern','$id','$schema','title'] as const) if (schema[key] !== undefined && typeof schema[key] !== 'string') throw new Error(`Invalid schema ${key}`);
  if (schema.required !== undefined && (!Array.isArray(schema.required) || !schema.required.every(x => typeof x === 'string'))) throw new Error('Invalid schema required');
  if (schema.enum !== undefined && !Array.isArray(schema.enum)) throw new Error('Invalid schema enum');
  const lossless = (value: unknown, level = 0): boolean => level <= 32 && (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) || !!value && typeof value === 'object' && (Array.isArray(value) ? value.every(x => lossless(x,level + 1)) : [Object.prototype,null].includes(Object.getPrototypeOf(value)) && Object.values(value).every(x => lossless(x,level + 1))));
  if (schema.enum && !lossless(schema.enum) || 'const' in schema && !lossless(schema.const)) throw new Error('Schema values must be bounded finite JSON');
  if (schema.pattern) new RegExp(schema.pattern);
  if (schema.properties !== undefined && (!schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties))) throw new Error('Invalid schema properties');
  for (const child of Object.values(schema.properties ?? {})) checkSchema(child, depth + 1);
  if (schema.items !== undefined) checkSchema(schema.items, depth + 1);
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') checkSchema(schema.additionalProperties, depth + 1);
  if (schema.oneOf !== undefined && (!Array.isArray(schema.oneOf) || !schema.oneOf.length)) throw new Error('Invalid schema oneOf');
  for (const child of schema.oneOf ?? []) checkSchema(child, depth + 1);
}
function matches(value: unknown, schema: PayloadSchema): boolean {
  if (schema.oneOf && schema.oneOf.filter(s => matches(value, s)).length !== 1) return false;
  if ('const' in schema && canonical(value) !== canonical(schema.const)) return false;
  if (schema.enum && !schema.enum.some(x => canonical(value) === canonical(x))) return false;
  if (schema.type) {
    const valid = schema.type === 'null' ? value === null : schema.type === 'array' ? Array.isArray(value)
      : schema.type === 'object' ? !!value && typeof value === 'object' && !Array.isArray(value)
      : schema.type === 'integer' ? typeof value === 'number' && Number.isInteger(value)
      : typeof value === schema.type;
    if (!valid) return false;
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength || schema.maxLength !== undefined && value.length > schema.maxLength) return false;
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return false;
  }
  if (typeof value === 'number' && (!Number.isFinite(value) || schema.minimum !== undefined && value < schema.minimum || schema.maximum !== undefined && value > schema.maximum)) return false;
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems || schema.maxItems !== undefined && value.length > schema.maxItems) return false;
    if (schema.items && !value.every(x => matches(x, schema.items!))) return false;
  } else if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (schema.required?.some(key => !(key in record))) return false;
    for (const [key, child] of Object.entries(record)) {
      const property = schema.properties && Object.hasOwn(schema.properties,key) ? schema.properties[key] : undefined;
      if (property ? !matches(child, property) : schema.additionalProperties === false || typeof schema.additionalProperties === 'object' && !matches(child, schema.additionalProperties)) return false;
    }
  }
  return true;
}
export class LogSchemaRegistry {
  private readonly schemas = new Map<string, { schema: PayloadSchema; signature: string; optional: boolean }>();
  register(logType: string, schema: PayloadSchema, options: { optional?: boolean } = {}): this {
    if (!/^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+\.v[1-9][0-9]*$/.test(logType) || logType.length > 256) throw new Error('Expected a versioned namespaced log_type');
    checkSchema(schema);
    const signature = canonical({ schema, optional: !!options.optional });
    const prior = this.schemas.get(logType);
    if (prior && prior.signature !== signature) throw new Error(`Schema ${logType} is immutable; publish a new version`);
    this.schemas.set(logType, { schema: JSON.parse(JSON.stringify(schema)), signature, optional: !!options.optional });
    return this;
  }
  validate(logType: string, data: unknown): boolean {
    const registered = this.schemas.get(logType);
    return !registered || data === undefined && registered.optional || matches(data, registered.schema);
  }
  get(logType: string): PayloadSchema | undefined {
    const schema = this.schemas.get(logType)?.schema;
    return schema && JSON.parse(JSON.stringify(schema)) as PayloadSchema;
  }
}
const sourceSchema: PayloadSchema = { type:'object', properties:{path:{type:'string'},offset:{type:'integer',minimum:0},run:{oneOf:[{type:'string'},{type:'object',required:['id','generation'],properties:{id:{type:'string'},generation:{type:'integer',minimum:0}},additionalProperties:false}]}},additionalProperties:false };
export const errorBatchPayloadSchema: PayloadSchema = {
  type:'object', required:['key','groups','count','range','dropped'], additionalProperties:true,
  properties:{
    key:{type:'string'}, count:{type:'integer',minimum:1}, dropped:{type:'integer',minimum:0},
    range:{type:'object',required:['first','last'],properties:{first:{type:'string'},last:{type:'string'}},additionalProperties:false},
    groups:{type:'array',minItems:1,maxItems:20,items:{type:'object',required:['fingerprint','count','sample','range'],additionalProperties:true,properties:{
      fingerprint:{type:'string'},count:{type:'integer',minimum:1},sample:{type:'object'},
      range:{type:'object',required:['first','last'],properties:{first:{type:'string'},last:{type:'string'}},additionalProperties:false},
      source:sourceSchema,
    }}},
  },
};
export const httpRequestPayloadSchema: PayloadSchema = {
  type:'object', required:['method','path','status'], additionalProperties:true,
  properties:{method:{type:'string',minLength:1,maxLength:32},path:{type:'string'},status:{type:'integer',minimum:100,maximum:599},duration_ms:{type:'number',minimum:0}},
};
export const defaultLogRegistry = new LogSchemaRegistry()
  .register('dsh.program.error.v1', {type:'object',additionalProperties:true}, {optional:true})
  .register('dsh.http.request.v1', httpRequestPayloadSchema)
  .register('dsh.program.error-batch.v1', errorBatchPayloadSchema);
