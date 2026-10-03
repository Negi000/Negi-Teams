import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { LocalProjectSetup } from "../../src/server/orchestration/projectSetup.ts";
import { LocalProjectConfiguration } from "../../src/server/orchestration/projectConfiguration.ts";
import { LocalStorageConsole } from "../../src/server/orchestration/storageConsole.ts";
import { LocalTaskService } from "../../src/server/orchestration/taskService.ts";
import { setup } from "./taskAuthoringFixture.ts";

// A real child process speaking a synthetic provider protocol. No model access.
const provider = String.raw`
const fs=require('node:fs');let data='';const statePath=process.argv[2];
const load=()=>fs.existsSync(statePath)?JSON.parse(fs.readFileSync(statePath,'utf8')):{threads:{},nextThread:0,nextTurn:0};
const save=s=>fs.writeFileSync(statePath,JSON.stringify(s));
const reply=t=>({thread:{...t,turns:[]},cwd:t.cwd,model:t.model,modelProvider:t.modelProvider,reasoningEffort:t.reasoningEffort,approvalPolicy:'on-request',approvalsReviewer:'user',sandbox:{type:'readOnly',networkAccess:false}});
process.stdin.on('data',chunk=>{data+=chunk;let end;while((end=data.indexOf('\n'))>=0){
 const q=JSON.parse(data.slice(0,end));data=data.slice(end+1);fs.appendFileSync(process.argv[1],JSON.stringify(q)+'\n');
 if(q.id===undefined||!q.method)continue;let result={};
 if(q.method==='initialize')result={userAgent:'indexed-startup-fixture'};
 if(q.method==='account/read')result={account:{type:'chatgpt'},requiresOpenaiAuth:true};
 if(q.method==='model/list')result={data:['gpt-6-astra','gpt-6.1-sol'].map(model=>({model,supportedReasoningEfforts:[{reasoningEffort:'medium'}],inputModalities:['text']})),nextCursor:null};
 const state=load();let activeThread,activeTurn;
 if(q.method==='thread/start'){activeThread='fixture-thread-'+(++state.nextThread);const t={id:activeThread,cwd:q.params.cwd,model:q.params.model,modelProvider:'openai',reasoningEffort:q.params.config.model_reasoning_effort,ephemeral:false,status:{type:'idle'},turns:[],dynamicTools:q.params.dynamicTools};state.threads[activeThread]=t;save(state);result=reply(t);if(state.fault==='response-cwd')result.cwd='E:/foreign';}
 if(q.method==='thread/resume')result=reply(state.threads[q.params.threadId]);
 if(q.method==='thread/read')result={thread:{...state.threads[q.params.threadId],turns:[]}};
 if(q.method==='thread/turns/list')result={data:state.threads[q.params.threadId].turns,nextCursor:null};
 if(q.method==='turn/start'){activeThread=q.params.threadId;activeTurn='fixture-turn-'+(++state.nextTurn);state.threads[activeThread].turns.push({id:activeTurn,status:'completed'});save(state);result={turn:{id:activeTurn}};}
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\n');
 if(q.method==='turn/start'){
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'turn/started',params:{threadId:activeThread,turn:{id:activeTurn,status:'inProgress'}}})+'\n');
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'item/completed',params:{threadId:activeThread,turnId:activeTurn,item:{type:'agentMessage',phase:'final_answer',text:'通常起動の合成応答です。'}}})+'\n');
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'turn/completed',params:{threadId:activeThread,turn:{id:activeTurn,status:'completed'}}})+'\n');
 }
}});
`;

export async function indexedStartupFixture() {
  const f = await setup();await f.tasks.close();
  try {
    const project = await LocalProjectSetup.open(join(f.root,"settings"),[f.repo]);
    const settings={id:"docs-project",title:"通常起動の確認",project:"fixture",repository:f.repo,vault:f.vault,
      executable:process.execPath,allowedPaths:["docs"],astra:f.config.astra,sol:f.config.sol,
      verification:f.config.verification,maxAttempts:1,timeLimitMinutes:5};
    const preview=await project.preview(settings);await project.save(preview.settings,preview.hash,randomUUID());
    const manager=await LocalProjectConfiguration.open(project),configuration=(await manager.current())!,bundle=await manager.startup(configuration);
    const registration={...await LocalTaskService.inspectStorageRegistration(bundle.tasks),masterId:"negi-master"};
    const console=new LocalStorageConsole(registration,()=>({maintenance:true,executionHeld:true,startupError:null,indexedSetupAvailable:true}));
    const config=join(f.root,"server-config.json"),serverHome=join(f.root,"server-home");await mkdir(serverHome);await writeFile(config,JSON.stringify({fixedEbi:[]}));
    const prepare=async()=>{for(const operation of ["authority-initialize","stage-adopt","runtime-adopt"] as const){const p=await console.preview(operation);await console.apply(p.decision)}};
    const providerState=join(f.root,"provider-state.json");
    const launch=async(options:{mode?:string;maintenance?:boolean;built?:boolean;port?:number}={})=>{
      const wire=join(f.root,randomUUID()+".wire.jsonl"),preload=join(f.root,randomUUID()+".preload.mjs");await writeFile(wire,"");
      const modulePath=resolve(options.built?"dist/server/server/master/appServerProcess.js":"src/server/master/appServerProcess.ts");
      await writeFile(preload,`import { AppServerProcess } from ${JSON.stringify(pathToFileURL(modulePath).href)};\n`+
        `const launch=AppServerProcess.launch.bind(AppServerProcess);AppServerProcess.launch=options=>launch({...options,executable:process.execPath,args:['-e',${JSON.stringify(provider)},${JSON.stringify(wire)},${JSON.stringify(providerState)}]});\n`);
      const probe=createServer();await new Promise<void>(accept=>probe.listen(options.port ?? 0,"127.0.0.1",accept));const port=(probe.address() as {port:number}).port;
      await new Promise<void>(accept=>probe.close(()=>accept()));
      const env={...process.env,EBI_PORT:String(port),EBI_HOST:"127.0.0.1",EBI_AUTH_TOKEN:"indexed-fixture-token",EBI_CONFIG_PATH:config,
        NEGI_SETUP_ROOT:project.root,NEGI_TASK_CONFIG:"",NEGI_REVIEW_CONFIG:"",NEGI_TASK_AUTHORING_CONFIG:"",NEGI_INTEGRATION_CONFIG:"",NEGI_KNOWLEDGE_CONFIG:"",
        NEGI_STORAGE_MAINTENANCE:options.maintenance?"1":"0",EBI_IDLE_NOTIFY:"off",EBI_CONTEXT_GUARD:"off"};
      delete env.NEGI_STORAGE_MODE;if(options.mode!==undefined)env.NEGI_STORAGE_MODE=options.mode;
      const args=["--import",import.meta.resolve("tsx"),"--import",pathToFileURL(preload).href,resolve(options.built?"dist/server/server/index.js":"src/server/index.ts")];
      const child=spawn(process.execPath,args,{cwd:serverHome,env,windowsHide:true,stdio:["ignore","pipe","pipe"]});let output="",closed=false;
      child.stdout!.on("data",bytes=>{output+=bytes});child.stderr!.on("data",bytes=>{output+=bytes});
      const exited=new Promise<void>(accept=>child.once("close",()=>{closed=true;accept()}));
      const stop=async()=>{if(!closed)child.kill();await exited};
      const base=`http://127.0.0.1:${port}`,headers={cookie:"ebi_auth=indexed-fixture-token"};
      const status=async()=>{const r=await fetch(base+"/api/storage",{headers});if(!r.ok)throw Error("Storage HTTP unavailable");return r.json()};
      const until=async(test:(v:Awaited<ReturnType<typeof status>>)=>boolean)=>{
        const deadline=Date.now()+120_000;for(;;){if(closed)throw Error("Server closed: "+output);
          try{const value=await status();if(test(value))return value}catch(error){if(Date.now()>deadline)throw error}
          if(Date.now()>deadline)throw Error("Server state timeout: "+output);await new Promise(accept=>setTimeout(accept,100));}
      };
      try{await until(()=>true)}catch(error){await stop();throw error}
      return{child,base,headers,wire,status,until,stop,messages:async()=> (await readFile(wire,"utf8")).trim().split("\n").filter(Boolean).map(row=>JSON.parse(row))};
    };
    return{...f,project,manager,bundle,registration,console,prepare,launch,providerState};
  } catch(error){await f.close();throw error}
}
