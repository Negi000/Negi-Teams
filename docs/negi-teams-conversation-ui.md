# 元の会話を確認する画面

## 入口と記録の意味

Material 3 Expressiveの共通surface・配色・shape・操作サイズを使い、Taskと契約案から元の送信と応答へ戻れる画面を接続した。PCでは入力と応答を二列、スマホでは一列の読む順序と下部ナビを使う。識別子とhashは詳細で展開する。

| 入口 | 開く記録 |
| --- | --- |
| 統括の結果通知、作業一覧の結果、Task詳細の「委任元の会話」 | 保存されたTask開始要求の`requestedBy` |
| Task詳細の「契約案を作成した会話」 | 承認時の契約案の`origin` |
| 契約案の「契約案を作成した会話」 | その契約案の`origin` |

`/conversations?run=<登録run>&source=requested|created`と`/conversations?draft=<契約案UUID>`を使う。作成元と開始元は別の記録である。利用者がTask画面から開始した作業には統括からの委任リンクを表示せず、直接開始元URLを開いた場合も「画面から開始」と表示する。承認済みTaskの作成元は署名済み承認のorigin/configと登録済みconfigを再照合する。

この画面が復元するのは、その作業につながった特定のprovider turnの記録である。会話全体や途中の全ツール結果の履歴ではない。provider応答の終了確認は、Taskの機械検証や人間による成果の受入を意味しない。「今の統括を開く」は現在の会話へ移動する操作であり、古い入力の再送や新しい会話の作成ではない。

## 読み取りの境界

- Cookie認証をページとAPIに要求し、Bearer/query tokenは受け入れない。ログイン後も指定した会話・契約案へ戻る。
- run/draft/source以外のquery、重複、path指定、未登録runは拒否する。未記録や不一致を現在の会話で補わない。
- サーバが指定する保存先だけからrequest・dispatch・provider binding・outcome・同じscheduler entryを読む。入力hash、終了記録hashとscheduler evidenceRef、所有者、thread/turn、実行状態を照合する。
- regular file、非symlink、nlink1、サイズ制限、canonical JSON line、前後のfile/directory identityを確認する。provider inventory・対象記録・scheduler entryの前後一致を要求する。変更中の読み取りは保留し、更新後に再確認する。
- 待機中・結果不明・欠測・破損・重複を区別する。結果不明の実行枠を読み取りで解放しない。入力・応答は`textContent`で表示する。
- 送信準備の日時は`dispatch.json.at`である。providerの受付時刻を正確に測った値として扱わない。
- Taskの選択変更や無効な保存URL、取得失敗では旧リンクを消す。遅れて到着した別Taskの応答を表示しない。通常のTask pollで毎回provider inventoryを検索しない。

Master turn記録自体は署名台帳ではない。保存領域の外部書換えや非協調的なABA復元への防御を証明したものではない。正規形式でもMaster turn directoryが10,000件を超えると検索を保留する。全件を二度走査するため上限付近の性能も未検証。旧originと曖昧なbindingの拒否を保つ索引・版移行は残課題で、記録削除で回避しない。

## 確認したこと

関連75/75成功（266019.5895ms）の後、日時修正を含む最終のsource/auth/Master admission試験49/49成功（15034.1519ms）、型検査・ビルド成功。両試験集合は重複するため加算しない。実FileSchedulerと一時Git/Vault/Task fixtureで、再読込、作成元とbrowser開始元、署名変更、未知target、部分JSON、重複key、hash変更、hardlink/junction、provider binding変更、待機・結果不明・失敗・中断を確認した。最初の48件は47成功・1失敗で、テストが先頭のtheme scriptを選んだ誤りを修正して再実行した。

ビルド済みHTTP/pageとVite UIを合成runtimeへ接続し、Chromium1440×900/375×812/320×812、ライト/ダークで以下を確認した。

- client/scroll幅が1440/375/320pxで一致。PC二列・スマホ一列、長いtokenの折返し、選択した操作48px、reduced motion 0s。
- ログイン→指定会話、Task→開始元、契約案→作成元、結果通知と作業一覧→委任元、戻るリンク、キーボードによる詳細展開と遷移。
- browser開始、欠測、待機、結果不明、hash不一致、通信失敗時の旧本文消去、遅延応答の破棄、無効なpopstateで旧Task/リンクを消去。
- 入力と応答内のHTML/scriptを実行しない。最終試験の予期しないconsole error/warning・page errorは0。明示的な失敗試験のHTTP503だけ2件を別記録にした。
- 表示中のprovider/model turn・チャット送信・新しい会話・Task追加実行は0。準備時に一時fixtureの合成Sol callbackを2回使ったが、実providerプロセス・実モデルAPI・Jevは0。読み取り中のscheduler hashとcallback数は不変。

初回のGUI試験はQAのroute解除とcontinueの順序でdaemonが終了し、続く再試験は一度unknownにしたfixtureを再利用した待機状態の期待で失敗した。順序を直して新しいfixtureを使い、非表示の作業一覧を検索した試験も表示を開く手順へ直した後、全経路を再確認した。Browser pluginは利用できず、既存Playwright CLIを使った。合成データ・スクリーンショット・ログは公開差分に含めない。

独立した読取監査で日時と開始元の表記を再確認し、この限定範囲の受入blockerは残らなかった。大規模履歴、実機safe-area/仮想キーボード、人による使いやすさの受入、実モデルの全会話復元は未確認。Codexの新しい会話は、単一lifecycle・永続reset ID・実行中/unknown claim・process tree終了・thread/start不確定状態を一緒に扱う実装が必要で、既存の拒否を維持する。全73要件／Phase0〜8の残条件をこの画面の確認で完了扱いにしない。
