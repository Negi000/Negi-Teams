# Negi-Teams 実装と受入の現在地

2026-10-01（JST）。基準は `NEGI_TEAMS_MASTER_PLAN.ja.md` のPhase 0〜8と `REQUIREMENTS_TRACEABILITY.ja.md`。この表は実装・合成テスト・実モデル観測・人間受入を分ける。Git管理外の実行証拠も参照しており、実装差分の公開を全Phaseの完了宣言とは扱わない。

追加の[統括から登録Taskへの接続](./negi-teams-master-task-tools.md)では、通常Codex Masterに固定Taskの一覧・完全な契約の読取・同一schedulerへの委任を接続した。起動元は人間受入と別に保存する。実Astraの読取確認と関連TS45件は成功した。Material 3の320px/375px表示と48px角の停止ボタンも確認した。全件の並列試験では知識連携の待ち時間超過、次の試験では旧PTY配送の時間依存による失敗を観測し、直列試験でもPTY待ちとGitの時間切れが出た。全件の成功を今回の確認結果としては主張しない。旧MCP/PTYと常駐統括の全面移行は引き続き未完了。

旧PTY fixtureは固定sleepから描画・idle/busy・queue flushの観測へ変更し、合成heartbeatとテスト側の待機期限を調整した。製品の配送設定は変更していない。最終の関連34件は33成功・1起動待ちタイムアウトで、失敗した1件は個別再実行で成功した。型検査・ビルドも成功。これを全件の一括成功には換算しない。

| Phase | 実施して確認した範囲 | 受入に残る主な条件 |
|---|---|---|
| 0 基準 | 既存SHA・dirty状態・起動/テスト・認証/MCP/configの境界を記録。Windowsの標準テスト入口と配送fixtureを修正 | 実CLIのopt-in試験とPOSIX固有試験は別ゲート |
| 1 履歴診断 | 読取専用importerとローカルDB。269 source・700,674 eventの保存版、参照行・欠測・再取込・変化中入力を区別。合成16件とDB整合性を確認 | 変化中の約2.8 GBログと今後の増分、全履歴の最新性、成果の外部裏づけ |
| 2 Vault | ID/版/hashつきノート、検索、Context Pack、更新前hash、candidate/activate/deprecate。実VaultのTask/仕様/候補を利用。自由文から限定Lesson候補と明示知識承認を接続 | 既存派生Packの失効通知・大規模検索・同期競合 |
| 3 Astra→Sol | App Server接続・台帳・Task固定・隔離checkoutを実装。Task画面で実Astra→Sol、内容監査による失効、元成果を保持した同一契約の修正版Bの再検証・再起動を確認。固定Codex Masterの読取専用UI turnも完了。開始・停止・操作承認・固定差分レビューを接続 | 実成果の人間受入。旧worker/MCP経路のTask Contractと同一枠への全面移行 |
| 4 Luna・並列 | 単一schedulerとLuna/Solの読取並列を観測し、内容不良と機械条件の不一致を失敗として保持。別所有の2文書の実Astra→Sol書込を並行実行し、第三のclean checkoutへ統合・再検証。登録Taskの最新修正版も統合対象にできる。統合成果の固定差分・元Taskの版を共通レビュー画面へ接続し、署名付き受入・取消・再起動復旧を合成確認 | 実コードの競合解消・人間受入、全通常dispatchの同一枠化、checkout alias対策 |
| 5 Jev shadow | 7 gateのoff/shadowと利用台帳。送信レビュー済みの非機密fixtureで2成功・1不正応答を観測し、失敗は再送せず保留 | 日本語の人間ラベルとの校正、全gateの実フロー接続、外部アカウント残高の強制上限 |
| 6 レビュー | A→指摘→B→検証の台帳、Lesson候補、失効操作。Cookie認証付き画面で自由文を成果hashへ固定し、署名付き受入・取消を対応Task台帳へ反映。同一契約のローカル修正登録とjournalからの台帳復旧を実成果で確認。認証付き指摘→候補→別の知識承認→次のTask参照→失効を通常schedulerの合成Taskで接続 | 実成果の人間受入、workerによる修正版生成への通常経路、Lessonの複数事例照合・矛盾・寿命管理 |
| 7 政策比較 | 同条件のLuna medium/lowを2問で実比較。双方正答だが所要時間は1勝1敗。Policy候補/比較/承認/active/rollbackの状態機械 | 品質を維持した明瞭な改善が未観測。人間承認なし。active適用と戻し試験なし |
| 8 運用・モバイル | Material 3 ExpressiveへUIを再設計。実データの作業一覧、PCのrail・一覧/詳細・レビューpane、スマホの下部ナビ・単一詳細、ダークテーマ、native dialogとキーボード操作を接続。Cookie認証と旧token削除を維持し、1440px/320px/375px・合成レビューの保存/受入/取消・深いリンク・通信失敗をChromiumで確認。既存Codex Master読取turnと合成Task実行の証拠も保持 | iPhone/Androidのsafe area・仮想キーボード、画像と実成果の人間受入を含む旅程。AndroidエミュレータへのURL起動は自動承認レビューで拒否され、画面試験に至らず。知識の承認・編集・失効は共通UIへ接続済み。統合成果のレビューも共通UIへ接続済み。統合実行とJevの通常操作は残る |

実モデルのturn usageはApp Server通知で観測した値で、turn全体の範囲とサブスクリプションの金銭請求額を確定していない。Jevの既知入力906 tokenについて公式公表単価による参考試算を残し、不正応答1件のusage/費用は不明のまま。これらを節約率や品質改善の実証に換算しない。

検証: 統合入口・最新修正版の選択・Windowsパス互換・新しいUIのsummary/成果表示を含む標準の`npm run test:unit`を完走し、621成功・失敗0・未完了0・2スキップ（実Claudeのopt-in試験とPOSIX ptmx試験）を確認した。型検査・ビルド・Python36件も成功。画面調整後に関連52件とブラウザ操作を再確認。条件付きLessonはTask分類の伝播・署名付きの知識承認・通常schedulerの次Task参照へ接続し、標準TS627件中625成功・2スキップ、最終関連58件・Python36件・型検査・ビルドを確認した。知識画面のChromium1440px/320px/375px操作も確認した。追加CLI3本の型検査と実並列/統合入口の証拠は保持し、UI改修で新規モデル/Jev turnは使っていない。統合レビュー追加時の標準TS638件中636成功・2スキップ・失敗0。固定原文再生成の照合を加えた後の関連21件も成功。最終の3件と型検査・ビルドも成功。既存の実統合成果は通常サーバーでレビュー待ちとして読み取れ、元Taskとcheckoutを保持した。合成果の受入・取消・再起動と変更時停止を1440px/320px/375pxで確認した。実モデルや実機の未試験経路まで成功扱いにしない。

公開先は利用者所有の`Negi000/Negi-Teams`。計画の基準SHAからの`negi-teams-foundation`差分と、残る条件を明記したdraft PRで扱う。originは元の`r2sake/ebi-team`であり、そこへ直接pushしない。Git管理外の証拠、ローカルVault、過去ログは公開対象に含めず、追加文書の個人のログパスとsession IDを除いた。
