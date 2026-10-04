# Phase 4: 単一スケジューラの土台

2026-10-04に[Task環境の旧dispatch境界](negi-teams-managed-dispatch.md)を追加した。保存方式がlegacyでもTaskカタログ/setup rootを指定したホストは旧PTY/注入/要約を開始できず、固定統括は共有枠を使うCodexチャット最大1件に制限する。Task未設定の独立互換ホストは維持する。合成・GUI・実provider・人間受入を分け、外部旧processの隔離やNT-010全体の完了とは扱わない。

`src/server/orchestration/scheduler.ts`は、登録済みの作業だけを開始するローカルJSONL台帳である。実モデルの起動、承認、OS sandboxは持たない。`scheduledVaultRun.ts`がVault契約に基づくAstra→Solの1runをこの受付へ通す。

2026-10-03に、[明示的なLuna読み取り専用Taskと専用成果レビュー](negi-teams-luna-tasks.md)を追加した。role/mode、Context Pack、計画→作業枠、native process owner、権限要求拒否、tool authorityの保留、変更ゼロの固定検証を分けて記録する。通常Task・raw/template契約案・並列CLIからの専用成果登録、署名付き受入/取消・再起動復元・元Astra通知を接続し、Material 3 ExpressiveのPC/スマホ画面で操作した。researchはWindows専用で、実model調査turn・tool-free profile・approved Policy選択は未完。既存Git差分レビューを空差分対応へ緩めない。

## 現在の保証

- 全体同時実行枠、checkoutごとのread/write競合、宣言された共有資源、依存作業の検証済み状態を開始条件として確認する。別のcheckoutでも全体枠を共有する。
- 同一dispatchキーの再使用は実行を再開しない。JSONLへのclaimを先に同期保存し、実行結果が不明なら枠と書込資源を保持する。再起動後も`needs_reconciliation`を読み戻し、根拠付きの照合を経るまで次の作業を開始しない。
- 予算はdispatch前の**計画上の予約額**。未取得費用を実請求0円とせず、予約額を消費したままにする。これはプロバイダーの課金上限ではない。
- 依存先が失敗・取消・blockedなら後続をblockedへ伝播させる。成果の`verified`には証拠参照を要求し、人間の`accepted`とは区別する。

スケジューラとVault/read-only wrapperの12件の合成テストで同時claim、依存、同一checkout競合、結果不明後の再読、重複dispatch、予算、不正ログ、事後失効を確認し、`npm run typecheck`は成功した。実モデルのv2縦断試行はこの受付を通り、Astra→Sol完了後に`verified`を記録した。v1はprovider結果不明中に枠を保持し、根拠付き放棄の後に解放した。

## Lunaと並列の実試行（2026-09-30）

導入中のApp Serverで`gpt-6-luna`/`low`の読み取り専用smokeが完了した。続く限定調査も`scheduler`を通してLunaが2ファイルを読み、checkoutを変更せず成果を保存した。観測した最後のusageは入力25,515、出力160（cached input 20,224）。usageのturn全量保証と金銭費用は不明。

さらに`scripts/negi_phase4_parallel_live.ts`で、同一基準SHAの別checkoutからSolとLunaの読み取り専用turnを同時に開始した。台帳では両方が13:28:49 UTCにclaimされ、Lunaが13:29:13、Solが13:29:25に機械検証を終えた。両checkoutの`git status`は前後で同じだった。依存していた統合は両方の終了後にだけclaimされ、出力ファイルのhashを照合して結合した。

**事後レビューでLunaの内容に誤りを発見した。** 指定された`src/server/index.ts`には`registry.spawn`の呼出しが実在するのに、Lunaは指定範囲で確認できないと書いた。最初の検証は単語の存在だけを見ていた。`scripts/negi_phase4_audit.ts`がコードと原文を突き合わせ、append-onlyの`invalidate`イベントでLunaと依存する統合の状態を`failed`へ変更した。Solの限定調査は`verified`のまま。元の機械検証・成果・事後監査は`.ebi-team/phase4-parallel/`に保持する。統合成果を受入済みとは扱わない。次回用の検証では該当呼出しの行番号も要求するが、自然文の正しさ全体を保証しない。

改善した条件で別台帳の再試行を1回行った。Lunaは`registry.spawn`を`src/server/index.ts:1221`と`:1251`に特定し、原文との照合も一致した。Solの回答は`createMasterBrain`を含む接続説明として原文と整合するが、機械検証が要求した`MasterSession`という文字列を省略したため`failed`になった。依存する統合はclaimされていない。成果と台帳は`.ebi-team/phase4-parallel-v2/`に保存し、失敗状態を後から成功へ書き換えない。改善した条件でも自然文の品質と機械検証の一致を一巡で満たせていない。

## 別checkoutへの差分統合

`taskIntegration.ts`は、同一基準SHAの2〜8件の検証済み成果について、固定manifest・成果・検証根拠・Task/scheduler状態を照合する。所有ファイルが重ならないことを確認し、cleanな別checkoutへcreate/edit/deleteを適用して統合検証を行う。原checkout・主作業ツリーへのコピー、モデル起動、commit、push、人間受入を自動で行わない。部分適用後の例外は枠を保持して照合待ちにする。

実Gitを使った合成6件で、別所有ファイルの並列claim後の統合、修正版の選択、重複範囲、基準差、検証失敗、部分停止を確認した。

2026-10-01に、別々の20行以内の文書を所有する2つのactive Vault Taskを、`negi_run_parallel_tasks.ts`から実Astra→Solで並行実行した。両runは03:50:30 UTCに共有schedulerでclaimされ、それぞれ03:52:24、03:52:31に検証済みになった。追加モデルturnはAstra2件・Sol2件。最初の統合読込はWindowsのパス区切りの差で拒否されたため、成果を変えず同一パスの判定を修正した。続く`negi_integrate_tasks.ts`は両sourceの検証済み状態を再読し、03:54:39に別clean checkoutで統合をclaim、03:54:42に両文書と基準・範囲の再検証を終えた。原checkoutは保持され、commit/pushと人間受入は行っていない。これは2つの文書のcreateを実証したもので、コード変更の競合解消や削除の実モデル試験ではない。

## ローカルCLI入口

`node --import tsx scripts/negi_run_parallel_tasks.ts <absolute-tasks.json> <absolute-reviews.json>`で、[Task画面と同じ登録形式](negi-teams-task-ui.md)の2〜3件を実行する。全Taskのpreflightを済ませてから同じschedulerへ投入し、同一runの再投入を拒否する。CLIでは操作承認を自動拒否し、承認が必要な作業は停止する。Task画面の初期pumpは引き続き直列である。

`node --import tsx scripts/negi_integrate_tasks.ts <absolute-integration.json>`で、登録済みTaskの最新成果を別checkoutへ統合する。設定例:

```json
{
  "taskCatalog": "D:/runs/tasks.json",
  "reviewCatalog": "D:/runs/reviews.json",
  "id": "integration-1",
  "sourceRunIds": ["task-a", "task-b"],
  "baseSha": "実際の同一Git基準SHA",
  "checkout": "D:/worktrees/integration-1",
  "outputDir": "D:/runs/integration-1",
  "verification": [{
    "requirement": "両変更を合わせた動作確認",
    "program": "D:/tools/node.exe",
    "args": ["scripts/check-integration.mjs"],
    "timeoutMs": 30000
  }]
}
```

出力先の親を事前に作り、対象checkoutを同じ基準でcleanにする。sourceは同じcatalog/schedulerに登録され、現在のレビュー・Task・scheduler・成果・検証根拠が一致する必要がある。修正版は原版のmanifestではなく最新の固定版を使う。任意のシェル文字列を受け取らず、信頼済みローカル設定のprogram/argvを起動する。統合結果の`ready_for_review`は機械検証済みを意味し、統合結果の人間レビューは現在ローカルGit差分で行う。統合結果の署名付き受入画面は未接続。

## 完了前の残件

- 既存Master/worker/UIの全起動経路を単一受付に統合していない。直接起動された外部CLIをスケジューラだけで阻止できない。Sol/Lunaのread-only並列と2つの別所有文書の実モデル書込・統合は確認したが、実コードの変更・競合解消・人間受入は未検証。
- resource名は呼出側の申告に依存する。checkoutの相対パスを拒否し大小文字は正規化するが、シンボリックリンク等の別名と外部編集を完全には検出しない。共有DB・生成ディレクトリは明示的なclaimが必要。
- 統合結果の署名付きレビュー画面は以下の登録経路へ接続した。実成果への人間受入は未実施。統合の実行自体はCLIで、競合解消や通常workerの全面接続は残る。dirty worktreeの削除はしない。
- JSONLの不完全な末尾と残った`.lock`は自動修復しない。元ファイルと稼働中writerを確認してから対応する。

ロールバックは`scheduler.ts`、`scheduledVaultRun.ts`、対応テストとこの文書の差分を確認して戻す。ローカル台帳は`.ebi-team/phase3-live/`に残るので、未受入・結果不明の証拠を保全した後に扱う。

## 統合成果の署名付きレビュー（2026-10-01）

`NEGI_INTEGRATION_CONFIG`を絶対パスで指定し、`EBI_AUTH_TOKEN`と`NEGI_REVIEW_CONFIG`を設定する。起動時に、既に検証済みの統合成果だけを登録する。ブラウザからcheckout、検証コマンド、source catalogを追加する入口はない。この登録ではモデル起動、差分適用、commit、pushを行わない。

```json
{
  "integrations": [{
    "id": "integration-1",
    "title": "二つのTaskの統合成果",
    "taskCatalog": "D:/runs/tasks.json",
    "reviewCatalog": "D:/runs/reviews.json",
    "sourceRunIds": ["task-a", "task-b"],
    "baseSha": "実際の同一Git基準SHA（40桁）",
    "checkout": "D:/worktrees/integration-1",
    "outputDir": "D:/runs/integration-1",
    "evidenceSha256": "integration-verification.jsonのSHA-256（64桁）",
    "limits": "人間に確認してほしい範囲と未検証の経路"
  }]
}
```

`outputDir`は元Taskと統合のcheckout・Vaultから分離し、署名storageもmodel writable rootsと成果から分離する。元Taskは指定したcatalogの認証済み台帳readerで読む。統合schedulerの依存・基準SHA・固定された外側/検証programの根拠・元Taskの版/契約/成果/検証hash・所有ファイル・内容を照合する。ファイルのmode変更など、元の統合入口が対応しない変更は保留する。Windowsでは実行権限bitのOS検査を行わない。

完全な差分、新規文書、元Taskの受入条件、検証記録、出典の版を`integration-review-result.md`とmanifestへ固定する。Material 3 Expressiveの共通`/reviews`画面では成果本文・検証・「統合元のTask」を確認できる。受入直前にも現在のcheckout、元Task、根拠を再照合し、原文のhashを署名する。元Taskの失効、新版、内容変更、余分な変更があれば受入を止め、表示済みの原文を保持する。HTMLを実行しない既存の表示規則も維持する。

コメント保存、明示受入、理由付き取消は別操作である。受入・取消の正本は署名を検証するReviewChainで、元Taskを自動受入にしない。元の`integration-result.json`の`acceptedBy: null`は統合時点の機械記録として変更しない。schedulerの`verified`も人間受入とは別である。再起動は固定artifactと署名台帳を読み直し、createだけ保存された台帳も検証イベントを補って復旧する。署名鍵は個人SSOや同一OS権限のプロセスを隔離する仕組みではない。

検証: 標準TS638件中636成功・2スキップ・失敗0。固定原文の再生成照合を加えた後の関連21件も成功。最終のmetadata/現在版/原文照合の3件、型検査、ビルドも成功。実モデルで作成済みの2文書の統合成果を通常サーバーから読取り、レビュー待ち・元Task2件・checkout不変を確認した。実成果の受入は行っていない。Chromiumの1440px/320px/375pxで合成果のコメント・受入・取消・レビューサービス再起動後の保持、変更時の受入停止、版の展開、ダークテーマを確認した。実機は未確認。新規モデル/Jev呼出はない。

統合コメントは署名付きレビュー記録として保持する。複数の元TaskからLessonの適用範囲と根拠を決める経路は未実装で、現在はTask単位の知識候補化を使う。
