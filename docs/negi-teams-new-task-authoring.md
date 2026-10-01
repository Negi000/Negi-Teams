# 新しい依頼からTask契約へ

2026-10-01追加。常駐Codex Astraの通常会話から、設定済みプロジェクトの新しい独立Taskを作る入口。大きい依頼には[2〜8件の分解案](./negi-teams-task-decomposition.md)も保存できる。独立Taskだけを確定・実行し、先行成果が必要な案は統合後の新しい計画を待つ。

## 利用者の流れ

1. 作業一覧の「新しいTask」から、利用できるプロジェクトを確認する。
2. 「統括に依頼する」で目的を送る。Astraが必須仕様と参照の版を読み、短い契約案とSolへの実行計画を保存する。
3. チャットに表示された「この契約案を確認」から、目的・対象内外・許可パス・不変条件・受入・検証・差戻し・担当・制限・参照の版を確認する。
4. 「この契約を確定」で正確な案を承認する。Vaultの新しいTaskノート、固定export、専用Git worktree、同じTaskカタログへの登録を行う。
5. Task画面から開始する。承認済みのAstra計画をSolへ直接渡し、既存の検証・固定差分レビューへ進む。成果の人間受入は別の操作。

案の保存は実行を開始しない。修正は統括へ伝え、新しい案を作る。確定済みTaskや過去の成果を書き換えて新しい条件を採点しない。

## サーバーの明示設定

`NEGI_TASK_AUTHORING_CONFIG`は絶対パスのローカルJSON。認証付き`NEGI_TASK_CONFIG`と、少なくとも1件の既存の固定実行設定を必要とする。設定はモデル・HTTPから編集できない。

```json
{
  "storageRoot": "C:/negi/state/task-authoring",
  "profiles": [{
    "id": "project-docs",
    "title": "文書作業",
    "templateRunId": "registered-run-id",
    "repository": "C:/negi/projects/example",
    "worktreeRoot": "C:/negi/worktrees/example",
    "allowedPaths": ["docs"],
    "maxAttempts": 1,
    "timeLimitMinutes": 30
  }]
}
```

`templateRunId`からVault、プロジェクトID、Codex実行ファイル、Astra/Solモデルとeffort、検証コマンド、共有資源、同じschedulerを引き継ぐ。Taskの目的や変更範囲をテンプレートから複製しない。案は設定された許可範囲と制限をさらに狭めることができる。すべての設定済みチェックが新しい契約に必要となる。モデルがコマンドを追加・置換したり、別の保存先・モデル・課金経路を選ぶ入力はない。

profileのplannerと実際に起動した常駐Masterのモデル・effortが一致する場合だけ案を保存できる。設定のSHA、プロジェクトHEAD、参照ID・版・内容SHAを固定し、確定直前に再照合する。基準SHAはコミット済みの版を指す。既存checkoutの未コミット作業は取り込まない。

## 通常チャットの追加操作

| 操作 | 読む・保存する内容 |
|---|---|
| `negi_list_projects` | 人が設定した実行profile・担当・許可範囲・チェック・制限 |
| `negi_read_project` | 必須仕様と明示した参照の全文・版・内容SHA |
| `negi_propose_task` | 読んだ参照に基づく契約案と実行計画。実行権限は持たない |
| `negi_propose_task_decomposition` | 依頼全体・共有条件・各Task・依存・引継ぎ成果を一つの分解案へ保存。先行Taskがある案は実行不可 |

thread・turn・callと実際のモデル・effortを保存する。同じcallの再送は同じ案を返し、異なる内容でのID再利用を拒否する。Task案はサーバーの計画用保存先に置く。人の確定までVaultのactive Taskは増えず、作業場所やprovider turnも生成しない。

## 保存・実行・再起動

- Cookie認証・同じOrigin・UUID・案の正確なhashが揃った確定要求だけ、モデルの書込範囲外へ署名付き承認を保存する。全確定処理を1つのWriter lockで囲み、停止後のlockを自動解除しない。
- 署名したTask本文をVault Writer lockと参照照合の下で保存し、既存Python exporterの結果が正確な承認内容と一致することを確認する。Markdownコードブロックの挿入による別契約の混入を拒否する。
- worktree作成intentを保存してから、信頼済みGitリポジトリの固定SHAでdetach作成する。既存パスを採用・削除しない。親リポジトリ、基準SHA、clean状態を確認して作成証拠を保存する。
- 既存の共通schedulerへ`direct`のSol作業として登録する。Task台帳には承認済み計画の採用を記録する。追加Astra turnや架空のAstra attempt・料金を生成しない。実際の計画turnはMaster台帳に残る。
- 実行直前とSolへの引継ぎ直前に、署名・固定export・Vault・Context Pack・checkoutを再照合する。終了後は従来のパス範囲・検証・差分レビューを使い、人間受入を自動生成しない。
- 再起動は正確な署名と作成証拠がある登録を復元する。実行済みのdirty checkoutも現在のTaskを確認するために復元する。provider・worktree作成・Task開始を自動再送しない。作成途中・署名不一致・設定変更は保留する。

## 確認と残る範囲

型検査・ビルド成功。標準テスト691件中689成功・失敗0・既定skip2。実Git/Vaultを使い、案の重複、範囲・コマンド・モデル・制限の拒否、仕様/HEADの変更、署名改変、部分作成、再起動、別Writerの同時承認、停止後lock、Cookie/Origin、直接Solの一度だけの実行、既存checkoutの不変と人間受入未生成を確認した。

最終の同時draft出版対策後は、この入口の10件を再確認し、全成功。最終の在庫は692件であり、標準テスト692件の全実行を主張しない。案の出版もWriter lockで直列化し、同じprovider callには同じ保存IDを使う。停止後のlockは自動解除しない。

隔離した検証用repo/Vaultで、Material 3の通常チャットから実Astra lowが新しい日本語依頼の必須仕様を読み、契約案を1件保存した。利用者操作に相当するQA操作で具体的な案を確定し、Task画面から実Sol lowを1回起動した。文書1件・固定チェック・差分レビュー待ち・枠解放・再起動後の登録復元を確認した。追加Astra attemptはなく、元checkout・元仕様・実行設定の参照Taskは不変。人間受入と実料金は未取得。この小さい文書の成功を、任意のコード変更や全プロジェクトの品質受入へ一般化しない。

Chromiumの1440px/320px/375px、契約・Task・レビューへの深いリンク、キーボードによる契約確定、ダークテーマを確認した。320pxで参照詳細を開いた際の長いhashの横はみ出しを修正し、最終表示でも横はみ出しがないことを確認した。実機のsafe area・仮想キーボードは未確認。

初版の実subscription試験は依存Taskのない1件が対象。追加の分解案では独立部分の契約化と通常実行へ接続したが、先行成果の統合と実際の基準での後続契約化、初回プロジェクト設定のGUI、作成途中の手動照合・取消・再開、新しい案による確定済み契約の版移行は残る。これらを手動テンプレート複製で完了扱いにしない。全73要件の完了・旧MCP/PTY経路の移行・実機受入は別のゲート。

Task画面から開始した作業は利用者起動として結果を作業一覧へ返す。統括チャットへの結果通知・次の入力への固定packは、既存のnative委任の起動元を使用する。契約案を作った会話への自動関連付けは残る。

2026-10-02の[実コードQA](./negi-teams-code-integration-qa.md)で、実Astraによる3件の分解案と、保存した統合基準からの後続契約を確認した。native入口の案・結果サイズを契約サービスの上限に合わせ、不正作業IDの修正箇所を安全に返すようにした。初回設定・汎用復旧・契約版移行・会話関連付け・実機・実利用者受入は残る。
