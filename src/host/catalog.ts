import{createHash}from'node:crypto';
import{mkdirSync,readFileSync,writeFileSync,renameSync,statSync,readdirSync}from'node:fs';
import{join,resolve}from'node:path';
import type{ProgramDefinition,ProgramSupervisor}from'../runtime/index.js';
import{object,text,exactKeys,json}from'./validation.js';
import{normalizeSupervision,type SupervisionSettings}from'../supervision.js';
import type{ProgramUrlDefinition,ProgramEndpointDefinition}from'../endpoints.js';

export interface Registration {name:string;description:string;command:string[];cwd?:string;urls?:ProgramUrlDefinition[];endpoints?:Record<string,ProgramEndpointDefinition>;logsPath?:string;supervision?:SupervisionSettings}
export interface ProgramAccess {tools?:string[];mcp?:Array<{server:string;tools:string[]}>;messaging?:boolean}
interface Saved {ownerId:string;entries:Array<{program:string;definition:ProgramDefinition;access?:ProgramAccess}>}
/** Durable launch descriptions only, never execution state or child credentials. */
export class ProgramCatalog {
 private loaded=new Map<string,Saved>();
 constructor(private directory:string,private supervisor:ProgramSupervisor,private configured:ReadonlySet<string>){mkdirSync(directory,{recursive:true,mode:0o700});}
 private file(owner:string){return join(this.directory,createHash('sha256').update(owner).digest('hex')+'.json');}
 load(owner:string):Saved{
  let saved=this.loaded.get(owner);if(saved)return saved;
  if(this.loaded.size>=256)throw Error('Program catalog session limit reached');
  saved={ownerId:owner,entries:[]};
  try{
   const file=this.file(owner);if(statSync(file).size>262144)throw Error('Catalog file too large');
   const value=object(JSON.parse(readFileSync(file,'utf8')));if(value.ownerId!==owner||!Array.isArray(value.entries)||value.entries.length>32)throw Error('Invalid program catalog');
   for(const raw of value.entries){const item=object(raw),program=text(item.program,'program');if(!program.startsWith(this.prefix(owner)))throw Error('Foreign program catalog entry');const definition=object(item.definition) as unknown as ProgramDefinition;this.supervisor.define(program,definition);saved.entries.push({program,definition,...item.access?{access:this.accessValue(item.access)}:{}});}
  }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  this.loaded.set(owner,saved);return saved;
 }
 entries(){
  for(const file of readdirSync(this.directory).filter(f=>/^[a-f0-9]{64}\.json$/.test(f)).slice(0,256)){
   try{const path=join(this.directory,file);if(statSync(path).size>262144)continue;const data=object(JSON.parse(readFileSync(path,'utf8')));if(typeof data.ownerId==='string'&&this.file(data.ownerId)===path)this.load(data.ownerId);}catch{/* Invalid catalogs are not execution authority. Explicit list/register surfaces error. */}
  }
  return [...this.loaded.values()].flatMap(saved=>saved.entries.map(entry=>({ownerId:saved.ownerId,...entry})));
 }
 definition(owner:string,program:string){if(!this.visible(owner,program))return undefined;return this.load(owner).entries.find(e=>e.program===program)?.definition;}
 private prefix(owner:string){return'reg-'+createHash('sha256').update(owner).digest('hex').slice(0,20)+'-';}
 visible(owner:string,program:string){return this.configured.has(program)||this.load(owner).entries.some(e=>e.program===program);}
 list(owner:string){this.load(owner);return this.supervisor.definitionsList().filter(d=>this.visible(owner,d.program));}
 access(owner:string,program:string){return this.load(owner).entries.find(e=>e.program===program)?.access??{};}
 private accessValue(input:unknown):ProgramAccess{const a=object(input);exactKeys(a,['tools','mcp','messaging']);const names=(value:unknown)=>{if(value===undefined)return undefined;if(!Array.isArray(value)||value.length>128||value.some(v=>typeof v!=='string'||!/^[A-Za-z][A-Za-z0-9_.:-]{0,119}$/.test(v)))throw Error('Invalid access allowlist');return value as string[];};if(a.messaging!==undefined&&typeof a.messaging!=='boolean')throw Error('Invalid messaging access');let mcp:ProgramAccess['mcp'];if(a.mcp!==undefined){if(!Array.isArray(a.mcp)||a.mcp.length>32)throw Error('Invalid MCP access');mcp=a.mcp.map(raw=>{const row=object(raw);exactKeys(row,['server','tools']);const server=text(row.server,'MCP server',32);if(!/^[A-Za-z0-9_-]+$/.test(server))throw Error('Invalid MCP server');return{server,tools:names(row.tools)??[]};});}return{...(a.tools===undefined?{}:{tools:names(a.tools)!}),...(mcp===undefined?{}:{mcp}),messaging:a.messaging===true};}
 register(owner:string,input:unknown,cwd:string){
  const p=object(input);exactKeys(p,['name','description','command','cwd','urls','endpoints','logsPath','supervision','access']);
  const name=text(p.name,'name',120),description=text(p.description,'description',1200);
  if(!Array.isArray(p.command)||p.command.length<1||p.command.length>64||p.command.some(v=>typeof v!=='string'||v.length>8192||v.includes('\0')))throw Error('command must be an argv array (executable, arguments); no implicit shell');
  const command=p.command as string[];if(!command[0]?.trim())throw Error('Missing executable');
  const directory=resolve(cwd,p.cwd===undefined?'.':text(p.cwd,'cwd',4096));
  const definition:ProgramDefinition={name,description,command:[...command],cwd:directory};
  if(p.supervision!==undefined)definition.supervision=normalizeSupervision(p.supervision);
  if(p.logsPath!==undefined)definition.logsPath=resolve(directory,text(p.logsPath,'logsPath',4096));
  if(p.endpoints!==undefined)definition.endpoints=object(p.endpoints)as unknown as Record<string,ProgramEndpointDefinition>;
  if(p.urls!==undefined){if(!Array.isArray(p.urls)||p.urls.length>32)throw Error('urls must be a bounded array');definition.urls=p.urls.map(raw=>{const u=object(raw);exactKeys(u,['id','title','type','url','endpoint','path','docs']);if(!['ui','api','docs'].includes(String(u.type)))throw Error('URL type must be ui, api or docs');return{id:text(u.id,'URL id',120),title:text(u.title,'URL title',200),type:u.type as'ui'|'api'|'docs',...(u.url===undefined?{}:{url:text(u.url,'URL',8192)}),...(u.endpoint===undefined?{}:{endpoint:text(u.endpoint,'endpoint',64)}),...(u.path===undefined?{}:{path:text(u.path,'endpoint path',4096)}),...(u.docs===undefined?{}:{docs:text(u.docs,'docs',8192)})}as ProgramUrlDefinition;});}
  const saved=this.load(owner),program=this.prefix(owner)+createHash('sha256').update(name).digest('hex').slice(0,16);
  if(!saved.entries.some(e=>e.program===program)&&saved.entries.length>=32)throw Error('At most 32 programs per parent');
  // Runtime validates URL schemes, metadata and executable before persistence.
  this.supervisor.define(program,definition);
  const access=p.access===undefined?saved.entries.find(e=>e.program===program)?.access:this.accessValue(p.access);
  const entries=[...saved.entries.filter(e=>e.program!==program),{program,definition,...access?{access}:{}}];
  const data=JSON.stringify(json({ownerId:owner,entries},262144),null,2)+'\n';
  const file=this.file(owner),temporary=file+'.tmp';writeFileSync(temporary,data,{mode:0o600});renameSync(temporary,file);
  saved.entries=entries;
  return this.list(owner).find(d=>d.program===program)!;
 }
}
