import{randomUUID}from'node:crypto';
import type{JsonValue}from'../types.js';
import{createResponseValidator,type AgentTarget,type ResponseSchema,type RequestRecord}from'../requests.js';
import{ProgramError}from'../runtime/protocol.js';
import type{AgentInfo,CallOptions,SendOptions}from'./index.js';
export type{AgentTarget,ResponseSchema,JSONSchema,RequestStatus,ResponseReceipt}from'../requests.js';
export interface AgentRequestView{requestId:string;status:RequestRecord['status'];agentId?:string;createdAt:string;deadline:string;response?:JsonValue;error?:string}
export interface AskOptions extends CallOptions{requestId?:string;responseSchema?:ResponseSchema;instructions?:string}
/** Runtime schema plus identity parser for statically typed ask results. A TS
 * interface alone disappears at runtime and cannot validate an Agent reply. */
export interface AgentResponseType<T extends JsonValue>{readonly schema:ResponseSchema;parse(value:JsonValue):T}
export function responseType<T extends JsonValue>(schema:ResponseSchema):AgentResponseType<T>{const validate=createResponseValidator(schema);return{schema,parse(value){validate(value);return value as T;}};}
export const responseTypes={string:()=>responseType<string>({type:'string'})};
export class AgentRequestError extends ProgramError{
 constructor(code:string,message:string,readonly requestId:string,readonly status:RequestRecord['status']){super(code,message);}
}
export type AgentBridgeCall=<T=JsonValue>(method:string,input?:JsonValue,options?:CallOptions)=>Promise<T>;
export interface ProgramAgents{
 list(options?:CallOptions):Promise<AgentInfo[]>;
 get(id:string,options?:CallOptions):Promise<AgentInfo|null>;
 send(target:AgentTarget,body:JsonValue,options?:SendOptions):Promise<JsonValue>;
 ask(target:AgentTarget,body:JsonValue,options?:AskOptions&{responseSchema?:undefined}):Promise<string>;
 ask<T extends JsonValue=JsonValue>(target:AgentTarget,body:JsonValue,options:AskOptions&{responseSchema:ResponseSchema}):Promise<T>;
 ask<T extends JsonValue>(target:AgentTarget,body:JsonValue,responseType:AgentResponseType<T>,options?:AskOptions):Promise<T>;
 request(requestId:string,options?:CallOptions):Promise<AgentRequestView|null>;
 cancel(requestId:string,options?:CallOptions):Promise<AgentRequestView>;
}
export function createProgramAgents(call:AgentBridgeCall):ProgramAgents{
 const request=(requestId:string,options?:CallOptions)=>call<AgentRequestView|null>('agents.request',{requestId},options);
 const cancel=(requestId:string,options?:CallOptions)=>call<AgentRequestView>('agents.cancel',{requestId},options);
 const ask=async(target:AgentTarget,body:JsonValue,options:AskOptions={}):Promise<JsonValue>=>{
  const timeout=options.timeoutMs??120000;if(!Number.isSafeInteger(timeout)||timeout<1||timeout>3600000)throw new ProgramError('INVALID_INPUT','Agent ask timeout must be 1..3600000ms');
  options.signal?.throwIfAborted();const key=options.requestId??randomUUID();
  // Compile before sending anything: invalid schemas cannot spend model tokens.
  const validate=createResponseValidator(options.responseSchema);let view:AgentRequestView|undefined;
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(new ProgramError('TIMEOUT','Agent response deadline exceeded')),timeout);
  const abort=()=>controller.abort(options.signal?.reason??new ProgramError('CANCELLED','Agent ask cancelled'));options.signal?.addEventListener('abort',abort,{once:true});
  try{
   view=await call<AgentRequestView>('agents.ask',{target:target as JsonValue,body,requestId:key,timeoutMs:timeout,...options.responseSchema===undefined?{}:{responseSchema:options.responseSchema},...options.instructions===undefined?{}:{prompt:options.instructions}},{signal:controller.signal,timeoutMs:Math.min(timeout,120000)});
   while(view.status==='pending')view=await call<AgentRequestView>('agents.wait',{requestId:view.requestId,waitMs:Math.min(25000,Math.max(0,Date.parse(view.deadline)-Date.now()))},{signal:controller.signal,timeoutMs:30000});
   if(view.status==='answered'){validate(view.response);return view.response!;}
   throw new AgentRequestError(view.status==='dispatch-unknown'?'DISPATCH_UNKNOWN':view.status==='expired'?'TIMEOUT':view.status==='cancelled'?'CANCELLED':'AGENT_REQUEST_FAILED',view.error??'Agent request '+view.status,view.requestId,view.status);
  }catch(error){
   // Cancellation only settles this response contract, never pretends the Agent's
   // reasoning/external effects were undone. No message/delegation retries.
   if(controller.signal.aborted){await cancel(view?.requestId??key,{timeoutMs:5000}).catch(()=>{});throw new AgentRequestError(options.signal?.aborted?'CANCELLED':'TIMEOUT','Agent ask interrupted; inspect the durable request before repeating work',view?.requestId??key,view?.status??'pending');}
   if(error instanceof AgentRequestError)throw error;
   if(view?.status==='answered'&&error instanceof ProgramError&&error.code==='INVALID_RESPONSE')throw error;
   if(error instanceof ProgramError&&!['TIMEOUT','CANCELLED','INVALID_RESPONSE','CALL_FAILED'].includes(error.code))throw error;
   throw new AgentRequestError('DISPATCH_UNKNOWN','Request transport failed; inspect using the request key before repeating work',view?.requestId??key,view?.status??'dispatch-unknown');
  }finally{clearTimeout(timer);options.signal?.removeEventListener('abort',abort);}
 };
 return{
  list:options=>call('agents.list',null,options),get:(id,options)=>call('agents.get',{id},options),
  send:(target,body,options={})=>call('agents.send',{...typeof target==='string'?{id:target}:{target:target as JsonValue},body,...options.correlationId===undefined?{}:{correlationId:options.correlationId}},options),
  ask:((target:AgentTarget,body:JsonValue,typeOrOptions:AgentResponseType<JsonValue>|AskOptions={},options:AskOptions={})=>{
   if('schema'in typeOrOptions&&'parse'in typeOrOptions)return ask(target,body,{...options,responseSchema:typeOrOptions.schema}).then(value=>typeOrOptions.parse(value));
   return ask(target,body,typeOrOptions as AskOptions);
  })as ProgramAgents['ask'],request,cancel,
 };
}
