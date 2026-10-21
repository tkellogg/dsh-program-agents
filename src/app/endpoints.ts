import type { Server } from 'node:net';
import type { ProgramEndpointBinding } from '../endpoints.js';
import { endpointName } from '../endpoints.js';
import type { JsonValue } from '../types.js';
import { ProgramError } from '../runtime/protocol.js';
import type { CallOptions } from './index.js';

export type { ProgramEndpointBinding } from '../endpoints.js';
export interface PublishEndpointOptions { port: number }
export interface UnpublishEndpointOptions { port?: number }
export interface ListeningProgramEndpoint {
  port: number;
  /** Authoritative bind host, not a browser-facing hostname. */
  host: string;
  /** Local verification URL; wildcard binds use their loopback equivalent. */
  localUrl: string;
  /** Close this listener and await its conditional unpublication. Idempotent. */
  close(): Promise<void>;
}
export interface ProgramEndpoints {
  list(options?: CallOptions): Promise<ProgramEndpointBinding[]>;
  publish(id: string, address: PublishEndpointOptions, options?: CallOptions): Promise<ProgramEndpointBinding>;
  unpublish(id: string, address?: UnpublishEndpointOptions, options?: CallOptions): Promise<ProgramEndpointBinding>;
  /** Bind using current host configuration, then advertise the actual OS port. */
  listen(id: string, server: Server, options?: CallOptions): Promise<ListeningProgramEndpoint>;
}
export type EndpointBridgeCall = <T = JsonValue>(method: string, input?: JsonValue, options?: CallOptions) => Promise<T>;

const managedServers = new WeakSet<Server>();
const cancelled = () => new ProgramError('CANCELLED', 'Endpoint listen was cancelled');
const unavailable = () => new ProgramError('UNAVAILABLE', 'Endpoint server closed during setup');
const unbracket = (host: string) => host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;

/** Typed endpoint bridge helpers. Calls are never retried and use existing call cancellation. */
export function createProgramEndpoints(call: EndpointBridgeCall): ProgramEndpoints {
  const endpoints: ProgramEndpoints = {
    list: (options) => call<ProgramEndpointBinding[]>('endpoints.list', null, options),
    publish: (id, { port }, options) => call<ProgramEndpointBinding>('endpoints.publish', { id, port }, options),
    unpublish: (id, { port } = {}, options) => call<ProgramEndpointBinding>('endpoints.unpublish', { id, ...(port === undefined ? {} : { port }) }, options),
    listen: (id, server, options) => listenProgramEndpoint(endpoints, id, server, options),
  };
  return endpoints;
}

/**
 * Bind a fresh Node net/http/https server using authoritative bridge configuration.
 * Existing published ports and the app's environment do not choose the bind address.
 * Frameworks managing their own listeners can instead use list/publish/unpublish.
 */
export async function listenProgramEndpoint(endpoints: Pick<ProgramEndpoints, 'list' | 'publish' | 'unpublish'>, id: string, server: Server, options: CallOptions = {}): Promise<ListeningProgramEndpoint> {
  if (!endpointName(id)) throw new ProgramError('INVALID_INPUT', 'Invalid endpoint id');
  if (server.listening || managedServers.has(server)) throw new ProgramError('BUSY', 'Endpoint helper requires an unbound, unmanaged server');
  managedServers.add(server);
  let attemptedBind = false;
  let closed = false;
  let setupComplete = false;
  let setupFailed = false;
  let setupError: unknown;
  let port: number | undefined;
  let publication: Promise<ProgramEndpointBinding> | undefined;
  let unpublication: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let rejectSetup!: (error: unknown) => void;
  let resolveListening!: () => void;
  const interrupted = new Promise<never>((_resolve, reject) => { rejectSetup = reject; });
  // An error can arrive between awaited setup stages, before the next race attaches.
  void interrupted.catch(() => {});
  const listening = new Promise<void>((resolve) => { resolveListening = resolve; });
  const onListening = () => resolveListening();
  const failSetup = (error: unknown) => {
    if (!setupFailed) { setupFailed = true; setupError = error; }
    rejectSetup(error);
  };
  const onError = (error: Error) => failSetup(error);
  const onAbort = () => failSetup(cancelled());
  const unpublish = (): Promise<void> => {
    if (!publication || port === undefined) return Promise.resolve();
    // A close during publication must unpublish AFTER that call settles, not before it.
    return unpublication ??= (async () => {
      await publication.catch(() => {});
      await endpoints.unpublish(id, { port });
    })();
  };
  const onClose = () => {
    closed = true;
    if (!setupComplete) failSetup(unavailable());
    else managedServers.delete(server);
    // Event callbacks cannot report a rejection; handle.close() still awaits/reports it.
    if (publication) void unpublish().catch(() => {});
  };
  const removeSetupListeners = () => {
    server.removeListener('listening', onListening);
    server.removeListener('error', onError);
    options.signal?.removeEventListener('abort', onAbort);
  };
  const closeServer = (): Promise<void> => new Promise((resolve, reject) => {
    // Calling close also cancels an in-progress DNS/bind attempt. Do not merely test
    // server.listening: it is false while listen is still acquiring its socket.
    try {
      server.close((error?: Error) => {
        if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
        else resolve();
      });
    } catch (error) { reject(error); }
  });
  try {
    const bindings = await endpoints.list(options);
    const binding = Array.isArray(bindings) ? bindings.find((item) => item?.id === id) : undefined;
    if (!binding) throw new ProgramError('NOT_FOUND', `Endpoint ${id} is not configured`);
    if (typeof binding.bindHost !== 'string' || !binding.bindHost || !Number.isSafeInteger(binding.requestedPort) || binding.requestedPort < 0 || binding.requestedPort > 65535 || !['http', 'https'].includes(binding.protocol)) throw new ProgramError('INVALID_RESPONSE', 'Invalid endpoint binding configuration');
    if (options.signal?.aborted) throw cancelled();
    // Do not take ownership of a server that somebody bound while list was pending.
    if (server.listening) throw new ProgramError('BUSY', 'Endpoint server was bound during configuration lookup');
    server.once('listening', onListening);
    server.on('error', onError);
    server.once('close', onClose);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    attemptedBind = true;
    server.listen({ port: binding.requestedPort, host: unbracket(binding.bindHost) });
    await Promise.race([listening, interrupted]);
    if (setupFailed) throw setupError;
    if (options.signal?.aborted) throw cancelled();
    if (closed || !server.listening) throw unavailable();
    const address = server.address();
    if (!address || typeof address === 'string' || !Number.isSafeInteger(address.port) || address.port < 1 || address.port > 65535) throw new ProgramError('UNAVAILABLE', 'Endpoint server did not bind a TCP port');
    port = address.port;
    publication = endpoints.publish(id, { port }, options);
    await Promise.race([publication, interrupted]);
    if (setupFailed) throw setupError;
    if (options.signal?.aborted) throw cancelled();
    if (closed || !server.listening) throw unavailable();
    setupComplete = true;
    removeSetupListeners();
    let localHost = unbracket(binding.bindHost);
    if (localHost === '0.0.0.0') localHost = '127.0.0.1';
    else if (localHost === '::') localHost = '::1';
    if (localHost.includes(':')) localHost = `[${localHost}]`;
    return {
      port,
      host: binding.bindHost,
      localUrl: `${binding.protocol}://${localHost}:${port}/`,
      close: () => closing ??= (async () => {
        if (!closed) await closeServer();
        await unpublish();
      })(),
    };
  } catch (error) {
    setupComplete = true;
    removeSetupListeners();
    // Publish failures/cancellation have potentially unknown effects, so compensate
    // once with the exact port. A failed bind never publishes or unpublishes.
    if (attemptedBind && !closed) await closeServer().catch(() => {});
    await unpublish().catch(() => {});
    server.removeListener('close', onClose);
    managedServers.delete(server);
    throw error;
  }
}
