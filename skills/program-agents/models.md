# Named model slots and user configuration

Programs can give model choices stable, purpose-specific names. Declare them once during normal backend initialization; repeated identical declarations are no-ops. Defaults belong to the app, overrides belong to the user.

```ts
import {connectProgram} from '@tkellogg/dsh-program-agents/app';
const dsh=connectProgram();
await dsh.models.declare({
  'smart-model':{
    description:'Difficult judgments and multi-step planning.',
    default:{provider:'codex',model:'gpt-6.1-sol',reasoningEffort:'xhigh'},
  },
  'cheap-local':{
    description:'Private, inexpensive classification and short summaries.',
    default:{provider:'local-mlx',model:'Qwen3.8-27B-4bit'},
  },
});

const result=await dsh.models.call({slot:'smart-model',prompt:'Review this plan…'});
const selection=await dsh.models.resolve('cheap-local');
const slots=await dsh.models.list();
```

**In the DSH GUI:** expand Program agents, then the program's **Models** button. Each slot shows the program's description, provider/model and supported reasoning choices. Save creates a private parent-Session + program-scoped override; Use program default removes it. No page refresh or program restart is needed for the next slot call. Normal status SSE carries a small revision hash, not a copy of the whole model catalog. The pane fetches per-program settings separately. An open pane refreshes when declarations/preferences change.

These controls do **not** call DSH's session/global model picker and never modify the parent chat, global default, provider configuration or credentials. They only select existing advertised routes for that program slot. Concurrent edits use revision fences; a stale save rejects rather than overwriting another user's choice. A saved unavailable model stays visible as unavailable; calls do not silently fall back to a different provider. Default declarations may name currently unavailable routes, but calling one must pass native adapter resolution.

A declaration is a complete slot snapshot (max32 active slots). New descriptions/defaults do not clobber overrides. Removed slots are hidden; if reintroduced, their user's override/revision history survives within the bounded retained store. Private SQLite preferences survive worker/host reloads. Do not commit preference/task databases.

## Explicit model calls remain available

Slots are preferences, not an exclusive list. A program may still call a provider/model directly through the same native DSH adapter:

```ts
await dsh.models.call({
  provider:'codex',model:'gpt-6.1-sol',reasoningEffort:'xhigh',
  prompt:'An explicit route for this operation',maxTokens:1000,
});
```

A call supplies **either** slot **or** explicit provider/model/effort. Native route resolution, credentials, availability, parent attribution and output caps remain authoritative. No new provider credentials or settings are created; model slot edits aren't a security sandbox. Direct calls can bypass a user slot preference deliberately—apps should use slots for user-controllable behavior. Old configured `programs.*.models` metadata is no longer an exclusive app-call allowlist; explicit valid adapter routes remain callable. `maxModelOutputTokens` still caps output. The app API returns `{blocks,usage,finish}`; it is unary text inference, not a tool loop. Internally dispatch uses a real native prepared call handle so model defaults and adapter registration stay bound to the same generation.

## Conversational Agents

Use a slot for **creation** of a normal DSH child conversation:

```ts
const chat=await dsh.conversations.open({
  name:'Planning assistant',
  instructions:'Help the user understand and improve their plans.',
  model:'smart-model',
});
```

This uses the parent's real public subagent tool, including its route-selection/depth/capacity/policy settings. If native child model selection is disabled, a selected route fails explicitly before creating a child; omit model to inherit the parent route or enable normal DSH subagent model selection.

A conversation retains its creation-time model and stable instructions. Changing a slot affects future direct slot calls and **new** conversation names, not a conversation already in progress. Reopening the old name with a different resolved route rejects `MODEL_IMMUTABLE`; use `conversations.get(savedId)` to retain the old conversation or explicitly choose a new name to start fresh. Do not silently reset history just because a preference changed. Mid-conversation model switching is not implemented.

For history, streaming, UI composition and cache-stable page context, read [chat-sidebar.md](chat-sidebar.md).
