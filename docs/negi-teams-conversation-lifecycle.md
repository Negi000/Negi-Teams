# 会話切替と統括のライフサイクル

2026-10-03更新。Material 3 Expressiveの会話切替を、実際の起動・終了状態に合わせる。現在の有効化範囲は、保存済みsetupを使うindexed通常起動の単一Codex統括である。

## 2026-10-03追加: 実Codexで空会話を保存する

実際にインストールされているCodex CLI 0.159.2では、入力前の`thread/start`が成功しても、履歴を持たないthreadはprocess終了後に再開できなかった。独立した一時cwdの診断で、終了後のreadは`thread not loaded`、同じIDのresumeは`no rollout found`を返した。合成providerだけの先行検証からは分からなかった製品不具合である。

常駐統括の初回作成と明示した切替では、返されたcwd/model/provider/effort/policy/idleを先に照合し、固定のdeveloper contextを`thread/inject_items`で一度だけ保存する。その空ACKとread/terminal turn集合の一致を確認するまで、新しいidentityを呼出元へ返さない。[公式App Server文書](https://learn.chatgpt.com/docs/app-server)も、このAPIによる履歴保存はuser turnを開始しないことを説明している。モデル処理やユーザー入力の代替は行わない。

保存するcontextは`negi-resident-history/1`の固定文であり、アプリによる会話初期化であることと、明示された入力まで作業を待つことを指定する。ユーザーのメッセージでもモデルの回答でもない。後続の明示入力ではモデルのcontextに含まれる。UIへ架空の発言として表示しない。

- ACK喪失、不正ACK、外部turn、ephemeralな履歴、照合中の状態変化は結果不明として保留する。inject/start/inputを自動で繰り返さない。切替中は元の確認済みidentityを保持する。
- bootstrapを含む設定hashを新規会話へ保存する。保存済みの旧版は、従来の完全な設定hashが一致する場合だけそのままresumeする。旧recordや履歴を書き換えず、resumeでinjectしない。
- 旧版からの次の明示切替で新しいhashを記録する。完了保存後だけ現在のhashを更新する。異なるモデル/effort/設定は依然として拒否する。
- 旧版の空threadが既に再開不能な場合は保留を維持する。新しいthreadを作って記録を回避する復旧は追加していない。

関連79件の試験は互換修正前に成功し、その後の旧版互換2件と型検査・ビルドも成功した。前後の試験を最終ソースの全件81件とは数えない。実CLIと通常サーバー/M3画面の最新の証拠は[実装状況](negi-teams-implementation-status.md)に記す。実モデルを使う作業全体、外部clientとの同時操作、Job/broker、実機と人間受入、未知の作成結果の汎用修復は引き続き残る。

## 2026-10-03: 常駐Codexの会話を保存・再開する

- 初回の空threadを署名付き要求と索引へ保存する。正常な再起動では保存済みの同じthreadを照合し、`thread/resume`で再開する。表示ログのsession IDをauthorityとして採用しない。
- `cwd/model/provider/effort/settings`、approval policy、read-only/network無効、threadの状態とterminal turn集合を照合する。設定・外部turn・未解決claim・残存owner・不足した記録は開始を保留する。入力の自動再送はない。
- idle時の「新しい会話」はM3確認dialogで空の文脈へ切り替える意思を確認し、UUIDと旧threadを同じタブへ保存してから送る。旧threadが変わった確認は拒否する。通常の切替は同じApp Server内で行う。
- Master ownerを保持し、各段階の保存だけ共有root guardを取得する。provider待機中も別Taskの保存は進められる。同じMasterの入力と切替は同時に受理しない。dispatch intentを永続化してからRPCを呼び、完了の保存後だけ表示境界・使用量を切り替える。
- 切断、timeout、provider戻り値の不一致、保存結果不明は同じ要求の照合待ちへ残す。status照会と同じUUIDの重複要求で再作成しない。切替失敗は所有する接続を終了し、元の記録を保持する。
- 要求IDは保存先の登録SHAとMasterへ束縛する。再接続は同じ要求の状態を読む。通常統括が起動できない場合も、`/storage`の「会話の作成結果」で保持した要求を認証付きGETにより確認できる。この画面はproviderを起動しない。第一stage前の署名済みownerも不明な結果として保持する。
- best-effortな表示ログへserver-owned thread IDを付け、現在のthreadの表示だけを復元する。完全なseq履歴だけが境界の不存在を示せる。切れた・欠落・重複したログは不存在の証明に使わず、現在の履歴を消す境界を追加しない。表示ログはprovider authorityではない。

既定legacy・未登録の構成はCodex切替を有効にしない。過去のturnに署名済み初回thread/chainがない場合は移行の照合を保留し、新しい空threadで回避しない。外部の同権限provider clientや別serverによる同じthreadの同時操作、Job/broker終了の保証、unknown turnやownerの汎用修復、実モデルの作業全体・実機・人間受入、10,000件規模の性能と保持/移行は残る条件である。全Phaseの完成ではない。

実装・合成試験・ブラウザー確認の最新結果は[実装状況](negi-teams-implementation-status.md)へ記録する。以下の節は追加時点の履歴であり、indexed通常起動が未接続という過去の状態は上記の限定接続により更新された。

## 先行実装の記録

最新の候補実装では、server内部で`stageStorage: "indexed"`を明示登録したauthorityのowner preview・解除・保存済み確認IDの照会まで索引へ接続した。[owner復旧の方式と検証](negi-teams-master-conversation-inventory.md#2026-10-03-明示登録したauthorityのowner復旧と同じ確認idの照会)。3種類のownerを対象に、元receipt/UUID/proofを再利用し、不明なACK・別owner・別記録の欠落を保留する。owner解除はprovider操作の完了ではない。既定legacy、通常入力/起動/providerの互換gateとCodex新規会話の拒否は維持する。production caller・HTTP・認証済み人間確認UIはまだ接続していない。これらの確認画面はauthority/APIの受入後に既存のMaterial 3 PC/スマホ導線へ統合する。

## 実装した範囲

- Claude/Geminiの切替中は新しい切替、入力、担当からの配送、回答を開始しない。起動前のログ読取も開始状態として保護する。
- サーバ終了の要求は取り消さない。進行中の初回起動・切替・起動完了を待ち、終了後の再起動を防ぐ。同時の同じbrainへの停止を一つにまとめる。
- 旧brainの停止とイベント処理の終了を確認してから、残っている質問・承認を破棄として記録する。新規起動が失敗しても旧質問の回答ボタンは復活しない。会話境界より前の未回答IDは持ち越さない。
- 新しいbrainの起動を確認してから、使用量と表示を切り替える。`cleared`は新しいsessionイベントより先に記録する。起動失敗は`cleared`を出さず、使用量と元の表示を保持し、自動で起動し直さない。
- 旧brainから遅れて届くイベントは新しい会話へ適用しない。同世代の終了後の質問破棄は受け取る。表示通知の例外で既知の切替やbrainの所有権を失わず、snapshotから復元できる。
- Codexではproviderのturn完了に加えて、受理済みの登録ツールがすべて終了するまで、統括の実行枠と実行中表示を保持する。重複callは一つの処理を待つ。時間切れ、接続断、待機中の終端状態・本文変更は照合待ちとし、遅い完了で解除・再送しない。

ChatLogは従来のbest-effortな表示記録である。今回のフラグやPromiseは一つのMasterSession内の競合を扱い、複数サーバ、クラッシュ後の切替要求、provider側のthread作成の結果不明を照合する永続authorityではない。停止の成功もbackendの停止契約の範囲であり、外部brokerの全子プロセス終了を証明したものではない。

## Codexの新しい会話に残る条件

同じ常駐App Serverで、入力を送らずに新しいthreadを作る方式を採る予定。正常な会話切替ではprocessを置換しないため、process tree終了の証明を前提にせず進められる。ただし、公開する前に以下を一緒に接続する必要がある。

1. 旧turnの永続的な終端証拠、登録ツール、approval、server request、waiterの終了、およびMasterのactive/unknown claimがないことの照合。
2. UUID要求IDとMasterごとの排他。`requested → old_idle → start_dispatched → bound → completed`の記録を保存し、RPCより前にdispatch intentをfsyncする。
3. 新旧thread IDの相違、cwd/model/provider/settingsの固定。threadとturnの状態を分離する。
4. timeout・切断・失われた応答を照合待ちに残す。同じ要求の状態を返し、別IDで自動的に再試行しない。
5. 起動前に未完了の切替記録とrunning/needs_reconciliation claimを照合する。壊れた証拠を新しい会話で回避しない。
6. 永続的な完了後だけ、要求IDと新旧threadを持つ表示境界を通知する。再接続で状態を照会し、結果不明なら会話・使用量を保持する。
7. 設定admissionを一か所で取得する。既存の非再入writerを二重取得しない。shutdown/crash/transport喪失にはprocess containmentと別の照合が必要である。

`MasterSession.newConversation()`とMaterial UIはCodexの切替を引き続き拒否する。今回の登録ツール待機を、上記の全条件の実装完了へ換算しない。

## 2026-10-02追加: 永続要求の候補と読み取り専用の起動検査

Material 3の会話切替へ接続する前の基盤を追加した。現在の接続範囲は以下のとおり。

| 範囲 | 現在の状態 |
| --- | --- |
| 通常の統括入力 | fsync済みのrequest全文のSHA-256とMaster IDをschedulerのsubmitへ束縛する。configuration admissionは従来どおり一回。会話writer・全履歴監査は入力へ接続しない |
| Codex起動前 | provider processのlaunch前に読み取り専用で検査する。未完了・結果不明・孤立・不一致のMaster記録、対象Masterの残留ownerや未完了の候補切替記録は保留する。検査ではkey、journal、lockを作らず、修復・解除・再送しない |
| 切替の候補authority | 専用keyによるHMAC、連続した段階と前段hash、UUID要求、新旧threadとmodel/provider/settingsの固定、RPC直前のfsync intent、同じ要求の状態読取、Masterごとの排他を実装した。`start`/`admitTurn`/writerを使う`assertIdle`は本番RPC・UI・通常入力へ未接続 |
| Codex「新しい会話」 | API・UIは引き続き拒否する。新規threadの実作成、初回threadの永続記録、再接続照会、表示境界の通知は未実装 |

新しいMaster記録は、requestの担当IDや本文・日時などのbytesが変わると、別Masterとして読み飛ばさず保留する。旧記録は所有者を証明するbindingを持たないため、Astra/readでMasterのUUID形式を使った未解決記録を全Masterで保留する。通常のSol Taskは同じID形式を使えてもMasterとは分類しない。旧Astra/readの通常workが同じIDを使った場合の曖昧性は移行条件として残る。起動監査の前後でauthorityのディレクトリ・inventory・key・段階とscheduler/turn証拠を再確認し、検査中の変更も保留する。監査待ちのstop後にprocessをlaunchしない。

2026-10-03の追加: server内部で`stageStorage: "indexed"`を明示登録した候補authorityは、`start`の各stageと`status`を独立索引へ接続した。段階intentをDBへcommitしてから原文fileを作り、ACK消失・欠落・改変は再実行せず照合待ちに保持する。production callerはこの登録をまだ使用せず、通常入力・provider起動・native owner解除の互換gateは保留を維持する。既定のlegacy登録を索引登録へ自動変更しない。詳細と検証は[索引接続の記録](negi-teams-master-conversation-inventory.md#2026-10-03-会話stage保存と状態照会の索引接続)を参照する。

### 候補writerを有効にする前の必須条件

- 署名付きinventory/checkpointと増分検査、保持・移行の規則。段階単体の署名ではoperationディレクトリ全体の削除を検知できない。現行の完全走査は10,000件上限を持つ。独立監査では短い終端記録500件でも約8.5秒を要したため、通常入力へ使わない。起動監査も履歴件数に比例する。500/1,000件の性能検証は未完了。
- ownerへ処理種別・要求・期待する証拠を束縛し、PID再利用・正確なファイル・journal・schedulerを照合する明示的な復旧。この節の追加時点では候補ownerはnonce/PIDのみだった。後続の限定した復旧は次節に記す。死んだPIDだけで解除・自動再試行しない。読み取り専用の本番起動検査自体はこのownerを作らない。
- 実App Serverの初回threadと切替を同じ永続authorityへ接続し、cwdを含む戻り値、現在のthread・設定、登録ツール・approval・server request・waiterの静止を照合する。通常入力と切替の排他を同時に有効化する。
- 永続的な完了後だけ要求IDと新旧threadを含む表示境界を通知し、再接続で同じIDを照会する。shutdown/crash/transport喪失時のcontainment、部分marker・混在版・外部書換え/ABA・停電・Linux/UNC実filesystemの条件も残る。

### 今回の検証

- 最終のauthority/Master admission/Brain/scheduler関連62/62成功（28769.3316ms、exit0）。別の会話表示12/12成功（14966.0021ms、exit0）。集合は合算せず、過去の全件試験を最終ソースの全件検証とは扱わない。最後の変更は上部コメントだけ。最終の型検査・ビルド成功。
- 実一時filesystemで署名・同じ要求の再読取・異なる条件の拒否・lost ACK・並行候補要求・部分/変更/削除段階・hardlink/junction・担当ID変更・旧未解決記録・別Master・起動前保留・stop中のlaunch抑止を確認した。子Nodeはintent保存後にexit23とし、保存済み段階とownerを再読取した。TaskServiceの本番配線が読み取り時にkey/lockを作らず、通常reserveがconfiguration admissionを一回だけ使うことも確認した。
- 実`submitVaultRun`でMasterのUUID形式の通常Sol Taskを登録し、起動監査が通り、scheduler bytesを変えず、Master journalを作らないことを確認した。fixtureは一時Git/Vaultと合成runtime。実provider RPC・モデルturn・Jevは0であり、実Codex会話切替、GUI操作、実機、人による受入の証拠ではない。今回のclient build assetsは直前のMaterial 3端末UIと同じで、画面改修はない。

初期関連試験の1件は、Task pumpがclaimする前にfixtureの待機が終わり、読み取り中にschedulerが変わった。`ready_for_review`かつ非liveまで待つよう修正した。別の1件はrequest hashを束縛した後でtimestamp fixtureがrequestを編集したため正しく保留された。reserveとdispatchの間に実待機を挟み、記録を変更せず時刻の違いを確認するfixtureへ修正した。失敗結果と修正後の成功を別記録として保持する。

独立監査の担当ID書換え、通常Taskのprefix/UUID衝突は回帰を追加して修正した。毎入力の全履歴走査とcrash owner復旧の指摘を受け、候補writerの本番入力/起動への接続を撤去した。これらの候補writerの課題を解決済みには扱わない。

最後の限定再監査では追加のP1/P2指摘はなかった。監査側の30件再実行は親の62件と重複するため合算しない。別の全件実行は最終編集と重なり、最終ソースの全件完了主張へ使わない。

## 2026-10-02追加: 停止した候補ownerの明示照合と限定解除

Material 3の会話切替を公開する前の候補authorityへ、`ownerRecovery(cwd)`と`releaseOwner(cwd, decisionId, proofSha256)`を追加した。通常入力・本番RPC・UIには接続していない。表示用の起動検査は引き続き読み取り専用である。

署名付きownerにMaster ID、処理種別、UUID要求、処理hash、正規cwdのhash、取得時点の会話・turn・scheduler証拠hashを束縛する。入力受付は任意callbackを受け取らず、要求IDから先に固定したwork IDで内部の既存受付だけを呼ぶ。previewは記録もnative guardも作らず、nativeで終了が確認できた正確なowner全文SHA-256、署名、期待する証拠を前後で照合する。live PID・再利用されたlive PID・終了不明・部分/旧版/変更されたowner・hardlinkは解除しない。

| 停止地点 | 今回の扱い |
| --- | --- |
| 読取監査中、他のMaster証拠がすべて既知の終端 | 正確なownerだけを明示解除できる |
| 入力受付前、対象turnディレクトリもscheduler entryも存在しない | 正規cwdと要求に束縛したownerだけを解除できる |
| 入力受付の対象request/claimが一つでも存在する | cancelled/終端になっていても保留。対象全文hash・段階・schedulerと初回の基盤作成を含む別の照合が必要 |
| 会話作成の署名済み要求と段階が残る | ownerだけを解除できる。dispatch後の結果不明はそのまま残り、新しい会話や入力を開始できない |
| 会話作成の対象ディレクトリがない/部分/変更 | 保留。削除されたdispatchを不存在と見なして解除しない |

解除は元の要求とは別のUUID確認IDを使う。確認IDの再利用を別ownerへ適用する前に拒否し、同じownerに別確認を重ねない。最大8KBの完全な署名付き復旧recordをメモリで検証してからnativeへ渡す。既存のOS排他内で固定`recoveries`へstagingを書き、完了recordを上書きなしで保存した後だけ、開いた正確なdead ownerを解除する。staging名はowner nonceと確認IDを含み、部分stagingを通常起動から除外しない。同じowner・同じ確認IDだけが再開でき、未完成bytesを完了recordとして採用しない。保存後・解除後に同じ確認IDを再読取してもモデル処理を実行しない。

復旧recordには全文cwdを埋め込まず、署名済みownerと同じ正規cwdのSHA-256を保存する。長い有効なcwdでもrecordが上限を越えて復旧不能にならない。同じ保存済み確認IDは、その後に正当な別の処理が進んでも、過去の正確なrecordとowner不存在を照合して結果を返す。現在の実行枠を変更しない。記録上限10,000件では新しいrecordの枠をnative排他内でも予約し、上限を越える保存・owner解除を拒否する。既存の正確なfinal/pendingの再照合は上限内で継続できる。

Windowsでは通常fileのhandleとlink数/サイズを確認してからstagingを書き、`FlushFileBuffers`後に`MoveFileExW`のWRITE_THROUGHを使い、REPLACE_EXISTINGやcopy fallbackは使わない（[FlushFileBuffers](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers)、[MoveFileExW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw)）。Linuxのpathname unlinkは、直前のinode/bytes照合後にも差替えられるため、Masterのnative解除をguard/record作成より前に拒否する。非Windowsのpreviewも解除可能を返さない。Linuxの協調writer・安全なquarantine/解除protocolは残る条件である。既存の他3種writerのLinux経路は今回変更しておらず、そのcheck/unlink間の差替え条件も未解決である。実Linux/UNC filesystemと停電の検証はなく、API呼出しやprocess exit試験から電源断耐性を主張しない。

解除後に新しいownerが現れた場合は成功を返さず、そのownerを保持する。旧会話段階、実行枠、送信・終端証拠を取消・settle・修正せず、providerを起動しない。

### 残る有効化条件

この限定解除は全復旧の完成ではない。対象turnを作成した後のreconciliation、target全文hashとschedulerの固定、初回のturn root/設定作成が変えるbaseline、会話要求を作る前のthread owner crash、署名付きinventoryと別に耐久化したanchor、保持・移行・500/1,000件性能検証が残る。個々の復旧recordは署名と上書き防止を持つが、record削除や末尾rollbackを検知するinventoryはまだない。外部writer/ABA、部分marker、混在版、Linux/UNC/停電も未検証である。

同じ常駐App Serverへの実初回thread/rotation、戻り値のcwd/model/provider/settings、登録ツール・approval・server request・waiterの静止、通常入力と切替の共有排他、完了後だけの表示境界、再接続で同じ要求IDの照会を一緒に接続する必要がある。UIへ接続する際は、認証済み利用者の明示意思とpreview証拠を確認する必要がある。候補APIへ渡したUUIDは実利用者の承認証明ではない。Codex「新しい会話」は引き続き拒否する。直前のMaterial 3 UIは保持し、今回新しい画面実証は行っていない。

### 復旧の検証記録

独立レビューで、別ownerへの確認ID再利用による重複record、最終名への部分書込、保存前のサイズ/自己検証、入力受付ownerとcwdの未束縛を指摘され、修正した。再レビューのLinux差替えはMaster解除の拒否へ変更し、後の進捗による同じ確認の照会失敗、記録上限の越境、長いcwdの復旧不能を修正した。対象turnがある場合の証拠不足は、今回は明示的に解除対象外として保留する。署名付きanchorと全復旧は解決済みに扱わない。

一時filesystemとNode/Python子process、合成provider identityを使った試験である。実provider RPC・モデルturn・Jevは0。UI、実機、人の使いやすさ・成果品質、CI成功の証拠ではない。関連試験の最終件数・時間と限定レビュー結果は実装状況文書へ記録する。

最終実装の関連73/73成功（48162.6215ms、exit0）。最後に追加した非Windows previewのOS別回帰を含む復旧31件は30成功・非Windows実OSを必要とする1スキップ・失敗0（26681.658ms、exit0）。両集合は重複し、合算しない。型検査・最終ビルド成功。client assetsは従来の`index-CvLJ6iRB.css`/`index-C-cjKz75.js`のままである。独立した限定再レビューでは修正した4経路にP1/P2指摘が残らず、後続の正当な進捗後の同じ確認照会も別fixtureで再確認した。

Windowsの実一時filesystemで、live/PID再利用、別owner/別確認、署名/部分/旧版/変更、hardlink、実processの部分書込・保存後・解除後exit、並行解除、後から現れるowner、8KBを越えるUTF8 cwdを確認した。容量の9,999/10,000/10,001境界とnative排他内の満杯検知は合成inventory名を使い、10,000件の実filesystem走査や性能を検証したものではない。Linuxのnative拒否分岐はWindows上から直接呼出し、guard/receipt/ownerの不変を確認した。非Windows authorityの実OS試験は前記1スキップであり、Linux動作を実証したとは扱わない。

## 検証

- 最終関連194/194成功（5032.3924ms、exit0）。AppServer client/Brain、MasterSession、共通実行枠、会話モデル・配線、permissionを含む。既存全件試験とは合算しない。
- 型検査・ビルド成功。独立監査で初回起動前の競合、表示通知例外、旧質問の残存を修正し、追加ブロッカーなしを確認した。境界のID再利用の直接試験も追加した。
- ビルド済みUI＋実MasterSession＋合成brainをCookie認証付きHTTP/WSへ接続。Chromium1440×900/375×812/320×812の両テーマで確認した。文書幅は1440/375/320pxと一致し、確認操作48px、送信52px、reduced motionは0s。スマホ入力欄bottom724px < 下部navigation top740pxだった。
- キャンセルは未送信。明示切替3回で、起動待ち・二重要求拒否・再接続・起動失敗・明示再試行成功・サーバ終了との競合を確認した。表示境界は成功1回だけ、入力と失敗時の使用量を保持し、旧質問のボタンは破棄後に消えた。
- 最終GUIのconsole error/warning/page errorは0。UIのchatSendは0。準備時の合成入力1件を含み、providerプロセス・model API・Jevは0。実Claude/Gemini/Codexの切替、実機safe-area/仮想キーボード、人による使いやすさ・成果品質の受入は未確認。

初期試験では、終了後の質問破棄を落とした互換性1件と、終了未確認時に入力できる1件を修正した。対象外のtest filename指定2回、QAの誤ったelement ref、CLIのworkspace外script読取拒否、WS反映前の確認、初期表示前の確認、スマホで非表示の接続statusへの待機は実行手順の失敗として保持した。fixtureの再起動中に旧pageが再接続したconnection-refusedログも、最終GUIの新しい監視区間と区別する。

Browser plugin not availableのため既存Playwright CLIを使用した。CLIがworkspace外のscriptを拒否したため、実行用コピーだけ公開外の`output/playwright/`へ置いた。fixture・スクリーンショットはworkspace外、試験ログは公開外の`.ebi-team/`に保持し、公開差分には含めない。
