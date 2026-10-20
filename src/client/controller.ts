import { boundedText, runControls, type ProgramAction, type ProgramItem, type ProgramRun, type RunList } from './model.js';
import type { ProgramClient } from './transport.js';

export interface ProgramPanelState extends RunList {
  loading: boolean;
  stale: boolean;
  error?: string;
  pending: Readonly<Record<string, ProgramAction>>;
  actionErrors: Readonly<Record<string, string>>;
}
export const actionKey = (item: ProgramItem | ProgramRun): string => item.program;
const errorText = (error: unknown): string => boundedText(error instanceof Error ? error.message : 'Connection unavailable.', 180);
/** One Session's SSE lifecycle. Timers retry disconnected streams, never poll state
 * or replay effects. Every replacement stream owns a fresh snapshot epoch. */
export function createPanelController(client: ProgramClient, reconnectDelayMs = 1_000) {
  let state: ProgramPanelState = { runs: [], programs: [], items: [], loading: true, stale: true, truncated: false, pending: {}, actionErrors: {} };
  const listeners = new Set<() => void>();
  let active = false, visible = true, epoch = 0, failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stream: AbortController | undefined;
  const actions = new Map<string, AbortController>();
  // A fast RPC acknowledgement must not reopen Start before its pushed state
  // arrives. Keep the effect single-flight through authoritative transition.
  const awaiting = new Map<string, ProgramRun | undefined>();
  const sameRun = (left?: ProgramRun, right?: ProgramRun) => left?.id === right?.id && left?.generation === right?.generation && left?.state === right?.state;
  const publish = (patch: Partial<ProgramPanelState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const clearTimer = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  const invalidate = () => { epoch++; clearTimer(); stream?.abort(); };
  function connect(): void {
    if (!active || !visible) return;
    invalidate();
    const abort = new AbortController(); stream = abort;
    const current = epoch;
    let baseline = true;
    publish({ loading: true, stale: true });
    const latest = () => active && visible && !abort.signal.aborted && current === epoch;
    void (async () => {
      try {
        await client.subscribe(result => {
          if (!latest()) return;
          failures = 0;
          const errors = Object.fromEntries(Object.entries(state.actionErrors).filter(([key]) => {
            const before = state.items.find(item => item.program === key)?.run;
            const after = result.items.find(item => item.program === key)?.run;
            return before?.id === after?.id && before?.generation === after?.generation;
          }));
          const pending = { ...state.pending };
          for (const [key, before] of awaiting) {
            const after = result.items.find(item => item.program === key)?.run;
            if (baseline || !sameRun(before, after)) { awaiting.delete(key); delete pending[key]; }
          }
          baseline = false;
          publish({ ...result, loading: false, stale: false, error: undefined, actionErrors: errors, pending });
        }, abort.signal);
        if (latest()) throw new Error('Connection interrupted.');
      } catch (error) {
        if (!latest()) return;
        publish({ loading: false, stale: true, error: errorText(error) });
        // End this epoch immediately: a carrier ignoring cancellation cannot
        // re-enable controls during backoff with a late snapshot.
        abort.abort(); epoch++;
        const delay = Math.min(30_000, Math.max(1, reconnectDelayMs) * 2 ** Math.min(failures++, 5));
        timer = setTimeout(() => { timer = undefined; connect(); }, delay);
      }
    })();
  }
  return {
    getSnapshot: (): ProgramPanelState => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start() { if (active) return; active = true; connect(); },
    stop() {
      active = false; invalidate();
      for (const action of actions.values()) action.abort();
      actions.clear(); awaiting.clear(); publish({ loading: false, stale: true, pending: {} });
    },
    setVisible(next: boolean) {
      if (visible === next) return;
      visible = next;
      if (next) connect();
      else { invalidate(); publish({ loading: false, stale: true }); }
    },
    async action(action: ProgramAction, target: ProgramItem | ProgramRun): Promise<boolean> {
      const key = actionKey(target);
      const latest = state.items.find(item => item.program === target.program);
      const expected = 'ownerId' in target ? target : target.run;
      if (!active || !visible || !latest || actions.has(key) || state.pending[key] ||
        latest.run?.id !== expected?.id || latest.run?.generation !== expected?.generation ||
        !runControls(latest.run?.state ?? 'configured', false, state.stale)[action]) return false;
      const abort = new AbortController(); actions.set(key, abort);
      publish({ pending: { ...state.pending, [key]: action }, actionErrors: { ...state.actionErrors, [key]: '' } });
      try {
        await client.action(action, latest, abort.signal);
        if (!active || abort.signal.aborted) return false;
        const after = state.items.find(item => item.program === key)?.run;
        if (sameRun(expected, after)) awaiting.set(key, expected);
        return true;
      } catch (error) {
        if (active && !abort.signal.aborted) {
          publish({ stale: true, actionErrors: { ...state.actionErrors, [key]: errorText(error) } });
          // A fresh stream baseline self-heals ambiguous results; never retry the
          // action and never start a list polling loop.
          connect();
        }
        return false;
      } finally {
        if (actions.get(key) === abort) {
          actions.delete(key);
          const next = { ...state.pending };
          if (!awaiting.has(key)) delete next[key];
          if (active) publish({ pending: next });
        }
      }
    },
  };
}
export type PanelController = ReturnType<typeof createPanelController>;
