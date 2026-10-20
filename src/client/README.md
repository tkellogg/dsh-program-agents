# DSH browser contribution

This is the browser half of `@tkellogg/dsh-program-agents`, targeting DSH
`0.2.1-rc.2`. It registers the public `conversation.input.dock` list slot, not a
standalone page/server. DSH calls the entry's `inject(sessionId)` for the strict
Session scope. A Session switch remounts local cards and drafts. The browser also
filters every snapshot by its exact `ownerId` before displaying it.

## Integration contract

`index.ts` exports `inject = ['slots', 'connection']` and `apply(ctx)`.
The package's `dsh.client` declaration needs `platform: 'web'` and package
injections for `@deepseek-ai/dsh-client-connection`,
`@deepseek-ai/dsh-client-ui-conversation`, and
`@deepseek-ai/dsh-client-ui-renderer`. The `./client` package export points to the
built browser artifact.

Bundle the entry with esbuild `platform: 'browser', format: 'cjs'`, sharing
`react` rather than bundling another React copy. Register the output lazily:

```js
window.__ModuleLoader__.load({
  id: '@tkellogg/dsh-program-agents',
  factory: require => {
    var module = { exports: {} };
    var exports = module.exports;
    // CJS bundle body
    return module.exports;
  },
});
```

The controller uses DSH's existing authenticated, mount-aware transport:

```ts
ctx.connection.rpc.call('/program-agents', 'list', { sessionId }, signal);
ctx.connection.rpc.call('/program-agents', 'send', { sessionId, id, generation, body }, signal);
ctx.connection.rpc.call('/program-agents', 'stop', { sessionId, id, generation }, signal);
ctx.connection.rpc.call('/program-agents', 'restart', { sessionId, id, generation }, signal);
```

The host registers the dedicated authenticated logical channel with
`ctx.connection.rpc.handle('/program-agents', handler)`. Do not intercept `/api`:
DSH's API Gateway already owns its sole interceptor. The Connection carrier
validates authentication, method/path matching and request/response envelopes.

Connection results are `{ ok: true, value }` or
`{ ok: false, error: { code, message, details } }`. List's value is
`{ runs: ProgramSnapshot[] }`. Successful mutations are followed by a list read;
the client does not depend on their value. The host must authenticate the owner
Peer, validate the live Session, enforce exact snapshot ownership, and check the
expected generation before mutation. Client-side filtering is defense in depth,
not an authorization boundary.

## MVP scope and limitations

- Collapsed-by-default composer dock; no dedicated navigation page or start UI.
  Programs are launched with the configured `program_start` tool.
- One serialized read every three seconds while mounted in a visible tab, with
  bounded exponential error backoff. Hidden tabs pause reads and revoke stale
  controls/links. There is no event-stream subscription or execution-state replay.
- Active programs sort ahead of terminal history, then newest start time first.
  The UI keeps at most 50 cards, 150 recent log entries with roughly 64 KB total
  text per card, 50 messages, and 30 resources. Individual displayed strings and
  nested JSON rendering are also bounded. This is not a complete history viewer.
- Stop/restart/send show pending and host errors. All requests have a 20-second
  client deadline and mutations include a generation fence. A failed mutation
  triggers only a state read, never an effect retry. Restart is offered only after terminal state; the runtime must additionally
  prove process-group exit before allowing it.
- Messages default to text. Explicit JSON mode rejects invalid JSON locally.
  A new generation remounts its draft, so stale drafts cannot target the next run.
- Only absolute `http://` and `https://` resources without credentials, control
  characters, or backslashes become anchors. Anchors use `_blank`,
  `noopener noreferrer`, and `no-referrer`. Unavailable, stale, starting, stopping,
  or terminal-generation resources are plain disabled text. There are no iframes,
  HTML injection, resource probes, embedded pages, or automatic resource fetches.
- If the host plugin/API is absent, the dock displays an unavailable/error state;
  there is no alternate launcher, custom credential handling, or replacement DSH
  server. No running DSH installation is modified by this implementation.

Client tests cover the pure boundary/controller plus actual React DOM rendering
with linkedom, mocked Connection transport, safe/disabled anchors, escaped logs,
text/JSON send, pending/errors, Session switching, and real slot registration.
