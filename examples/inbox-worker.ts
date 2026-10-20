import{connectProgram,installGlobalErrorHandlers}from'@tkellogg/dsh-program-agents/app';
const program=connectProgram({logger:{logsPath:'./logs',stdout:true,private:true}});
installGlobalErrorHandlers(program.logger);
program.logger.info('Inbox worker ready',{pid:process.pid},{log_type:'com.example.inbox.ready.v1'});
const abort=new AbortController();for(const signal of ['SIGINT','SIGTERM']as const)process.on(signal,()=>abort.abort());
try{
 while(!abort.signal.aborted){
  const message=await program.inbox.receive({waitMs:25000,leaseMs:60000,signal:abort.signal});if(!message)continue;
  // A real app validates its own payload and commits effects with idempotency first.
  program.logger.info('Received application work',{message_id:message.id,body:message.body},{log_type:'com.example.inbox.processed.v1',operation_id:message.correlationId??message.id});
  await program.inbox.ack(message);
 }
}catch(error){if(!abort.signal.aborted){program.logger.error('Inbox worker failed',{}, {error:error as Error});throw error;}}
finally{await program.logger.close();}
