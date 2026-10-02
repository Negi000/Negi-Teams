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

### 2026-10-02: 全本文読取の並行化と追記の測定

operationごとのfile読取をhelper内で最大8件並行にした。各operation内のfileは順に読み、directory identityとfile一覧を前後で確認する。workerへ渡す期待値は変更不可のsnapshotで、結果はmain threadが名前順に結合する。第1走査の全workerが終了してから第2走査を始める。失敗時も開始済みworkerの終了を待ち、authority/DBのhandleを閉じる。鍵・署名鎖・SQLite・owner・最後のwrite CASはmain threadで扱う。本文やHMACの検査を省かず、永続cacheも導入していない。8件はhelperごとの上限で、二つのhelperなら合計16件になり得る。

Windows/Node v20.17.0の同じ規模の合成履歴で、200 operation/1,000 stageのprofile全体は7.260秒から2.367秒になった。OS cacheは消去していない。500/1,000 operationの公開benchmarkは次の全試行で`clean`、時間切れ0、exit0だった。

| operation / stage | 最初の監査 | 繰返し1 | 繰返し2 | DB bytes |
| --- | ---: | ---: | ---: | ---: |
| 500 / 2,500 | 5,527ms | 3,146ms | 2,923ms | 11,919,360 |
| 1,000 / 5,000 | 9,591ms | 4,697ms | 5,247ms | 23,826,432 |

前の実装の1,000件初回timeoutという阻害は、この測定では解消した。大量履歴での通常利用全体の性能を満たしたという判定ではない。

`node --import tsx scripts/benchmark-master-conversation-inventory.mjs --writes`は別の1,000 operation fixtureを使い、public append APIの成功ACK後だけ、stageをcreate-onlyで保存してfsyncする。5段階のintent追記はrequestedから順に**13,859 / 10,262 / 9,337 / 7,898 / 7,178ms**、最終監査は`clean`だった。5段階の追記とfile保存の合計は48,572msで、会話切替の応答性に向けた追加改善が必要である。これは合成stageの保存時間であり、実RPCや画面での会話切替時間ではない。

続けて同じDBの二つのMasterにそれぞれ1,000 operationの履歴を用意し、requested、未送信cancelledを二つのhelperへ同時に要求した。intent追記はrequestedが**10,331 / 10,501ms**、cancelledが**7,759 / 7,695ms**。4件とも保存成功、両Masterの最終監査`clean`、exit0だった。helperの同時呼出を確認した測定で、SQLiteのwrite transactionが同時刻に競合した保証はない。失敗/時間切れ時はmutationを再試行せず、確認できたACKだけをfileへ保存する。終了時には成功・失敗にかかわらずこの測定専用の一時fixtureを削除するため、失敗fixtureの保持や復旧の証拠には使わない。

最終の関連36件は成功・失敗0・skip0（43,682.988ms）。上限8件の実重複、二走査の完全終了、worker失敗でも他worker終了までguardを保持、読取中の部分変更、同じbytesのdirectory置換を検証した。これまでの署名・欠落・競合・crash・hot journal試験も含む。独立レビューではこの差分に具体的な正しさ/データ整合性の問題は見つからなかった。

既存authority/起動/通常入力/provider/UIへの接続は引き続き未実施。全履歴を繰り返し読む追記の改善、turn/scheduler監査、journal復旧、owner/2移行、receipt、保持/版移行と前記platform/外部変更の条件を残す。既存Material 3 Expressive画面のCodex「新しい会話」はまだ有効化しない。

### 2026-10-02: Windowsの追記中だけ保護した読取ハンドルを再利用する

既存の一回のappend内で、最初に確認したstage fileとoperation directoryのハンドルを保持する。stageは読取だけを共有し、directoryは削除を共有しない。既存の書込みハンドルや書込み可能なmappingがある場合は保護したopenを拒否し、DBを変更せず保留する。Windowsの共有条件はcloseまで続き、WRITE共有を省くopenは既存の書込みハンドル/mappingと両立せず、DELETE共有を省くと削除・名前変更のopenを許さない（[CreateFileWの公式仕様](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew)）。属性アクセス全体を禁止する仕組みではないため、native stamp・通常path・directory identity・file一覧の前後照合は維持する。

本文cacheは使わない。同じハンドルを先頭へ戻し、append内の三走査すべてで全stage bytesを読んでSHAを照合する。署名鎖・owner・SQLite・最後のwrite CASも従来通り。worker失敗時は全開始済みworkerを待ち、登録済みハンドルすべてを閉じてから戻る。未登録のopenはworker自身が失敗時に閉じる。プロセス終了によるOSの解放も検証した。常駐writer、TSの新しい通信protocol、provider RPCは追加していない。単独audit/lookupと非Windowsの追記は従来のreaderを使う。

保持するstage数とoperation directory数の合計は、helperごとに最大8,192。最初のprotected open前に方式を選び、見積が上限を超える履歴は従来の全件openへ進む。保護の取得失敗を理由に従来方式へ切り替えない。この上限はハンドルの資源上限で、50,000 stageのデータ上限や保存期間を変更しない。複数helper全体で共有する8,192上限ではない。

最終関連41/41成功、失敗・取消・skip0（52,275.7048ms）。追加5件は、三回の全本文読取とopen再利用、書換え/削除/名前変更の拒否、既存writerとfile/section handleを閉じた後も残る書込み可能viewの拒否、worker部分失敗時のjoinと解放、方式選択の境界、実child終了時の解放を検証した。小fixtureは40 file open・8 directory open・120本文読取。失敗時の解放試験では、GC前に全stageの再書込みと全operation directoryの往復renameが成功し、nativeの保護が解除されたことを確認した。GCは完了済みThread/Futureのtracebackが保持する診断用handle数の確認にだけ使う。初期のfocused試験でのerrno判断、診断handle数、注入したreaderの復元漏れによる失敗は別記録に保持し、最終成功へ合算していない。

同じ公開`--writes`測定の1,000 operation/5,000 stageへの追記は次の値になった。OS cacheは消去せず、前回と今回の単一実行を比較した方向の確認である。

| stage | intent ACK | stage保存・fsyncを含む時間 |
| --- | ---: | ---: |
| requested | 5,578ms | 5,584ms |
| old_idle | 5,481ms | 5,485ms |
| start_dispatched | 5,563ms | 5,567ms |
| bound | 5,498ms | 5,502ms |
| completed | 5,563ms | 5,567ms |

5段階合計は前回48,572msから**27,705ms**になり、最終監査は`clean`。同じDBの二つの1,000履歴Masterへの同時helper呼出はrequested **6,044 / 6,087ms**、未送信cancelled **5,897 / 5,962ms**。全4追記を保存し、両Masterの最終監査`clean`・exit0だった。DBは47,689,728 bytes。合成owner/provider identityを使ったpublic append APIの測定であり、SQLiteの同時write競合、実RPC、scheduler/turn、UI、停電の検証やp99保証ではない。27.7秒という保存時間は、通常利用へ接続する前の応答性改善として引き続き扱う。

別の1,000履歴fixtureでPython helperを直接計測した資源診断は、file open 5,000・directory open 1,000・全本文読取15,000・三走査。process handle数は**165 → 最大6,172 → 165**となり、追記後のpublic auditは`clean`だった。診断用hookと事前auditを伴うため、診断の5,532msをpublic APIの性能値へ混ぜない。実8,192上限でのOS資源負荷、50,000 stageでの性能、macOS/Linux/UNCでの新方式を検証したという主張はしない。上限超過時の従来方式には大量履歴で30秒期限に達する可能性が残る。

候補は既存authority/起動/通常入力/provider/UIへ未接続のまま。turn/scheduler索引、明示hot-journal rollback、欠落stage repair、owner/2移行、native receipt intent/解除とbaseline、独立DBを先に確認するprepare、保持/版移行、外部ABAと前記接続条件を維持する。Material 3 ExpressiveのUIは維持し、Codex「新しい会話」はまだ有効化しない。全73要件・Phase0–8の追加進捗であり、全体完了ではない。

最終ソースのPython AST、型検査、build、差分検査も成功。client assetsは`index-CvLJ6iRB.css`/`index-C-cjKz75.js`を維持した。今回の新しいGUI/実機/人の品質受入やCI成功は主張しない。

限定した独立read-onlyレビューでも、具体的な正しさ・データ整合性・handle解放の追加問題は見つからなかった。実8,192負荷と複数helper合計の資源量、上限超過時の性能は前記の接続前条件として残す。
