/** Persist recipes, never evaluated JavaScript or a previous process's port. */
export interface ProgramEndpointDefinition {port:'dynamic'|number}
export interface EndpointNetworking {
 /** Trusted harness setting; program metadata cannot expose a new interface. */
 bindHost?:string;
 /** Browser hostname by default, or an explicit reachable DNS/IP hostname. */
 publicHost?:string;
 /** Direct app protocol, not necessarily the DSH browser's protocol. Default http. */
 protocol?:'http'|'https';
}
export type ProgramUrlDefinition = {
 id:string;title:string;type:'ui'|'api'|'docs';docs?:string;
} & (
 /** Legacy absolute URL / informational docs path. Exclusive with endpoint+path. */
 {url:string;endpoint?:never;path?:never} |
 {url?:never;endpoint:string;path?:string}
);
export interface ResolvedEndpointAddress {
 endpoint:string;host:string;protocol:'http'|'https';port:number;path:string;
}
export interface ProgramEndpointBinding {
 id:string;bindHost:string;requestedPort:number;port?:number;
 publicHost:string;protocol:'http'|'https';
}
const controls=/[\u0000-\u0020\u007f\\]/;
export function endpointName(value:unknown):value is string{return typeof value==='string'&&/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value);}
export function normalizeEndpointPath(value:unknown):string{
 if(value===undefined)return'/';
 if(typeof value!=='string'||!value.startsWith('/')||value.startsWith('//')||value.length>4096||controls.test(value)||/%(?:0[0-9a-f]|1[0-9a-f]|7f|5c)/i.test(value))throw Error('Endpoint path must be a bounded absolute path, not a URL or authority');
 const u=new URL(value,'http://endpoint.invalid');if(u.origin!=='http://endpoint.invalid')throw Error('Invalid endpoint path');return u.pathname+u.search+u.hash;
}
export function normalizeHostname(value:unknown):string{
 if(typeof value!=='string'||!value||value.length>253||controls.test(value)||/[/?#@%]/.test(value))throw Error('Invalid endpoint hostname');
 const bracketed=value.includes(':')&&!value.startsWith('[')?'['+value+']':value;
 let u:URL;try{u=new URL('http://'+bracketed+'/');}catch{throw Error('Invalid endpoint hostname');}
 if(u.port||u.username||u.password||u.pathname!=='/'||!u.hostname)throw Error('Hostname must not include a scheme, port or credentials');
 return u.hostname;
}
/** Browser-safe; caller supplies browser hostname explicitly for deterministic tests. */
export function endpointUrl(address:ResolvedEndpointAddress,browserHostname?:string):string|undefined{
 try{
  if(!address||!endpointName(address.endpoint)||!['http','https'].includes(address.protocol)||!Number.isSafeInteger(address.port)||address.port<1||address.port>65535)return undefined;
  const host=normalizeHostname(address.host==='browser'?browserHostname:address.host);
  if(['0.0.0.0','[::]','browser'].includes(host))return undefined;
  const path=normalizeEndpointPath(address.path);
  return new URL(`${address.protocol}://${host}:${address.port}${path}`).href;
 }catch{return undefined;}
}
