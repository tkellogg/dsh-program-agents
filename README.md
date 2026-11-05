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

## Default workflow

1. Build an app using a foreground **watch/reload** command.
2. Register its name, description, argv command, URLs and optional log path with `program_register`.
3. Start using `program_start` or the composer's **Start** button. The UI dispatches through the exact live parent's public tool pipeline; it does not create an unrelated shell/Agent.
4. Edit source; let the watcher reload rather than repeatedly restarting manually. Check application readiness using its actual health/API URL and logs.

