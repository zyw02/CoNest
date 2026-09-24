import { createRequire } from 'node:module';
import { realpath, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
const require=createRequire(import.meta.url);
const {build}=require('esbuild');

const options={bundle:true,platform:'node',format:'esm',target:'node24',sourcemap:false,
 plugins:[{name:'freeze-package-attribution',setup(b){b.onLoad({filter:/\.(ts|js)$/},async args=>{let contents=await readFile(args.path,'utf8');const pattern=/createRequire\(import\.meta\.url\)\(["']\.\.\/package\.json["']\)/g;if(!pattern.test(contents))return;let directory=path.dirname(args.path);let manifest;for(let i=0;i<8;i++){try{manifest=JSON.parse(await readFile(path.join(directory,'package.json'),'utf8'));break;}catch{directory=path.dirname(directory);}}if(!manifest)throw Error('Package identity not found: '+args.path);contents=contents.replaceAll(pattern,JSON.stringify({version:manifest.version}));return {contents,loader:args.path.endsWith('.ts')?'ts':'js'};});}}],
 banner:{js:"import { createRequire as __bundleCreateRequire } from 'node:module'; const require = __bundleCreateRequire(import.meta.url);"},
 external:['openclaw','openclaw/*','sharp','koffi','node-pty','@vscode/ripgrep','@deepseek-ai/node-addon-system','@deepseek-ai/node-addon-system/*'],
 alias:{'@deepseek-ai/dsh-tools':require.resolve('@deepseek-ai/dsh-tools')},metafile:true};
for (const [entry,out] of [['src/studio/index.ts','dist/studio/index.js'],['src/studio/host-runtime.ts','dist/studio/host-runtime.js'],['src/mcp-memory-server.mjs','dist/mcp-memory-server.mjs'],['src/studio/runtime-probe.ts','dist/studio/runtime-probe.mjs']]) {
 const result=await build({...options,...(entry==='src/studio/index.ts'?{external:[...options.external,'../host.js']}:{}),entryPoints:[path.join(root,entry)],outfile:path.join(root,out)});
 await writeFile(path.join(root,out+'.meta.json'),JSON.stringify(result.metafile));
}
// Retain provenance and upstream notices for JavaScript folded into the bundles.
const {mkdir, readdir, cp} = await import('node:fs/promises');
const licenses=path.join(root,'dist/studio-licenses');await mkdir(licenses,{recursive:true});
const seen=new Map();
for(const out of ['dist/studio/index.js','dist/studio/host-runtime.js','dist/mcp-memory-server.mjs','dist/studio/runtime-probe.mjs']) {
 const meta=JSON.parse(await readFile(path.join(root,out+'.meta.json'),'utf8'));
 for(const member of Object.keys(meta.inputs)) {
  let dir=path.dirname(path.resolve(member));
  for(let i=0;i<15;i++) {
   try {const manifest=JSON.parse(await readFile(path.join(dir,'package.json'),'utf8'));if(manifest.name)seen.set(dir,manifest);break;}
   catch {const next=path.dirname(dir);if(next===dir)break;dir=next;}
  }
 }
}
const notices=[];
for(const [dir,manifest] of seen) {
 if(manifest.name==='@local/conest-connector')continue;
 const id=(manifest.name+'-'+manifest.version).replaceAll('/','__');const target=path.join(licenses,id);await mkdir(target,{recursive:true});
 let files=(await readdir(dir)).filter(f=>/^(license|licence|notice|copying)([.-]|$)/i.test(f));
 for(const f of files)await cp(path.join(dir,f),path.join(target,f),{recursive:true});
 if(!files.length && manifest.name.startsWith('@deepseek-ai/')) throw Error('Missing SDK license: '+manifest.name);
 notices.push({name:manifest.name,version:manifest.version,license:manifest.license,notices:files.map(f=>id+'/'+f)});
}
await writeFile(path.join(licenses,'index.json'),JSON.stringify(notices,null,2));
