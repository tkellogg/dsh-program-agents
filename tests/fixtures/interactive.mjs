export default async function main(ctx) {
  await ctx.status('blocked', 'waiting for a message');
  await ctx.resources.publish({ id: 'service', title: 'Service', url: 'http://127.0.0.1:43210/' });
  for await (const { body } of ctx.inbox) {
    if (body?.op === 'complete') return { input: ctx.input, generation: ctx.generation };
    if (body?.op === 'echo') await ctx.parent.send({ echo: body.value, generation: ctx.generation });
    if (body?.op === 'status') await ctx.status('running', 'working');
  }
}
