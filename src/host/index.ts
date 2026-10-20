import { Service, type Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { PluginConfig } from './contracts.js';
import { DshProgramAdapter } from './adapter.js';
import { object, text, json, exactKeys } from './validation.js';
import type { ProgramSnapshot } from '../types.js';
export type { PluginConfig, ProgramGrant } from './contracts.js';
export { DshProgramAdapter } from './adapter.js';
export const name='program-agents';
export const inject=['tools','agents','llm'];
export const Config: z<PluginConfig>=z.object({
  auditDirectory:z.string(),
  programs:z.dict(z.object({entry:z.string().required(),cwd:z.string(),args:z.array(z.string()),env:z.dict(z.string()).role('secret'),allowedCapabilities:z.array(z.string()),models:z.array(z.object({provider:z.string().required(),model:z.string().required()})),tools:z.array(z.string()),maxModelOutputTokens:z.number().min(1).step(1)})).default({}),
  maxRuns:z.number().min(1).max(64).step(1).default(8),
  maxHistory:z.number().min(1).max(256).step(1).default(64),
  startupTimeoutMs:z.number().min(100).default(10000),
  stopTimeoutMs:z.number().min(100).default(3000),
  callTimeoutMs:z.number().min(100).default(120000)
});
declare module '@deepseek-ai/cordis' {interface Context {programAgents:ProgramAgentsService}}
export class ProgramAgentsService extends Service {
  readonly adapter:DshProgramAdapter;
  constructor(ctx:Context,config:PluginConfig){super(ctx,'programAgents');this.adapter=new DshProgramAdapter(ctx,config);}
  get supervisor(){return this.adapter.supervisor;}
  get capabilities(){return this.adapter.capabilities;}
}
function caller(exec:{agent?:Agent}):Agent{if(!exec.agent)throw new Error('A live parent Agent is required');return exec.agent;}
const output={schema:{type:'json' as const},render:(_args:unknown,value:unknown)=>[{type:'text' as const,text:JSON.stringify(value)}]};

export function apply(ctx:Context,config:PluginConfig={}){
  const service=new ProgramAgentsService(ctx,config),a=service.adapter;
  ctx.effect(()=>()=>a.supervisor.dispose().finally(()=>a.journal.close()));
  ctx.on('agent/disposed',({agent})=>a.ownerDisposed(agent));
  ctx.tools.register(defineTool({name:'program_start',description:'Start a configured trusted Node program as a supervised child. Returns after connection, not completion. No automatic restart or application-state durability.',parameters:{program:{type:'string',required:true},input:{type:'json'},label:{type:'string'}},output,execute:async(args,exec)=>json(await a.start(caller(exec),args.program,args.input??null,args.label,exec.signal),1048576)}));
  ctx.tools.register(defineTool({name:'program_list',description:'Inspect your supervised programs, including bounded logs, messages, state and available dashboard links.',parameters:{},output,execute:async(_args,exec)=>json(a.supervisor.list(String(caller(exec).id)),4*1048576)}));
  ctx.tools.register(defineTool({name:'program_send',description:'Send JSON input to one of your running programs. Delivery is in-memory acceptance, not durable processing.',parameters:{id:{type:'string',required:true},generation:{type:'integer',required:true},body:{type:'json',required:true}},output,execute:async(args,exec)=>{const owner=String(caller(exec).id);a.owner(owner);fence(a.supervisor.get(args.id,owner),args.generation);await a.supervisor.send(args.id,owner,args.body);return {accepted:true};}}));
  for(const action of ['stop','restart']as const)ctx.tools.register(defineTool({name:`program_${action}`,description:action==='stop'?'Stop a supervised program and its process group. Reports incomplete cleanup rather than claiming it stopped.':'Explicitly restart a program after stopping its previous generation. Application must restore its own state and deduplicate side effects.',parameters:{id:{type:'string',required:true},generation:{type:'integer',required:true}},output,execute:async(args,exec)=>{const owner=String(caller(exec).id);a.owner(owner);fence(a.supervisor.get(args.id,owner),args.generation);return json(await a.supervisor[action](args.id,owner),1048576);}}));
  // A dedicated authenticated Connection channel; /api is owned by DSH Gateway.
  // Fail closed for non-owner peers; no custom credentials or launcher endpoint.
  ctx.inject(['connection'],c=>{
    const connection=c.get('connection') as unknown as Connection;
    c.effect(()=>connection.rpc.handle('/program-agents',async(endpoint,payload,signal,peer)=>{
      try{
        if(peer.principal.kind!=='owner')throw new Error('Only the authenticated owner may access program controls');
        signal.throwIfAborted();
        if(!['list','send','stop','restart'].includes(endpoint))throw new Error('Unknown program endpoint');
        const p=object(payload);
        exactKeys(p,endpoint==='list'?['sessionId']:endpoint==='send'?['sessionId','id','generation','body']:['sessionId','id','generation']);
        const owner=text(p.sessionId,'sessionId');
        if(endpoint==='list')return{ok:true,value:{runs:a.supervisor.list(owner)}};
        a.owner(owner);
        const id=text(p.id,'id');fence(a.supervisor.get(id,owner),p.generation);
        if(endpoint==='send'){await a.supervisor.send(id,owner,json(p.body));return{ok:true,value:{accepted:true}};}
        if(endpoint==='stop'||endpoint==='restart'){const method=endpoint==='stop'?'stop':'restart';return{ok:true,value:await a.supervisor[method](id,owner)};}
        throw new Error('Unknown program endpoint');
      }catch(error){return{ok:false,error:{code:'program-agents/rejected',message:error instanceof Error?error.message:'Program operation failed',details:{}}};}
    }));
  });
  return service;
}
export function fence(run:ProgramSnapshot,generation:unknown):void{
  if(!Number.isSafeInteger(generation)||run.generation!==generation)throw new Error('Stale program generation; refresh before retrying');
}
interface Connection {rpc:{handle(channel:string,handler:(endpoint:string,payload:unknown,signal:AbortSignal,peer:{principal:{kind:string}})=>Promise<unknown>):()=>Promise<void>}}
