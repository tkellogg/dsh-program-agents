import { isAbsolute, resolve } from 'node:path';
import type { ProgramDefinition, ProgramEndpointDefinition, ProgramResource, ProgramUrlDefinition } from '../types.js';
import { endpointName, normalizeEndpointPath } from '../endpoints.js';
import { normalizeSupervision } from '../supervision.js';
import { exactKeys, isRecord, ProgramError, RUNTIME_LIMITS, validName } from './protocol.js';

const controls = /[\u0000-\u001f\u007f]/;

/** Paths are informational descriptors; callers must never turn them into file:// links. */
function location(value: unknown, allowPath: boolean): string {
  if (typeof value !== 'string' || !value || value.length > 4096 || controls.test(value)) throw new ProgramError('INVALID_URL', 'Resource location must be a bounded HTTP(S) URL or documentation path');
  if (allowPath && isAbsolute(value)) return value;
  if (!/^https?:\/\//i.test(value) || /\s/.test(value)) throw new ProgramError('INVALID_URL', 'Resource URL must be explicit HTTP(S) without whitespace or controls');
  let url: URL;
  try { url = new URL(value); } catch { throw new ProgramError('INVALID_URL', 'Resource URL must be absolute HTTP(S)'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new ProgramError('INVALID_URL', 'Only HTTP(S) links without credentials may be published');
  return url.href;
}

export function normalizeResource(input: unknown, available = false, requireType = false): ProgramResource {
  if (!isRecord(input) || !exactKeys(input, ['id', 'title', 'url'], ['type', 'docs']) || !validName(input.id) || typeof input.title !== 'string' || input.title.length > 256 || (requireType && input.type === undefined) || (input.type !== undefined && !['ui', 'api', 'docs'].includes(input.type as string))) throw new ProgramError('INVALID_INPUT', 'Invalid resource');
  return {
    id: input.id,
    title: input.title,
    url: location(input.url, input.type === 'docs'),
    ...(input.type === undefined ? {} : { type: input.type as 'ui' | 'api' | 'docs' }),
    ...(input.docs === undefined ? {} : { docs: location(input.docs, true) }),
    available,
  };
}

/** Configured recipes retain metadata without evaluating a listener or browser hostname. */
export function definitionResource(input: ProgramUrlDefinition): ProgramResource {
  if (input.endpoint === undefined) return normalizeResource(input);
  return {
    id: input.id, title: input.title, type: input.type, url: '',
    endpoint: input.endpoint, path: input.path ?? '/',
    ...(input.docs === undefined ? {} : { docs: input.docs }), available: false,
  };
}

function normalizeUrlDefinition(input: unknown, endpoints: Record<string, ProgramEndpointDefinition>): ProgramUrlDefinition {
  if (!isRecord(input) || !exactKeys(input, ['id', 'title', 'type'], ['url', 'endpoint', 'path', 'docs'])) throw new ProgramError('INVALID_INPUT', 'Invalid configured resource');
  if (input.url !== undefined) {
    if (Object.hasOwn(input, 'endpoint') || Object.hasOwn(input, 'path')) throw new ProgramError('INVALID_INPUT', 'Resource requires a literal URL or an endpoint recipe, not both');
    const { available: _, ...resource } = normalizeResource(input, false, true);
    return resource as ProgramUrlDefinition;
  }
  if (Object.hasOwn(input, 'url') || !validName(input.id) || typeof input.title !== 'string' || input.title.length > 256 || !['ui', 'api', 'docs'].includes(input.type as string) || !endpointName(input.endpoint) || !Object.hasOwn(endpoints, input.endpoint)) throw new ProgramError('INVALID_INPUT', 'Resource recipe must reference a configured endpoint');
  return {
    id: input.id, title: input.title, type: input.type as ProgramUrlDefinition['type'],
    endpoint: input.endpoint, path: normalizeEndpointPath(input.path),
    ...(input.docs === undefined ? {} : { docs: location(input.docs, true) }),
  };
}

/** Definitions execute trusted code, but config/metadata still have bounded exact shapes. */
export function normalizeDefinition(program: string, input: ProgramDefinition): ProgramDefinition {
  if (!validName(program) || !isRecord(input) || !exactKeys(input, [], ['entry', 'command', 'name', 'description', 'urls', 'endpoints', 'logsPath', 'cwd', 'args', 'env', 'allowedCapabilities', 'supervision'])) throw new ProgramError('INVALID_CONFIG', 'Invalid program definition');
  const entry = input.entry;
  const command = input.command;
  if ((entry === undefined) === (command === undefined)) throw new ProgramError('INVALID_CONFIG', 'Program requires exactly one of entry or command');
  const text = (value: unknown, max: number, empty = false): value is string => typeof value === 'string' && (empty || value.length > 0) && value.length <= max && !value.includes('\0');
  const argv = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 256 && Array.from(value).every((item) => text(item, 8192, true)) && Buffer.byteLength(JSON.stringify(value)) <= 64 * 1024;
  if (entry !== undefined && !text(entry, 4096)) throw new ProgramError('INVALID_CONFIG', 'Invalid program entrypoint');
  if (command !== undefined && (!argv(command) || !command.length || !command[0])) throw new ProgramError('INVALID_CONFIG', 'Command must be a nonempty executable argv array');
  if (input.args !== undefined && (!argv(input.args) || command !== undefined)) throw new ProgramError('INVALID_CONFIG', 'args is only supported with an SDK entrypoint; command already contains argv');
  if (input.cwd !== undefined && !text(input.cwd, 4096)) throw new ProgramError('INVALID_CONFIG', 'Invalid program working directory');
  if (input.name !== undefined && !text(input.name, 256)) throw new ProgramError('INVALID_CONFIG', 'Invalid program name');
  if (input.description !== undefined && !text(input.description, 4096, true)) throw new ProgramError('INVALID_CONFIG', 'Invalid program description');
  if (input.logsPath !== undefined && (!text(input.logsPath, 4096) || controls.test(input.logsPath))) throw new ProgramError('INVALID_CONFIG', 'Invalid log path');
  if (input.env !== undefined && (!isRecord(input.env) || Object.keys(input.env).length > 256 || Object.entries(input.env).some(([key, value]) => !key || key.includes('=') || key.includes('\0') || !text(value, 8192, true)) || Buffer.byteLength(JSON.stringify(input.env)) > 64 * 1024)) throw new ProgramError('INVALID_CONFIG', 'Invalid explicit program environment');
  const reserved = new Set(['capabilities.list', 'parent.send', 'status.set', 'resources.publish', 'resources.unpublish']);
  if (input.allowedCapabilities !== undefined && (!Array.isArray(input.allowedCapabilities) || input.allowedCapabilities.length > 256 || input.allowedCapabilities.some((capability) => !validName(capability) || reserved.has(capability)))) throw new ProgramError('INVALID_CONFIG', 'Invalid capability allowlist');
  if (input.urls !== undefined && (!Array.isArray(input.urls) || input.urls.length > RUNTIME_LIMITS.resources)) throw new ProgramError('INVALID_CONFIG', 'Invalid static resource list');
  if (input.endpoints !== undefined && (!isRecord(input.endpoints) || Object.keys(input.endpoints).length > 16)) throw new ProgramError('INVALID_CONFIG', 'At most 16 named endpoints may be configured');
  const endpoints: Record<string, ProgramEndpointDefinition> = {};
  for (const [id, endpoint] of Object.entries(input.endpoints ?? {})) {
    if (!endpointName(id) || !isRecord(endpoint) || !exactKeys(endpoint, ['port']) || (endpoint.port !== 'dynamic' && (!Number.isSafeInteger(endpoint.port) || (endpoint.port as number) < 1 || (endpoint.port as number) > 65535))) throw new ProgramError('INVALID_CONFIG', 'Endpoint requires a bounded name and dynamic or fixed port (1–65535)');
    endpoints[id] = { port: endpoint.port as 'dynamic' | number };
  }
  const urls: ProgramUrlDefinition[] = [];
  try {
    for (const item of input.urls ?? []) {
      const resource = normalizeUrlDefinition(item, endpoints);
      if (urls.some((other) => other.id === resource.id)) throw new ProgramError('INVALID_CONFIG', 'Duplicate static resource id');
      urls.push(resource);
    }
  } catch (error) { throw new ProgramError('INVALID_CONFIG', error instanceof Error ? error.message : 'Invalid static resource'); }
  const cwd = resolve(input.cwd ?? process.cwd());
  let supervision: ProgramDefinition['supervision'];
  try { supervision = normalizeSupervision(input.supervision); }
  catch (error) { throw new ProgramError('INVALID_CONFIG', error instanceof Error ? error.message : 'Invalid supervision settings'); }
  return {
    ...input,
    cwd,
    ...(entry === undefined ? { command: [...command!] } : { entry: resolve(cwd, entry), args: [...(input.args ?? [])] }),
    env: { ...(input.env as Record<string, string> | undefined) },
    allowedCapabilities: [...new Set(input.allowedCapabilities ?? [])],
    urls,
    ...(input.endpoints === undefined ? {} : { endpoints }),
    ...(supervision === undefined ? {} : { supervision }),
    ...(input.logsPath === undefined ? {} : { logsPath: resolve(cwd, input.logsPath) }),
  };
}

export function definitionCommand(definition: ProgramDefinition): string[] {
  return definition.command ? [...definition.command] : [process.execPath, definition.entry!, ...(definition.args ?? [])];
}
