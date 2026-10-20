import { createProgramClient, type RpcTransport } from './transport.js';
import { ProgramAgentsDock } from './view.js';

// Public service/slot faces deliberately structural: no Node-side DSH package can
// accidentally enter the browser bundle. These match DSH 0.2.1-rc.2's actual APIs.
interface ClientContext {
  connection: { rpc: RpcTransport };
  slots: {
    inject(name: string, register: () => unknown): unknown;
    register(options: {
      name: string;
      id: string;
      order: number;
      inject(sessionId: string): { programClient: ReturnType<typeof createProgramClient> };
    }, component: typeof ProgramAgentsDock): unknown;
  };
}
export const inject = ['slots', 'connection'];
/** Real DSH contribution: strict Session-scoped full-width dock above the composer. */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'program-agents',
    order: 30,
    inject: (sessionId) => ({ programClient: createProgramClient(ctx.connection, sessionId) }),
  }, ProgramAgentsDock));
}
export { ProgramAgentsDock, ProgramAgentsPanel } from './view.js';
