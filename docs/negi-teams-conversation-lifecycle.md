# 会話切替と統括のライフサイクル

2026-10-02。Material 3の会話切替を、実際の起動・終了状態に合わせる。Codexの新規会話を有効にした記録ではない。

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

### 候補writerを有効にする前の必須条件

- 署名付きinventory/checkpointと増分検査、保持・移行の規則。段階単体の署名ではoperationディレクトリ全体の削除を検知できない。現行の完全走査は10,000件上限を持つ。独立監査では短い終端記録500件でも約8.5秒を要したため、通常入力へ使わない。起動監査も履歴件数に比例する。500/1,000件の性能検証は未完了。
- ownerへ処理種別・要求・期待する証拠を束縛し、PID再利用・正確なファイル・journal・schedulerを照合する明示的な復旧。現行候補ownerはnonce/PIDのみで、crash後の安全な解除を提供しない。死んだPIDだけで解除・自動再試行しない。実子processの停止試験ではdispatch intentとownerを保持したまま起動を保留した。読み取り専用の本番起動検査自体はこのownerを作らない。
- 実App Serverの初回threadと切替を同じ永続authorityへ接続し、cwdを含む戻り値、現在のthread・設定、登録ツール・approval・server request・waiterの静止を照合する。通常入力と切替の排他を同時に有効化する。
- 永続的な完了後だけ要求IDと新旧threadを含む表示境界を通知し、再接続で同じIDを照会する。shutdown/crash/transport喪失時のcontainment、部分marker・混在版・外部書換え/ABA・停電・Linux/UNC実filesystemの条件も残る。

### 今回の検証

- 最終のauthority/Master admission/Brain/scheduler関連62/62成功（28769.3316ms、exit0）。別の会話表示12/12成功（14966.0021ms、exit0）。集合は合算せず、過去の全件試験を最終ソースの全件検証とは扱わない。最後の変更は上部コメントだけ。最終の型検査・ビルド成功。
- 実一時filesystemで署名・同じ要求の再読取・異なる条件の拒否・lost ACK・並行候補要求・部分/変更/削除段階・hardlink/junction・担当ID変更・旧未解決記録・別Master・起動前保留・stop中のlaunch抑止を確認した。子Nodeはintent保存後にexit23とし、保存済み段階とownerを再読取した。TaskServiceの本番配線が読み取り時にkey/lockを作らず、通常reserveがconfiguration admissionを一回だけ使うことも確認した。
- 実`submitVaultRun`でMasterのUUID形式の通常Sol Taskを登録し、起動監査が通り、scheduler bytesを変えず、Master journalを作らないことを確認した。fixtureは一時Git/Vaultと合成runtime。実provider RPC・モデルturn・Jevは0であり、実Codex会話切替、GUI操作、実機、人による受入の証拠ではない。今回のclient build assetsは直前のMaterial 3端末UIと同じで、画面改修はない。

初期関連試験の1件は、Task pumpがclaimする前にfixtureの待機が終わり、読み取り中にschedulerが変わった。`ready_for_review`かつ非liveまで待つよう修正した。別の1件はrequest hashを束縛した後でtimestamp fixtureがrequestを編集したため正しく保留された。reserveとdispatchの間に実待機を挟み、記録を変更せず時刻の違いを確認するfixtureへ修正した。失敗結果と修正後の成功を別記録として保持する。

独立監査の担当ID書換え、通常Taskのprefix/UUID衝突は回帰を追加して修正した。毎入力の全履歴走査とcrash owner復旧の指摘を受け、候補writerの本番入力/起動への接続を撤去した。これらの候補writerの課題を解決済みには扱わない。

最後の限定再監査では追加のP1/P2指摘はなかった。監査側の30件再実行は親の62件と重複するため合算しない。別の全件実行は最終編集と重なり、最終ソースの全件完了主張へ使わない。

## 検証

- 最終関連194/194成功（5032.3924ms、exit0）。AppServer client/Brain、MasterSession、共通実行枠、会話モデル・配線、permissionを含む。既存全件試験とは合算しない。
- 型検査・ビルド成功。独立監査で初回起動前の競合、表示通知例外、旧質問の残存を修正し、追加ブロッカーなしを確認した。境界のID再利用の直接試験も追加した。
- ビルド済みUI＋実MasterSession＋合成brainをCookie認証付きHTTP/WSへ接続。Chromium1440×900/375×812/320×812の両テーマで確認した。文書幅は1440/375/320pxと一致し、確認操作48px、送信52px、reduced motionは0s。スマホ入力欄bottom724px < 下部navigation top740pxだった。
- キャンセルは未送信。明示切替3回で、起動待ち・二重要求拒否・再接続・起動失敗・明示再試行成功・サーバ終了との競合を確認した。表示境界は成功1回だけ、入力と失敗時の使用量を保持し、旧質問のボタンは破棄後に消えた。
- 最終GUIのconsole error/warning/page errorは0。UIのchatSendは0。準備時の合成入力1件を含み、providerプロセス・model API・Jevは0。実Claude/Gemini/Codexの切替、実機safe-area/仮想キーボード、人による使いやすさ・成果品質の受入は未確認。

初期試験では、終了後の質問破棄を落とした互換性1件と、終了未確認時に入力できる1件を修正した。対象外のtest filename指定2回、QAの誤ったelement ref、CLIのworkspace外script読取拒否、WS反映前の確認、初期表示前の確認、スマホで非表示の接続statusへの待機は実行手順の失敗として保持した。fixtureの再起動中に旧pageが再接続したconnection-refusedログも、最終GUIの新しい監視区間と区別する。

Browser plugin not availableのため既存Playwright CLIを使用した。CLIがworkspace外のscriptを拒否したため、実行用コピーだけ公開外の`output/playwright/`へ置いた。fixture・スクリーンショットはworkspace外、試験ログは公開外の`.ebi-team/`に保持し、公開差分には含めない。
