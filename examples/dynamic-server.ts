import {createServer}from'node:http';
import {connectProgram,installGlobalErrorHandlers}from'@tkellogg/dsh-program-agents/app';
const app=connectProgram();installGlobalErrorHandlers(app.logger);
const startedAt=new Date().toISOString();
const server=createServer((req,res)=>{
 if(req.url==='/api/status'){res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({pid:process.pid,startedAt,message:'Harness endpoint is bound and advertised'}));return;}
 if(req.url!=='/'){res.writeHead(404);res.end();return;}
 res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'"});
 res.end('<!doctype html><title>Dynamic endpoint demo</title><style>body{font:18px system-ui;max-width:700px;margin:4rem auto}a{color:#368}</style><h1>Dynamic endpoint demo</h1><p>This server uses a harness-supplied interface and an OS-assigned port. Restarting resolves the endpoint again.</p><a href="/api/status">API status</a>');
});
const listener=await app.endpoints.listen('web',server);
app.logger.info('Endpoint ready',{port:listener.port,bind_host:listener.host,local_url:listener.localUrl},{log_type:'com.example.endpoint.ready.v1'});
let closing=false;for(const signal of ['SIGINT','SIGTERM']as const)process.on(signal,()=>{if(closing)return;closing=true;void listener.close().finally(()=>app.logger.close()).finally(()=>process.exit(0));});
