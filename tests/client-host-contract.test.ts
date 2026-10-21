import assert from'node:assert/strict';import{mkdtemp,rm}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';import test from'node:test';import{Context}from'@deepseek-ai/cordis';import*as host from'../src/host/index.js';import{createProgramClient,type RpcTransport}from'../src/client/transport.js';import type{ProgramSnapshot}from'../src/types.js';
type Route={path:string;methods:readonly string[];fetch(request:Request):Promise<Response>};
test('client and host start in exact parent public tool context; scoped SSE and generation mutations agree',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'program-contract-')),ctx=new Context(),routes=new Map<string,Route>();
 let agent:any;const effects:string[]=[];const tools=new Map<string,any>();
 const snapshot:ProgramSnapshot={id:'p1',generation:2,ownerId:'session-a',program:'worker',label:'Worker',state:'running',startedAt:'',logs:[],resources:[],messages:[]};
 ctx.provide('tools',{register(tool:any){tools.set(tool.name,tool);return()=>tools.delete(tool.name);}});
 agent={id:'session-a',ctx:{get:()=>undefined,tools:{async execute(call:any){assert.equal(call.agent,agent);assert.ok(['program_start','program_stop','program_restart'].includes(call.name));assert.equal(call.parent,undefined);effects.push(call.name==='program_start'?'parent-tool-start':call.name.slice('program_'.length));return{isError:false,content:[]};}}}};
 ctx.provide('agents',{get:(id:string)=>id===agent?.id?agent:undefined,withInitiator(a:any,op:()=>unknown){assert.equal(a,agent);return op();}});ctx.provide('llm',{});
 ctx.provide('connection',{fetch:{register(route:Route){routes.set(route.path,route);return async()=>{routes.delete(route.path);};}}});
 const fiber=await ctx.plugin(host,{auditDirectory:directory,programs:{worker:{command:[process.execPath,'-e','setInterval(()=>{},1000)'],name:'Worker',description:'Example worker'}}});
 try{
  assert.deepEqual([...routes.keys()],['list','start','stop','restart','models','modelSet','events'].map(m=>'/api/programAgents/'+m));
  const a=ctx.programAgents.adapter;a['owners'].set('session-a',agent);a.supervisor.list=owner=>owner==='session-a'?[{...snapshot}]:[];a.supervisor.get=(id,owner)=>{if(id!=='p1'||owner!=='session-a')throw Error('not found');return{...snapshot};};
  a.supervisor.stop=async()=>{effects.push('stop');return{...snapshot,state:'stopped'};};a.supervisor.restart=async()=>{effects.push('restart');return{...snapshot,generation:3};};
  let count=0;const signal=new AbortController().signal;
  const invoke=async(method:string,payload:unknown,s=signal)=>{const route=routes.get('/api/programAgents/'+method)!;const rpcId='test-'+ ++count;const response=await route.fetch(new Request('http://localhost'+route.path,{method:'POST',headers:{'content-type':'application/json'},signal:s,body:JSON.stringify({type:'client-request',rpcId,method:'programAgents/'+method,payload})}));const result=await response.json();assert.equal(result.rpcId,rpcId);return result.result;};
  const rpc:RpcTransport={call:(channel,method,payload,s)=>{assert.equal(channel,'/api');return invoke(method.slice('programAgents/'.length),payload,s);}};
  const client=createProgramClient(rpc,'session-a');const state=await client.list(signal);assert.equal(state.runs[0].generation,2);
  await client.action('stop',state.runs[0],signal);await client.action('restart',state.runs[0],signal);assert.deepEqual(effects,['stop','restart']);effects.length=0;
  // UI Start is unavailable if already active, then dispatches through exact parent.
  assert.equal((await invoke('start',{sessionId:'session-a',program:'worker'})).ok,false);
  a.supervisor.list=()=>[];
  assert.equal((await invoke('start',{sessionId:'session-a',program:'worker'})).ok,true);assert.deepEqual(effects,['parent-tool-start']);effects.length=0;
  const originalExecute=agent.ctx.tools.execute;let release!:()=>void;
  agent.ctx.tools.execute=async(call:any)=>{effects.push('single-flight');await new Promise<void>(r=>release=r);return{isError:false,content:[]};};
  const first=invoke('start',{sessionId:'session-a',program:'worker'});await new Promise<void>(r=>setImmediate(r));
  assert.equal((await invoke('start',{sessionId:'session-a',program:'worker'})).ok,false);release();assert.equal((await first).ok,true);assert.deepEqual(effects,['single-flight']);agent.ctx.tools.execute=originalExecute;effects.length=0;
  for(const[method,payload]of[['start',{sessionId:'session-a',program:'arbitrary'}],['start',{sessionId:'session-a',program:'worker',command:['evil']}],['stop',{sessionId:'session-b',id:'p1',generation:2}],['restart',{sessionId:'session-a',id:'p1',generation:1}],['list',{args:{sessionId:'session-a'}}],['stop',{sessionId:'session-a',id:'p1',generation:2,body:{}}]]as const){assert.equal((await invoke(method,payload)).ok,false);}
  assert.equal(routes.has('/api/programAgents/send'),false);assert.deepEqual(effects,[]);
  const eventRoute=routes.get('/api/programAgents/events')!;const response=await eventRoute.fetch(new Request('http://localhost'+eventRoute.path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sessionId:'session-a'})}));const reader=response.body!.getReader();const pushed=new TextDecoder().decode((await reader.read()).value);assert.match(pushed,/event: snapshot/);assert.match(pushed,/"name":"Worker"/);assert.doesNotMatch(pushed,/parent-tool-start/);await reader.cancel();
 }finally{await fiber.dispose();assert.equal(routes.size,0);await rm(directory,{recursive:true,force:true});}
});
