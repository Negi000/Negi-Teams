// Authenticated settings reads expose signed operations and observations only.
// Completion endpoints reauthorize content and native ownership before mutation.
import type { LocalProjectSetup } from "./projectSetup.ts";
import type { LocalProjectConfiguration } from "./projectConfiguration.ts";
import { canRecoverWriter, observeWriter, type WriterKind, type WriterObservation, type WriterOperation } from "./writerRecovery.ts";

export interface SetupRecoveryCandidate {
  operation:WriterOperation;title:string;published:boolean;preview:unknown;canComplete:boolean;reason:string|null;
  writers:WriterObservation[];
}
async function observation(root:string,kind:WriterKind):Promise<WriterObservation>{
  try{return await observeWriter(root,kind)}catch{return {state:"unknown",operation:null,sha256:null,legacyGuard:true};}
}
export async function readSetupRecovery(setup:LocalProjectSetup,configuration:LocalProjectConfiguration|null|undefined,historyValid:boolean,historyLength:number){
  const [shared,initial,vault]=await Promise.all([observation(setup.root,"configuration"),observation(setup.root,"setup"),observation(setup.vaults.root,"vault")]);
  const recoveries:SetupRecoveryCandidate[]=[],matching=(v:WriterObservation,op:WriterOperation)=>v.operation?.domain===op.domain&&v.operation.requestId===op.requestId&&v.operation.hash===op.hash;
  const held=(v:WriterObservation)=>v.state!=="absent"||v.legacyGuard;
  const add=(operation:WriterOperation,title:string,published:boolean,preview:unknown,writers:WriterObservation[],valid=true)=>{
    const canComplete=!!configuration&&valid&&writers.every(w=>canRecoverWriter(w,operation));
    recoveries.push({operation,title,published,preview,writers,canComplete,reason:canComplete?null:
      writers.some(w=>w.state==="live")?"この処理は実行中です。終了してから状態を更新してください。":
      "承認内容または保存状態を照合できません。記録を保持して確認してください。"});
  };
  let initialError:string|null=null;
  try{
    const row=await setup.recovery();
    if(row&&(!row.published||held(initial)||shared.operation?.domain==="project-setup")){
      const operation:WriterOperation={domain:"project-setup",requestId:row.requestId,hash:row.preview.hash};
      let valid=historyValid&&(shared.state==="absent"||historyLength<=1);
      try{await setup.authorizeCompletion(row.requestId,row.preview.hash)}catch{valid=false;}
      add(operation,"最初のプロジェクト · "+row.preview.settings.title,row.published,row.preview,[shared,initial],valid);
    }
  }catch{initialError="初回設定の承認・保存記録を照合できません。記録を保持して確認してください。";}
  if(configuration)try{
    const row=await configuration.recoveryCandidate();
    if(row&&(!row.published||matching(shared,{domain:"project-configuration",requestId:row.requestId,hash:row.preview.configuration.hash})))
      add({domain:"project-configuration",requestId:row.requestId,hash:row.preview.configuration.hash},"設定の版 "+row.preview.configuration.version,row.published,row.preview,[shared,initial]);
  }catch{/* The settings history error remains visible in the main state. */}
  let vaultInitializations:Awaited<ReturnType<LocalProjectSetup["vaults"]["history"]>>=[],vaultError:string|null=null;
  if(historyValid)try{
    vaultInitializations=await setup.vaults.history();
    for(const row of vaultInitializations){
      const operation:WriterOperation={domain:"vault-initialization",requestId:row.preview.requestId,hash:row.preview.hash};
      if(row.state==="approved"||matching(shared,operation)||matching(vault,operation))
        add(operation,"Vault · "+row.preview.input.title,row.state==="created",row.preview,[shared,vault,initial]);
    }
  }catch{vaultError="Vault作成の保存記録を照合できません。記録を保持して確認してください。";}
  if(held(vault)&&!recoveries.some(r=>r.operation.domain==="vault-initialization")&&!vaultError)
    vaultError="Vault作成は処理中、または保存状態の照合待ちです。記録を保持して確認してください。";
  return {recoveries,writerStates:{shared,initial,vault},initialError,vaultInitializations,vaultError,
    holdsSetup:held(shared)||held(initial)||!!initialError||recoveries.some(r=>r.operation.domain==="project-setup"&&!r.published),holdsVault:held(vault)||!!vaultError};
}
