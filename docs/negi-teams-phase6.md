# Phase 6: レビューと知識循環の初期経路

`reviewChain.ts` は、成果A、対象を指定した反応、同一目的かを明示した成果B、Bの検証、人間の受入、失効を別イベントにする。曖昧な肯定や無反応は受入へ変換しない。修正後は古い検証を無効にし、新しい成果のhashと検証を要求する。`FileReviewChain`での受入記録と再読込には、文字列の `user:` 参照に加えて、呼出側が提供する信頼できる承認検証関数の成功が必要である。後述のローカル成果レビュー画面へ明示設定で接続した。

Vault CLIに `create-candidate` と `deprecate` を追加した。前者はLesson/Feedback/Evaluation候補だけを新規作成し、同一IDや同名ファイルを拒否する。後者は既存のcandidate/activeを新版のdeprecatedにし、失効理由と元の出典を保持する。新版Context Packはdeprecatedノートを選ばない。既に保存されたPackを一括書換えする機能はなく、利用側は新しいPackを再生成する必要がある。`activate` の `user:` 参照は既存CLIだけでは人間の認証を意味しない。

## 実記録

Phase 3の実モデル試行の統合マップについて、Solの原文A（SHA-256 `fade306a657516f73e55cdd125bb3fd15713bb5f186643d5684d4fbc4a685954`）にあった証拠の出所の誤記を、エージェントが指摘してB（`7c1a01e5112f86ba1a5df49b190d42b1a0905e8e317d56672e33faa52de6dbfa`）へ修正した。`scripts/negi_review_map.ts` は同一目的の1行修正、指定5ファイルのシンボル、80行以下、限定的な秘密パターンを確認し、ローカルのreview台帳へA→指摘→B→Bの機械検証を記録した。**人間のフィードバックや受入ではない。** 元のPhase 3 runも`ready_for_review`のまま維持する。

この1件から `NT-LESSON-ATTRIBUTION-MAP-001` をVaultの `40_Lessons` にcandidateとして作成した。適用範囲、推奨、非適用例、反例、出典、未確認点を記録した。1件で一般的なPolicy効果は証明できないためactive化していない。

## 残る境界

- 自然な会話からのFeedback分類、対象不明時のUI確認、複数の発言への分割、実ユーザーによる受入、通常チャットからの自動接続は未確認。
- Lesson候補を複数事例と照合し、矛盾・同義・寿命を管理する仕組みは未完成。既存Packの失効通知もない。
- `negi_review_map.ts` の確認はBの内容に限定される。Bを隔離checkoutに再適用して全変更範囲を検証したものではない。

`node --import tsx --test test/reviewChain.test.ts` の2件、`python -m unittest discover -s test -p negi_vault_test.py -v` の14件、実Vaultの4ノート検証は成功した。

## ローカル成果レビュー画面（2026-10-01）

`NEGI_REVIEW_CONFIG`に絶対パスの登録JSON、`EBI_AUTH_TOKEN`にブラウザログイン用の秘密を設定する。登録JSONは`storageRoot`、モデルが書けるcheckoutの`writableRoots`、`cases`を持つ。各caseには`id`、`title`、`ledgerPath`、`artifactRoot`、`verifiedArtifactSha256`、`evidencePath`、`evidenceSha256`、`verificationSummary`、`limits`が必要。台帳と検証は既存のものを指定し、対象hashと実体が一致する場合だけ開く。署名用storageと台帳は宣言したモデルの書込先の外に置く。既存の親ディレクトリを必要とする。

チーム画面のregistryから`/reviews`へ移動できる。この画面はlocalhostでもログインCookieが必要。自然な自由文を対象の版へ保存でき、分類は未確定を選べる。肯定や修正を含む文章の保存から受入を推定しない。明示受入と理由付き取消を別操作にし、同じ操作IDの再投入は重複記録しない。表示した成果の写しをhashで固定し、元成果や検証根拠が変われば受入操作を止める。受入記録はローカルサーバの署名でcase/run/artifact/検証根拠/操作を結び、台帳の読込時にも照合する。

320pxのChromiumで、合成成果だけを使ったログイン→自由文保存→明示受入→取消を画面と台帳で確認した。375pxでも横幅の超過はなく、320pxでは表示中の入力・操作要素が44px以上あった。関連42テスト、型検査、ビルドは成功。合成QAの受入は実作業の受入件数へ含めない。元のPhase 3成果は未受入のまま。

この接続は共有ログインの利用者操作を記録するもので、個人を識別するSSOではない。署名はローカル管理者や同じOS権限の任意プロセスから秘密を隔離するOS sandboxを提供しない。App Serverと通常PTYの親envからブラウザ認証秘密とレビュー・Task設定パスを除くが、宣言外の書込先・OSアクセスの隔離は別の条件。レビュー指摘を通常workerへ差し戻す経路、混合発言の分割と人間確認、Lesson昇格は引き続き接続が必要。

## Task台帳への接続

[Task実行画面](negi-teams-task-ui.md)で機械検証を終えた成果は、基準SHA・差分・新規ファイル・検証根拠を固定してレビューへ登録する。受入時に元checkoutと各ファイルのhashを再確認する。署名付きの受入・取消は対応runのTask台帳へ反映し、再起動後にも署名を照合する。同じ台帳を別caseで登録すること、書込checkout内に署名storageを置くことは拒否する。合成QAで実行・操作承認・レビュー・受入・取消を通したが、実成果の受入は行っていない。

同一契約のローカル修正登録を追加した。指摘の対象hash、元と修正版のmanifest/成果/検証hash、契約の版、基準SHAをjournalへ固定する。共有schedulerの排他下で再検証し、A→指摘→B→検証とTask/schedulerを更新する。journal後の停止はメタデータだけ復旧し、モデルを再投入しない。実Task画面で生成した文書の誤記2行を訂正してこの経路を通し、元Aを保持したBをレビュー待ちにした。修正前の版の受入は拒否する。これはエージェントの訂正による実証で、実ユーザーの指摘・受入ではない。
