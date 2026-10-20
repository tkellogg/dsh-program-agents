import{test}from'node:test';import assert from'node:assert/strict';import{mkdtemp,rm,readFile}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';import{DshProgramAdapter}from'../src/host/adapter.js';
const until=async(check:()=>boolean)=>{const end=Date.now()+3000;while(!check()&&Date.now()<end)await new Promise(r=>setTimeout(r,10));assert.ok(check());};
async function setup(directory:string,archived:string[]=[]){let adapter:DshProgramAdapter;const registry=new Map<string,any>(),calls:string[]=[];const agent:any={id:'owner',steer:()=>{},inject:()=>{},ctx:{get:()=>undefined,tools:{execute:async(call:any)=>{calls.push(call.name);const a=call.arguments;if(call.name==='program_start')return{isError:false,value:await adapter.start(agent,a.program,null)};if(call.name==='program_restart')return{isError:false,value:await adapter.restart(a.id,'owner')};throw Error('Unexpected tool');}}}};const ctx:any={get:(name:string)=>name==='workspaceRegistry'?{archivedSessionIds:archived}:name==='sessionController'?{resolveAgent:async()=>{registry.set('owner',agent);return{agent};}}:undefined,agents:{get:(id:string)=>registry.get(id),withInitiator:(_a:any,fn:()=>unknown)=>fn()},logger:{warn:()=>{}}};adapter=new DshProgramAdapter(ctx,{auditDirectory:directory});return{adapter,agent,registry,calls};}
test('startAtStartup cold-resumes actual persisted parent, starts child, archive stops it and archived startup never resumes',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'program-startup-'));let f=await setup(directory);
 try{f.registry.set('owner',f.agent);await f.adapter.register(f.agent,{name:'Resident',description:'Startup program',command:[process.execPath,'-e','setInterval(()=>{},1000)'],supervision:{startAtStartup:true}});await f.adapter.dispose();
 f=await setup(directory);await f.adapter.restoreStartup();const run=f.adapter.supervisor.list('owner')[0];assert.equal(run.state,'running');assert.deepEqual(f.calls,['program_start']);assert.equal(f.registry.get('owner'),f.agent);
 await f.adapter.stopSession('owner');assert.equal(f.adapter.supervisor.get(run.id,'owner').state,'stopped');await f.adapter.dispose();
 f=await setup(directory,['owner']);await f.adapter.restoreStartup();assert.equal(f.registry.size,0);assert.deepEqual(f.adapter.supervisor.list(),[]);assert.deepEqual(f.calls,[]);
 }finally{await f.adapter.dispose();await rm(directory,{recursive:true,force:true});}
});
test('opted-in on-failure restarts proven closed process with bounded budget, manual Stop prevents more',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'program-restart-'));const f=await setup(directory);try{
 f.registry.set('owner',f.agent);const descriptor=await f.adapter.register(f.agent,{name:'Fails',description:'Restart test',command:[process.execPath,'-e','process.exit(2)'],supervision:{restart:'on-failure',maxRestarts:2,restartDelayMs:100,errors:{enabled:false}}});await f.adapter.restoreStartup();const run=await f.adapter.start(f.agent,descriptor.program,null);
 await until(()=>f.adapter.supervisor.get(run.id,'owner').generation===3&&f.adapter.supervisor.get(run.id,'owner').state==='failed');assert.equal(f.calls.filter(c=>c==='program_restart').length,2);await f.adapter.stop(run.id,'owner');
 }finally{await f.adapter.dispose();await rm(directory,{recursive:true,force:true});}
});
