# 保存状態・明示登録・復旧の管理画面

## 2026-10-03の実装範囲

Material 3 Expressiveの共通シェルに、認証済みの`/storage`画面を追加した。PCは操作一覧と詳細を並べ、スマホは操作選択から一つの詳細へ進む。明暗テーマ、下部ナビ、キーボード操作、reduced motionを共通化する。プロジェクト設定から「保存状態・登録・復旧を確認」で到達できる。

画面で扱う操作は次の3つである。

| 操作 | 対象と条件 |
| --- | --- |
| 会話の保存記録を登録 | 既存の署名鍵・native root guardを使い、既存stageと復旧receiptを照合して索引へ明示登録する。 |
| 実行の保存記録を登録 | 固定turnRootと共有schedulerの原文を照合し、署名済みruntime baselineを明示登録する。 |
| 中断した保存を復旧 | 対応するSQLite hot journalを複製で検査し、同じ確認IDとproofで元DBの復旧を行う。 |

登録・復旧の保存後も`executionStarted:false`、`activation:"held"`を返す。会話の返答、provider処理の完了、新しい実行の開始を意味しない。通常のindexed production modeは今回の画面から有効化しない。

## 保存先と認証の境界

`LocalTaskService.inspectStorageRegistration`がtrusted Task catalogをsnapshotし、既存のrun/config parserから正規stateRoot、`master-conversations`、`master-turns`、共有schedulerを読み取る。この検査はTask storeを作成しない。Windowsの未作成schedulerについても、既存`open`と同じ大文字小文字の比較を使う。

Master IDは保存済みproject setupでは`negi-master`、legacy構成ではserver設定`NEGI_STORAGE_MASTER_ID`（既定`negi-master`）から固定する。HTTP入力からroot、turnRoot、scheduler、Master ID、storage modeを受け取らない。登録内容のSHAを確認IDへ束縛する。stageの状態表示は指定Master、runtimeは共通rootの範囲であり、指定Masterの件数を全Masterの件数として表示しない。

`/storage`と`/api/storage*`にはアクセストークンの設定と正確な認証Cookieを要求する。loopbackも例外にしない。未認証の画面要求は`/login?returnTo=/storage`へ戻す。APIはno-store、書込みは同一hostのHTTP/HTTPS Origin、JSON、4,000 bytes以下、正確なfield形状を検査する。保存には`confirmed:true`が必要で、helperの内部出力や署名鍵をエラー本文へ出さない。

状態照会・preview・拒否されたapplyから、欠けたroot、署名鍵、DB、guardを自動生成しない。legacy migrationも既存native guardを要求する。初回root/key/guardの明示作成は、この画面の実装範囲には含まれない。

## 停止と確認IDの操作

登録・復旧を保存する前に、この保存先を使う旧server・外部ツールを停止する。認証と既存のtrusted構成を用意したserverを`NEGI_STORAGE_MAINTENANCE=1`で起動し、内容をpreviewし、対象・内容・旧プログラム停止を画面で確認して保存する。applyはmaintenanceかつ当該serverのexecutionHeld中に限る。

通常起動では、サービスを開く前に既存Authorityの互換性fenceでstage/runtimeのDB・marker・sidecarの存在を検査する。登録済みstage DBだけがある場合も旧経路の起動を保留する。設定・保存検査に失敗しても認証済み診断HTTPを残し、当該serverのTask/統合受付、制御API、固定/動的agent、PTY入力、会話送信・新規会話、要約等の開始を保留する。起動途中のサービスはcloseを待ち、再試行しない。

これは当該serverの既知経路と参加writerの保存境界である。同権限の外部writerや過去binaryの強制停止・root全体のversion参加証明にはならない。画面の停止チェックも外部process静止の測定結果ではない。

確認内容はブラウザーの`negi-storage-decision/1/<registrationSha256>/<decisionId>`へ確認IDごとに保持する。鍵・トークン・会話本文は保存しない。複数タブの別IDを上書きせず、保持内容の選択、storage event、送信直前の完全一致再読込みを使う。ブラウザーへ保存できない場合はapplyを有効にしない。

通信断後も元IDを保持し、同じ登録・proofで明示再確認する。未保存なら確認した保存を続け、保存済みならnative側で受理済み内容を照合する。新しいIDを発行して処理を再送しない。成功応答が確認内容と一致した場合だけ当該IDの消去を許可し、他のIDは残す。元IDの再確認自体をprovider再実行・不明結果の完了として扱わない。

## 検証と実際の画面操作

最終修正後の関連3 test filesは**60/60成功、失敗・取消・skip 0、67,582.3314ms、actual exit 0**。実行中runtime/test 317 filesのSHAが不変だった。新規storage console 9ケース、認証、Task互換を含み、Windowsの未作成schedulerの大小文字互換回帰も成功した。型検査・client/server build・差分検査が成功した。

先行する関連11 test filesは**190/190成功、失敗・取消・skip 0、515,254.7829ms、actual exit 0**で、同じ317 filesのSHAが不変だった。この集合の終了後、Taskのscheduler比較とスマホ見出しのCSS specificityを修正し、回帰1ケースを追加して上記60件を実行した。190件は最後の修正前の集合であり、60件と合算せず、最終差分の標準全件試験・CI成功とも扱わない。途中のimport、WS接続先/終了待ち、fixture cleanupの試験設定不備は修正し、保存内容の照合条件は弱めていない。

Browser plugin not availableのため、既存Playwright CLIとChromeを使い、ビルド済みの実serverをloopbackで起動した。署名鍵/native guardを明示作成した独立fixtureと空のtrusted catalogを使い、実provider/model/Jevは呼ばない。GUI用script、snapshot、画像、結果は公開差分の外に保存した。

| 実操作・検証 | 結果 |
| --- | --- |
| 未認証`/storage`→ログイン→保存状態 | 実画面の認証・returnTo導線が成功。空白画面なし。 |
| 2タブでstage preview | 別々の確認IDを保持。登録後の応答だけを切断しても成功を誤表示せず元IDを保持。 |
| 再読込み→元ID選択→同じIDの再確認 | native受理内容を照合。DB全文SHAは再確認前後で同一。受理したIDの消去後も別タブのIDが残る。 |
| キーボード確認・runtime登録 | checkboxをfocusしてSpaceで操作し、runtime baselineを実native helperで保存。実行は保留。 |
| 実SQLite hot journal→preview→明示復旧 | 子processのactual exit 23とhot journal magicを確認。複製previewは元journal不変。保存後に元DBの正確なbaseline SHAへ戻り、journal消失。同IDの再確認も成功。 |
| 通常モードで再起動 | 診断画面は表示し、保存と旧実行を保留。stageだけが存在する起動も実server/HTTP/WS回帰で確認。 |
| 1440/768/375/320px、明暗テーマ | 横幅はviewportと一致。最終375/320pxの見出し操作はタイトルの下へ配置。操作・下部ナビに横方向の欠けなし。 |
| reduced motion・テーマ再読込み・設定往復 | テーマ保持、操作選択、設定画面との往復が成功。 |
| console/page error | 意図した応答切断でnet::ERR_FAILED 1件。最終通常起動の表示・往復では予期しないerror 0件。 |

親が最終差分を確認し、独立read-only監査で、stageだけの起動fence、複数タブのID保持、scope表示、Windows path互換の指摘を修正した。再レビューで未解決のMedium以上の指摘なし。監査側の編集・試験再実行はない。

共通client assetsは`index-CvLJ6iRB.css`/`index-C-cjKz75.js`を維持する。保存画面はserver生成HTMLであり、同じassets名だけを新画面検証の証拠には使わない。実際の最終HTMLを上記ブラウザーで検証した。

## 継続する受入条件

初回root/key/index設定、全Masterの選択・登録、全旧CLI/MCP/PTY/過去binaryのversion参加・静止、通常indexed production callerの有効化、owner/欠落stage/部分記録の手動照合・完全な復旧導線は残る。対応外journal・部分bootstrap、実停電/UNC/Linux、保持・版移行・大規模性能・外部anchor/DB同時喪失/ABA、実provider/停止/transportの受入も今回完了していない。

実機スマホのsafe-area・仮想キーボード、全導線の人による使いやすさの受入は残る。Codex「新しい会話」は未有効化。Task/Jev/知識/Policy/履歴を含む全73要件・Phase0–8と全体ゴールはACTIVEであり、この画面の検証を全体完成・release・CI成功へ置き換えない。
