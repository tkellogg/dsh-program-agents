import type{StructuredLogger}from'./logger.js';
/** Report once, flush within a hard deadline, then exit nonzero. Never keep a
 * process alive after an uncaught exception/unhandled rejection. Opt-in only. */
export function installGlobalErrorHandlers(logger:StructuredLogger,options:{timeoutMs?:number}={}):()=>void{
 const timeout=options.timeoutMs??500;if(!Number.isSafeInteger(timeout)||timeout<1||timeout>5000)throw Error('Invalid fatal log timeout');
 let failing=false;
 const fail=(reason:unknown,kind:'uncaughtException'|'unhandledRejection')=>{
  if(failing){process.exit(1);return;}failing=true;
  // Referenced deadline guarantees an exit even if stdout/disk backpressure hangs.
  const timer=setTimeout(()=>process.exit(1),timeout);
  try{const error=reason instanceof Error?reason:new Error(typeof reason==='string'?reason:'Non-Error thrown/rejected value');logger.error('Unhandled program error',{unhandled:true,kind},{log_type:'dsh.program.error.v1',error,fatal:true});}
  catch{clearTimeout(timer);process.exit(1);return;}
  void logger.flush().catch(()=>{}).finally(()=>{clearTimeout(timer);process.exit(1);});
 };
 const exception=(error:Error)=>fail(error,'uncaughtException'),rejection=(reason:unknown)=>fail(reason,'unhandledRejection');
 process.on('uncaughtException',exception);process.on('unhandledRejection',rejection);
 return()=>{process.off('uncaughtException',exception);process.off('unhandledRejection',rejection);};
}
