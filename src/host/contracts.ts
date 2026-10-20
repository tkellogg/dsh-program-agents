import type { JsonValue, ProgramDefinition } from '../types.js';

export interface ProgramGrant extends ProgramDefinition {
  /** Exact model routes; an empty list denies model calls. */
  models?: Array<{provider: string; model: string}>;
  /** Exact visible DSH tool names; empty denies tool execution. */
  tools?: string[];
  maxModelOutputTokens?: number;
}
export interface PluginConfig {
  /** Plugin-owned bounded journals; does not alter DSH Session event schemas. */
  auditDirectory?: string;
  catalogDirectory?: string;
  logDirectory?: string;
  programs?: Record<string, ProgramGrant>;
  maxRuns?: number;
  maxHistory?: number;
  startupTimeoutMs?: number;
  stopTimeoutMs?: number;
  callTimeoutMs?: number;
}
export interface HostAudit {
  event: string;
  runId: string;
  generation: number;
  detail: JsonValue;
}
