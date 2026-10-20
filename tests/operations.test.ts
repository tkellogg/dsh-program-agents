import{test}from'node:test';import assert from'node:assert/strict';import{mkdtemp,rm,writeFile,mkdir,appendFile}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';import{ProgramOperations}from'../src/host/operations.js';import type{ProgramSnapshot}from'../src/types.js';
const record=(level:string,event:string)=>({timestamp:new Date().toISOString(),level,log_type:'com.example.app.task.v1',message:'Task failed',event_id:event,data:{operation:'sync'}});
const run:ProgramSnapshot={id:'r1',generation:1,ownerId:'parent',program:'app',label:'App',state:'running',startedAt:'',logs:[],messages:[],resources:[]};
const until=async(predicate:()=>boolean)=>{const end=Date.now()+3000;while(!predicate()&&Date.now()<end)await new Promise(r=>setTimeout(r,10));assert.ok(predicate(),'timed out waiting for automatic delivery');};
test('standard ERROR stdout is buffered automatically, INFO is not, fatal process exit emits ERROR',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'ops-')),deliveries:any[]=[];const ops=new ProgramOperations(directory,()=>({command:['node'],supervision:{errors:{bufferMs:10,cooldownMs:100}}}),async(r,b)=>{assert.equal(r.ownerId,'parent');deliveries.push(b);});try{
 const line=JSON.stringify(record('ERROR','event-a'))+'\n';ops.output(run,JSON.stringify(record('INFO','info'))+'\n','stdout');ops.output(run,line.slice(0,35),'stderr');ops.output(run,line.slice(35),'stderr');await until(()=>deliveries.length===1);assert.equal(deliveries[0].data.count,1);assert.equal(deliveries[0].data.groups[0].sample.event_id,'event-a');
 ops.failed({...run,state:'failed',error:'Unhandled worker exit'});ops.terminal(run);await until(()=>deliveries.length===2);assert.equal(deliveries[1].data.groups[0].sample.error.name,'ProgramExit');
 }finally{await ops.dispose();await rm(directory,{recursive:true,force:true});}
});
test('registered JSONL file is tailed prelaunch and rotation-aware; final errors persist independently of run',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'ops-file-')),logs=join(directory,'logs'),file=join(logs,'app-log.jsonl');await mkdir(logs);await writeFile(file,JSON.stringify(record('ERROR','historical'))+'\n');const deliveries:any[]=[];const ops=new ProgramOperations(join(directory,'outbox'),()=>({command:['node'],logsPath:logs,supervision:{errors:{bufferMs:10}}}),async(_r,b)=>{deliveries.push(b);});
 try{await ops.prepare(run);await appendFile(file,JSON.stringify(record('ERROR','new'))+'\n');await until(()=>deliveries.length===1);assert.equal(deliveries[0].data.count,1);assert.equal(deliveries[0].data.groups[0].sample.event_id,'new');}finally{await ops.dispose();await rm(directory,{recursive:true,force:true});}
});
