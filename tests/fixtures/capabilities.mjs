export default async function main(ctx) {
  const names = (await ctx.capabilities.list()).map((capability) => capability.name);
  const result = await ctx.models.call({ prompt: ctx.input, secret: process.env.RUNTIME_SECRET ?? null });
  const tool = await ctx.tools.call('echo', { result });
  let denied;
  try { await ctx.capabilities.call('private.call', {}); }
  catch (error) { denied = error.code; }
  return { names, result, tool, denied };
}
