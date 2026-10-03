# turnとschedulerの保存境界

2026-10-03更新。NT-010/013/033/064/067/073の接続準備。通常の `FileScheduler` と `scheduledMasterTurns` に、serverが登録した保存処理を使う境界を追加した。これらのinterfaceだけでSQLite索引、移行、認証済み確認UIが完成したわけではない。現行production登録は引き続き既定の保存方式で、Codexの新規会話は未有効化である。

## 共有scheduler

`FileScheduler(path, {journal})` は、登録した `SchedulerJournal` の関数とpathを固定する。関数を後で差し替えても登録先を変えず、scheduler.pathの変更を検出したら保留する。既定方式も含め、読取・lock・書込の実I/O先はconstructor時のprivate pathを使う。検証callbackやawait中に公開pathが変わっても別台帳へ書かない。JSON入力やモデルがこの登録を選ぶ経路はない。

登録された経路の順序は以下のとおり。

1. 共通の再入可能な `withStorage` に入る。
2. schedulerの既存のexclusive lockを取得する。lockを盗んだり、時間経過で削除したりしない。
3. 正規parent・通常file・単一link・安定したfile identity/stamp・UTF-8の正確なbytesを読み、`audit`へsnapshotを渡す。
4. actionを既存のreducerで検査し、`appendIntent`へ元のbytesと固定した新しいevent/bytesを渡す。保存処理は、その元の記録と一致するintentを耐久化してから成功を返す。
5. 元のsnapshotを再確認し、既存fileは`r+`、初回fileは`wx+`で開く。以前のprefixを上書きせず、元bytesの長さをoffsetとして追記しfsyncする。
6. 保存済みbytesとintentの一致を再検査する。検査・ACKが失敗した場合も、公開済みeventを削除・書き直し・再送しない。

configure/容量改訂、通常append、claim、worker開始、startNextは同じ境界を使う。容量不足は既存どおりclaim eventを保存しない。同じkeyの照会も保存状態を検査し、異なるactionへのkey再利用を拒否する。読取は既存の`{state, events}`を返し、新しいeventやparent/lockを作成しない。

`audit`・`appendIntent`にはコピーしたsnapshotを渡す。callbackが受け取ったobjectを変更しても、その変更をevent/書込原文へ使わない。callbackから同じschedulerを呼ばず、与えられたsnapshotと固定した保存先を検査する必要がある。

## 通常turnの記録

`scheduledMasterTurns({journal, ...})` は登録したroot、Master ID、scheduler path、確認用関数と終了通知先をコピーする。入力は最初のawaitより前にコピーし、待機中の下書きやmodel変更を保存済み要求へ混ぜない。

requestのintentを保存してからturn directoryを作成する。dispatch/provider/outcome/not-sentも、intentの成功後に原文をcreate-onlyで書きfsyncする。intent後・directory作成前・各scheduler呼出し前後・最終audit後にも登録scheduler pathを照合する。reserveと各lease操作は同じ再入可能なstorage scopeで前後の`audit`を行う。schedulerを登録する場合も、同じrootのstorage scopeを使う必要がある。既存のindexed authorityへ自動接続したり、異なるrootのlockを二重に取得したりしない。

登録したturn rootが欠けた場合は再作成しない。artifactの上限は既存readerと同じrequest 1MB、outcome 2MB、その他8KBで、超過はfile/intent保存前に拒否する。providerの終端応答は成果品質や人の受入ではなく、`humanAcceptance: null`を維持する。

dispatchの保存後にACKを失っても、取消を未送信として扱わない。既定legacy方式にも、既存または部分的なdispatch/provider/outcomeがある場合のnot-sent取消拒否を追加した。unknownはschedulerの枠を保持する。出力保存または索引の確認が失敗した場合、claimを自動で解除しない。

## 接続条件と残る工程

これらのcallbackは信頼するserver側の登録であり、constructorが保存先の署名、native guardの意味、索引の正しさを自動証明するものではない。`withStorage`は開始したnested処理も終了まで待ち、`audit`は欠落・部分保存・stale prefix・登録変更を保留し、`appendIntent`は元snapshotへのCASと耐久化を行う実装でなければならない。read/ACKから修復やprovider再実行を行わない。

既定の登録にはこのcallbackを自動注入しない。通常turn/schedulerを独立索引へ追加する保存実装、既存履歴の明示baseline、root全体の参加version条件、production登録、起動監査と復旧、HTTP/認証済み人間確認、初回thread・戻りidentity・旧runtime静止は次の工程として残る。非参加writerによる意図的ABA、鍵を持つ同権限主体、実停電/UNC/Linuxの保証も未完了である。

Material 3 Expressiveの共通tokensとPC/スマホ別導線は維持する。保存APIと認証の条件が揃ってから、同じ確認IDの照会・明示再開・完了後だけの画面切替を接続する。実機safe-area/仮想キーボードと人の全導線受入を省略しない。全73要件・Phase0–8のゴールは継続中。

## 検証

最終関連9 test filesは**196件中196成功・失敗/取消/スキップ0（108785.4547ms、actual exit0）**。実行中のtracked runtime/test 307 filesのhashは不変だった。client/server型検査・build・差分検査が成功した。client assetsは`index-CvLJ6iRB.css`/`index-C-cjKz75.js`と一致する。開始した試験childの終了を待った。

独立read-only再レビューでpath retargetのP2閉鎖を確認し、この修正に起因する追加のmaterial regressionはなかった。監査側の変更・テストの重複実行はない。path修正前の関連193/193（113781.0453ms）と、修正後focused 30/30（6454.3473ms）は途中集合で、最終suiteの成功件数へ合算しない。

新規19ケースは全scheduler writer経路、intent拒否/ACK消失、公開後のACK消失と同じkey照会、intent後のfile置換、hardlink/alias/登録path変更、turn directory作成前のintent、通常終端/unknown/未送信、dispatch intent/公開ACK消失、部分dispatchのlegacy取消拒否、欠けたroot/oversize outcome、audit中の入力/登録変更を確認する。Windowsの既存native guardを使うscopeと別scheduler instanceの最後の枠競合も確認する。独立レビューで見つかったrequest intent中の別台帳へのretargetを修正し、設定済みA/B双方の原文不変・turn directory未作成・claimなし、最終auditでの変更保留、既定schedulerの検証callback中の変更拒否を回帰確認する。

保存callbackの原文/intentは試験内で構成したfixtureであり、製品の署名DB・baseline移行・repairの実証とは扱わない。実provider/model/Jev・新GUI・実機・人の受入・CI成功の証拠ではない。途中fixtureのエラー文/未作成guardの誤りを修正し、失敗ログと後の成功を区別する。途中集合は最終suiteへ合算しない。
