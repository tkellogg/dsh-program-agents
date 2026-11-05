# DSH Program Agents

You know how subagents can send messages to each other, launch new subagents, call LLMs, use tools, etc? A lot of agents write non-trivial amounts of code just to operate normally. _What if an "agent" was just code?_ 

_**Program agents**_ — no agent loop, just regular software that a supervising agent can edit & manage.

This repo includes
* A typescript SDK for [DSH (DeepSeek Harness)](https://github.com/deepseek-ai/deepseek-harness) that wraps tool calling, LLM calling, inter-agent messaging, etc.
* A process manager that keeps the program agent running, or not, whatever you need
* Logging/monitoring so that errors get funneled to the supervising agent
* Named models for configurable software so you can upgrade models easily
* A skill to teach your agent how to write program agents

## Installation

You'll need [Node.js](https://nodejs.org/) **22.18 or newer** and Git. This plugin currently targets **DSH 0.2.1-rc.2**; use that version for the setup below.

### 1. Install DSH

Install the [DSH CLI](https://github.com/deepseek-ai/deepseek-harness) and pnpm:

```sh
npm install -g @deepseek-ai/dsh@0.2.1-rc.2 pnpm@10
dsh web
```

DSH opens its web UI at `http://127.0.0.1:3080` and creates your web profile. Stop it with **Ctrl+C** while you install the plugins below.

### 2. Install Program Agents

The first npm release is being prepared. Once published, install it with:

```sh
dsh plugin --profile web add @tkellogg/dsh-program-agents
mkdir -p ~/.dsh/skills
cp -R ~/.dsh/profiles/web/node_modules/@tkellogg/dsh-program-agents/skills/program-agents ~/.dsh/skills/
```

This enables the plugin automatically. Until that release is available, build it from a checkout:

```sh
git clone https://github.com/tkellogg/dsh-program-agents.git
cd dsh-program-agents
pnpm install --frozen-lockfile
pnpm build

# Install the skill so DSH's agents know how to use program agents.
mkdir -p ~/.dsh/skills
cp -R skills/program-agents ~/.dsh/skills/
```

Add the following to `~/.dsh/profiles/web/cordis.patch.yml`, keeping any existing entries. Replace `/absolute/path/to/dsh-program-agents` with the checkout's full path (run `pwd` to find it):

```yaml
- insert:
    - id: program-agents
      name: /absolute/path/to/dsh-program-agents/dist/host/index.js
```

Keep the checkout in that location: DSH loads the built plugin from it.

Maintainers: see [Publishing to npm](docs/publishing.md) for the release steps.

### 3. Connect Codex or Claude

To use your ChatGPT or Claude subscription, install [dsh-plugin-subscriptions](https://github.com/V1ki/dsh-plugin-subscriptions):

```sh
dsh plugin --profile web add dsh-plugin-subscriptions
dsh web
```

In DSH, open **Settings → Subscriptions** and click **Connect** for the provider you want:

- **ChatGPT (Codex):** sign in with your ChatGPT account in the browser.
- **Claude:** imports your existing Claude Code login when available. Otherwise, follow the browser authorization flow; the Claude Code CLI is optional.

These providers use your subscription login, so no API key is needed. Open the session's model picker (`/model`) and select a model under **ChatGPT (Codex)** or **Claude (Subscription)**.

If you use another model provider, skip the subscriptions plugin and run `dsh web` after step 2. In a new chat, ask DSH to use the **program-agents** skill to build and start a program. The **Program agents** panel above the composer shows its status and Start/Stop/Restart controls.

## Why not just regular software?
* _Error handling_ — software that discovers problems and dynamically adapts
* _Slowly changing software_ — e.g. in data engineering you'll run into new data bugs or learn new things about the data in production. Program agents merely evolve to handle new situations
* _World-integrated agents_ — a collection of loops that poll web services like Github or Salesforce for events and messages and forward them onto a real agent
* _Heavily AI-integrated software_ — Regular software with agents and chatbots wired deeply throughout

## Default workflow

1. Build an app using a foreground **watch/reload** command.
2. Register its name, description, argv command, URLs and optional log path with `program_register`.
3. Start using `program_start` or the composer's **Start** button. The UI dispatches through the exact live parent's public tool pipeline; it does not create an unrelated shell/Agent.
4. Edit source; let the watcher reload rather than repeatedly restarting manually. Check application readiness using its actual health/API URL and logs.

## Development commands

Run `pnpm install --frozen-lockfile` after cloning, then use these scripts from the repository root:

| Command | Purpose |
| --- | --- |
| `pnpm build` | Build the host, browser client, SDK, and examples. |
| `pnpm typecheck` | Check the source TypeScript. |
| `pnpm typecheck:references` | Check the copyable application references. |
| `pnpm test` | Run the test suite. |
| `pnpm check` | Build, check references, and run tests. |
| `pnpm example` | Run the standalone supervisor example. |
| `pnpm release:pack` | Run all checks and create the release archive. |
| `pnpm release:inspect` | List the files in the current version's archive. |
| `pnpm release:publish:dry-run` | Preview publishing the archive. |
| `pnpm release:login` | Sign in to npm. |
| `pnpm release:publish` | Publish the existing archive publicly to npm. |

See [Publishing to npm](docs/publishing.md) for the release workflow.

