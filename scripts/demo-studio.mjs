#!/usr/bin/env node
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { assertRuntime, protectDirectory, stopProcessTree } from './platform-support.mjs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { createLiveDeepSeek } from './live-deepseek.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
const require=createRequire(import.meta.url);
const cli=path.resolve(path.dirname(require.resolve('openclaw/plugin-sdk/plugin-entry')),'../../openclaw.mjs');
assertRuntime();
const coreOnly=process.argv.includes('--core');
const verify=process.argv.includes('--verify');
const live=process.argv.includes('--live')?await createLiveDeepSeek(process.env.CONEST_CREDENTIAL_FILE??path.join(os.homedir(),'conest-demo','credentials','deepseek.env')):undefined;
const demoRoot=path.resolve(process.env.CONEST_DEMO_STATE??path.join(os.homedir(),'conest-demo',verify?'check-state-'+Date.now():'demo-state'));
const workspace=path.join(demoRoot,'workspace');const studio=path.join(demoRoot,'studio');
await protectDirectory(demoRoot);await mkdir(workspace,{recursive:true});await mkdir(studio,{recursive:true,mode:0o700});
await writeFile(path.join(workspace,'evidence.txt'),'CoNest connects OpenClaw tools and DSH tools in one agent task.\n项目代号：青竹。验收标记：CONEST_BOTH_TOOLS_OK。\n');
const providerDir=path.join(demoRoot,'deepseek-provider');
await cp(path.join(root,'node_modules/@openclaw/deepseek-provider'),providerDir,{recursive:true,dereference:true});
const providerManifest=JSON.parse(await readFile(path.join(providerDir,'package.json'),'utf8'));
providerManifest.openclaw.extensions=providerManifest.openclaw.runtimeExtensions;
await writeFile(path.join(providerDir,'package.json'),JSON.stringify(providerManifest,null,2));
const componentConfig=path.join(demoRoot,'conest.json');
await cp(path.join(root,'examples/office'),path.join(demoRoot,'office'),{recursive:true});
await writeFile(componentConfig,JSON.stringify({workspaceRoot:workspace, ...(process.platform==='win32'?{startupTimeoutMs:60000}:{}), ...(coreOnly?{builtins:Object.fromEntries(['dsh-search','dsh-read','dsh-memory','result-verifier'].map(id=>[id,{enabled:false}]))}:{}), components:['office-knowledge','office-check','office-context'].map(id=>({manifest:path.join(demoRoot,'office',id,'component.json')}))},null,2));
const token=randomUUID();const requests=[];
const text=m=>typeof m.content==='string'?m.content:(m.content??[]).map(b=>b.text??'').join('\n');
const model=createServer(async(req,res)=>{try{
 let bytes='';for await(const c of req)bytes+=c;const input=JSON.parse(bytes);
 const offered=(input.tools??[]).map(t=>t.function.name); const results=input.messages.filter(m=>m.role==='tool');
 const originalTask=text([...input.messages].reverse().find(m=>m.role==='user'&&!text(m).startsWith('Current runtime context.'))??{});
 const task=originalTask.replace(/<dsh-automatic-memory>[\s\S]*?<\/dsh-automatic-memory>/g,'');
 let output;
 if(live)output=await live.complete(input);
 else {
  let name,args,final;
  if(task.includes('采购申请')) {
   if(results.length===0){name='bridge_capabilities';args={};}
   else if(results.length===1){let catalogue=JSON.parse(text(results[0]));if(catalogue.content)catalogue=JSON.parse(text(catalogue));name='bridge_invoke';args={capability:'office_check',generation:catalogue.generation,args:{attachment:false}};}
   else final='采购检查结果：'+text(results.at(-1));
  } else if(task.includes('请记住：'))final='已记住项目代号青竹，汇报偏好为先结论、后证据。';
  else if(task.includes('根据共享记忆')||task.includes('刚才记住')) {
   const context=input.messages.map(text).join('\n');
   final=context.includes('青竹')?'共享记忆：项目代号青竹，汇报偏好为先结论、后证据。':'未找到共享记忆。';
  } else if(results.length===0){name='read';args={path:'evidence.txt'};}
  else if(results.length===1){name='dsh_grep';args={pattern:'CoNest',path:'.'};}
  else final='已由当前 Loop 完成双方工具调用。OpenClaw read 和 DSH dsh_grep 均返回：CoNest connects OpenClaw tools and DSH tools in one agent task. 验收标记：CONEST_BOTH_TOOLS_OK。';
  if(name&&!offered.includes(name))throw Error('Required tool not offered: '+name+'; offered='+offered.join(','));
  const message=name?{role:'assistant',content:null,tool_calls:[{id:'call_'+randomUUID().replaceAll('-',''),type:'function',function:{name,arguments:JSON.stringify(args)}}]}:{role:'assistant',content:final};
  output={id:'chatcmpl-'+randomUUID(),object:'chat.completion',model:'deepseek-v4-flash',choices:[{index:0,message,finish_reason:name?'tool_calls':'stop'}],usage:{prompt_tokens:100,completion_tokens:30,total_tokens:130}};
 }
 requests.push({at:new Date().toISOString(),userText:originalTask,offered,results:results.map(text),decision:output.choices[0].message});
 if(input.stream){res.writeHead(200,{'content-type':'text/event-stream'});let delta=output.choices[0].message;if(delta.tool_calls)delta={...delta,tool_calls:delta.tool_calls.map((c,index)=>({...c,index}))};for(const [d,finish] of [[delta,null],[{},output.choices[0].finish_reason]])res.write('data: '+JSON.stringify({id:output.id,object:'chat.completion.chunk',model:output.model,choices:[{index:0,delta:d,finish_reason:finish}],...(finish?{usage:output.usage}:{})})+'\n\n');res.end('data: [DONE]\n\n');}
 else{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(output));}
}catch(e){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:String(e)}}));}});
await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));const modelPort=model.address().port;
const port=Number(process.env.CONEST_DEMO_PORT??18791);
const config={logging:{file:path.join(demoRoot,'gateway.log')},gateway:{mode:'local',bind:'loopback',port,auth:{mode:'token',token},controlUi:{enabled:true,allowedOrigins:[`http://127.0.0.1:${port}`,`http://localhost:${port}`]}},
 agents:{ownership:'explicit',defaults:{workspace,skipBootstrap:true,model:{primary:'deepseek/deepseek-v4-flash'},models:{'deepseek/deepseek-v4-flash':{agentRuntime:{id:coreOnly?'openclaw':'dsh'}}},thinkingDefault:'off'},entries:{main:{workspace}}},
 tools:{allow:['read','session_status','dsh_read','dsh_grep','dsh_glob','dsh_mcp__reference_memory__search_nodes','bridge_capabilities','bridge_invoke','knowledge_search','knowledge_verify'],fs:{workspaceOnly:true},codeMode:{enabled:false}},
 models:{mode:'replace',providers:{deepseek:{baseUrl:`http://127.0.0.1:${modelPort}/v1`,api:'openai-completions',apiKey:'local-transport-only',models:[{id:'deepseek-v4-flash',name:live?'DeepSeek Flash · live':'CoNest · deterministic rehearsal',agentRuntime:{id:coreOnly?'openclaw':'dsh'},reasoning:false,input:['text'],contextWindow:128000,maxTokens:2048,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]}}},
 plugins:{enabled:true,allow:['dsh-bridge','deepseek'],slots:{memory:'none'},load:{paths:[process.env.CONEST_PLUGIN_ROOT??root,providerDir]},entries:{deepseek:{enabled:true},'dsh-bridge':{enabled:true,hooks:{allowConversationAccess:true},config:{workspaceRoot:workspace,configFile:componentConfig,capabilityGuidance:true,contextProvider:{capability:'office_context',provider:'office-context',timeoutMs:2000,maxChars:1000},studio:{stateDir:studio,dsh:!coreOnly,demoMode:live?'live':'fixture'}}}}}};
const configPath=path.join(demoRoot,'openclaw.json');await writeFile(configPath,JSON.stringify(config,null,2),{mode:0o600});
const env={...process.env,OPENCLAW_CONFIG_PATH:configPath,OPENCLAW_STATE_DIR:path.join(demoRoot,'host'),OPENCLAW_GATEWAY_TOKEN:token,DEEPSEEK_API_KEY:'local-transport-only',DEEPSEEK_BASE_URL:`http://127.0.0.1:${modelPort}/v1`,OPENCLAW_SKIP_CHANNELS:'1',OPENCLAW_SKIP_BROWSER_CONTROL_SERVER:'1',NO_COLOR:'1'};
let log='';let gateway=spawn(process.execPath,[cli,'gateway','run','--port',String(port)],{cwd:workspace,env,stdio:['ignore','pipe','pipe']});gateway.stdout.on('data',c=>log+=c);gateway.stderr.on('data',c=>log+=c);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const base=`http://127.0.0.1:${port}/plugins/conest-studio`;
const cleanup=async()=>{await stopProcessTree(gateway);model.close();await writeFile(path.join(demoRoot,'launcher.log'),log);await writeFile(path.join(demoRoot,'model-evidence.json'),JSON.stringify({mode:live?'live':'fixture',requests,usage:live?.report()},null,2),{mode:0o600});};
process.once('SIGTERM',()=>cleanup().then(()=>process.exit()));process.once('SIGINT',()=>cleanup().then(()=>process.exit()));
try{
 let repaired=false;
 for(let i=0;;i++){
 if(gateway.exitCode!==null && !repaired && log.includes('plugin migration inputs changed')){
   repaired=true;gateway=spawn(process.execPath,[cli,'gateway','run','--port',String(port)],{cwd:workspace,env,stdio:['ignore','pipe','pipe']});
   gateway.stdout.on('data',c=>log+=c);gateway.stderr.on('data',c=>log+=c);
 }
 if(gateway.exitCode!==null||i>600)throw Error('Gateway startup failed: '+log.slice(-12000));try{if((await fetch(`http://127.0.0.1:${port}/health`)).ok)break;}catch{}await sleep(100);}
 const request=async(route,body)=>{const r=await fetch(base+'/api'+route,{signal:AbortSignal.timeout(30000),method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const raw=await r.text();let value;try{value=JSON.parse(raw);}catch{throw Error(`HTTP ${r.status}: ${raw.slice(0,1000)}`);}if(!r.ok)throw Error(`HTTP ${r.status}: ${raw}`);return value;};
 let state;for(let i=0;i<60;i++){try{state=await request('/state');if(state.status==='ready')break;}catch(e){if(i===59)throw e;}await sleep(500);}
 await writeFile(path.join(demoRoot,'connection.json'),JSON.stringify({url:base,token,mode:live?'live':'fixture',pid:process.pid},null,2),{mode:0o600});
 console.log(JSON.stringify({ready:state?.status,url:base,connectionFile:path.join(demoRoot,'connection.json'),catalog:state?.items?.length,errors:state?.errors,model:live?'live':'fixture'}));
 if(verify){
  assert.equal(state.status,'ready');assert.equal(state.errors.length,0);assert.ok(state.items.some(i=>i.origin==='openclaw'&&i.kind==='plugin'));if(!coreOnly)assert.ok(state.items.some(i=>i.name==='dsh_grep'));assert.notEqual(state.process.gatewayPid,state.process.hostPid);assert.equal(state.components.pid,state.process.hostPid);
  const completed=[];
  const scenarios=coreOnly?[]:[['dsh','使用 OpenClaw 的 read 读取 evidence.txt，再用 DSH 的 dsh_grep 搜索 CoNest，汇总两次工具返回的真实内容。'],['dsh','请记住：CoNest 演示的项目代号是青竹，汇报偏好为先结论、后证据。请确认记忆。'],['openclaw','刚才记住的 CoNest 项目代号和汇报偏好是什么？请根据共享记忆回答。'],['openclaw','使用 OpenClaw 的 read 读取 evidence.txt，再用 DSH 的 dsh_grep 搜索 CoNest，汇总两次工具返回的真实内容。']];
  scenarios.push(['openclaw','检查这份采购申请：没有附件。使用 office_check 并返回检查依据。']);
  if(!coreOnly)scenarios.push(['dsh','检查这份采购申请：没有附件。使用 office_check 并返回检查依据。']);
  for(const [loop,message] of scenarios){
   const accepted=await request('/run',{loop,message});console.log('Run accepted',loop,accepted.sessionKey);
   let done;for(let i=0;i<180;i++){const r=await request('/activity');done=r.activity.find(e=>e.kind==='run.complete'&&e.sessionKey===accepted.sessionKey);if(done)break;await sleep(1000);}
   assert.ok(done,'Task did not complete; log: '+log.slice(-10000));assert.equal(done.state,'completed',JSON.stringify(done));assert.equal(done.loop,loop,'Actual loop differs from selection');completed.push(done);console.log('Run completed',loop,done.text?.slice(0,120));
  }
  const activity=await request('/activity');
  for (const index of coreOnly?[]:[0,3]) {
    const events=activity.activity.filter(e=>e.sessionKey===completed[index].sessionKey&&e.kind==='tool.end');
    assert.ok(events.some(e=>e.tool==='read'&&e.state==='completed'),'Native read did not execute');
    assert.ok(events.some(e=>e.tool==='dsh_grep'&&e.state==='completed'),'DSH grep did not execute');
  }
  if(!coreOnly) { assert.equal(activity.memory.length,1,'Recall questions must not be captured as memories');
  assert.ok(activity.memory.some(m=>m.includes('青竹')));assert.ok(completed[2].text.includes('青竹')); }
  for(const result of completed.slice(coreOnly?0:4)) { assert.match(result.text,/A-1/);assert.match(result.text,/false/); }

  await writeFile(path.join(demoRoot,'acceptance.json'),JSON.stringify({at:new Date().toISOString(),mode:live?'live':'fixture',passed:true,coreOnly,process:state.process,components:state.components,completed,activity,requests,usage:live?.report()},null,2),{mode:0o600});
  console.log('Studio acceptance passed');await cleanup();
 }else{setInterval(()=>{writeFile(path.join(demoRoot,'launcher.log'),log).catch(()=>{});},5000);}
}catch(e){await cleanup();console.error(e);process.exitCode=1;}
