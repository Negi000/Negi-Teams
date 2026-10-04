import type { IncomingMessage, ServerResponse } from "node:http";
import { parseCookie, tokenMatches, type AuthConfig } from "../auth.ts";
import { IntegrationConflictError, type LocalIntegrationExecutionService } from "./integrationExecution.ts";
import { integrationPageHtml } from "./integrationPage.ts";
import { ConfigurationPendingError } from "./projectConfiguration.ts";

function json(res:ServerResponse,status:number,value:unknown){res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"});res.end(JSON.stringify(value))}
export function createIntegrationHttp(service:LocalIntegrationExecutionService|null,auth:AuthConfig){
 return async(req:IncomingMessage,res:ServerResponse,url:URL):Promise<boolean>=>{
  if(url.pathname!=="/integrations"&&url.pathname!=="/api/integrations"&&!url.pathname.startsWith("/api/integrations/"))return false;
  if(!service||!auth.token){json(res,503,{error:"成果の統合は設定されていません。プロジェクトとレビューの設定を確認してください。"});return true}
  const cookie=parseCookie(req.headers.cookie,"ebi_auth");
  if(!cookie||!tokenMatches(cookie,auth.token)){if(url.pathname==="/integrations"&&req.method==="GET"){res.writeHead(302,{Location:"/login?returnTo=/integrations","Cache-Control":"no-store"});res.end()}else json(res,401,{error:"ログインしてから統合を確認してください。"});return true}
  if(url.pathname==="/integrations"&&req.method==="GET"){res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff","X-Frame-Options":"DENY"});res.end(integrationPageHtml());return true}
  try{
   if(url.pathname==="/api/integrations"&&req.method==="GET"){json(res,200,await service.overview(url.searchParams.get("profile")||undefined));return true}
   const match=url.pathname.match(/^\/api\/integrations\/(integration-[a-f0-9-]{36})(?:\/(stop|resume))?$/);
   if(match&&!match[2]&&req.method==="GET"){json(res,200,await service.snapshot(match[1]));return true}
   if(!["/api/integrations/preview","/api/integrations/start"].includes(url.pathname)&&!match?.[2]){json(res,404,{error:"統合がありません。"});return true}
   if(req.method!=="POST"){json(res,405,{error:"Method not allowed"});return true}
   let origin=false;try{const value=new URL(String(req.headers.origin));origin=["http:","https:"].includes(value.protocol)&&value.host===req.headers.host}catch{}
   if(!origin){json(res,403,{error:"同じ画面から操作してください。"});return true}
   if(!req.headers["content-type"]?.startsWith("application/json"))throw Error("JSON required");
   const chunks:Buffer[]=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>4000)throw Error("Request too large");chunks.push(Buffer.from(chunk))}
   const input=JSON.parse(Buffer.concat(chunks).toString("utf8"));
   const keys=match?.[2]?["expectedHash","requestId"]:url.pathname.endsWith("/preview")?["profileId","sourceRunIds"]:["profileId","sourceRunIds","expectedHash","requestId"];
   if(!input||typeof input!=="object"||Array.isArray(input)||Object.keys(input).length!==keys.length||Object.keys(input).some(k=>!keys.includes(k)))throw Error("Exact integration input required");
   if(!match?.[2]&&(typeof input.profileId!=="string"||!Array.isArray(input.sourceRunIds)))throw Error("Selection invalid");
   if(match?.[2]||url.pathname.endsWith("/start"))if(typeof input.expectedHash!=="string"||typeof input.requestId!=="string")throw Error("Approval invalid");
   const value=match?.[2]==="stop"?await service.stop(match[1],input.expectedHash,input.requestId):match?.[2]==="resume"?await service.resume(match[1],input.expectedHash,input.requestId):
    url.pathname.endsWith("/preview")?await service.preview(input.profileId,input.sourceRunIds):await service.start(input.profileId,input.sourceRunIds,input.expectedHash,input.requestId);
   json(res,200,value);
  }catch(e){if(url.pathname.endsWith("/preview")&&e instanceof IntegrationConflictError)json(res,409,{error:e.message,conflict:e.conflict});
   else json(res,409,{error:e instanceof ConfigurationPendingError?e.message:url.pathname.endsWith("/preview")?"同じ基準で検証された固定成果と、重ならない変更範囲を選んでください。競合は統括へ戻してください。":"統合の版または実行状態を確認できません。操作を繰り返さず、状態を更新して差分と実行記録を確認してください。"})}
  return true;
 };
}
