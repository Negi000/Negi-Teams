import type { IncomingMessage, ServerResponse } from "node:http";
import { parseCookie, tokenMatches, type AuthConfig } from "../auth.ts";
import type { LocalTaskAuthoringService } from "./taskAuthoring.ts";
import { taskPlanPageHtml } from "./taskPlanPage.ts";

function json(res:ServerResponse,status:number,value:unknown) {
  res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"});res.end(JSON.stringify(value));
}
export function createTaskAuthoringHttp(service:LocalTaskAuthoringService|null,auth:AuthConfig) {
  return async(req:IncomingMessage,res:ServerResponse,url:URL):Promise<boolean>=>{
    if(url.pathname!=="/task-plans"&&url.pathname!=="/api/task-plans"&&!url.pathname.startsWith("/api/task-plans/"))return false;
    if(!service||!auth.token){json(res,503,{error:"新しいTaskを作成するプロジェクトが設定されていません。"});return true}
    const cookie=parseCookie(req.headers.cookie,"ebi_auth");
    if(!cookie||!tokenMatches(cookie,auth.token)){
      if(url.pathname==="/task-plans"&&req.method==="GET"){res.writeHead(302,{Location:"/login?returnTo=/task-plans","Cache-Control":"no-store"});res.end()}
      else json(res,401,{error:"ログインしてから契約案を確認してください。"});return true;
    }
    if(url.pathname==="/task-plans"&&req.method==="GET"){
      res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff","X-Frame-Options":"DENY"});res.end(taskPlanPageHtml());return true;
    }
    try{
      if(url.pathname==="/api/task-plans"&&req.method==="GET"){json(res,200,await service.list());return true}
      if(url.pathname==="/api/task-plans/profiles"&&req.method==="GET"){json(res,200,service.listProfiles());return true}
      const match=url.pathname.match(/^\/api\/task-plans\/([0-9a-f-]{36})\/finalize$/);
      if(!match){json(res,404,{error:"契約案がありません。"});return true}
      if(req.method!=="POST"){json(res,405,{error:"Method not allowed"});return true}
      let same=false;try{const origin=new URL(String(req.headers.origin));same=["http:","https:"].includes(origin.protocol)&&origin.host===req.headers.host}catch{/* absent/invalid origin */}
      if(!same){json(res,403,{error:"同じ画面から契約を確定してください。"});return true}
      if(!req.headers["content-type"]?.startsWith("application/json"))throw Error("JSON required");
      const chunks:Buffer[]=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>4000)throw Error("Request too large");chunks.push(Buffer.from(chunk))}
      const input=JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string,unknown>;
      if(!input||Array.isArray(input)||Object.keys(input).length!==2||typeof input.expectedHash!=="string"||typeof input.requestId!=="string")throw Error("Approval target invalid");
      json(res,200,await service.finalize(match[1],input.expectedHash,input.requestId));
    }catch{json(res,409,{error:"契約を確定できませんでした。操作を繰り返さず、状態を更新して現在の契約と作業を確認してください。"})}
    return true;
  };
}
