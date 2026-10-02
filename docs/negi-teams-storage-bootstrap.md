# 初回の保存先を明示的に準備する

## 対象と画面

2026-10-03、Material 3 Expressiveの認証済み`/storage`へ「初回の保存先を準備」を追加した。PCは操作一覧と詳細、スマホは操作選択と単一詳細を使う。共通テーマ・ナビ・確認ID保持を使い、準備、会話記録の登録、実行記録の登録の3段階を表示する。

trusted catalogから固定したroot、turnRoot、scheduler pathとserverのMaster IDを使う。画面やHTTP入力からpath・鍵・Master IDを選ばない。既存authorityは再作成しない。既存の署名鍵/native guardを使うstage移行と、今回の初回root/key/turnRoot作成は別の明示操作である。

操作手順は次の通り。

1. この保存先を使う旧server・外部ツールを停止し、認証とtrusted catalogを設定したserverを`NEGI_STORAGE_MAINTENANCE=1`で起動する。
2. ログイン後に保存状態を開き、「初回の保存先を準備」の内容を確認する。
3. 対象・内容・旧プログラム停止を確認して保存する。通信が途切れた場合は元の確認IDを保持し、同じIDで照合する。
4. 準備済みになったら当該IDの照合を終え、会話の保存記録、実行の保存記録を順に明示登録する。

すべての保存後も`executionStarted:false`、`activation:"held"`を返す。初回準備だけでも通常legacy起動・writerは保留する。通常のindexed production mode、providerや新しい会話の開始は別の受入条件である。

## native公開と同じ確認ID

Windows helperは未作成root/turnRoot、既存canonical parent、scheduler原文・native identity、DB/sidecar/registrationの不在をpreviewで照合する。guard/intent/DB/journal/lock等の派生名同士の衝突を拒否する。読み取り・拒否された初回previewから鍵やsourceは作らない。

初回/部分公開ではJSONLの末尾・key・重複をnativeで検査し、同じ原文SHA/byte数を既存FileScheduler reducerで読み取り専用検査する。native再previewと保存直前の照合を通った同じproofだけを公開する。意味の通らない既存受付履歴を保持したまま初回準備を拒否する。

保存はrootのnative guard、削除を共有しないparent handle、schedulerのcreate-only native leaf lockの内側で行う。

| 順序 | 保存するもの |
| --- | --- |
| 1 | 同じparentのランダムsourceへ署名鍵、空のmasters/Master、空のturnRootを作り、鍵をflush/readbackする。 |
| 2 | 元の確認ID・proof・登録・scheduler snapshot・native directory/key identityを署名した固定pending intentを保存する。 |
| 3 | root sibling intentと独立scheduler fenceをcreate-onlyで公開する。 |
| 4 | 両receiptを確認した後、元のsourceだけを固定root/turnRootへ上書きなしで移す。 |

root側は`<root>.bootstrap-v1.json`、scheduler側は`<scheduler>.negi-storage-bootstrap.json`で、公開前は各`.pending`を使う。receiptには鍵の原文を含めない。移動はWRITE_THROUGHのみで、置換・コピー・別sourceへのfallbackを使わない。

固定intent後のprocess exitでは元の確認IDがpreviewへ戻り、そのID/proof/native identityだけで部分公開を続ける。変更されたreceipt/HMAC、別ID、鍵の欠落、同じ鍵bytesの別inode、source/targetの両存・両欠落は保留する。鍵の再生成、未知sourceの採用・削除、時間だけを根拠にしたlock奪取を行わない。

固定intent前のcrashで残ったランダムsourceは未知のまま保存する。新たな明示操作が別sourceを使う場合も、その残骸を消さない。初回準備のnative childを経過時間だけでkillせず、実際のcloseを待つ。

完全公開後の同じIDは歴史的な準備内容の照合である。その後の正当なindexed進捗やruntime障害からroot/key/turnRootを再作成しない。runtimeの問題は別の監査で保留する。準備の照合成功をruntimeの正常化・再実行と解釈しない。

## 後続登録の境界

stageの全helper要求へ固定serverのbootstrapContextを渡し、runtimeにも同じcontextを使う。片側のroot receiptが欠け、scheduler側fenceが残っている場合や、別authorityが同じschedulerを使う場合はstage/runtime登録を拒否する。新authorityのstage metadataへbootstrap receipt SHAを署名し、runtime bindingにも含める。索引保存後のreceipt喪失から古いauthorityへ降格しない。

runtime previewはnative snapshotに束縛した読み取り専用FileSchedulerを使う。初回準備済みのpersistent fenceを維持したまま、後続の意味検査を行える。既定writerを再開したり、未索引writerを外へ渡したりしない。legacyの両bootstrap receiptがない場合は既存の登録仕様を維持する。

初回previewでapply stdin 24,000 bytes、署名receipt 32,000 bytes、runtime metadata 32,000 bytesの容量を先に予約する。runtime previewも登録容量を保存前に検査する。旧署名形式のfield/domainは変えず、小さい過去metadataを引き続き読める。

実試験でbundled SQLiteが約1,500文字のWindows pathを開けなかった。Windowsの派生stage/runtime DBと`-journal`のUTF-16長が260未満であることを初回検査の必要条件にした。非常に長い日本語pathは鍵作成前に拒否し、既存bytesを保持する。対応範囲内の日本語pathでは3段階のnative登録まで検証する。あらゆるSQLite/file system条件を保証するpath判定ではない。

## 検証

最終試験結果は完了した集合ごとに以下へ記録する。途中の集合や修正前の成功を合算しない。

最終修正後の関連3 test filesは**47/47成功、失敗・取消・skip 0、129,023.057ms、actual exit 0**。実行中runtime/test 320 filesのSHAが不変だった。新規bootstrap 19ケースには、5公開地点での実process exit・元ID再開、native排他競合、鍵/receipt/identity改変、派生名衝突、容量拒否、root receipt喪失・別authorityのscheduler誤登録拒否、schedulerのJSON/重複/reducer不整合、対応範囲内の日本語pathと長いWindows SQLite path拒否を含む。最後のケースでは後日のbytes破損・hardlink・directory化それぞれでruntimeを保留し、元の準備IDの照合後に全snapshot不変を確認した。

先行する関連15 test filesは**272/272成功、失敗・取消・skip 0、694,975.3746ms、actual exit 0**で、runtime/test 320 filesのSHAが不変だった。終了後にbootstrap constructorのcurrent scheduler leaf検査を初回/部分公開側へ限定し、上記最後の回帰を拡張した。変更したruntime/testはそのPython helperと当該testの2 filesだけで、新freezeとの差分を検査した。272件と最終47件を合算せず、最終差分の標準全件試験・CI成功とも扱わない。

途中の実E2Eでは、初回公開fenceによる後続runtime previewの拒否を発見し、native snapshotに束縛した読み取り専用reducerへ修正した。約1,500文字のWindows pathは実SQLite登録で失敗したため、対応を主張せず初回preview前の容量拒否へ変更した。照合条件をfixture都合で緩めていない。型検査・client/server build・Python AST4・差分検査が成功した。

独立read-only監査で、派生namespace衝突、保存容量、片側receipt喪失/別authorityのcontext、既存scheduler意味検査、historical ACKの後続障害依存を修正した。最後の静的再レビューで残存blockerなし。監査側の編集・試験重複はない。

Browser plugin not availableのため、既存Playwright CLI/Chromeとビルド済みloopback serverを使った。GUI用script、snapshot、画像、結果とnative fixtureは公開差分外に保存した。trusted catalogのstate parentだけを用意し、root/key/guard/turnRootは製品の明示操作で実際に作成した。実provider/model/Jevは呼ばない。

| 画面で行った操作 | 観測した結果 |
| --- | --- |
| 未認証storage→ログイン→初回準備 | 初期操作・未作成表示、認証returnToが正しい。 |
| 実native保存→応答だけ切断→再読込み→元IDで照合 | 元IDを保持。鍵・両receiptのSHAとroot/turnRoot/keyのnative identityが前後一致。 |
| 初回準備のみで通常再起動 | 診断HTTPは表示。stage/runtime未登録のままexecutionHeld、canApply:false。追加保存と旧実行を保留。 |
| maintenanceへ戻す→元ID照合→stage/runtime登録 | 両索引がclean、実行は保留。checkboxをfocusしてSpaceで操作。 |
| 1440/768/375/320px、明暗テーマ、reduced motion | 横方向のoverflow/欠けなし。375/320pxでは見出し下に操作を配置。テーマ再読込み、操作選択と下部ナビが有効。 |
| project setupとの往復 | ページIDと意味ある内容を維持。空白・framework overlayなし。 |
| console/page error | 応答切断のexpected net::ERR_FAILED 1件だけ。通常起動・登録・往復では予期しないerror 0。 |

親が最終画像を直接確認した。共通client assetsのhashだけを画面の証拠にせず、server生成HTMLと実native操作を確認した。

## 継続する条件

この操作は当該server・参加writerの保存境界を使う。画面の停止チェックやmaintenance起動は、旧binary/同権限の外部writerが静止した測定証拠でもOS sandboxでもない。全Masterの選択/登録、全旧CLI/MCP/PTY/過去binaryのversion参加、通常indexed production有効化を継続する。

bootstrapContextを省略したtrusted内部APIの直接呼出しは、製品consoleのcross-root fence保証の範囲外である。bootstrap自体はWindows専用で、旧authorityの両receiptがない互換経路を全writerのversion参加証明に置き換えない。

未知seed/部分bootstrapの手動照合・cleanup、欠落鍵/receipt/DB、owner/欠落stage/部分記録、未対応journal、保持・版移行・大規模性能、外部anchor/同時喪失/ABA、実停電/UNC/Linux、実provider/停止/transportの受入は残る。process exit fixtureを停電試験と扱わない。

実機スマホのsafe-area・仮想キーボード、全導線の人による受入は残る。Codex「新しい会話」は未有効化。NT-067/073の追加進捗であり、全73要件・Phase0–8の全体ゴールはACTIVE。このlocal/native/GUI検証は全体完成、release、CI成功ではない。
