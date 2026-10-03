import assert from "node:assert/strict";
import { test } from "node:test";
import type { CodexAppServerClient } from "../src/server/master/appServerClient.ts";
import { boundedAppServerArgs, researchAppServerArgs } from "../src/server/master/boundedAppServer.ts";
import { createTaskProviderInspector } from "../src/server/orchestration/taskReconciliation.ts";
import { assertResearchHost } from "../src/server/orchestration/vaultTaskExecution.ts";
import { researchFixture } from "./helpers/readOnlyTaskFixture.ts";

test("research provider inspection validates executable and isolation before account or passive provider reads",async()=>researchFixture(async data=>{
  for(const held of ["executable","tool-authority",null]){
    const calls:string[]=[];
    const inspect=createTaskProviderInspector({
      assertExecutable:async()=>{calls.push("executable");if(held==="executable")throw Error("incompatible executable")},
      launch:async(options)=>{
        calls.push("launch");assert.deepEqual(options.args,researchAppServerArgs());assert.notDeepEqual(options.args,boundedAppServerArgs(true));
        return {client:{initialize:async()=>{calls.push("initialize")},
          assertResearchToolAuthority:async(cwd:string)=>{calls.push("tool-authority");assert.equal(cwd,data.config.checkout);if(held==="tool-authority")throw Error("inherited MCP authority")},
          readAccountMode:async()=>{calls.push("account");return{type:"chatgpt",requiresOpenaiAuth:true}},
          inspectProviderTurnProcessSafety:async(threadId:string,turnId:string)=>{calls.push("provider-read");return{threadId,turnId,status:"interrupted"}}
        } as unknown as CodexAppServerClient,stop:async()=>{calls.push("stop");return{} as never}};
      }});
    if(held)await assert.rejects(inspect(data.config,"thread-fixture","turn-fixture"));else await inspect(data.config,"thread-fixture","turn-fixture");
    assert.deepEqual(calls,held==="executable"?["executable"]:held==="tool-authority"?["executable","launch","initialize","tool-authority","stop"]:
      ["executable","launch","initialize","tool-authority","account","provider-read","stop"]);
  }
}));
test("research host gate keeps uncontained platforms before launch",()=>{
  assert.doesNotThrow(()=>assertResearchHost("win32"));
  for(const platform of ["linux","darwin"] as const)assert.throws(()=>assertResearchHost(platform),/requires Windows Job process containment/);
});
