# DSH browser contribution

Browser half of `@tkellogg/dsh-program-agents` for DSH `0.2.1-rc.2`.
The public `conversation.input.dock` contribution remains in the bottom composer
seat: a tiny, collapsed-by-default **Program agents (N)** status strip, not a
standalone page or a fixed-position overlay. Opening it shows compact rows in a
scrollable foldout bounded by `min(240px, 35vh)`. Expansion persists across push
updates and generation changes. Switching Session remounts the local UI.

## Integration contract

The entry exports `inject = ['slots', 'connection']` and `apply(ctx)`. Package
client injections include Connection, conversation and renderer. Bundle for the
browser, sharing DSH's React copy, and register via its module loader. No Node
runtime code belongs in this bundle.

`createProgramClient(ctx.connection, sessionId)` uses actual public RPC for effects:

```ts
ctx.connection.rpc.call('/api', 'programAgents/start', { sessionId, program }, signal);
ctx.connection.rpc.call('/api', 'programAgents/stop', { sessionId, id, generation }, signal);
ctx.connection.rpc.call('/api', 'programAgents/restart', { sessionId, id, generation }, signal);
```

The installed rc.2 public browser ConnectionHandle has no streaming HTTP request
facade. Streaming therefore uses native fetch to
`new URL('api/programAgents/events', document.baseURI)`, with `POST`,
`credentials: 'same-origin'`, `redirect: 'error'`, JSON `{sessionId}` and an
AbortSignal. It does not access private Connection fields or invent an API.
A streaming fetch implementation can also be passed explicitly for tests.

The authenticated host route returns `text/event-stream`. At connect and after
coalesced changes it sends complete compact state:

```text
event: snapshot
data: {"runs":[],"programs":[]}

```

Comments are heartbeat-only. Frames are bounded to 128 KiB (bytes), fragmented
UTF-8/CRLF and multiline data are supported, incomplete final events are ignored.
There are no logs or message bodies in the pushed state. The client discards
legacy log/message/result fields rather than retaining or rendering them.

Descriptors are `{ program, name, description, command: string[], urls, logsPath? }`.
Resources are `{ id, title, type: 'ui'|'api'|'docs', url, docs?, available }`.
Each UI item merges a descriptor with the latest owned run by opaque `program`
key. Legacy `{runs}` lists are accepted. Counts reflect programs, not historical
run duplication. Optional `list(signal)` is available to callers; the controller
never calls it and has no state polling timer.

## Lifecycle and UI safety

- Streams reconnect with bounded exponential backoff after EOF/error; each new
  full baseline self-heals state. Late callbacks are fenced by stream epoch.
- Hidden tabs abort their stream and retry timer; becoming visible opens a fresh
  stream. Disconnects retain names/status but mark stale, revoking links/actions.
- Start is offered for configured or terminal programs; active runs offer Stop
  and Restart. Start is single-flight, and Stop/Restart bind exact run generation.
  Action failure never replays the effect: only the stream baseline reconnects.
  RPC effects have a 20-second deadline. Host ownership/generation checks remain
  authoritative; client filtering is defense in depth.
- Rows show name, state, typed links and controls. Optional More reveals only
  description, command, log path and local documentation paths. No Refresh,
  message forms, recent logs, raw run IDs, generation labels or default warnings.
- Only absolute HTTP(S) resources without credentials/controls/backslashes are
  anchors; external links use `_blank`, `noopener noreferrer`, `no-referrer`.
  Local documentation paths are displayed/copyable, never `file://` anchors.
  There are no embedded resources, probes or program-resource fetches.

Tests exercise the pure model/controller, actual React DOM foldout, exact RPC
args, Session changes, single-flight/fenced effects, SSE parser bounds and abort,
reconnect/no-poll behavior, plus an optional isolated installed-browser carrier.
