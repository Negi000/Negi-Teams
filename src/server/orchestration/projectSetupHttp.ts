import type { IncomingMessage, ServerResponse } from "node:http";
import { parseCookie, tokenMatches, type AuthConfig } from "../auth.ts";
import type { LocalProjectSetup } from "./projectSetup.ts";
import { projectSetupPageHtml } from "./projectSetupPage.ts";
import type { LocalProjectConfiguration } from "./projectConfiguration.ts";

export function createProjectSetupHttp(service:LocalProjectSetup|null,auth:AuthConfig,host:()=>{legacyConfigured:boolean;active:boolean;activationError?:string|null;bootHash?:string|null},configuration?:LocalProjectConfiguration|null) {
  const json=(res:ServerResponse,status:number,value:unknown)=>{res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"});res.end(JSON.stringify(value))};
  return async(req:IncomingMessage,res:ServerResponse,url:URL):Promise<boolean>=>{
    if(url.pathname!=="/setup"&&url.pathname!=="/api/setup"&&!url.pathname.startsWith("/api/setup/"))return false;
    if(!auth.token){json(res,503,{error:"プロジェクト設定には、サーバーのEBI_AUTH_TOKEN設定が必要です。"});return true}
    const cookie=parseCookie(req.headers.cookie,"ebi_auth");if(!cookie||!tokenMatches(cookie,auth.token)){
      if(req.method==="GET"&&url.pathname==="/setup"){res.writeHead(302,{Location:"/login?returnTo=/setup","Cache-Control":"no-store"});res.end()}
      else json(res,401,{error:"ログインして設定を確認してください。"});return true;
    }
    if(req.method==="GET"&&url.pathname==="/setup"){res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff","X-Frame-Options":"DENY"});res.end(projectSetupPageHtml());return true}
    try{
      const state=host();if(req.method==="GET"&&url.pathname==="/api/setup"){
        let history:Awaited<ReturnType<LocalProjectConfiguration["history"]>>=[],recovery:Awaited<ReturnType<LocalProjectConfiguration["recovery"]>>=null,configurationError:string|null=null,historyValid=true;
        if(configuration)try{history=await configuration.history()}catch{
          historyValid=false;
          try{recovery=await configuration.recovery()}catch{}
          configurationError=recovery?"設定の保存が途中で止まりました。署名した条件を確認してから保存を完了してください。":"設定の保存記録を照合できません。現在の記録を保持し、サーバーの保存状態を確認してください。";
        }
        const current=history.at(-1)??null;
        const writerHeld=configuration?await configuration.writerHeld():false;
        if(writerHeld&&!configurationError)configurationError="設定・作業開始の確認が進行中、または停止後の照合待ちです。状態を更新し、停止している場合は保存記録を保持して確認してください。";
        let vaultInitializations:Awaited<ReturnType<LocalProjectSetup["vaults"]["history"]>>=[],vaultInitializationError:string|null=null;
        if(service&&!state.legacyConfigured&&historyValid)try{vaultInitializations=(await service.vaults.history()).filter(v=>v.state==="approved")}catch{
          vaultInitializationError="Vault作成の保存記録を照合できません。記録を保持して確認してください。既存プロジェクトの設定は引き続き表示できます。";
        }
        json(res,200,{preview:current?.projects[0].preview??(service?await service.current():null),configuration:current,
          history:history.map(c=>({version:c.version,hash:c.hash,titles:c.projects.map(p=>p.preview.settings.title)})),
          vaultInitializations,vaultInitializationError,canCreateVault:!!service&&!state.legacyConfigured&&!configurationError&&!vaultInitializationError,
          recovery,pending:!!configurationError||!!current&&current.hash!==state.bootHash,canManage:!!configuration&&!state.legacyConfigured&&!configurationError,
          canSave:!!service&&!state.legacyConfigured&&!configurationError,active:state.active&&!configurationError&&(!current||current.hash===state.bootHash),activationError:configurationError??state.activationError??null,
          reason:state.legacyConfigured?"既存の実行設定があります。現在のTaskと起動設定を確認してください。":"初回設定を保存するには、サーバーのNEGI_SETUP_ROOTへ作業場所・Vault外の絶対パスを設定してください。"});return true}
      const vaultOperation=["/api/setup/vault-preview","/api/setup/vault-save","/api/setup/vault-complete"].includes(url.pathname);
      if(req.method!=="POST"||!vaultOperation&&!["/api/setup/preview","/api/setup/save","/api/setup/configuration-preview","/api/setup/configuration-save","/api/setup/configuration-recover"].includes(url.pathname)){json(res,405,{error:"Method not allowed"});return true}
      let same=false;try{const origin=new URL(String(req.headers.origin));same=["http:","https:"].includes(origin.protocol)&&origin.host===req.headers.host}catch{}
      if(!same){json(res,403,{error:"同じ画面から設定してください。"});return true}
      if(!service||state.legacyConfigured)throw Error("Setup unavailable");
      if(!req.headers["content-type"]?.startsWith("application/json"))throw Error("JSON required");
      const chunks:Buffer[]=[];let size=0;for await(const c of req){size+=c.length;if(size>(vaultOperation?32000:18000))throw Error("Setup request too large");chunks.push(Buffer.from(c))}
      const input=JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string,unknown>;
      if(!input||Array.isArray(input))throw Error("Setup request invalid");
      if(vaultOperation){
        const operation=async(roots:string[])=>{
          if(typeof input.requestId!=="string")throw Error("Vault request identity invalid");
          if(url.pathname.endsWith("vault-complete")){
            if(Object.keys(input).length!==2||typeof input.expectedHash!=="string")throw Error("Vault completion fields invalid");
            return service.vaults.complete(input.requestId,input.expectedHash,roots);
          }
          if(url.pathname.endsWith("vault-preview")){
            if(Object.keys(input).length!==2||!("input" in input))throw Error("Vault preview fields invalid");
            return service.vaults.preview(input.input,input.requestId,roots);
          }
          if(Object.keys(input).length!==4||!("input" in input)||typeof input.expectedHash!=="string"||typeof input.updated!=="string")throw Error("Vault approval fields invalid");
          return service.vaults.save(input.input,input.expectedHash,input.requestId,input.updated,roots);
        };
        if(!configuration)throw Error("Stable project history required for Vault creation");
        const roots=(rows:Awaited<ReturnType<LocalProjectConfiguration["history"]>>)=>rows.flatMap(c=>c.projects.flatMap(p=>[p.preview.settings.repository,p.preview.settings.vault]));
        if(url.pathname.endsWith("vault-preview")){
          if(await configuration.writerHeld())throw Error("Settings writer held");
          const before=await configuration.history(),value=await operation(roots(before)),after=await configuration.history();
          if(await configuration.writerHeld()||JSON.stringify(before.map(c=>c.hash))!==JSON.stringify(after.map(c=>c.hash)))throw Error("Settings history changed during preview");
          json(res,200,value);return true;
        }
        const complete=url.pathname.endsWith("vault-complete");
        if(typeof input.requestId!=="string"||typeof input.expectedHash!=="string"||
          complete&&Object.keys(input).length!==2||!complete&&(Object.keys(input).length!==4||typeof input.updated!=="string"||!("input" in input)))throw Error("Vault writer fields invalid");
        const value=await configuration.withStableHistory(rows=>operation(roots(rows)),{requestId:input.requestId,hash:input.expectedHash,complete});
        json(res,200,value);return true;
      }
      if(url.pathname.includes("/configuration-")){
        if(url.pathname.endsWith("-recover")){
          if(!configuration||Object.keys(input).length!==2||typeof input.requestId!=="string"||typeof input.expectedHash!=="string")throw Error("Recovery target invalid");
          json(res,200,{configuration:await configuration.recover(input.requestId,input.expectedHash),activation:"restart_required",executionStarted:false});return true;
        }
        if(!configuration||typeof input.expectedCurrentHash!=="string")throw Error("Configuration management unavailable");
        if(url.pathname.endsWith("-preview")){
          if(Object.keys(input).length!==2||!("change" in input))throw Error("Configuration preview fields invalid");
          json(res,200,await configuration.preview(input.change,input.expectedCurrentHash));return true;
        }
        if(Object.keys(input).length!==4||!("change" in input)||typeof input.expectedHash!=="string"||typeof input.requestId!=="string")throw Error("Configuration save fields invalid");
        json(res,200,{preview:await configuration.save(input.change,input.expectedCurrentHash,input.expectedHash,input.requestId),activation:"restart_required",executionStarted:false});return true;
      }
      if(url.pathname.endsWith("/preview")){if(Object.keys(input).length!==1||!("settings" in input))throw Error("Setup preview fields invalid");json(res,200,await service.preview(input.settings));return true}
      if(Object.keys(input).length!==3||typeof input.expectedHash!=="string"||typeof input.requestId!=="string")throw Error("Setup approval fields invalid");
      const save=()=>service.save(input.settings,input.expectedHash as string,input.requestId as string);
      json(res,200,{preview:configuration?await configuration.withStableHistory(save):await save(),activation:"restart_required",executionStarted:false});
    }catch{json(res,409,{error:url.pathname.includes("/vault-")?
      "Vaultを作成・確認できません。新しい保存先と存在する親フォルダー、未コミット変更のないGit、仕様本文を確認してください。保存操作は繰り返さず、状態を更新して途中の作成を確認してください。":
      "設定を保存・確認できません。絶対パス、未コミット変更のないGit、Vaultの必須仕様、入力条件、保存先の既存記録を確認してください。保存操作は繰り返さず、この画面を更新して現在の状態を確認してください。"})}
    return true;
  };
}
