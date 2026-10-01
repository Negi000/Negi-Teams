# 統括から登録Taskを委任する

2026-10-01。明示設定したCodex chat Masterが、Task画面と同じ固定カタログ・`LocalTaskService`・単一schedulerを使用する接続。

## 起動と操作

既存のCodex Masterのopt-in設定と、起動時の`NEGI_TASK_CONFIG`を使用する。モデル・effort・Codex実行ファイルは明示設定を維持する。通常の統括起動はChatGPT認証を確認してからモデルのthreadを開き、APIキーを子プロセスへ渡さない。CLIの変更は新しい起動設定で確認し、過去のrun設定は書き換えない。

| 操作 | 入力 | 結果 |
|---|---|---|
| `negi_list_tasks` | 任意のproject・offset | 10件ずつの固定カタログ、契約ID・版・設定hash |
| `negi_read_task` | 登録済みrun ID | 完全な固定Task Contract、担当、検証・人間受入・現在の状態 |
| `negi_dispatch_task` | run ID・カタログのconfig hash | Task画面と同じschedulerへの一度だけの開始要求 |

チャットでは「Task一覧を取得」「Task契約を確認」「Taskを委任」と表示する。展開すると操作の識別子と入出力を確認できる。Task画面は利用者の開始と統括からの委任を区別する。古い起動元未記録のrunを利用者操作と推定しない。

## 固定する境界

- serverが登録した3操作だけをproviderへ渡す。workerには渡さない。
- thread・turn・call IDを照合する。同じcallの再送は同じ結果を返し、異なる引数でのcall ID再利用は拒否する。
- 起動要求は会話IDへ結び付けて永続化する。UIとの同時開始やサーバ再起動でも同じTaskを再実行しない。
- 契約・担当モデル・コマンド・checkout・承認・成果受入をモデル入力から変更しない。
- 完全な契約を返せない大きさのTaskは委任前に停止する。切断や結果不明時はTask画面で照合し、自動再試行しない。
- 統括の委任記録は人間の署名付き操作承認・成果受入とは別の記録である。

## 確認と残る範囲

現在のCLI 0.159.2の生成したexperimental schemaを確認し、通常サーバのMaterial 3チャットから実Astraによる一覧・固定契約の読取を観測した。既存Task・Vaultの参照ノート・二つのcheckoutは前後で変化しなかった。実Taskの開始・停止・許可・受入はこの接続確認では行っていない。

合成Taskでは委任・重複・UIとの競合・再起動・契約hash不一致・大きな契約の拒否・人間受入の未生成を確認した。Chromiumの1440px/320px/375pxでチャット結果の展開、起動元、レビュー待ち、48px角の停止ボタンを確認した。実機のsafe areaと仮想キーボードは未確認。

未登録の自由な依頼から新規Task Contractを確定する導線、旧MCP/PTY委任の全面移行、常駐統括自体の共通実行枠への計上、統括への完了通知は残る。この登録Task接続を全通常dispatchの移行完了とは扱わない。
