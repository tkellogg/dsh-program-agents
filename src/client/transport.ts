import { parseRunList, type ProgramAction, type ProgramRun, type RunList } from './model.js';

/** Public structural face of DSH ClientConnectionRpc; supplied by ctx.connection. */
export interface RpcTransport {
  call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<
    { readonly ok: true; readonly value: unknown } |
    { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }
  >;
}
export interface ProgramClient {
  readonly sessionId: string;
  list(signal: AbortSignal): Promise<RunList>;
  action(action: ProgramAction, run: ProgramRun, body: unknown, signal: AbortSignal): Promise<void>;
}
export class ProgramApiError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = 'ProgramApiError'; this.code = code; }
}
/** Use the existing DSH authenticated/mount-aware carrier, never resource URLs. */
export function createProgramClient(rpc: RpcTransport, sessionId: string, timeoutMs = 20_000): ProgramClient {
  if (!sessionId) throw new Error('Program agents require a selected Session.');
  const call = async (method: string, payload: unknown, signal: AbortSignal): Promise<unknown> => {
    const abort = new AbortController();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let cancel: (() => void) | undefined;
    try {
      const failure = new Promise<never>((_resolve, reject) => {
        cancel = () => { abort.abort(); reject(new ProgramApiError('cancelled', 'Program agents request cancelled.')); };
        if (signal.aborted) { cancel(); return; }
        signal.addEventListener('abort', cancel, { once: true });
        deadline = setTimeout(() => {
          abort.abort();
          reject(new ProgramApiError('timeout', 'Program agents request timed out. Refresh before retrying an action.'));
        }, timeoutMs);
      });
      if (signal.aborted) return await failure;
      const reply = await Promise.race([rpc.call('/program-agents', method, payload, abort.signal), failure]);
      if (!reply.ok) throw new ProgramApiError(reply.error.code, reply.error.message);
      return reply.value;
    } finally {
      if (deadline !== undefined) clearTimeout(deadline);
      if (cancel) signal.removeEventListener('abort', cancel);
    }
  };
  return {
    sessionId,
    async list(signal) { return parseRunList(await call('list', { sessionId }, signal), sessionId); },
    async action(action, run, body, signal) {
      if (run.ownerId !== sessionId) throw new Error('Program does not belong to this Session.');
      await call(action, {
        sessionId, id: run.id, generation: run.generation,
        ...(action === 'send' ? { body } : {}),
      }, signal);
    },
  };
}
