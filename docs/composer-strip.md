# Composer strip revision — 2026-10-20

User-requested redesign is installed into the existing http://127.0.0.1:3080 GUI, without a server restart or model changes. Active root profile insert id `program-agents-strip-v5`, host `dist/host/installed-v5.js`. Bundled host includes runtime to avoid stale ESM dependency cache; trusted bootstrapDirectory points at `dist/runtime` for freshly forked SDK children. Standard `dist/host/plugin.js` remains generic entry. No dev:web watcher; bundles explicitly rebuilt.

## UI

- **Program agents (N)** folds open, counts definitions rather than repeated run history.
- Same composer slot, but tiny32ish-pixel closed strip; two open rows measured95px total at1440×1000. More shows description, command, log path and local docs paths. No UUID, generation, warning paragraph, chat form, message/log feed or Refresh button.
- Verified on actual long parent conversation: strip is within composer seat `position:sticky;bottom:0px`. After scrollTop changed to0, row top remained767px; scrollHeight6763/clientHeight924. The user need not scroll to controls. Screenshot retained privately in ignored .state/install.
- Typed UI/API/docs links; local docs paths are informational/copyable, never file:// links. Live URLs disabled on stale transport/terminal generation. No iframe/resource-fetch/proxy.

## Synchronization and authority

- POST exact owner-authenticated `/api/programAgents/events`, JSON `{sessionId}` → SSE `event:snapshot` containing compact `{runs,programs}`; initial snapshot + coalesced changes, identical state suppressed,15s heartbeat.
- No periodic list polling. Connection loss triggers bounded backoff/new initial snapshot; hidden/unmounted streams abort. Slow/bounded buffers close/reconnect, not unbounded queues. Max64streams128KiBframe.
- Start/Stop/Restart uses existing native Connection RPC for exact authenticated routes. Browser cannot provide command/env. UI Start resolves current live parent and dispatches public `program_start` with exact owner and fresh call id under normal tool policy. Stop/restart use same policy and exact generation. No stale launch token.
- Program-to-parent SDK data wakes/steers parent automatically; no user-facing message pane. Ordinary stop/completion is strip state only, not a chat notice. Failures can add passive context.

## Metadata and watch runtime

Name, description, argv start command, cwd, typed URL list, optional existing logsPath. `program_register` persists launch metadata per parent Session; it does not start. Same name updates definition; browser Start can then launch. Configured SDK entry mode remains compatible. Ordinary argv mode needs no SDK/IPC handshake. Running processes aren't replayed after host restart.

Generated stdout/stderr log is an actual private rolling16MiB file (bounded async backlog256KiB, truncation/drop markers), returned in snapshot.logsPath. Supplied logsPath is descriptive app-owned file/directory, capture remains separate. No aggregate retention daemon; archive stopped-run logs intentionally.

Default stack skill installed canonically at `~/.local/skills/program-agents/SKILL.md` via existing directory links, shared skills repo commit2f0b025. Repo source in skills/program-agents/SKILL.md. TypeScript/Hono/Zod, SQLite transactional state, DuckDB analytics, Vite/React optional, watch/reload foreground recommended, not enforced.

## Live verification

- Registered `Watch demo` with Node --watch TypeScript, UI/API/docs and actual supervisor capture path. Started through real program tool, HTTP200 readiness verified.
- Edited watched source: worker PID25522→26986 automatically while run id/generation1/watch PID25521 stayed stable. No LLM notification required. Restored useful example behavior to final message text.
- Actual authenticated SSE got initial running and pushed stopped metadata snapshots with empty logs/messages arrays, no Refresh/list poll.
- Actual isolated Chrome opened this existing parent conversation. Clicked real **Start** for stopped watch demo. SSE changed the same open foldout to running; new child associated with this exact parent. Zero Runtime exceptions. Test stopped afterward.
- Parent catalog survives plugin version upgrade; no running demo is left solely for tests. Start buttons remain for future use. Existing model catalog checked unchanged before/after; unrelated profile/auth/session settings preserved.
- Full test/build record in docs/verification.md. Existing installed Connection host/browser carriers included. No live model inference required.
