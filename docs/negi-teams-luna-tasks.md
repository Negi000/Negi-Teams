# Lunaの読み取り専用TaskとMaterial 3成果レビュー

2026-10-03。Phase 4の限定実装。信頼済みのresearch設定を通常Taskと契約案へ接続し、Material 3 Expressiveで作成・担当表示・専用成果レビュー・署名付き受入/取消を扱えるようにした。全体完成・実Policy採用・実モデルの調査成功を表すものではない。

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

入口は信頼済みTask catalog、raw/templateプロジェクト設定を使う契約案、Vault単一CLIと並列CLI。Policyはこの経路で自動選択しない。未接続の `lunaPolicy` 指定は拒否する。通常のSol設定は従来のJSON形・hash・権限を保持する。

## 実行と証拠

- Astraの計画とLunaの調査は、共通schedulerの `astra_to_luna` で計画枠→作業枠を使う。承認済み計画の直接実行も明示 `direct` で同じ作業枠を使う。新modeはrole=Luna・checkout/read・全resource/readを要求する。
- 仕様上、Lunaは限定実装も担当しうる。従来のmodeなしLuna writerを一律に読み取り専用へ変えない。その記録は新research wrapperに適合しない。モデル名だけで権限を決めない。
- Astra/LunaそれぞれのContext Packを別path/hashで保存する。計画待機後にもVault原文・export・Pack・基準を照合し、変更があればLunaのturnを送らない。
- 新research threadはread-only、approvalPolicy=never、sandboxのnetworkAccess=falseを要求し、provider返信の一致を必須にする。欠測・別の値は不明結果として保留する。追加dynamic toolやresident authorityと併用しない。仮に承認要求が届いても自動拒否し、ブラウザから権限を追加しない。追加agentを無効にする既存のprocess引数も保持する。
- research専用processではapps/plugins/browser/computer/hooks等の外部toolに関係する18featureとweb検索を無効にする。threadとturnの前にcwd付きeffective configを読む。全無効値・web disabled・空のMCP設定を確認してから、MCP inventoryが空かを照合する。設定にMCPが残れば、調査目的のinventory取得自体を行わない。CLIは検査した0.160.0に限定し、prepareと各provider起動直前に版・canonical executableを確認する。更新後のCLIは互換確認まで保留する。
- Task台帳とnative process ownerは正確なLuna roleを記録する。Windows Jobの全終了記録を確認してから実行枠を解放する。不明なturn・停止/検証の不明結果から自動再送しない。
- researchはWindows Jobによる終了確認が必要なためWindows専用。非Windowsはpreflight/照合時の実行ファイル確認で停止し、providerを起動しない。中断Taskの照合もresearch専用引数・CLI版・effective config・空のMCP inventoryを確認してからaccountと保存thread/itemsを読む。隔離条件が成立しなければ実行枠を保持する。
- 調査文はランナーが外側の固定成果ファイルへfsync保存する。モデルは保存先・コマンド・レビューschemaを決めない。固定検証はGitの可視変更ゼロを開始前と終了後に確認する。開始時にあった変更を検証コマンドが消しても合格しない。既存の書き込み検証では引き続き差分を必須とする。
- 調査の最終回答はUTF-8で12,000 bytes以内（日本語の目安約4,000文字）をpromptに明示する。超過した既知の最終回答は決定的な失敗として記録し、検証/レビューへ進めない。固定契約のレビューmetadataはdispatch前に20KB以内を確認する。全文のJSON escapeを含め100KBのプレビューへ収まる上限で、調査文を途中で切らない。長い検証command argsは全文の検証証拠に固定し、画面用成果には重複させない。

`ready_for_review` は機械検証までの状態で、人間受入を含まない。単一Vault CLIはレビュー登録を行わず `resultKind: read-only-artifact` と `reviewAvailability: not-registered` を出力する。通常Taskと並列CLIは専用成果を登録する。既存のGit差分レビューへ渡さない。

## 専用成果レビューと通常画面

専用manifestは `negi-task-readonly-review/1`。正確な完成Luna attempt、固定outputRef/hash、契約/config/snapshot、基準SHA、変更ゼロ・全固定checkの証拠を採用する。source/preview/manifestは正規の単独ファイルとして読み、symlink・hardlink・型/範囲外・内容変更を保留する。既存Gitレビューの空差分対応へ緩めない。調査文の `Git diff` 等の見出しも調査本文として表示し、コード差分とは解釈しない。

previewだけ/chainのcreateだけの部分保存から、同一byteのcreate-only登録を再開できる。受入直前と再起動時に固定原文・証拠・checkout・scheduler・期待role全件のnative Job終了を再照合する。受入/取消は既存のserver署名を使用し、元Taskの台帳と正確な委任元Astra会話への通知へ反映する。受入済みをモデル応答から作らない。成功通知はレビュー登録が完成するまで出さない。

契約案のraw/template設定はいずれもLuna profileとresearch分類を維持し、人間が確定したVault原文/exportに同じclassを保存する。承認済み計画はAstraの再計画を追加せずLunaへ渡す。研究用分解は独立rootだけに限定する。研究成果をコード統合source、統合baselineの利用/公開、checkout修正版へ渡す入口は拒否する。研究専用プロジェクトの統合画面には専用の空状態を表示する。

Material 3 Expressiveの契約案・Task・履歴・照合で、Luna、調査計画、参照範囲、引継ぎ待ち/調査中を明示する。PCの一覧/詳細とスマホの下部ナビ/縦配置を使う。既存native tool定義のhashは変えず、`readProject`の実行指示とmode付き結果が研究用の条件を示す。

調査文の修正は新しい固定契約にする。approved Policyの通常Task選択、専用tool-free profile、全旧reader/writerの版参加、実provider/停止試験、全通常UI導線・実機受入も残る。

## 検証範囲と限界

先行基盤の最終13 files 106/106はレビュー/UI接続前の記録で、今回の件数へ合算しない。今回の最終関連検証結果は実装状況の冒頭に記録する。client/server型検査・buildは成功。独立read-only再レビューで具体的な未解消指摘なし。

通常のcompiled serverを実認証付きで起動し、Playwrightで1440×1000、375×812、320×780を確認した（Browser plugin not available）。契約確定→Task、成果レビュー→署名付き受入→server再起動→取消、原文変更時の受入保留、研究専用の統合空状態、deep link、ダークテーマ/減動作/キーボードを操作した。横overflow・framework overlay・app console error/warningは0。引継ぎ待ち/調査中/照合の表示は別途controlled HTTP payloadで確認し、実provider照合の成功とは扱わない。モデル結果は合成fixtureで、Windows Jobのprovider placeholderと固定検証の終了はnative記録を使用する。実機スマホ・実モデルturn/Jev・CI成功の証拠ではない。

通信fixtureとnative Job試験は、実Codexモデル/Jevの呼出ではない。readonly threadの要求/返信、権限要求拒否、Astra→Luna担当交替、Luna Pack、固定検証、Job終了、枠解放を確認する。通常Sol・既存scheduler・Task画面・契約案・署名付きレビューの関連回帰も対象にする。

実CLI 0.160.0のmetadataだけを読む確認では、18featureの無効値とweb disabledは一致したが、既存MCP設定6件が残ったため保留した。MCP inventory・account/catalog・thread/turnを要求せず、native Jobの終了を確認した。`mcp_servers={}`のoverrideだけで継承設定を消せるとは扱わない。現在の全体設定のままで実モデル調査を開始できる証拠はない。global設定や認証を変更せず利用できる専用tool-free profileの接続が残る。

Gitの可視変更の検査は全filesystemの追跡ではない。無視対象ファイル、一時的に変更して元に戻した内容、外部編集、OSの同一ユーザー、外部サービス経由の処理を完全に隔離した証拠ではない。sandboxのnetworkAccess=falseはモデルサービスや設定済み外部tool全体の通信を証明するものではない。未知結果の外部process終了は既存の保留条件を緩めない。新modeの記録を作成した後の旧binaryへのdowngrade/混在運用は非対応で、証拠を保持して参加reader/writerを揃える必要がある。
