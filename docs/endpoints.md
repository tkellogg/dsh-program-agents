# Runtime endpoint recipes and direct remote access

A URL has two lifetimes: a **persisted recipe** and a **current listener address**. Never save an evaluated dynamic port or last browser hostname as the launch definition. No stored JavaScript, interpolation, eval, or shell expansion is involved.

## Registration

```json
{
  "name":"Inventory",
  "description":"Local inventory app and API",
  "command":["pnpm","run","dev"],
  "cwd":"/absolute/path/inventory",
  "endpoints":{"web":{"port":"dynamic"}},
  "urls":[
    {"id":"ui","title":"Open inventory","type":"ui","endpoint":"web","path":"/"},
    {"id":"api","title":"Inventory API","type":"api","endpoint":"web","path":"/api","docs":"/absolute/path/inventory/docs/api.md"},
    {"id":"docs","title":"App docs","type":"docs","endpoint":"web","path":"/docs"}
  ]
}
```

`endpoints` is a map of at most16 named listeners. `port` is `"dynamic"` or an explicit integer1–65535. Recipe URLs use `endpoint` and optional `path` (default `/`), mutually exclusive with legacy `url`. Multiple UI/API/docs paths may share a listener. Paths include query/hash if useful but cannot change authority or carry raw controls/backslashes. Filesystem documentation remains informational; no `file://` links. Legacy absolute HTTP(S) URLs continue unchanged, including deliberately external links: the harness never globally rewrites `127.0.0.1` inside arbitrary strings.

Registration persists the recipe only. A fresh process generation starts with requested port0 for dynamic listeners, no bound port and unavailable links. A listener's actual port becomes available only after the app binds and reports it. Stop/crash/restart clears binding/link availability. The strip receives pushed metadata and resolves links again; it never needs a manual Refresh.

## Bind with the app helper

```ts
import {createServer} from 'node:http';
import {connectProgram} from '@tkellogg/dsh-program-agents/app';

const app=connectProgram();
const server=createServer((req,res)=>res.end('Hello'));
const listener=await app.endpoints.listen('web',server);
console.log('Local health address:', listener.localUrl);
// On orderly shutdown:
await listener.close();
```

The helper asks the authenticated host for this generation's binding policy, calls `server.listen({host,port})`, waits for listening, reads `server.address().port`, then publishes it. For dynamic ports the OS selects and holds port0 atomically—no probe/free/rebind race. It does not guess a free port, reserve it briefly, or promise the previous port survives a restart. If the old port is occupied, the next dynamic launch uses an available one. Fixed-port collisions fail normally and never advertise an unbound endpoint. There is no automatic retry of app side effects.

`listen` takes a Node net/http-compatible Server, so Hono's Node handler can use `createServer(getRequestListener(app.fetch))`; use the same pattern with a framework's server adapter. For separate frontend/backend listeners, register distinct endpoint names. Prefer a single-origin app when possible so asset URLs and relative API requests follow the browser's actual host/port. Configure Vite/framework host/origin settings deliberately; DSH does not rewrite arbitrary HTML, asset paths or redirects.

For framework-owned listeners:

```ts
const policy=(await app.endpoints.list()).find(x=>x.id==='web');
if(!policy) throw new Error('web endpoint is not registered');
// Bind using policy.bindHost and policy.requestedPort (0 for dynamic), then:
await app.endpoints.publish('web',{port:actualBoundPort});
// On close (port condition prevents an old worker clearing a replacement):
await app.endpoints.unpublish('web',{port:actualBoundPort});
```

Per-run policy is also in `DSH_PROGRAM_ENDPOINTS_JSON` for non-JS launchers; the app bridge has list/publish/unpublish. This environment is ephemeral harness input, not something to copy back into the saved definition. Legacy SDK entrypoints can use `/app` alongside `/sdk`; ordinary watched commands need no special entrypoint. A reload worker reads `requestedPort`, not a previously reported `port`. Worker replacement can report a fresh port in the same generation. Publication is not a health-check assertion beyond the helper's successful local bind; use actual health endpoints.

## Harness host policy

Plugin config, not registration or a request Host header, controls exposure:

```yaml
networking:
  bindHost: 127.0.0.1
  publicHost: browser
  protocol: http
```

Defaults are local-only bind, browser-host links, HTTP. `publicHost: browser` means render using **this browser's `location.hostname`**, excluding DSH's port. This matters with two viewers: local DSH gets `http://127.0.0.1:<app-port>/api`; a Tailscale viewer gets `http://devbox.tailnet.ts.net:<app-port>/api`. Browser hostname is evaluated when constructing each link, not persisted, and never controls where a server listens. An explicit public DNS/IP hostname overrides the browser default. IPv6 is supported/bracketed appropriately. Agent/server health checks use a server-local address, not a guessed remote-browser authority; returned binding metadata exposes bindHost+actual port separately from the public recipe.

### Tailscale direct-port mode

Configure `bindHost` to the server's **Tailscale interface address** to expose only that interface, or another deliberately reachable bind address. The user/harness owns that setting. Don't silently change a local app to `0.0.0.0`: that can expose it on Wi-Fi/LAN too. A Tailscale-only bind may not accept `127.0.0.1`; if DSH is viewed locally through loopback, configure an explicit Tailscale `publicHost` or view DSH through its Tailscale name. `publicHost: browser` is correct only when the browser's hostname reaches the app's configured interface.

Tailscale ACL/firewall policy must permit the app's selected ports. Dynamic ports aren't automatically tunneled or opened. The current implementation uses **own ports**, as selected by the user—not a DSH same-origin reverse proxy. Tailscale provides the private network but is not per-app authorization: add app auth for sensitive services or other authorized tailnet users.

`protocol` describes the app listener, not the DSH page. Opening DSH over HTTPS does not magically give a plain Node HTTP listener TLS; default links remain HTTP. Set HTTPS only when the app itself serves HTTPS with valid certificates at that hostname/port. Tailscale transport encryption is separate from browser HTTPS. This direct mode does not implement Tailscale Serve mappings, HTTPS termination, SSH forwarding of arbitrary dynamic ports, or one-port proxy support. A browser following a link navigates in a separate tab; DSH never fetches/embeds app content with its credentials.

## Lifecycle and security

- Different ports are different browser origins, **but cookies are not port-scoped**. A browser may send matching hostname/path cookies to an app on another port. HttpOnly prevents JavaScript reads, not a receiving HTTP server from seeing Cookie headers. These are trusted OS-user programs, not a hostile-code isolation boundary. Do not log/forward Cookie or Authorization headers; use a separate app hostname and appropriately scoped DSH cookies if cookie isolation is required. No reverse proxy is added here.
- Host metadata has structured `address:{endpoint,host,protocol,port,path}` only after a report; recipe `url` is empty, never an old port string. The browser validates shape/host/path again. Unbound, stale, stopped, pending-action, malformed links are disabled.
- Bridge credential selects exact live owner/run/generation. A stale generation cannot report or unpublish a newer listener. Program input cannot set bindHost/publicHost/protocol through report methods. Trust boundary remains trusted OS-user code, not a network sandbox; custom code could still ignore instructions and bind differently.
- Configured recipe resource IDs cannot be overwritten via legacy `resources.publish`; report/unpublish the endpoint instead. Arbitrary external static resources remain supported.
- Runtime does not probe/fetch advertised URLs or auto-kill another service holding a fixed port. Do not adopt another process's listener after EADDRINUSE.
- OS-assigned ports solve collision/restart allocation for integrated apps. A generic black-box command hardcoded to a port must be adapted to consume harness configuration and report readiness; metadata alone cannot change its listening socket.
- No URLs, browser hostnames or evaluated port bindings are saved back to launch recipes on exit. App databases and idempotency remain separate from endpoint lifecycle.

## Example and validation

`examples/dynamic-server.ts` (built `dist/examples/dynamic-server.js`) is an ordinary command using the helper. Register endpoint web dynamic and UI `/`, API `/api/status`, docs `/docs` if actually implemented (the example only serves UI and API).

Tests cover actual bind0 and publication, restart with previous port occupied by another process, no advertising before bind, fixed-port collision, bridge failures/cancellation/close cleanup, stale generations, per-browser local/Tailscale/IPv6 hostname resolution, host injection attempts, backward-compatible static resources and persisted recipe reload. Network reachability on a real remote Tailscale client requires that actual environment; local tests do not claim remote ACL/TLS verification.
