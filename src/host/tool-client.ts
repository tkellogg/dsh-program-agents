import type{Agent}from'@deepseek-ai/dsh-agent';
import type{Tool}from'../mcp.js';
import{ToolSchema}from'@modelcontextprotocol/core';
import type{JsonValue}from'../types.js';
import{mcpPublicName,mcpResult,mcpTool}from'./mcp.js';
import{json,object,text}from'./validation.js';
interface Access{tools?:string[];mcp?:Array<{server:string;tools:string[]}>}
const allowedNative=(name:string)=>!name.startsWith('program_')&&name!=='run_code';
/** Discover only tools already visible in the exact parent's DSH tool runtime. */
export function listToolEntries(owner:Agent,access:Access,server?:string):Tool[]{
 const schemas=owner.ctx.tools.schemas(owner),result:Tool[]=[];
 if(server===undefined)for(const schema of schemas){if(!access.tools?.includes(schema.name)||!allowedNative(schema.name))continue;result.push(mcpTool(schema));}
 for(const row of access.mcp??[]){if(server!==undefined&&server!==row.server)continue;for(const name of row.tools){const publicName=mcpPublicName(row.server,name),schema=schemas.find(s=>s.name===publicName);if(!schema)continue;const tool=mcpTool(schema),exposed=server===undefined?publicName:name;if(result.some(t=>t.name===exposed))continue;result.push({...tool,name:exposed});}}
 return result.map(tool=>{const parsed=ToolSchema.safeParse(tool);if(!parsed.success)throw Error('Tool definition is not a valid MCP tool');return parsed.data;});
}
export function listTools(owner:Agent,access:Access,input:Record<string,unknown>):JsonValue{
 const server=input.server===undefined?undefined:text(input.server,'MCP server',32),all=listToolEntries(owner,access,server);
 const cursor=input.cursor===undefined?0:Number(text(input.cursor,'cursor',8));if(!Number.isSafeInteger(cursor)||cursor<0||cursor>all.length)throw Error('Invalid tool cursor');
 const tools:Tool[]=[];let index=cursor;
 while(index<all.length&&tools.length<64){const candidate=[...tools,all[index]];if(Buffer.byteLength(JSON.stringify(candidate))>48000){if(!tools.length)throw Error('Tool definition exceeds bridge budget');break;}tools.push(all[index++]);}
 return json({tools,...index<all.length?{nextCursor:String(index)}:{}});
}
export async function callTool(owner:Agent,access:Access,input:Record<string,unknown>,signal:AbortSignal,execute:(name:string,args:JsonValue)=>Promise<{isError?:boolean;content?:unknown;value?:unknown}>):Promise<JsonValue>{
 signal.throwIfAborted();
 const name=text(input.name,'tool name',256),args=json(input.arguments??{});object(args);if(input._meta!==undefined)object(input._meta);
 const server=input.server===undefined?undefined:text(input.server,'MCP server',32);
 const entries=listToolEntries(owner,access,server);if(!entries.some(t=>t.name===name))throw Error('Tool unavailable or not granted');
 const publicName=server===undefined?name:mcpPublicName(server,name);
 const result=mcpResult(await execute(publicName,args),publicName.startsWith('mcp__'));
 return json(result,57344);
}
