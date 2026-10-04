# Phase 3 実接続の検証記録（2026-09-30）

全Phaseへの拡大、ChatGPTサブスクリプション内の実モデル利用はユーザーが許可した。Codex CLIのログイン状態は`Logged in using ChatGPT`。導入中のApp Serverから8モデルの能力を取得し、`gpt-6-astra`と`gpt-6.1-sol`の`low`で読み取り専用の短いturnをそれぞれ正常終了させた。資格情報の値は取得・記録していない。

既存repoの未コミット変更を保護するため、基準SHA `2bbad19d0589c7a78f353813da958d67290c2267`から隔離checkoutを作成した。Vaultの`NT-TASK-PHASE3-LIVE-MAP` v1、v2を固定JSONへ出力し、Astra計画→Solの1文書作成を実行した。Task Contract、役割別Context Pack、run台帳、回答ファイル、機械検証は明示したローカル出力先に保持する。このrunドライバーは通常のMaster/worker選択経路には未接続である。

## 観測した結果

| 試行 | 観測結果 | 扱い |
|---|---|---|
| v1 | Astraは完了。Solは待機期限内に終了せず、後のプロバイダー照合では`interrupted`。承認要求、成果ファイル、checkout差分は観測されなかった | 台帳を`needs_reconciliation`で停止。プロバイダー状態とローカル差分を記録した後、Sol試行を`abandoned`、runを`stopped`として保存。受入なし |
| v2 | AstraとSolが各1turn完了。Solは指定文書だけを作成。変更パス、39行、5つのコード参照、ファイルハッシュを機械検証 | runは`ready_for_review`、スケジューラは`verified`。`acceptedBy`はnull |

v2のApp Server通知で観測した最後のusageは、Astraがinput 28,063 / output 704、Solがinput 52,704 / output 263（うちcached input 51,712）。これが各turn全体を網羅するかは未確認なのでscopeは`unknown`。API実請求額はnullであり、サブスクリプションの金銭請求へ換算しない。Jevは呼び出していない。

Solの文書は[接続点マップ](negi-teams-integration-map.md)として主作業ツリーへコピーした。レビューで「Astra計画は未実行」という誤記を発見し、コピー側のみ訂正した。隔離checkoutのSol出力は元版の証拠として保持する。訂正後の文書はrun内の機械検証ハッシュと異なるため、[Phase 6レビュー台帳](negi-teams-phase6.md)でA→指摘→BとBの限定的な再検証を別記録にした。人間の受入はなく、元のrunも`ready_for_review`のままである。

## まだ満たしていない条件

- Codex App Serverの読み取り専用ブリッジは後続のPhase 8で固定Masterチャット起動経路に明示opt-inで接続し、実モデルの1turnをローカルUIから完了させた。この接続は本ページのVault Task Contract・run台帳・スケジューラや通常のworker起動へは接続していない。書込、承認UI、実ユーザー作業の受入は未検証。`createMasterBrain("codex")`単体は引き続き既存stubである。
- 本番経路の全体実行枠とTask Contract受付は未接続。今回の明示的なCLIだけが[Phase 4スケジューラ](negi-teams-phase4.md)を通った。
- 隔離worktreeは書込分離であり、OS sandboxや外部副作用の保証ではない。元のSol試行で外部副作用の全件証明はできていないため、放棄記録にもこの限界を残す。
- v2の機械検証は文書の品質全体を証明しない。訂正後の版Bの限定的な機械検証を別記録にしたが、人間の受入は未実施である。

## 再現と戻し方

特定の接続点マップ以外のactive Vault Taskには`scripts/negi_run_vault_task.ts`を使える。絶対パスのJSON設定にCodex実行ファイル、隔離checkout、Vault、固定Taskスナップショット、checkout外の出力先、共有scheduler台帳、run ID、Astra/Solのモデル・effort、明示した検証コマンドを指定する。CLIは`codex login status`がChatGPTログインを示す場合だけ進み、Task source hash・Git基準SHA・clean checkoutを実モデル起動前に確認する。検証コマンドはシェルを通さず指定argvで起動し、終了状態とstdout hashだけをローカル証拠に保存する。変更パスが契約範囲に収まることを検証後に再確認し、機械検証が通れば`ready_for_review`で止まる。全検証項目の対応が欠ける設定はモデル起動前に拒否し、人間の受入を自動記録しない。

設定例（パスとTask IDは各自の環境に置換）:

```json
{
  "executable": "D:/tools/codex.exe",
  "checkout": "D:/worktrees/task-1",
  "vault": "D:/Negi-Teams-Vault",
  "snapshot": "D:/run/task-1-contract.json",
  "outputDir": "D:/run/task-1",
  "schedulerPath": "D:/run/scheduler.jsonl",
  "runId": "task-1",
  "astra": { "model": "gpt-6-astra", "effort": "low" },
  "sol": { "model": "gpt-6.1-sol", "effort": "low" },
  "verification": [{ "requirement": "Task Contractの検証文と完全一致する項目", "program": "node", "args": ["--version"], "timeoutMs": 5000 }],
  "resources": ["source:task-1"]
}
```

各コマンドの`requirement`をTask Contractの検証文と完全一致させ、全項目を一度ずつ対応づける。欠け・重複と、Vaultやcheckout内の出力先・scheduler台帳をモデル起動前に拒否する。出力先の親ディレクトリは事前に作成する。

この例の`node --version`は成果の受入検証にならない。実Taskに対応するコマンドへ変更する必要がある。起動は`node --import tsx scripts/negi_run_vault_task.ts <絶対config.json>`。既存run IDの再投入は拒否し、結果不明の作業を自動再送しない。同じ汎用実行処理を使う[Task画面](negi-teams-task-ui.md)から固定Task v2の実Astra→Sol、内容監査、ローカル修正版の再検証と再起動を確認した。人間受入は未実施。検証コマンドは信頼済みローカル設定として扱い、OS sandboxを提供しない。

実モデル起動CLIは`scripts/negi_app_server_probe.ts`、`scripts/negi_app_server_smoke.ts`、`scripts/negi_phase3_live_map.ts`。どれも明示したCLI実行ファイルとcheckoutを必要とする。`negi_phase3_live_map.ts`は既存runのdispatchキーを再利用すると拒否し、不明なturnを再送しない。結果不明時の読取には`scripts/negi_app_server_inspect.ts`、`scripts/negi_phase3_record_observation.ts`、`scripts/negi_reconciliation_dossier.ts`を使う。限定文書runの放棄判定だけ`scripts/negi_phase3_reconcile_local.ts`で行った。

派生物は`.ebi-team/phase3-live/`にあり、Git管理対象外。隔離checkoutは別worktreeとして残している。戻す際は主作業ツリーの追加コード・文書を差分で確認して戻し、派生物と隔離worktreeは未受入成果を保全した後に扱う。認証、MCP、Codex設定、過去ログは変更していない。
