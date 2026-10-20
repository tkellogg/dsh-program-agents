import type{JsonValue,ProgramSnapshot}from'../types.js';
export interface AppFunction {name:string;description:string;inputSchema?:JsonValue;handler:(input:JsonValue,context:{run:ProgramSnapshot;signal:AbortSignal})=>Promise<JsonValue>}
/** Host plugin functions are explicit JSON operations, never arbitrary JS evaluation. */
export class AppFunctions {
 private entries=new Map<string,AppFunction>();
 register(fn:AppFunction){if(!/^[A-Za-z][A-Za-z0-9_.:-]{0,119}$/.test(fn.name)||this.entries.has(fn.name)||this.entries.size>=256)throw Error('Invalid, duplicate or excessive function');this.entries.set(fn.name,fn);return()=>{if(this.entries.get(fn.name)===fn)this.entries.delete(fn.name);};}
 list(allowed:readonly string[]){return [...this.entries.values()].filter(f=>allowed.includes(f.name)).map(({handler,...metadata})=>metadata);}
 async call(name:string,input:JsonValue,allowed:readonly string[],run:ProgramSnapshot,signal:AbortSignal){if(!allowed.includes(name))throw Error('Function not granted');const fn=this.entries.get(name);if(!fn)throw Error('Function unavailable');signal.throwIfAborted();return fn.handler(input,{run,signal});}
}
