import { createElement as h, useEffect, useMemo, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { actionKey, createPanelController, type PanelController, type ProgramPanelState } from './controller.js';
import { resourceLink, runControls, safeResourceUrl, type ProgramAction, type ProgramItem } from './model.js';
import type { ProgramClient } from './transport.js';

// The conversation.input.dock lives inside DSH's bottom-anchored composer seat.
// Stay in that layout flow: no global selectors, fixed positioning or overlay.
const panelStyle: CSSProperties = {
  boxSizing: 'border-box', width: '100%', maxWidth: 'var(--dsh-composer-card-max-width, 960px)',
  margin: '0 auto 4px', border: '1px solid var(--dsw-alias-border-l1, #8884)', borderRadius: 8,
  background: 'var(--dsw-specific-menu, Canvas)', color: 'var(--dsw-alias-label-primary, CanvasText)', fontSize: 12,
};
const rowStyle: CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', minWidth: 0 };
const buttonStyle: CSSProperties = { font: 'inherit', color: 'inherit', background: 'transparent', border: '1px solid var(--dsw-alias-border-l1, #8885)', borderRadius: 5, padding: '2px 6px', cursor: 'pointer', whiteSpace: 'nowrap' };
const mutedStyle: CSSProperties = { opacity: 0.65, fontSize: 11 };
const linkStyle: CSSProperties = { color: 'var(--dsw-alias-link-primary, LinkText)', whiteSpace: 'nowrap' };
const errorStyle: CSSProperties = { color: 'var(--dsw-alias-state-error-primary, #bc3333)', fontSize: 11, margin: '3px 0 0', overflowWrap: 'anywhere' };
function button(label: string, disabled: boolean, onClick: () => void, extra: Record<string, unknown> = {}) {
  return h('button', { type: 'button', style: { ...buttonStyle, opacity: disabled ? 0.5 : 1 }, disabled, onClick, ...extra }, label);
}
function ProgramRow({ item, state, controller }: { item: ProgramItem; state: ProgramPanelState; controller: PanelController }) {
  const key = actionKey(item), pending = state.pending[key];
  const status = item.run?.state ?? 'configured';
  const controls = runControls(status, Boolean(pending), state.stale);
  const [more, setMore] = useState(false);
  const [copied, setCopied] = useState('');
  const localDocs = [...new Set(item.urls.flatMap(resource => [
    ...(resource.docs && !safeResourceUrl(resource.docs) ? [resource.docs] : []),
    ...(resource.type === 'docs' && /^(?:\/|[A-Za-z]:[\\/])/.test(resource.url) && !safeResourceUrl(resource.url) ? [resource.url] : []),
  ]))];
  const hasMore = Boolean(item.description || item.command.length || item.logsPath || localDocs.length);
  const perform = (action: ProgramAction) => { void controller.action(action, item); };
  const copy = (text: string) => {
    if (typeof navigator.clipboard?.writeText === 'function') void navigator.clipboard.writeText(text).then(() => setCopied(text), () => {});
  };
  return h('article', { 'data-program-key': item.program, style: { padding: '6px 9px', borderTop: '1px solid var(--dsw-alias-border-l1, #8883)' } },
    h('div', { style: rowStyle },
      h('strong', { title: item.name, style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: '1 1 100px' } }, item.name),
      h('span', { 'data-program-state': status, title: item.run?.status, style: mutedStyle }, status),
      h('span', { 'aria-label': 'Program resources', style: { ...rowStyle, gap: 6, flexWrap: 'wrap' } }, ...item.urls.flatMap((resource, index) => {
        const href = resourceLink(item, resource, state.stale, pending);
        const label = resource.type.toUpperCase();
        const docsHref = resource.docs && safeResourceUrl(resource.docs);
        return [href
          ? h('a', { key: `${index}:url`, href, target: '_blank', rel: 'noopener noreferrer', referrerPolicy: 'no-referrer', title: resource.title, style: linkStyle }, label)
          : h('span', { key: `${index}:url`, 'aria-disabled': true, title: resource.title, style: mutedStyle }, label),
          ...(docsHref && resource.type !== 'docs' ? [href
            ? h('a', { key: `${index}:docs`, href: docsHref, target: '_blank', rel: 'noopener noreferrer', referrerPolicy: 'no-referrer', style: linkStyle }, 'Docs')
            : h('span', { key: `${index}:docs`, 'aria-disabled': true, style: mutedStyle }, 'Docs')] : []),
        ];
      })),
      (status === 'configured' || ['stopped', 'completed', 'failed'].includes(status)) ? button(pending === 'start' ? 'Starting…' : 'Start', !controls.start, () => perform('start')) : null,
      status !== 'configured' && !['stopped', 'completed', 'failed'].includes(status) ? button(pending === 'stop' ? 'Stopping…' : 'Stop', !controls.stop, () => perform('stop')) : null,
      status !== 'configured' ? button(pending === 'restart' ? 'Restarting…' : 'Restart', !controls.restart, () => perform('restart')) : null,
      hasMore ? button('More', false, () => setMore(!more), { 'aria-expanded': more, 'aria-label': `More about ${item.name}`, style: { ...buttonStyle, border: 0, padding: '2px 0', ...mutedStyle } }) : null,
    ),
    (state.actionErrors[key] || item.run?.error) ? h('p', { role: 'alert', style: errorStyle }, state.actionErrors[key] || item.run?.error) : null,
    more ? h('div', { 'aria-label': `${item.name} details`, style: { ...mutedStyle, marginTop: 5, overflowWrap: 'anywhere' } },
      item.description ? h('div', null, item.description) : null,
      item.command.length ? h('div', null, h('code', null, item.command.join(' '))) : null,
      item.logsPath ? h('div', null, 'Logs: ', h('code', null, item.logsPath)) : null,
      ...localDocs.map((path, index) => h('div', { key: index }, 'Docs: ', h('code', null, path), ' ', button(copied === path ? 'Copied' : 'Copy', false, () => copy(path)))),
    ) : null,
  );
}
/** Tiny status strip in the existing Session composer slot. Foldout state is
 * independent of snapshots, and rows are keyed by definition, never generation. */
export function ProgramAgentsPanel({ client, reconnectDelayMs }: { client: ProgramClient; reconnectDelayMs?: number }) {
  const controller = useMemo(() => createPanelController(client, reconnectDelayMs), [client, reconnectDelayMs]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => {
    const changed = () => controller.setVisible(document.visibilityState !== 'hidden');
    changed(); controller.start();
    document.addEventListener('visibilitychange', changed);
    return () => { document.removeEventListener('visibilitychange', changed); controller.stop(); };
  }, [controller]);
  const [open, setOpen] = useState(false);
  return h('section', { 'aria-label': 'Program agents', 'data-session-id': client.sessionId, style: panelStyle },
    h('div', { style: { ...rowStyle, padding: '3px 8px' } },
      button(`${open ? '▾' : '▸'} Program agents (${state.items.length})`, false, () => setOpen(!open), { 'aria-expanded': open, style: { ...buttonStyle, border: 0, flex: 1, textAlign: 'left', padding: '2px 0' } }),
      state.stale ? h('span', { role: 'status', title: state.error, style: mutedStyle }, state.error ? 'Reconnecting…' : state.loading ? 'Connecting…' : 'Paused') : null,
    ),
    open ? h('div', { 'data-program-foldout': true, style: { maxHeight: 'min(240px, 35vh)', overflowY: 'auto', overscrollBehavior: 'contain' } },
      !state.items.length && !state.loading ? h('div', { style: { padding: '5px 9px', ...mutedStyle } }, 'No programs configured.') : null,
      state.truncated ? h('div', { style: { padding: '3px 9px', ...mutedStyle } }, 'Showing the most recent programs.') : null,
      ...state.items.map(item => h(ProgramRow, { key: item.program, item, state, controller })),
    ) : null,
  );
}
/** A Session switch remounts local state; no previous owner's content can flash. */
export function ProgramAgentsDock({ programClient }: { programClient: ProgramClient }) {
  return h(ProgramAgentsPanel, { key: programClient.sessionId, client: programClient });
}
