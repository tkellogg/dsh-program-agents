// Uses the public app transport over HTTP; no bootstrap or IPC for command mode.
import { connectProgram } from '../../src/app/index.ts';

async function execute() {
  const app = connectProgram({ logger: { stdout: false } });
  const result = await app.tools.callTool({ name: 'echo', arguments: { input: 'hello' } });
  console.log(JSON.stringify({ ready: true, result, id: app.id, generation: app.generation, ipc: typeof process.send, nodeOptions: process.env.NODE_OPTIONS ?? null }));
  process.stderr.write('bridge stderr\n');
  app.logger.info('App connected');
  await app.logger.flush();
  setInterval(() => {}, 1000);
}
if (process.env.APP_SDK !== '1') await execute();
export default async function main() { await execute(); await new Promise(() => {}); }
