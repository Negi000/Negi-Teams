# Master会話の独立索引候補

NT-067/073の追加部品。`MasterConversationInventory`と固定Python helperを実装した。既存の会話authority、起動検査、通常入力、provider RPC、復旧解除、認証済み確認UIへの接続は次の工程である。全73要件・Phase0–8のゴールは継続中。

## 保存するもの

既存の署名付き会話段階の外側、authority rootの隣の固定`*.inventory.sqlite3`へ索引を置く。Node 20で使える既存Pythonの標準`sqlite3`を使用し、追加packageは導入しない。鍵や本文をcommand line/environmentへ埋め込まず、最大100KBのstdin要求を一度渡す。

- authorityの正規path、root/masters/鍵file identity、鍵全文SHA-256を署名して固定する。
- 空のMaster directoryだけを明示登録し、directory identityとMaster別の段階数/最終hashを署名する。
- 各stageの固定相対path、要求ID、stage、前のentry hash、owner全文hash、原文SHA-256と原文bytesを保存する。entryはdomainを分けたHMACとhash鎖で検査する。
- `BEGIN IMMEDIATE`、DELETE journal、`synchronous=FULL`で新しいintentと署名headを同じtransactionへ保存する。成功後だけ、呼出側がstage directory/fileを作成できる。helper自体はstageを作成しない。

SQLiteの設定とprocess exit試験は実電源断の保証ではない。[SQLiteのrollback journalとcommit手順](https://www.sqlite.org/lockingv3.html)に従う保存設定であり、OS・filesystem・deviceの耐久性は別の検証が必要。

## 検査と所有者

読取は`mode=ro`で既存DBだけを開き、初期化・移行・repairを行わない。schema/application ID/version、integrity/FK、全登録Masterの署名head・行数・整数連番範囲・最終entry hashを検査する。選択したMasterの全entry鎖、署名、stage原文・要求・遷移と、実filesystemのinventory/本文を二度照合する。他Masterの全本文/鎖を検査したという意味ではない。

`clean`は選択したMasterの保存整合だけを意味する。`needs_reconciliation`を含む署名済み段階でも、保存が一致すれば`clean`になり得る。idle、scheduler/turnの終端、providerの結果、切替可能、人の承認は別の判定である。

intentだけが保存されてfileがない場合、`pending`と欠落pathを返し、`lookup`で索引の固定bytesを読み出せる。次のappendは保留する。既存の部分/異なるfileや未登録directory/fileは変更せず保留する。取消stageを後付けしたり、モデル処理を再実行したりしない。自動復元や人の確認済み復元APIはまだ提供していない。

appendは選択Masterの正確な署名ownerと、呼出前に固定したheadを要求する。新部品のowner/3はPID、nonce、要求hash、cwd hashに加え、Windowsのnative process作成FILETIME、またはLinuxのboot ID＋開始tickを署名する。Pythonを直接起動した親processのPID/作成tokenと一致する必要がある。PIDが同じだけの古いownerやowner/2はappendへ使えない。既存authority/native復旧はowner/2なので、version移行と解除側の同じtoken照合を一緒に接続する必要がある。

Windowsの読取は同じnative handle APIのfile ID・link数・size・作成/更新時刻を前後で照合する。PythonのWindows lstat/fstatが異なるctimeを返したため、両API間のctime比較を廃した。正規directoryのhandleを保持し、DB/fileのreparse/hardlinkを拒否する。選択headを読取後とappend直前に再確認し、全filesystem本文走査をSQLiteのwrite transactionから外した。

process作成tokenの候補実装はWindows/Linuxに限る。macOSのtoken取得は未実装でappendを拒否する。今回の実OS試験はWindowsであり、LinuxのFS/排他/復旧やmacOS互換性の受入は残る。

## 明示的な境界

この独立DBが残る間、stage末尾やoperation folder全体の削除を欠落として検出できる。root/鍵/Master directoryの消失や別identityへの置換も保留する。索引がない既存の非空記録は初期化対象にせず、旧記録を保持する。初期化はcreate-onlyで、部分/旧版DBを上書きしない。

DBとauthorityを同時に過去snapshotへ戻す攻撃、同じOS userによる鍵と全保存先の変更、外部writerのABAを防ぐ外部の単調anchorではない。通常の本文改変/欠落検査と区別する。

候補版はMaster別50,000 stage、DB全体も別の50,000 stage予算、Master catalog 10,000、DB size約1.5GBを上限として保留する。複数Masterの合計にも全体予算を適用し、上限に達したら新stageを保存しない。保持/archival/版移行は未実装であり、上限を理由に記録を削除しない。

`-journal/-wal/-shm`がある場合はGET/append/registerを保留する。実transaction途中のexitで残ったjournalも読取から回復しない。**正規DB/journal、期待するproof、全owner不在とOS排他を照合し、SQLite自身へrollbackを委ねる明示DB復旧の実装が残る。** 手動でjournalを削除する実装は提供しない。

既存復旧receiptの索引は未接続。空のrecoveriesは読めるが、非空receiptはこの候補部品から保留する。receipt intentをnativeの同じ解除境界で照合し、同じ確認の固定bytesを再利用すること、owner baselineのheadを対象要求/自分のreceiptだけ正規化することが必須。一般stage repairでreceiptを作成しない。

## 接続前に残る工程

1. 既存journal/owner/2の明示移行、root/鍵作成前の独立DB検査、retention/version更新。
2. 明示DB rollback復旧、欠落stageだけの認証済みpreview/repair、native receipt intent/解除の照合、owner baseline正規化。
3. 複数Masterの並行appendと大規模履歴の実測、turn/scheduler全履歴の索引/照合、初回基盤とtarget-bearing admissionの復旧。
4. 同じ常駐App Serverでの初回空thread/rotation、戻り値cwd/model/provider/settings、旧runtimeのtool/approval/server request/waiter静止、通常入力との共通排他。
5. 認証済み利用者の確認と完了後だけのUI境界、再接続の同じID照会、実機safe-area/keyboardと人の受入。

既存Material 3 Expressive画面を維持し、Codex「新しい会話」の有効化はこれらの接続後に進める。

## 検証

検証の最終件数・測定値は実装状況文書の今回追記へ記録する。合成provider identityを使った一時filesystem/Node/Python試験であり、実provider RPC、モデルturn、Jev、実機、人の品質受入やCI成功を主張しない。

`node --import tsx scripts/benchmark-master-conversation-inventory.mjs`は500/1,000 completed operation（各5 stage）の実一時treeと署名DBを作り、最初の読取と繰返し読取を各3回測る。fixture builderはtest専用の一括transactionであり、live append APIの性能を測定するものではない。OS cacheは消去せず、cold diskの測定とは呼ばない。scheduler/turn監査、通常入力、RPC、UI待ち時間も測定に含まない。
