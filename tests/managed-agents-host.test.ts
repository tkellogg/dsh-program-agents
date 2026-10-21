import{test}from'node:test';import assert from'node:assert/strict';import{mkdtemp,rm}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';import{DshProgramAdapter}from'../src/host/adapter.js';import{createProgramAgents}from'../src/app/agents.js';
async function fixture(options:{catalogHook?:(call:number)=>Promise<void>}={}){let catalogCalls=0;const directory=await mkdtemp(join(tmpdir(),'managed-agent-host-'));let adapter:DshProgramAdapter,program='',creates=0;const sent:any[]=[],children:any[]=[],registry=new Map<string,any>();
 const sub={listChildren:async()=>{await options.catalogHook?.(++catalogCalls);return children;}, sendMessage:async(_parent:any,id:string,content:any)=>{sent.push({id,content});const envelope=JSON.parse(content[0].text.slice(content[0].text.indexOf('\n')+1));if(envelope.kind==='dsh.program.request.v1'){if(envelope.body==='maximum-depth'){let deep:any='answer';for(let n=0;n<28;n++)deep=[deep];await adapter.replyToRequest(registry.get(id),'owner',program,envelope.request_id,deep);return'message-deep';}
   // Reply can race transport acceptance, but assignment must already be durable.
   await adapter.replyToRequest(registry.get(id),'owner',program,envelope.request_id,envelope.body.structured?{verdict:'good'}:'very good');
  }return'message-'+sent.length;}};
 const owner:any={id:'owner',steer:(m:any)=>sent.push(m),ctx:{get:(name:string)=>name==='subagents'?sub:undefined,tools:{execute:async(call:any)=>{assert.equal(call.name,'subagent');creates++;const id='child-'+creates;const child={id};registry.set(id,child);children.push({id,label:call.arguments.description,mode:'continuable'});return{isError:false,value:{subagentId:id},content:[]};}}}};registry.set(owner.id,owner);
 const ctx:any={agents:{get:(id:string)=>registry.get(id),isOwnedBy:()=>false,withInitiator:(_owner:any,fn:()=>unknown)=>fn()},get:()=>undefined,logger:{warn:()=>{}}};adapter=new DshProgramAdapter(ctx,{auditDirectory:directory});const d=await adapter.register(owner,{name:'App',description:'Ask test',command:[process.execPath,'-e','setInterval(()=>{},1000)'],access:{messaging:true},supervision:{errors:{enabled:false}}});program=d.program;const run=await adapter.start(owner,program,null);const call:any=(method:string,input:any=null,options:any={})=>adapter.appCall(run,method,input,options.signal??new AbortController().signal);return{adapter,owner,run,program,agents:createProgramAgents(call),sent,children,registry,creates:()=>creates,cleanup:async()=>{await adapter.dispose();await rm(directory,{recursive:true,force:true});}};
}
test('ask implicitly creates named agent, assigns before delivery, validates one reply, reuses named target for send/ask',async()=>{
 const f=await fixture();try{
 // Discovery is bounded but routing must not confuse a truncated catalog with absence.
 for(let n=0;n<70;n++)f.children.push({id:'historical-'+n,label:'Old '+n,mode:'continuable'});
 const answer=await f.agents.ask({name:'Reviewer'},'Review item',{requestId:'review-1'});assert.equal(answer,'very good');assert.equal(f.creates(),1);
 const typed=await f.agents.ask({name:'Reviewer'},{structured:true},{requestId:'review-2',responseSchema:{type:'object',properties:{verdict:{type:'string',enum:['good','bad']}},required:['verdict'],additionalProperties:false}});assert.deepEqual(typed,{verdict:'good'});assert.equal(f.creates(),1);
 await f.agents.send({name:'Reviewer'},{type:'followup'});assert.equal(f.creates(),1);
 await f.agents.send({create:{name:'One shot'}},{type:'work'});assert.equal(f.creates(),2);
 const requests=await f.agents.request('review-1');assert.equal(requests?.status,'answered');const before=f.sent.length;assert.equal(await f.agents.ask({name:'Reviewer'},'Review item',{requestId:'review-1'}),'very good');assert.equal(f.sent.length,before);
 await assert.rejects(()=>f.agents.ask({name:'Reviewer'},'Changed work',{requestId:'review-1'}),e=>(e as any).code==='IDEMPOTENCY_CONFLICT');
 await assert.rejects(()=>f.adapter.replyToRequest(f.registry.get('child-2'),'owner',f.program,requests!.requestId,'fake'),/assigned|agent/i);
 await assert.rejects(()=>f.adapter.replyToRequest(f.registry.get('child-1'),'owner',f.program,requests!.requestId,'different'),/already|response|repl/i);
 await assert.rejects(()=>f.agents.send('unrelated-session',{type:'work'}),/direct|parent|child/);
 }finally{await f.cleanup();}
});
test('maximum accepted reply depth remains retrievable through app API envelopes',async()=>{
 const f=await fixture();try{const value:any=await f.agents.ask({name:'Deep'},'maximum-depth',{responseSchema:true});let item=value;for(let n=0;n<28;n++){assert.equal(Array.isArray(item),true);item=item[0];}assert.equal(item,'answer');}finally{await f.cleanup();}
});
test('cancel during delayed pre-dispatch catalog lookup prevents sending work',async()=>{
 let release!:()=>void,paused!:()=>void;const gate=new Promise<void>(r=>release=r),reached=new Promise<void>(r=>paused=r);const f=await fixture({catalogHook:async n=>{if(n===2){paused();await gate;}}});
 try{f.children.push({id:'existing',label:'Existing',mode:'continuable'});f.registry.set('existing',{id:'existing'});const task=f.agents.ask('existing','work',{requestId:'cancel-before-send'});const rejected=assert.rejects(task,e=>(e as any).code==='CANCELLED');await reached;assert.equal((await f.agents.cancel('cancel-before-send')).status,'cancelled');release();await rejected;assert.equal(f.sent.length,0);assert.equal(f.creates(),0);}finally{release();await f.cleanup();}
});
test('invalid response schemas cannot create or dispatch an Agent',async()=>{
 const f=await fixture();try{await assert.rejects(()=>f.agents.ask({create:{name:'Never create'}},'work',{responseSchema:{type:'object',unsupported:true}}),e=>(e as any).code==='INVALID_SCHEMA');assert.equal(f.creates(),0);assert.equal(f.sent.length,0);}finally{await f.cleanup();}
});
