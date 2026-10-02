# 通常turnと共有schedulerの署名索引

2026-10-03更新。NT-010/013/033/064/067/073の保存実装。`RuntimeJournalInventory` を信頼するserverが固定root・turnRoot・schedulerPathで登録すると、通常 `FileScheduler` と `scheduledMasterTurns` のjournalへ実際の署名付きSQLite保存を渡せる。以前のcallback fixtureとは異なる実DB/native guardの実装である。production caller/HTTP/認証済み確認UIへの全面登録とCodex新規会話の有効化は、必要な残条件を満たしてから行う。

## 共有する保存先

共有schedulerは複数のMasterとTaskに使われるため、Masterごとの会話stage索引headへ他Taskのeventを帰属させない。固定schedulerの隣に `.negi-runtime.sqlite3` を置き、固定turnRoot全体とschedulerの原文を一つの独立台帳で検査する。既存のsigning authorityの鍵・root/key identityを使い、新しい鍵やrootを自動生成しない。authority・turn・schedulerのnamespace重複を拒否する。既存stage/owner/recoveryのDB版・event版は変更しない。

DBのmetaは登録context、authority hash、baselineのdecision/proof、元schedulerのhash/長さとファイルの存在、artifact件数を署名する。空の既存schedulerの消失もpendingとして検出し、元々存在しないschedulerへ空ファイルが現れた場合も未索引変更として保留する。global seq・先行hash・登録meta hash・原文hash・schedulerの先行bytes/hashを各eventへ束縛し、headも署名する。署名だけで人間受入やprovider処理の完了と扱わない。raw recordsの意味・scheduler遷移・turn identityは既存reducer/reader/admissionの責務も維持する。

## 明示baseline

1. 既存signing authorityとnative root guard、turnRoot、scheduler parentを準備してserverに登録する。稼働中の旧runtimeを確認する条件はproduction接続前に満たす必要がある。
2. `previewBaseline()` が現在のschedulerと全turn artifactを二度読んで、原文hash・file identity/stamp・固定contextを含むproofを返す。全artifactのworkIdとdirectory名をmarker/DB作成前に照合する。readからDB・marker・providerを作成しない。
3. `adoptBaseline({decisionId, expectedProofSha256})` を明示実行する。同じroot guardの内側で既存FileSchedulerと同じcreate-only lockを取得する。foreign lockを盗まず、そのまま保留する。
4. 現在のproofが一致する場合だけ、署名付き `.negi-runtime-registration.json` をcreate-onlyでfsyncし、DBをcreate-onlyで生成する。既存原文を変更せず、baselineをSQLite `DELETE` journal・`synchronous=FULL` のtransactionへ保存する。
5. 同じdecision/proofの再照会は保存済みbaselineと現在headを読むACKである。異なるdecision、欠けたmarker、DB欠損、途中bootstrap、hot journal/WAL/SHMは再作成・自動rollbackせず保留する。

markerはDB欠損後にも既定writerを止める登録事実である。既定FileSchedulerはmarker/DB/sidecarの存在・アクセス不明を、SQLiteを開かずに拒否する。既定MasterのturnRoot作成と各artifactの公開は`withUnindexedArtifacts`で同じexclusive scheduler lockの内側へ入れ、登録の有無を前後照合する。adoptionと公開を直列化し、事前gateから実書込みまでの間にbaselineが成立しても未索引request/dispatchを公開しない。callbackの内側からscheduler操作を呼ばない。これらは今回の参加writerへの条件であり、この条件を持たない過去binary・直接file書込み・同権限主体を排除するOS sandboxではない。root-wide version条件と旧runtime静止を、production有効化前に別途確認する。

## 通常の保存

`schedulerJournal()` と `turnJournal()` は同じ再入可能なnative storage scopeを使う。schedulerは既存exclusive lockの内側で原文snapshotをauditし、SQLiteへ先行snapshot/CAS付きintentを先にcommitする。その後、以前の保存境界で正確なoffset・create-only/fsync・post-auditを行う。turnのrequest intentはdirectory作成前にcommitする。返答消失は再送せず、同じ索引head/原文を保持する。

全原文・全event chain・署名head・marker・登録identityを検査する。欠けた既知artifact、未公開intent、schedulerの既知prefixだけが残った場合は`pending`として読み取る。次のappend/claim/settle/未送信取消は止める。部分・変更・未索引artifact、別scheduler bytes、未知schema、HMAC不一致、余分なtable、hardlink/aliasは保留する。auditから原文を公開・削除・修復したり、providerを呼んだりしない。

helperは固定scriptへstdinで呼び、鍵・本文をargv/envへ入れない。baseline/appendの経過時間だけでhelperをkillせず、実終了とcleanupを待つ。現在の実装はWindows native guardとDELETE journal、event最大100,000、turn directory最大10,000・artifact最大50,000、scheduler 64MB、DB 1.5GBの範囲を明示する。新しいrequestはdirectory上限をintent前に確認する。SQLiteの[`max_page_count`](https://www.sqlite.org/pragma.html#pragma_max_page_count)へDB上限を設定して戻り値を照合し、COMMIT前のpage数×page sizeとCOMMIT後の実ファイル長も確認する。容量超過を受理後の次回auditへ持ち越さない。全履歴scanの大規模性能、retention、DB版移行、途中bootstrap/hot journalの明示repair、外部anchor、DBとmarkerの同時喪失、非参加writerの意図的ABA、実停電/UNC/Linuxは未完了である。

## 検証と次の接続

最終関連10 test filesは**215件中215成功・失敗/取消/スキップ0（176428.22ms、actual exit0）**。新規19ケースと既存196ケースを含む。実行中tracked runtime/test311 files hash不変、client/server型検査・build・Python AST・差分検査が成功した。ビルド済みserver moduleから固定helper fallbackを使い、実native guard/signing authorityでbaseline→scheduler append→clean audit/seq2を確認した。開始した試験childは実終了を待った。修正前209/209、途中focused6/6、監査側focused1/1を最終suiteへ合算しない。client assetsは`index-CvLJ6iRB.css`/`index-C-cjKz75.js`を維持する。

新規19ケースは実署名DB・実native scopeを使うnormal turn、既存原文のbaseline、変化proof/異decision、削除/rollback/部分/未索引/署名改変、欠けたDBのpersistent fence、foreign lock、全scheduler writer・同じkey ACK・別instanceの最後の枠、実process exit83によるbootstrap途中終了を確認する。独立レビューの3指摘（baseline identityの検証時点、既定Master公開とadoptionの競合、DB/turn容量の検証時点）を修正した。追加の空scheduler存在問題も修正し、6回帰でhead・marker・directory・原文への副作用を照合した。独立再レビューでこれら4点の閉鎖と追加material regressionなしを確認した。監査側の独立focused実行は1成功/18名前filter skip・失敗/取消0、15214.8865ms、actual exit0で、最終suiteとは別集合である（標準出力のファイル保存なし）。試験での原文復元・直接SQL改変・容量/crash hookはfixture操作であり、製品のrepair APIではない。実model/provider/Jev・認証済み新GUI・人間受入・実機・CI成功の証拠として扱わない。

通常Authorityのowner/4とruntime indexの取得head/後続行の統合、起動監査、全Task/Master/旧dispatchの参加登録、旧runtime静止、認証済みMaterial 3 Expressiveのpreview/明示登録/同じ確認ID照会/復旧と、実機safe-area/仮想キーボードの確認を継続する。全73要件・Phase0–8のゴールはACTIVE。
