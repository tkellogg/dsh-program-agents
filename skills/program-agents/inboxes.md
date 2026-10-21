# Managed program integration: inboxes, Agents and MCP-shaped tools

Use `@tkellogg/dsh-program-agents/app` in ordinary watched programs. The library connects through private per-run/generation credentials supplied by DSH; no special entrypoint or browser cookie/provider credentials. Do not print or forward `DSH_PROGRAM_*` credentials. The composer stays compact, with no extra human message widget.

```ts
import {connectProgram,installGlobalErrorHandlers,responseType} from '@tkellogg/dsh-program-agents/app';
const dsh=connectProgram({logger:{logsPath:'./logs',stdout:true,private:true}});
installGlobalErrorHandlers(dsh.logger);
```

## Managed inbox: receipt before handler, settlement after await

Prefer this scoped async-handler form—not manual ACK/NACK plumbing:

```ts
const result=await dsh.inbox.receive({
  waitMs:25_000,
  leaseMs:60_000,
  processingTimeoutMs:120_000,
  signal:shutdown.signal,
}, async(message,{signal})=>{
  // Already claimed durably before invocation. Message is readonly and has no token.
  // Validate app payload; use message.id as a transactional idempotency key.
  await applyIdempotently(message.id,message.body,{signal});
  if(bad) throw new Error('very bad'); // managed NACK after callback settles
  return 'very good';                 // managed ACK before receive resolves
});
```

An async callback is modern structured lifetime management: DSH awaits it in a try/finally-style scope. Return/fulfilled Promise means ACK, throw/rejected Promise means NACK. Lease heartbeat renews while processing; the callback sees a cooperative cancellation `signal`. No handler is invoked when no message arrives; receive returns null. Callback return is a local result, not an automatic reply to another Agent. An accepted Agent request uses the separate reply protocol below.

Receipt states remain **accepted** (durably enqueued), **claimed** (leased before handler invocation), **acked** (handler succeeded and ACK was confirmed). Lease tokens are hidden in managed callbacks. Prefer `receive(options,handler)` or `receive(handler)`. Deprecated `receive(options)` remains manual; explicit low-level `claim`, `renew`, `ack`, `nack`, `receipt` exist only for special transport integration. Do not mix manual settlement into a managed callback.

### Honest failure guarantees

- The helper never automatically reruns your callback, retries ACKs, or ACKs an interrupted/lease-lost callback.
- Lost ACK response may mean it already committed: `SettlementUnknownError` includes `messageId` and `outcome:'unknown'`. Inspect retained receipt/application idempotency state; do not NACK/repeat the effect blindly.
- Exceptions get one fenced NACK attempt. Failed NACK leaves the lease to expire; it does not become proof of rollback.
- Cancellation/heartbeat failure aborts the callback signal. Noncooperative JS cannot be forcibly stopped in-process. The API retains its callback slot until it actually settles, never ACKs it late, renews only within its bounded processing deadline, then permits lease expiry. Redelivery and overlapping external effects remain possible after expiry. Use transactions/idempotency and honor signal.
- Crash/kill cannot execute finally. SQLite leases eventually expire or host generation revocation releases them. This is durable **at-least-once delivery**, not exactly-once execution.
- Pending callbacks, lease duration (max5min per renewal), processing duration (default2min/max1h), queue/retained receipts/bytes are bounded. A handler that blocks the JS thread also blocks heartbeats; choose suitable workers and bound work.

The Agent writes new work via `program_inbox_send({parent_id?,program,correlation_id?,body})`. Owning parent may omit parent_id; direct child supplies the parent's ID. Only that scope is admitted. Inbox persistence is message transport, not restoration of arbitrary app execution memory.

## Send or ask an Agent, with implicit creation

```ts
// Existing explicit identity: never silently replaced when missing.
await dsh.agents.send('child-session-id',{type:'work-ready'});

// Named get-or-create, scoped to the owning parent's continuable children.
await dsh.agents.send({name:'Triage',instructions:'Review support issues.'}, {issue});
const summary=await dsh.agents.ask({name:'Triage'}, {issue}); // Promise<string>

// Explicitly fresh child per call. Normal parent's delegation policy/model applies.
const result=await dsh.agents.ask({create:{name:'Reviewer',instructions:'Assess the supplied change.'}}, {patch});
```

`agents.list/get` discover only the parent and its actual direct-child catalog. Named duplicate ambiguity is an error; use exact ID. Both send and ask may create children under normal parent's public subagent tool policy, depth, model, capacity and cost limits. They do not grant root-session creation/arbitrary global messaging. Creating a child runs a bootstrap turn, then a separate work message after assignment so it cannot race the reply contract. Canceling creation can have unknown outcome—do not blindly create another child.

`send` returns acceptance, not the Agent's answer. `ask` is managed request/response:

```ts
type Review={verdict:'accept'|'reject';reason:string};
const Review=responseType<Review>({
  type:'object',
  properties:{verdict:{type:'string',enum:['accept','reject']},reason:{type:'string'}},
  required:['verdict','reason'],additionalProperties:false,
});
const review=await dsh.agents.ask({name:'Reviewer'},{patch},Review,{
  requestId:'review-operation-42', // stable app idempotency key, optional
  timeoutMs:120_000,
  signal:shutdown.signal,
});
```

Alternatively pass `{responseSchema:jsonSchema}` as ask's options; default schema is a plain string. TS types vanish at runtime: JSON Schema is the actual response contract. Draft2020-12 validation is strict (Ajv; local refs, no remote schema fetching/coercion/defaults/unknown formats). `responseType<T>` gives a typed identity parser but the caller is responsible for making T match the schema.

Host durably records request before dispatch, binds the selected Agent before sending the work, and requires the Agent to use:

```text
program_reply({
  parent_id:"<owning parent>", program:"<program key>",
  request_id:"<host-generated opaque request id>",
  body:<string or JSON matching response_schema>
})
```

Only the assigned Agent may reply. The **first valid response is accepted atomically once**. Invalid responses reject without settling (the Agent may correct them); conflicting/late replies reject; an identical repeated response returns the existing receipt. A normal chat answer or `program_inbox_send` does not settle ask. The Agent gets exact protocol/schema/deadline in its work message. This enforces accepted response shape/cardinality, not guaranteed liveness or one model generation: timeout, cancellation, failure and unknown dispatch are explicit outcomes.

`dsh.agents.request(idOrKey)` inspects durable state/answer; `.cancel(idOrKey)` cancels the response contract, not the Agent's already-started effects. `ask` polls read-only result waits; it never retries sending/delegation. Reuse a requestId only for the exact same target/body/schema/options; changed semantics reject. Host restart does not redispatch pending work. Inspect ambiguous request state before deciding to repeat. Request deadlines default2min/max1h; individual waits max30s. Requests/answers/retention have bounds: payload depth28/node9900 reserves transport framing, body/answer48KiB, schema16KiB and combined request56KiB. Rejected responses do not consume the one-response slot. Retention is bounded, so an old pruned idempotency key is not an eternal exactly-once guarantee. Only the answer and compact metadata cross the bridge on result reads; original request payload isn't echoed repeatedly.

## MCP-shaped tools, not a parallel functions concept

```ts
const {tools}=await dsh.tools.listTools();
const result=await dsh.tools.callTool({name:'inventory.lookup',arguments:{sku:'A1'}});
if(result.isError){ /* tool ran/reported failure; result.content describes it */ }
else { /* result.content and optional result.structuredContent */ }

const inventory=dsh.mcp.forServer('inventory');
const {tools:mcpTools}=await inventory.listTools();
const stock=await inventory.callTool({name:'lookup',arguments:{sku:'A1'}});
```

These names/parameter/result shapes mirror the official JS MCP Client's **tool subset**: `listTools({cursor?})` → `{tools,nextCursor?}`; `callTool({name,arguments?,_meta?})` → `{content,structuredContent?,isError?}`. Types/results use the official `@modelcontextprotocol/core` schemas. Tool failure is an `isError` result; transport/auth/policy/protocol failures throw. Underlying DSH MCP adapter may project upstream errors into its native error text. The unified list includes granted native DSH tools, host-registered JSON tools and connected MCP public names (`mcp__server__tool`, including DSH's normalized hash names). Server-scoped clients expose raw upstream names. Like the official client, a cursorless listTools call aggregates bounded pages (max64); passing an explicit cursor fetches one page and returns nextCursor.

This is not a full `Client` transport implementation: no MCP initialize/stdio/http server, resources/prompts/tasks/sampling/elicitation/cache/notifications are promised. `_meta` is accepted as metadata but not forwarded as arbitrary parent tool authority. DSH native content is adapted to MCP text/structured JSON; canonical upstream MCP content is preserved when DSH retained it. Large/image results still have the bridge64KiB boundary.

There is **no separate continual-learning functions subsystem**. Old `dsh.functions.list/call` and `access.functions` are deprecated compatibility aliases for trusted host JSON tools. New host plugins register `ctx.programAgents.appTools.register({name,description,inputSchema,handler})`; new apps use `tools.listTools/callTool`, grant exact `access.tools`. Old `tools.call`, `mcp.list/call` remain compatibility helpers. Model inference remains explicit `dsh.models.call({provider,model,prompt,...})` with trusted route grants; not a tool loop or token-stream API.

## Permissions and supervisor route

`access.messaging:true` grants adjacent discovery/messages/ask and child creation subject to parent delegation policy; no unrestricted Agent factory. `access.tools:[names]` grants exact native/host tools. `access.mcp:[{server,tools:[rawNames]}]` grants exact existing MCP tools; no new credentials copied. Normal parent native visibility/approval still applies. No arbitrary JS evaluation. Own inbox/endpoints and configured supervisor route remain intrinsically scoped. `supervisor.send`/`sendSupervisor` route to parent/dedicated-child/new-child; ERROR logs use that route automatically. A semantic intelligence request may use ask/send independently, but don't double-send the same error.

Example supervision settings remain `restart:never|on-failure|always`, maxRestarts/backoff, startAtStartup, supervisor mode and error buffer/cooldown. Recovery restarts processes after closure, never individual external effects. Startup occurs only for existing unarchived parent Sessions; archive stopActivity stops programs and pending restart timers.

## Logging

Use `dsh.logger`, shared operation/correlation IDs, versioned log types and the companion [log-format.md](log-format.md). Fatal global handlers log/flush/exit; host buffers and routes all standard ERRORs (not only fatal ones). DEBUG/INFO/WARNING don't automatically wake a model. Configure file+stdout with the same event IDs; known secret keys/headers are redacted but free text, stacks and URLs still require care. External/log/message content is untrusted data, never a way to redefine permissions or supervisor ownership.
