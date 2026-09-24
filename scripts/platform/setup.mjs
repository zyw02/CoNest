import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const bundle=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(process.argv[2]??path.join(os.homedir(),'conest-demo-0.6.4'));
const target=process.platform+'-'+process.arch;
if(!['linux-x64','win32-x64'].includes(target))throw Error('This package supports Linux x64 and Windows x64');
const version=JSON.parse(await readFile(path.join(bundle,'delivery.json'),'utf8')).version;
const archive=path.join(bundle,'packages',target,`local-conest-connector-${version}.tgz`);
const expected=(await readFile(archive+'.sha256','utf8')).trim().split(/\s+/)[0];
if(createHash('sha256').update(await readFile(archive)).digest('hex')!==expected)throw Error('Plugin archive checksum mismatch');
const host=path.join(root,'host');const state=path.join(root,'install-state');await mkdir(host,{recursive:true});await mkdir(state,{recursive:true});
const npm=process.platform==='win32'?path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js'):path.resolve(path.dirname(process.execPath),'../lib/node_modules/npm/bin/npm-cli.js');
const env={...process.env,PATH:path.dirname(process.execPath)+path.delimiter+(process.env.PATH??process.env.Path??''),OPENCLAW_STATE_DIR:state,OPENCLAW_CONFIG_PATH:path.join(state,'openclaw.json')};
if(process.platform==='win32')delete env.Path;
async function run(args){await new Promise((resolve,reject)=>{const child=spawn(process.execPath,args,{env,cwd:root,stdio:'inherit',windowsHide:true});child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error(`Installation step exited with ${code}`)))});}
console.log('Installing OpenClaw 2026.9.2 and CoNest '+version+' for '+target);
await run([npm,'install','--prefix',host,'--ignore-scripts','--no-audit','--no-fund','--registry',process.env.CONEST_NPM_REGISTRY??'https://registry.npmjs.org','openclaw@2026.9.2','pnpm@11.7.0']);
// npm extracts the self-contained artifact without OpenClaw's fixed archive
// extraction deadline. The public directory install still checks and registers it.
await run([npm,'install','--prefix',host,'--offline','--ignore-scripts','--legacy-peer-deps','--no-audit','--no-fund',archive]);
const plugin=path.join(host,'node_modules/@local/conest-connector');
await run([path.join(host,'node_modules/openclaw/openclaw.mjs'),'plugins','install','--link','--force','--accept-capabilities',plugin]);
const settings={root,node:process.execPath,plugin,state:path.join(root,'demo-state'),credentials:path.join(root,'credentials/deepseek.env')};
await writeFile(path.join(root,'conest-launch.json'),JSON.stringify(settings,null,2));
// Launch files contain paths only; credentials remain in a separate private file.
const launcher=await readFile(path.join(bundle,'launch.mjs'),'utf8');await writeFile(path.join(root,'launch.mjs'),launcher);
console.log('\nInstallation complete. Start the deterministic demo without an API key; use --live for a configured model.');
console.log('Self-check: '+JSON.stringify(process.execPath)+' '+JSON.stringify(path.join(root,'launch.mjs'))+' --verify');
