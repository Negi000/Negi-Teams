// Native exclusion is process-lifetime; callers authorize the exact signed
// operation before invoking this fixed-name writer recovery boundary.
import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export interface WriterOperation { domain:"vault-initialization"|"project-configuration";requestId:string;hash:string }
const exec=promisify(execFile);
export async function recoverWriter(root:string,kind:"vault"|"configuration",operation:WriterOperation){
  let path=fileURLToPath(new URL("../../../scripts/negi_recover_writer.py",import.meta.url));
  try{await lstat(path)}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;
    path=fileURLToPath(new URL("../../../../scripts/negi_recover_writer.py",import.meta.url));}
  if(!(await lstat(path)).isFile())throw Error("Native writer recovery helper missing");
  await exec("python",[path,"--root",root,"--kind",kind,"--domain",operation.domain,
    "--request-id",operation.requestId.toLowerCase(),"--hash",operation.hash],
    {windowsHide:true,timeout:10000,maxBuffer:20000,env:{...process.env,PYTHONIOENCODING:"utf-8"}});
}
