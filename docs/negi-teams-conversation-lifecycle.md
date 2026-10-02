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

## 検証

- 最終関連194/194成功（5032.3924ms、exit0）。AppServer client/Brain、MasterSession、共通実行枠、会話モデル・配線、permissionを含む。既存全件試験とは合算しない。
- 型検査・ビルド成功。独立監査で初回起動前の競合、表示通知例外、旧質問の残存を修正し、追加ブロッカーなしを確認した。境界のID再利用の直接試験も追加した。
- ビルド済みUI＋実MasterSession＋合成brainをCookie認証付きHTTP/WSへ接続。Chromium1440×900/375×812/320×812の両テーマで確認した。文書幅は1440/375/320pxと一致し、確認操作48px、送信52px、reduced motionは0s。スマホ入力欄bottom724px < 下部navigation top740pxだった。
- キャンセルは未送信。明示切替3回で、起動待ち・二重要求拒否・再接続・起動失敗・明示再試行成功・サーバ終了との競合を確認した。表示境界は成功1回だけ、入力と失敗時の使用量を保持し、旧質問のボタンは破棄後に消えた。
- 最終GUIのconsole error/warning/page errorは0。UIのchatSendは0。準備時の合成入力1件を含み、providerプロセス・model API・Jevは0。実Claude/Gemini/Codexの切替、実機safe-area/仮想キーボード、人による使いやすさ・成果品質の受入は未確認。

初期試験では、終了後の質問破棄を落とした互換性1件と、終了未確認時に入力できる1件を修正した。対象外のtest filename指定2回、QAの誤ったelement ref、CLIのworkspace外script読取拒否、WS反映前の確認、初期表示前の確認、スマホで非表示の接続statusへの待機は実行手順の失敗として保持した。fixtureの再起動中に旧pageが再接続したconnection-refusedログも、最終GUIの新しい監視区間と区別する。

Browser plugin not availableのため既存Playwright CLIを使用した。CLIがworkspace外のscriptを拒否したため、実行用コピーだけ公開外の`output/playwright/`へ置いた。fixture・スクリーンショットはworkspace外、試験ログは公開外の`.ebi-team/`に保持し、公開差分には含めない。
