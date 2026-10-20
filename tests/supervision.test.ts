import{test}from'node:test';import assert from'node:assert/strict';import{SupervisionPolicies}from'../src/host/policies.js';import{normalizeSupervision}from'../src/supervision.js';import type{ProgramSnapshot}from'../src/types.js';
const run:ProgramSnapshot={id:'run',generation:1,program:'app',ownerId:'owner',label:'App',state:'failed',startedAt:'',logs:[],messages:[],resources:[]};
const wait=(ms:number)=>new Promise(r=>setTimeout(r,ms));
test('supervision config validates opt-in bounded recovery and supervisor routes',()=>{
 assert.equal(normalizeSupervision(undefined),undefined);assert.deepEqual(normalizeSupervision({})?.restart,'never');assert.throws(()=>normalizeSupervision({restart:'forever'}));assert.throws(()=>normalizeSupervision({maxRestarts:Infinity}));assert.throws(()=>normalizeSupervision({supervisor:{mode:'arbitrary-agent',id:'x'}}));assert.equal(normalizeSupervision({supervisor:{mode:'dedicated-child'},startAtStartup:true})?.startAtStartup,true);
});
test('restart is bounded, rechecks archive eligibility and manual Stop suppresses recovery',async()=>{
 let eligible=true,restarts=0;const definition={command:['node'],supervision:{restart:'on-failure' as const,maxRestarts:2,restartDelayMs:10}};
 const policies=new SupervisionPolicies({definition:()=>definition,entries:()=>[],eligible:()=>eligible,live:()=>false,start:async()=>{},restart:async()=>{restarts++;},report:()=>{}});
 try{policies.changed(run);await wait(20);assert.equal(restarts,1);policies.changed({...run,generation:2});await wait(30);assert.equal(restarts,2);policies.changed({...run,generation:3});await wait(30);assert.equal(restarts,2);
 policies.manualStart('owner','app');policies.changed({...run,generation:4});eligible=false;await wait(20);assert.equal(restarts,2);eligible=true;
 policies.manualStart('owner','app');policies.changed({...run,generation:5});policies.manualStop(run);await wait(20);assert.equal(restarts,2);
 }finally{policies.dispose();}
});
test('startup restores only eligible unarchived opt-in definitions and avoids reentrant duplicate Session starts',async()=>{
 const entries=[{ownerId:'live',program:'app',definition:{command:['node'],supervision:{startAtStartup:true}}},{ownerId:'archived',program:'app',definition:{command:['node'],supervision:{startAtStartup:true}}},{ownerId:'live',program:'manual',definition:{command:['node']}}];const started:string[]=[];let policies:SupervisionPolicies;
 policies=new SupervisionPolicies({definition:()=>undefined,entries:()=>entries,eligible:owner=>owner!=='archived',live:()=>false,start:async(owner,program)=>{started.push(owner+':'+program);await policies.startup(owner);},restart:async()=>{},report:()=>{}});
 try{await policies.startup();assert.deepEqual(started,['live:app']);policies.archive('live');await policies.startup();assert.deepEqual(started,['live:app']);}finally{policies.dispose();}
});
