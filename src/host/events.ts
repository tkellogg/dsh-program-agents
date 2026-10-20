import {object,exactKeys,text} from './validation.js';

/** Session-scoped metadata changes only: no token/log/message stream and no polling. */
export class ProgramEvents {
  private listeners=new Map<string,Set<()=>void>>();
  private timers=new Map<string,ReturnType<typeof setTimeout>>();
  private closers=new Set<()=>void>();
  private closed=false;
  constructor(private snapshot:(ownerId:string)=>unknown){}
  changed(ownerId:string){
    if(this.closed||!this.listeners.has(ownerId)||this.timers.has(ownerId))return;
    this.timers.set(ownerId,setTimeout(()=>{this.timers.delete(ownerId);for(const notify of this.listeners.get(ownerId)??[])notify();},75));
  }
  async fetch(request:Request):Promise<Response>{
    if(this.closed)return new Response('Plugin unloading',{status:503});
    if(request.headers.get('content-type')?.split(';',1)[0]?.trim()!=='application/json')return new Response('Expected JSON',{status:415});
    let owner:string;
    try{const body=await request.text();if(Buffer.byteLength(body)>4096)return new Response('Request too large',{status:413});const p=object(JSON.parse(body));exactKeys(p,['sessionId']);owner=text(p.sessionId,'sessionId',1024);request.signal.throwIfAborted();}
    catch{return new Response('Invalid session stream request',{status:400});}
    if(this.closers.size>=64)return new Response('Too many streams',{status:429});
    const encoder=new TextEncoder();let close=()=>{};
    const stream=new ReadableStream<Uint8Array>({
      start:controller=>{
        let disposed=false,lastSnapshot='';let timer:ReturnType<typeof setInterval>;
        const cleanup=()=>{if(disposed)return;disposed=true;clearInterval(timer);request.signal.removeEventListener('abort',finish);const listeners=this.listeners.get(owner);listeners?.delete(send);if(!listeners?.size)this.listeners.delete(owner);this.closers.delete(finish);};
        const finish=()=>{cleanup();try{controller.close();}catch{}};close=finish;
        const send=()=>{
          if(disposed)return;
          // Slow clients reconnect to a fresh snapshot rather than retaining a backlog.
          if(controller.desiredSize!==null&&controller.desiredSize<=0){finish();return;}
          try{const json=JSON.stringify(this.snapshot(owner));if(json===lastSnapshot)return;if(Buffer.byteLength(json)>131000){finish();return;}lastSnapshot=json;controller.enqueue(encoder.encode(`event: snapshot\ndata: ${json}\n\n`));}catch{finish();}
        };
        let listeners=this.listeners.get(owner);if(!listeners){listeners=new Set();this.listeners.set(owner,listeners);}listeners.add(send);this.closers.add(finish);
        request.signal.addEventListener('abort',finish,{once:true});
        timer=setInterval(()=>{if(disposed)return;if(controller.desiredSize!==null&&controller.desiredSize<=0){finish();return;}try{controller.enqueue(encoder.encode(': heartbeat\n\n'));}catch{finish();}},15000);
        timer.unref?.();send();if(request.signal.aborted)finish();
      },
      cancel:()=>close(),
    });
    return new Response(stream,{headers:{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-store','X-Accel-Buffering':'no'}});
  }
  dispose(){this.closed=true;for(const timer of this.timers.values())clearTimeout(timer);this.timers.clear();for(const close of [...this.closers])close();this.listeners.clear();}
}
