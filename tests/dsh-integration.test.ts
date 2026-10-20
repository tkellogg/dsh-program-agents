import {test}from'node:test';
import assert from'node:assert/strict';
import {Context,Service}from'@deepseek-ai/cordis';
import {ToolRuntime,defineTool}from'@deepseek-ai/dsh-tools';
import {LlmRuntime}from'@deepseek-ai/dsh-llm';
import {mkdtemp,rm}from'node:fs/promises';
import {tmpdir}from'node:os';
import {join,resolve}from'node:path';
import * as plugin from'../src/host/index.js';
import type{ProgramSnapshot}from'../src/types.js';

test('real Cordis + DSH ToolRuntime enforce policy and plugin channel avoids /api gateway',async()=>{
 const root=new Context();const directory=await mkdtemp(join(tmpdir(),'program-dsh-real-'));let handler:any;const channels:string[]=[];let calls=0;
 const owner:any={id:'owner',steer:()=>{},inject:()=>{},ctx:root};
 class FakeAgents extends Service{constructor(c:Context){super(c,'agents')}get(id:string){return id==='owner'?owner:undefined;}withInitiator(_a:any,f:()=>unknown){return f();}}
 class FakePrompt extends Service{constructor(c:Context){super(c,'systemPrompt')}tools(){}}
 class Connection extends Service{constructor(c:Context){super(c,'connection')}rpc={handle:(channel:string,h:any)=>{assert.notEqual(channel,'/api');channels.push(channel);handler=h;return async()=>{};}};}
 await root.plugin(FakePrompt);await root.plugin(FakeAgents);await root.plugin(LlmRuntime);await root.plugin(ToolRuntime);await root.plugin(Connection);
 const fork=await root.plugin(plugin,{auditDirectory:directory,programs:{example:{entry:resolve('examples/dashboard.ts'),tools:['fixture_read'],allowedCapabilities:['tools.call']}}});

 try{
 assert.ok(fork);assert.ok(root.programAgents);assert.deepEqual(channels,['/program-agents']);
 root.tools.register(defineTool({name:'fixture_read',description:'read fixture',parameters:{},output:{schema:{type:'string'},render:(_a,v)=>[{type:'text',text:v}]},execute:async()=>{calls++;return'ok'}}));
 const adapter=root.programAgents.adapter;adapter['owners'].set('owner',owner);
 const run:ProgramSnapshot={id:'fixture',generation:1,program:'example',ownerId:'owner',label:'test',state:'running',startedAt:new Date().toISOString(),logs:[],resources:[],messages:[]};
 const method=adapter.capabilities.get('tools.call')!;
 const controller=new AbortController();await method.handler({name:'fixture_read',args:{}},{run,signal:controller.signal});assert.equal(calls,1);
 const unguard=root.tools.guard(()=> 'denied by integration guard');
 const denied=await method.handler({name:'fixture_read',args:{}},{run,signal:controller.signal})as any;assert.equal(denied.isError,true);assert.equal(calls,1);unguard();
 const ownerReply=await handler('list',{sessionId:'owner'},controller.signal,{principal:{kind:'owner'}});assert.equal(ownerReply.ok,true);
 const agentReply=await handler('list',{sessionId:'owner'},controller.signal,{principal:{kind:'agent'}});assert.equal(agentReply.ok,false);
 const malformed=await handler('list',{sessionId:'owner',extra:true},controller.signal,{principal:{kind:'owner'}});assert.equal(malformed.ok,false);
 }finally{await fork.dispose();await rm(directory,{recursive:true,force:true});}
});
