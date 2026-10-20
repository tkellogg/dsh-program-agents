export default async function main(ctx) {
  await ctx.resources.publish({ id: 'api', title: 'API', type: 'api', url: 'http://127.0.0.1:9876/api', docs: 'https://example.com/openapi.json' });
  await ctx.resources.publish({ id: 'docs', title: 'Local docs', type: 'docs', url: '/tmp/program docs/README.md', docs: '/tmp/program docs/openapi.json' });
  const rejected = [];
  for (const resource of [
    { id: 'bad', title: 'bad', type: 'docs', url: 'file:///tmp/README.md' },
    { id: 'bad', title: 'bad', type: 'ui', url: '/tmp/README.md' },
    { id: 'bad', title: 'bad', type: 'api', url: 'http://localhost/', docs: 'javascript:alert(1)' },
    { id: 'bad', title: 'bad', type: 'api', url: 'http://localhost/', docs: 'relative/docs.md' },
    { id: 'bad', title: 'bad', type: 'other', url: 'http://localhost/' },
  ]) {
    try { await ctx.resources.publish(resource); rejected.push('accepted'); } catch (error) { rejected.push(error.code); }
  }
  return rejected;
}
