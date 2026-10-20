import type { JsonValue } from '../types.js';
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object');
  return value as Record<string,unknown>;
}
export function text(value: unknown, name: string, max=256): string {
  if(typeof value!=='string'||!value.length||value.length>max)throw new Error(`Invalid ${name}`);
  return value;
}
export function json(value: unknown, maxBytes=65536): JsonValue {
  const wire=JSON.stringify(value);
  if(wire===undefined||Buffer.byteLength(wire)>maxBytes)throw new Error('JSON value too large or missing');
  // Values arrive from a JSON protocol; reject non-JSON callers as well.
  function check(v:unknown,depth=0):void {
    if(depth>32)throw new Error('JSON nesting limit');
    if(v===null||typeof v==='string'||typeof v==='boolean')return;
    if(typeof v==='number'&&Number.isFinite(v))return;
    if(Array.isArray(v)){for(const x of v)check(x,depth+1);return;}
    if(v&&typeof v==='object'&&(Object.getPrototypeOf(v)===Object.prototype||Object.getPrototypeOf(v)===null)){for(const x of Object.values(v))check(x,depth+1);return;}
    throw new Error('Expected lossless JSON');
  }
  check(value);return JSON.parse(wire) as JsonValue;
}
export function exactKeys(o:Record<string,unknown>,keys:string[]):void {
  if(Object.keys(o).some(k=>!keys.includes(k)))throw new Error('Unknown argument');
}
