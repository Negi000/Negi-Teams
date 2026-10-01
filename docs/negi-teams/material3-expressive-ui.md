# Negi-Teams UI: Material 3 Expressive

ユーザーの2026-10-01の追加要件。Phase 0–8の目的を維持し、元のebi-team UIから画面構造と操作の流れを作り変える。

## 設計

- 視覚方針: 緑を基調にした明るいtonal surface、大きさの異なる丸み、強い見出しと主要操作で作業と判断を見分ける。端末の出力は可読性を維持する。
- 内容構成: 作業一覧を入口に、要判断、現在のTask、チームの順で表示する。詳細は必要な場面で開く。使用量・契約hashは個別の詳細で確認する。
- 操作方針: ナビゲーションの選択、一覧から詳細への遷移、ボタンの押下で状態変化を短い動きで示す。reduced motionを尊重する。
- PC: 常設navigation rail、Taskのlist-detail、成果本文とレビュー操作のsupporting pane。
- スマホ: 下部navigation、Task切替と単一詳細、本文→コメント→受入の順。停止と送信を分離し、48px以上の主要操作とsafe-areaを確保する。
- 共通: 実データの状態だけを表示する。未取得と0を分ける。コメント、操作許可、成果受入、将来の知識承認を別の判断にする。共有Cookie認証と版指定を維持する。

CSS tokens、形、type scale、選択状態、motionはworkspace/Task/review/loginで共有する。ブラウザが外部のfont/icon CDNへアクセスする依存は追加しない。既存の端末、Claude/Gemini/Codex接続、ファイル閲覧、会話の履歴と送信先を維持する。

## 改修の順序

1. Task・Review APIの現状を基準に共通shellと実データの作業一覧を実装する。
2. Task/reviewを同じ設計で再構成し、深いリンク、キーボード、空・通信失敗・停止・受入取消の状態を検証する。
3. 次の知識管理・統合・Jevの操作をこのshellへ接続する。未実装機能を装飾だけの操作として出さない。
4. PCと320/375pxでブラウザ検証。ネイティブ端末のsafe-area/keyboard確認と人間の受入は別の残存gateとして記録する。

## 参考

- [Material 3 Expressive: building guidance](https://m3.material.io/blog/building-with-m3-expressive)
- [Google Design: expressive design research](https://design.google/library/expressive-material-design-google-research)
- [Material: canonical layouts](https://m3.material.io/foundations/layout/canonical-examples/overview)

本UIにGoogleの調査結果と同じ効果があるとは主張しない。Web向けの独自実装であり、Android Composeの公式component implementationを使用するものではない。

## 実装と検証（2026-10-01）

- 共通tokensとSVG、ライト/ダークテーマ、selectionと押下のshape変化を実装。認証画面・作業一覧・Task・レビュー・チーム・使用状況・資料選択を同じ基準へ接続した。新しいfont/icon CDNや依存パッケージは追加していない。
- 作業一覧はCookie認証付きのTask/レビューsummaryを参照する。実行開始や成果受入は行わない。未取得・通信失敗・個別Taskの状態不明を実行中0件へ置き換えない。訂正・取消・integrity errorも要確認へ含める。
- プロジェクト/文字検索、未接続、深いリンクの対象不明を確認。指定対象が無いときは別成果へ自動で移動しない。フィルタしても判断待ちの成果を隠さない。HTTP失敗の合成応答では値を「—」とし、再取得後に実データへ戻ることを確認した。
- Task/成果の一覧が空の合成応答から、ページの更新ボタンで実カタログを再取得して詳細が表示されることを確認した。成果では再取得後にも合成台帳の受入取消が維持された。
- Taskの生成済み成果はMarkdownとして表示し、契約上の受入条件・記録された検証・完全な原文を保持する。HTMLは文字列として描画し、リンクはhttp/httpsだけを許可する。表示整形は受入判定を変えず、署名とartifact hashは完全な原文を対象にする。
- Chromiumの1440px/320px/375pxで作業一覧、Task、レビューを確認。320pxのTask/レビューはclient/scroll幅305pxで一致した（デスクトップscrollbarを除く）。操作ボタン48px、入力52px以上。スマホでは本文からコメント/受入へ移動できる。
- 合成専用成果で自由文保存・明示受入・理由付き取消と再起動後の保持を確認。HTMLコメント・成果内scriptは実行されず、javascriptリンクにhrefが付かないことを確認した。実Taskの現在の修正版は未受入のまま。
- キーボードでdrawer、資料/担当追加のnative dialog、Escで手前だけを閉じる操作とfocus復帰を確認。ライト/ダーク設定は非機密の`negi-theme`だけを保存し、旧認証tokenは削除する。reduced motionではanimationがnone、transitionが0sになることを確認した。
- 標準TSテスト621成功・2スキップ・失敗0。Python36件、型検査、ビルドも成功。最後の画面調整後に関連52テストとブラウザ操作を再確認した。新規モデル/Jev turnは追加していない。

スクリーンショットと合成QA台帳はローカルの`output/playwright/`と`.ebi-team/material3-ui/`に保存し、公開差分には含めない。実機iPhone/Androidのsafe-area・仮想キーボード、実ユーザーによる使いやすさの受入、全通常dispatchのTask Contract移行、統合実行/Jev画面は残る条件である。

### 知識の承認画面

[Phase 6の知識循環](../negi-teams-phase6.md)を`/knowledge`へ接続した。レビューの指摘原文→候補編集→限定的な参照の承認→理由付き失効の順に操作する。PCでは一覧・詳細・承認pane、スマホでは候補切替と単一詳細を使う。元の指摘と対象成果へ戻れる。途中の保存は同じ署名済み操作の再試行で回復し、手編集は上書きしない。成功・進行・エラーの表示色も分けた。

Chromium1440px/320px/375pxで編集・承認・失効・テーマ再読込を確認した。320px/375pxのclient/scroll幅はそれぞれ320/375pxで一致し、ボタン48px以上、入力52px以上、右端は幅内だった。指摘のHTML文字列は実行されない。ブラウザのHTML pattern仕様でハイフンを含む分類欄がエラーになる問題を修正し、再読込後のエラーがないことを確認した。通常schedulerの次の合成Taskで参照と失効を確認し、実カタログは読み取り専用で開いた。実Taskの現在の版は未受入、実Vaultは変更していない。

### 統合成果のレビュー

[Phase 4の署名付き統合レビュー](../negi-teams-phase4.md)を同じ成果一覧とレビューpaneへ接続した。本文・受入条件・検証・折りたたんだ元Taskの版/hashを読み、明示受入と理由付き取消を行う。元Taskや統合checkoutが変われば受入を止め、表示した固定版を保持する。統合の実行は別のCLI操作である。

合成果で1440px/320px/375pxを確認した。320pxはclient/scroll305px、375pxは360pxで一致し、版を展開しても右端が収まる。操作は48px、ダークテーマ・コメント保存・受入・取消・レビューサービス再起動後の保持も確認した。実統合成果は読取のみでレビュー待ちのまま。実機と実利用者の受入は残る。

### 最初のプロジェクト

[初回設定](../negi-teams-project-setup.md)を同じshellへ接続した。PCは作業場所と担当条件を並べ、スマホは入力順に読み進める。確認した正確な条件と保存操作を分け、保存後は再起動待ち、起動確認後は新規Taskと統括チャットを表示する。モデル確認が失敗した場合は保留を示し、作業の開始を受け付けない。

通常ビルド済みサーバーで1440/320/375px・ライト/ダーク・キーボード保存、検証の追加/削除、詳細の展開、再起動後の導線を確認した。Taskをまだ作っていない状態で実CodexのChatGPTログインと両モデルの起動条件を確認した。スマホのチャット空欄案内の切れも短い案内で修正した。設定の編集・移行、実機safe-area/keyboard、人の受入は残る。
