import type{CallToolResult,Tool}from'../mcp.js';
import{CallToolResultSchema}from'@modelcontextprotocol/core';
import type{JsonValue}from'../types.js';
import{isRecord,ProgramError}from'../runtime/protocol.js';
/** Preserve upstream MCP blocks when DSH's MCP adapter retained their canonical
 * value; native DSH tools are adapted as text + structured JSON. */
export function mcpResult(result:{isError?:boolean;content?:unknown;value?:unknown},upstream=false):CallToolResult{
 let value:unknown;
 if(upstream&&!result.isError&&isRecord(result.value)&&Array.isArray(result.value.content))value={...result.value,isError:false};
 else{const content=projectContent(result.content);if(!content.length&&result.value!==undefined)content.push({type:'text',text:JSON.stringify(result.value)});value={content,...isRecord(result.value)?{structuredContent:result.value}:{},isError:result.isError===true};}
 const checked=CallToolResultSchema.safeParse(value);
 if(!checked.success)throw new ProgramError('INVALID_RESULT','Tool result cannot be represented as MCP content');
 return checked.data;
}
function projectContent(input:unknown):Array<{type:'text';text:string}>{
 if(!Array.isArray(input))return[];
 return input.map(block=>isRecord(block)&&block.type==='text'&&typeof block.text==='string'?{type:'text' as const,text:block.text}:{type:'text' as const,text:JSON.stringify(block)});
}
export function mcpTool(schema:unknown):Tool{
 if(!isRecord(schema)||typeof schema.name!=='string')throw new ProgramError('INVALID_TOOL','Invalid native tool schema');
 const parameters=isRecord(schema.parameters)?schema.parameters:isRecord(schema.inputSchema)?schema.inputSchema:{type:'object',properties:{}};
 return{name:schema.name,...typeof schema.description==='string'?{description:schema.description}:{},inputSchema:{...parameters,type:'object'}as Tool['inputSchema']};
}
/** Mirrors DSH MCP namespace algorithm, including hash suffix when normalized. */
export function mcpPublicName(server:string,tool:string):string{
 const clean=`mcp__${server}__${tool}`.replace(/[^a-zA-Z0-9_-]/g,'_');
 // Clean short names are the established common path. Hash algorithm is supplied
 // separately below, avoiding conflating different original tool identities.
 if(clean===`mcp__${server}__${tool}`&&clean.length<=64)return clean;
 return hashedName(server,tool,clean);
}
import{createHash}from'node:crypto';
function hashedName(server:string,tool:string,clean:string){return clean.slice(0,51)+'_'+createHash('sha256').update(server+'\0'+tool).digest('hex').slice(0,12);}
