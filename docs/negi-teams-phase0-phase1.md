# Negi-Teams Phase 0–1: 基準と過去Codexログ診断

この文書の対象は、`NEGI_TEAMS_MASTER_PLAN.ja.md` の Phase 0–1 と `CODEX_START_HERE.ja.md` に対応するローカルの読み取り専用 CLI である。Phase 0–1 の実装自体は既存 ebi-team の UI、認証、MCP、実モデル起動経路、設定を変更しない。現在の作業ツリーには別途 Phase 2・3 の未コミット差分も存在するが、この文書の検証結果や Phase 0–1 の受入範囲には含めない。

## Phase 0 の基準（2026-09-27）

- 上流 `r2sake/ebi-team` をローカルへ clone。checkout は `main`、SHA は計画の基準と同じ `2bbad19d0589c7a78f353813da958d67290c2267`。変更前の作業ツリーは clean。既存 worktree はこの checkout のみ。
- 実行環境は Windows build 10.0.26200、Node v20.17.0、Git 2.46.1.windows.1、Codex CLI 0.158.0-alpha.2.1、Python 3.12.8（`python`）。`CODEX_HOME` は未設定で、ログ候補は Windows ユーザープロファイル配下に存在。WSL とリモートの動作は未検証。
- `package.json` は npm lockfile を使用。`predev` / `prestart` は MCP 設定生成、`postinstall` は Unix の node-pty helper の chmod を行う。インストール前に内容を読み、`npm ci --ignore-scripts --no-audit --no-fund` で依存を固定版のまま展開。認証や MCP 設定を生成・編集していない。
- `npm run typecheck` と `npm run build` は成功。`npm run test:unit` は Windows PowerShell で `test/*.test.ts` が展開されず、テスト起動前に失敗。PowerShell でファイル一覧を渡した全ユニット実行は、既存 `dupDelivery.test.ts` の複数失敗を示し、終了せず中断した。変更前からの失敗として扱い、今回の成功に含めない。既存 `usageHistory.test.ts` と `codexBackend.test.ts` の限定実行は 22 件成功。
- 既存の `usageStore.ts` / `usageHistory.ts` は Claude statusLine 等の現在値・履歴用。過去Codex rollout JSONL の取り込みとは責務が異なるため、これらの保存形式を変更していない。

## 使い方

Python 3.10 以上の標準ライブラリのみを使う。対象を明示し、出力を専用ディレクトリに置く。ディレクトリ指定時は、その下の `rollout-*.jsonl` のみを探索する。`auth.json`、`.env`、任意の個人ファイルは対象外。

```powershell
python scripts/historical_codex.py `
  --source 'C:\Users\<user>\.codex\sessions\2026\09\<rollout-file>.jsonl' `
  --out '.ebi-team\historical-codex'
```

複数の `--source` を指定できる。出力は `.ebi-team/historical-codex/historical-codex.sqlite3` と `report.md`。既存の無関係なファイル・同名の別DB/レポート・出力ファイルのシンボリックリンクがある出力先は拒否する。`.ebi-team/` は既存の `.gitignore` 対象で、レポートには会話本文、ツール引数、ツール出力、推論本文を自動転載しない。元ログへの参照は入力パス、行番号、byte offset、SHA-256 で辿れる。SQLiteの `source_files`、`events`、`event_locations`、`issues`、`usage_observations`、`skipped_sources` に正規化する。同じ入力の再実行は同一イベントとusageを増やさない。コピーやアーカイブ先の重複出現も、同じsession・ordinal・内容で照合する。

保存済み診断が現在の元ファイルと一致するか、内容を再取込せず確認できる。`--status-only`はDBとレポートを変更せず、保存済みパスのサイズ・更新時刻だけを照合してJSONを標準出力へ返す。不一致・保留があれば終了コード2。内容SHA-256と、新しく作られたログの探索は行わない。

```powershell
python scripts/historical_codex.py --status-only --out '.ebi-team\historical-codex'
```

保存済みDBからレポートだけを更新する場合は次を使う。元ログは開かず、DBを読み取り専用で扱う。レポートの生成時刻が新しくても、最終取込時刻や`--status-only`の不一致は解消しない。

```powershell
python scripts/historical_codex.py --report-from-db --out '.ebi-team\historical-codex'
```

レポートは同じ出力ディレクトリに一時ファイルを完成させてから置き換える。書込みや置換に失敗した場合は旧`report.md`を保持し、一時ファイルを片付ける。合成テストで置換失敗を起こし、旧レポートとDB・元ログが変わらないことを確認した。

完全な改行のない末尾行は、JSONとして読めても `incomplete_final_line` として保留する。壊れたJSON、UTF-8不正、未知イベントはそれぞれ区別する。ファイル読み取り中にサイズ・更新時刻が変われば、そのファイルの処理をロールバックし、ほかの入力の処理とレポート生成は続ける。変化中のファイルは `skipped_sources` とレポートに記録し、終了コード2とパスで知らせ、次回の再実行で取り込む。JSONLをファイル全体でメモリに載せず、1行ずつ処理する。ただし非常に長い単一行はその1行分のメモリを要する。

追記されたファイルは、保存済みの元ファイルSHA-256と現在の先頭部分を照合してから、追加行だけをJSON解析する。保留中だった末尾行は先頭から読み直す。先頭部分が変わった場合やparser版が変わった場合はファイル全体を再解析する。整合性確認のためハッシュ計算ではファイル全体を読み込むので、巨大なファイルの再実行時間が追記量だけに比例するわけではない。usageと破損行のレポート生成はSQLiteの結果を順次処理し、responseや破損行の全件リストをメモリに積まない。

usageは `token_usage_record.usage` をresponse単位の増分として優先する。これがないsessionだけ `event_msg.token_count.info.total_token_usage` の累計差分を使う。`last_token_usage`、turn累計、thread累計を同時加算しない。キャッシュ入力は入力の内訳、推論出力は出力の内訳。対象session別のusageを単純和として表示するが、親子間の包含関係が未確認なので請求総量とは扱わない。API請求額、参考単価、サブスク枠はこの段階で算出しない。モデルとeffortは `turn_context` の観測値だけを使い、新しいturnの開始時にいったん不明へ戻す。現在の設定や前turnから埋めない。

親付きsessionの累計通知は、最初の値に親から継承した利用量を含む実ログ例がある。その初回値を基準値として除外し、以後の差分だけを子の観測値にする。途中で初めて現れたフィールドも基準値として扱うため、子自身の最初の利用量が混じる場合は未取得になる。異なるsession間の包括・排他関係までは確定できず、単純和を実際の全体利用量や請求額へ換算しない。

初期のtask境界は観測されたユーザーmessage、`task_started`、`turn_context` のturn識別子による候補であり、セッションを1タスクと決めつけない。`task_complete` はturn終了で、成果受入ではない。テスト結果、Git/CI証拠、明示的なユーザー評価は本文や外部証拠を照合していないため、未確認とする。

同一turn IDが複数sessionに現れる場合を、同一イベントのコピーによる重複とは別に集計する。UUID形式とそれ以外のIDを分け、元ログの行へ戻れる例を表示する。子sessionへの継承や再開もあり得るため、この件数だけでusageの二重計上とは判定しない。

## 検証と現在の制限

```powershell
python -m unittest discover -s test -p historical_codex_test.py -v
```

匿名の合成fixture 14 件で、通常・未知イベント・欠測・破損・末尾途中行・追記の差分解析・同一入力とコピーの再取り込み・累計リセット・モデル途中変更・新turnの設定欠測・usageの欠測と実測0・parser更新時の再処理・親子・複数ファイルの再開候補・compaction・元ファイル不変・外部通信なし・変化中ファイルの隔離と再試行、無関係な同名出力とシンボリックリンクの拒否、セッションをまたぐturn ID重なりの別表示を確認した。実ログは最初に6ファイルを診断し、その後 `sessions` と `archived_sessions` の合計269候補へ拡大した。2026-09-27時点で268ファイル、693,921イベントをローカルDBへ取り込み、1ファイルは書き込み中に変化したため取り込まず保留した。対象範囲、形式、欠測率、重複、モデル/effort、usage、時刻と根拠は `.ebi-team/historical-codex/report.md` に記録した。レポートはDBに累積保存されたファイルだけを対象とし、書き込み中のログや別の保存場所にあるログは含まない。

2026-09-29の再診断では270候補を読み、267件はDB保存版と一致、3件は読取中に変化したため新しい内容を取り込まなかった。保留3件のうち2件は未取込、1件は過去版をDBに保持しており、その過去版は集計に含まれる。現在の内容が全件反映された値ではないことをレポートに明記した。未取込と過去版を混同しない表示は合成テストでも確認した。

その後、9月29日の約5 MBの1ファイルだけを再試行して取り込んだ。DBは269ファイル・695,234イベント、保留は2件になった。このファイルは取り込み完了後にも外部プロセスから追記されており、レポートは記録したbytes/hash時点のスナップショットである。ファイルの更新時刻だけを静止判定に使わず、読取中のサイズ変化も確認している。残る約2.8 GBのログと9月27日開始の活動中ログは、読取中に変化したため未反映または過去版のまま保持する。

同日の保存済みDBを再診断すると、同一イベントの再出現は0件だが、同一turn IDが複数sessionに現れる候補は63種・308 session-turn（UUID形式60種、その他3種）だった。根拠の行はレポートに示す。この重なりは再開や子sessionへの継承でも起こり得るため、重複利用量の確定件数とはしない。

同日の追加1ファイル前の保存済み実ログでは、親付きsession 114件の初回累計を基準値として除外した。7月の子session標本の5行目は親IDを持ち、初回の累計入力が944,829,623、次の累計との差が69,724だった。入力トークンのsession単純和は32,447,313,881から15,847,424,974へ改まった。これは計算方法の訂正であり、費用削減の測定ではない。個人のsource pathとsession IDは公開文書へ載せず、根拠への参照はGit管理外のローカル診断に保持する。最新のスナップショット値はレポートを参照する。

`turn_context`行でのmodel/effort欠測だけでは、行自体のないturnを見落とす。保存済み実ログではturn候補2,233件中152件に`turn_context`がなく、model/effortを未確認として別表示する。

同一sessionに新旧のusage形式が混在し、response増分が一部欠ける場合、累計から穴埋めはしない。親子の包括値との対応、明示的なresume境界、意味的なタスク再分類、テスト合否、品質評価、時間内訳、費用、Windows以外の実行は残る確認事項である。

2026-09-30の再確認では、合成fixtureの14テストが成功した。保存済み診断DBの`PRAGMA integrity_check`は`ok`、外部キー違反と参照箇所のないイベントは0件だった。DBは269ファイル、695,234イベント、355,823 usage観測を保持し、変化中として保留された入力は2件のままである。保存済みの小さい実ログ1件を再取り込みした結果は`unchanged`で、イベント・参照箇所・usage観測の件数と元ファイルのSHA-256は前後で一致した。この確認は全候補の再走査ではない。レポートに成果の裏づけの取得状態と保存済みファイルの最終取込時刻を追加し、保存DBから再生成した。最終取込は2026-09-29 14:18 UTCであり、レポートの新しい生成時刻は現在の全ログを反映した時刻ではない。

同日、保存済み実ログの`turn_context` 1件（2026-04-24のrollout、5行目）と`response_incremental` usage 1件（2026-09-06のrollout、12行目）をDBのsource path・行番号・byte offsetから読み直した。両方とも保存SHA-256とbyte offsetが一致し、前者のイベント種別・turn ID、後者のinput/output観測値も元行と一致した。本文やツール引数は表示していない。これは根拠参照の標本確認であり、全イベントの再照合ではない。

`response_incremental`のscopeを別の実ログでも照合した。9月の保存済み標本の18行目と27行目では、response inputが34,064・49,265、turn累計inputが34,064・83,329で、後者はresponseの和に等しい。outputも799・650に対しturn累計799・1,449だった。元ファイルのSHA-256はDB保存値と一致した。この標本ではresponse値だけを加算し、turn累計を再加算しない扱いが整合する。他のCLI版・欠測形式まで同じとは断定しない。source pathとsession IDはローカル診断で確認する。

同じ9月30日に、保留中だった約21 MBの活動中rolloutを単独で2回再試行し、保存DBは269ファイル・700,674イベントになった。もう1件の約2.8 GBの活動中rolloutは未取込のまま。再試行したファイルもレポート生成後に追記され、保存bytesと現在のbytesが異なることを確認した。取り込み直後の再statで変化を検出した場合は保存済み版を保持して`changed_after_import`として保留に記録するようにし、合成テストを追加した（計15件成功）。ただしレポート生成中や生成後の追記は継続し得るため、保留件数は検出済みの変化だけであり、レポートが全元ログの最新内容を表すとは扱わない。

同日の`--status-only`確認では、保存済み269ファイルのうちサイズ・更新時刻が一致するものは267件、変化したものは2件、未読取・シンボリックリンクは0件で、未取込の保留は1件だった。終了コードは2。元ログ本文、DB、レポートを読み直し・書き換えずに得たメタデータ照合であり、一致した267件の内容SHA-256や新規ログの有無を証明しない。合成fixtureの状態確認テストを加え、計16件成功した。

保存DBを読み取り専用で再検査した結果、`PRAGMA quick_check`は`ok`、外部キー違反と参照箇所のないイベントは0件だった。269 source、700,674 eventと出現箇所、359,083 usage観測、保留1件を確認した。これはDBの構造と参照整合性の確認で、変化中の元ログが全件反映された証拠ではない。

turn境界とusageの対応を(session ID, turn ID)で追加集計し、保存DBからレポートを再生成した。ユーザー入力を観測したturnは1,922、`task_started`を観測したturnは2,227、両者の和集合も2,227。境界候補でusageを観測したものは2,011、未観測は216、usageだけで両境界を観測しないturnは0だった。元行のパス・行番号・byte offsetを例示した。これらはturn境界の観測であり、正式なTask/Run IDや受入済み作業件数ではない。合成fixtureで境界だけ・usageだけのturnを分けるテストを追加し、計17件成功した。

根拠行の標本確認で、旧レポートがusage値のない最初の`token_count`通知を代表根拠に選ぶ例を発見した。集計したトークン値ではなく根拠リンクの誤りとして修正し、実際に加算した通知の代表行を選ぶようにした。累計差分では直前通知も併記する。2026-03-22のrolloutでは旧参照の8行目にusage値がなく、修正後の14行目に`total_token_usage`がある。境界2行目とusage14行目の保存SHA-256・byte offset・turn対応を元ファイルで確認した。代表1行は全加算通知の証明ではないため、レポートに加算通知件数とscopeを表示する。

## ロールバック

新規ファイル `scripts/historical_codex.py`、`test/historical_codex_test.py`、この文書、README の Phase 1 リンク、`.gitignore` の Python cache 2行を戻す。ローカルの派生物が不要なら、内容と場所を確認したうえで `.ebi-team/historical-codex` だけを削除できる。元ログ、認証、MCP、Codexグローバル設定、既存Vaultには変更を加えていない。依存の展開は `node_modules/` のみで、lockfileは変更していない。
