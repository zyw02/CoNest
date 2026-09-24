import {readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import path from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const config=JSON.parse(await readFile(path.join(root,'conest-launch.json'),'utf8'));
const support=await import(pathToFileURL(path.join(config.plugin,'dist/platform-support.mjs')).href);
support.assertRuntime();
if(process.argv.includes('--protect-credentials')){await support.protectDirectory(path.dirname(config.credentials));process.exit(0);}
if(process.argv.includes('--connection')){
 const c=JSON.parse(await readFile(path.join(config.state,'connection.json'),'utf8'));
 console.log('Address:',c.url);console.log('Gateway token:',c.token);process.exit(0);
}
const verify=process.argv.includes('--verify');
if(process.argv.includes('--components')){
 const child=spawn(config.node,[path.join(config.plugin,'dist/demo-components.mjs'),'--out',path.join(root,'components-acceptance.json')],{cwd:root,stdio:'inherit',windowsHide:true});
 child.once('error',error=>{console.error(error);process.exitCode=1});child.once('exit',code=>{process.exitCode=code??1});
} else {
const env={...process.env,CONEST_PLUGIN_DIR:config.plugin,CONEST_DEMO_STATE:verify?path.join(root,'check-state-'+Date.now()):config.state,CONEST_DEMO_PORT:verify?'18792':'18791',CONEST_CREDENTIAL_FILE:config.credentials};
const child=spawn(config.node,[path.join(config.plugin,'dist/demo-studio.mjs'),...process.argv.slice(2).filter(arg=>['--verify','--live','--core'].includes(arg))],{env,cwd:root,stdio:'inherit',windowsHide:true});
child.on('error',error=>{console.error(error.message);process.exitCode=1});
let stopping=false;const stop=()=>{if(stopping)return;stopping=true;support.stopProcessTree(child).catch(error=>{console.error(error.message);process.exitCode=1})};
process.once('SIGINT',stop);process.once('SIGTERM',stop);child.once('exit',code=>{process.exitCode=code??0});

}
