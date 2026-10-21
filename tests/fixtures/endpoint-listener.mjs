import { createServer } from 'node:http';

const bindings = JSON.parse(process.env.DSH_PROGRAM_ENDPOINTS_JSON ?? '[]');
console.log(JSON.stringify({ kind: 'environment', bindings, bridgeToken: process.env.DSH_PROGRAM_BRIDGE_TOKEN ?? null }));
for (const binding of bindings) {
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ endpoint: binding.id, pid: process.pid }));
  });
  server.on('error', (error) => { console.error(error); process.exitCode = 1; });
  server.listen(binding.requestedPort, binding.bindHost, () => {
    const address = server.address();
    console.log(JSON.stringify({ kind: 'bound', id: binding.id, port: address.port, requestedPort: binding.requestedPort, bindHost: binding.bindHost, pid: process.pid }));
  });
}
if (!bindings.length) setInterval(() => {}, 1000);
