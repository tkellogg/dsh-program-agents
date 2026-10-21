# DSH Program Agents

Parent-owned TypeScript/JavaScript programs and local apps for DeepSeek Harness. **Not RLM, not a REPL, not an implicit LLM loop.**

A compact **Program agents (N)** strip lives above the parent's message composer and stays pinned with it while chat scrolls. Expand for one compact row per app: name, state, typed UI/API/docs links, Start/Stop/Restart. More reveals description, start command and log path. No Refresh button, message form or log flood. Metadata is pushed over authenticated SSE; open/closed UI state survives updates.

Experimental0.2 implementation for DSH0.2.1-rc.2; Node22.18+ on macOS/Linux. Local checkout, not published. Installed in this Mac's existing GUI; see `docs/local-installation.md` and `docs/composer-strip.md`.

## Dynamic URLs and remote hosts

Persist listener recipes such as `endpoints:{web:{port:"dynamic"}}` and URLs `{id:"ui",title:"Open",type:"ui",endpoint:"web",path:"/"}` instead of a previously evaluated hostname/port. `connectProgram().endpoints.listen('web',server)` binds the harness interface with OS-assigned port0, reports the actual listener, and updates links. Each browser uses its own DSH hostname by default (not DSH's port); an explicit harness public hostname/protocol can override it. Restart re-evaluates endpoints, even when the old port is taken. Absolute legacy URLs remain supported.

Direct Tailscale access requires a reachable harness `networking.bindHost`, matching `publicHost` policy and ACL/firewall access to app ports; defaults stay loopback, never silently bind all interfaces. No DSH same-origin proxy or implicit TLS. See [endpoint configuration and lifecycle](docs/endpoints.md).

## Monitoring, app bridge and supervision

New: `@tkellogg/dsh-program-agents/app` works with ordinary watched commands. `connectProgram()` exposes supervisor messaging, granted Functions/MCP/tools/models, adjacent Agent lookup/messaging, and durable SQLite inbox receive/lease/ACK/NACK/receipt. No special entrypoint required.

Standard JSONL `ERROR` logs from stdout/stderr or registered logsPath are automatically deduplicated/buffered into the configured parent, reusable supervisor child, or fresh child. Versioned `log_type` identifies stable extensible monitoring schemas; see `docs/log-format.md` and shipped `schemas/`. Structured logger supports operation IDs, rotation, private files and secret-key redaction.

`program_register` accepts optional `supervision` (restart never/on-failure/always, bounded budget/backoff, startAtStartup, supervisor route, error buffering) and exact `access` grants. Defaults preserve manual process control. Startup resolves existing parent Sessions and never starts archived Sessions; archival participates in activity admission/stop. See `docs/supervision.md` and `skills/program-agents/inboxes.md`.

## Default workflow

1. Build an app using a foreground **watch/reload** command.
2. Register its name, description, argv command, URLs and optional log path with `program_register`.
3. Start using `program_start` or the composer's **Start** button. The UI dispatches through the exact live parent's public tool pipeline; it does not create an unrelated shell/Agent.
4. Edit source; let the watcher reload rather than repeatedly restarting manually. Check application readiness using its actual health/API URL and logs.

```json
{
  "name":"Inventory",
  "description":"Local inventory editor and stock-level API.",
  "command":["pnpm","run","dev"],
  "cwd":"/absolute/path/inventory",
  "urls":[
    {"id":"app","title":"Open inventory","type":"ui","url":"http://127.0.0.1:5173/"},
    {"id":"api","title":"Inventory API","type":"api","url":"http://127.0.0.1:3000/api","docs":"/absolute/path/inventory/docs/api.md"},
    {"id":"docs","title":"API docs","type":"docs","url":"/absolute/path/inventory/docs/api.md"}
  ]
}
```

`program_register` returns an opaque `program` key. Registration persists a parent-scoped launch description but **does not launch code**. Re-register the same name to update it. Commands are executable+argv, no implicit shell; don't pass an interpolated shell string. Model tools `program_register`, `program_start`, `program_list`, `program_stop`, `program_restart`; legacy SDK-only `program_send` is internal, not a user interface.

### Shared data model

- **name / description**: short display name + sentence describing purpose.
- **command / cwd**: argv foreground launch command in its working directory. Prefer `pnpm run dev`, `tsx watch`, `node --watch`, Vite.
- **urls**: zero or more `{id,title,type:'ui'|'api'|'docs',url,docs?}`. API URLs should include documentation, either HTTP(S) or an absolute local README/OpenAPI path. Filesystem docs are shown/copied as paths, never `file://` anchors. No credentials in URLs.
- **logsPath**: an existing app log file/directory, or a supervisor-generated actual tail-able stdout/stderr file when omitted. Private rolling16MiB capture; old segments/disk-backpressure drops are marked. UI carries only the path, not a log feed.
- **run state**: parent id, pid, generation, status, resources, timestamps; retained separately from durable launch descriptions. Stopped generations have no live links.

## Recommended stack and installed skill

**TypeScript + Hono + Zod**, Vite/React when needed; **SQLite for transactional app state**, **DuckDB for analytics/Parquet/CSV**. These are recommendations, not restrictions. Use SQLite migrations, transactions and effect idempotency. Avoid extra server/container dependencies for a small local app without a reason.

Read `skills/program-agents/SKILL.md`; on this Mac it is installed at `~/.local/skills/program-agents/SKILL.md`, discovered through existing whole-directory skill links. It explains metadata, tool use, watch reload, API docs, logs, SQLite/DuckDB tradeoffs, parent escalation and cleanup.

## Try without DSH

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm example
```

The SDK dashboard example prints a loopback URL; Ctrl+C stops it. An ordinary no-SDK TypeScript server is in `examples/watch-server.ts`; see `docs/watch-demo.md`. Native TypeScript must be erasable; compile installed examples under `node_modules` because Node intentionally refuses type-stripping there. Build ships JS examples.

## Install into another DSH profile

Build first. New profile entries need an **insert wrapper**, not a bare id-targeted override:

```yaml
- insert:
    - id: program-agents
      name: /absolute/path/dsh-program-agents/dist/host/plugin.js
      config:
        programs:
          dashboard:
            name: Dashboard
            description: Small SDK dashboard example
            entry: /absolute/path/dsh-program-agents/dist/examples/dashboard.js
            allowedCapabilities: []
        maxRuns: 8
        maxHistory: 64
```

Ordinary configured programs can use `command: [pnpm, run, dev]` instead of `entry`; exactly one is required. Host services tools/agents/llm are provided by standard profiles. Browser contribution is discovered from nearest package manifest and `./client`. DSH0.2.1-rc.2 has a dedicated-channel injection defect, so UI uses exact owner-authenticated Connection Fetch routes `/api/programAgents/{list,start,stop,restart,events}`, preserving Gateway's sole interceptor. No new GUI server or credential system. Rebuild and refresh the existing GUI after client edits; no source watcher is implied. See `docs/installation.md` for cache/update caveats.

## Optional SDK and broker capabilities

Ordinary commands require **no special SDK entrypoint** and can serve their own APIs. Optional app bridge supplies durable inboxes and granted calls via per-run credentials, never raw model keys. For explicit DSH models/tools, dynamic URLs/status and exceptional parent coordination, export a default SDK entry:

```ts
import type { ProgramContext } from '@tkellogg/dsh-program-agents/sdk';
export default async function main(ctx: ProgramContext) {
  await ctx.resources.publish({id:'app',title:'Inventory',type:'ui',url:'http://127.0.0.1:3000/'});
  await ctx.status('running','Ready');
  // Normal work; ctx.parent.send(json) automatically wakes/steers parent if needed.
}
```

`ctx.parent.send` remains a bounded internal coordination primitive. Parent processes it automatically; user need not relay/acknowledge messages. INFO/DEBUG/status updates don't wake the LLM; standard ERROR logs and synthetic process failures are buffered into the configured supervisor automatically. Normal stop/completion does not inject a chat notice.

Named `allowedCapabilities`, exact `models:[{provider,model}]` and `tools:[name]` grants are trusted host config. Dynamic commands can request exact persisted access allowlists; they don't gain broad subscriptions/tools, and parent public tool policy still applies. `models.call` is one bounded assembled text call (not token streaming/tool loop); `tools.call` traverses the live parent's public policy with fresh identity, no expired tool token. Third-party host plugins can register JSON handlers via `ctx.programAgents.capabilities.register(...)`; validate inputs, honor cancellation, return JSON. No automatic effect retries.

## Lifecycle, privacy and limits

**Trusted local code only. A Node child/process group is not an OS sandbox.** Ordinary code can access filesystem/network under your account; allowlists gate only the DSH broker. Minimal child env omits secrets/NODE_OPTIONS; command mode inherits HOME for package caches. No arbitrary command from browser: it can only select this parent's registered definition. UI mutations traverse parent tool policy.

Start returns after spawn/SDK connection, not app readiness. Stop requests cooperative shutdown then forced process-group cleanup; restart requires proven old-group exit. Watchers may reload their own workers; opted-in process recovery restarts failed watchers with budget/backoff, never individual effects. Parent turn completion keeps runs; parent disposal/plugin unload revokes/stops them. Replacement live Agent for same Session can explicitly reauthorize after cleanup; old restarting epochs remain fenced.

Launch metadata/catalog and private supervisory audit persist locally, **execution state does not**. App databases/queues/checkpoints/idempotency belong to the program. Interrupted effects can have unknown outcome; verify before retry. No exactly-once execution promise or interrupted-effect replay. Opted-in startup restores launch descriptions, not app memory; durable app inbox is a separate transport. Programs themselves remain supervised processes, not native LLM Agents; configured supervisor children use normal DSH delegation.

SSE sends initial compact snapshot + coalesced changes, suppresses identical updates,15s heartbeat; reconnect only on transport loss, no list polling.64streams/128KiBframe; slow clients close/reconnect to a fresh snapshot. Hidden tabs abort and reconnect on visibility. Stale links/actions are disabled. Internal runtime IPC64KiB,32pending/globalnoncooperative calls,64inbox/sends, bounded log/message/history rings. UI shows at most50 programs, foldout min(240px,35vh). URLs are not fetched, embedded or proxied; remote-host localhost needs explicit forwarding.

Defaults: `~/.dsh/program-agents/{audit,catalog}` (custom auditDirectory groups catalog/logs there unless overridden). Private0700/0600. Audit contains exact explicit model/tool data and has bounded file budget; archive intentionally. Capture logs are bounded per generation, not aggregate automatic retention—archive/remove old stopped-run logs under your own policy. Secrets should not appear in commands/URLs/launch metadata.

## Verification

```sh
pnpm check
DSH_TEST_CONNECTION_ENTRY=/path/to/dsh-client-connection/lib/index.js \
DSH_CLIENT_CONNECTION_BUNDLE=/path/to/dsh-client-connection/lib/client.browser.js pnpm test
```

Actual process/group/watch/log tests, SSE/auth/owner/tool-policy tests, DOM/layout behavior and installed-carrier compatibility; no model inference required. See verification and local-installation docs. MIT licensed.
