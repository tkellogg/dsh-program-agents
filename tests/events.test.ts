import{test}from'node:test';import assert from'node:assert/strict';import{ProgramEvents}from'../src/host/events.js';
const req=(owner:string,signal?:AbortSignal)=>new Request('http://localhost/api/programAgents/events',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:owner}),signal});
const decode=(b:Uint8Array)=>new TextDecoder().decode(b);
test('SSE sends initial scoped state and coalesces change events; abort removes subscription',async()=>{
 let value=1,reads=0;const events=new ProgramEvents(owner=>{reads++;return{owner,runs:[{id:value}],programs:[]};});const ac=new AbortController();const response=await events.fetch(req('owner-a',ac.signal));assert.equal(response.headers.get('content-type'),'text/event-stream; charset=utf-8');const reader=response.body!.getReader();assert.match(decode((await reader.read()).value!),/"owner":"owner-a"/);assert.equal(reads,1);
 events.changed('foreign');events.changed('owner-a');events.changed('owner-a');value=2;
 const update=decode((await reader.read()).value!);assert.match(update,/"id":2/);assert.equal(reads,2);
 ac.abort();assert.equal((await reader.read()).done,true);events.dispose();assert.equal(events['closers'].size,0);
});
test('SSE rejects malformed envelopes, bounds clients and closes on plugin unload',async()=>{
 const events=new ProgramEvents(()=>({runs:[],programs:[]}));assert.equal((await events.fetch(new Request('http://localhost',{method:'POST',body:'{}'}))).status,415);
 const bad=new Request('http://localhost',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'x',extra:1})});assert.equal((await events.fetch(bad)).status,400);
 const responses=await Promise.all(Array.from({length:64},()=>events.fetch(req('x'))));assert.equal((await events.fetch(req('x'))).status,429);events.dispose();for(const response of responses){const reader=response.body!.getReader();await reader.read();assert.equal((await reader.read()).done,true);}assert.equal(events['listeners'].size,0);
});
