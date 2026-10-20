import{createHash}from'node:crypto';
import type{ProgramDefinition,ProgramSnapshot}from'../types.js';
import{ErrorBuffer,LogTailer,parseLogLine,JsonlDecoder}from'../monitoring/index.js';

/** ERROR ingestion stays independent of process lifetime, so fatal exit cannot
 * revoke delivery before buffered reports reach their configured supervisor. */
export class ProgramOperations {
 private buffers=new Map<string,ErrorBuffer>();private tails=new Map<string,LogTailer>();private partial=new Map<string,JsonlDecoder>();
 private stopped=false;
 constructor(private directory:string,private definition:(run:ProgramSnapshot)=>ProgramDefinition|undefined,private deliver:(run:ProgramSnapshot,body:unknown,signal?:AbortSignal)=>Promise<void>){}
 private key(run:ProgramSnapshot){return run.ownerId+'\0'+run.program;}
 private buffer(run:ProgramSnapshot){
  const key=this.key(run);let buffer=this.buffers.get(key);if(buffer)return buffer;
  const errors=this.definition(run)?.supervision?.errors;
  buffer=new ErrorBuffer({key:createHash('sha256').update(key).digest('hex'),directory:this.directory,enabled:errors?.enabled!==false,bufferMs:errors?.bufferMs??1000,maxBatch:errors?.maxBatch??20,cooldownMs:errors?.cooldownMs??30000,deliver:(body,signal)=>this.deliver(run,body,signal)});this.buffers.set(key,buffer);return buffer;
 }
 restore(run:ProgramSnapshot){if(!this.stopped)this.buffer(run);}
 async prepare(run:ProgramSnapshot){this.started(run);await this.tails.get(this.key(run))?.ready;}
 started(run:ProgramSnapshot){
  if(this.stopped)return;this.buffer(run);
  const path=this.definition(run)?.logsPath;if(!path)return;
  const key=this.key(run);if(this.tails.has(key))return;
  const tail=new LogTailer({logsPath:path,readExisting:false,cursorPath:this.directory+'/'+createHash('sha256').update(key).digest('hex')+'.cursor.json',onRecord:async(record,pointer)=>{const buffer=this.buffer(run);buffer.add(record,{...pointer,run:{id:run.id,generation:run.generation}});await buffer.checkpoint();}});this.tails.set(key,tail);void tail.ready.catch(()=>{});
 }
 output(run:ProgramSnapshot,chunk:string,stream:'stdout'|'stderr'){
  if(this.stopped)return;const key=run.id+':'+run.generation+':'+stream;
  let decoder=this.partial.get(key);if(!decoder){decoder=new JsonlDecoder(record=>this.buffer(run).add(record,{path:run.logsPath,run:{id:run.id,generation:run.generation}}));this.partial.set(key,decoder);}decoder.push(chunk);
 }
 failed(run:ProgramSnapshot){
  if(this.stopped)return;
  const record=parseLogLine(JSON.stringify({timestamp:new Date().toISOString(),level:'ERROR',log_type:'dsh.program.error.v1',message:run.error??'Program process failed',event_id:`process-${run.id}-${run.generation}`,error:{name:'ProgramExit',message:run.error??'Program process failed'},data:{unhandled:true,run_id:run.id,generation:run.generation,logs_path:run.logsPath??null}}));
  if(record)this.buffer(run).add(record,{path:run.logsPath,run:{id:run.id,generation:run.generation}});
 }
 terminal(run:ProgramSnapshot){for(const key of this.partial.keys())if(key.startsWith(run.id+':'))this.partial.delete(key);void this.buffer(run).flush().catch(()=>{});}
 async dispose(){this.stopped=true;for(const tail of this.tails.values())await tail.close();this.tails.clear();for(const buffer of this.buffers.values())await buffer.close();this.buffers.clear();this.partial.clear();}
}
