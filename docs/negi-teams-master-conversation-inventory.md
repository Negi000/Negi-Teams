# Master会話の独立索引と明示移行候補

NT-067/073の追加部品。`MasterConversationInventory`と固定Python helperに、既存stageと復旧receiptの明示移行、および署名済みDBのstandalone hot journalをSQLite自身でrollbackする明示復旧を追加した。2026-10-03には、明示的なserver登録で会話authorityのstage保存・状態照会・owner復旧を索引へ接続した。復旧は署名済みreceipt intentとWindows nativeの正確なdead owner解除を使い、同じ確認IDを読み直せる。通常読取や起動で自動移行・復旧しない。既存処理は独立DBが残る場合に未接続writerを保留する。production caller、起動検査、通常入力、provider RPC、認証済み確認UIへの全面接続は次の工程である。全73要件・Phase0–8のゴールは継続中。

## 保存するもの

既存の署名付き会話段階の外側、authority rootの隣の固定`*.inventory.sqlite3`へ索引を置く。Node 20で使える既存Pythonの標準`sqlite3`を使用し、追加packageは導入しない。鍵や本文をcommand line/environmentへ埋め込まず、最大100KBのstdin要求を一度渡す。

- authorityの正規path、root/masters/鍵file identity、鍵全文SHA-256を署名して固定する。
- 空のMaster directoryだけを明示登録し、directory identityとMaster別の段階数/最終hashを署名する。
- 新規appendする各stageの固定相対path、要求ID、stage、前のentry hash、owner全文hash、原文SHA-256と原文bytesを保存する。entryはdomainを分けたHMACとhash鎖で検査する。
- 既存履歴の移行は、全Masterのstage/receipt原文と署名、path、file identity/stamp、鍵とdirectory identityを固定したpreview proofと確認IDを必要とする。移行entryは実行当時のownerを捏造せず、受け入れた署名baselineのhashへ結び付ける。
- `BEGIN IMMEDIATE`、DELETE journal、`synchronous=FULL`で新しいintentと署名headを同じtransactionへ保存する。成功後だけ、呼出側がstage directory/fileを作成できる。helper自体はstageを作成しない。

SQLiteの設定とprocess exit試験は実電源断の保証ではない。[SQLiteのrollback journalとcommit手順](https://www.sqlite.org/lockingv3.html)に従う保存設定であり、OS・filesystem・deviceの耐久性は別の検証が必要。

## 検査と所有者

読取は`mode=ro`で既存DBだけを開き、初期化・移行・repairを行わない。schema/application ID/version、integrity/FK、全登録Masterの署名head・行数・整数連番範囲・最終entry hashを検査する。選択したMasterの全entry鎖、署名、stage原文・要求・遷移、移行済みreceipt原文と、実filesystemのinventory/本文を二度照合する。通常auditが他Masterの全本文/鎖を検査したという意味ではない。移行確認IDの同一再試行は例外として、全登録Masterの全鎖/本文を検査してから既存の受入記録を返す。

`clean`は選択したMasterの保存整合だけを意味する。`needs_reconciliation`を含む署名済み段階でも、保存が一致すれば`clean`になり得る。idle、scheduler/turnの終端、providerの結果、切替可能、人の承認は別の判定である。

intentまたは移行済み原文が保存されてfileがない場合、`pending`と欠落pathを返し、`lookup`で索引の固定bytesを読み出せる。次のappendは保留する。既存の部分/異なるfileや未登録directory/fileは変更せず保留する。取消stageを後付けしたり、モデル処理を再実行したりしない。receiptも欠落を返せるが、一般stage writerから公開/復元しない。自動復元や人の確認済み復元APIはまだ提供していない。

appendは選択Masterの正確な署名ownerと、呼出前に固定したheadを要求する。新部品のowner/3はPID、nonce、要求hash、cwd hashに加え、Windowsのnative process作成FILETIME、またはLinuxのboot ID＋開始tickを署名する。Pythonを直接起動した親processのPID/作成tokenと一致する必要がある。PIDが同じだけの古いownerやowner/2はappendへ使えない。2026-10-02に新規authority ownerとnative復旧の版判別をowner/3へ接続した。過去owner/2の原文は保持する。既存stage/receiptの明示baseline移行を追加したが、新規stage/receipt intentの通常authorityへの全面接続と旧binaryの排除は引き続き必要である。

Windowsの読取は同じnative handle APIのfile ID・link数・size・作成/更新時刻を前後で照合する。PythonのWindows lstat/fstatが異なるctimeを返したため、両API間のctime比較を廃した。正規directoryのhandleを保持し、DB/fileのreparse/hardlinkを拒否する。選択headを読取後とappend直前に再確認し、全filesystem本文走査をSQLiteのwrite transactionから外した。

process作成tokenの候補実装はWindows/Linuxに限る。macOSのtoken取得は未実装でappendを拒否する。今回の実OS試験はWindowsであり、LinuxのFS/排他/復旧やmacOS互換性の受入は残る。

## 明示的な境界

この独立DBが残る間、stage末尾やoperation folder全体、移行済みreceiptの削除を欠落として検出できる。root/鍵/Master directoryの消失や別identityへの置換も保留する。索引がない既存の非空記録は通常初期化の対象にせず、明示preview/確認IDによる移行だけを許可する。初期化・移行はcreate-onlyで、部分/旧版DBを上書きしない。

DBとauthorityを同時に過去snapshotへ戻す攻撃、同じOS userによる鍵と全保存先の変更、外部writerのABAを防ぐ外部の単調anchorではない。通常の本文改変/欠落検査と区別する。

候補版は従来のstage予算をMaster別・DB全体とも50,000のまま保持し、移行済みreceiptにはMaster別10,000・DB全体50,000の独立した予算を適用する。aggregateはMaster別60,000・DB全体100,000、Master catalogは10,000、DB sizeは約1.5GBを上限として保留する。複数Masterの合計にもそれぞれの全体予算を適用する。receipt追加でstage予算を減らさない。移行中もSQLite page数×page sizeをcommit前に確認し、上限を理由に履歴を切り捨てない。保持/archivalと既存DBの版移行は未実装である。

`-journal/-wal/-shm`がある場合はGET/append/registerを保留する。実transaction途中のexitで残ったjournalも通常読取から回復しない。[明示DB復旧候補](#2026-10-03-署名済みdbの明示hot-journal復旧)は正規DB/journal、期待するproof、全owner不在とOS排他を照合し、SQLite自身へrollbackを委ねる。WAL/SHM、cold/partial/super-journal等の復旧と確認UIは未対応。手動でjournalを削除する実装は提供しない。

既存復旧receiptは明示移行で索引へ原文のまま取り込める。未登録receiptや`.pending-*`は保留する。新規receipt intentをnativeの同じ解除境界で照合し、同じ確認の固定bytesを再利用すること、owner baselineのheadを対象要求/自分のreceiptだけ正規化する接続は未実装である。一般stage repairでreceiptを作成しない。

## 接続前に残る工程

1. 既存stage/receiptの明示移行は候補APIへ追加済み。旧binary/version fence、turn/schedulerのbaseline索引、retention/既存DB版移行と通常authorityへの全面接続を進める。root/鍵作成前の独立DB検査は保持する。
2. 明示DB rollback候補の人間確認と通常経路への接続、未対応journal/部分bootstrapの復旧、欠落stageだけの認証済みpreview/repair、native receipt intent/解除の照合、owner baseline正規化。
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

### 2026-10-02: 旧writerと独立DBの互換性検査

既存のowner/2 writerは索引intentを保存しないため、正しい独立DBが存在する場合も、そのまま会話記録を変更できない。authority rootの隣の固定DB pathと`-journal/-wal/-shm`を`lstat`だけで調べ、何らかのentryが存在する場合やアクセスを確定できない場合は保留する。空・部分DB、sidecarだけ、directory、hardlink、redirected pathも同じ扱いとする。SQLiteで開く操作や内容による自動採用を行わない。DBだけが残りauthorityや鍵が消えた場合は、最初のmkdir・鍵作成より前に止める。

検査はauthorityの準備、owner取得後、stage保存、admission、起動監査、owner解除へ接続した。通常のTaskServiceの予約と返却済みleaseにも、更新の前後で同じ検査を適用する。更新が例外になった場合も後検査を行う。入力と終端観測は最初の非同期検査より前に固定する。providerのprocess起動、初期化、model discovery後、thread/start後、turn/start前にも確認する。Windowsのnative owner解除を直接呼ぶ場合も、同じcanonical Master layoutのDBを調べ、receipt作成・公開・正確なowner削除の前に確認する。

更新・owner解除の前にDBを検出した場合、既存stage・owner・実行枠を照合の証拠として保持する。旧`status()`は読み取り専用の診断として利用できるが、独立DBを含む開始可能判定ではない。owner previewは署名と終了状態の証拠を読めても、DBがあれば`canRelease=false`とする。

**これは互換性の検出であり、検査と書込みを原子的にする共通排他ではない。** 遅い検出では、保存済みreceiptや終端記録、確認済みschedulerの枠解放が既に存在し得る。それらの事実を巻き戻さず、モデルや保存操作を自動再実行しない。thread/start中の出現ではprovider側に空threadが作られた後に準備完了を拒否するため、耐久性のある索引へ未結付けのidentityが残る可能性がある。process停止だけをprovider側の削除や完全な会話復旧と扱わない。

最終の関連6ファイルの試験は**127件中126成功・1スキップ・失敗/取消0（35,441.5502ms）**。スキップはWindows上の非Windows owner preview試験であり、実モデル依存ではない。DB/鍵/authorityの消失、owner fsync後、予約済みlease、起動監査・model discovery・thread/start・dispatch保存中、失敗した予約・終端保存後、native receipt公開後の出現を検証した。保存済みの正確なbytesと枠・終端を確認し、late detectionを無変更の保証へ置き換えない。provider試験は合成Node App Serverで、実Codex/model/Jevを起動していない。native試験の停止済みNode/Python childは終了を待った。

最終Python AST、client/server型検査、build、差分検査は成功。独立した読み取り専用のレビューでは、指摘した予約・lease・provider境界と例外時の後検査を修正した後、追加の具体的な欠陥は見つからなかった。Material 3 Expressiveのclient assetsは`index-CvLJ6iRB.css`/`index-C-cjKz75.js`を維持した。今回の変更を新しいGUI/実機試験やCI成功とは扱わない。

明示DB復旧より先に、全Masterと参加writerが共有するOS排他、旧binaryのversion fence、owner/2からowner/3への移行、stage/receipt intentとbaseline、初回threadの耐久性あるdispatch/identity記録を接続する必要がある。`lstat`の検査間に動くwriterや、検査を持たない旧binaryの排除は未達である。hot journalの回復は[SQLiteのlockingとrollback手順](https://sqlite.org/lockingv3.html)に従い、確認済みproof・全owner不在・共通排他の下でSQLite自身へ委ねる設計が必要で、今回rollback APIを実装したとは扱わない。欠落stage repair、保持/版移行、turn/scheduler全履歴と性能、実provider切替・利用者確認、platform/外部ABA/停電と先行の全残条件を維持する。Codex「新しい会話」の有効化と全73要件・Phase0–8の受入は継続中。

### 2026-10-02: 参加するMaster保存処理の共通OS排他

Windowsのauthority rootごとに、固定sibling `root.storage-guard-v1.lock`を使用する。通常の空・single-link fileであり、競合を解消するために削除しない。`CreateFileW`のshare=0と親directoryのno-delete handleを保持し、helperから直接のNode親へnative handleを移す。helper終了後もNodeが排他を所有し、正確なNode所有processの終了ではOSが解放する。共有条件とhandle transferの根拠は[CreateFileW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew)と[DuplicateHandle](https://learn.microsoft.com/en-us/windows/win32/api/handleapi/nf-handleapi-duplicatehandle)に従う。

handle ticketはstdinだけを使い、直接の親PID・native creation token・canonical path・volume/file ID・種類を照合する。file内へticketを保存しない。正確なcanonical spellingを要求し、driveや親pathの非canonicalな大文字小文字、junctionやredirect、部分file、hardlinkは保留する。Windowsのcase-sensitive directoryでも異なるrootを同じleaseへまとめない。Nodeの同一root内では開始済みの入れ子保存を全て待ち、同一processの別callerは解放を待つ。他processの競合と不明状態ではcallbackを開始せず、callbackを自動再実行しない。読取専用audit/lookupは既存guardだけを開き、欠落root/guardを作らない。読取専用呼出は従来の索引rootにguardが無い場合も保留する。旧writerとの混在を排除する明示的な移行は未達である。

authorityのowner/stage更新と解除、productionの通常予約と返却済みlease、候補inventoryのinitialize/register/append/audit/lookup、native Master owner解除へ接続した。startupとturn/start/binding、Task結果とschedulerのterminal/unknown保存も同じroot排他を使う。モデル応答の待機中にはrootを保持しない。準備完了のsessionとturnEndは保存排他を解放した後に通知する。重なるstartは最初の非同期待機より前に拒否し、後続startが正常な起動processを停止したり、待機中のstopを取り消したりしない。

helperのCLI/importでContextVarが二重化する問題、文字大小を潰して別rootへticketを渡す問題、重複startによるprocess停止を実装と試験で修正した。`DUPLICATE_CLOSE_SOURCE`はBOOLの成否に関係なくsourceを閉じるため、検証済みの親source→guard sourceを両方試み、コピーを保持したまま完了する。native close後にfalseを返す故障注入でも、両sourceの試行と同じNodeからの再取得を確認した。返答消失・部分transfer・release例外はprocess内のregistrationを保留するが、それだけで全native handleが残っているとは保証しない。保存済み事実は巻き戻さず、操作も再送しない。未確定状態の運用上の照合と再起動手順は引き続き必要である。

関連8 test filesは**182件中181成功・1スキップ・失敗/取消0（198,548.3924ms）**。スキップはWindows上の非Windows owner preview試験。実Windowsのcase-sensitive fixture、Node所有process終了、外部helperの排除、未awaitの入れ子保存のjoin、read-only非作成、root/handle差替え拒否、inventory/native recovery/通常受付との結合を確認した。この実行開始後に追加したstartup競合修正は、後続のBrain全ファイル**24/24成功（5,841.9578ms）**で検証し、両実行を一つの最新183件suiteとして合算しない。強制停止のunknownと確認済み中断のfailedを区別するよう誤った試験期待を直した。故障fixtureのUTF-8不足など初期失敗は別logへ保持する。最終Python AST・client/server型検査・build・差分検査は成功。独立read-onlyレビューの具体的な指摘は修正済み。合成Node providerと試験専用childだけを使い、その終了を待った。

これは参加writerの排他で、旧binaryや外部の同一権限processを隔離するsandboxではない。Windowsを今回の対象runtimeとし、Linux/macOSのguardは未対応で保留する。UNC/SUBST/全filesystem・停電での受入も未確認。既存owner/2の独立DB presence gateは維持する。索引intentの通常記録への接続、owner2→3/version fence、stage/receipt intent・baseline・初回thread記録、hot-journal rollback、repair、保持/版移行と性能、実provider/UI切替は未達のまま。Material 3 ExpressiveのUI assets `index-CvLJ6iRB.css`/`index-C-cjKz75.js`は一致し、今回の新しいGUI/実機/人の受入/実Codex/model/Jev/CI成功は主張しない。全73要件・Phase0–8の進捗であり、Codex「新しい会話」と全体受入は継続中。


### 2026-10-02: 新規owner/3とnative process作成tokenの復旧照合

新規のinspection・turn-admission・thread-start ownerは`owner/3`で署名する。既に取得済みのactiveなroot storage guardがnativeで確認した直接のNode親PIDとcreation FILETIMEを使う。`createdAt`やPIDだけからprocessの開始を推定しない。所有nonce、kind、cwd hash、固定要求hash、baseline証拠hashも署名対象として保持する。

共通のTS検証とnative parserはowner/2・owner/3を厳密に判別する。owner/3はprocessIdentityの正確な3フィールド、top-level PIDとの一致、Windowsの正のuint64 tokenまたはLinuxのboot ID＋開始tick形式を要求する。追加・欠落・不正なtokenは保留し、tokenの編集もHMACで検出する。過去owner/2を現在のprocessへ昇格したり、開始tokenを後から補ったりしない。原文の署名・versionを保持し、復旧receiptにも同じ原文ownerを保存する。

Windowsの判定は、query権限と待機権限で開いた同じprocess handleを使う。終了済みまたは存在しないPIDは元ownerの終了を確認する。生存中なら[GetProcessTimes](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes)のcreation FILETIMEを比較し、同じPID＋開始tokenならliveとして保留する。異なるtokenは別processであり、記録されたowner identityの終了を区別する。PIDの一意性は[processの終了まで](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getcurrentprocessid)に限られる。processをsignal/terminateせず、handleはfinallyで閉じる。作成時刻取得・アクセス・待機判定の失敗はunknownとして保持する。

previewとnative解除の両方へ接続した。解除はreceipt公開前と正確なowner削除前に版に応じて再確認し、owner bytes・署名済みreceipt・原文baseline・DB presence gate・root排他を維持する。owner/2には開始tokenが無いため、再利用されたPIDがliveなら従来どおり保留する。Linuxでのowner/3 native診断は開始tokenの比較を実装していないのでunknownとし、PIDだけでlive/deadを補わない。WindowsでLinux identityを読んだ場合もunknown。LinuxのMaster削除は引き続き未対応である。

最終関連9 test filesは**189件中188成功・1スキップ・失敗/取消0（202,725.2583ms）**。スキップはWindows上の非Windows owner preview試験。実際のlive owner/3、終了した試験Node owner、旧owner/2の原文receiptと同じdecisionのretry、署名編集・不正なprocess identity、native query failureとplatform mismatch、通常起動・実行受付・索引候補との形式整合を確認した。PID再利用は、署名済みfixtureに同じ生存PIDと異なる開始tokenを設定して同じnative分岐を検証したもので、実OSがPIDを再利用したという証拠ではない。記録ownerだけを解除し、生存processのnative identityが変わらず、receipt ownerが原文と一致することを確認した。

初回の4 test filesは126件中123成功・2失敗・1スキップ。owner/3なのにtop-level PIDだけを書換え、内側PIDを変更していなかった既存fixtureを修正した。旧PID-onlyの保守的試験はowner/2として保持し、後続の生存ownerは実際のnative開始tokenを使う。focused6成功を経て前記最終suiteを完了し、試験の期待を緩めて不正ownerを採用していない。Python AST・client/server型検査・build・差分検査も成功。独立read-onlyレビューの指摘したfixture2件を修正後、追加の具体的な欠陥は見つからなかった。試験childの終了を待ち、実Codex/model/Jevは起動していない。

これは新規writerと復旧parserのowner版を揃える実装であり、既存stage/turn/scheduler/receiptの索引移行を完成したものではない。owner/3が残った状態でowner/2専用版へrollbackすると保留され、新版の復旧経路を必要とする。旧binaryのversion fence、既存履歴の署名baselineと移行intent、索引intentの通常記録への全面接続、初回threadのdispatch/identity証拠、明示hot-journal rollback/repair、保持/性能と先行の全条件を維持する。Material 3 Expressive client assetsは`index-CvLJ6iRB.css`/`index-C-cjKz75.js`で一致し、新GUI/実機/人の受入/CI成功の確認ではない。Codex「新しい会話」は未有効化で、全73要件・Phase0–8と全体ゴールはACTIVE。

### 2026-10-02: 既存stage/receiptの明示baseline移行

候補APIへ`previewLegacyMigration`と`migrateLegacy`を追加した。previewは既存のauthority/key/root guardを読み、全Masterの原文stageと過去の署名付き復旧receiptを検査する。欠落root/guardを作らず、DB/sidecarが存在すれば保留する。既存guardを用意する工程はpreviewと別に必要である。通常の起動・GET・auditから移行を実行しない。

stageの要求・遷移・前段hash・連続filenameと、receiptの完全なcanonical envelope・署名・owner/2またはowner/3の原文・対象Master/cwd/operation/decisionを照合する。過去receiptのownerについて現在の生存状態を推定しない。全Masterでownerとrecovery writerの不在を要求し、不明なlockを解除しない。部分file、空operation、不明なentry、重複decision、hardlink/reparseはそのまま保留する。署名済みの未完了/unknown stageは事実として保持する。

原文bytesのhash/size、native file identity/stamp、directory identityと完全なfile一覧、authority/keyを繰り返し走査してpreview proofへ固定する。確認IDと正確なproofを受け取った場合だけ、既存DB不在を確認して作成する。入力は最初の非同期待機より前に固定する。全payloadを一括保持せず、原文を一件ずつ再読取してSQLiteへ保存し、commit前にも全snapshotとowner不在を再確認する。entry順はMaster catalogと相対pathの決定順であり、過去の全実行の時系列を復元したものではない。

新規DBは`user_version=2`と署名付き`adoptions`を使う。adoptionはauthority hash、decision、preview proof、全Masterの署名body hashとstage/receipt件数・artifact一覧hashを結合する。移行entry/2はこの受入原文のhashへ結合し、実行当時のowner hashを捏造しない。移行後の新しいstageは従来のevent/1と正確なowner/3を要求する。新しい空Masterの明示登録も既存baselineを書き換えない。既存v1 DBは正確なv1 schemaのままaudit/appendでき、自動upgradeや再移行を行わない。v1専用inventory版へv2 DBを戻すと保留されるが、これだけで全旧binaryの排除を達成したとは扱わない。[user_version](https://www.sqlite.org/pragma.html#pragma_user_version)はアプリ側の版管理として使用する。

既存DBがある同一decision/proofの再試行は、全登録Masterの全署名鎖・本文とfilesystemを読み取り専用で検査し、保存済みの受入結果を返す。別decision/proofや変更された他Master、欠落artifact、部分DB/journalは保留する。importを再送したり、DBを上書きしたりしない。commit前の実process exitでは残ったDB/journalを保存し、commit後の返答消失では同一確認の読取だけで結果を確認する。SQLiteの[transaction](https://www.sqlite.org/lang_transaction.html)を用い、独自にhot journalを削除しない。認証済み明示rollback復旧は引き続き未実装である。

書込み移行helperは経過時間だけで強制停止せず、実際の終了を待つ。通常APIの30秒、読取専用previewの15分とは区別する。これは処理が必ず終了する保証ではなく、helperが終了しない間はroot guardも保持される。進捗/取消/中断後の確認UIは未接続である。出力過大などprotocol異常の保留は残し、その失敗から自動的にimportやDB修復を再実行しない。

stage/receiptの容量は前記の独立した予算を用い、物理DB容量もcommit前に確認する。容量を理由に原本を切り捨てない。receipt件数はHMACで認証したadoptionのMaster別summaryから取り、冗長な未署名`events.path`列でstage/receiptの予算を分類しない。通常auditの他Master全本文検査を省く範囲と、全Masterの容量集計に使用する認証済み件数を区別する。

移行proofは、初めて受け入れた時点に存在する署名済み履歴を固定する。受入前に既に失われていた完全なoperationの存在を証明する外部記録はなく、履歴の過去からの完全性はUnknownである。DB/authorityの同時rollback、同権限外部writer/ABAに対する外部単調anchorにもならない。このAPIは信頼する内部serverの明示decisionであり、認証済み人間確認UI/HTTP routeへはまだ公開していない。

最終関連5 test filesは**153件中152成功・1スキップ・失敗/取消0（210,825.9579ms、exit0）**。スキップはWindows上の非Windows owner preview試験。全Master/空登録/旧新版receipt/未完了事実、proofや署名の変更、欠落/部分file、競合decision、入力固定、他Master改変、実process exit前後、35秒の固定TS→Python helper終了待ち、v1 audit/appendと容量の縮小境界を確認した。実50,000 stage、最大receipt/物理容量での性能、実停電、全platformの受入は未検証である。Python AST3件・client/server型検査・build・差分検査も成功。合成fixtureと所有するNode/Python試験childを使い、開始したchildの終了を待った。

独立read-onlyレビューの移行helperを30秒でkillする問題と、他Masterの未署名path列で容量を分類する問題を修正し、最後のレビューに追加の具体的指摘はなかった。初回11/11、途中66/66、修正前の150件中149成功/1スキップ・152件中151成功/1スキップ、focused runsは別logとして保持し、最終suiteへ合算しない。追加容量試験の初期1失敗は、baseline容量で先に保留したfixtureを、移行後の通常追記を含むものへ修正した。最後のfocused6件と前記153件suiteは修正後の結果である。実Codex/model/Jev、今回の新GUI/実機/人の受入、CI成功の確認ではない。最終buildのMaterial 3 Expressive assetsは`index-CvLJ6iRB.css`/`index-C-cjKz75.js`で一致した。

turn/scheduler baseline、旧binary/version fence、索引intentと通常authority/startup/予約/providerの全面接続、新規receipt intentとnative解除/owner baseline正規化、初回threadとreturned identity/旧runtime静止、明示SQLite復旧・認証済みstage repair・保持/版移行・大規模性能を継続する。移行済みDBでも未接続の通常writerは保留し、移行成功からproviderを起動しない。Material 3 Expressiveは既存の各画面に実装済みで、認証と保存APIが整った後にPC/スマホ別の確認導線へ接続する。実機safe-area/keyboardと人の受入を含む先行の全条件、全73要件・Phase0–8と全体ゴールはACTIVE。

### 2026-10-03: 署名済みDBの明示hot journal復旧

`previewDatabaseRecovery`は元のDB/journalを変更せず、同じvolumeの一時cloneでSQLiteのrollback結果を検査する。standalone hot rollback headerだけを対象にし、WAL/SHM、cold/zero/partial journal、super-journal footer、hardlink/reparse、不明なowner/recovery writerを保留する。参加するwriterの共通root guard、authority/key/Master directoryのidentityを保持し、original DB leafも削除共有しないnative handleで固定する。外部writerの排除やABAの完全な防止を意味しない。

cloneのschema・authority HMAC・全登録Masterの署名head・全entry鎖・stage/receipt原文・遷移・filesystem全本文/一覧を検査する。全体検証はcloneごとに前後2回行い、その間にMaster別の全鎖と二度のfilesystem走査を行う。最後に全headとadoptionを同じsnapshotへ照合する。Masterごとに全DBを再検証する方式を除いた。本文を一括cacheせず、固定path/hash/sizeとfilesystem証拠を集める。元のDB/journalとauthorityを再読取し、同じ候補を二度得た場合だけ固定proof、source/復旧後SHA、Master/artifact/欠落件数を返す。

`recoverDatabase`は呼出前に固定したUUID decisionと正確なproofを要求する。authority hash、元DB/journalのhash/identity/stamp、全filesystem proofと復旧結果をHMAC署名したintentへ結合する。最初は`*.recoveries.pending` directory内でcreate-onlyのstaged fileを書き、`FlushFileBuffers`後にfileとdirectoryを同volumeの`MoveFileExW(..., MOVEFILE_WRITE_THROUGH)`で上書きなしに公開する。既存ledgerへの次のintent/doneもstaged fileと同じ公開手順を使う。**intentの公開に成功する前にoriginalのSQLite rollbackを開始しない。** [MicrosoftのMoveFileExW仕様](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw)に沿うnative公開であり、実電源断やdevice cacheの保証は未検証である。

originalは置換せず、`mode=rw`の既存SQLite接続の最初のschema読取へ[SQLiteのhot journal回復](https://www.sqlite.org/lockingv3.html)を委ねる。独自のjournal削除・page書戻しは行わない。SQLiteがjournalを処理した後、accepted targetと同じDB SHA/identity、全Master/本文/filesystem、owner不在を再照合して署名doneを公開する。欠落artifactは件数として保持し、復旧してもstage/receipt fileは作成しない。

intent後、rollback後、done後に返答が消えても同じdecision/proofで照会する。途中までpageが戻ったDBは、同じDB identityと完全に同じjournalのcloneが元と同じ署名済みtargetへ到達する場合だけ再開できる。done済み照会は後のowner/journalへ触れず過去の署名結果だけを返す。別確認や別proof、partial/未知/HMAC不一致のrecordは保留する。staged directory/fileは消さず手動照合の対象にする。ledgerまたはstaged siblingだけが残ってもbootstrap・legacy TS/native writerを保留する。

absenceは`lstat`の`FileNotFoundError`だけで判定し、アクセス拒否・invalid path・他のOS errorを不在へ変換しない。ledger、journal/WAL/SHM、ownerの全判定に適用する。[Pythonのexists系APIは権限不足でfalseを返し得る](https://docs.python.org/3/library/os.path.html#os.path.exists)ため、そのboolを復旧の認可条件には使わない。

DBの約1.5GB予算とjournalの予算を分ける。[journal形式](https://sqlite.org/fileformat.html#the_rollback_journal)のpage bytes、8-byte record、sector header/境界paddingに基づき、headerの元page数・page size・sector sizeから上限を検査する。native sizeも64-bitで比較し、streaming read/copyとclone用の空き容量検査を行う。正常journalはDB容量を超え得る。DB/journal原文を切り詰めない。復旧記録はdecision最大10,000、record最大16KBで、満杯なら保留する。

復旧とDB previewのhelperは経過時間だけではkillせず、実際のcloseとclone cleanupを待ってroot guardを解放する。通常APIは30秒、legacy migration previewは15分を維持する。helperの不終了、protocol異常による停止、OS crash後に残る私的cloneの照合/安全な掃除、進捗/取消UIは残る条件である。

最終関連6 test filesは**171件中170成功・1スキップ・失敗/取消0（155,907.6142ms、actual exit0）**。OS条件の1スキップを含む。実SQLite 3.45.3のhot journal、2 Master/10署名stageのrollback、実process exitのintent/rollback/done前後、構成した途中page状態、別Master改変/欠落、stale proof/競合/入力固定、unknown/partial record、危険なpath、staged namespace公開途中のexit、アクセス拒否/invalid statを確認した。2/66 Masterでもcloneごとに全体検証2回、縮小したDB予算より大きい正常journal、実35秒遅延の書込み終了待ち、遅延previewのdeadline未設定/cleanupも確認した。最大容量/件数・実停電・native pager途中の強制停止を検証した意味ではない。

独立read-onlyレビューで指摘された名前空間公開、journal予算、preview強制停止、Master別の反復全DB検証、曖昧な不在判定を修正した。途中11/11やfocused runsは別logで保持し、最終171件へ合算しない。Python AST、client/server型検査、buildが成功。新APIはtrusted-server候補であり、認証済み人間確認UI/HTTP、通常authority/provider起動、新規receipt intent/解除とowner baseline、turn/scheduler/初回thread、repair/保持/版移行は継続中。全73要件・Phase0–8とゴールはACTIVE。

## 2026-10-03: 会話stage保存と状態照会の索引接続

既存`MasterConversationAuthority.start/status`に、server内部の明示登録`stageStorage: "indexed"`を追加した。登録は固定root/Masterの既存索引だけを使い、missing root/guard/key/DBを作り直さない。既定はlegacyであり、productionのTaskService/Brain/UIはまだindexed登録を使用しない。通常turn予約・provider起動・native owner解除は既存の互換gateで引き続き保留する。

1. Windows共通root guard内で既存署名DBとauthorityを照合し、要求・cwd・直接Node親の作成tokenへ束縛したowner/3をcreate-onlyでfsyncする。
2. ownerの書込みhandleを閉じる。root guardは維持し、固定Python helperのWRITE共有を拒否するowner読取と両立させる。
3. 各stageの原文を一度署名し、現在の署名headと正確なowner全文SHA-256を持つintentをDBへcommitする。最初のoperation directoryも、このACKを受け取った後にだけ作成する。
4. 同じ原文をcreate-onlyでfileへfsyncし、再監査が`clean`であることを確認してから次へ進む。RPCを行う信頼されたcallbackは、直前の`markDispatched`の成功を待つ契約を維持する。
5. 最後にも保存整合とowner identity/bytesを照合し、このlive ownerだけを除去する。不確かなACK・部分file・欠落はownerを保持し、新しいdispatch/append/取消の後付けを拒否する。

`latestStage(requestId)`は全認証済みstageから要求を再構成し、末尾の固定path・原文・hashを返す。通常監査と同じ署名head/鎖/HMAC/遷移/原文検査とfilesystem二重走査を行う読み取り専用APIである。`status`はroot guard内でその結果を前後二度比較し、同じ鍵のHMACとownerを照合する。indexed intentが未materialize、末尾fileが消失、operation全体が消失した場合も要求と既知identityを失わず、`needs_reconciliation`と保持状態を返す。改変やauthority消失は保留し、未登録のUUIDだけを不存在と扱う。読取からfile復元・モデル再実行・owner解除は行わない。

新規11件の単独試験は11成功・失敗/取消/skip0（120,924.8735ms、actual exit0）。5段階のDB先行順序、同一完了要求のcallback再実行0、ACK消失、末尾/operation削除、原文改変、受入baselineへの追記、dispatch前後の失敗、missing root/key/DB、owner全文差替え、実Node childのdispatch intent後exit27を確認した。実child終了後のstatusは要求とownerを保持し、native復旧の`canRelease`はfalseだった。合成identityと試験専用childを使い、実provider/model/Jevは0である。最終関連7 filesは**182件中181成功・OS条件1スキップ・失敗/取消0（172,789.2133ms、actual exit0）**。単独集合と合算しない。Python AST4、型検査、build成功。実行したchildは終了を待った。

独立read-onlyレビューは今回の4実装/test filesに重大な具体的指摘なし。small fixtureの5段階保存と同一ID再照会の初回focused測定は14,886.1116msだったが、複数の全監査とhelper起動を含む試験時間であり、実RPC/UI latencyや大規模履歴の受入性能ではない。通常入力へこの完全走査を接続しない。参加writerのroot guard内に限る保証であり、旧binary/version fence、外部同権限processのABA、native receipt intent/解除/owner baseline、turn/scheduler、初回thread/戻りidentity/旧runtime静止、認証済み確認UI、保持/版移行/性能、実停電/UNC/Linux/実機の条件は継続する。Codex「新しい会話」は未有効化、全73要件・Phase0–8とゴールはACTIVE。

## 2026-10-03: 復旧receipt intentと正確なowner解除

trusted server内部の明示`recoveryContext: {turnRoot, schedulerPath}`登録に限り、`appendRecoveryIntent`・`recoveryIntent`・`releaseRecoveryIntent`を追加した。現在対象は索引に固定された`thread-start`要求だけで、inspection/admissionは保留する。登録を最初のawait前に固定し、receipt原文・正確なowner全文SHA・signed head・登録contextのSHAを新しい署名event/3へ結び付ける。DB schema/versionは変更せず、stage event/1・既存移行event/2と受入baselineを保持する。live receiptの容量集計も署名headerを認証し、他Masterの未署名pathからstage使用数を減らせない。

最初のrecoveries directory/fileより先に、receipt原文と署名headを同一FULL transactionへcommitする。現在の署名owner、native process作成tokenの終了、索引の要求/cwd、対象Masterのturn/schedulerの終端状態とowner baselineを固定Node verifierで再検査する。原文HMACだけで現在のproofを承認しない。固定verifierはsource TSまたはbuild済みJSを読み、書込み・provider呼出しを行わない。missing root/guard/key/DBを自動作成しない。

Windows native公開は、保存済みの同じUUID decisionと同じ原文だけを使用する。pending fileはその原文の正確なprefixのみ許可し、nativeで開いたhandleのbytesをtruncate前に再照合する。file flush、上書きなしのwrite-through move、公開後の選択Master索引の全監査と現在proof再検査を通してから、読み取った正確なdead owner handleだけを解除する。解除後もfresh proofと最終DB/FS監査、owner不在を確認する。`ownerReleased: true`でも`operationComplete: false`であり、providerの不明結果を完了へ変えない。

共通root guardに加え、`FileScheduler`全writerと同じ固定`.lock`をnative CREATE_NEW/share0/DELETE_ON_CLOSEで取得する。既存の正規parentだけをpinし、他writerのlockを待たず保持したまま保留する。最終proofからDB commit、native解除後のproof・最終監査までhandleを保持し、scheduler更新の競合窓を閉じた。handleのcloseに対応する削除条件は[Microsoft CreateFileWの仕様](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew)に従う。参加しない旧binary・同権限writerによるturn/rootの変更やABAを防ぐ保証は別のgateである。

intent commit・部分書込み・receipt公開・owner解除後の返答消失は、`recoveryIntent`で同じdecisionの既知原文を照会する。別decisionやproof、未知pending、prefix不一致、receipt改変は保留する。owner不在の既知完了receiptは保存済みACKだけを返し、その後のscheduler状態へ復旧を再実行しない。owner不在でreceiptが欠ける場合は復元しない。native releaseには経過時間だけのhelper killを設けず、実際の終了を待つ。未終了helperの進捗/取消・手動照合UIは残る。

最終関連8 test filesは**200件中199成功・OS条件1スキップ・失敗/取消0（664,082.5678ms、actual exit0）**。新規18ケースにはintent/部分書込み/公開/解除後の実process exitと同一decision、移行baseline、原文/prefix/HMAC/live identity、未署名path容量、35秒終了待ち、現在proofの鮮度、verifier return直後のappend/release競合、foreign lock/context/未対応kindを含む。初期15/15（304,214.2679ms）はscheduler競合修正前、focused5成功/13 name-filter skip（97,986.4787ms）は修正後の別集合で、最終suiteと合算しない。独立read-only再レビューで参加scheduler競合の閉鎖を確認し、追加の具体的blockerはなかった。Python AST5・型検査・build・mjs構文・差分検査成功。compiled fallbackはmodule読込と不存在authorityのread-only保留/actual exit1を確認し、compiled側の実復旧全経路試験ではない。開始した試験childは終了を待った。実provider/model/Jev/新GUI/実機/人の受入/CI成功を確認した結果ではない。最大履歴/実停電/UNC/Linuxは未検証。

通常`MasterConversationAuthority.ownerRecovery/releaseOwner`とlegacy native CLIは独立DBがある場合の保留を維持する。今回の登録/APIをproduction caller・HTTP・認証済み人間確認UIへ接続していない。UUID/proofと内部署名は人間の認証済み承認そのものではない。通常owner baselineの正規化、turn/schedulerの索引baseline、参加version/旧binary fence、初回thread・戻りidentity・旧runtime静止、repair/保持/版移行/大規模性能、実停電/UNC/Linux/実機safe-area/keyboard等の先行条件を継続する。実provider/model/Jev/新GUI/人の受入/CI成功を示す変更ではない。Material 3 Expressive assetsは維持し、全73要件・Phase0–8とゴールはACTIVE。

## 2026-10-03: 明示登録したauthorityのowner復旧と同じ確認IDの照会

`stageStorage: "indexed"`をserver内部で登録した`MasterConversationAuthority`の`ownerRecovery/releaseOwner`を、既存の索引receipt/native解除へ接続した。既定のlegacy登録とlegacy CLIはDB presenceで引き続き保留する。登録root/turnRoot/Masterとscheduler pathを固定し、元のoptionsやscheduler pathの変更から別の保存先へ復旧を向けない。root/guard/key/DBがない場合も作成せず保留する。production callerはindexed登録をまだ使用していない。

対象は`thread-start`、`inspection`、`turn-admission`の3種類。正規cwdのUTF8 hashを署名ownerへ照合し、thread-startではさらに索引にある元の要求のcwd/hashを要求する。現在のturn/scheduler/会話証拠とnative process作成tokenの終了を再検査する。inspectionの未解決会話や、admissionの対象turn/claimが既に存在する場合は解除しない。解除はownerだけに限定し、`operationComplete: false`を維持する。結果不明のthread-startは`needs_reconciliation`のままであり、providerを再実行しない。

`ownerRecoveryIntent(ownerId)`は全認証済み索引から正確なownerの元receiptと`live/adopted`の由来を読み取る。intent commitの返答が消えた場合、previewは保存済み`recoveryDecisionId`を返す。明示再開はそのUUID・proof・元bytesだけを使い、別の確認IDや現在時刻でreceiptを作り直さない。未知ACKはその呼出しでは保留し、自動再試行しない。receiptの部分書込み・公開後の実process exitでも、同じ保存済み確認を再開できる。

`ownerRecoveryStatus(cwd, decisionId)`は記録を読み、モデルやnative解除を再実行しない。次の状態を返す。

| state | 保存された事実と扱い |
| --- | --- |
| `intent_saved` | この確認のintentだけが保存済みで、final receiptはまだない。owner不在でも完了と扱わない |
| `receipt_published` | 正確なreceiptを公開済みで、元ownerが残る。明示再開で現在proofを再確認する |
| `owner_released` | 正確なreceiptを公開済みで、ownerは存在しない。保存済みACKだけを返す |
| `different_owner` | 別ownerが存在する。過去の確認で新しいownerを解除しない |
| `storage_pending` | この確認以外のstage/receiptが欠ける。復旧を保留し、欠落を補修しない |

previewもこの確認の欠落と別記録の欠落を分ける。own receiptのpendingだけは独立索引の全認証後に照合できるが、別の欠落・改変・stale proofを解除可能へ正規化しない。reviewで見つかった「今のreceiptは公開済み、過去receiptが欠落」の`intent_saved`誤分類は、preview/statusとも`storage_pending`へ修正した。移行で受け入れた`adopted` receiptは、owner不在の過去ACKの読取だけに使い、native解除の新しい承認として使わない。

### 今回の検証と残る接続

最終関連7 test filesは**148件中147成功・OS条件1スキップ・失敗/取消0（585,547.7888ms、actual exit0）**。実行中の15 runtime/test filesのhashは不変だった。Python AST5・固定mjs構文・client/server型検査・build・差分検査成功。開始した試験childは終了を待った。新規14ケースを含む最終集合であり、途中focused集合と合算しない。client assetsは`index-CvLJ6iRB.css`/`index-C-cjKz75.js`と一致する。

新規14ケースは3種類の実Node dead owner、intent/native ACK消失、部分書込み/公開直後の実Python exit、移行済み過去ACK、後の別owner、root/key/DB欠落、foreign scheduler lock、stale proof、別cwd、登録元の変更、admission targetの後発作成、別receipt欠落を確認する。最後の欠落ケースの公開済み状態と復元は試験用に構成し、製品のrepair APIの証拠とは扱わない。合成provider identityと一時filesystemを使い、開始したchildは実際の終了を待つ。途中のfocused集合は最終suiteと合算しない。

独立read-onlyレビューの状態誤分類を修正し、再レビューで追加の具体的blockerはなかった。参加writerのroot/scheduler guard内に限る保証で、旧binary/version fenceや同権限の非参加writer ABAは継続する。通常turn予約・provider起動・起動監査は既存の互換gateを維持する。turn/schedulerの索引baseline、通常owner取得時のbaseline登録、初回thread/root/config、戻りcwd/model/provider/settings、旧tools/approval/server requests/waiters静止、HTTP/認証済み人間確認UI、repair/保持/版移行/性能、実停電/UNC/Linuxは次の工程である。Codex「新しい会話」は未有効化。Material 3 Expressiveの既存UIを維持し、実機safe-area/keyboardと人間受入は未確認。全73要件・Phase0–8と全体ゴールはACTIVE。
