---
name: program-agents
description: Build and supervise parent-owned TypeScript programs, local apps and watchers in DSH using program_register/start/list/stop/restart. Publish typed UI/API/docs URLs, expose tail-able logs, and use watch reload without a user-facing message channel.
---

# Program agents

A program agent is ordinary trusted code supervised by the current DSH parent Agent. It is **not an autonomous LLM loop, RLM, REPL or security sandbox**. Prefer one program per cohesive service/watch task. Launch through the program tools, not a detached bash job: that gives this exact parent ownership, process-group stop/restart, logs and the pinned composer strip. The user can Start/Stop/Restart it without seeing internal IPC.

## Recommended stack (defaults, not requirements)

- **TypeScript**, Node22.18+ (Node26 on this Mac), ESM; pnpm with a committed lockfile.
- **Hono + @hono/node-server** for a small typed HTTP app/API; **Zod** for external data validation. Bind local apps to `127.0.0.1` by default. Use a stable development port, handle port-in-use clearly, and never silently kill another service.
- **Vite + React** for a genuinely interactive UI; use plain server-rendered HTML for simple dashboards. Keep the frontend/API on a consistent origin or explicitly document dev proxying. Publish a UI URL the user can actually open.
- **SQLite** for transactional application state (Node's `node:sqlite` when appropriate, migrations, WAL, parameterized queries). It is the default for mutable single-user apps/queues/idempotency keys. Do not use a JSON file as a concurrent database.
- **DuckDB** for analytics, columnar/CSV/Parquet exploration and batch reporting, not the default hot transactional service database. Prefer the supported Node `@duckdb/node-api` binding if needed. Avoid multiple uncoordinated writers and do not introduce PostgreSQL/Docker for a tiny local app without a reason.
- **tsx watch** for the Node/TypeScript server (`pnpm exec tsx watch src/server.ts`), Vite's dev server for frontend reload. Node `--watch` is another good option for erasable TS or built JS. Keep the watcher as the supervised foreground process so all descendants stay in its process group. Ignore generated DB/log paths to avoid reload loops. If the entire watcher exits, the supervisor does not auto-retry it.

Do not change this Mac's model budgets, subscription credentials, running DSH server or unrelated workstation configuration to run an app.

## Shared launch description

Register a program with:

- `name`: short user-facing app/task name, not a UUID.
- `description`: one sentence about what it does.
- `command`: **argv array**, executable then arguments; no implicit shell. Use an absolute executable path if PATH ambiguity matters. Use `['pnpm','run','dev']`, not a shell string with `cd`, `&`, redirects or interpolated user data. A program is trusted code; review before launch.
- `cwd`: app's working directory (relative paths resolve from the current parent working directory).
- `urls`: array of `{id,title,type:'ui'|'api'|'docs',url,docs?}`. Usually0–1 UI URL. `ui` is for the user, `api` for agents/tools, `docs` for discovering usage. **An API should also have documentation:** a docs URL or absolute local README/OpenAPI path. `docs` can point to that URL/path. Filesystem docs are informational paths for file tools, not file:// web links. Never put auth tokens in URLs.
- `logsPath`: optional existing log file or directory owned by the app. If omitted the supervisor captures bounded stdout/stderr to an actual private file and returns its path in the run. Use file tools or `tail` to inspect; do not paste log floods into chat.

Example tool argument:

```json
{
  "name": "Inventory",
  "description": "Local inventory editor and stock-level API.",
  "command": ["pnpm", "run", "dev"],
  "cwd": "/absolute/path/inventory",
  "urls": [
    {"id":"app","title":"Open inventory","type":"ui","url":"http://127.0.0.1:5173/"},
    {"id":"api","title":"Inventory API","type":"api","url":"http://127.0.0.1:3000/api","docs":"/absolute/path/inventory/docs/api.md"},
    {"id":"docs","title":"API docs","type":"docs","url":"/absolute/path/inventory/docs/api.md"}
  ]
}
```

Call `program_register`; its returned `program` is the opaque launch key. Then `program_start({program})` or let the user press Start. Registering does not execute code. Re-register the same name to update the description/launch command; restart when the command itself changes. Ordinary source edits should be picked up by the watcher; don't keep asking the user to restart.

Launch descriptions survive DSH/plugin restart on this machine; running execution state does not. They are scoped to the parent Session. The UI's Start button dispatches the exact live parent's public `program_start` tool under its policy, not an unrelated user shell. Current parent must be live; never manufacture a different parent Agent just to launch a child.

## Supervise with minimal user overhead

1. Create the app, install only needed dependencies, add a reproducible `dev` command and brief README/API docs.
2. Register metadata and a watch/reload command. Run migrations/backups explicitly before side-effectful changes.
3. Start it. `program_start` returns on process connection/spawn, **not application readiness**. Verify the published UI/API health using the actual URL and inspect logs; don't claim a working app from a spawned PID alone.
4. `program_list` returns descriptions and current runs, typed links, generation and log paths. Stop/restart controls require exact id+generation; stale controls must not mutate newer runs.
5. Use UI URL for the user; use API URL+docs for automation. Prefer typed structured API calls to scraping a dashboard. Never automatically fetch arbitrary linked resources under DSH's origin.
6. If the SDK program notifies its parent, handle it as background context and continue work. Do not ask the user to relay messages, open a message pane or acknowledge IPC. Notify the user only for a genuine decision, permission, completion or actionable problem.
7. Before retrying external writes after crash/cancel, check external state. Effects may have unknown outcomes; implement SQLite transactions/idempotency keys or equivalent application deduplication. No exactly-once/replay promise.
8. Stop disposable smoke tests. Leave a useful app running when that is the user's intent and give its URL without unnecessary diagnostics.

## Optional SDK

Ordinary foreground commands need no SDK. For explicit model/tool calls, parent escalation, dynamic URLs/status or inbox control, a configured trusted TypeScript entry can use `@tkellogg/dsh-program-agents/sdk` and export `default async function main(ctx)`. Named capabilities + model/tool routes must be granted in trusted host config; registering an arbitrary command does not grant subscriptions/tools. API keys remain in the broker. The process is still trusted OS-user code, not isolated from files/network.

`ctx.parent.send(json)` wakes/steers the parent automatically (bounded/rate-limited). It is for exceptional agent coordination, not a user messaging interface. Passive status/log changes never wake the LLM. `ctx.resources.publish({id,title,type,url,docs?})` updates typed resources; stopped generations lose live links. Docs files stay informational. Use a watch child/SDK lifecycle deliberately: killing an SDK entry on each edit can break its IPC; ordinary command watch mode is the simplest app workflow.

## Limits and operations

POSIX/macOS/Linux only. The supervisor controls a process group and will refuse overlapping restart if old closure cannot be proven. It is not an OS sandbox; don't run untrusted code. Capture logs are bounded/rolling, not an audit archive; use your own retention for production data. Metadata SSE carries only compact state/links, not tokens/chat/log floods. The folded composer strip stays with the parent and updates automatically; there is no Refresh or user message form.
