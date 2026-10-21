export default async function main(ctx) {
  const results = [];
  for (const action of [
    () => ctx.resources.publish({ id: 'ui', title: 'Attempted replacement', url: 'http://127.0.0.1:9876/' }),
    () => ctx.resources.unpublish('ui'),
    () => ctx.resources.publish({ id: 'other', title: 'Not a configured recipe', endpoint: 'web', path: '/' }),
  ]) {
    try { await action(); results.push('accepted'); }
    catch (error) { results.push(error.code); }
  }
  await ctx.status('running', JSON.stringify(results));
  for await (const _message of ctx.inbox) return results;
}
