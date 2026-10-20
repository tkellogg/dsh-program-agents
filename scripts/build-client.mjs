import {build} from 'esbuild';
import {writeFile,mkdir,copyFile} from 'node:fs/promises';
const output=await build({entryPoints:['src/client/index.ts'],bundle:true,write:false,format:'cjs',platform:'browser',target:'es2022',external:['react','react-dom','react/jsx-runtime','react-dom/client'],sourcemap:false});
const body=output.outputFiles[0].text;
await mkdir('dist',{recursive:true});
// One host entry keeps local live installation free of stale transitive ESM cache.
await build({entryPoints:['src/host/index.ts'],outfile:'dist/host/plugin.js',bundle:true,format:'esm',platform:'node',target:'node22',external:['@deepseek-ai/*']});
// Explicit fresh path for the first live rc.2 install (old ESM URLs stay cached).
await copyFile('dist/host/plugin.js','dist/host/installed-v2.js');
await copyFile('dist/host/plugin.js','dist/host/installed-v3.js');
await copyFile('dist/host/plugin.js','dist/host/installed-v4.js');
await copyFile('dist/host/plugin.js','dist/host/installed-v5.js');
// Node deliberately refuses native TS stripping inside node_modules. Ship JS examples.
await build({entryPoints:['examples/dashboard.ts','examples/standalone-supervisor.ts'],outdir:'dist/examples',bundle:false,format:'esm',platform:'node',target:'node22',sourcemap:false});
await writeFile('dist/client.js',`window.__ModuleLoader__.load({id:'@tkellogg/dsh-program-agents',factory:(require)=>{var module={exports:{}};var exports=module.exports;\n${body}\nreturn module.exports;}});\n`);
