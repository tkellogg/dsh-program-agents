// Browser-only wire boundary. No Node/runtime imports belong in the client bundle.
export type ProgramState = 'starting' | 'running' | 'blocked' | 'stopping' | 'stopped' | 'completed' | 'failed';
export type ProgramAction = 'send' | 'stop' | 'restart';
export interface ProgramResource { id: string; title: string; url: string; available: boolean }
export interface ProgramRun {
  id: string;
  generation: number;
  program: string;
  ownerId: string;
  label: string;
  state: ProgramState;
  status?: string;
  error?: string;
  startedAt: string;
  endedAt?: string;
  logs: Array<{ sequence: number; stream: 'stdout' | 'stderr' | 'system'; text: string }>;
  messages: Array<{ direction: 'parent' | 'program'; body: unknown; at: string }>;
  resources: ProgramResource[];
  result?: unknown;
}
export const CLIENT_LIMITS = {
  runs: 50, logs: 150, logCharacters: 64_000, messages: 50, resources: 30,
  textCharacters: 4_000, messageCharacters: 8_000, inputCharacters: 16_384,
} as const;
const states: readonly string[] = ['starting', 'running', 'blocked', 'stopping', 'stopped', 'completed', 'failed'];
const terminalStates: readonly ProgramState[] = ['stopped', 'completed', 'failed'];
export const isTerminal = (state: ProgramState): boolean => terminalStates.includes(state);
export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function boundedText(value: unknown, max: number = CLIENT_LIMITS.textCharacters): string {
  if (typeof value !== 'string') return '';
  return value.length > max ? `${value.slice(0, max)}… [truncated]` : value;
}
/** Absolute HTTP(S) only; never resolve relative, scheme-relative, credentials, or control characters. */
export function safeResourceUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 8_192 || !/^https?:\/\//i.test(value) || /[\u0000-\u0020\u007f\\]/.test(value)) return undefined;
  try {
    const url = new URL(value);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !url.hostname || url.username || url.password) return undefined;
    return url.href;
  } catch { return undefined; }
}
export function resourceLink(run: ProgramRun, resource: ProgramResource, stale = false, pending?: ProgramAction): string | undefined {
  if (stale || pending === 'stop' || pending === 'restart' || !resource.available || (run.state !== 'running' && run.state !== 'blocked')) return undefined;
  return safeResourceUrl(resource.url);
}
export function runControls(state: ProgramState, pending = false, stale = false): Record<ProgramAction, boolean> {
  const ready = !pending && !stale;
  return {
    send: ready && (state === 'running' || state === 'blocked'),
    stop: ready && (state === 'starting' || state === 'running' || state === 'blocked'),
    restart: ready && isTerminal(state),
  };
}
/** Bound nested JSON before formatting; children never become markup or executable content. */
export function formatJson(value: unknown): string {
  let budget = 600;
  const visit = (input: unknown, depth: number): unknown => {
    if (--budget < 0 || depth > 10) return '[truncated]';
    if (input === null || typeof input === 'boolean' || typeof input === 'number') return input;
    if (typeof input === 'string') return boundedText(input, 2_000);
    if (Array.isArray(input)) return input.slice(0, 100).map(item => visit(item, depth + 1));
    if (record(input)) return Object.fromEntries(Object.entries(input).slice(0, 100).map(([key, item]) => [boundedText(key, 200), visit(item, depth + 1)]));
    return null;
  };
  return boundedText(JSON.stringify(visit(value, 0), null, 2), CLIENT_LIMITS.messageCharacters);
}
function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value || value.length > 512) throw new Error(`Invalid program snapshot ${name}.`);
  return value;
}
function normalizeRun(raw: unknown, sessionId: string): ProgramRun | undefined {
  if (!record(raw)) throw new Error('Invalid program snapshot.');
  // Fail closed before looking at any display fields from another Session.
  if (raw.ownerId !== sessionId) return undefined;
  const id = requiredString(raw.id, 'id');
  if (!Number.isSafeInteger(raw.generation) || (raw.generation as number) < 1 || !states.includes(String(raw.state))) throw new Error('Invalid program snapshot state or generation.');
  let logBudget: number = CLIENT_LIMITS.logCharacters;
  const logs: ProgramRun['logs'] = [];
  const rawLogs = Array.isArray(raw.logs) ? raw.logs.slice(-CLIENT_LIMITS.logs) : [];
  // Keep the most recent bounded text, not an unbounded concatenation of stdout.
  for (let index = rawLogs.length - 1; index >= 0 && logBudget > 0; index--) {
    const log: unknown = rawLogs[index];
    if (!record(log) || !['stdout', 'stderr', 'system'].includes(String(log.stream)) || typeof log.text !== 'string') continue;
    const text = boundedText(log.text, Math.min(logBudget, CLIENT_LIMITS.textCharacters));
    logBudget -= text.length;
    logs.unshift({ sequence: typeof log.sequence === 'number' ? log.sequence : index, stream: log.stream as 'stdout' | 'stderr' | 'system', text });
  }
  return {
    id, generation: raw.generation as number, ownerId: sessionId,
    program: boundedText(raw.program, 200), label: boundedText(raw.label, 200),
    state: raw.state as ProgramState, status: boundedText(raw.status), error: boundedText(raw.error),
    startedAt: boundedText(raw.startedAt, 100), endedAt: boundedText(raw.endedAt, 100), logs,
    messages: (Array.isArray(raw.messages) ? raw.messages : []).slice(-CLIENT_LIMITS.messages).flatMap((message: unknown) => {
      if (!record(message) || !['parent', 'program'].includes(String(message.direction))) return [];
      return [{ direction: message.direction as 'parent' | 'program', body: message.body, at: boundedText(message.at, 100) }];
    }),
    resources: (Array.isArray(raw.resources) ? raw.resources : []).slice(0, CLIENT_LIMITS.resources).flatMap((resource: unknown) => {
      if (!record(resource)) return [];
      return [{ id: boundedText(resource.id, 200), title: boundedText(resource.title, 300), url: boundedText(resource.url, 8_192), available: resource.available === true }];
    }),
    ...(raw.result !== undefined ? { result: raw.result } : {}),
  };
}
export interface RunList { runs: ProgramRun[]; truncated: boolean }
/** Validate the server result and enforce a second, client-side owner/data bound. */
export function parseRunList(value: unknown, sessionId: string): RunList {
  if (!record(value) || !Array.isArray(value.runs)) throw new Error('Program agents API returned an invalid list.');
  const runs: ProgramRun[] = [];
  const seen = new Set<string>();
  // Do not normalize or render snapshots belonging to another Session.
  const scoped = value.runs.filter((run: unknown) => record(run) && run.ownerId === sessionId);
  // Keep active programs first and newest generations next, so bounds cannot
  // silently hide a newly launched process behind an old terminal history.
  scoped.sort((left: Record<string, unknown>, right: Record<string, unknown>) => {
    const terminalDifference = Number(terminalStates.includes(left.state as ProgramState)) - Number(terminalStates.includes(right.state as ProgramState));
    return terminalDifference || String(right.startedAt ?? '').localeCompare(String(left.startedAt ?? ''));
  });
  for (const raw of scoped.slice(0, CLIENT_LIMITS.runs)) {
    const run = normalizeRun(raw, sessionId);
    if (run && !seen.has(run.id)) { runs.push(run); seen.add(run.id); }
  }
  return { runs, truncated: scoped.length > CLIENT_LIMITS.runs };
}
/** Text by default; JSON mode is explicit and cannot fall back silently. */
export function parseMessage(text: string, json: boolean): unknown {
  if (!text.trim()) throw new Error('Enter a message.');
  if (text.length > CLIENT_LIMITS.inputCharacters) throw new Error(`Message is limited to ${CLIENT_LIMITS.inputCharacters.toLocaleString('en-US')} characters.`);
  if (!json) return text;
  try { return JSON.parse(text) as unknown; }
  catch { throw new Error('Message is not valid JSON.'); }
}
