# Installation and integration

## Status

Local experimental source package, not published. Targets DSH0.2.1-rc.2, Cordis4.0.5. Node22.18+ with erasable TS or precompiled JS. Build with pnpm (lockfile committed). No automatic mutation of a user's profiles, credentials, model settings or running server.

## Host and web contribution

Mount the built `dist/host/index.js` as a Host loader entry (see README). DSH finds the nearest package manifest, discovers `dsh.client`, and serves the lazy-CJS `dist/client.js` export. Do not mount the browser bundle itself as a host entry. The host provides `programAgents` and five `program_*` tools. The browser contributes `conversation.input.dock`, keyed by its exact session id.

The web UI uses existing DSH Connection owner authentication on four exact Fetch routes `/api/programAgents/{list,send,stop,restart}`. The rc.2 dedicated `connection.rpc.handle` path has a provider-side `webServer` injection defect, so it is deliberately not used. Exact Fetch routes are a supported extension point, checked before the Gateway interceptor. The Gateway owns the `/api` interceptor and this plugin never replaces it. Only owner principals may list/control through the browser. Program processes receive no browser credential. Model-facing tools derive owner identity from `exec.agent`, not model arguments; direct program messages and capability calls derive it from the host run, not child-provided identities.

When adding a new local plugin to an existing GUI, follow DSH's normal install/HMR lifecycle and verify the existing GUI URL after a refresh. Building this repository alone is not a claim that an already-running GUI has loaded the plugin. No replacement GUI server is needed. Repository tests mount the host in isolated Cordis and exercise the actual installed client carrier in an isolated VM; they do not install into your personal profile.

## Configuration

Program names select trusted definitions. `entry` should be absolute; optional `cwd`, fixed `args`, explicit `env`, `allowedCapabilities`. SDK intrinsics (inbox, parent.send, status, resources) are available without a grant. Generic host capabilities require exact named grants; `models.call` additionally requires a provider/model route; `tools.call` additionally requires exact tool names visible to the live parent. Defaults deny both.

No direct UI start endpoint exists. Launching happens through the parent's `program_start`, subject to its tool policy. JS plugins can use `ctx.programAgents.adapter.start(exactLiveAgent, configuredName, input, label, signal)`; direct runtime API is trusted host code, not a public unauthenticated endpoint.

Configuration has `auditDirectory`, `maxRuns`, `maxHistory`, `startupTimeoutMs`, `stopTimeoutMs`, and `callTimeoutMs`. Defaults8live/64terminal history,10sstartup,3sgrace,120scapabilitycalls. Runtime hard caps and bounded protocol are independent of configured higher-level grants. Long local-model calls may need a longer explicit call deadline. Parent program messages wake/steer an idle/busy parent respectively; passive status/logs never wake it. Terminal notice is injected for next natural step without automatically reviving the parent.

## Supported v0.1 versus deferred

Implemented: real Node process lifecycle, explicit restart/generation revocation, parent/inbox JSON, unary text model calls/usage/finish, native DSH tool policy dispatch, named capability extensions, status/logs, HTTP(S) resource links, session-scoped web controls, bounded private audit journal.

Deferred: token streaming SDK, program-spawned LLM children, native subagent-tree membership, Python, iframe dashboard embedding, automatic proxy/tunnels, restart-on-crash, app-state restore/replay, external persistent agent services. These are deliberately not represented by fake working APIs.

## Recovery

Parent Agents are captured exactly, not looked up by id alone for authority. Disposal revokes the owner and stops owned programs, including racing restart. Parent turn completion does not revoke runs. Plugin unload stops all runs and closes its journal. A process crash marks links unavailable. Old-generation messages/controls cannot affect a new run. A failed hard shutdown prevents restart rather than allow overlap.

Programs own durable storage and effect deduplication. DSH plugin audit is diagnostic/reconstructable model call evidence only; it does not restore in-memory programs after host restart. Unknown outcomes require external verification.
