# 検証済みTaskを画面から統合する

Material 3 ExpressiveのTask画面から、独立した固定成果を選び、別のworktreeで統合・検証してレビューへ渡す。設定済みプロジェクト、Task catalog、レビュー、Cookie認証が必要で、初回profile設定のGUIはまだない。

## 通常の操作

1. Task画面の「Taskの成果を統合」を開く。
2. 同じプロジェクト・repository・基準SHAで検証されたTaskを2〜8件選ぶ。
3. 元Taskの版、受入条件、まとめる変更、必要な検証を確認する。
4. 「統合して検証」で、選択した版を固定して統合用worktreeを準備する。既存schedulerの作業枠が空くまで待機する。
5. 統合と設定済み検証が成功したら「統合成果をレビュー」を開く。内容の受入はレビューで行う。
6. 受入済み成果の保存と新しい後続契約は、[統合基準から続ける経路](negi-teams-integration-baseline.md)を使う。

PCでは成果選択と内容確認を並べ、スマホでは一列で確認する。下部ナビ、light/dark、48pxの主要操作、詳細の展開、キーボード操作は共通のMaterial 3実装を使う。

## 固定と実行の条件

- ブラウザ入力はprofile ID、source run ID、選択hash、操作request IDだけ。パス、コマンド、モデル、権限を追加できない。
- sourceの現在の検証結果、契約版、manifest、設定、同じGit common directory、scheduler、基準SHAを照合する。
- 変更はprofileの範囲内かつ所有ファイルが重ならないものに限る。任意のコード変更も設定範囲内なら対象になるが、競合解消、rename、mode変更、新規実行ファイルは別の統合計画へ戻す。
- 署名付きintentとsetupを保存してから、設定済みworktree rootに専用のdetached worktreeを作る。Git hookを無効化する。元Taskと主checkoutのHEAD/index/差分を保つ。
- コピーとコマンドはscheduler claim後に実行する。profileと元Taskの検証コマンドを重複除去して、そのまま実行する。追加モデルturnは使わない。
- 検証後にも元Taskの固定版と、統合先のpaths/bytes/type/mode/HEADを照合する。検証コマンドが成果を書き換えた場合はverifiedにしない。
- 結果の署名、検証証拠、scheduler、登録レビューを確認してからレビューへのリンクを表示する。自動受入、commit、pushは行わない。

## 停止と再起動

開始前の待機は画面から停止できる。純粋な開始前取消の後は、新しい明示操作で同じ成果を選び直せる。実行中の停止は署名した共有markerと停止signalへ渡し、別serverからの要求も確認する。停止と最終結果確定は同じ操作lockで順序付ける。結果確定が先なら、停止は確定済みとして拒否する。

再起動は署名付きの完了結果を登録する。queued作業や不明なコマンドを自動再実行しない。cleanな待機worktreeと元Taskの版が一致するときだけ「待機を再開」を表示し、もう一度認証付き操作を必要とする。

apply後の停止・切断や一部だけの作成、stale lock、証拠の不一致は差分と実行枠を保って照合待ちにする。危険な途中状態の自動再開、worktree削除、汎用の手動照合GUIは未実装。worktreeはOS sandboxではない。

## 証明の範囲

実Git・Vault・HTTP・署名・通常Task service/schedulerを使う合成clientで確認する。providerの実行、実コード競合の解決、実成果の利用者受入、実機safe area/仮想キーボードの確認とは区別する。

2026-10-02の全件回帰は706件中703成功・失敗0・3skip。最終の表示順序修正後の関連11件、型検査、ビルドも成功。Chromium1440/320/375px・light/darkで選択、待機、開始前停止、再起動後の明示再開、レビュー移動を確認した。新しいfixtureでも通常の統合画面→レビューの受入操作→基準保存→後続契約→Sol fixture→人間レビュー待ちまで接続し、元のTaskと主checkoutを保った。UI試験の合成受入を実成果の利用者受入に換算しない。

全Phase0〜8／NT-001〜NT-073を維持する。旧dispatchの全面移行、provider照合と復旧、通知再発行、Jev全gate・日本語校正・外部残高上限、知識の複数事例・寿命・派生失効、Policy利益実証と承認、履歴最新性、初回設定・契約版移行・作成元会話の関連付けも残る。この追加は全体の完成宣言ではない。
