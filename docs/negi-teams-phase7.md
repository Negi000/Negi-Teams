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

## 残る境界

- 実験の2課題は小さなコード読取で、実装、検証、修正、ユーザー受入を含まない。処理順やプロバイダー負荷のばらつきも測れていない。
- Policy選択は純粋関数として用意したが、既存Master/workerまたはschedulerの通常dispatchからは呼んでいない。activeなPolicyも存在しない。
- Jevの7 gateの人間校正、知識再利用、検索改善、受入済み成果あたりの総負担比較は未実施。Phase 7の改善効果は未立証。
- `FilePolicyLedger`の信頼境界は呼出側の証拠・承認検証関数に依存する。認証済みUI操作への接続は今後必要。
