import type { JsonValue, ProgramDefinition } from '../types.js';
import type {EndpointNetworking} from '../endpoints.js';

export interface ProgramGrant extends ProgramDefinition {
  /** Exact model routes; an empty list denies model calls. */
  models?: Array<{provider: string; model: string}>;
  /** Exact visible DSH tool names; empty denies tool execution. */
  tools?: string[];
  /** Explicit host function names and MCP public tools (policy still applies). */
  functions?:string[];
  mcp?:Array<{server:string;tools:string[]}>;
  messaging?:boolean;
  maxModelOutputTokens?: number;
}
export interface PluginConfig {
  /** Plugin-owned bounded journals; does not alter DSH Session event schemas. */
  auditDirectory?: string;
  catalogDirectory?: string;
  logDirectory?: string;
  programs?: Record<string, ProgramGrant>;
  /** Trusted direct-access policy. Never supplied by browser Host headers or program recipes. */
  networking?:EndpointNetworking;
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
