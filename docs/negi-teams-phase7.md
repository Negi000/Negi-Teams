# Phase 7: 限定比較とPolicy版管理の基礎

`comparison.ts`は、同じモデル、異なるeffort、同じ基準コミット・依頼・受入条件・利用ツール・評価器を使った2つの読み取り専用成果を比較する。品質が不合格または不明の候補は改善候補にせず、API費用やturn全体のtokenが取得できないときは`null`を保つ。結果は個々の課題に限られ、モデルの一般的な優劣を示さない。

`policy.ts`は読み取り専用の調査に限定したプロファイル候補を`candidate → shadow → compared → approved → active`で記録し、根拠付きrollbackを可能にする。2件以上の独立した品質合格ペア、対象指標の全件非悪化と一部改善、呼出側の信頼できる証拠検証、人間承認検証が必要である。ログ読込時にも証拠と承認を再検証する。明示されたユーザープロファイルは上書きせず、実アカウントのモデル能力にない選択は返さない。権限、外部送信、必須検証はPolicyの選択軸に含めていない。

## 実モデルの2件比較（2026-09-30）

`scripts/negi_phase7_compare_live.ts`で、同じ基準SHAの清潔な別checkoutから`gpt-6-luna`の`medium`と`low`を同じ読み取り専用課題へ同時投入した。どちらの課題でも両armは正解し、checkoutは無変更だった。正解は対象ソースから機械的に生成した。`scripts/negi_phase7_audit.ts`で元レポートのhash、4成果ファイルのhash、schedulerのverified状態、checkoutを再確認し、各armにモデル・effortを固定した監査版を別ファイルに保存した。

| 課題 | medium | low | low − medium |
|---|---:|---:|---:|
| `createMasterBrain`宣言行とcodexクラス | 25,561 ms | 24,624 ms | −937 ms |
| `registry.spawn`の全呼出行 | 23,858 ms | 24,884 ms | ＋1,026 ms |

所要時間にはApp Serverプロセス起動からローカル検証までを含む。2件の方向が分かれ、lowへ一律に切り替える改善根拠はない。Policyは提案・active化していない。結果はVaultの`NT-EVAL-LUNA-EFFORT-READ-001`をcandidateとして記録した。金銭費用は不明。App Serverの最後のusage通知はturn全体の保証がないためtoken差を比較していない。以前のLunaの誤答も保持し、今回の短問成功で上書きしない。

証拠はGit管理外の`.ebi-team/phase7-live/comparison.json`（初回）と`comparison-audited.json`（監査版）、各scheduler台帳・成果ファイルにある。監査版SHA-256は`e60f261ac29cd235e5ed37a054df0c750a9173b183c2faf80296ae4187c095e1`。`test/policyComparison.test.ts`の3件と`npm run typecheck`は成功した。

## 認証付き比較・承認画面（2026-10-03）

通常サーバーの`/policies`と成果レビューから、Material 3 Expressiveの比較画面へ進める。PCはrail・一覧/詳細・承認pane、スマホは候補picker・単一詳細・下部ナビを使う。課題ごとの基準/候補、品質、所要時間、token/費用の不明値、対象指標を表示する。承認、次の調査への適用、理由付き差し戻しを別の認証済み操作として記録する。未改善・品質不合格・候補プロファイル不一致・未測定指標は承認できない。ログイン後の候補deep-link、空一覧、キャンセル、古い画面/通信失敗からの更新も扱う。

`LocalPolicyService`は管理者が明示登録した比較レポートと各成果のSHA-256を再確認する。HTTPは比較内容・ファイルパス・権限を受け取らない。Cookie・同一Origin・UUID・表示版hashが必要。候補の設定と実験のcandidateモデル/effort、一貫したbaseline、異なる課題・成果参照を照合する。設定JSONのキー順は版を変えず、未定義の設定項目は保存前に拒否する。

承認receiptには固定された候補定義と比較を含め、適用/差し戻しにも署名・連番・前後state hashを保存する。再起動はこの署名付き履歴から再構成する。現在の外部根拠が消えた場合は、その候補の新規承認・適用・自動選択を保留するが、署名済みの適用版から戻す操作は残る。関係ない未承認候補の根拠欠損は他の適用版を止めない。現在の登録から古い親版を外しても署名済みの履歴を保持する。

Windowsでは既存`withMasterStorageGuard`で初期化・読込・署名保存を排他し、実Nodeプロセスの終了でnative handleが解放される。空のguardファイルを削除して競合を解消しない。Policyだけは`HumanReviewProofStore.createCommitted`を使い、署名全体の書込・fsync後に同一directoryの`MoveFileW`でUUID名へ公開する。置換・copy fallbackは使わず、公開前に終了した処理のstagingファイルは履歴に取り込まない。鍵とreceiptのhard link、file identity変更、読込中の変更は保留する。disk上の鍵だけをコピーされても承認を偽造できないよう、別のサーバー秘密をHMAC鍵の導出に使う。

native guardとrecovery moduleは同梱sourceのSHA-256を固定し、検証したNode側snapshotを`python -I`へ渡す。検証後にpathをPython codeとして開き直さない。helperには最小限のsystem環境変数だけを渡す。他のサーバー補助処理、PTY、旧Claude Master、supervisor、App Server/Jobにも共通のcase-insensitiveな認証/authority環境除外を適用する。これは同一OSユーザーからのprocess memory読取や汎用OS管理者の権限を防ぐサンドボックスではない。署名鍵/authorityの破損、履歴全体の過去復元、power loss、UNC、非Windowsの書込互換も未検証。

### 明示登録

`NEGI_POLICY_CONFIG`は認証済みサーバーが読むローカルJSONの絶対パス。`storageRoot`と比較ファイルは登録済みのVault・checkout・レビュー出力と分離する。通常サーバーはconfig自体も登録済みの書込rootから分離する。例のSHAは、独立した監査を終えた実ファイルから取得する必要がある。

`NEGI_POLICY_SIGNING_SECRET`は暗号乱数から作った32文字以上の専用秘密を、サーバーの明示process環境へ設定する。モデルから読めるcheckout、Vault、cwdの`.env`やPolicy JSONへ保存しない。cwd `.env`にこのキーが宣言されている場合、明示process環境が優先していてもPolicyは保留する。秘密は認証用`EBI_AUTH_TOKEN`から独立しており、ログイントークン変更で履歴を失わない。専用秘密の変更・紛失は既存署名の検証を停止する。自動移行/再署名は行わず、画面は保存状態の確認を求める。元の秘密を戻した再起動で既存履歴を使える。

```json
{
  "storageRoot": "C:\\Negi-Local\\policy-authority",
  "candidates": [{
    "title": "限定した読み取り調査の候補",
    "policy": {
      "id": "read-low-v1", "parentId": null,
      "taskClass": "read_only_research", "role": "luna",
      "model": "実アカウントで確認したモデル", "effort": "low",
      "metric": "elapsed_ms", "sourceRefs": ["local:independent-experiment-audit"]
    },
    "shadowRef": "local:shadow-observation",
    "report": { "path": "C:\\Negi-Local\\audits\\comparison.json", "sha256": "実ファイルのSHA-256" }
  }]
}
```

レポートは`{ comparisons: PairedComparison[] }`。armの`evidenceRef`は絶対パスと`#sha256=`を持ち、`outputHash`と実バイトが一致する必要がある。登録は信頼できる独立監査の明示的な入口であり、署名/HMACや成果hashだけで品質評価が正しいと証明するものではない。旧`FilePolicyLedger`を通常サーバーの承認authorityとしては使わない。

### 読み取り実行への接続

`runScheduledReadOnlyTurn`は`approvedPolicy: LocalPolicyService`を**明示的に渡した場合だけ**承認済み設定を選択する。既存の`model/effort`は、このモードでは固定された既定値であり、Policyの最初のbaselineと一致する場合だけ選択対象になる。引数なしは従来どおり明示設定。role、読み取り用checkout/resource、provider catalogのモデル・effort・text対応を確認し、開始前にpolicy ID/hash・state hash・選択モデル/effortを固定ファイルへ保存する。実行中の適用/差し戻しは次のdispatchへ反映する。明示モデルやworkspace-writeのTaskへこのPolicyを注入しない。

この接続の現時点の証拠は、署名付きservice＋scheduler＋provider stubの限定試験。通常のVault Taskは引き続きユーザーが指定したAstra/Solを使う。通常のTask分解でLuna調査を自動登録する経路への接続、実アカウントでのPolicy適用、人間が承認した実Policyは未完了。

### 確認した範囲

- 独立監査で指摘された根拠欠損時のrollback停止、終了後のlock残留、部分receiptの参照、JSONキー順による再生失敗、hard linkを経由したdisk鍵による偽造、helper/preflightの秘密継承、旧設定の秘密展開、ログイントークン変更による署名履歴の喪失を修正した。
- 関連26ファイルの324件と起動・設定6ファイルの57件は成功した（Windows Jobの6件は再確認のため重複、異なる試験は計375件）。失敗・cancel・skipは0。`typecheck`と`build`も成功。補助Gitの環境除外は型/差分と共通除外試験でも確認した。
- 署名・版競合・同時操作・根拠改変・根拠欠損後の再起動/rollback・親版の登録省略・公開直前の実Node終了と再開を合成試験した。プロバイダーstubでは実行中のrollback、次回既定への復帰、明示設定の優先、根拠不正時の停止を確認した。
- 通常サーバーとChromiumで1440/375/320px、明/暗テーマ、ログインdeep-link、実測候補の承認不可、合成候補の承認→適用→差し戻し→再起動後の履歴、認証token変更後の履歴、署名秘密変更時の保留と復旧、Escape、空一覧、無効deep-link、409からの更新を確認した。Browser plugin not availableのためキャッシュ済みPlaywrightを使用。予期しないconsole/page errorは0。制御した409と署名検証失敗の503を各1件確認。画像/ログはGit管理外。
- 実測2件の監査版をhash照合して画面確認用に外部rootへコピーしたが、人間承認やactive化はしていない。合成候補の成功をモデル品質・速度改善の証拠としない。新規モデル/Jev turnは0。

## 残る境界

- 実験の2課題は小さなコード読取で、実装、検証、修正、ユーザー受入を含まない。処理順やプロバイダー負荷のばらつきも測れていない。
- 限定した読み取りdispatcherへの明示接続は合成確認済みだが、通常Task分解・旧Master/workerの自動調査への接続は残る。実運用でactiveなPolicyは存在しない。
- Jevの7 gateの人間校正、知識再利用、検索改善、受入済み成果あたりの総負担比較は未実施。Phase 7の改善効果は未立証。
- `FilePolicyLedger`の信頼境界は呼出側の証拠・承認検証関数に依存する。新しい通常UIは独立した`LocalPolicyService`の署名済み履歴を使う。大規模なPolicy履歴の読込性能・整理と、実機での確認は未測定。
