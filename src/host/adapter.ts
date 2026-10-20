import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AuditJournal } from './audit.js';
import { BlockAssembler, createUserMessage, createSystemMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Context } from '@deepseek-ai/cordis';
import type { PluginConfig } from './contracts.js';
import { object, text, json, exactKeys } from './validation.js';
import { CapabilityRegistry, ProgramSupervisor } from '../runtime/index.js';
import type { JsonValue, ProgramSnapshot } from '../types.js';

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap { 'program-agent': {kind:'program-agent';runId:string;generation:number} }
}

/** No stale ToolRunContext is retained: every operation belongs to this run. */
export class DshProgramAdapter {
  readonly capabilities = new CapabilityRegistry();
  readonly supervisor: ProgramSupervisor;
  readonly journal:AuditJournal;
  private owners = new Map<string,Agent>();
  private lifecycle = new Map<string,string>();
  private notices = new Map<string,{at:number;count:number}>();
  constructor(readonly ctx: Context, readonly config: PluginConfig) {
    this.journal=new AuditJournal(config.auditDirectory??join(process.env.DSH_HOME??join(homedir(),'.dsh'),'program-agents','audit'));
    this.capabilities.register({name:'models.call',description:'One explicit text model call using an allowed DSH route; no automatic tool loop.',handler:(input,c)=>this.model(input,c.run,c.signal)});
    this.capabilities.register({name:'tools.call',description:'Call an explicitly allowed visible DSH tool through policy. Native presentation only.',handler:(input,c)=>this.tool(input,c.run,c.signal)});
    this.supervisor = new ProgramSupervisor({
      programs: config.programs ?? {}, capabilities:this.capabilities,
      maxRuns:config.maxRuns,maxHistory:config.maxHistory,startupTimeoutMs:config.startupTimeoutMs,stopTimeoutMs:config.stopTimeoutMs,callTimeoutMs:config.callTimeoutMs,
      onParentMessage:async(ownerId,body,run,signal)=>{
        signal.throwIfAborted(); const owner=this.owner(ownerId);
        // A program cannot keep waking the model without bound.
        const now=Date.now(),rate=this.notices.get(run.id);
        const bucket=rate&&now-rate.at<60000?rate:{at:now,count:0};
        if(bucket.count>=10)throw new Error('Parent notification rate limit (10/minute)');
        bucket.count++;this.notices.set(run.id,bucket);
        this.audit(run,randomUUID(),'parent.send','accepted',body);
        owner.steer(createUserMessage({content:[{type:'text',text:`Program ${run.label} (${run.id}, generation ${run.generation}) sent data:\n${JSON.stringify(body)}`}],source:{kind:'program-agent',runId:run.id,generation:run.generation}}));
      },
      onEvent:event=>{
        const r=event.run,key=r.id,signature=`${r.generation}:${r.state}`;
        if(this.lifecycle.get(key)===signature)return;
        this.lifecycle.set(key,signature);
        const owner=this.owners.get(r.ownerId);
        if(!owner||this.ctx.agents.get(owner.id)!==owner)return;
        try{this.journal.append({type:'lifecycle',ownerId:r.ownerId,runId:r.id,generation:r.generation,program:r.program,state:r.state});}catch{this.ctx.logger.warn('Program lifecycle journal full or unavailable');}
        if(['completed','failed','stopped'].includes(r.state)){
          owner.inject(createUserMessage({content:[{type:'text',text:`Supervised program ${r.label} (${r.id}, generation ${r.generation}) is ${r.state}. Inspect program_list for retained details.`}],source:{kind:'program-agent',runId:r.id,generation:r.generation}}));
        }
      }
    });
  }
  owner(id:string):Agent {
    const owner=this.owners.get(id);
    if(!owner||this.ctx.agents.get(owner.id)!==owner)throw new Error('Program owner is no longer live');
    return owner;
  }
  async start(agent:Agent,program:string,input:JsonValue=null,label?:string,signal?:AbortSignal){
    if(this.ctx.agents.get(agent.id)!==agent)throw new Error('Caller is no longer live');
    this.owners.set(String(agent.id),agent);
    return this.supervisor.start({program,ownerId:String(agent.id),input,...(label?{label}:{})},signal);
  }
  async ownerDisposed(agent:Agent):Promise<void> {
    if(this.owners.get(String(agent.id))!==agent)return;
    this.owners.delete(String(agent.id));
    await this.supervisor.revokeOwner(String(agent.id));
  }
  private audit(run:ProgramSnapshot,effectId:string,operation:string,phase:string,detail:JsonValue){
    this.owner(run.ownerId);
    this.journal.append({type:'effect',ownerId:run.ownerId,runId:run.id,generation:run.generation,effectId,operation,phase,detail});
  }
  private async model(input:JsonValue,run:ProgramSnapshot,signal:AbortSignal):Promise<JsonValue>{
    const o=object(input);exactKeys(o,['provider','model','prompt','system','maxTokens','reasoningEffort']);
    const provider=text(o.provider,'provider'),model=text(o.model,'model');const grant=this.config.programs?.[run.program];
    if(!grant?.models?.some(r=>r.provider===provider&&r.model===model))throw new Error('Model route not granted');
    const prompt=text(o.prompt,'prompt',49152);const maxTokens=o.maxTokens??Math.min(4096,grant.maxModelOutputTokens??4096);
    if(!Number.isSafeInteger(maxTokens)||Number(maxTokens)<1||Number(maxTokens)>(grant.maxModelOutputTokens??16384))throw new Error('Invalid model output cap');
    const owner=this.owner(run.ownerId),effectId=randomUUID();
    const messages=[...(o.system===undefined?[]:[createSystemMessage(text(o.system,'system',65536))]),{role:'user' as const,content:[{type:'text' as const,text:prompt}]}];
    const config=await owner.ctx.llm.prepareCall({provider,model,maxTokens:Number(maxTokens),...(o.reasoningEffort===undefined?{}:{reasoningEffort:ReasoningEffortId(text(o.reasoningEffort,'reasoningEffort'))})},signal);
    this.audit(run,effectId,'models.call','started',json({config,messages},1048576));
    const assembly=new BlockAssembler();let bytes=0;const outputController=new AbortController();
    const callSignal=AbortSignal.any([signal,outputController.signal]);
    try{
      await this.ctx.agents.withInitiator(owner,async()=>{
        for await(const chunk of owner.ctx.llm.stream({...config,provider,model,messages,signal:callSignal})){
          bytes+=Buffer.byteLength(JSON.stringify(chunk));if(bytes>49152){outputController.abort();throw new Error('Model response exceeds program IPC budget');}
          assembly.push(chunk);
        }
      });
      const finish=assembly.finish;
      const result=json({blocks:assembly.blocks(),usage:assembly.usage??null,finish},57344);
      this.audit(run,effectId,'models.call','settled',result);
      return result;
    }catch{
      this.audit(run,effectId,'models.call',signal.aborted?'outcome-unknown':'failed',null);
      throw new Error(signal.aborted?'Model call interrupted; billing/result may be unknown':'Model call failed; see parent effect log');
    }
  }
  private async tool(input:JsonValue,run:ProgramSnapshot,signal:AbortSignal):Promise<JsonValue>{
    const o=object(input);exactKeys(o,['name','args']);const name=text(o.name,'tool name'),grant=this.config.programs?.[run.program];
    if(!grant?.tools?.includes(name)||name.startsWith('program_')||name==='run_code')throw new Error('Tool not granted');
    const owner=this.owner(run.ownerId),args=json(o.args??{}),callId=`program-${run.id}-${run.generation}-${randomUUID()}`;
    if(!owner.ctx.tools.get(name,owner))throw new Error('Tool not visible to owner');
    // PTC-only calls require an active transport token. Never forge/reuse one.
    if(!owner.ctx.tools.schemas(owner).some(s=>s.name===name))throw new Error('Background program tool calls require the tool on the native visible surface');
    this.audit(run,callId,`tool:${name}`,'started',args);
    try{
      const result=await this.ctx.agents.withInitiator(owner,()=>owner.ctx.tools.execute({callId:callId as never,name,arguments:args,agent:owner,signal}));
      const value=json({isError:result.isError,content:result.content,...('value'in result?{value:result.value}:{} )},57344);
      this.audit(run,callId,`tool:${name}`,'settled',value);
      return value;
    }catch{
      this.audit(run,callId,`tool:${name}`,signal.aborted?'outcome-unknown':'failed',null);
      throw new Error(signal.aborted?'Tool outcome unknown after cancellation':'Tool failed; see parent effect log');
    }
  }
}
