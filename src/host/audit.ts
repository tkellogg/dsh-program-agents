import { mkdirSync, readdirSync, openSync, fstatSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { JsonValue } from '../types.js';

/** Plugin-owned supervisory journal, never injects unknown events into DSH logs.
 * Not an execution checkpoint; refuses new effects when its bounded budget fills.
 */
export class AuditJournal {
  readonly path:string;
  private fd:number;
  private bytes=0;
  private closed=false;
  constructor(directory:string,readonly maxBytes=16*1024*1024){
    mkdirSync(directory,{recursive:true,mode:0o700});
    if(readdirSync(directory).filter(n=>n.endsWith('.jsonl')).length>=64)throw new Error('Program audit directory full; archive old journals explicitly');
    this.path=join(directory,`${Date.now()}-${randomUUID()}.jsonl`);
    this.fd=openSync(this.path,'wx',0o600);this.bytes=fstatSync(this.fd).size;
  }
  append(record:JsonValue):void{
    if(this.closed)throw new Error('Audit journal closed');
    const line=Buffer.from(JSON.stringify({at:new Date().toISOString(),record})+'\n');
    if(this.bytes+line.length>this.maxBytes)throw new Error('Program audit budget exhausted; no new effects admitted');
    let written=0;while(written<line.length)written+=writeSync(this.fd,line,written,line.length-written);
    this.bytes+=line.length;fsyncSync(this.fd);
  }
  close():void{if(!this.closed){this.closed=true;closeSync(this.fd);}}
}
