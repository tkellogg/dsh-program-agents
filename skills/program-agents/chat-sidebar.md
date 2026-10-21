# App-owned assistant sidebar (copyable reference)

Use this when a supervised web app needs a small chat sidebar that understands the page the human is looking at. This is an **app reference**, not a modification to the DSH composer or full conversation feed. It uses a real continuable native DSH conversation; do not implement a second model/tool loop or send ordinary chat through the supervisor inbox.

Copy the five files in [the reference directory](references/chat-sidebar/README.md) into your app:

- [AgentSidebar.tsx](references/chat-sidebar/AgentSidebar.tsx): React UI; opens only on human interaction, sends once, follows independently, reconnects with a fresh native snapshot.
- [backend.ts](references/chat-sidebar/backend.ts): Hono routes; lazily opens one app-owned conversation and proxies only that handle.
- [protocol.ts](references/chat-sidebar/protocol.ts): browser-pure native-frame reducer, compact snapshot reconstruction, bounded fetch-SSE reader.
- [agent-sidebar.css](references/chat-sidebar/agent-sidebar.css): scoped, responsive styling.
- [README.md](references/chat-sidebar/README.md): installation, typed app integration, route contract, security and lifecycle limitations.

## Non-negotiable boundaries

1. `connectProgram()` belongs **only on the backend**. Never ship bridge URL/token/environment to the frontend. The browser gets only same-origin, app-scoped routes, not arbitrary conversation/session IDs, tools, models, or bridge calls.
2. Supply an explicit backend `sanitizePageState(input)` allowlist. Share selected IDs, visible filters, and small summaries—not the whole store, DOM, cookies, credentials, or hidden records. Raw requests are capped at 32 KiB; page state at 16 KiB. Plain JSON is data, not HTML or trusted instructions.
3. Call `getPageContext()` only when the human sends a new message. Context is appended to that new user turn in the native SDK's explicit untrusted-data wrapper. Never rewrite the system prompt or previous history on page changes; never send page state from render/effect/polling loops.
4. Keep the persona and model stable at conversation creation. Provider prompt caching is best-effort, not a guarantee; changing a route invalidates caches in the ordinary way. A model slot is not a selector on the parent composer. Existing conversations keep their creation-time route: a new route/persona requires a deliberately different conversation name.
5. Follow `handle.events({ signal, maxMessages: 20 })` independently of send/ask. The native stream starts with a replacement snapshot; native assistant chunks are ephemeral and settle to durable events. Do not invent token event names, append duplicate baseline rows, or render reasoning by default.
6. An accepted receipt means native admission, not successful tool execution. A dropped send response has an **unknown outcome**. Preserve its request ID, reconnect, and inspect history before deciding whether to resend. Native request IDs are correlation, not an exactly-once or automatic-deduplication promise.
7. Enforce exact app Origin on writes, exact configured host, no wildcard CORS, and real app authentication where needed. Same-origin browser GETs normally omit Origin; the reference permits only the documented GET-only `Sec-Fetch-Site: same-origin` plus non-simple custom-header exception. Localhost cookies are not port-isolated; see the security section in the reference README.

Read [the complete integration instructions](references/chat-sidebar/README.md) before copying or publishing routes. This reference does not install dependencies, launch a server, change a running DSH instance, or provide a production authentication system.
