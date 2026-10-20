import type{JsonValue}from'./types.js';

export interface SupervisionSettings {
 /** Never is default. Restart only the process after proven closure, not its effects. */
 restart?:'never'|'on-failure'|'always';
 maxRestarts?:number;
 restartDelayMs?:number;
 /** Recreate program process on DSH startup while owning Session exists and is not archived. */
 startAtStartup?:boolean;
 supervisor?:{mode:'parent'|'dedicated-child'|'new-child';prompt?:string};
 /** Coalesce ERROR records before notifying the selected supervisor. */
 errors?:{enabled?:boolean;bufferMs?:number;maxBatch?:number;cooldownMs?:number};
}
export function normalizeSupervision(value:unknown):SupervisionSettings|undefined{
 if(value===undefined)return undefined;
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid supervision settings');
 const v=value as Record<string,unknown>,keys=['restart','maxRestarts','restartDelayMs','startAtStartup','supervisor','errors'];
 if(Object.keys(v).some(k=>!keys.includes(k)))throw Error('Unknown supervision setting');
 const integer=(x:unknown,name:string,min:number,max:number,fallback:number)=>{if(x===undefined)return fallback;if(!Number.isSafeInteger(x)||Number(x)<min||Number(x)>max)throw Error(`Invalid ${name}`);return Number(x);};
 if(v.restart!==undefined&&!['never','on-failure','always'].includes(String(v.restart)))throw Error('Invalid restart policy');
 if(v.startAtStartup!==undefined&&typeof v.startAtStartup!=='boolean')throw Error('Invalid startAtStartup');
 const result:SupervisionSettings={restart:(v.restart as SupervisionSettings['restart'])??'never',maxRestarts:integer(v.maxRestarts,'maxRestarts',0,100,3),restartDelayMs:integer(v.restartDelayMs,'restartDelayMs',100,300000,1000),startAtStartup:v.startAtStartup===true};
 if(v.supervisor!==undefined){const s=v.supervisor as Record<string,unknown>;if(!s||typeof s!=='object'||Array.isArray(s)||Object.keys(s).some(k=>!['mode','prompt'].includes(k))||!['parent','dedicated-child','new-child'].includes(String(s.mode))||s.prompt!==undefined&&(typeof s.prompt!=='string'||s.prompt.length>12000))throw Error('Invalid supervisor routing');result.supervisor={mode:s.mode as'parent'|'dedicated-child'|'new-child',...(typeof s.prompt==='string'?{prompt:s.prompt}:{})};}
 if(v.errors!==undefined){const e=v.errors as Record<string,unknown>;if(!e||typeof e!=='object'||Array.isArray(e)||Object.keys(e).some(k=>!['enabled','bufferMs','maxBatch','cooldownMs'].includes(k))||e.enabled!==undefined&&typeof e.enabled!=='boolean')throw Error('Invalid error buffering');result.errors={enabled:e.enabled!==false,bufferMs:integer(e.bufferMs,'bufferMs',10,60000,1000),maxBatch:integer(e.maxBatch,'maxBatch',1,100,20),cooldownMs:integer(e.cooldownMs,'cooldownMs',100,3600000,30000)};}
 return result;
}
export function supervisionJson(value:SupervisionSettings):JsonValue{return JSON.parse(JSON.stringify(value))as JsonValue;}
