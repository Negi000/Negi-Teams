# Context Pack の再利用と知識の失効

2026-10-03。NT-019/027/028のローカル派生キャッシュを通常の登録Taskへ接続した。元ノート・署名済み知識承認・Taskの必須条件が正本であり、キャッシュは実行許可や人間受入を作らない。Material 3の知識承認・失効画面で行った操作も、次のTaskの現在の署名を通じて再評価する。

## 通常の経路

`LocalTaskService` → `executeVaultRun` → `runSingleTaskFromVault` → Vault compiler。同じTask stateの`context-cache`を使い、Vaultとモデルcheckoutの外へ置く。Astra/Solの初回生成、Sol開始前、成果検証時に現在のPackを確認する。ブラウザやモデルの入力からキャッシュ保存先を指定しない。開始時のPackとhashは従来どおり実行artifactへ固定保存する。

| 層 | 再利用する内容 | 一致が必要な条件 |
|---|---|---|
| L1 | Markdownの解析済みProperties・本文 | Vault、相対パス、原文SHA、実際にロードした処理コード、privateの許可 |
| L2 | 完全なContext Pack | 全ノートのパス/原文SHA、現在の知識承認、処理コード/Python版、project、role、query、必須ID、文字数上限、privateの許可、Task分類 |

分類だけでは再利用しない。版番号を増やさない手編集、名前変更、追加・削除、status/sensitivity・依存の変更も原文SHAと全ノートの集合で失効する。署名履歴を毎回検証するため、失効のreceiptだけが保存され、activeノートの書換えが途中で止まった場合も、古い承認を使わない。

処理の前後で正本bytes、知識の許可、処理コードを再確認する。途中で変わればPackを返さず、再読を求める。旧コードをロードしたPython processが後継版のディスクbytesを処理版として名乗る競合も拒否する。永続キーは実際のロード済みmodule codeに結び、ロード後にファイルが変われば再起動が必要となる。

絶対パスのローカル出典が現在存在するかどうかも、L1 hit時と返却前に再確認する。ノートbytesが変わらなくても、出典削除を解析済みデータで通過させない。

## 保存と失敗

- HMAC付きのroot/namespace登録と各entryを使う。鍵は通常のTask契約で書込みを許可するVault/checkoutの外に置く。rootとcheckoutの完全一致・祖先/子孫関係も拒否する。
- Windowsでは、既存の各ancestor/root/namespaceのidentityを保存してから照合し、GENERIC_READのハンドルでrenameを止める。新しいroot/namespaceは[WindowsのNtCreateFile](https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntcreatefile)で作成とハンドル取得を一度に行う。リンク/reparse・hardlinkを再利用や削除の根拠にしない。
- 未登録の既存rootは上書き・登録・guard作成を行わない。初回登録の途中停止、guard競合、破損、上限超過は正本から生成する。保守処理の失敗後も正本の照合を通過した内容を返す。guardはOSが解放し、固定lockを消して競合を解決しない。
- 成功した生成の最後に、このnamespaceの署名付き旧L1と、現在のepoch以外のL2を削除する。削除は検証した同じファイルハンドルで行う。不明/破損/リンク付きのentryは保存して調査対象とし、現在のPackには使わない。
- entryは5 MB、namespace内の項目は4,096まで。満杯では追加の保存を止める。全Vaultを横断するディスク容量管理やLRUは実装していない。
- privateは明示許可なしではL1へ本文を保存せず、Packへ含めない。許可を外した正常生成では署名を確認できる旧private派生entryも除去する。失敗時の残存ファイルや破損したentryの物理消去、実行証拠として保持する過去Packの削除は別の管理操作であり、自動消去済みとは扱わない。これはNT-066全体の完了ではない。

同じOS権限の非協調processが最初のidentity取得より前にパスを書き換える状況や、鍵を読める権限そのものへのOS隔離は保証しない。現在はWindowsのローカル保存を確認した。非Windowsはキャッシュを使わず生成し、UNC・同期サービス・実停電は未検証。

## ローカルCLI

親フォルダが実在し、Vault・checkout・無関係な保存先から分離された新しいcache directoryを指定する。

```powershell
python scripts/negi_vault.py --vault '<Vault>' pack --project '<project>' --role sol --require '<Task ID>' --query '<依頼>' --cache-dir '<専用のcache directory>' --cache-stats --stdout
```

`--cache-stats`は本文・鍵・ノートIDを含まないhit/miss等をstderrへ出す。stdoutのPack本文とmanifestは未使用時と同じで、Provider Prompt Cacheやモデル/Jevの再利用を追加しない。

## 確認した範囲

合成Vaultとプロトコルfixtureを使う。新しい実モデル/Jev turnは0。

- cold/warm/freshの本文一致、Astra/Sol同一epochの併存、依頼・必須ID・分類・上限の違い。
- 更新・失効・削除・追加・名前変更、版を変えないsensitivity変更、private許可の解除。
- 正しい署名のpending revokeが、変更前のactive bytesとwarm cacheを保留する経路。
- 原文・署名・処理版の途中変更、旧ロード済みコードによる後継版へのcache汚染の拒否。
- 破損・部分ファイル・未知の保存先、hardlink/junction、root/namespace/ancestor差替え、同時process、保守失敗、所有した試験processの強制終了後の解放。
- 通常実行のAstra→Sol→固定検証→未受入成果、開始前の変更によるSol停止、過去の固定Packの保持。

独立レビューの初期指摘を修正した後、cache専用19件・Task Contract3件は別実行で成功し、追加のblocker/medium findingはなかった。初期のTS検証は36成功・1失敗で、入口の完全一致を追加して修正した。その後の最終検証結果は[実装状況](negi-teams-implementation-status.md)へ記録する。

### 速度の観測

同一PC・生成したノート・同じ依頼で、fresh/warmを交互に4回ずつ測定した。本文SHAは全回一致した。5ノートでは中央値fresh 10.67 ms / warm 19.12 ms、250ノートでは433.13 ms / 425.60 ms。coldは83.69 ms / 2,199.93 msで、250ノートの最初のwarmは1,923.57 msだった。L1は各5/250件、L2は1件のhitを確認した。

キャッシュが常に速いという結果ではない。実Vault・通常Task全体の速度やtoken費用の改善、利用者の使いやすさ、品質向上を実証していない。大規模意味検索、学習済み要約/embedding、既存PackへのUI上の失効通知、NT-019の知識寿命全体、Phase0–8の完成は別の残る条件である。
