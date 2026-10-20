export default async function main(ctx) {
  let code;
  try { await ctx.parent.send('x'.repeat(65450)); }
  catch (error) { code = error.code; }
  await ctx.parent.send({ result: code });
  return code;
}
