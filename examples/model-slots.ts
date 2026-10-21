import{connectProgram,installGlobalErrorHandlers}from'@tkellogg/dsh-program-agents/app';
const dsh=connectProgram({logger:{logsPath:'./logs/model-slots',stdout:true,private:true}});
installGlobalErrorHandlers(dsh.logger);
await dsh.models.declare({
 'smart-model':{description:'Difficult judgments and multi-step planning.',default:{provider:'codex',model:'gpt-6.1-sol',reasoningEffort:'xhigh'}},
 'cheap-local':{description:'Private, low-cost classification and short summaries.',default:{provider:'local-mlx',model:'Qwen3.8-27B-4bit'}},
});
dsh.logger.info('Model slots ready; configure selections with the program Models button',{}, {log_type:'com.example.models.ready.v1'});
// Declaration/configuration does not make an inference call or create a child.
const stop=new AbortController();for(const signal of ['SIGINT','SIGTERM']as const)process.on(signal,()=>stop.abort());
await new Promise<void>(resolve=>{const timer=setInterval(()=>{},60000);stop.signal.addEventListener('abort',()=>{clearInterval(timer);resolve();},{once:true});});
await dsh.logger.close();
