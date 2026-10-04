import type { ChildProcessWithoutNullStreams } from "node:child_process";

/** Only readonly helpers may be stopped at a deadline. Even then the caller
 * keeps its storage guard until actual process close. Mutations await close and
 * retain any committed intent; this function never retries either kind. */
export function observeRuntimeHelper(child:ChildProcessWithoutNullStreams,input:string,readonly:boolean,readTimeoutMs=20_000):Promise<string>{
  return new Promise((accept,reject)=>{
    let stdout="",stderr="",size=0,failure:Error|null=null;
    const timer=readonly?setTimeout(()=>{failure??=Error("Runtime inventory: readonly inspection timed out; storage remains held until helper exit");child.kill()},readTimeoutMs):null;
    child.stdout.setEncoding("utf8");child.stderr.setEncoding("utf8");
    child.stdout.on("data",(chunk:string)=>{size+=Buffer.byteLength(chunk);
      if(size>8_000_000){failure??=Error("Runtime inventory: output limit; inspect saved intent");if(readonly)child.kill()}
      else stdout+=chunk;
    });
    child.stderr.on("data",(chunk:string)=>{stderr=(stderr+chunk).slice(0,300)});
    child.on("error",error=>{failure??=error});child.stdin.on("error",error=>{failure??=error});
    child.on("close",code=>{if(timer)clearTimeout(timer);if(failure)reject(failure);
      else if(code!==0)reject(Error("Runtime inventory held: "+stderr.trim()));else accept(stdout)});
    child.stdin.end(input);
  });
}
