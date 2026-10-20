export default async function main(ctx) {
  await ctx.status('blocked', 'event loop blocked');
  process.on('SIGTERM', () => {});
  process.on('SIGINT', () => {});
  while (true) { /* Deliberately hard-blocked trusted program. */ }
}
