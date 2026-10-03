# Lunaの読み取り専用Task実行基盤

2026-10-03。Phase 4の限定実装。通常Task画面・契約案からの調査起動は、調査成果用レビューを接続するまで保留する。全体完成・実Policy採用・実モデルの調査成功を表すものではない。

## 固定契約と実行設定

activeなVault Taskのfrontmatterに `task_class: read_only_research` を明示する。通常と同じ目的・対象/対象外・参照対象パス・不変条件・受入条件・検証・差戻し条件・基準SHA・試行数/期限を必要とし、現在の原文とexportの一致、cleanなGit基準を実行直前に照合する。

信頼済みローカル設定には `taskMode: "read_only_research"` と `luna: {model, effort}` を指定し、`sol` を含めない。例のworker部分:

```json
{
  "taskMode": "read_only_research",
  "astra": {"model": "アカウントの実catalogに存在するモデル", "effort": "low"},
  "luna": {"model": "アカウントの実catalogに存在するモデル", "effort": "low"}
}
```

残る設定項目は既存のVault CLIと同じ。モデル/effortは起動したアカウントのcatalogに存在し、textを扱えるものだけを使用する。上記の説明用モデル名は実行可能な値ではない。両者のTask分類が一致しなければ投入しない。Solを別名として保存せず、旧parserは必須のSol設定欠落または新しいscheduler/Taskイベントで停止する。

現在の入口は `node --import tsx scripts/negi_run_vault_task.ts <absolute-config.json>`。Policyはこの経路で自動選択しない。未接続の `lunaPolicy` 指定は拒否する。通常のSol設定は従来のJSON形・hash・権限を保持する。

## 実行と証拠

- Astraの計画とLunaの調査は、共通schedulerの `astra_to_luna` で計画枠→作業枠を使う。承認済み計画の直接実行も明示 `direct` で同じ作業枠を使う。新modeはrole=Luna・checkout/read・全resource/readを要求する。
- 仕様上、Lunaは限定実装も担当しうる。従来のmodeなしLuna writerを一律に読み取り専用へ変えない。その記録は新research wrapperに適合しない。モデル名だけで権限を決めない。
- Astra/LunaそれぞれのContext Packを別path/hashで保存する。計画待機後にもVault原文・export・Pack・基準を照合し、変更があればLunaのturnを送らない。
- 新research threadはread-only、approvalPolicy=never、sandboxのnetworkAccess=falseを要求し、provider返信の一致を必須にする。欠測・別の値は不明結果として保留する。追加dynamic toolやresident authorityと併用しない。仮に承認要求が届いても自動拒否し、ブラウザから権限を追加しない。追加agentを無効にする既存のprocess引数も保持する。
- research専用processではapps/plugins/browser/computer/hooks等の外部toolに関係する18featureとweb検索を無効にする。threadとturnの前にcwd付きeffective configを読む。全無効値・web disabled・空のMCP設定を確認してから、MCP inventoryが空かを照合する。設定にMCPが残れば、調査目的のinventory取得自体を行わない。CLIは検査した0.160.0に限定し、prepareと各provider起動直前に版・canonical executableを確認する。更新後のCLIは互換確認まで保留する。
- Task台帳とnative process ownerは正確なLuna roleを記録する。Windows Jobの全終了記録を確認してから実行枠を解放する。不明なturn・停止/検証の不明結果から自動再送しない。
- 調査文はランナーが外側の固定成果ファイルへfsync保存する。モデルは保存先・コマンド・レビューschemaを決めない。固定検証はGitの可視変更ゼロを開始前と終了後に確認する。開始時にあった変更を検証コマンドが消しても合格しない。既存の書き込み検証では引き続き差分を必須とする。

CLIの `ready_for_review` は機械検証までの状態で、人間受入を含まない。research結果には `resultKind: read-only-artifact` と `reviewAvailability: not-registered` を出力する。既存のGit差分レビューへ渡さない。

## 次の接続

通常Taskの信頼済みcatalog・契約案・登録入口は、新modeを明示拒否する。既存の差分レビューを空差分対応へ緩めない。次に、完成済みLuna attemptの固定成果/hashと検証根拠を採用する専用manifest、部分保存回復、受入直前の再照合、署名付き受入、元Astraへの通知を接続する。その後にMaterial 3 Expressiveの契約案・Task画面へ調査用設定と成果を公開する。

調査文の修正は現在、新しい固定契約にする。既存のcheckout修正版・コード統合の扱いと混ぜない。approved Policyの通常Task選択、全旧reader/writerの版参加、実provider/停止試験、通常UIの全導線・実機受入も残る。

## 検証範囲と限界

最終修正後の関連13 test filesは106/106成功、失敗・取消・skip 0（104744ms、actual exit0）。実行中のsrc/scripts/testのSHAは不変だった。client/server型検査・build・差分検査も成功した。先行16 filesの155/155は外部tool/CLI版の最終修正前で、最終106件へ合算しない。独立read-only再レビューで具体的な未解消指摘なし。新しいGUI操作・実機・実モデルturn/Jev・CI成功を示す試験ではない。

通信fixtureとnative Job試験は、実Codexモデル/Jevの呼出ではない。readonly threadの要求/返信、権限要求拒否、Astra→Luna担当交替、Luna Pack、固定検証、Job終了、枠解放を確認する。通常Sol・既存scheduler・Task画面・契約案・署名付きレビューの関連回帰も対象にする。

実CLI 0.160.0のmetadataだけを読む確認では、18featureの無効値とweb disabledは一致したが、既存MCP設定6件が残ったため保留した。MCP inventory・account/catalog・thread/turnを要求せず、native Jobの終了を確認した。`mcp_servers={}`のoverrideだけで継承設定を消せるとは扱わない。現在の全体設定のままで実モデル調査を開始できる証拠はない。global設定や認証を変更せず利用できる専用tool-free profileの接続が残る。

Gitの可視変更の検査は全filesystemの追跡ではない。無視対象ファイル、一時的に変更して元に戻した内容、外部編集、OSの同一ユーザー、外部サービス経由の処理を完全に隔離した証拠ではない。sandboxのnetworkAccess=falseはモデルサービスや設定済み外部tool全体の通信を証明するものではない。未知結果の外部process終了は既存の保留条件を緩めない。新modeの記録を作成した後の旧binaryへのdowngrade/混在運用は非対応で、証拠を保持して参加reader/writerを揃える必要がある。
