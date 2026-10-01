# Vault Taskの実行と成果レビュー画面

2026-10-01。`/tasks`は、ローカル管理者が登録した固定Vault Taskを実行する入口です。目的・範囲・不変条件・検証条件を確認してからAstra→Solを開始し、停止、操作承認、検証結果、成果レビューを追えます。ブラウザから実行コマンドやcheckoutパスを作る機能はありません。

登録Taskは[Codex統括からも委任](negi-teams-master-task-tools.md)できます。Task画面と同じ固定契約とschedulerを使い、起動元を記録します。統括の委任は人間の成果受入にはなりません。

## 設定

知識承認を使う場合は[Phase 6の設定](negi-teams-phase6.md)に従って`NEGI_KNOWLEDGE_CONFIG`を追加します。Taskノートの明示`task_class`をsnapshotへ固定すると、承認済みLessonの適用分類と照合されます。既存snapshotは上書きせず、新しいTask/版の登録として扱ってください。

`NEGI_TASK_CONFIG`に絶対パスのJSON、`EBI_AUTH_TOKEN`にブラウザログイン用秘密を設定して既存サーバを起動します。JSONの`stateRoot`は操作記録と署名を保管する場所、`runs`は登録するTask一覧です。各`config`は[Vault実行CLIの設定](negi-teams-phase3-live.md)と同じ形式です。親ディレクトリを事前に作成してください。

```json
{
  "stateRoot": "D:/runs/task-state",
  "runs": [
    {
      "title": "局所的なUI修正",
      "config": {
        "executable": "D:/tools/codex.exe",
        "checkout": "D:/worktrees/task-1",
        "vault": "D:/Negi-Teams-Vault",
        "snapshot": "D:/runs/task-1-contract.json",
        "outputDir": "D:/runs/task-1",
        "schedulerPath": "D:/runs/scheduler.jsonl",
        "runId": "task-1",
        "astra": { "model": "gpt-6-astra", "effort": "low" },
        "sol": { "model": "gpt-6.1-sol", "effort": "low" },
        "verification": [
          {
            "requirement": "Task Contractに記載した検証文",
            "program": "D:/tools/node.exe",
            "args": ["scripts/check-result.mjs"],
            "timeoutMs": 30000
          }
        ],
        "resources": ["source:task-1"]
      }
    }
  ]
}
```

全登録Taskで同じschedulerを使います。state・output・schedulerは全登録checkoutとVaultの外に置き、各Taskのoutputを重ねません。スナップショットもモデルが書けるcheckoutの外に置きます。Taskの全検証項目を`requirement`で一度ずつ対応づける必要があります。検証プログラムは信頼済みローカル設定として扱い、シェルを通さず起動します。

成果レビューも使う場合は`NEGI_REVIEW_CONFIG`へ次の形式のJSONを設定します。Task完了時に固定差分と検証根拠を登録するため、`cases`は空でも利用できます。署名storageはモデルの書込checkoutの外に置きます。

```json
{
  "storageRoot": "D:/runs/human-reviews",
  "writableRoots": ["D:/worktrees/task-1"],
  "cases": []
}
```

## 操作と状態

1. チーム画面の「Task実行」を開き、ログインして固定契約を確認します。
2. 「契約を確認して実行」で一度だけ投入します。active Vaultの版/hash、参照仕様、Git基準SHA、clean checkout、ChatGPTログイン、出力先と検証対応を実行前に確認します。
3. Astraは読取計画、Solは指定checkoutで作業します。要求したモデルとeffortの能力を確認し、ChatGPT認証とOpenAI providerを確認します。ネイティブの孫agent機能をプロセス単位で無効にします。Task全体の時間上限と個別turnの待機期限を持ちます。
4. 操作承認が来たら、対象、作業ディレクトリ、thread/turn、期限を確認して許可または拒否します。対象が不明な要求は許可できません。結果不明の実行は枠を保持して照合待ちにします。
5. 機械検証が通れば`ready_for_review`で止まります。固定した差分、新規テキストファイル、受入条件、検証記録をレビュー画面で確認できます。100 KBを超えるプレビューや一部バイナリは別のローカルレビューが必要です。
6. 自由文を保存しても受入にはなりません。明示受入と理由付き取消の署名記録をTask台帳へ反映します。差分・ファイル・基準SHA・検証根拠が変わると受入を止めます。

停止はこのサーバが持つ実行プロセスへ送ります。待機中Taskは起動せず取消できます。サーバ再起動後のrunning・照合待ち・queuedを自動再投入しません。新たな実行は別run IDとclean checkoutで登録し、既存の結果不明の処理を先に照合してください。設定を外すと入口を無効にでき、証拠と未受入成果は保持されます。

## 中断した実行を確認する（2026-10-02）

照合待ちのTaskに「保存された実行を確認」を追加しました。明示操作で固定契約、台帳の最後の記録、会話/turn、実行枠、所有プロセス、Git基準と現在の版、変更ファイル、保存済み成果、操作の許可履歴を確認します。ログインが必要なTaskリンクでも、ログイン後に指定したTaskへ戻ります。

確認は保存済みのthread/turnだけを対象にします。ChatGPT認証・OpenAI provider・登録checkoutの一致を確かめ、`thread/read`・`thread/turns/list`・`thread/items/list`から状態を読みます。確認からモデルturn、新しい会話、再実行、割込み、機械検証は開始しません。確認時点と内容のhashを署名保存し、同じrequest IDの再送は同じ記録を返します。更新確認は別request IDです。

通常のTask runnerとCLIは、親の所有記録、provider起動前の意図、子PIDと終了、ホスト側の処理完了をモデルの書込範囲外へ保存します。Windowsでは下記のJob所属終了記録も保存します。終端turnや空のJobだけでは、外部サービス経由を含む起動済み処理全体の終了は証明できません。**実providerの子PIDを持つ照合待ちTaskは終了操作を許可せず、実行枠を保持します。** 所有記録がない旧Task、生存/不明な所有者、未取得/進行中のturn、コマンドや未知のitemを含む履歴も保留します。

終了操作は、子providerを持たない合成runtimeだけで検証した原型です。確認した内容と新しいprovider観測を照合し、署名付き終了判断→Taskの試行をabandoned/Taskをstopped→schedulerをfailedの順で保存します。差分・部分成果を保持し、成果受入や再投入にはしません。完全な署名付き終了判断が残り、現在の差分・成果・契約・所有記録が一致する場合だけ、同じ操作IDで残りの台帳保存を再試行できます。この再試行ではprovider呼出しや検証を繰り返しません。実Taskで終了・実行枠解放が成功したという実証はありません。

### 読取り上限と残る条件

- 台帳/schedulerは各8 MB、snapshot/成果は各2 MB、変更は200ファイル・個別5 MB・合計20 MBまで。リンクやcheckout外のパスを安全な通常ファイルとして扱いません。Git index・差分・変更ファイルのbytesも確認対象です。
- provider itemは最大20ページ、各100件です。重複・不完全なページ・別turn・未知の型・途中で変化した状態は終了の根拠になりません。生のreasoningやコマンド出力は照合記録へ複製しません。
- 操作許可は直近100件、対象の先頭500文字を表示し、全履歴と省略した対象のhash/countを保持します。照合の署名記録は専用storageで512 KBを上限にします。
- readerはローカルの`codex-cli 0.159.2`の生成型に照合しました。`thread/items/list`等に未対応の旧版は取得失敗として保留します。起動前のバージョン判定は未実装です。
- 実プロセス停止後に残るlock、署名proofの部分書込み、不明な途中保存を自動復旧しません。例外後にlockが解放された合成再試行を確認した範囲であり、プロセスkillを含むcrash安全性は未実証です。
- completed成果の完全な救済、検証/人間レビューへの引継ぎ、Astraの継続、汎用の取消・再開・照合は別の残る条件です。

通常ビルド済みサーバーと実Codexの読取接続で、合成の保存済みunknown試行を確認しました。合成thread/turnを実providerで確認できないため、画面は保留と終了不可を表示しました。元checkoutのHEAD・dirty bytes・部分成果は変わらず、モデルturn/Jev呼出しはありません。これは実Taskの復旧成功の証拠ではありません。

### WindowsのJob所属プロセス管理（2026-10-02）

Windowsの通常Task実行では、Astra・Sol・登録された機械検証コマンド・`git diff --check`をそれぞれJob Object内で起動します。読取専用の照合providerも同じ起動方式です。`PROC_THREAD_ATTRIBUTE_JOB_LIST`を用いてプロセス生成時に所属させ、breakawayを許可しません。親の停止・管理通信の切断・supervisorの終了時には、そのJobに所属する処理を停止します。providerが自然終了して子孫が残った場合も、所属する子孫の停止を確認してから終了記録を返します。

終了記録にはroot/supervisor PID、Job ID、helper hash、rootのexit code、所属プロセス数0、観測時刻を保存します。記録と起動時のIDが一致しなければ所有guardを保持します。schedulerが正常/失敗として枠を解放する前にも、起動した全roleの終了記録を確認します。検証結果が不明な場合は、Task台帳上の`blocked`を確定失敗と扱わず、schedulerの枠を保持して照合待ちにします。完了したSolの成果と不明な検証も照合画面で確認できますが、終了操作は許可しません。

ローカル修正版・統合検証のようにTask親ownerを持たないWindowsの検証には、出力名ごとの`verification-owners`記録を作ります。既存のTask ownerを上書きしません。以前の署名済み照合記録は、新しい派生表示項目を持たなくても元bytesのhashを照合して読み直します。

実行条件はWindows 10以降・x64と、インストール済み.NET Frameworkの`Framework64/v4.0.30319/csc.exe`です。trusted output内で同梱C# sourceをコンパイルし、helperのhashを起動前に照合します。コンパイラ取得やインストールは行いません。コンパイル/Job起動が失敗した場合に通常spawnへ切り替えません。Windowsの検証コマンドは実行可能ファイルを指定してください。`.cmd`などshell経由を要するコマンドの自動代替はありません。非Windowsの既存起動経路には、このJob終了保証はありません。

**JobはOS sandboxではありません。** WMIの`Win32_Process.Create`やサービス等の外部brokerから起動した処理はJobの所属外になり得ます。この境界は[MicrosoftのJob Objects仕様](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)と、WMIから起動した子が空Jobの終了記録後も残るネイティブ試験で確認しました。試験ではその試験が所有するPIDだけを後処理しています。外部brokerの制限や追加の停止証明は未実装であり、空Jobを根拠に実Taskの照合終了を有効化しません。原子的な所属の方式は[Microsoftの実装説明](https://devblogs.microsoft.com/oldnewthing/20230209-00/?p=107812)を参照しました。

所属子孫の停止・自然終了・親/supervisor終了・breakaway拒否・RPC/envの維持・検証timeout・正常なVault→Astra→Sol→検証→scheduler精算をローカル試験で確認しました。最後の通常経路は合成App Serverによる試験であり、実モデルの成果品質を示しません。実CodexではinitializeとChatGPT account読取だけを行い、空Jobの終了記録を確認しました。モデルturnとJev呼出しはありません。

最終の標準TS回帰は757件中754成功・3skip・失敗/未完了0、型検査とビルドも成功しました。今回の画面デザインは前回のブラウザ確認時から維持しており、新しいブラウザ/実機試験を実施したという主張ではありません。外部broker制限や実Taskの照合終了が完成したという結果でもありません。

## 確認した範囲

合成Taskの320px/375px Chromium試験で、ログイン→契約確認→開始→操作承認→成果レビュー→自由文保存→受入→取消→チーム画面へ戻る旅程を確認しました。横幅の超過、コンソールerror/warningはありませんでした。この受入は合成QAだけです。

通常のビルド済みサーバのTask画面から、固定Task v2を実Astra→Solで1回実行しました。両者の出力と機械検証を保存してレビュー待ちで停止しましたが、内容監査で文書末尾の証拠の出所に誤記を見つけたため、エージェントの指摘とscheduler失効を記録しました。隔離checkoutの2行だけを訂正して下記のローカル登録を実行し、修正版1の新しい検証・成果・台帳を保存しました。元の版Aと2つのprovider出力は保持され、新しいモデルturnはありません。再起動後のTask→レビュー画面を320px/375pxで確認しました。人間受入は未実施です。

実試行の設定にあった行数確認は改行正規表現が過剰にescapeされていました。保存済み検証は変更せず、別のローカル監査で実際の55行、指定5ファイルの56参照の行が存在することを確認しました。これは自然文の意味や受入条件全体の証明ではありません。

## 同じ契約のローカル修正を登録する

レビュー待ちの未受入成果に、現在の成果hashを対象とする認証済み利用者の訂正、または保存済みのエージェントの訂正がある場合に使います。契約範囲内の修正を隔離checkoutへ適用した後、サーバを止めて次を実行します。

```text
node --import tsx scripts/negi_register_task_revision.ts D:/runs/tasks.json D:/runs/reviews.json task-1 feedback-id
```

ブラウザから任意の修正やコマンドを投入する機能ではありません。固定契約・active Vault・基準SHA・範囲・全検証対応を再確認し、共有schedulerの書込枠を取得して検証します。`verification-rN.json`、`review-result-rN.md`、`review-manifest-rN.json`、`revision-N.json`を新規保存し、元の成果・検証を変更しません。署名付き受入は新しい版に対して別途必要です。

完全な修正journalを保存した後の停止は、再起動時に台帳だけ復旧します。journalより前の不明な停止は枠を保持し、機械検証失敗は証拠付きfailedにします。どちらも再実行や上書きで自動修復しません。部分保存された版番号は手動確認が必要です。取消済み・受入済みの成果や、目的を変える要求にはこの登録を使えません。

通常の旧PTY worker/MCP dispatchはこのTask入口へ全面移行していません。この入口の初期pumpは登録Taskを順に実行します。共有scheduler自体は複数枠と依存を扱えますが、並列書込の統合は別の確認が必要です。worktree・署名・子プロセスenv除外はOS sandboxや個人SSOを提供しません。実機のsafe area・仮想キーボードと、実ユーザーによる実成果の受入は未確認です。
