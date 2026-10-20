import {build} from 'esbuild';
import {writeFile,mkdir} from 'node:fs/promises';
const output=await build({entryPoints:['src/client/index.ts'],bundle:true,write:false,format:'cjs',platform:'browser',target:'es2022',external:['react','react-dom','react/jsx-runtime','react-dom/client'],sourcemap:false});
const body=output.outputFiles[0].text;
await mkdir('dist',{recursive:true});
// Node deliberately refuses native TS stripping inside node_modules. Ship JS examples.
await build({entryPoints:['examples/dashboard.ts','examples/standalone-supervisor.ts'],outdir:'dist/examples',bundle:false,format:'esm',platform:'node',target:'node22',sourcemap:false});
await writeFile('dist/client.js',`window.__ModuleLoader__.load({id:'@tkellogg/dsh-program-agents',factory:(require)=>{var module={exports:{}};var exports=module.exports;\n${body}\nreturn module.exports;}});\n`);
