import { createServer } from 'node:http';
import type { ProgramContext } from '@tkellogg/dsh-program-agents/sdk';

/** Normal Node code: owns its state; DSH owns observation/control. */
export default async function main(ctx: ProgramContext) {
  let processed=0;let lastInput:unknown=null;
  const server=createServer((req,res)=>{
    if(req.url!=='/'){res.writeHead(404);res.end();return;}
    // JSON text rendered via textContent, never interpolated as HTML.
    const data=JSON.stringify({processed,lastInput,generation:ctx.generation}).replaceAll('<','\\u003c');
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",'Cache-Control':'no-store'});
    res.end(`<!doctype html><title>Program dashboard</title><style>body{font:18px system-ui;max-width:700px;margin:3rem auto;background:#15171c;color:#eee}pre{white-space:pre-wrap}</style><h1>Supervised program</h1><p>Reload to see the latest state. Send JSON from DSH.</p><pre id="data"></pre><script>document.getElementById('data').textContent=JSON.stringify(${data},null,2)</script>`);
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve());});
  const address=server.address();if(!address||typeof address==='string')throw new Error('No server address');
  await ctx.resources.publish({id:'dashboard',title:'Program dashboard',url:`http://127.0.0.1:${address.port}/`});
  await ctx.status('running','Dashboard ready; waiting for JSON input');
  try {
    for await(const message of ctx.inbox){
      lastInput=message.body;processed++;
      if(message.body&&typeof message.body==='object'&&!Array.isArray(message.body)&&message.body.action==='help'){
        await ctx.status('blocked','Waiting for supervisor advice');
        await ctx.parent.send({type:'needs_help',reason:'Example explicit escalation',processed});
      } else {
        await ctx.status('running',`Processed ${processed} message(s)`);
        console.log(`Processed message ${processed}`);
      }
    }
  } finally { await new Promise<void>(resolve=>server.close(()=>resolve())); }
  return {processed};
}
