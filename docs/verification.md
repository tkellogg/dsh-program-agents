# Verification record

Implementation date:2026-10-19, macOS AppleSilicon Node26.12.0, pnpm12.14.0; DSH0.2.1-rc.2/Cordis4.0.5.

## Current monitoring/supervision revision (2026-10-20)

Strict build + **106/106 tests pass**, zero failed/skipped with both installed DSH carriers enabled. Adds actual command bridge env/revocation, loopback auth/envelope/concurrency/deadlines, durable SQLite inbox leases/ACK/NACK/correlation/receipts, exact function/MCP grant+public-tool policy, automatic stdout/file ERROR-to-parent, typed schema validation/extensions, redaction/rotation/cursors, durable error batching/dedup/backpressure/noncooperative delivery slots/bounded shutdown, fatal exception/rejection logger exit, cold parent resume/startup/archive exclusion, real bounded failure-restart and supervisor route/receipt/rate tests.

Live: final installed host v8 is active on existing DSH PID11160; refreshed actual GUI has no Runtime exceptions and retains bottom sticky95px composer foldout. Live `program_inbox_send` receipt became acked with matching app JSONL/correlation and attempts1. Disposable worker stopped, Watch demo restored healthy, model catalog unchanged. No live model inference/synthetic child generation/external MCP server invoked; child-routing and MCP execution use actual router/tool APIs with mocked services.

## Previous composer-strip revision (2026-10-20)

Strict build + **61/61 tests pass**, zero failed/skipped, both installed-carrier compatibility checks enabled. Includes ordinary command/watch source-edit reload, process-group cleanup, metadata/catalog persistence, real tail-able bounded log files, owner reauthorization epochs, SSE initial/coalesced/scoped/auth/abort/dispose behavior, compact DOM/no message UI, Start public-parent policy dispatch and pre-push double-click fencing. Live actual GUI pin/Start/SSE/watch checks are recorded in composer-strip.md. The initial implementation evidence below is historical where its polling/message UI differs.

## Tested scope

- TypeScript strict NodeNext build emits host,SDK,runtime declarations and built bootstrap.
- Browser bundle built as actual DSH lazy-CJS ModuleLoader factory, sharedReactexternal.
- Real Node child processes: startup/inbox/messages/status/result, exact captured owner, minimalenv, capabilityallowlists, HTTP(S)URLvalidation, forcedkillofstalledeventloop, explicitgenerationrestart, ownerrevocationrace, stdout/stderrflood bounded/drained, noncooperativehandlerdeadlines/globalbound, stalegeneration/invalid/oversized/repeatedIPC, boundedinbox/history/admission, importerrors, descendantprocessgroupcleanup, nativeTS and compiledbootstrapwithouttsxloader.
- Client puremodel/controller tests and actualReactDOM+linkedom: exactsessiondockregistration, scopedpolling, deadlines, staleconnection/linkrevocation, generationfencedactions, messageJSONerrors, logtextescaping, safeexternalanchors, absenceofiframe.
- Actual installedDSHclientConnectioncarrier loadedinVM withfakefetch: nativeRPCenvelope, dedicatedchannelpath, namedsessionargs verified. No livebrowserauth used.
- Real isolatedCordis+DSHToolRuntime+LlmRuntime mounted: pluginHostserviceandfivetools, dedicatedRPCchannel (noGatewaycollision), realtoolguarddeniesbeforebody. Models/provider/networkandAgentregistry mocked inthisisolatedhosttest.
- Exampledashboard starts actualloopbackHTTPserver, publishesURL, acceptsmessage, stoprevokesresourceandcloseslistener.
- Modeladapter unittest:exactrouteallowlist, freshcallid/owner/signal, recordedrequestbeforedispatchandsettlement, malformedJSON/generationrejection.

Initial validation: strict build plus **45 tests passed, zero failed/skipped** with the optional installed carrier enabled. Packed npm artifact installed in an isolated local consumer; built runtime/bootstrap and built JavaScript dashboard entry started, published a real URL, returned HTTP200, and stopped cleanly. Source TypeScript inside node_modules initially failed Node’s intentional stripping restriction; the build now ships JS examples under dist/examples, and the packed-artifact check passed. Tests exercise boundaries, not arbitrary plugin correctness.

## Explicitly not claimed

Initial implementation did not install into runningDSHGUI/profile. Subsequent user-authorized live installation and refreshed-GUI smoke are recorded in docs/local-installation.md, with46tests including actual installedHostConnectioncarrier. No realsubscription/modelinference, noPython, noagent-spawnAPI, nostreamingtokensSDK, nodurableappstaterestore, nosecuritysandbox, noWindowsprocessgroupguarantee. NativeDSHsubagenttree membership isnotimplemented; programregistryanddockareseparate. Modelcalls assembledboundedtextresults; noautomatictoolloop.

The authenticated Connection host carrier's own authentication is delegated to DSH; our tests assert owner-principal checks, scoped runownership, exactgeneration andmethodargs. They do not reimplement browsercookieauth.

## Re-run

```sh
pnpm install --frozen-lockfile
pnpm check
# Optional real installedDSHbrowsercarrier compatibility:
DSH_CLIENT_CONNECTION_BUNDLE=/path/to/node_modules/@deepseek-ai/dsh-client-connection/lib/client.browser.js pnpm test
```

Tests require no Qwen/oMLX/Docker service and do not change inference budgets, globalmodelchoices, credentials, sessions, or currentGUI. Testfixtureprocesses/listeners are shut down in cleanup.
