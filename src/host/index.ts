import { Service, type Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { PluginConfig } from './contracts.js';
import { DshProgramAdapter } from './adapter.js';
import { object, text, json, exactKeys } from './validation.js';
import type { ProgramSnapshot } from '../types.js';
import {programFetch} from './http.js';
export type { PluginConfig, ProgramGrant } from './contracts.js';
export { DshProgramAdapter } from './adapter.js';
export const name='program-agents';
export const inject=['tools','agents','llm'];
const supervision=z.any();
const resource=z.union([
 z.object({id:z.string().required(),title:z.string().required(),type:z.union(['ui','api','docs']).required(),url:z.string().required(),docs:z.string()}),
 z.object({id:z.string().required(),title:z.string().required(),type:z.union(['ui','api','docs']).required(),endpoint:z.string().required(),path:z.string(),docs:z.string()})
]);
export const Config: z<PluginConfig>=z.object({
  auditDirectory:z.string(),catalogDirectory:z.string(),logDirectory:z.string(),
  networking:z.object({bindHost:z.string(),publicHost:z.string(),protocol:z.union(['http','https'])}),
  programs:z.dict(z.object({entry:z.string(),command:z.array(z.string()),name:z.string(),description:z.string(),urls:z.array(resource),endpoints:z.dict(z.object({port:z.union([z.const('dynamic'),z.number().min(1).max(65535).step(1)]).required()})),logsPath:z.string(),cwd:z.string(),args:z.array(z.string()),env:z.dict(z.string()).role('secret'),allowedCapabilities:z.array(z.string()),supervision,functions:z.array(z.string()),mcp:z.array(z.object({server:z.string(),tools:z.array(z.string())})),messaging:z.boolean(),models:z.array(z.object({provider:z.string().required(),model:z.string().required()})),tools:z.array(z.string()),maxModelOutputTokens:z.number().min(1).step(1)})).default({}),
  maxRuns:z.number().min(1).max(64).step(1).default(8),maxHistory:z.number().min(1).max(256).step(1).default(64),
  startupTimeoutMs:z.number().min(100).default(10000),stopTimeoutMs:z.number().min(100).default(3000),callTimeoutMs:z.number().min(100).default(120000)
});
declare module '@deepseek-ai/cordis' {interface Context {programAgents:ProgramAgentsService}}
export class ProgramAgentsService extends Service {
  readonly adapter:DshProgramAdapter;
  constructor(ctx:Context,config:PluginConfig){super(ctx,'programAgents');this.adapter=new DshProgramAdapter(ctx,config);}
  get supervisor(){return this.adapter.supervisor;}
  get capabilities(){return this.adapter.capabilities;}
  /** Register host JSON tools; exposed to apps through the MCP-shaped tool client. */
  get appTools(){return this.adapter.functions;}
  /** @deprecated Historical alias; these are tools, not a separate functions system. */
  get functions(){return this.adapter.functions;}
}
function caller(exec:{agent?:Agent}):Agent{if(!exec.agent)throw new Error('A live parent Agent is required');return exec.agent;}
const output={schema:{type:'json' as const},render:(_args:unknown,value:unknown)=>[{type:'text' as const,text:JSON.stringify(value)}]};
export function apply(ctx:Context,config:PluginConfig={}){
  const service=new ProgramAgentsService(ctx,config),a=service.adapter;
  ctx.effect(()=>()=>a.dispose());
  ctx.inject(['workspaceRegistry','sessionController'],c=>{void a.restoreStartup().catch(error=>c.logger.warn('Program startup restore failed: '+String(error)));});
  ctx.on('agent/created',async({agent})=>{await a.sessionCreated(agent).catch(error=>ctx.logger.warn('Program Session startup failed: '+String(error)));return undefined;},{global:true});
  (ctx.on as (name:string,callback:(...args:any[])=>any)=>unknown)('workspace/session-activity',async({sessionId}:any,next:()=>Promise<any[]>)=>{const runs=a.supervisor.list(String(sessionId)).filter(r=>['starting','running','blocked','stopping'].includes(r.state));const rest=await next();return runs.length?[{kind:'program-agent',items:runs.map(r=>({id:r.id,label:r.name??r.label}))},...rest]:rest;});
  (ctx.on as (name:string,callback:(...args:any[])=>any)=>unknown)('workspace/session-stop',({sessionId}:any)=>a.stopSession(String(sessionId)));
  ctx.on('agent/disposed',({agent})=>a.ownerDisposed(agent));
  ctx.tools.register(defineTool({name:'program_register',description:'Register a parent-owned program: name, description, argv start command, typed URLs (ui/api/docs), optional endpoints and log path. Prefer persisted endpoints:{web:{port:"dynamic"}} and URLs {id,title,type,endpoint:"web",path:"/api"} instead of a previous run URL. Apps bind/report actual ports through connectProgram().endpoints.listen; public hostname comes from harness/browser, bind interface from trusted harness config. Prefer TypeScript + Hono, SQLite for app state or DuckDB for analytics, and a watch/reload start command. Registration does not launch it; program_start or its composer Start button does, in this exact parent context. Trusted local code, not a sandbox.',parameters:{name:{type:'string',required:true},description:{type:'string',required:true},command:{type:'json',required:true},cwd:{type:'string'},urls:{type:'json'},endpoints:{type:'json'},logsPath:{type:'string'},supervision:{type:'json'},access:{type:'json'}},output,execute:async(args,exec)=>json(await a.register(caller(exec),args,exec.signal),131072)}));
  ctx.tools.register(defineTool({name:'program_reply',description:'Settle one pending program agents.ask request with a schema-valid response. Use the supplied parent_id, program and request_id. Only the specifically assigned Agent can reply. The first valid response is accepted durably; conflicting, late or wrong-Agent replies are rejected. A normal chat answer does not settle the request.',parameters:{parent_id:{type:'string',required:true},program:{type:'string',required:true},request_id:{type:'string',required:true},body:{type:'json',required:true}},output,execute:async(args,exec)=>json(await a.replyToRequest(caller(exec),args.parent_id,args.program,args.request_id,json(args.body)))}));
  ctx.tools.register(defineTool({name:'program_inbox_send',description:'Deliver structured data to a program inbox. Accepted is not processed: the app claims a lease, performs idempotent work, then acknowledges. A supervisor child may reply using its parent_id and program key.',parameters:{program:{type:'string',required:true},body:{type:'json',required:true},parent_id:{type:'string'},correlation_id:{type:'string'}},output,execute:async(args,exec)=>{const agent=caller(exec);return json(await a.sendInbox(agent,args.parent_id??String(agent.id),args.program,json(args.body),args.correlation_id));}}));
  ctx.tools.register(defineTool({name:'program_start',description:'Start a registered or configured program as a supervised child of this parent Agent. Use program_register first for a new command. Prefer watch/reload to repeated manual restarts. No automatic effect retries or application-state durability.',parameters:{program:{type:'string',required:true},input:{type:'json'},label:{type:'string'}},output,execute:async(args,exec)=>json(await a.start(caller(exec),args.program,args.input??null,args.label,exec.signal),1048576)}));
  ctx.tools.register(defineTool({name:'program_list',description:'Inspect this parent’s program launch descriptions, typed URLs/docs, log paths and current runs. Background parent notifications are handled internally; no user message UI is needed.',parameters:{},output,execute:async(_args,exec)=>{const owner=String(caller(exec).id);return json({programs:a.catalog.list(owner),runs:a.supervisor.list(owner)},4*1048576);}}));
  ctx.tools.register(defineTool({name:'program_send',description:'Internal parent-to-SDK-program input, not a user chat channel. Ordinary command programs do not have an SDK inbox. Delivery is in-memory, not durable processing.',parameters:{id:{type:'string',required:true},generation:{type:'integer',required:true},body:{type:'json',required:true}},output,execute:async(args,exec)=>{const owner=String(caller(exec).id);a.owner(owner);fence(a.supervisor.get(args.id,owner),args.generation);await a.supervisor.send(args.id,owner,args.body);return{accepted:true};}}));
  for(const action of ['stop','restart']as const)ctx.tools.register(defineTool({name:`program_${action}`,description:action==='stop'?'Stop this parent’s program and its process group; require proven cleanup.':'Explicitly restart this parent’s program after proven process-group closure. Prefer watch/reload for source edits.',parameters:{id:{type:'string',required:true},generation:{type:'integer',required:true}},output,execute:async(args,exec)=>{const owner=String(caller(exec).id);a.owner(owner);fence(a.supervisor.get(args.id,owner),args.generation);return json(await a[action](args.id,owner),1048576);}}));
  ctx.inject(['connection'],c=>{
    const connection=(c as Context & {connection:Connection}).connection;
    const handler=async(endpoint:string,payload:unknown,signal:AbortSignal)=>{
      try{
        signal.throwIfAborted();
        if(!['list','start','stop','restart'].includes(endpoint))throw Error('Unknown program endpoint');
        const p=object(payload);exactKeys(p,endpoint==='list'?['sessionId']:endpoint==='start'?['sessionId','program']:['sessionId','id','generation']);
        const owner=text(p.sessionId,'sessionId');
        if(endpoint==='list')return{ok:true,value:a.view(owner)};
        if(endpoint==='start')return{ok:true,value:await a.startFromUi(owner,text(p.program,'program'),signal)};
        // Existing runs retain their captured live parent; the browser cannot choose
        // a different Agent or supply commands/environment to these controls.
        const agent=a.owner(owner),id=text(p.id,'id');fence(a.supervisor.get(id,owner),p.generation);
        return{ok:true,value:await a.controlFromUi(agent,endpoint as 'stop'|'restart',{id,generation:Number(p.generation)},signal)};
      }catch(error){return{ok:false,error:{code:'program-agents/rejected',message:error instanceof Error?error.message:'Program operation failed',details:{}}};}
    };
    for(const method of ['list','start','stop','restart'])c.effect(()=>connection.fetch.register({path:`/api/programAgents/${method}`,methods:['POST'],requestBody:'buffered',fetch:programFetch(method,handler)}));
    c.effect(()=>connection.fetch.register({path:'/api/programAgents/events',methods:['POST'],requestBody:'buffered',fetch:request=>a.events.fetch(request)}));
    a.journal.append({kind:'web-routes-registered',prefix:'/api/programAgents',updates:'SSE'});
  });
  return service;
}
export function fence(run:ProgramSnapshot,generation:unknown):void{if(!Number.isSafeInteger(generation)||run.generation!==generation)throw Error('Stale program generation; wait for the latest state');}
interface Connection {fetch:{register(route:{path:string;methods:readonly string[];requestBody:'buffered';fetch:(request:Request)=>Promise<Response>}):()=>Promise<void>}}
