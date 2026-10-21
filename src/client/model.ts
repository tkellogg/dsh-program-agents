import{endpointUrl,endpointName,normalizeEndpointPath,normalizeHostname,type ResolvedEndpointAddress}from'../endpoints.js';
// Browser-only wire boundary. Never retain runtime logs/messages in this status UI.
export type ProgramState = 'starting' | 'running' | 'blocked' | 'stopping' | 'stopped' | 'completed' | 'failed';
export type ProgramAction = 'start' | 'stop' | 'restart';
export interface ProgramResource { id: string; title: string; type: 'ui' | 'api' | 'docs'; url: string; docs?: string; endpoint?:string;path?:string;address?:ResolvedEndpointAddress;available: boolean }
export interface ProgramDescriptor {
  program: string;
  name: string;
  description: string;
  command: string[];
  urls: ProgramResource[];
  logsPath?: string;
  hasModelSlots?:boolean;
  modelRevision?:string;
}
export interface ProgramRun {
  id: string;
  generation: number;
  program: string;
  ownerId: string;
  label: string;
  state: ProgramState;
  name?: string;
  description?: string;
  command?: string[];
  logsPath?: string;
  status?: string;
  error?: string;
  startedAt: string;
  resources: ProgramResource[];
}
/** One row per configured program, merged with its newest owned run. */
export interface ProgramItem extends ProgramDescriptor { run?: ProgramRun }
export const CLIENT_LIMITS = { runs: 100, programs: 100, resources: 30, textCharacters: 2_000, frameBytes: 128 * 1024 } as const;
const states: readonly string[] = ['starting', 'running', 'blocked', 'stopping', 'stopped', 'completed', 'failed'];
export const isTerminal = (state: ProgramState): boolean => ['stopped', 'completed', 'failed'].includes(state);
export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function boundedText(value: unknown, max: number = CLIENT_LIMITS.textCharacters): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}
/** Only absolute HTTP(S), never local paths, credentials, controls or scheme-relative URLs. */
export function safeResourceUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 8_192 || !/^https?:\/\//i.test(value) || /[\u0000-\u0020\u007f\\]/.test(value)) return undefined;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}
export function resourceLink(item: ProgramItem, resource: ProgramResource, stale = false, pending?: ProgramAction,browserHostname?:string): string | undefined {
  if (stale || pending || !resource.available || !item.run || !['running', 'blocked'].includes(item.run.state)) return undefined;
  if(resource.endpoint){
    if(!resource.address||resource.address.endpoint!==resource.endpoint||resource.address.path!==(resource.path??'/'))return undefined;
    return endpointUrl(resource.address,browserHostname??(typeof location==='undefined'?undefined:location.hostname));
  }
  return safeResourceUrl(resource.url);
}
export function runControls(state: ProgramState | 'configured', pending = false, stale = false): Record<ProgramAction, boolean> {
  const ready = !pending && !stale;
  return {
    start: ready && (state === 'configured' || isTerminal(state)),
    stop: ready && ['starting', 'running', 'blocked'].includes(state),
    restart: ready && state !== 'configured' && state !== 'stopping',
  };
}
function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value || value.length > 512) throw new Error(`Invalid program snapshot ${name}.`);
  return value;
}
const command = (value: unknown): string[] => (Array.isArray(value) ? value : []).slice(0, 100).map(part => boundedText(part));
function address(value:unknown):ResolvedEndpointAddress|undefined{
  if(!record(value)||!endpointName(value.endpoint)||!['http','https'].includes(String(value.protocol))||!Number.isSafeInteger(value.port)||Number(value.port)<1||Number(value.port)>65535||typeof value.host!=='string')return undefined;
  try{const host=value.host==='browser'?'browser':normalizeHostname(value.host);return{endpoint:value.endpoint,host,protocol:value.protocol as'http'|'https',port:Number(value.port),path:normalizeEndpointPath(value.path)};}catch{return undefined;}
}
function resources(value: unknown): ProgramResource[] {
  return (Array.isArray(value) ? value : []).slice(0, CLIENT_LIMITS.resources).flatMap((raw: unknown) => {
    if (!record(raw)) return [];
    let recipe:{endpoint:string;path:string}|undefined;
    if(raw.endpoint!==undefined){if(!endpointName(raw.endpoint))return[];try{recipe={endpoint:raw.endpoint,path:normalizeEndpointPath(raw.path)};}catch{return[];}}
    const resolved=address(raw.address);
    return [{ id: boundedText(raw.id, 200), title: boundedText(raw.title, 300),
      type: (['ui', 'api', 'docs'].includes(String(raw.type)) ? raw.type : 'ui') as ProgramResource['type'],
      url: boundedText(raw.url, 8_192), ...(typeof raw.docs === 'string' ? { docs: boundedText(raw.docs, 8_192) } : {}), ...(recipe??{}),...(resolved?{address:resolved}:{}),available: raw.available === true }];
  });
}
function normalizeRun(raw: Record<string, unknown>, sessionId: string): ProgramRun {
  const id = requiredString(raw.id, 'id');
  if (!Number.isSafeInteger(raw.generation) || (raw.generation as number) < 1 || !states.includes(String(raw.state))) throw new Error('Invalid program snapshot state or generation.');
  return {
    id, generation: raw.generation as number, ownerId: sessionId, program: requiredString(raw.program, 'program'),
    label: boundedText(raw.label, 200), state: raw.state as ProgramState,
    ...(typeof raw.name === 'string' ? { name: boundedText(raw.name, 200) } : {}),
    ...(typeof raw.description === 'string' ? { description: boundedText(raw.description) } : {}),
    ...(Array.isArray(raw.command) ? { command: command(raw.command) } : {}),
    ...(typeof raw.logsPath === 'string' ? { logsPath: boundedText(raw.logsPath, 8_192) } : {}),
    status: boundedText(raw.status, 200), error: boundedText(raw.error, 240), startedAt: boundedText(raw.startedAt, 100),
    resources: resources(raw.resources ?? raw.urls),
  };
}
export interface RunList { runs: ProgramRun[]; programs: ProgramDescriptor[]; items: ProgramItem[]; truncated: boolean }
/** Full compact snapshots; legacy {runs} is accepted without fabricating configured entries. */
export function parseRunList(value: unknown, sessionId: string): RunList {
  if (!record(value) || !Array.isArray(value.runs) || (value.programs !== undefined && !Array.isArray(value.programs))) throw new Error('Program agents API returned an invalid list.');
  const scoped = value.runs.filter((raw: unknown): raw is Record<string, unknown> => record(raw) && raw.ownerId === sessionId);
  scoped.sort((left, right) => String(right.startedAt ?? '').localeCompare(String(left.startedAt ?? '')) || Number(right.generation) - Number(left.generation));
  // Bound history only after reserving each program's newest run, so one noisy
  // program cannot crowd another program's current state out of the foldout.
  const newest = new Map<string, Record<string, unknown>>();
  for (const raw of scoped) if (!newest.has(String(raw.program))) newest.set(String(raw.program), raw);
  const first = new Set(newest.values());
  const ordered = [...first, ...scoped.filter(raw => !first.has(raw))];
  const runs: ProgramRun[] = [];
  const ids = new Set<string>();
  for (const raw of ordered.slice(0, CLIENT_LIMITS.runs)) {
    const run = normalizeRun(raw, sessionId);
    if (!ids.has(run.id)) { runs.push(run); ids.add(run.id); }
  }
  const programs: ProgramDescriptor[] = [];
  const keys = new Set<string>();
  const definitions: unknown[] = Array.isArray(value.programs) ? value.programs : [];
  for (const raw of definitions.slice(0, CLIENT_LIMITS.programs)) {
    if (!record(raw)) throw new Error('Invalid program descriptor.');
    const program = requiredString(raw.program, 'program');
    if (keys.has(program)) continue;
    programs.push({ program, name: boundedText(raw.name, 200) || program, description: boundedText(raw.description), command: command(raw.command), urls: resources(raw.urls),...(raw.hasModelSlots===true?{hasModelSlots:true,modelRevision:boundedText(raw.modelRevision,2000)}:{}), ...(typeof raw.logsPath === 'string' ? { logsPath: boundedText(raw.logsPath, 8_192) } : {}) });
    keys.add(program);
  }
  const latest = new Map<string, ProgramRun>();
  for (const run of runs) if (!latest.has(run.program)) latest.set(run.program, run);
  const items: ProgramItem[] = programs.map(descriptor => {
    const run = latest.get(descriptor.program);
    latest.delete(descriptor.program);
    const merged = new Map(descriptor.urls.map(resource => [resource.id, resource]));
    for (const resource of run?.resources ?? []) {const configured=merged.get(resource.id);merged.set(resource.id,{...resource,...resource.docs===undefined&&configured?.docs!==undefined?{docs:configured.docs}:{}});}
    return { ...descriptor, urls: [...merged.values()].slice(0, CLIENT_LIMITS.resources), ...(run ? { run, logsPath: run.logsPath || descriptor.logsPath } : {}) };
  });
  for (const run of latest.values()) items.push({ program: run.program, name: run.name || run.label || run.program, description: run.description || '', command: run.command ?? [], logsPath: run.logsPath, urls: run.resources, run });
  return { runs, programs, items: items.slice(0, CLIENT_LIMITS.programs), truncated: scoped.length > CLIENT_LIMITS.runs || definitions.length > CLIENT_LIMITS.programs || items.length > CLIENT_LIMITS.programs };
}
