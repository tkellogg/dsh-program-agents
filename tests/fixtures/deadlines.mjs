export default async function main(ctx) {
  const errors = [];
  for (let i = 0; i < 36; i++) {
    try { await ctx.capabilities.call('never.call', { i }); }
    catch (error) { errors.push(error.code); }
  }
  return errors;
}
