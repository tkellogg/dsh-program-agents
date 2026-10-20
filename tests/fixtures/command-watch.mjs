// Ordinary Node watcher worker: deliberately no SDK imports, export, or IPC.
console.log(JSON.stringify({ ready: true, workerPid: process.pid, ipc: typeof process.send, argv: process.argv.slice(2), home: process.env.HOME, path: Boolean(process.env.PATH), secret: process.env.RUNTIME_COMMAND_SECRET ?? null, nodeOptions: process.env.NODE_OPTIONS ?? null, explicit: process.env.EXPLICIT ?? null }));
console.error('ordinary-command stderr ready');
setInterval(() => {}, 1000);
