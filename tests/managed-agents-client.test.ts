import{test}from'node:test';import assert from'node:assert/strict';import{createProgramAgents,responseType,responseTypes,AgentRequestError}from'../src/app/agents.js';import{ProgramError}from'../src/runtime/protocol.js';
const record=(status='pending',response?:unknown)=>({requestId:'req1',status,createdAt:new Date().toISOString(),deadline:new Date(Date.now()+60000).toISOString(),...response===undefined?{}:{response}});
test('ask accepts response type helper or plain string, polls only result reads and never repeats send',async()=>{
 let creates=0,waits=0;const api=createProgramAgents(async(method,input)=>{if(method==='agents.ask'){creates++;return record()as any;}if(method==='agents.wait'){waits++;return record('answered',{ok:true})as any;}throw Error(method);});
 const type=responseType<{ok:boolean}>({type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false});assert.deepEqual(await api.ask({name:'worker'},{work:1},type),{ok:true});assert.equal(creates,1);assert.equal(waits,1);
 const text=createProgramAgents(async()=>record('answered','very good')as any);assert.equal(await text.ask('parent','work',responseTypes.string()),'very good');assert.equal(await text.ask('parent','work'),'very good');
});
test('ask cancellation cancels durable response contract, never sends a second request',async()=>{
 const abort=new AbortController(),calls:string[]=[];const api=createProgramAgents(async(method,input,options)=>{calls.push(method);if(method==='agents.ask')return record()as any;if(method==='agents.cancel')return record('cancelled')as any;return new Promise((_resolve,reject)=>options!.signal!.addEventListener('abort',()=>reject(options!.signal!.reason),{once:true}));});
 const task=api.ask('parent','work',{signal:abort.signal});setTimeout(()=>abort.abort(),10);await assert.rejects(task,e=>e instanceof AgentRequestError&&e.code==='CANCELLED'&&e.requestId==='req1');assert.deepEqual(calls,['agents.ask','agents.wait','agents.cancel']);
});
test('ask validates final response, propagates known request errors and exposes ambiguous dispatch',async()=>{
 const malformed=createProgramAgents(async()=>record('answered',{notString:true})as any);await assert.rejects(()=>malformed.ask('parent','work'),e=>(e as any).code==='INVALID_RESPONSE');
 const denied=createProgramAgents(async()=>{throw new ProgramError('IDEMPOTENCY_CONFLICT','changed');});await assert.rejects(()=>denied.ask('parent','work'),e=>(e as any).code==='IDEMPOTENCY_CONFLICT');
 const unknown=createProgramAgents(async()=>record('dispatch-unknown')as any);await assert.rejects(()=>unknown.ask('parent','work'),e=>e instanceof AgentRequestError&&e.code==='DISPATCH_UNKNOWN'&&e.requestId==='req1');
});
