# Master会話の独立索引候補

NT-067/073の追加部品。`MasterConversationInventory`と固定Python helperを実装した。既存処理には、独立DBが残る場合に旧writerを保留する互換性検査を接続した。索引intentを使う会話authority、起動検査、通常入力、provider RPC、復旧解除、認証済み確認UIの全面接続は次の工程である。全73要件・Phase0–8のゴールは継続中。

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

appendは選択Masterの正確な署名ownerと、呼出前に固定したheadを要求する。新部品のowner/3はPID、nonce、要求hash、cwd hashに加え、Windowsのnative process作成FILETIME、またはLinuxのboot ID＋開始tickを署名する。Pythonを直接起動した親processのPID/作成tokenと一致する必要がある。PIDが同じだけの古いownerやowner/2はappendへ使えない。2026-10-02に新規authority ownerとnative復旧の版判別をowner/3へ接続した。過去owner/2の原文は保持し、署名と保守的なPID終了確認を維持する。stage/receiptの索引intentと既存履歴のbaseline/version移行の全面接続は引き続き必要である。

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
