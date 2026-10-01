# Phase 6: レビューと知識循環の初期経路

`reviewChain.ts` は、成果A、対象を指定した反応、同一目的かを明示した成果B、Bの検証、人間の受入、失効を別イベントにする。曖昧な肯定や無反応は受入へ変換しない。修正後は古い検証を無効にし、新しい成果のhashと検証を要求する。`FileReviewChain`での受入記録と再読込には、文字列の `user:` 参照に加えて、呼出側が提供する信頼できる承認検証関数の成功が必要である。後述のローカル成果レビュー画面へ明示設定で接続した。

Vault CLIに `create-candidate` と `deprecate` を追加した。前者はLesson/Feedback/Evaluation候補だけを新規作成し、同一IDや同名ファイルを拒否する。後者は既存のcandidate/activeを新版のdeprecatedにし、失効理由と元の出典を保持する。新版Context Packはdeprecatedノートを選ばない。既に保存されたPackを一括書換えする機能はなく、利用側は新しいPackを再生成する必要がある。`activate` の `user:` 参照は既存CLIだけでは人間の認証を意味しない。

## 実記録

Phase 3の実モデル試行の統合マップについて、Solの原文A（SHA-256 `fade306a657516f73e55cdd125bb3fd15713bb5f186643d5684d4fbc4a685954`）にあった証拠の出所の誤記を、エージェントが指摘してB（`7c1a01e5112f86ba1a5df49b190d42b1a0905e8e317d56672e33faa52de6dbfa`）へ修正した。`scripts/negi_review_map.ts` は同一目的の1行修正、指定5ファイルのシンボル、80行以下、限定的な秘密パターンを確認し、ローカルのreview台帳へA→指摘→B→Bの機械検証を記録した。**人間のフィードバックや受入ではない。** 元のPhase 3 runも`ready_for_review`のまま維持する。

この1件から `NT-LESSON-ATTRIBUTION-MAP-001` をVaultの `40_Lessons` にcandidateとして作成した。適用範囲、推奨、非適用例、反例、出典、未確認点を記録した。1件で一般的なPolicy効果は証明できないためactive化していない。

## 残る境界

### 条件付きLessonのContext Pack選択（2026-10-01）

Vault compiler `phase2-2`に、project内のLessonへ明示的な`task_classes`と`source_versions`（`ID@version:sha256`）を指定する仕組みを追加した。`pack --task-class`が一致し、根拠ノートがactive・現在の版/hash・閲覧範囲に一致する場合だけ参照する。分類不明・別分類・根拠変更・失効・private権限不足では参照しない。明示的に必須指定した不適合Lessonはエラーにする。適用するLessonは本文の非適用例・反例も含め、必須Spec/Taskを削らない。candidateはactive扱いにしない。

この初期実装を、以下の認証付き画面と通常Taskへ接続した。既存のCLI文字列`user:`を認証された承認として扱わない。Python36件で分類・役割・版/hash・状態・project・privateの境界を確認した。

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

## 指摘から次回Taskまでの知識承認（2026-10-01）

`NEGI_TASK_CONFIG`と`NEGI_REVIEW_CONFIG`を設定したサーバに、`NEGI_KNOWLEDGE_CONFIG`として絶対パスのJSONを追加する。内容は`{"storageRoot":"D:/runs/knowledge-signing"}`。既存の親ディレクトリが必要。署名storageは、登録したすべてのVault・モデル書込checkout・レビュー成果の外に置く。設定パスとログイン用秘密はモデル子プロセスへ渡さない。ブラウザから保存先やプロジェクトを登録する機能はない。

レビュー画面で保存した認証付き自由文は、Taskの登録先Vaultに`40_Lessons/NT-LESSON-<操作UUID>.md`としてcandidateを作る。原文、未確定を含む分類、今回/今後の範囲、対象成果hash、元Taskと必須ノートの版/hashを保持する。エージェントの指摘や未署名の台帳記録はこの経路の候補にしない。原文から推奨や一般規則を勝手に推定せず、推奨・非適用条件・反例は利用者が確認して記入する。

`/knowledge`はMaterial 3 Expressiveの共通UIを使う。PCでは一覧・詳細・承認pane、スマホでは候補切替と単一詳細になる。利用者が「候補として保存」し、別操作の「この範囲で参照を許可」を押した版だけをactiveにする。成果の受入は別操作であり、知識承認から推定しない。一件の指摘に基づく限定的な希望で、複数事例による効果やPolicyの改善を証明したものではない。

Task正本のPropertiesに`task_class: code-attribution`などを明示すると、exporterが`taskClass`として固定snapshotへ伝播し、通常TaskのAstra/Sol Context Packにも渡す。分類のない旧snapshotは変更しない。知識候補の分類は未分類の場合に利用者が指定できるが、次回Taskの明示分類と一致しなければ参照されない。根拠ノートのactive状態・版/hash・project・閲覧権限を照合し、日本語の目的文が完全一致しなくても明示分類で関連候補を取得する。必須Spec/Taskは全文を保持し、任意Lessonが容量を超える場合は選ばない。

`scripts/negi_knowledge.py`はサーバのHMAC署名を照合するjournalとCAS Writerである。操作の全文・版・前のhashを署名し、署名を保存してから同じ内容をVaultへ適用する。保存途中では旧active本文を参照しない。最新の署名とノートhashが一致する版だけを参照するため、古いactive本文の復元や承認欄の削除では失効を取り消せない。Writer lockを勝手に削除せず、手編集と競合した内容は上書きしない。再起動または「保存を再試行」で署名済み操作だけを再適用する。保存途中の承認も理由付きで失効できる。

編集は新しいcandidateに戻し、再承認まで参照を止める。失効は理由を署名してdeprecatedにする。根拠が変わった候補は承認を止め、新しい根拠から別候補を作る。新しく作るPackから失効知識を外し、通常runnerもSol開始前と完了後に再生成して差を検出する。以前に保存したPackは実行記録として変更しない。単独の手動`pack`には明示的な`--knowledge-proof-dir`が必要で、これがなければこの経路の知識を参照しない。

署名は既存の共有Cookieで認証されたローカルサーバ操作の証拠であり、個人SSOではない。署名鍵やjournalを読書きできる同一OS権限の利用者・プロセスを隔離する仕組みではない。私的なレビュー全文・Vault・署名・画面fixtureは公開Gitへ含めない。ノート本文17,000 bytes、署名receipt24,000 bytes、journal10,000件などのローカル上限を超えた候補は保留し、原コメントは保持する。

検証: 標準TSテスト627件中625成功・2スキップ。最終変更後の関連58件、Python36件、型検査、ビルドも成功。認証付き指摘→候補→明示知識承認→通常schedulerで次の合成Task→Astra/Sol両入力の参照→失効を確認した。手編集・根拠変更・古い本文の復元・署名改ざん・同時CAS・途中保存の復旧/取消・未認証/別Originも確認した。Chromium1440px/320px/375pxで候補編集・承認・失効・テーマ再読込・HTML文字列の非実行を確認した。実モデル/Jevの追加呼出や実成果の受入は行っていない。実機と複数事例の矛盾/同義/寿命管理は残る。
