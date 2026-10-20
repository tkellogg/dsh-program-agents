import { createElement as h, useEffect, useMemo, useState, useSyncExternalStore, type CSSProperties, type FormEvent } from 'react';
import { actionKey, createPanelController, type PanelController, type ProgramPanelState } from './controller.js';
import { CLIENT_LIMITS, formatJson, parseMessage, resourceLink, runControls, type ProgramAction, type ProgramRun } from './model.js';
import type { ProgramClient } from './transport.js';

const panelStyle: CSSProperties = {
  boxSizing: 'border-box', width: '100%', maxWidth: 'var(--dsh-composer-card-max-width, 960px)',
  margin: '0 auto 8px', border: '1px solid var(--dsw-alias-border-l1, #8885)', borderRadius: 10,
  background: 'var(--dsw-specific-menu, Canvas)', color: 'var(--dsw-alias-label-primary, CanvasText)', fontSize: 13,
};
const rowStyle: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' };
const buttonStyle: CSSProperties = { font: 'inherit', color: 'inherit', background: 'transparent', border: '1px solid var(--dsw-alias-border-l1, #8888)', borderRadius: 6, padding: '4px 9px', cursor: 'pointer' };
const preStyle: CSSProperties = { margin: '6px 0', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 12, maxHeight: 180, overflow: 'auto', borderRadius: 4, background: 'var(--dsw-alias-interactive-bg-hover, #8881)', padding: 8 };
const errorStyle: CSSProperties = { color: 'var(--dsw-alias-state-error-primary, #bc3333)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: '6px 0' };
function button(label: string, disabled: boolean, onClick: () => void, extra: Record<string, unknown> = {}) {
  return h('button', { type: 'button', style: { ...buttonStyle, opacity: disabled ? 0.5 : 1 }, disabled, onClick, ...extra }, label);
}
function RunCard({ run, state, controller }: { run: ProgramRun; state: ProgramPanelState; controller: PanelController }) {
  const key = actionKey(run);
  const pending = state.pending[key];
  const controls = runControls(run.state, Boolean(pending), state.stale);
  const [draft, setDraft] = useState('');
  const [jsonMode, setJsonMode] = useState(false);
  const [validation, setValidation] = useState('');
  const send = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!controls.send) return;
    let body: unknown;
    try { body = parseMessage(draft, jsonMode); setValidation(''); }
    catch (error) { setValidation(error instanceof Error ? error.message : 'Invalid message.'); return; }
    void controller.action('send', run, body).then(sent => { if (sent) setDraft(previous => previous === draft ? '' : previous); });
  };
  const perform = (action: ProgramAction) => { void controller.action(action, run); };
  return h('article', { 'data-program-id': run.id, 'data-generation': run.generation, style: { padding: 12, borderTop: '1px solid var(--dsw-alias-border-l1, #8885)', overflowWrap: 'anywhere' } },
    h('div', { style: rowStyle },
      h('strong', { style: { flex: '1 1 180px' } }, run.label || run.program || 'Program'),
      h('span', { 'data-program-state': run.state, style: { fontWeight: 600 } }, run.state),
      h('span', { style: { opacity: 0.7 } }, `generation ${run.generation}`),
    ),
    h('div', { style: { fontSize: 11, opacity: 0.7, marginTop: 4 } }, `${run.program} · ${run.id}`),
    run.status ? h('p', { style: { margin: '6px 0', whiteSpace: 'pre-wrap' } }, run.status) : null,
    run.error ? h('p', { style: errorStyle }, run.error) : null,
    run.endedAt ? h('div', { style: { fontSize: 11, opacity: 0.7, margin: '4px 0' } }, `Ended ${run.endedAt}`) : null,
    h('div', { style: rowStyle },
      button(pending === 'stop' ? 'Stopping…' : 'Stop', !controls.stop, () => perform('stop')),
      button(pending === 'restart' ? 'Restarting…' : 'Restart', !controls.restart, () => perform('restart'), { title: 'Explicitly start a new generation after the previous process exits.' }),
      pending ? h('span', { role: 'status' }, pending === 'send' ? 'Sending…' : 'Action pending…') : null,
    ),
    state.actionErrors[key] ? h('p', { role: 'alert', style: errorStyle }, state.actionErrors[key]) : null,
    run.resources.length ? h('ul', { 'aria-label': 'Program resources', style: { paddingLeft: 20, margin: '8px 0' } },
      ...run.resources.map((resource, index) => {
        const href = resourceLink(run, resource, state.stale, pending);
        const title = resource.title || resource.id || 'Resource';
        return h('li', { key: `${resource.id}:${index}` }, href
          ? h('a', { href, target: '_blank', rel: 'noopener noreferrer', referrerPolicy: 'no-referrer', style: { color: 'var(--dsw-alias-link-primary, LinkText)' } }, `${title} ↗`)
          : h('span', { 'aria-disabled': true, style: { opacity: 0.6 }, title: 'Resource unavailable, stale, stopped, or not an absolute HTTP(S) URL.' }, `${title} — unavailable`));
      }),
    ) : null,
    run.logs.length ? h('details', null,
      h('summary', { style: { cursor: 'pointer', marginTop: 8 } }, `Recent logs (${run.logs.length}; bounded)`),
      h('pre', { style: preStyle, 'aria-label': 'Recent program logs' }, ...run.logs.map((log, index) => h('span', { key: `${log.sequence}:${index}`, style: { display: 'block' } }, `[${log.stream}] ${log.text}`))),
    ) : null,
    run.messages.length ? h('details', null,
      h('summary', { style: { cursor: 'pointer', marginTop: 8 } }, `Recent messages (${run.messages.length}; bounded)`),
      ...run.messages.map((message, index) => h('div', { key: index },
        h('div', { style: { marginTop: 6, fontSize: 11, opacity: 0.7 } }, `${message.direction === 'program' ? 'Program → parent' : 'Parent → program'} · ${message.at}`),
        h('pre', { style: preStyle }, formatJson(message.body)),
      )),
    ) : null,
    run.result !== undefined ? h('details', null, h('summary', { style: { cursor: 'pointer', marginTop: 8 } }, 'Result'), h('pre', { style: preStyle }, formatJson(run.result))) : null,
    h('form', { onSubmit: send, style: { marginTop: 10 } },
      h('label', { style: { display: 'block' } }, 'Message to program',
        h('textarea', { 'aria-label': 'Message to program', rows: 2, value: draft, maxLength: CLIENT_LIMITS.inputCharacters, disabled: !controls.send,
          onChange: (event: { currentTarget: HTMLTextAreaElement }) => setDraft(event.currentTarget.value),
          placeholder: controls.send ? 'Send text to this program’s inbox' : 'Messages require a running or blocked program',
          style: { display: 'block', boxSizing: 'border-box', marginTop: 4, width: '100%', font: 'inherit', color: 'inherit', background: 'transparent', border: '1px solid var(--dsw-alias-border-l1, #8888)', borderRadius: 6, padding: 6, resize: 'vertical', maxHeight: 160 },
        }),
      ),
      h('div', { style: { ...rowStyle, marginTop: 6 } },
        h('label', null, h('input', { type: 'checkbox', checked: jsonMode, disabled: !controls.send, onChange: (event: { currentTarget: HTMLInputElement }) => setJsonMode(event.currentTarget.checked) }), ' JSON body'),
        h('button', { type: 'submit', style: buttonStyle, disabled: !controls.send || !draft.trim() }, pending === 'send' ? 'Sending…' : 'Send'),
      ),
      validation ? h('p', { role: 'alert', style: errorStyle }, validation) : null,
    ),
  );
}
/** Public component is injectable for DOM tests; the actual entry mounts it in a strict Session slot. */
export function ProgramAgentsPanel({ client, pollIntervalMs = 3_000 }: { client: ProgramClient; pollIntervalMs?: number }) {
  const controller = useMemo(() => createPanelController(client, pollIntervalMs), [client, pollIntervalMs]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => {
    const changed = () => controller.setVisible(typeof document === 'undefined' || document.visibilityState !== 'hidden');
    changed(); controller.start();
    document.addEventListener('visibilitychange', changed);
    return () => { document.removeEventListener('visibilitychange', changed); controller.stop(); };
  }, [controller]);
  const [open, setOpen] = useState(false);
  return h('section', { 'aria-label': 'Program agents', 'data-session-id': client.sessionId, style: panelStyle },
    h('div', { style: { ...rowStyle, padding: '7px 10px' } },
      button(`${open ? '▾' : '▸'} Program agents${state.runs.length ? ` (${state.runs.length})` : ''}`, false, () => setOpen(!open), { 'aria-expanded': open, style: { ...buttonStyle, border: 0, flex: 1, textAlign: 'left' } }),
      h('span', { role: 'status', style: { fontSize: 11, opacity: 0.75 } }, state.error ? 'Unavailable' : state.loading ? 'Refreshing…' : 'Session scoped'),
      button('Refresh', state.loading, () => { void controller.refresh(); }),
    ),
    open ? h('div', { style: { maxHeight: 460, overflow: 'auto' } },
      h('p', { style: { margin: '0 12px 8px', fontSize: 11, opacity: 0.7 } }, 'Supervised trusted programs, not a sandbox. Links open externally; this panel never embeds or fetches program resources.'),
      state.error ? h('p', { role: 'alert', style: { ...errorStyle, margin: '8px 12px' } }, `Program agents unavailable: ${state.error} Links and controls are disabled until refreshed.`) : null,
      !state.runs.length && !state.loading && !state.error ? h('p', { style: { padding: '0 12px' } }, 'No programs in this Session. Start one with the program_start tool.') : null,
      state.truncated ? h('p', { style: { padding: '0 12px', fontSize: 11 } }, `Showing up to ${CLIENT_LIMITS.runs} programs; older entries are omitted.`) : null,
      ...state.runs.map(run => h(RunCard, { key: actionKey(run), run, state, controller })),
    ) : null,
  );
}
/** A Session switch always remounts local drafts/state; no previous Session content can flash. */
export function ProgramAgentsDock({ programClient }: { programClient: ProgramClient }) {
  return h(ProgramAgentsPanel, { key: programClient.sessionId, client: programClient });
}
