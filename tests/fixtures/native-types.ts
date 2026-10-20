export default async function main(ctx: { input: unknown; generation: number }) {
  return { input: ctx.input, generation: ctx.generation };
}
