import{test}from'node:test';import assert from'node:assert/strict';import{mkdtemp,rm}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';import{SupervisorRouter}from'../src/host/agents.js';import type{ProgramSnapshot}from'../src/types.js';
const run:ProgramSnapshot={id:'r',generation:1,program:'app',ownerId:'p',label:'App',state:'running',startedAt:'',logs:[],messages:[],resources:[]};
test('supervisor ERROR receipt dedup suppresses repeats and parent message budget bounds cost',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'router-bounds-'));let count=0;const parent:any={id:'p',steer:()=>count++,ctx:{get:()=>undefined}},router=new SupervisorRouter(directory,async()=>parent,async()=>({subagentId:'c'})),signal=new AbortController().signal;
 try{const event={event_id:'batch-id',message:'error'};await router.notify(run,undefined,event,signal);await router.notify(run,undefined,event,signal);assert.equal(count,1);for(let i=0;i<9;i++)await router.notify(run,undefined,{i},signal);assert.equal(count,10);await assert.rejects(()=>router.notify(run,undefined,{i:10},signal),/rate limit/);
 const reloaded=new SupervisorRouter(directory,async()=>parent,async()=>{throw Error();});await reloaded.notify(run,undefined,event,signal);assert.equal(count,10);
 }finally{await rm(directory,{recursive:true,force:true});}
});
