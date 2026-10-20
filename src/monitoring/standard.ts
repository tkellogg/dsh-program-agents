import { createHash } from 'node:crypto';
import type { JsonValue } from '../types.js';
import { LogSchemaRegistry, defaultLogRegistry } from './schemas.js';

export type { JsonValue };
export const MAX_LOG_LINE_BYTES = 64 * 1024;
export const MAX_LOG_DEPTH = 32;
export const LOG_LEVELS = ['DEBUG', 'INFO', 'WARNING', 'ERROR'] as const;
export type LogLevel = typeof LOG_LEVELS[number];
export interface StandardLogError {
  name: string;
  message: string;
  stack?: string;
  code?: string | number;
  fingerprint?: string;
}
/** Extensions are allowed, but must be bounded, finite JSON values. */
export interface StandardLogRecord {
  timestamp: string;
  level: LogLevel;
  log_type: string;
  message: string;
  operation_id?: string;
  event_id?: string;
  error?: StandardLogError;
  data?: JsonValue;
  /** Advisory only: ERROR severity, not this flag, drives error monitoring. */
  fatal?: boolean;
  [extension: string]: unknown;
}

export const LOG_TYPE_PATTERN = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+\.v[1-9][0-9]*$/;
export function isLogType(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 256 && LOG_TYPE_PATTERN.test(value);
}
/** Validate before serializing: JSON.stringify silently loses undefined/NaN/class values. */
export function isJson(value: unknown, depth = 0, seen = new Set<object>()): value is JsonValue {
  if (depth > MAX_LOG_DEPTH) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || seen.has(value)) return false;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? Array.from({ length: value.length }, (_, i) => i in value && isJson(value[i], depth + 1, seen)).every(Boolean)
    : Object.values(value).every(child => isJson(child, depth + 1, seen));
  seen.delete(value);
  return valid;
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function optionalString(o: Record<string, unknown>, key: string): boolean {
  return !(key in o) || typeof o[key] === 'string';
}
function validTimestamp(value: string): boolean {
  const match = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d{1,9})?(?:Z|([+-])(\d\d):(\d\d))$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const [,year,month,day,hour,minute,second,,zoneHour,zoneMinute] = match;
  const y = Number(year), m = Number(month), d = Number(day);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31,leap ? 29 : 28,31,30,31,30,31,31,30,31,30,31];
  return m >= 1 && m <= 12 && d >= 1 && d <= days[m - 1] && Number(hour) < 24 && Number(minute) < 60 && Number(second) < 60 && (!zoneHour || Number(zoneHour) < 24 && Number(zoneMinute) < 60);
}
export function isStandardLogRecord(value: unknown, registry: LogSchemaRegistry = defaultLogRegistry): value is StandardLogRecord {
  if (!isJson(value) || !object(value)) return false;
  if (typeof value.timestamp !== 'string' || !validTimestamp(value.timestamp)) return false;
  if (!LOG_LEVELS.includes(value.level as LogLevel) || !isLogType(value.log_type) || typeof value.message !== 'string') return false;
  if (!optionalString(value, 'operation_id') || !optionalString(value, 'event_id')) return false;
  if ('fatal' in value && typeof value.fatal !== 'boolean') return false;
  if ('error' in value) {
    const e = value.error;
    if (!object(e) || typeof e.name !== 'string' || typeof e.message !== 'string' || !optionalString(e, 'stack') || !optionalString(e, 'fingerprint')) return false;
    if ('code' in e && typeof e.code !== 'string' && typeof e.code !== 'number') return false;
  }
  return registry.validate(value.log_type, value.data);
}
/** Invalid/nonstandard/oversize lines are ignored, never interpreted as instructions. */
export function parseLogLine(line: string, registry: LogSchemaRegistry = defaultLogRegistry): StandardLogRecord | undefined {
  if (typeof line !== 'string' || Buffer.byteLength(line, 'utf8') > MAX_LOG_LINE_BYTES) return undefined;
  try {
    const value: unknown = JSON.parse(line);
    return isStandardLogRecord(value, registry) ? value : undefined;
  } catch { return undefined; }
}
/** Stable across timestamps, stack positions, sources and stdout/file duplicates. */
export function errorFingerprint(record: StandardLogRecord): string {
  return createHash('sha256').update(JSON.stringify([
    record.log_type, record.message, record.error?.name ?? null,
    record.error?.message ?? null, record.error?.code ?? null,
  ])).digest('hex');
}

const SECRET_KEYS = new Set(['authorization', 'proxyauthorization', 'cookie', 'setcookie', 'password', 'passwd', 'passphrase', 'secret', 'clientsecret', 'token', 'accesstoken', 'refreshtoken', 'idtoken', 'apikey', 'xapikey', 'privatekey', 'credentials', 'headers']);
/** Header objects are deliberately wholly redacted, rather than guessing safe headers. */
export function redact(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const result: { [key: string]: JsonValue } = Object.create(null);
    for (const [key, child] of Object.entries(value)) {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
      result[key] = SECRET_KEYS.has(normalized) || /(?:password|secret|token|apikey)$/.test(normalized) ? '[REDACTED]' : redact(child);
    }
    return result;
  }
  return value;
}

/** Useful to host stdout parsers too: bounded fragments, including oversize lines. */
export class JsonlDecoder {
  private pending = Buffer.alloc(0);
  private skipping = false;
  constructor(private readonly onRecord: (record: StandardLogRecord, endOffset: number) => void, private readonly registry = defaultLogRegistry) {}
  push(chunk: Buffer | string, startOffset = 0): void {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    let start = 0;
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] !== 10) continue;
      if (!this.skipping) {
        const fragment = bytes.subarray(start, i);
        if (this.pending.length + fragment.length <= MAX_LOG_LINE_BYTES) {
          const line = this.pending.length ? Buffer.concat([this.pending, fragment]) : fragment;
          const record = parseLogLine(line.toString('utf8'), this.registry);
          if (record) this.onRecord(record, startOffset + i + 1);
        }
      }
      this.pending = Buffer.alloc(0); this.skipping = false; start = i + 1;
    }
    const rest = bytes.subarray(start);
    if (!this.skipping && this.pending.length + rest.length <= MAX_LOG_LINE_BYTES) this.pending = Buffer.concat([this.pending, rest]);
    else { this.pending = Buffer.alloc(0); this.skipping = true; }
  }
  reset(): void { this.pending = Buffer.alloc(0); this.skipping = false; }
  discardPartialLine(): void { this.pending = Buffer.alloc(0); this.skipping = true; }
  get pendingBytes(): number { return this.pending.length; }
}
