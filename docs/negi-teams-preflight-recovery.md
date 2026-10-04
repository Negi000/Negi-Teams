# 開始前の失敗を確認して終了する

Material 3 ExpressiveのTask画面に、開始できなかった要求の確認・終了を追加した。これは未実行を確認できる要求を終了する操作であり、同じrunを再試行する操作ではない。元の要求、失敗記録、契約、差分、通知履歴を保持する。続行する場合は元の会話から新しい契約案とrunを作成する。

## 確認する条件

- 認証済みの同一Origin操作、固定run/config、UUID、正確なJSON。
- 固定snapshotと署名済み契約承認。現在のGit HEAD、index、差分、変更ファイルhash。
- 開始要求と失敗記録のbytes。実行台帳・scheduler登録の不在。実行用フォルダーに未知の記録がないこと。
- 同じrunの開始・確認・終了に共通の排他的なowner lock。別serviceの開始中や残留lockは保留する。
- indexed構成はroot共通guardの下でnative SQLite索引がcleanであること。保存済みintentの欠落、pending、未知の処理は終了許可にしない。

確認結果は署名し、終了時に再照合する。一般的な失敗メッセージや経過時間だけでは未実行と判断しない。差分を削除・リセットせず、確認後の変更は終了を拒否する。外部editor/CLIのGit変更をOS全体で排除する保証ではない。

## 明示的な終了と部分保存

終了判断のintentと署名receiptを先に保存し、一つの`close_unsubmitted`イベントで古いrunを`cancelled`へ登録する。実行待ちになる中間状態、provider起動、再送はない。同じIDは新しいwriterからのsubmitも拒否する。

開始要求・失敗記録は書き換えない。終了後の読取は、scheduler event/時刻/work、close intent、署名したclose receipt、元のinspection receipt、run/config/dossier、元の要求・失敗・snapshotのhashを照合する。欠落・改変は「終了済み」にせず、保存記録の照合待ちとして開始を保留する。終了後に利用者がcheckoutを編集しても、過去の判断を新しい差分に付け替えない。

判断保存後の公開失敗は、元の確認・終了IDを表示する。同じ明示操作だけで残りを続ける。新しいIDへの切替、再起動・状態読取からの自動公開、未知のscheduler intentの再送はしない。保存索引がpendingの場合は、既存の保存状態確認と個別照合が先に必要になる。

## 読取helperと終了処理

native inventoryの`preview`・`audit`・`auditScheduler`だけに20秒の読取期限を設定する。期限で当該読取processへ停止を要求しても、実際のprocess closeを待つまでstorage guardを解放しない。`adopt`・`appendScheduler`・`appendTurn`は期限でkill・再試行しない。出力超過も書き込みprocessの完了とは扱わない。

Task開始の結果通知・状態読取は、configuration writerとpreflight ownerを解放してから行う。service終了は進行中の開始処理と実行精算を待つ。serverは5秒で自分の接続を閉じるが、保存処理の完了を待たずにprocess exitしない。OS強制終了・停電は別の条件である。

## 形式移行と運用条件

**`close_unsubmitted`記録後の旧binaryへのdowngradeと新旧readerの混在は非対応。** 直前のreaderの固定fixtureで、新イベントを拒否して元状態を変更しないことを試験した。通知更新形式の既存方針と同様、全参加者を更新してから新writerを使う。

新しい終了writerは既定で無効。確認画面と過去の署名判断の読取は利用できるが、終了APIは拒否する。以下の全reader更新を完了した運用者だけが、server起動時に`NEGI_PREFLIGHT_CLOSURE=close_unsubmitted/1`を設定して有効化する。値は正確に検証し、HTTP/modelの入力から変更できない。これは運用者による明示activationで、外部processの版・静止を自動測定するfenceではない。

1. 同じscheduler/stateを使う全サーバー・CLI・reader/writerを停止する。当該serverの停止だけで外部参加者の停止を証明したことにはしない。
2. Task台帳、scheduler/native索引・authority、署名proof、要求・失敗・入力・成果・通知・設定を一体でバックアップする。
3. 全reader/writerを新イベント対応版へ更新し、隔離したコピーの読取とnative auditを確認する。新旧混在で終了操作を有効化しない。
4. 更新後の障害は同じ形式を読める修正版でroll forwardする。旧logやbackupを稼働storageへ上書きせず、原記録と未確定のintentを保持する。

終了後に実行台帳・owner・成果などの記録が出現した場合も、過去の「未実行」と矛盾するため現在表示を保留する。署名済み契約承認の欠落・改変も照合する。checkoutの利用者編集だけは、過去の終了判断を変更しない。

残留preflight lockを時刻やPIDだけで削除しない。全参加者・関連processの終了、元要求、完全な台帳、署名、native索引、checkoutを照合し、未知の操作が残る場合は保持する。安全を確認できた運用者だけが、正確なstorage内の当該lockをバックアップ先へ退避して原記録を残す。汎用のstale-owner復旧UIは今回提供しない。

## 検証範囲と残る条件

合成の事前確認失敗から実native索引・ビルド済みHTTP/Chromeで確認、明示終了、再読込、署名記録欠落時の保留を検証する。PC1440px、375px、320px、明暗、Space確認、48px操作、横幅、consoleを確認する。これは新しい実Astra→Sol→レビュー→Astraの成功やnative phoneの受入ではない。

既存の失敗した実モデル要求は再送・削除していない。原因を失った旧generic failureから正確な例外を復元しない。部分作成、未知provider/owner、全reader参加の測定、directory metadataを含む実停電耐性、実機safe area/keyboard、旧dispatch全面移行と全73要件の受入は継続する。この追加はdraft上の進捗で、production activation、完成、release、CI成功を意味しない。

## 2026-10-04: Task区分と担当権限を保存する

[解決Task](negi-teams-integration-resolution.md)の未送信終了では、integration_resolutionとSol/write/directを作業記録へ残す。結果不明の照合にも同じ区分を残す。未送信の明示調査はLuna/read・資源read・元の実行形態を保持し、Sol/writeへ読み替えない。終了専用条件と共通scheduler検証の両方を満たす場合だけterminal予約を保存する。開始保留のnative Lunaを有効にする変更ではない。

終了writerの既定off、運用者の明示activation、全reader/writer更新、元要求・署名・無admissionの照合、未知状態の保留、旧版との混在非対応を維持する。モデルturn・claim・submitは終了操作から送信しない。
