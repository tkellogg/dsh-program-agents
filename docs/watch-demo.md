# Watch demo

Ordinary TypeScript HTTP server supervised as `node --watch examples/watch-server.ts`.
No SDK, dependencies or implicit model loop. UI http://127.0.0.1:4317/ ; API GET http://127.0.0.1:4317/api/status returns `{message,pid,startedAt}`. Bind is loopback-only. Edit the source and Node automatically reloads its server worker; DSH keeps supervising the same watch process and program generation. Port4317 must be free; no existing process is killed to claim it. Program output is JSON lines in the supervisor's returned logsPath. State is memory-only; a real app should use SQLite or DuckDB as appropriate.
