# Vault Taskの実行と成果レビュー画面

2026-10-01。`/tasks`は、ローカル管理者が登録した固定Vault Taskを実行する入口です。目的・範囲・不変条件・検証条件を確認してからAstra→Solを開始し、停止、操作承認、検証結果、成果レビューを追えます。ブラウザから実行コマンドやcheckoutパスを作る機能はありません。

## 設定

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
