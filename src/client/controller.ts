import { boundedText, runControls, type ProgramAction, type ProgramRun } from './model.js';
import type { ProgramClient } from './transport.js';

export interface ProgramPanelState {
  runs: ProgramRun[];
  loading: boolean;
  stale: boolean;
  truncated: boolean;
  error?: string;
  pending: Readonly<Record<string, ProgramAction>>;
  actionErrors: Readonly<Record<string, string>>;
}
export const actionKey = (run: ProgramRun): string => `${run.id}:${run.generation}`;
const errorText = (error: unknown): string => boundedText(error instanceof Error ? error.message : 'Program agents are unavailable.');
/** One mounted Session's state; serialized reads, generation-bound actions, no effect replay. */
export function createPanelController(client: ProgramClient, pollIntervalMs = 3_000) {
  let state: ProgramPanelState = { runs: [], loading: true, stale: true, truncated: false, pending: {}, actionErrors: {} };
  const listeners = new Set<() => void>();
  let active = false;
  let visible = true;
  let epoch = 0;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let read: AbortController | undefined;
  const actions = new Map<string, AbortController>();
  const publish = (patch: Partial<ProgramPanelState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const clearTimer = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  const schedule = () => {
    clearTimer();
    if (!active || !visible || pollIntervalMs <= 0) return;
    timer = setTimeout(() => { void refresh(); }, Math.min(30_000, pollIntervalMs * 2 ** Math.min(failures, 3)));
  };
  async function refresh(): Promise<void> {
    if (!active || !visible) return;
    clearTimer();
    read?.abort();
    read = new AbortController();
    const signal = read.signal;
    const current = ++epoch;
    publish({ loading: true });
    try {
      const result = await client.list(signal);
      if (!active || signal.aborted || current !== epoch) return;
      failures = 0;
      const liveKeys = new Set(result.runs.map(actionKey));
      publish({ ...result, loading: false, stale: false, error: undefined,
        actionErrors: Object.fromEntries(Object.entries(state.actionErrors).filter(([key]) => liveKeys.has(key))),
      });
    } catch (error) {
      if (!active || signal.aborted || current !== epoch) return;
      failures++;
      // Keep history visible but revoke stale links and controls until a successful read.
      publish({ loading: false, stale: true, error: errorText(error) });
    } finally {
      if (active && !signal.aborted && current === epoch) schedule();
    }
  }
  return {
    getSnapshot: (): ProgramPanelState => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start() { if (active) return; active = true; void refresh(); },
    stop() {
      active = false; epoch++; clearTimer(); read?.abort();
      for (const action of actions.values()) action.abort();
      actions.clear();
      publish({ loading: false, stale: true, pending: {} });
    },
    setVisible(next: boolean) {
      if (visible === next) return;
      visible = next;
      if (next) { void refresh(); }
      else { epoch++; read?.abort(); clearTimer(); publish({ loading: false, stale: true }); }
    },
    refresh,
    async action(action: ProgramAction, run: ProgramRun, body?: unknown): Promise<boolean> {
      const key = actionKey(run);
      const latest = state.runs.find(item => item.id === run.id);
      if (!active || !latest || latest.generation !== run.generation || actions.has(key) || !runControls(latest.state, false, state.stale)[action]) return false;
      const abort = new AbortController();
      actions.set(key, abort);
      publish({ pending: { ...state.pending, [key]: action }, actionErrors: { ...state.actionErrors, [key]: '' } });
      try {
        await client.action(action, run, body, abort.signal);
        if (!active || abort.signal.aborted) return false;
        await refresh();
        return true;
      } catch (error) {
        if (active && !abort.signal.aborted) {
          publish({ stale: true, actionErrors: { ...state.actionErrors, [key]: errorText(error) } });
          // Read authoritative state after an ambiguous failure. This is a read,
          // never an automatic retry of the possibly committed mutation.
          await refresh();
        }
        return false;
      } finally {
        if (actions.get(key) === abort) {
          actions.delete(key);
          const next = { ...state.pending }; delete next[key];
          if (active) publish({ pending: next });
        }
      }
    },
  };
}
export type PanelController = ReturnType<typeof createPanelController>;
