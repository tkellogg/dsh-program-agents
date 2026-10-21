import{test}from'node:test';import assert from'node:assert/strict';import{mkdtemp,rm}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';import{DshProgramAdapter}from'../src/host/adapter.js';import{CallToolResultSchema}from'@modelcontextprotocol/core';import{ProgramAgentsService,Config}from'../src/host/index.js';
const until=async(check:()=>boolean)=>{const end=Date.now()+3000;while(!check()&&Date.now()<end)await new Promise(r=>setTimeout(r,10));assert.ok(check());};
test('ordinary command ERROR wakes parent; existing DSH tools/MCP/inbox stay scoped with no custom registry',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'host-app-')),steers:any[]=[],calls:any[]=[];const tools={schemas:()=>[{name:'inventory.lookup',description:'Lookup',parameters:{type:'object',properties:{sku:{type:'string'}}}},{name:'mcp__demo__ping'}],get:()=>({}),execute:async(call:any)=>{calls.push(call);return{isError:false,value:{ok:true},content:[]};}};
 const agent:any={id:'owner',steer:(message:any)=>steers.push(message),inject:()=>{},ctx:{tools,get:()=>undefined}};const registry=new Map([['owner',agent]]);const ctx:any={agents:{get:(id:string)=>registry.get(id),isOwnedBy:()=>false,withInitiator:(a:any,fn:()=>unknown)=>{assert.equal(a,agent);return fn();}},get:(name:string)=>name==='workspaceRegistry'?{archivedSessionIds:[]}:undefined,logger:{warn:()=>{}}};
 const adapter=new DshProgramAdapter(ctx,{auditDirectory:directory,programs:{}});
 try{
 assert.equal('functions' in adapter,false);assert.equal('functions' in ProgramAgentsService.prototype,false);assert.equal('appTools' in ProgramAgentsService.prototype,false);assert.equal('functions' in Config({programs:{app:{command:['node']}}}).programs!.app,false);
 const script=`console.log(JSON.stringify({timestamp:new Date().toISOString(),level:'ERROR',log_type:'com.example.app.operation.v1',message:'Synthetic test failure',event_id:'test-error'}));setInterval(()=>{},1000)`;
 const registration={name:'App',description:'Test',command:[process.execPath,'-e',script],supervision:{errors:{bufferMs:10}},access:{tools:['inventory.lookup'],mcp:[{server:'demo',tools:['ping']}],messaging:true}};
 await assert.rejects(()=>adapter.register(agent,{...registration,access:{functions:['inventory.lookup']}}),/Unexpected|Unknown|functions/i);
 const descriptor=await adapter.register(agent,registration);
 const run=await adapter.start(agent,descriptor.program,null);await until(()=>steers.length===1);assert.match(steers[0].content[0].text,/Synthetic test failure/);
 const signal=new AbortController().signal;const result:any=await adapter.appCall(run,'tools.callTool',{name:'inventory.lookup',arguments:{sku:'x'}},signal);assert.deepEqual(result.structuredContent,{ok:true});assert.equal(CallToolResultSchema.safeParse(result).success,true);assert.equal(calls[0].agent,agent);assert.deepEqual(calls[0].arguments,{sku:'x'});
 await assert.rejects(()=>adapter.appCall(run,'tools.callTool',{name:'arbitrary.eval',arguments:{}},signal),/not granted/);
 const count=calls.length;for(const method of ['functions.list','functions.call'])await assert.rejects(()=>adapter.appCall(run,method,{},signal),/Unknown or ungranted app method/);assert.equal(calls.length,count);
 assert.deepEqual(await adapter.appCall(run,'mcp.call',{server:'demo',tool:'ping',args:{}},signal),{ok:true});assert.equal(calls[1].agent,agent);assert.equal(calls[1].parent,undefined);await assert.rejects(()=>adapter.appCall(run,'mcp.call',{server:'other',tool:'ping',args:{}},signal),/not granted/);
 const accepted=await adapter.sendInbox(agent,'owner',descriptor.program,{reply:'ok'},'op1');assert.equal(accepted.status,'accepted');const claimed:any=await adapter.appCall(run,'inbox.receive',{waitMs:0},signal);assert.equal(claimed.correlationId,'op1');assert.equal(claimed.receipt.status,'claimed');const ack:any=await adapter.appCall(run,'inbox.ack',{id:claimed.id,leaseToken:claimed.leaseToken},signal);assert.equal(ack.status,'acked');
 await adapter.stop(run.id,'owner');assert.equal(steers.length,1);
 }finally{await adapter.dispose();await rm(directory,{recursive:true,force:true});}
});
