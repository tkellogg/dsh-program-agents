# Local installation — 2026-10-19

## Current endpoint recipe revision — installed 2026-10-20

Active entry **program-agents-strip-v9**, host `dist/host/installed-v9.js`. Existing GUI http://127.0.0.1:3080 and Node PID11160 preserved. Added declarative `endpoints:{web:{port:"dynamic"}}`, URL endpoint/path recipes, harness bind/public host policy, app `.endpoints.listen`, per-run address publication and per-browser link resolution. Default interface remains127.0.0.1; no Tailscale/network exposure silently changed. Final build132/132 tests pass; actual GUI zero Runtime exceptions and dynamic UI/API links updated via push after restart. Live old-port collision49663→49680 verified with blocker holding old port; subsequent UI-observed restart49680→49825. Transient ports must not be hardcoded. Dynamic demo and preexisting Watch demo left running; no disposable blocker/browser processes remain. Model catalog unchanged. No skill files edited, copied, synchronized or committed during this revision; user is actively editing them. See endpoints.md.

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
