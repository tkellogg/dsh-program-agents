import type{ServerResponse}from'node:http';
import type{JsonValue}from'../types.js';
import{assertJson,ProgramError}from'../runtime/protocol.js';
/** Drain the native iterator independently of HTTP backpressure. Native DSH's
 * follow queue must never become an unbounded slow-browser buffer. */
export async function writeProgramStream(response:ServerResponse,source:AsyncIterable<JsonValue>,controller:AbortController,options:{maxFrameBytes?:number;maxQueueBytes?:number;maxQueueFrames?:number}={}):Promise<void>{
 const maxFrame=options.maxFrameBytes??512*1024,maxBytes=options.maxQueueBytes??1024*1024,maxFrames=options.maxQueueFrames??128;
 const queue:Buffer[]=[];let bytes=0,done=false,failure:unknown,wake:(()=>void)|undefined;
 const notify=()=>{wake?.();wake=undefined;};const abort=()=>{failure??=controller.signal.reason;notify();};controller.signal.addEventListener('abort',abort,{once:true});
 const iterator=source[Symbol.asyncIterator]();let cleanup:Promise<unknown>|undefined;
 const pump=(async()=>{try{while(!controller.signal.aborted){const item=await iterator.next();if(item.done)break;assertJson(item.value);const line=Buffer.from(JSON.stringify(item.value)+'\n');if(line.length>maxFrame||bytes+line.length>maxBytes||queue.length>=maxFrames)throw new ProgramError('STREAM_OVERFLOW','Conversation stream exceeded its bounded buffer; reconnect for a fresh native snapshot');queue.push(line);bytes+=line.length;notify();}}
  catch(error){failure=error;controller.abort(error);}finally{done=true;notify();}})();
 void pump.catch(()=>{});
 response.writeHead(200,{'Content-Type':'application/x-ndjson; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Accel-Buffering':'no'});response.flushHeaders();
 try{
  while(!controller.signal.aborted){if(queue.length){const line=queue.shift()!;bytes-=line.length;if(!response.write(line))await new Promise<void>((resolve,reject)=>{const cleanup=()=>{response.off('drain',drain);controller.signal.removeEventListener('abort',cancel);};const drain=()=>{cleanup();resolve();},cancel=()=>{cleanup();reject(controller.signal.reason);};response.once('drain',drain);controller.signal.addEventListener('abort',cancel,{once:true});if(controller.signal.aborted)cancel();});continue;}if(done)break;await new Promise<void>(resolve=>{wake=resolve;if(done||controller.signal.aborted||queue.length)notify();});}
 }catch(error){failure??=error;}
 finally{
  controller.signal.removeEventListener('abort',abort);if(!controller.signal.aborted)controller.abort(new Error('Stream completed'));
  // A misbehaving iterator may ignore cancellation; retain the caller's resource
  // slot until it actually settles. Never await unbounded cleanup for the socket.
  cleanup=Promise.resolve().then(()=>iterator.return?.()).catch(()=>{});
  if(!response.destroyed&&!response.writableEnded){if(failure){const message=failure instanceof Error?failure.message:'Stream interrupted';response.write(JSON.stringify({type:'stream-error',code:failure instanceof ProgramError?failure.code:'INTERRUPTED',message:message.slice(0,512)})+'\n');}response.end();}
 }
 await pump;await cleanup;
}
