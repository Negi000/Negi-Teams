# Phase 5: Jev shadow 接続の初期検証

`src/server/orchestration/jevShadow.ts` は7種類の判定gateの型を定義し、外部送信を確認した短い入力だけを評価する。既定は `off`。`shadow` は回答を記録しても実行・承認・必須検証を変更しない。`active` は校正済みPolicyがないため保留する。`typeSafeJevProvider` はAPIキーを引数で受け、TypeSafeのSystem One endpointへ単発のHTTP要求を送る。キーや送信本文を記録しない。

`jevShadowLedger.ts` は入力、task版、rubric版のhashで同じ判定の再送を防ぐ。送信前に1件あたりUSD 0.01をローカル台帳へ予約し、失敗・結果不明の予約は自動返却しない。台帳予算の設定値はUSD 5以下。これは**アプリ内のdispatch制約**で、TypeSafeアカウントの残高確認や課金停止を保証しない。usageによる推定は、2026-09-30に確認した[公式モデルページ](https://docs.typesafe.ai/models)の入力USD 0.042/100万tokenを用い、請求額ではない。台帳には本文や鍵を残さない。lockが残れば稼働中の呼出しを調べてから復旧する。

## 2026-09-30の実接続

インストール済み `jev-efficiency` MCPを使い、機密のない日本語合成例を3件送信した。Scope例は「見出しの色を青に」という依頼に対する「認証APIの保存方式変更」を `separate_candidate` と分類した。必要な確認を残すNoul値は0.63だったため、検証削減には使わない。Feedback例は「余白は良い、スマホのボタンが切れる」という反応を、肯定Noul 0.93・修正Noul 0.97・全体 `mixed` と分類した。2件とも事前に定めた人手の期待と一致したが、ユーザーによる校正ではない。

Verification/Scoreを同時に問う例は `Provider returned invalid distribution.` で失敗し、回答・usageは得られなかった。再送していない。必須のCIとsession renewal testは維持した。これはshadowで失敗を保留する必要性を示す一例であり、原因をモデル本体と断定しない。

成功2件の実測usageは合計入力906・出力152 token、応答時間は2068msと290ms、公開単価による入力費用推定合計USD 0.000038052。失敗1件のusageと費用は不明なので合計請求額を推定しない。入力fixtureと実応答はローカルの無追跡 `.ebi-team/phase5-shadow/` に保存する。TypeSafeのアカウント残高と実請求は取得していない。

## 現在の限界

- この呼出しはMCP経由。アプリのHTTP providerはfake応答で型・保留・単発送信を検証したが、同じ鍵での実HTTP試験はまだ行っていない。
- 3件の日本語合成例は日本語での判定精度や人間との一致率を示さない。実ユーザーのレビューケースを送る際は個別の機密確認が必要。
- Scope以外の6 gate、検索漏れ、過剰検証、ルーティング、費用・遅延の比較は未校正。`active` へ切り替えない。
- 台帳はこの単独経路でのみ効く。既存Master/workerからの全Jev起動を統合していない。

`node --import tsx --test test/jevShadow.test.ts` の3件と `npm run typecheck` は成功した。単発試験の成功をPhase 5全体の完了や削減効果に換算しない。
