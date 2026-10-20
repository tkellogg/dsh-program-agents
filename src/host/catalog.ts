import{createHash}from'node:crypto';
import{mkdirSync,readFileSync,writeFileSync,renameSync,statSync}from'node:fs';
import{join,resolve}from'node:path';
import type{ProgramDefinition,ProgramSupervisor}from'../runtime/index.js';
import{object,text,exactKeys,json}from'./validation.js';

export interface Registration {name:string;description:string;command:string[];cwd?:string;urls?:Array<{id:string;title:string;type:'ui'|'api'|'docs';url:string;docs?:string}>;logsPath?:string}
interface Saved {ownerId:string;entries:Array<{program:string;definition:ProgramDefinition}>}
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
   for(const raw of value.entries){const item=object(raw),program=text(item.program,'program');if(!program.startsWith(this.prefix(owner)))throw Error('Foreign program catalog entry');const definition=object(item.definition) as unknown as ProgramDefinition;this.supervisor.define(program,definition);saved.entries.push({program,definition});}
  }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  this.loaded.set(owner,saved);return saved;
 }
 private prefix(owner:string){return'reg-'+createHash('sha256').update(owner).digest('hex').slice(0,20)+'-';}
 visible(owner:string,program:string){return this.configured.has(program)||this.load(owner).entries.some(e=>e.program===program);}
 list(owner:string){this.load(owner);return this.supervisor.definitionsList().filter(d=>this.visible(owner,d.program));}
 register(owner:string,input:unknown,cwd:string){
  const p=object(input);exactKeys(p,['name','description','command','cwd','urls','logsPath']);
  const name=text(p.name,'name',120),description=text(p.description,'description',1200);
  if(!Array.isArray(p.command)||p.command.length<1||p.command.length>64||p.command.some(v=>typeof v!=='string'||v.length>8192||v.includes('\0')))throw Error('command must be an argv array (executable, arguments); no implicit shell');
  const command=p.command as string[];if(!command[0]?.trim())throw Error('Missing executable');
  const directory=resolve(cwd,p.cwd===undefined?'.':text(p.cwd,'cwd',4096));
  const definition:ProgramDefinition={name,description,command:[...command],cwd:directory};
  if(p.logsPath!==undefined)definition.logsPath=resolve(directory,text(p.logsPath,'logsPath',4096));
  if(p.urls!==undefined){if(!Array.isArray(p.urls)||p.urls.length>32)throw Error('urls must be a bounded array');definition.urls=p.urls.map(raw=>{const u=object(raw);exactKeys(u,['id','title','type','url','docs']);if(!['ui','api','docs'].includes(String(u.type)))throw Error('URL type must be ui, api or docs');return{id:text(u.id,'URL id',120),title:text(u.title,'URL title',200),type:u.type as'ui'|'api'|'docs',url:text(u.url,'URL',8192),...(u.docs===undefined?{}:{docs:text(u.docs,'docs',8192)})};});}
  const saved=this.load(owner),program=this.prefix(owner)+createHash('sha256').update(name).digest('hex').slice(0,16);
  if(!saved.entries.some(e=>e.program===program)&&saved.entries.length>=32)throw Error('At most 32 programs per parent');
  // Runtime validates URL schemes, metadata and executable before persistence.
  this.supervisor.define(program,definition);
  const entries=[...saved.entries.filter(e=>e.program!==program),{program,definition}];
  const data=JSON.stringify(json({ownerId:owner,entries},262144),null,2)+'\n';
  const file=this.file(owner),temporary=file+'.tmp';writeFileSync(temporary,data,{mode:0o600});renameSync(temporary,file);
  saved.entries=entries;
  return this.list(owner).find(d=>d.program===program)!;
 }
}
