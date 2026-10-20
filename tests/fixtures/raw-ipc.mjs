let init;
const originalSend = process.send.bind(process);
process.send = (message, ...args) => {
  if (message.type === 'hello') init = message;
  return originalSend(message, ...args);
};
const turn = () => new Promise((resolve) => setImmediate(resolve));

export default async function main(ctx) {
  while (!init) await turn();
  const send = (type, fields = {}, identity = {}) => new Promise((resolve, reject) => process.send({ ...init, ...fields, ...identity, type }, (error) => error ? reject(error) : resolve()));
  if (ctx.input === 'invalid') process.send('not an envelope');
  if (ctx.input === 'oversized') await send('call', { callId: 900, method: 'parent.send', input: 'x'.repeat(70000) });
  if (ctx.input === 'duplicate') {
    await send('call', { callId: 900, method: 'effect.call', input: null });
    await send('call', { callId: 900, method: 'effect.call', input: null });
  }
  if (ctx.input === 'stale') {
    await send('call', { callId: 900, method: 'parent.send', input: 'forged owner', ownerId: 'someone-else' }, { generation: ctx.generation - 1 });
    await send('complete', { result: 'forged completion' }, { runId: 'another-run' });
    await ctx.status('blocked', 'stale frames ignored');
  }
  if (ctx.input === 'parent-identity') {
    await send('call', { callId: 900, method: 'parent.send', input: 'message', ownerId: 'someone-else' });
  }
  await new Promise(() => {});
}
