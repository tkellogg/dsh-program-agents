import { resolve } from 'node:path';
import { ProgramSupervisor } from '@tkellogg/dsh-program-agents/runtime';

const supervisor=new ProgramSupervisor({
  programs:{dashboard:{entry:resolve('examples/dashboard.ts'),allowedCapabilities:[]}},
  onParentMessage:async(_owner,body)=>{console.log('Program asks parent:',body);},
});
const run=await supervisor.start({program:'dashboard',ownerId:'demo',input:null});
console.log('Started',run.id,'— press Ctrl+C to stop.');
const timer=setInterval(()=>{
  const r=supervisor.get(run.id,'demo');for(const resource of r.resources)if(resource.available)console.log('Dashboard:',resource.url);
},3000);timer.unref();
await supervisor.send(run.id,'demo',{hello:'world'});
process.once('SIGINT',()=>{clearInterval(timer);void supervisor.dispose().then(()=>process.exit(0));});
