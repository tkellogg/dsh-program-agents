import {createServer} from 'node:http';
// Ordinary command program: no SDK or IPC required. Node --watch owns reload.
const message='Watch mode reloaded successfully';
const server=createServer((req,res)=>{
 if(req.url==='/api/status'){res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({message,pid:process.pid,startedAt}));return;}
 if(req.url!=='/'){res.writeHead(404);res.end();return;}
 res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'"});
 res.end(`<!doctype html><title>Watch demo</title><style>body{font:18px system-ui;max-width:700px;margin:4rem auto;background:#17191d;color:#eee}a{color:#9bc8ff}</style><h1>Watch demo</h1><p>${message}</p><p>Edit this file; Node reloads the server automatically.</p><a href="/api/status">API status</a>`);
});
const startedAt=new Date().toISOString();
server.listen(4317,'127.0.0.1',()=>console.log(JSON.stringify({event:'ready',url:'http://127.0.0.1:4317/',pid:process.pid,startedAt})));
for(const signal of ['SIGINT','SIGTERM']as const)process.on(signal,()=>server.close(()=>process.exit(0)));
