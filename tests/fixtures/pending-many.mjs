export default async function main(ctx) {
  const calls = Array.from({ length: 32 }, (_, i) => ctx.capabilities.call('never.call', { i }).catch((error) => error.code));
  await ctx.status('blocked', 'slots dispatched').catch(() => {});
  await Promise.all(calls);
  for await (const _message of ctx.inbox) {}
}
