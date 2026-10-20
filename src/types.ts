import type { SupervisionSettings } from './supervision.js';

/** JSON is the only value boundary between a supervised process and its host. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type ProgramState = 'starting' | 'running' | 'blocked' | 'stopping' | 'stopped' | 'completed' | 'failed';

export interface ProgramDefinition {
  /** SDK module entrypoint. Mutually exclusive with command. */
  entry?: string;
  /** Trusted executable argv, passed directly to spawn without an implicit shell. */
  command?: string[];
  name?: string;
  description?: string;
  urls?: Array<{ id: string; title: string; type: 'ui' | 'api' | 'docs'; url: string; docs?: string }>;
  /** Optional descriptor for program-owned logs; supervisor capture remains separate. */
  logsPath?: string;
  cwd?: string;
  args?: string[];
  env?: Record<string, string>;
  allowedCapabilities?: string[];
  /** Trusted host policy; not permission granted by program-controlled input. */
  supervision?: SupervisionSettings;
}

export interface ProgramDescriptor {
  program: string;
  name: string;
  description: string;
  command: string[];
  urls: ProgramResource[];
  logsPath?: string;
  supervision?: SupervisionSettings;
}

export interface ProgramLog {
  sequence: number;
  stream: 'stdout' | 'stderr' | 'system';
  text: string;
}

export interface ProgramResource {
  id: string;
  title: string;
  url: string;
  type?: 'ui' | 'api' | 'docs';
  /** Documentation HTTP(S) URL or informational absolute filesystem path. */
  docs?: string;
  available: boolean;
}

export interface ProgramMessage {
  /** The sender: parent -> inbox, or program -> parent notification. */
  direction: 'parent' | 'program';
  body: JsonValue;
  at: string;
}

export interface ProgramSnapshot {
  id: string;
  generation: number;
  program: string;
  ownerId: string;
  label: string;
  name?: string;
  description?: string;
  command?: string[];
  logsPath?: string;
  supervision?: SupervisionSettings;
  state: ProgramState;
  status?: string;
  pid?: number;
  startedAt: string;
  endedAt?: string;
  error?: string;
  logs: ProgramLog[];
  resources: ProgramResource[];
  messages: ProgramMessage[];
  result?: JsonValue;
}

export interface ProgramEvent {
  type: 'changed';
  run: ProgramSnapshot;
}

export interface CapabilityMetadata {
  name: string;
  description: string;
  inputSchema?: JsonValue;
}

export interface CapabilityDefinition extends CapabilityMetadata {
  handler: (input: JsonValue, context: { run: ProgramSnapshot; signal: AbortSignal }) => Promise<JsonValue>;
}

export interface ProgramContext {
  readonly id: string;
  readonly generation: number;
  readonly input: JsonValue;
  readonly signal: AbortSignal;
  readonly inbox: AsyncIterable<{ body: JsonValue }>;
  readonly parent: { send(body: JsonValue): Promise<void> };
  status(state: 'running' | 'blocked', detail?: string): Promise<void>;
  readonly resources: {
    publish(resource: { id: string; title: string; url: string; type?: 'ui' | 'api' | 'docs'; docs?: string }): Promise<void>;
    unpublish(id: string): Promise<void>;
  };
  readonly capabilities: {
    list(): Promise<CapabilityMetadata[]>;
    call(name: string, input: JsonValue): Promise<JsonValue>;
  };
  readonly models: { call(input: JsonValue): Promise<JsonValue> };
  readonly tools: { call(name: string, args: JsonValue): Promise<JsonValue> };
}

export type ProgramMain = (context: ProgramContext) => JsonValue | void | Promise<JsonValue | void>;

export interface StartProgramOptions {
  program: string;
  ownerId: string;
  input?: JsonValue;
  label?: string;
}

/** Registry is structural here to keep the shared contract independent of the runtime. */
export interface CapabilityRegistryLike {
  list(): CapabilityMetadata[];
  get(name: string): CapabilityDefinition | undefined;
}

export interface ProgramSupervisorOptions {
  programs: Record<string, ProgramDefinition>;
  capabilities?: CapabilityRegistryLike;
  onParentMessage?: (ownerId: string, message: JsonValue, run: ProgramSnapshot, signal: AbortSignal) => Promise<void>;
  onEvent?: (event: ProgramEvent) => void;
  /** Observer of decoded raw output, before bounded snapshot truncation. */
  onOutput?: (run: ProgramSnapshot, chunk: string, stream: 'stdout' | 'stderr') => void;
  /** Synchronous credential setup before spawn; revoke is called before process cleanup. */
  bridge?: {
    environment(run: ProgramSnapshot, definition: ProgramDefinition): Record<string, string>;
    revoke(run: ProgramSnapshot): void;
  };
  maxRuns?: number;
  maxHistory?: number;
  startupTimeoutMs?: number;
  stopTimeoutMs?: number;
  callTimeoutMs?: number;
  /** Private capture directory; standalone supervisors default to a private temporary directory. */
  logDirectory?: string;
  /** Trusted host override for bundled deployments; defaults to this runtime's directory. */
  bootstrapDirectory?: string;
}
