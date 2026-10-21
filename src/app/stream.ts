import type{JsonValue}from'../types.js';
import type{CallOptions}from'./index.js';
import{assertJson,ProgramError,validName,isRecord}from'../runtime/protocol.js';
export type ProgramStreamCall=(method:string,input?:JsonValue,options?:CallOptions)=>AsyncIterable<JsonValue>;
export function createProgramStream(url:URL,token:string):ProgramStreamCall{
 let active=0;
 return async function*(method,input=null,options={}){
  if(!validName(method))throw new ProgramError('INVALID_INPUT','Invalid stream method');assertJson(input);const body=JSON.stringify({method,input});if(Buffer.byteLength(body)>65536)throw new ProgramError('LIMIT','Stream request exceeds64KiB');
  if(active>=8)throw new ProgramError('BACKPRESSURE','Program stream limit reached');options.signal?.throwIfAborted();
  const timeout=options.timeoutMs??120000;if(!Number.isSafeInteger(timeout)||timeout<1||timeout>120000)throw new ProgramError('INVALID_INPUT','Stream connection timeout must be1..120000ms');
  active++;const controller=new AbortController(),abort=()=>controller.abort(options.signal?.reason),timer=setTimeout(()=>controller.abort(new ProgramError('STREAM_RECONNECT','Refresh conversation snapshot')),timeout);options.signal?.addEventListener('abort',abort,{once:true});let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  try{
   const response=await fetch(new URL('/stream',url),{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',Accept:'application/x-ndjson'},body,signal:controller.signal,redirect:'error'});
   if(!response.ok){const errorReader=response.body?.getReader();const chunks:Uint8Array[]=[];let size=0;try{while(errorReader){const item=await errorReader.read();if(item.done)break;size+=item.value.byteLength;if(size>65536){await errorReader.cancel();throw new ProgramError('LIMIT','Stream error response too large');}chunks.push(item.value);}}finally{errorReader?.releaseLock();}const text=Buffer.concat(chunks).toString('utf8');let parsed:unknown;try{parsed=JSON.parse(text);}catch{}if(isRecord(parsed)&&isRecord(parsed.error))throw new ProgramError(String(parsed.error.code),String(parsed.error.message));throw new ProgramError('STREAM_FAILED',`Conversation stream HTTP${response.status}`);}
   if(!response.headers.get('content-type')?.startsWith('application/x-ndjson')||!response.body)throw new ProgramError('INVALID_RESPONSE','Expected conversation NDJSON stream');
   reader=response.body.getReader();const decoder=new TextDecoder('utf-8',{fatal:true});let pending='';
   while(true){const item=await reader.read();if(item.done)break;pending+=decoder.decode(item.value,{stream:true});while(pending.includes('\n')){const end=pending.indexOf('\n');if(Buffer.byteLength(pending.slice(0,end))>512*1024)throw new ProgramError('LIMIT','Conversation frame too large');const line=pending.slice(0,end);pending=pending.slice(end+1);if(!line)continue;const value:unknown=JSON.parse(line);assertJson(value);if(isRecord(value)&&value.type==='stream-error')throw new ProgramError(String(value.code),String(value.message));yield value;}if(Buffer.byteLength(pending)>512*1024)throw new ProgramError('LIMIT','Conversation frame too large');}
   if(pending.trim())throw new ProgramError('INVALID_RESPONSE','Conversation stream ended mid-frame');
  }finally{controller.abort();clearTimeout(timer);options.signal?.removeEventListener('abort',abort);await reader?.cancel().catch(()=>{});reader?.releaseLock();active--;}
 };
}
