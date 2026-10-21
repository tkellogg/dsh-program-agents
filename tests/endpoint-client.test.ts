import{test}from'node:test';import assert from'node:assert/strict';
import{endpointUrl,normalizeHostname,normalizeEndpointPath}from'../src/endpoints.js';
import{parseRunList,resourceLink,type ProgramItem,type ProgramResource}from'../src/client/model.js';
const address={endpoint:'web',host:'browser',protocol:'http' as const,port:43123,path:'/api?mode=short#latest'};
const resource:ProgramResource={id:'api',title:'API',type:'api',url:'',endpoint:'web',path:address.path,address,available:true};
const item:ProgramItem={program:'app',name:'App',description:'',command:[],urls:[resource],run:{id:'run',generation:1,program:'app',ownerId:'p',label:'App',state:'running',startedAt:'',resources:[resource]}};
test('direct resource recipe uses each viewing browser hostname, not DSH port/scheme or persisted loopback',()=>{
 assert.equal(resourceLink(item,resource,false,undefined,'127.0.0.1'),'http://127.0.0.1:43123/api?mode=short#latest');
 assert.equal(resourceLink(item,resource,false,undefined,'devbox.tailnet.ts.net'),'http://devbox.tailnet.ts.net:43123/api?mode=short#latest');
 assert.equal(resourceLink(item,resource,false,undefined,'[fd7a:115c:a1e0::1]'),'http://[fd7a:115c:a1e0::1]:43123/api?mode=short#latest');
 assert.equal(resourceLink(item,{...resource,address:{...address,host:'apps.internal',protocol:'https'}},false,undefined,'other-host'),'https://apps.internal:43123/api?mode=short#latest');
 assert.equal(endpointUrl(address),undefined);assert.equal(resourceLink(item,{...resource,address:undefined},false,undefined,'box'),undefined);
 for(const pending of ['start','stop','restart']as const)assert.equal(resourceLink(item,resource,false,pending,'box'),undefined);
 assert.equal(resourceLink(item,resource,true,undefined,'box'),undefined);assert.equal(resourceLink({...item,run:{...item.run!,state:'stopped'}},resource,false,undefined,'box'),undefined);
});
test('endpoint URL builder rejects authority injection, credentials, malformed hosts and protocols',()=>{
 for(const host of ['evil.com/path','https://evil.com','user:pw@evil.com','host:9000','host?x','host#x','localhost\\evil','host\n'])assert.equal(endpointUrl({...address,host},'box'),undefined);
 for(const path of ['//evil.com/path','https://evil.com/','/\\evil.com/','/x\n','/%0afoo'])assert.throws(()=>normalizeEndpointPath(path));
 assert.equal(endpointUrl({...address,port:0},'box'),undefined);assert.equal(endpointUrl({...address,port:65536},'box'),undefined);assert.equal(endpointUrl({...address,protocol:'javascript' as any},'box'),undefined);
 assert.equal(normalizeHostname('fd7a:115c:a1e0::1'),'[fd7a:115c:a1e0::1]');
 assert.equal(normalizeEndpointPath('/a/../api'),'/api');
});
test('snapshot parser preserves unresolved recipe and latest bound address, never stale previous generation link',()=>{
 const wire={programs:[{program:'app',name:'App',urls:[{...resource,address:undefined,available:false}]}],runs:[{...item.run,resources:[resource]}]};
 const parsed=parseRunList(wire,'p');assert.equal(resourceLink(parsed.items[0],parsed.items[0].urls[0],false,undefined,'box'),'http://box:43123/api?mode=short#latest');
 const next=parseRunList({...wire,runs:[{...item.run,generation:2,resources:[{...resource,address:undefined,available:false}]}]},'p');assert.equal(next.items[0].urls[0].address,undefined);assert.equal(resourceLink(next.items[0],next.items[0].urls[0],false,undefined,'box'),undefined);
 for(const bad of [{...address,port:'12'},{...address,host:'user@host'},{...address,endpoint:'other'}, {...address,path:'//evil'}]){const result=parseRunList({...wire,runs:[{...item.run,resources:[{...resource,address:bad}]}]},'p');assert.equal(resourceLink(result.items[0],result.items[0].urls[0],false,undefined,'box'),undefined);}
});
