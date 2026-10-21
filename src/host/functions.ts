import type{JsonValue,ProgramSnapshot}from'../types.js';
import{createResponseValidator,type ResponseValidator,type ResponseSchema}from'../requests.js';
export interface AppFunction {name:string;description:string;inputSchema?:JsonValue;handler:(input:JsonValue,context:{run:ProgramSnapshot;signal:AbortSignal})=>Promise<JsonValue>}
/** Host plugin functions are explicit JSON operations, never arbitrary JS evaluation. */
export class AppFunctions {
 private entries=new Map<string,AppFunction>();
 private validators=new Map<string,ResponseValidator>();
 register(fn:AppFunction){if(fn.inputSchema!==undefined&&(!fn.inputSchema||typeof fn.inputSchema!=='object'||Array.isArray(fn.inputSchema)||fn.inputSchema.type!=='object'))throw Error('Host tool inputSchema must have an object root');if(!/^[A-Za-z][A-Za-z0-9_.:-]{0,119}$/.test(fn.name)||this.entries.has(fn.name)||this.entries.size>=256)throw Error('Invalid, duplicate or excessive tool');const validator=createResponseValidator((fn.inputSchema??{type:'object',properties:{},additionalProperties:true})as ResponseSchema);const registered={...fn,...fn.inputSchema===undefined?{}:{inputSchema:structuredClone(fn.inputSchema)}};this.entries.set(fn.name,registered);this.validators.set(fn.name,validator);return()=>{if(this.entries.get(fn.name)===registered){this.entries.delete(fn.name);this.validators.delete(fn.name);}};}
 list(allowed:readonly string[]){return [...this.entries.values()].filter(f=>allowed.includes(f.name)).map(({handler,...metadata})=>metadata);}
 async call(name:string,input:JsonValue,allowed:readonly string[],run:ProgramSnapshot,signal:AbortSignal){if(!allowed.includes(name))throw Error('Function not granted');const fn=this.entries.get(name);if(!fn)throw Error('Function unavailable');signal.throwIfAborted();if(fn.inputSchema!==undefined)this.validators.get(name)!(input);return fn.handler(input,{run,signal});}
}
