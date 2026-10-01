# Negi-Teams Phase 3: オフラインの単一タスク実行基盤

後続の実接続試行は[Phase 3実接続の検証記録](negi-teams-phase3-live.md)を参照。本書の「未実装・接続前の条件」は、以下のオフライン実装を確認した時点の記録である。

2026-09-29の「進めてください」をPhase 3への着手指示として扱い、実モデル起動・課金・外部送信の禁止は保持した。今回の成果は**通信層、明示的な子プロセス管理、単一タスクの状態遷移と注入式ドライバーの合成検証**であり、Phase 3の実接続・実作業の終了条件は未達である。

## 実装した範囲

- `src/server/master/appServerTransport.ts`: Codex App Serverのstdio JSONメッセージを行単位で受け、分割受信、複数メッセージ、要求IDと応答の照合、通知、サーバ側要求、タイムアウト、切断、行単位のサイズ上限を扱う。大きな受信チャンク全体を連結せず、未完了行だけを上限内で保持する。切断後の遅延したストリームエラーも処理する。要求がタイムアウトしても自動再送しない。承認要求のハンドラが無ければエラー応答にする。プロセスの起動、資格情報、モデル呼び出しは持たない。
- `src/server/master/appServerClient.ts`: 導入済みCLIの型に合わせ、`initialize`/`initialized`、モデル一覧、thread開始・再開、turn開始・中断、通知のID・usage、承認要求を扱う。turn完了待ちは通知の先着・待機中の切断・タイムアウトを処理する。要求モデルと応答モデルを別に残し、リルートや結果不明の直後はdispatchを止める。承認の操作・対象・thread/turn/item・期限を再照合し、受け口が無ければ拒否する。未回答は期限切れで拒否し、turn完了時にも古い承認を破棄する。`thread/read`と`thread/turns/list`で指定turnの状態を本文なし・ページ上限付きで観測する読取メソッドも追加した。観測結果は照合の材料であり、停止を自動解除しない。読み書きストリームを外から受け取るだけで、実プロセスは起動しない。
- `src/server/master/appServerProcess.ts`: 明示された実行ファイル、引数、作業ディレクトリでローカル子プロセスを所有する境界を追加した。標準出力・入力を上記clientに接続し、stderrは最大64 KiBまでの末尾だけを診断用に保持する。起動失敗、異常終了、停止時にclientを閉じ、途中のturnは結果不明として再実行しない。自動起動・自動再起動はなく、既存MasterSessionやworkerには接続していない。検証ではNodeの合成fixtureだけを起動した。
- `src/server/master/session.ts`: Codex指定の`MasterSession`は、プロセス異常終了や起動失敗のあと自動`resume`しない。手動の「新しい会話」も、結果照合とrun台帳の接続まで拒否する。直前のturn・成果差分・承認状態の照合を求める通知を出し、stoppedで待つ。Claudeの既存動作は維持する。`CodexHeadlessBrain`はまだstubであり、この停止ガードだけでは実接続にならない。
- `src/server/master/codexAppServerBrain.ts`: 明示された実行ファイルだけを起動する読み取り専用の`MasterBrain`ブリッジ。モデル能力を確認して1ターンの通知・最終回答・観測usageをチャットイベントへ写す。結果不明時は完了イベントを出さず停止する。通常の`createMasterBrain("codex")`からは生成せず、実Codex起動は無効のまま。
- `src/server/orchestration/singleTask.ts`: VaultのID・版・SHA-256とGit基準SHAを固定した単一runをJSONLイベントで保存する。Astra計画、Sol実行、検証、明示受入を別状態にする。task/run/attemptとprovider thread/turnを別IDで記録する。冪等キーの重複開始、並行attempt、古い承認、対象違い、証拠のない検証・受入を拒否する。通信断などで結果が不明な試行は`needs_reconciliation`で止め、信頼済み検証フックによる明示照合まで再dispatchしない。検証フックを持たない台帳は`reconcile`を追記できない。usageは出典・scope・実請求/試算/サブスク枠の区分を付けてattemptに保持し、未取得はnullにする。cache入力と推論出力は内訳として検査し、総量へ再加算しない。
- `src/server/orchestration/singleTaskRunner.ts`: 接続済みクライアントを注入する単一runのドライバー。利用可能モデルとeffortを先に確認し、Astraをread-only、Solをworkspace-writeで順に実行する。thread作成応答を得た直後にthread IDを台帳へ保存し、turn開始が結果不明でも照合先を残す。回答をローカルファイルへ保存してSHA-256参照を台帳に残し、検証コールバックの結果を保存する。明示受入は自動実行しない。プロバイダーが失敗を明示した場合は`blocked`、結果不明なら`needs_reconciliation`でSolへの引き継ぎを止める。`thread/tokenUsage/updated.last`は範囲未確認の観測値として`scope=unknown`、費用はnullで記録する。
- `src/server/orchestration/providerObservation.ts`: `needs_reconciliation`のうちthread/turn IDが台帳に固定された試行だけを対象に、注入済みclientの読取メソッドでprovider状態を観測する。観測したID・状態・検索完了可否・時刻・出典を`observe_provider`イベントに追記する。IDや状態が不整合なら記録を拒否し、観測後もrunは停止したままにする。実App Serverへの接続や`reconcile`の自動実行は行わない。
- `src/server/orchestration/reconciliationDossier.ts`: 結果不明の試行について、台帳のprovider観測・承認状態、既知の成果ファイルのサイズとSHA-256、Git基準SHAと変更パス・許可範囲外パスをローカルで読み取る。processの生存状態は未確認と明記し、成果本文や差分本文を自動転載しない。診断は台帳を変更せず、再開可否を常に未承認のまま返す。
- `scripts/negi_task_contract.py` と `src/server/orchestration/vaultTaskContract.ts`: activeかつ`approval_ref`があるlocal Taskノートを読み、範囲・保護条件・受入条件・検証・差戻し・基準SHAを持つスナップショットをVault外に新規保存する。必須仕様と依存ノートのID・版・ハッシュも固定する。run直前の読取経路は元ノートのhash、Vault再exportとの一致、Git HEADとclean checkoutを確認する。Astra/Sol別のContext Packを現在のVaultから生成し、必須Task・仕様・依存が全文で含まれることを照合する。Packの本文を各役割の入力に加え、Pack自体とSHA-256参照をVault・Git checkout外に保存する。AstraからSolへ渡す直前とSol後にPack・契約を再確認し、Git基準SHAの変更・許可外パスの差分を検証結果に反映する。`runSingleTaskFromVault`は注入済みクライアントだけを使い、プロセスやモデルは自分で起動しない。
- `scripts/negi_phase3_mock.ts`: Phase 2 Packのsource hashを実Vaultと照合し、上記台帳をmock Astra→mock Solで一巡する。`resolvedModel`は不明のまま記録し、実コードの検証をしていないので`blocked`・未受入で終了する。ソースノートはPhase 2仕様であり、このmockは実Task Contractの採用ではない。

導入済みCodex CLI `0.158.0-alpha.2.1` の`codex app-server generate-ts`で型をローカル生成し、`thread/start`、`turn/start`、`turn/interrupt`、承認要求等の現行形を調べた。生成ファイルは`.ebi-team/app-server-schema/`に置き、Git管理・正本にはしない。App Serverはexperimentalで、導入版が変わればスキーマを再確認する。

## mockの再実行

```powershell
node --import tsx scripts/negi_phase3_mock.ts `
  --vault 'E:\Negi-Teams\Negi-Teams-Vault' `
  --pack '.ebi-team\context-packs\phase2.md' `
  --out '.ebi-team\phase3-mock'
```

実行ごとに新しい`mock-*.jsonl`を作り、既存runは上書きしない。Packの元ノートが変わった場合は失敗する。保存される`mock:`参照とprovider IDは合成値である。実モデル、MCP、Jev、シェル作業を起動せず、既存の画面・認証・Codex設定を変更しない。

結果不明の試行は、明示したローカル台帳・Git checkout・成果ディレクトリから読み取り専用で確認できる。JSONには成果本文や差分本文を含めない。実行中プロセスや外部副作用は確認できず、結果を見ても再開は許可されない。

```powershell
node --import tsx scripts/negi_reconciliation_dossier.ts `
  --ledger '<run.jsonl>' --attempt '<attempt-id>' `
  --checkout '<Git checkout root>' --artifacts '<run artifact directory>'
```

## Vault Task Contractのローカル固定

TaskノートはVaultの`80_Tasks/`内に置き、Phase 2のProperties検証を通す。`status: active`、`sensitivity: local`、`approval_ref: user:...`を必要とする。本文に次のJSONブロックを一つ置く。これは書式例であり、実Vaultにはまだ実行可能なTaskノートを作成していない。

````markdown
```negi-task-contract
{"objective":"一件の修正","in_scope":["対象機能"],"out_of_scope":["公開"],"allowed_paths":["src/server/orchestration"],"invariants":["既存認証を保持"],"acceptance":["指定した挙動を確認"],"verification":["対象テストを実行"],"escalation":["仕様変更時は停止"],"base_sha":"<Git HEADの40桁または64桁SHA>","max_attempts":1,"time_limit_minutes":30}
```
````

```powershell
python scripts/negi_task_contract.py --vault 'E:/Negi-Teams/Negi-Teams-Vault' --id '<active Task ID>' --project negi-teams --out '.ebi-team/task-contracts/<run-id>.json'
```

出力先の親ディレクトリは先に作成する。既存ファイルへの上書きとVault内への出力は拒否する。`approval_ref`の文字列だけで発言者を認証していないため、実UIでは既存認証と承認履歴に結び付ける必要がある。スナップショットの作成・検証はローカル読み取りと派生物の保存だけで、実行許可や課金許可を与えない。

`runSingleTaskFromVault`の`artifactDir`はVaultとGit checkoutの外に置き、その親ディレクトリは実在させる。Astra/Sol用PackはPhase 2 compilerの`pack --stdout`で作り、必須ノートの全文を落とさず、役割別の追加候補だけを分ける。既定上限は各Pack 16,000文字で、超えたときはrunを始めない。Packの再生成結果が途中で変わればSolの開始または受入検証を止める。これらはローカルの合成検証であり、実モデル送信の許可ではない。

Git差分の範囲検査はGit checkoutのルートを作業ディレクトリとし、trackedと通常のuntrackedファイルを対象にする。Gitでignoredの生成物、リポジトリ外の共有DB、外部プロセスの副作用までは検査できない。実運用ではそれらの保護・検証と、作業中の外部編集を含めたwriter管理が別途必要である。

## 検証

```powershell
node --import tsx --test test/appServerTransport.test.ts test/appServerClient.test.ts test/appServerProcess.test.ts test/codexAppServerBrain.test.ts test/singleTask.test.ts test/providerObservation.test.ts test/reconciliationDossier.test.ts test/singleTaskRunner.test.ts test/vaultTaskContract.test.ts test/masterChatSession.test.ts
python -m unittest discover -s test -p negi_task_contract_test.py -v
npm run typecheck
npm run build
```

合成テストでUTF-8分割受信、複数応答とID順序、未知通知、要求タイムアウト後の無再送、切断、承認要求のfail closed、モデル一覧にない名前・effortの拒否、リルート停止、resume後の照合待ち、同一clientでのthread/start・turn/start同時送信の遮断、未知または予期しないturn通知後のdispatch停止を確認する。provider読取では対象turnへのページ移動、metadataだけの要求、未発見・ページ上限・cursor循環・thread ID不一致と、観測後もdispatch停止が続くことを合成サーバで確認した。読取結果のrun台帳への追記、ID不一致と不正状態の拒否、観測後も再dispatchできないこと、検証フックが無い場合や拒否した場合に`reconcile`を追記しないことを合成台帳で確認した。合成Git checkoutと台帳で、結果不明時のprovider・承認・成果ハッシュ・許可外差分を診断し、台帳が変化せず再開許可にもならないことを確認した。Astra→Sol順序、冪等キー、結果不明からの自動再実行禁止、承認のrun内ID・操作・対象・期限、停止と安全な再開、途中で切れたJSONLの拒否も確認する。ローカル子プロセスのfixtureでは、同じ受信内のturn応答と最終回答通知、異常終了後の結果不明とdispatch停止、stderrの長さ制限、実行ファイル不在を確認する。さらに二つのNode合成プロセスで単一runを一巡し、Astra→Solの結果が台帳に残り、人間の受入前で止まることを確認する。合成Vaultとローカルcloneでは、Task本文と必須仕様の固定、派生JSONの改変検知、Git基準SHA・dirty状態の拒否、許可外パスの変更停止、許可パス内の変更後も未受入のままレビューへ進むこと、役割別Pack・保存ハッシュ・途中変更時の停止を確認する。mock通過は実App Server通信やモデルの挙動を証明しない。

## 未実装・接続前の条件

`CodexHeadlessBrain`は既存stubのままで、`IMPLEMENTED_MASTER_BRAIN_IDS`にcodexを追加していない。読み取り専用ブリッジは合成Nodeプロセスだけで確認した。書き込み、画像、承認UI、resumeは未対応で、実モデルへの利用を有効化していない。単一runドライバーの検証関数は呼び出し側が与えるもので、Git差分や受入条件をこのドライバーだけで検証していない。Task Contract exporterとloaderは合成Taskノートで検証したが、実Vaultにはまだactive Task Contractがない。承認要求には自動許可を接続していない。実Codex CLIとのinitialize、モデル能力、通知、承認応答、resume照合と`MasterSession`/worker接続は未確認。Codexの自動復帰と手動の新規会話は停止した。providerのturn状態は台帳へ記録でき、ローカルの診断で成果ファイル・checkout・承認状態と並べて確認できる。ただし実行中プロセス、成果内容、外部副作用、認証済みの判断は検証せず、永続台帳への`reconcile`追記には信頼済み検証フックが必須で、現行の実行経路には未接続のため拒否される。合成テストの許可フックは認証済み人間の承認を証明しない。観測や診断だけを再開許可とみなしてはいけない。`markReconciled`を呼ぶ条件も自動判定しない。thread作成応答そのものが不明、または応答と台帳保存の間で停止した場合はthread IDも不明のままで、再dispatchせず外部照合を要する。Astraが作る実Task Contract、Solの実装成果、差分・テスト証拠、実際の利用量・費用、実モデルでの検証はまだ無い。

この台帳の`reviewer`文字列だけでは認証済み人間の証明ではない。後続修正で`accept`の追記と読込には、呼出側の信頼できる受入検証関数も必須にした。現行CLIはその関数を認証済みUIに接続しておらず、実runを受入済みにできない。実UIに接続する際は、既存認証とrun/thread/turn照合をサーバ側で行い、承認期限にはサーバ時計を使う。JSONLの不完全な末尾は自動修復せず、元ファイルを保存して照合する。`.lock`が残る場合はwriterの稼働を確認する。Vault、ログ、既存の未コミット変更には手を加えない。

## ロールバック

読み取り専用ブリッジだけ戻す場合は`codexAppServerBrain.ts`、その合成テスト、`master/index.ts`のexport、および`session.ts`の費用未取得表示の差分を確認して戻す。通常のCodex master選択は未有効化なので、ロールバックで実モデルの停止操作は発生しない。

新規の通信層・プロセス境界、台帳・provider観測・ローカル照合診断、単一runドライバー、Task Contract exporter/loader、mock CLI・照合診断CLI、テスト、`session.ts`のCodex専用自動復帰ガード、この文書とREADMEのPhase 3リンク、およびPhase 2 compilerの`pack --stdout`追加部分を差分確認の上で戻す。`.ebi-team/phase3-mock/`、`.ebi-team/app-server-schema/`、将来生成する`.ebi-team/task-contracts/`とrunのPack/回答ファイルはローカル派生物であり、不要なら保存先を確認して退避・削除できる。Vault正本と過去Codexログには手を加えない。
