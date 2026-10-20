export default async function main(ctx) {
  await ctx.capabilities.call('slow.call', { generation: ctx.generation });
  await ctx.parent.send('late notification must not escape cancellation');
}
