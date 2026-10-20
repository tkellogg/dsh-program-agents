import{test}from'node:test';import assert from'node:assert/strict';import{mkdtemp,rm}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';import{SupervisorRouter}from'../src/host/agents.js';import type{ProgramSnapshot}from'../src/types.js';
const run:ProgramSnapshot={id:'run',generation:1,program:'app',ownerId:'parent',label:'App',state:'running',startedAt:'',logs:[],messages:[],resources:[]};
test('supervisor routing wakes parent, reuses dedicated child and creates fresh child explicitly; no global agent messaging',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'supervisor-router-')),steers:unknown[]=[],sent:unknown[]=[];let creates=0;const children:any[]=[];const parent:any={id:'parent',steer:(v:unknown)=>steers.push(v),ctx:{get:()=>({listChildren:async()=>children,sendMessage:async(_parent:any,id:string,content:unknown)=>{sent.push({id,content});return'message-id';}})}};
 const router=new SupervisorRouter(directory,async()=>parent,async(_parent,name,args)=>{assert.equal(name,'subagent');const id='child-'+ ++creates;children.push({id,label:'Supervisor',mode:'continuable'});return{subagentId:id};});
 try{
 const signal=new AbortController().signal;assert.equal((await router.notify(run,undefined,{event:'ready'},signal)).agentId,'parent');assert.equal(steers.length,1);
 const settings={supervisor:{mode:'dedicated-child' as const}};assert.equal((await router.notify(run,settings,{error:'one'},signal)).agentId,'child-1');assert.equal((await router.notify(run,settings,{error:'two'},signal)).agentId,'child-1');assert.equal(creates,1);assert.equal(sent.length,1);
 await router.notify(run,{supervisor:{mode:'new-child'}},{error:'three'},signal);await router.notify(run,{supervisor:{mode:'new-child'}},{error:'four'},signal);assert.equal(creates,3);
 await assert.rejects(()=>router.send('parent','unrelated-session',{data:1},signal),/adjacent/);
 const resumed=new SupervisorRouter(directory,async()=>parent,async()=>{throw Error('should reuse persisted child');});assert.equal((await resumed.notify(run,settings,{error:'five'},signal)).agentId,'child-1');
 }finally{await rm(directory,{recursive:true,force:true});}
});
