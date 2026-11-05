# DSH Program Agents

You know how subagents can send messages to each other, launch new subagents, call LLMs, use tools, etc? A lot of agents write non-trivial amounts of code just to operate normally. _What if an "agent" was just code?_ 

_**Program agents**_ — no agent loop, just regular software that a supervising agent can edit & manage.

This repo includes
* A typescript SDK for [DSH (DeepSeek Harness)](https://github.com/deepseek-ai/deepseek-harness) that wraps tool calling, LLM calling, inter-agent messaging, etc.
* A process manager that keeps the program agent running, or not, whatever you need
* Logging/monitoring so that errors get funneled to the supervising agent
* Named models for configurable software so you can upgrade models easily
* A skill to teach your agent how to write program agents

## Why not just regular software?
* _Error handling_ — software that discovers problems and dynamically adapts
* _Slowly changing software_ — e.g. in data engineering you'll run into new data bugs or learn new things about the data in production. Program agents merely evolve to handle new situations
* _World-integrated agents_ — a collection of loops that poll web services like Github or Salesforce for events and messages and forward them onto a real agent
* _Heavily AI-integrated software_ — Regular software with agents and chatbots wired deeply throughout


## Installation

You'll need [Node.js](https://nodejs.org/) **22.18 or newer**. This plugin currently targets **DSH 0.2.1-rc.2**; use that version for the setup below.

### 1. Install DSH

Install the [DSH CLI](https://github.com/deepseek-ai/deepseek-harness) and pnpm:

```sh
npm install -g @deepseek-ai/dsh@0.2.1-rc.2 pnpm@10
dsh web
```

DSH opens its web UI at `http://127.0.0.1:3080` and creates your web profile. Stop it with **Ctrl+C** while you install the plugins below.

### 2. Install Program Agents

Install the npm package into DSH's web profile:

```sh
dsh plugin --profile web add @kelloggt/dsh-program-agents
```

DSH enables the plugin and discovers its bundled **program-agents** skill automatically in version **0.1.1 and later**. Package upgrades update the skill too.

If you previously copied the skill into `~/.dsh/skills/program-agents`, that copy takes precedence. Remove an old, unmodified copy to use the bundled version; keep it if you maintain your own instructions.

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

## Default workflow

1. Build an app using a foreground **watch/reload** command.
2. Register its name, description, argv command, URLs and optional log path with `program_register`.
3. Start using `program_start` or the composer's **Start** button. The UI dispatches through the exact live parent's public tool pipeline; it does not create an unrelated shell/Agent.
4. Edit source; let the watcher reload rather than repeatedly restarting manually. Check application readiness using its actual health/API URL and logs.



