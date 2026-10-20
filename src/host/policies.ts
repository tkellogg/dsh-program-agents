import type{ProgramDefinition,ProgramSnapshot}from'../types.js';
import type{SupervisionSettings}from'../supervision.js';
interface PolicyHost {
 definition(owner:string,program:string):ProgramDefinition|undefined;
 entries():Array<{ownerId:string;program:string;definition:ProgramDefinition}>;
 eligible(owner:string):boolean;
 live(owner:string,program:string):boolean;
 start(owner:string,program:string):Promise<unknown>;
 restart(run:ProgramSnapshot):Promise<unknown>;
 report(run:ProgramSnapshot,error:unknown):void;
}
/** Opt-in process recovery. Never retries individual calls or infers application idempotence. */
export class SupervisionPolicies {
 private timers=new Map<string,ReturnType<typeof setTimeout>>();
 private attempts=new Map<string,number>();private suppressed=new Set<string>();private signatures=new Map<string,string>();
 private closed=false;private starting=new Set<string>();private startingOwners=new Set<string>();
 constructor(private host:PolicyHost){}
 private key(owner:string,program:string){return owner+'\0'+program;}
 manualStart(owner:string,program:string){const k=this.key(owner,program);this.suppressed.delete(k);this.attempts.delete(k);this.cancel(k);}
 manualStop(run:ProgramSnapshot){const k=this.key(run.ownerId,run.program);this.suppressed.add(k);this.cancel(k);}
 private cancel(k:string){const timer=this.timers.get(k);if(timer)clearTimeout(timer);this.timers.delete(k);}
 changed(run:ProgramSnapshot){
  if(this.closed)return;
  const k=this.key(run.ownerId,run.program),signature=run.id+':'+run.generation+':'+run.state;
  if(this.signatures.get(k)===signature)return;this.signatures.set(k,signature);
  if(!['failed','completed'].includes(run.state)||this.suppressed.has(k)||!this.host.eligible(run.ownerId))return;
  const policy=this.host.definition(run.ownerId,run.program)?.supervision;
  if(!policy||policy.restart==='never'||policy.restart===undefined||policy.restart==='on-failure'&&run.state!=='failed')return;
  const attempts=this.attempts.get(k)??0,max=policy.maxRestarts??3;
  if(attempts>=max)return;
  this.cancel(k);const delay=Math.min(300000,(policy.restartDelayMs??1000)*2**Math.min(attempts,8));
  this.attempts.set(k,attempts+1);
  this.timers.set(k,setTimeout(()=>{this.timers.delete(k);if(this.closed||this.suppressed.has(k)||!this.host.eligible(run.ownerId))return;void this.host.restart(run).catch(error=>this.host.report(run,error));},delay));
 }
 /** Called only after archive/session services are available, and on Agent publication. */
 async startup(ownerId?:string){
  if(this.closed)return;
  for(const entry of this.host.entries()){
   if(ownerId!==undefined&&entry.ownerId!==ownerId||!entry.definition.supervision?.startAtStartup||!this.host.eligible(entry.ownerId))continue;
   const k=this.key(entry.ownerId,entry.program);if(this.startingOwners.has(entry.ownerId)||this.starting.has(k)||this.host.live(entry.ownerId,entry.program)||this.suppressed.has(k))continue;
   this.starting.add(k);this.startingOwners.add(entry.ownerId);
   try{await this.host.start(entry.ownerId,entry.program);}catch(error){this.host.report({id:'startup',generation:0,ownerId:entry.ownerId,program:entry.program,label:entry.definition.name??entry.program,state:'failed',startedAt:new Date().toISOString(),logs:[],messages:[],resources:[]},error);}finally{this.starting.delete(k);this.startingOwners.delete(entry.ownerId);}
  }
 }
 archive(ownerId:string){for(const entry of this.host.entries())if(entry.ownerId===ownerId){const k=this.key(ownerId,entry.program);this.suppressed.add(k);this.cancel(k);}}
 dispose(){this.closed=true;for(const key of this.timers.keys())this.cancel(key);this.starting.clear();this.startingOwners.clear();}
}
