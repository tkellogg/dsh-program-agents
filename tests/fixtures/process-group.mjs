import { spawn } from 'node:child_process';

export default async function main(ctx) {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], { stdio: 'ignore' });
  await ctx.parent.send({ descendantPid: child.pid });
  await ctx.status('blocked', 'descendant running');
  for await (const { body } of ctx.inbox) if (body === 'complete') return 'complete';
}
