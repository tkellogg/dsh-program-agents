import{test}from'node:test';import assert from'node:assert/strict';import{Config}from'../src/host/index.js';import{ProgramSupervisor}from'../src/runtime/index.js';
test('actual Schemastery launch configuration preserves endpoint recipe XOR literal URL and trusted networking policy',async()=>{
 const config=Config({networking:{bindHost:'127.0.0.1',publicHost:'browser',protocol:'http'},programs:{app:{command:[process.execPath,'-e','setInterval(()=>{},1000)'],endpoints:{web:{port:'dynamic'}},urls:[{id:'ui',title:'App',type:'ui',endpoint:'web',path:'/'},{id:'docs',title:'Docs',type:'docs',url:'/tmp/docs.md'}]}}});
 assert.deepEqual(config.networking,{bindHost:'127.0.0.1',publicHost:'browser',protocol:'http'});const {models,tools,mcp,messaging,maxModelOutputTokens,...app}=config.programs!.app;if(!app.args?.length)delete app.args;
 const runtime=new ProgramSupervisor({networking:config.networking,programs:{app}});try{const d=runtime.definitionsList()[0];assert.equal(d.urls[0].endpoint,'web');assert.equal(d.urls[0].url,'');assert.equal(d.urls[0].available,false);assert.equal(d.urls[1].url,'/tmp/docs.md');}finally{await runtime.dispose();}
});
