export default async function main(ctx) {
  await ctx.status('blocked', 'not reading inbox');
  await new Promise(() => {});
}
