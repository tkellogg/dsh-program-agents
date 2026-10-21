# Local installation — 2026-10-19

## Current models and native conversations revision — installed 2026-10-21

Active entry **program-agents-strip-v13**, host `dist/host/installed-v13.js` (v12 was the intermediate UI smoke revision). Existing GUI http://127.0.0.1:3080, original Node PID11160, parent/global model catalog and unrelated profile configuration preserved. Only one program plugin enabled/active. Existing Dynamic/Watch demos restored; Model preferences demo is available/running with smart-model=Sol/xhigh and cheap-local=Qwen3.8-27B. It declares settings only, not startup inference.

**225/225 tests pass**, plus strict copyable React/Hono reference typecheck. Real browser model widgets show purpose descriptions and native catalog choices; selecting local Qwen for smart-model persisted revision2, resetting restored Sol/xhigh revision3, and state survived plugin replacement. Final browser repeat also passed with zero runtime errors. Direct model calls are tested against the actual native LlmRuntime prepared-call interface (mock provider, no external API); explicit native routes remain callable independent of named preferences.

A real installed app opened a native continuable DSH child using the inherited route, subscribed before its queued prompt, received85 frames (snapshot+receipt+25durableevents+58assistant-stream frames), ended on its own turn rather than the initialization turn, and verified SIDEBAR_OK in paginated native history. Selected child-route request was correctly rejected when this exact parent's native subagent tool did not advertise model-selection arguments; no policy bypass or global model mutation. Temporary verification app completed and its persisted launch entry was removed. Child Session remains normal native history, not an independently running service.

Skill includes named model guide plus a five-file copyable React sidebar/Hono backend reference. Browser bundle has no runtime SDK/Node/bridge credentials. Context is allowlisted/bounded and appended only with new user turns; stable system/history prefixes are not rewritten. Native stream reconnection is a fresh snapshot, not promised token replay. Existing conversation routes/personas are immutable; preference changes affect new conversations and future direct slot calls. Async stream cleanup/backpressure/startup teardown regressions are included. No core DSH patches, replacement server or implicit network exposure.

## Previous tools-only revision — installed 2026-10-21

Active entry **program-agents-strip-v11**, host `dist/host/installed-v11.js`. Removed the custom registry, app/service aliases, bridge routes, grant types and configuration field. No renamed replacement registry: discovery/calls now use only the exact parent's existing DSH tool runtime and connected MCP tools. Legacy removed grants are rejected rather than silently promoted to broader tool authority. Skill/docs now describe the native tool integration only; user UI-pattern guidance remains untouched.

**176/176 tests pass** with installed carrier regressions. Negative coverage verifies the removed app/service APIs are absent, removed bridge methods cannot execute, and removed registration grants reject. Native DSH tool and MCP discovery, policy dispatch, structured/scalar results, managed inboxes and typed Agent replies remain covered. Actual GUI refresh has zero runtime exceptions and dynamic links still update across restart. Existing app health, original DSH Node PID11160, model catalog and unrelated profile settings preserved; running Dynamic/Watch demos restored.

## Previous managed API revision — installed 2026-10-21

Active entry **program-agents-strip-v10**, host `dist/host/installed-v10.js`. Plugin-only upgrade in the existing GUI http://127.0.0.1:3080; original Node PID11160 and unrelated profile/model settings preserved. Public provider metadata unchanged. Exactly one enabled/active program plugin. Existing Dynamic/Watch demos restored; disposable managed inbox smoke process stopped and its launch description removed.

**176/176 tests pass**, including installed DSH HostConnection/browser carriers. Managed receive owns asynchronous callback lifetime, lease heartbeats and settlement; real installed command smoke was received and ACKed once in private SQLite. Durable ask first-response/schema/idempotency/cancellation/ambiguity and implicit child creation are exercised with the real adapter/store and mocked delegation (no synthetic paid inference). Official MCP schemas validate discovery/calls/results; no external MCP server was invoked. Additional review regressions cover cancellation during delayed target lookup, over64 historical children, nested response framing and scalar tool results. `functions` is deprecated compatibility, not a learning subsystem.

Refreshed actual GUI in owned headless Chrome: zero Runtime exceptions, bottom-sticky compact panel, pushed dynamic URL updates across restart. Skill logging/API guidance synchronized to canonical SKILL/inboxes after concurrent-edit guards. User use-case/routing sections preserved; UI-patterns content not edited or synchronized. No browser/model credentials committed.

## Previous endpoint recipe revision — installed 2026-10-20

Active entry **program-agents-strip-v9**, host `dist/host/installed-v9.js`. Existing GUI http://127.0.0.1:3080 and Node PID11160 preserved. Added declarative `endpoints:{web:{port:"dynamic"}}`, URL endpoint/path recipes, harness bind/public host policy, app `.endpoints.listen`, per-run address publication and per-browser link resolution. Default interface remains127.0.0.1; no Tailscale/network exposure silently changed. Final build132/132 tests pass; actual GUI zero Runtime exceptions and dynamic UI/API links updated via push after restart. Live old-port collision49663→49680 verified with blocker holding old port; subsequent UI-observed restart49680→49825. Transient ports must not be hardcoded. Dynamic demo and preexisting Watch demo left running; no disposable blocker/browser processes remain. Model catalog unchanged. No skill files edited, copied, synchronized or committed during this revision; user is actively editing them. See [the endpoint skill guide](../skills/program-agents/endpoints.md).

## Previous supervision revision — installed 2026-10-20

Active entry **program-agents-strip-v8**, host `dist/host/installed-v8.js`. Existing GUI still http://127.0.0.1:3080 and original Node PID11160; no server restart/replacement, no auth/session/model changes. Model catalog before/after identical. Earlier v5/v6 entry cleanly disabled then replaced with fresh id/module URL to avoid ESM cache. Final browser refresh: zero Runtime exceptions; compact strip remains bottom sticky,95px expanded, pinned while long conversation scrolls to top. Existing Watch demo restored and healthy at http://127.0.0.1:4317/ after host upgrade.

Full strict build +106/106 tests (installed HostConnection/browser carriers included); actual command launched through live program tools, `program_inbox_send` accepted test message, app received with correlation and ACKed it. Read-only SQLite verification: acked_at set, attempts1; private app JSONL contains matching operation/message IDs. Disposable Inbox smoke process stopped and its launch description removed; no temporary smoke worker remains. Structured ERROR/model dispatch testing uses isolated exact-parent adapter and mocked recipient/delegation to avoid synthetic LLM calls; external MCP/model inference was not exercised.

Canonical program-agents skill updated in `~/.local/skills/program-agents` including inboxes.md, log-format.md and schema copies; user SKILL.md edits preserved. Existing `~/.dsh/skills` and `~/.agents/skills` symlinks unchanged. New settings and APIs documented in supervision.md. User's existing registrations were not opted into startup/restart silently.


**Superseded UI/runtime revision installed2026-10-20:** see `composer-strip.md` for current compact pushed strip, program_register/command watch support and active `program-agents-strip-v5` entry. The record below is the initial installation history, not the current transport/control design.

Installed on this Mac into the **existing web profile**, without restarting DSH.

- GUI: http://127.0.0.1:3080 (existing server, PID11160 during test)
- Profile: `~/.dsh/profiles/web/cordis.patch.yml`; new root `insert` entry id `program-agents-installed`
- Host entry: `/Users/timkellogg/code/dsh-program-agents/dist/host/installed-v2.js`
- Configured program: `dashboard`, built entry `dist/examples/dashboard.js`, cwd this checkout
- Grants: no model/tool/plugin capabilities; this demo only uses SDK status/inbox/resources
- Audit: `~/.dsh/program-agents/audit` (private0700/0600); diagnostic private backups/results in ignored `.state/install`
- Browser export: rebuilt `dist/client.js`, discovered through package manifest; actual GUI inspected after refresh. No second web server and no `dev:web` source watcher. Rebuild after source edits; do not assume source edits propagate automatically.

## Use

Refresh your existing DSH browser tab. **Program agents** appears just above the composer and is collapsed initially. Ask the parent:

> Start the configured dashboard program and send it a JSON hello message. Leave it running.

Expand the panel to see that session's program card, status, messages, Stop/Restart/Send, and **Program dashboard ↗** link. It opens in another tab. No HTML is embedded under DSH's origin. Example has no model/tool grant by design; it processes messages and displays a counter until explicitly stopped.

## Verified live

- PluginManager reports enabled/active; actual five model-facing program tools available in this already-existing agent.
- Authenticated `/api/programAgents/list` returns session-filtered snapshots; unauthenticated request401.
- Started run74223325-922e-4032-99af-37548d14f243, generation1 via real program_start. Published loopback URL and returned HTTP200. program_send accepted JSON and status/logs updated.
- Restart through authenticated API yielded generation2 after old process closure; web send accepted; web stop produced terminal stopped and resource unavailable. Test process stopped; no running demo left behind.
- Refreshed existing GUI in separately owned headless Chrome authenticated via existing owner authority: panel renders and expands, zero Runtime exceptions. Isolated browser used its own new-chat view, not user's active browser. Full live card interaction tested via authenticated endpoint; DOM card interactions also covered in local tests.
- Model catalog/default captured before+after are identical. No auth/session/model files rewritten. Profile edits restricted to plugin insertion; original private profile backup retained outside Git.
- Full build +46tests pass with both installed-host-Connection and installed-browser-carrier compatibility enabled.

## Installation fixes

1. New entries require `- insert: [...]` in profile patch; bare id-targeted patch only edits existing entries.
2. Installed rc.2 `connection.rpc.handle` silently fails its nested fiber due to provider-side webServer injection while outer host remains active. Exact Connection Fetch registration is the supported workaround: `/api/programAgents/{list,send,stop,restart}`, owner-authenticated before handler, strict named payload/envelope, no replacement of Gateway interceptor.
3. rc.2 Loader preserves ESM module cache even after disable/enable, and changing an existing entry path did not recreate the active Service. A bundled fresh host URL plus new entry id forced correct initialization without server restart. Build emits both `plugin.js` and the currently installed `installed-v2.js`. Do not keep multiple active host entries for this same package. Future host updates require explicit new versioned entry/identity or normal DSH restart when safe; do not restart active host just to test source edits.
4. Runtime Schemastery dependency is pinned as production dependency, not dev-only.

## Disable / uninstall

Use Settings → Plugins to disable `include:program-agents-installed`, or remove only this plugin's insert block from web profile. Plugin cleanup stops all its runs. Do not restore entire old profile over newer unrelated settings. Keep or archive private audit journals according to your own retention policy; disabling does not erase them. Checkout remains local; not published/pushed.
