# Supervision and ordinary app integration

## Settings

`program_register` and trusted configured definitions accept:

```json
{
 "supervision": {
  "restart": "on-failure",
  "maxRestarts": 3,
  "restartDelayMs": 1000,
  "startAtStartup": true,
  "supervisor": {"mode":"dedicated-child", "prompt":"Investigate failures and coordinate with parent; don't blindly retry external writes."},
  "errors": {"enabled":true,"bufferMs":1000,"maxBatch":20,"cooldownMs":30000}
 },
 "access": {
  "tools":["working_directory","inventory.lookup"],
  "mcp":[{"server":"inventory","tools":["lookup"]}],
  "messaging":true
 }
}
```

Defaults: restart never, no startAtStartup, supervisor parent, ERROR monitoring on. restart also accepts always (on natural success/failure, not explicit Stop). Restarts have exponential delay capped5minutes and a bounded budget (default3; max100). Budget is in-memory per host lifetime/manual start, not perpetual service management. Manual Stop cancels pending recovery in this host lifetime; persisted startup configuration is not silently rewritten. Explicit Start resets recovery budget. Process-group closure must be proven before restart. No individual DSH tool/MCP/message/external side effect is automatically retried.

Supervisor modes:
- **parent**: wakes/steers exact live owner; cold Session resolved through existing DSH SessionController when necessary.
- **dedicated-child**: creates a real adjacent DSH subagent via parent's public subagent tool, saves its identity, then sends future reports through normal continuable messaging. Missing/non-continuable child is replaced; transport rejection does not silently reroute to someone else.
- **new-child**: creates a fresh child per explicit notification/error batch, not per log line. Normal inherited parent model/depth/permissions and subagent capacity apply. Do not enable noisy new-child routing without sensible buffer/cooldown.

`program.supervisor.send(body,{correlationId})` and `sendSupervisor(body)` select this route. Receipt accepted is inbox/delegation acceptance, not processing completion. Structured ERROR reports are buffered and delivered through the same router automatically. Parent notification source is attributed program data, never trusted instructions. Separate human-facing message UI is intentionally absent.

## Start at startup and archive safety

Registered launch descriptions persist in private parent-scoped catalog files; running execution does not. Once workspace/archive and SessionController services are available on DSH/plugin startup, opted-in entries are scanned. A missing live parent is resolved from its actual persisted Session with the recorded composition/model; no new unrelated root Agent is fabricated. Start runs under this parent's public program_start tool policy. Missing or archived Sessions are skipped/refused, not recreated. Session creation also checks opted-in entries, with reentrant duplicate-start guards.

Program activity participates in DSH archive admission: archive without stopActivity refuses while work is running; archive with stopActivity stops this parent's process groups and cancels restart timers. Every delayed restart checks current archive status again. Defaults do not change existing registrations. Startup means DSH/plugin service startup while its process is running—not launchd/macOS boot when DSH itself isn't running. A live main/chat turn isn't required; same persisted Session ownership is.

## App library

```ts
import {connectProgram} from '@tkellogg/dsh-program-agents/app';
const program=connectProgram({logger:{logsPath:'./logs',stdout:true,private:true}});
program.logger.info('ready',{}, {log_type:'com.example.app.ready.v1'});
await program.supervisor.send({type:'work-ready',count:3},{correlationId:'batch-42'});
await program.inbox.receive({waitMs:25000,leaseMs:60000},async(item,{signal})=>{
  await processIdempotently(item.id,item.body,{signal}); // library renews/ACKs/NACKs
});
const text=await program.agents.ask({name:'Reviewer'},{type:'review'}); // string response
const {tools}=await program.tools.listTools();
const result=await program.tools.callTool({name:'inventory.lookup',arguments:{sku:'A1'}});
```

Per-run/generation bearer credentials are injected into supervised command and SDK processes, inherited by watcher workers, and revoked on stop/crash/restart. Bridge is a separate loopback127 ephemeral HTTP endpoint, not a replacement GUI server. Browser origin/ambient cookies are not admitted; Host, body, header, concurrency and deadlines bounded. Calls include no caller-selected owner/run identity. Cancellation/revocation doesn't promise external effects were rolled back. Native trusted code is still not a sandbox.

Methods: tools.listTools/callTool (official MCP tool parameter/result shapes), mcp.forServer(server).listTools/callTool, agents.list/get/send/ask/request/cancel, supervisor.send/sendSupervisor, managed inbox.receive(options,handler), models.declare/list/resolve/call, conversations.open/get/list and conversation history/send/ask/events/interrupt. Named model slot defaults/descriptions and user overrides are separate from parent/global selection; explicit native routes remain callable. See the skill's models and chat-sidebar guides for configuration and copyable React/Hono UI. Tool access is limited to existing DSH tools registered through the normal DSH tool API and connected MCP tools. Exact access.tools and access.mcp grants and normal parent visibility/policy apply. Agent messaging requires explicit messaging grant and sees only parent + direct children; send/ask support explicit named get-or-create or fresh child selection under the normal parent delegation tool. SDK named capabilities remain supported.

`agents.ask` defaults to a string response or accepts strict Draft2020-12 responseSchema / typed responseType helper. Requests live in private requests.sqlite; assignment precedes dispatch, one valid reply is atomically accepted through program_reply, and conflicting/late/wrong-Agent replies reject. No guaranteed Agent liveness or automatic message/delegation retry. Stable requestId keys deduplicate only within retained storage; changed inputs reject. Result reads/cancel expose known/unknown outcomes and survive host restart without redispatch.

Inbox SQLite contains accepted/claimed/acked messages; namespace owner+program survives worker/host restart. Lease token + current authoritative claimant run/generation are mandatory for ACK/NACK. Claims expire or release on revoke. Managed receive renews leases, awaits handlers and owns ACK/NACK; lost ACKs raise SettlementUnknownError without unsafe retries. Cancellation aborts handler signal but cannot force noncooperative JS to stop; slots remain retained until actual settlement, renewal stops at the bounded processing deadline, and expired work can redeliver. At-least-once delivery requires app idempotency; ACK is not a distributed transaction. Poll receive bounds30s, lease5min, queue/receipts/bytes bounded. Retained receipt state is not eternal.

Read the skill's [inbox guide](../skills/program-agents/inboxes.md) for examples and use cases. `examples/inbox-worker.ts` is a real no-IPC ordinary command example; build ships dist/examples/inbox-worker.js. `docs/log-format.md` and schemas define structured logger/error pipeline.

## Privacy, durability and bounds

Private catalog/audit sibling state contains inboxes.sqlite, supervisors/ (dedicated-child identities and acceptance receipts), error-outbox/ (pending/grouped reports and tail cursors). Never commit task data or credentials. ERROR buffering batches max20groups64KiB, dedup event_id24h bounded4096, persists1MiB64batch default bound. Capacity eviction increments dropped; filesystem errors aren't durability acknowledgements. Receipts dedup accepted batch event_ids up to4096files; budget exhaustion refuses new receipts until explicitly archived. A crash between Agent acceptance and receipt persistence may duplicate delivery: no exactly-once claim.

App logger redacts known secret keys/headers but free text/stack/URLs still require care. Logs and forwarded external content must not redefine host policy. Log listeners attach before launch and use durable cursor+checkpoint to avoid acknowledged-file offsets ahead of persisted error state. Host output capture and app JSONL are distinct; stdout is parsed only when it follows the standard.

## Verified scope

Real process integration verifies automatic standard ERROR wakeup to parent adapter, DSH tool/MCP grant checks and exact parent tool call, durable reply/ACK, bounded process restart and cold-start archive exclusion. Real HostConnection/browser carrier regression remains. Supervisor routing tests use real routing code with mocked delegation/message service to avoid spending model tokens on synthetic errors. No live subscription inference or actual external MCP server was invoked for testing.
