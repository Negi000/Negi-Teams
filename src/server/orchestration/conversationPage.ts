import { negiPageStart } from "../../shared/material3.ts";

export function conversationPageHtml(): string {
  return negiPageStart("元の会話", "task") + String.raw`
<div class="md-page-heading"><div><div class="md-eyebrow">CONVERSATION SOURCE</div><h1>元の会話</h1><p>この作業につながった送信と応答を確認します。</p></div><button id="refresh" class="md-icon-button" aria-label="会話の記録を更新">↻</button></div>
<p id="error" class="md-message" role="alert"></p>
<article id="detail" hidden>
<section class="md-surface md-surface-tertiary"><h2 id="title"></h2><div class="md-actions"><span id="state" class="md-chip"></span><span id="evidence-state" class="md-chip"></span></div><p id="message" role="status"></p><div class="md-actions"><a id="task-link" class="md-button md-tonal" hidden>Taskへ戻る</a><a id="plan-link" class="md-button md-tonal" hidden>契約案へ戻る</a><a class="md-button md-text" href="/?view=workspace">今の統括を開く</a></div></section>
<div class="md-contract-grid md-section"><section class="md-surface"><h2>送信した内容</h2><p class="muted">統括へ渡した入力です。前の作業結果を添付した場合は、その内容も含みます。</p><pre id="input" class="md-conversation-text"></pre></section><section class="md-surface"><h2>記録された応答</h2><p id="outcome" class="muted"></p><pre id="response" class="md-conversation-text"></pre></section></div>
<details class="md-section"><summary>会話と根拠の識別子</summary><section class="md-surface"><dl id="metadata" class="md-key-values"></dl></section></details>
<p class="muted">元の会話全体の復元ではなく、この作業につながったturnの記録です。この画面を開いても入力の再送・Taskの実行・成果の受入は行いません。</p>
</article></main></div>
<script>
const $=id=>document.getElementById(id);let request=0;
const query=location.search;
function link(id,href){$(id).hidden=!href;if(href)$(id).href=href;else $(id).removeAttribute('href')}
async function load(){const generation=++request;$('detail').hidden=true;$('error').textContent='';$('input').textContent='';$('response').textContent='';$('metadata').replaceChildren();$('refresh').disabled=true;
try{const response=await fetch('/api/conversations/origin'+query,{credentials:'same-origin',cache:'no-store'});if(generation!==request)return;
if(response.status===401){location.href='/login?returnTo='+encodeURIComponent('/conversations'+query);return}const value=await response.json();if(generation!==request)return;if(!response.ok)throw Error(value.error||'会話の記録を取得できません');
$('title').textContent=value.title;$('state').textContent=value.source==='created'?'契約案の作成元':'Taskの開始元';$('message').textContent=value.message;
$('evidence-state').textContent=({available:'記録あり',waiting:'応答待ち',missing:'記録なし',attention:'照合が必要',browser:'画面から開始'})[value.state]||'未確認';$('evidence-state').className='md-chip '+(['attention','missing'].includes(value.state)?'md-chip-warning':'');
$('input').textContent=value.input===null?'送信内容を表示できません。':value.input;$('response').textContent=value.finalText===null?'応答の全文は確認できていません。':value.finalText;
$('outcome').textContent=({completed:'応答の終了を確認',failed:'応答が失敗',interrupted:'応答を中断',running:'応答待ち',needs_reconciliation:'応答の照合が必要'})[value.outcome]||'応答状態は未確認';
link('task-link',value.taskHref);link('plan-link',value.planHref);
for(const [name,text] of [['統括',value.origin?.masterId],['会話',value.origin?.threadId],['turn',value.origin?.turnId],['委任・作成の呼び出し',value.origin?.callId],['実行記録',value.workId],['担当',value.model],['推論設定',value.effort],['送信準備を記録した日時',value.sentAt],['入力SHA256',value.inputSha256],['終了記録SHA256',value.outcomeSha256]]){const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=name;dd.textContent=text??'未確認';$('metadata').append(dt,dd)}
$('detail').hidden=false;
}catch(error){if(generation===request){$('detail').hidden=true;$('error').textContent=error.message}}finally{if(generation===request)$('refresh').disabled=false}}
$('refresh').addEventListener('click',load);load();
</script></body></html>`;
}
