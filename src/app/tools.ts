import type{CallToolRequestParams,CallToolResult,ListToolsResult,Tool}from'../mcp.js';
import type{JsonValue}from'../types.js';
import type{CallOptions}from'./index.js';
export type{CallToolRequestParams,CallToolResult,ListToolsResult,Tool}from'../mcp.js';
export type ToolBridgeCall=<T=JsonValue>(method:string,input?:JsonValue,options?:CallOptions)=>Promise<T>;
/** MCP Client-shaped tool subset over DSH's authenticated, policy-gated bridge.
 * Not a full MCP Client/transport: no initialize/resources/prompts/sampling/tasks. */
export interface ProgramToolClient{
 listTools(params?:{cursor?:string},options?:CallOptions):Promise<ListToolsResult>;
 callTool(params:CallToolRequestParams,options?:CallOptions):Promise<CallToolResult>;
 /** @deprecated Use callTool({name,arguments}). Kept for old programs. */
 call<T=JsonValue>(name:string,args?:JsonValue,options?:CallOptions):Promise<T>;
}
export function createProgramTools(call:ToolBridgeCall,server?:string):ProgramToolClient{
 return{
  listTools:async(params={},options)=>{
   if(params.cursor!==undefined)return call<ListToolsResult>('tools.listTools',{...params,...server===undefined?{}:{server}}as JsonValue,options);
   const tools:Tool[]=[],seen=new Set<string>();let cursor:string|undefined;
   for(let page=0;page<64;page++){
    const result=await call<ListToolsResult>('tools.listTools',{...cursor===undefined?{}:{cursor},...server===undefined?{}:{server}}as JsonValue,options);tools.push(...result.tools);
    if(result.nextCursor===undefined)return{tools};if(seen.has(result.nextCursor))throw new Error('Tool listing repeated a pagination cursor');seen.add(result.nextCursor);cursor=result.nextCursor;
   }
   throw new Error('Tool listing exceeded 64 pages');
  },
  callTool:(params,options)=>call<CallToolResult>('tools.callTool',{...params,...server===undefined?{}:{server}}as JsonValue,options),
  call:(name,args={},options)=>server===undefined?call('tools.call',{name,args},options):call('mcp.call',{server,tool:name,args},options),
 };
}
