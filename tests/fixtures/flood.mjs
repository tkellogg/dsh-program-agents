export default async function main(ctx) {
  const chunk = 'x'.repeat(65536);
  for (let i = 0; i < 256; i++) {
    process.stdout.write(chunk);
    process.stderr.write(chunk);
  }
  await ctx.status('blocked', 'flood finished');
  for await (const { body } of ctx.inbox) if (body === 'complete') return 'done';
}
