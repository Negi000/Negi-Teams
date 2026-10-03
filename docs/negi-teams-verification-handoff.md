# 固定検証と結果表示の担当

## 実装と検証

Solのターンが終了した後、ランナーが呼出元の固定検証を実施し、証拠と結果をTask台帳へ保存する。AstraとSolへの入力にもこの担当を明記した。モデルに検証コマンドが提示されていない場合は推測して追加実行せず、ランナーの結果待ちと報告する。契約に明示された実装前の検証・停止条件は守る。

検証項目、登録済みコマンド、合否の保存、契約の受入条件を変更しない。Solの「検証成功」「受入済み」という回答は合否・人間受入の根拠にならない。機械検証が成功したTaskも、人間の判断まで受入未実施として扱う。

## 結果の更新とMaster入力

indexed modeの結果通知更新とMaster入力は、共通のnative保存保護とreview result-source保護を使う。修正前は結果更新がreview→native、Master入力がnative→reviewの順に取得し、互いの保存処理を待って入力を拒否する経路があった。

保存済みの実モデル成果を使った、配送入力の書込み前で停止する検査で、通常・Master保存保護内の照合がどちらも書込み直前まで通ることを確認した。逆順を発生させた別の検査では、結果更新の完了とMaster側の`ReviewDecisionBusyError`を確認した。どちらもモデルを起動せず、検査前後の元ファイルSHAは一致した。元のWeb拒否は例外を伏せていたため、この再現と元の例外が同一だったという点は推定である。

現在はtrusted serverが`LocalTaskService.connectReviews`で保存登録を一度だけ接続し、レビュー側の全result-source操作をnative→reviewの順に取得する。同じ非同期操作の入れ子は両方の保護へ再入する。結果通知だけでなく、受入・取消・コメント・修正版登録と、その通知callbackも同じ順序を使う。

- indexed登録のroot・turnRoot・schedulerPathを固定する。同じ登録の再接続は初回の保護を保持し、異なる登録や操作開始後の初回登録を拒否する。
- 統合レビューのsource readerも同じ保存登録とschedulerであることを、登録・公開より前とcurrent-checkで照合する。static registryはsource contextを開く前に照合する。同じreview storageへ別native rootを結び付ける構成を拒否し、native→review→別nativeという逆順を作らない。
- `IntegrationSource.resultStorage`はtrusted serverの必須項目。legacy readerは明示的に`null`を指定する。省略・indexed/legacy混在をlegacyとして推測しない。Windowsでもnative guardと同じcanonical casingを保持する。
- legacy modeはnative bindingを追加しない。
- native取得失敗をreviewの競合と取り違えず、元のエラーを維持する。
- 残されたreview所有記録は時間経過で奪取・削除しない。失敗時も取得したnative保護を解放する。
- 永続イベント、署名形式、モデルの再送規則、登録済みツール定義を変更しない。

## 検証の状態

初回の関連7ファイル73/73成功、失敗/取消/skip 0（476973.4538ms、actual exit0）。型検査・ビルドも成功し、src/scripts/test 328ファイルのSHA不変を確認した。その後の独立レビューで異種root統合の逆順を指摘され、上記の登録照合を追加した。73件をこの最終変更後の検証として扱わない。

独立再レビューの修正後、最終関連9ファイル88/88成功、失敗/取消/skip 0（866575.5366ms、actual exit0）。同一登録のstatic統合復元・統合受入/取消と、Taskの受入/取消→通知listener→結果公開→signed scheduler読取→accepted/review_revoked通知を実際のnative保存で確認した。異種root共有、casing差、未指定metadata、indexed/legacy混在とscheduler差は登録前に拒否する。型検査・ビルド・保存された実成果の追加読取もactual exit0で、実行中のsrc/scripts/testの328ファイル（.ts/.mjs/.py/.txt）のSHAは一致した。先行73件/19件を合算しない。独立read-only再レビューに残る具体的な指摘はなかった。

先行する実Codex 0.160.0の独立QAでは、Astra mediumの契約案1件→ブラウザで確定・開始→Sol mediumの実装1回→固定機械検証成功→固定レビューと結果通知の表示まで確認した。人間受入は未実施。次のAstra入力は結果照合で未送信として拒否され、その要求からモデルターンは開始していない。同じTaskを再投入していない。

Material 3 ExpressiveのPCとスマホの導線で実成果を表示した。1440pxと375/320pxの明暗、レビュー内容、作成元会話へのリンク、下書き保持を確認した。375/320pxの追加読取検査は、3つの48px操作ボタンが入力欄・下部ナビに隠れないこと、横はみ出し・予期しないconsole/page errorなしを確認し、入力や新規会話を送信しなかった。Browser plugin not availableのため既存Playwright/Chromeを使用し、私有証拠は公開差分の外へ保存する。

新しい独立QAでは、実Codex 0.160.0のAstra mediumが案を1件保存し、画面で境界確認・確定・開始した。Sol mediumの実装1回と固定検証が成功し、固定レビュー・M3結果カード・元会話のdeep linkを確認した。次の明示Astra入力に署名済み通知が添付され、Astraは「機械検証成功、人間受入未実施」と回答した。通知配送はcompletedとなり、通常終了・再起動後も同じ会話とcompleted状態を保持し、turnを再送しなかった。Masterのturn/startは合計2回、Solは1回、Task/案は各1件である。人間の受入操作は行っていない。

このQAの観察scriptは製品手順完了後、一覧APIに存在しないacceptedByをnullと比較してexit1となった。原記録を保持し、モデルを再実行せず保存されたTaskの詳細・通知・固定証拠を追加読取した。詳細はready_for_review、検証passed、acceptedBy=null、attempt 1、live=false、使用枠0。native auditはclean、元111ファイルのSHAは一致し、追加dispatchは0。計画したserver停止中だけWebSocketのconnection-refusedが5件あり、その他の予期しないUI errorは0。観察script全体がexit0だったという主張はしない。

## 継続する条件

レビューのcurrent-checkやGit検査もnative保護内で直列化するため、長時間の操作・大規模履歴・外部process競合に対する応答時間は残る性能条件である。旧writer/別binaryの参加や静止をこの順序変更で証明したことにはしない。

異なるnative rootを同時に扱う正式な統合は、複数guardとMasterの入場順を設計・実証する残条件である。今回の同一登録照合を、その構成の実装成功とは扱わない。serverの既存indexed通常起動はsaved setup専用で、NEGI_INTEGRATION_CONFIG等のlegacy環境設定との併用を開始前に保留する。この既存制約を解除しない。static integration serviceを直接構成するtrusted callerは、Taskと同じstorage optionを明示する。

全73要件・Phase0–8と全体ゴールを維持する。実機のsafe-area・keyboardと利用者受入、旧dispatchの全面移行、一般的な未知owner/部分保存の復旧、Jev・知識・Policy・履歴の残る条件を継続する。この進捗はproduction activation、release、CI成功、全体完成の確認ではない。
