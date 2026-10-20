import{test}from'node:test';
import assert from'node:assert/strict';
import{resolve}from'node:path';
import{ProgramSupervisor}from'../src/runtime/index.js';

test('dashboard example publishes actual HTTP URL and shutdown revokes it',async()=>{
 const supervisor=new ProgramSupervisor({programs:{dashboard:{entry:resolve('examples/dashboard.ts')}},stopTimeoutMs:500});
 try{
  const run=await supervisor.start({program:'dashboard',ownerId:'demo'});
  let current=supervisor.get(run.id,'demo');
  const deadline=Date.now()+5000;
  while(!current.resources.length&&Date.now()<deadline){await new Promise(r=>setTimeout(r,10));current=supervisor.get(run.id,'demo');}
  assert.equal(current.resources[0]?.available,true);
  const url=current.resources[0].url;const response=await fetch(url);assert.equal(response.status,200);assert.match(await response.text(),/Supervised program/);
  await supervisor.send(run.id,'demo',{hello:'world'});
  const stopped=await supervisor.stop(run.id,'demo');assert.equal(stopped.state,'stopped');assert.equal(stopped.resources[0]?.available,false);
  await assert.rejects(()=>fetch(url));
 }finally{await supervisor.dispose();}
});
