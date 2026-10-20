import {object,exactKeys} from './validation.js';
export interface ProgramRpcResult {ok:boolean;value?:unknown;error?:{code:string;message:string;details:object}}
export type ProgramRpcHandler=(method:string,payload:unknown,signal:AbortSignal)=>Promise<ProgramRpcResult>;
/** Connection exact Fetch routes enforce existing Host/Origin + owner authentication
 * before invoking this bridge. Do not register it as an unprotected web route.
 */
export function programFetch(method:string,handler:ProgramRpcHandler):(request:Request)=>Promise<Response>{
 return async(request)=>{
  const type=request.headers.get('content-type')?.split(';',1)[0]?.trim();
  if(type!=='application/json')return new Response('Expected application/json',{status:415});
  const raw=await request.text();if(Buffer.byteLength(raw)>131072)return new Response('Request too large',{status:413});
  let rpcId='invalid';
  try{
   const envelope=object(JSON.parse(raw));exactKeys(envelope,['type','rpcId','method','payload']);
   if(typeof envelope.rpcId!=='string'||envelope.rpcId.length>256)throw Error('Invalid rpcId');rpcId=envelope.rpcId;
   if(envelope.type!=='client-request'||envelope.method!==`programAgents/${method}`)throw Error('Invalid endpoint envelope');
   const result=await handler(method,envelope.payload,request.signal);
   return Response.json({type:'server-response',rpcId,result});
  }catch(error){return Response.json({type:'server-response',rpcId,result:{ok:false,error:{code:'program-agents/rejected',message:error instanceof Error?error.message:'Invalid request',details:{}}}});}
 };
}
