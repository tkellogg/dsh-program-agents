import{test}from'node:test';import assert from'node:assert/strict';import{createProgramTools}from'../src/app/tools.js';import{listTools,callTool}from'../src/host/tool-client.js';import{mcpPublicName,mcpResult}from'../src/host/mcp.js';import{CallToolResultSchema,ListToolsResultSchema}from'@modelcontextprotocol/core';
const signal=new AbortController().signal;
test('tool client mirrors MCP listTools/callTool requests and native/server names',async()=>{
 const calls:any[]=[];const client=createProgramTools(async(method,input)=>{calls.push({method,input});return(method==='tools.listTools'?{tools:[]}:{content:[]})as any;});await client.listTools();await client.callTool({name:'lookup',arguments:{sku:'A1'}});const server=createProgramTools(async(method,input)=>{calls.push({method,input});return{content:[]}as any;},'inventory');await server.callTool({name:'lookup',arguments:{sku:'A2'}});assert.deepEqual(calls,[{method:'tools.listTools',input:{}},{method:'tools.callTool',input:{name:'lookup',arguments:{sku:'A1'}}},{method:'tools.callTool',input:{name:'lookup',arguments:{sku:'A2'},server:'inventory'}}]);
});
test('cursorless tool discovery aggregates pages but explicit cursor reads only one',async()=>{
 const calls:any[]=[];const client=createProgramTools(async(_method,input)=>{calls.push(input);const next=(input as any).cursor===undefined;return{tools:[{name:next?'first':'second',inputSchema:{type:'object'}}],...next?{nextCursor:'1'}:{}}as any;});assert.deepEqual((await client.listTools()).tools.map(t=>t.name),['first','second']);assert.equal(calls.length,2);assert.deepEqual((await client.listTools({cursor:'0'})).tools.map(t=>t.name),['second']);assert.equal(calls.length,3);
});
test('discovery and execution use only granted tools already visible in the parent DSH runtime',async()=>{
 const owner:any={ctx:{tools:{schemas:()=>[{name:'allowed',description:'Native',parameters:{type:'object',properties:{x:{type:'string'}}}},{name:'hidden',parameters:{}},{name:'program_stop',parameters:{}},{name:'run_code',parameters:{}},{name:'mcp__inventory__lookup',description:'MCP',parameters:{type:'object',properties:{sku:{type:'string'}}}}]}}};
 const access={tools:['allowed','missing','program_stop','run_code'],mcp:[{server:'inventory',tools:['lookup','notConnected']}]};const listing:any=listTools(owner,access,{});assert.deepEqual(listing.tools.map((t:any)=>t.name),['allowed','mcp__inventory__lookup']);assert.equal(ListToolsResultSchema.safeParse(listing).success,true);
 const scoped:any=listTools(owner,access,{server:'inventory'});assert.deepEqual(scoped.tools.map((t:any)=>t.name),['lookup']);
 const seen:any[]=[];const execute=async(name:string,args:any)=>{seen.push({name,args});return{value:{ok:true},content:[]};};
 const native:any=await callTool(owner,access,{name:'allowed',arguments:{x:'yes'}},signal,execute);assert.deepEqual(native.structuredContent,{ok:true});assert.equal(CallToolResultSchema.safeParse(native).success,true);
 await callTool(owner,access,{server:'inventory',name:'lookup',arguments:{sku:'A1'}},signal,execute);assert.deepEqual(seen,[{name:'allowed',args:{x:'yes'}},{name:'mcp__inventory__lookup',args:{sku:'A1'}}]);
 for(const name of ['hidden','missing','program_stop','run_code'])await assert.rejects(()=>callTool(owner,access,{name},signal,execute),/not granted/);
 assert.equal(seen.length,2);
});
test('MCP content and structured output survive; tool errors remain values not transport exceptions',async()=>{
 const raw={content:[{type:'text',text:'ok'},{type:'image',data:'aGVsbG8=',mimeType:'image/png'}],structuredContent:{ok:true}};assert.deepEqual(mcpResult({value:raw,isError:false,content:[{type:'text',text:'projection'}]},true),{...raw,isError:false});
 const failed=mcpResult({isError:true,content:[{type:'text',text:'Tool failed'}]});assert.equal(failed.isError,true);assert.equal(CallToolResultSchema.safeParse(failed).success,true);
 const owner:any={ctx:{tools:{schemas:()=>[{name:'native',parameters:{type:'object',properties:{}}}]}}};const result:any=await callTool(owner,{tools:['native']},{name:'native'},signal,async()=>({isError:true,content:[{type:'text',text:'failure'}]}));assert.equal(result.isError,true);
 for(const primitive of ['ok',42,null,['array']]){const result:any=await callTool(owner,{tools:['native']},{name:'native'},signal,async()=>({value:primitive}));assert.equal(CallToolResultSchema.safeParse(result).success,true);assert.equal(result.structuredContent,undefined);assert.equal(result.content[0].text,JSON.stringify(primitive));}
 assert.equal(mcpPublicName('demo','long/tool').length<=64,true);assert.notEqual(mcpPublicName('demo','long/tool'),mcpPublicName('demo','long_tool'));
});
