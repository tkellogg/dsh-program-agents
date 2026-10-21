import {test}from'node:test';
import assert from'node:assert/strict';
import {mkdtemp,readFile,rm}from'node:fs/promises';
import {tmpdir}from'node:os';
import {join,resolve}from'node:path';
import {DshProgramAdapter}from'../src/host/adapter.js';
import {fence}from'../src/host/index.js';
import {json}from'../src/host/validation.js';
import type{Context}from'@deepseek-ai/cordis';
import type{ProgramSnapshot}from'../src/types.js';

function snapshot():ProgramSnapshot{return{id:'test',generation:1,program:'worker',ownerId:'parent',label:'worker',state:'running',startedAt:new Date().toISOString(),logs:[],messages:[],resources:[]};}
async function fixture(){
 const directory=await mkdtemp(join(tmpdir(),'dsh-program-host-'));let toolCalls=0,modelCalls=0;const steers:unknown[]=[],injects:unknown[]=[];
 const agent:any={id:'parent',steer:(v:unknown)=>steers.push(v),inject:(v:unknown)=>injects.push(v),ctx:{tools:{get:()=>({}),schemas:()=>[{name:'read'}],execute:async(exec:any)=>{toolCalls++;assert.equal(exec.agent,agent);assert.ok(exec.signal);assert.ok(exec.callId.startsWith('program-'));assert.equal(exec.parent,undefined);return{isError:false,content:[{type:'text',text:'ok'}],value:{ok:true}};}},llm:{prepareCall:async(v:any)=>{if(v.provider!=='local')throw Error('Provider unavailable');return{config:v,async*stream(opts:any){modelCalls++;assert.equal(opts.provider,'local');assert.equal(opts.model,'tiny');assert.equal(opts.maxTokens,v.maxTokens);yield{type:'block-start',index:0,blockType:'text'};yield{type:'text-delta',index:0,text:'hello'};yield{type:'block-end',index:0,block:{type:'text',text:'hello'}};yield{type:'finish',reason:{kind:'stop'}};}};},stream(){throw Error('Unprepared model dispatch must not be used');}}}};
 const registry=new Map([['parent',agent]]);
 const ctx:any={agents:{get:(id:string)=>registry.get(id),withInitiator:(a:any,fn:()=>unknown)=>{assert.equal(a,agent);return fn();}},logger:{warn:()=>{}}};
 const adapter=new DshProgramAdapter(ctx as Context,{auditDirectory:directory,programs:{worker:{entry:resolve('examples/dashboard.ts'),allowedCapabilities:['models.call','tools.call'],models:[{provider:'local',model:'tiny'}],tools:['read'],maxModelOutputTokens:4096}}});
 return{adapter,agent,registry,directory,steers,injects,get toolCalls(){return toolCalls},get modelCalls(){return modelCalls},async cleanup(){await adapter.dispose();await rm(directory,{recursive:true,force:true});}};
}
test('host tool capability preserves exact live owner and pipeline, no stale launch token',async()=>{
 const f=await fixture();try{f.adapter['owners'].set('parent',f.agent);const method=f.adapter.capabilities.get('tools.call')!;
 const result=await method.handler({name:'read',args:{}},{run:snapshot(),signal:new AbortController().signal});assert.deepEqual(result,{isError:false,content:[{type:'text',text:'ok'}],value:{ok:true}});assert.equal(f.toolCalls,1);
 await assert.rejects(()=>method.handler({name:'bash',args:{}},{run:snapshot(),signal:new AbortController().signal}),/not granted/);assert.equal(f.toolCalls,1);
 f.registry.delete('parent');await assert.rejects(()=>method.handler({name:'read',args:{}},{run:snapshot(),signal:new AbortController().signal}),/no longer live/);
 }finally{await f.cleanup();}
});
test('explicit model routes use native adapter validation and request audit precedes dispatch',async()=>{
 const f=await fixture();try{f.adapter['owners'].set('parent',f.agent);const method=f.adapter.capabilities.get('models.call')!;
 await assert.rejects(()=>method.handler({provider:'remote',model:'tiny',prompt:'hi'},{run:snapshot(),signal:new AbortController().signal}),/unavailable/);assert.equal(f.modelCalls,0);
 const result=await method.handler({provider:'local',model:'tiny',prompt:'hi'},{run:snapshot(),signal:new AbortController().signal});assert.ok(result);assert.equal(f.modelCalls,1);
 const lines=(await readFile(f.adapter.journal.path,'utf8')).trim().split('\n').map(l=>JSON.parse(l));assert.equal(lines[0].record.phase,'started');assert.equal(lines[0].record.detail.messages[0].content[0].text,'hi');assert.equal(lines[1].record.phase,'settled');
 }finally{await f.cleanup();}
});
test('failed adapter construction unwinds bridge and stores without leaving a listening server',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'dsh-program-failed-host-'));const handles=()=>new Set((process as any)._getActiveHandles().filter((h:any)=>h.constructor?.name==='Server'));const before=handles();
 try{assert.throws(()=>new DshProgramAdapter({}as Context,{auditDirectory:directory,maxRuns:0}));await new Promise<void>(resolve=>setImmediate(resolve));await new Promise<void>(resolve=>setImmediate(resolve));const retained=[...handles()].filter((server:any)=>!before.has(server)&&server.listening);assert.equal(retained.length,0);}finally{await rm(directory,{recursive:true,force:true});}
});
test('JSON boundary and generation controls fail closed',()=>{
 assert.throws(()=>json({bad:Infinity}));assert.throws(()=>json({bad:undefined}));assert.throws(()=>json({bad:()=>{}}));assert.throws(()=>fence(snapshot(),2),/Stale/);fence(snapshot(),1);
});
