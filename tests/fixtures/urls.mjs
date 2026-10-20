export default async function main(ctx) {
  const rejected = [];
  for (const url of ['javascript:alert(1)', 'data:text/html,no', 'file:///etc/passwd', 'ftp://example.com/', '//example.com', 'https://user:secret@example.com/']) {
    try { await ctx.resources.publish({ id: 'unsafe', title: 'Unsafe', url }); }
    catch (error) { rejected.push(error.code); }
  }
  await ctx.resources.publish({ id: 'secure', title: 'Secure', url: 'https://example.com/app' });
  await ctx.resources.publish({ id: 'local', title: 'Local', url: 'http://localhost:3000/' });
  await ctx.resources.publish({ id: 'removed', title: 'Removed', url: 'https://example.com/' });
  await ctx.resources.unpublish('removed');
  return { rejected };
}
