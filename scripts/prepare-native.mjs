import assert from 'node:assert/strict';
import {cp,mkdir,readFile,writeFile,realpath,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import path from 'node:path';import {fileURLToPath} from 'node:url';
const bridge=fileURLToPath(new URL('..',import.meta.url));
const args=process.argv.slice(2), flags={};while(args.length){const key=args.shift(),value=args.shift();assert(['--target','--out','--pty-build'].includes(key)&&value&&!flags[key],'Usage: prepare-native.mjs --target linux-x64|win32-x64 --out DIR [--pty-build BASELINE_PTY_NODE]');flags[key]=value;}
const target=flags['--target'];assert(['linux-x64','win32-x64'].includes(target));assert(flags['--out']);
const root=path.resolve(flags['--out']);await mkdir(root,{recursive:true});assert.equal((await readdir(root)).length,0,'Choose an empty native asset directory');
const modules=path.join(root,'node_modules');await mkdir(modules);const provenance={target,packages:[]};
if(target==='linux-x64'){
 assert(flags['--pty-build'],'Supply node-pty built in the RHEL 8 / glibc 2.28 baseline');
 const binary=path.resolve(flags['--pty-build']);const elf=execFileSync('readelf',['--version-info',binary],{encoding:'utf8'});
 const required=[...elf.matchAll(/Name: GLIBC_(\d+)\.(\d+)/g)].map(m=>[Number(m[1]),Number(m[2])]);assert(required.length&&required.every(([a,b])=>a<2||a===2&&b<=28),'node-pty exceeds glibc 2.28');
 const original=await realpath(path.join(bridge,'node_modules/node-pty'));
 const pty=path.join(modules,'node-pty');await cp(original,pty,{recursive:true,filter:source=>!['node_modules','build','prebuilds'].includes(path.relative(original,source).split(path.sep)[0])});
 await mkdir(path.join(pty,'build/Release'),{recursive:true});await cp(binary,path.join(pty,'build/Release/pty.node'));
 await cp(path.join(path.dirname(original),'node-addon-api'),path.join(modules,'node-addon-api'),{recursive:true});
 provenance.pty={buildBaseline:'RHEL 8 / glibc 2.28',sha256:createHash('sha256').update(await readFile(binary)).digest('hex'),requiredGlibc:required,napi:true};
}else{
 for(const [name,version]of [['@img/sharp-win32-x64','0.35.3'],['@koromix/koffi-win32-x64','3.1.1'],['@vscode/ripgrep-win32-x64','1.18.0']]){
  const response=await fetch('https://registry.npmjs.org/'+encodeURIComponent(name)+'/'+version);assert(response.ok,`${name}: HTTP ${response.status}`);const meta=await response.json();
  const responseTar=await fetch(meta.dist.tarball);assert(responseTar.ok);const bytes=Buffer.from(await responseTar.arrayBuffer());const [algorithm,expected]=meta.dist.integrity.split('-');assert.equal(createHash(algorithm).update(bytes).digest('base64'),expected,'Registry integrity mismatch');
  const archive=path.join(root,name.replaceAll('/','__')+'.tgz');await writeFile(archive,bytes);const dest=path.join(modules,name);await mkdir(dest,{recursive:true});execFileSync('tar',['-xzf',archive,'--strip-components=1','-C',dest]);provenance.packages.push({name,version,url:meta.dist.tarball,integrity:meta.dist.integrity});
 }
}
await writeFile(path.join(root,'provenance.json'),JSON.stringify(provenance,null,2)+'\n');console.log(root);
