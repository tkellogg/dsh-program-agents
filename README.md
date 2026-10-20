# DSH Program Agents

**Supervised TypeScript/JavaScript programs for DeepSeek Harness.** No RLM, Python, REPL, implicit model loop, execution checkpoints, or DSH core changes.

A parent agent launches a configured Node program. The program does normal work, receives messages, explicitly calls allowed model/tool/plugin capabilities, and publishes dashboard links. If it needs help, it messages its parent. The parent can inspect logs, edit the source, and explicitly restart it.

**Experimental v0.1**, targeting DSH **0.2.1-rc.2**, Node **22.18+** on **macOS/Linux (POSIX)** (developed on26). Windows is rejected rather than claim process-group cleanup guarantees. This repo is not published to npm. Built host/browser plugin, real-process tests, and isolated Cordis/DSH integration are included. On this Mac it is now installed into the existing web profile; see `docs/local-installation.md`. The generic install procedure below applies to other profiles.

## Quick start without DSH

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm example
```

The example starts a loopback dashboard and prints its URL. Ctrl+C stops the supervisor and its process group. It demonstrates actual SDK/IPC without invoking a model or needing credentials.

## A program is an ordinary entrypoint

```ts
import type { ProgramContext } from '@tkellogg/dsh-program-agents/sdk';

export default async function main(ctx: ProgramContext) {
  await ctx.status('running', 'Waiting for input');
  for await (const {body} of ctx.inbox) {
    if (needsHumanOrModelJudgment(body)) {
      await ctx.status('blocked', 'Needs advice');
      await ctx.parent.send({type: 'needs_help', item: body});
    } else {
      await processNormally(body);
    }
  }
}
```

`ctx` provides:

- `id`, `generation`, `input`, `signal`
- `inbox`: bounded async iterable; send acceptance is **not durable processing**
- `parent.send(json)`: explicit, rate-limited model-waking notification
- `status('running' | 'blocked', detail?)`: does not wake the parent
- `resources.publish({id,title,url})` / `unpublish(id)`: HTTP(S) links, generation-scoped
- `models.call({provider,model,prompt,system?,maxTokens?,reasoningEffort?})`: one explicit text call, returns assembled blocks/usage/finish; no automatic tool execution
- `tools.call(name,args)`: explicitly allowed native DSH tool through the owner’s public policy pipeline
- `capabilities.list()` / `call(name,json)`: plugin-extensible JSON operations

Normal npm libraries handle databases, HTTP, scheduling, retries and application logic. JS entrypoints work directly; TS entrypoints must use Node-supported erasable TypeScript or be compiled first. No tsconfig path aliases or arbitrary transpilation in the child.

See `examples/dashboard.ts` for source and built `dist/examples/dashboard.js` for a working link-publishing program. Use the built JS when installed under `node_modules` (Node intentionally refuses native TS stripping there).

## Install into another DSH profile (never automatic)

Build first and use an **absolute host entrypoint** in your profile patch. Review existing profile patches before merging; DSH config patch semantics replace complete config values.

```yaml
- insert:
    - id: program-agents
      name: /absolute/path/dsh-program-agents/dist/host/plugin.js
      config:
        programs:
          dashboard:
            entry: /absolute/path/dsh-program-agents/dist/examples/dashboard.js
            allowedCapabilities: []
        maxRuns: 8
        maxHistory: 64
```

The installed DSH profile must provide `tools`, `agents`, and `llm` (standard web/headless profiles do). The web composition additionally provides `connection` and discovers the package's `dsh.client` browser contribution. It mounts a **Program agents** dock above the conversation composer. The plugin uses four exact authenticated Connection Fetch routes at `/api/programAgents/{list,send,stop,restart}`—never replaces DSH's `/api` Gateway interceptor, never starts a second web server. A new profile entry must use the `insert` wrapper shown above; a bare id-targeted patch cannot create it. Model-facing tools: `program_start`, `program_list`, `program_send`, `program_stop`, `program_restart`. All actions address the caller’s own programs; mutations include the expected generation.

A simple prompt:

> Start the configured dashboard program. Inspect its link, send it a JSON hello message, and leave it running. Do not restart it automatically if it fails.

For a checked-out local package, dependency resolution must see the host's same DSH peer versions. `pnpm install` here includes development peers for isolated tests. Do not install a separate newer DSH over a running one. See `docs/installation.md` for integration details and lifecycle behavior.

## Grant capabilities explicitly

```yaml
programs:
  worker:
    entry: /absolute/path/worker.mjs
    allowedCapabilities: [models.call, tools.call, inventory.lookup]
    models:
      - {provider: local-mlx, model: Qwen3.8-27B-4bit}
    maxModelOutputTokens: 4096
    tools: [working_directory]
```

Both the named capability and its resource-specific grant are required. Programs cannot select arbitrary model routes/tools, request raw API keys, or provide a launch command through the start tool. Program definitions/environment are trusted host configuration. Tool calls use the exact live supervising Agent with a fresh execution id, never a captured launch-tool token. PTC-only tools fail closed rather than forging a transport token. Nested tool results are audited separately, not injected as fake LLM tool calls into the parent’s conversation.

A host plugin can extend the SDK without adding methods:

```ts
ctx.programAgents.capabilities.register({
  name: 'inventory.lookup',
  description: 'Find an inventory item',
  inputSchema: {type: 'object'}, // descriptive metadata; handler must validate input
  async handler(input, {run, signal}) {
    // Validate input and apply application-specific authority using run.ownerId.
    return lookupItem(input, signal);
  },
});
```

Capability metadata is discoverable only when granted to that program. Handlers must honor cancellation, validate input and return JSON. The host bounds concurrent outstanding handlers even when an extension ignores cancellation. Effects are **never automatically retried**.

## Supervision, not magical durability

- Separate Node processes/process groups; a blocked program event loop can be killed externally.
- Start returns after SDK connection, not after main finishes. Import/connection is deadline-bounded.
- Stop requests cancellation then escalates to forced termination. Restart waits for proven old-group exit before creating a new generation. Unproven cleanup is an error.
- Live links are revoked on stop/crash/restart; the UI marks stale/unavailable links inert and never embeds/fetches their pages.
- Parent disposal/plugin unload revoke runs; normal parent turn completion does not stop them.
- All state, messages, resource registry and handles are process-live. Host restart does **not** resurrect programs.
- A small bounded private journal records lifecycle, explicit model inputs/results and tool effect boundaries outside DSH Session formats. It is not a replay/checkpoint engine. By default: `$DSH_HOME/program-agents/audit` or `~/.dsh/program-agents/audit`; configure `auditDirectory` for isolation. Contains task data; permissions0700/0600. Archive explicitly when journal limits fill.
- Database/queue checkpoints and idempotency belong to the program. After cancellation or process loss a dispatched effect may have **unknown outcome**. Verify external state before retrying side effects.

## Security and limits

**A Node child process is not a security sandbox.** Programs are trusted local code with the launching OS user's filesystem/network/process authority. Capability allowlists fence the provided DSH bridge, not arbitrary direct Node API use. Never launch untrusted downloaded code without an actual OS isolation policy. No secrets are copied wholesale into child environments, but trusted code running as your account may still read local files. The model can edit the program's source if its own permissions allow it; review/test before explicit restart.

IPC frames64KiB, logs bounded128KiB/200entries, inbox64pending messages, messages100, resources32. Capability responses should stay below57KiB; large results fail rather than silently truncating. Model calls are unary-assembled in v0.1; streaming tokens to the child and child-LLM subagent spawning are deliberately deferred. Default deadlines can be configured for slower local models. Parent notification10/minute; status/log changes do not repeatedly wake models.

UI polls every3s while mounted/visible (errorbackoff, abortable20srequests), shows bounded history, and has message/stop/restart controls. It does not launch arbitrary code or start programs from URLs. Links open in a new tab with `noopener noreferrer`; no iframe/proxy/HTML under DSH origin. For remote DSH, a loopback URL points at the browser's machine—use explicit secure forwarding yourself; no automatic forwarding is claimed.

## Development

```sh
pnpm check                         # build host + lazy-CJS browser, all tests
pnpm exec tsx --test tests/runtime*.test.ts
pnpm exec tsx --test tests/client*.test.ts
pnpm exec tsx --test tests/dsh-integration.test.ts
```

Build output in `dist/`; package exports host, `./sdk`, `./runtime`, `./client`. The browser bundle is DSH's lazy module format, not standalone ESM. Tests require no subscription authentication or running DSH/oMLX server. No model weights/runtime settings are changed.

See `DESIGN.md`, `docs/installation.md` and `docs/verification.md`. MIT licensed.
