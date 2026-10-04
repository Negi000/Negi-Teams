# Task環境の起動経路

## 2026-10-04: 保存方式と実行経路を分ける

NT-010の単一スケジューラを使う環境では、旧ebi-teamのPTY・通知注入・要約を別の実行経路として併用しない。`NEGI_STORAGE_MODE=indexed`、`NEGI_TASK_CONFIG`、`NEGI_SETUP_ROOT`のいずれかを起動時に指定したホストをTask環境とする。保存方式が`legacy`でも同じ境界を使う。未保存のsetupやサービスの開始失敗によって、この判定を旧起動へ戻さない。

修正前の隔離プローブでは、Taskカタログとlegacy保存で旧`/control/spawn`から`Registry.spawn`に到達した。呼出し直前のsentinelで停止しており、実際のPTY・モデルは起動していない。HTTP 400はこのsentinelの拒否で、製品の実行境界による拒否ではなかった。

### 管理する経路

- 統括への明示入力はCodexチャットから行い、`masterTurnAdmission`で共有枠を取得する。
- 担当の開始は登録済みTaskの契約と実行管理を経由する。固定契約、検証、停止、unknown保持、レビューを維持する。
- 固定設定の統括は最大1件。`master`・`ui: chat`・`brain: codex`と読取専用の明示起動条件を必要とする。全設定を起動前に検査し、旧担当の混在や複数統括を部分起動しない。
- 保存済みsetupはサーバーが生成する1つの統括を使い、索引構成の会話authority・再開・明示切替を維持する。

複数の有効な統括を許す旧構造では、後の`masterSession`が先のsessionを上書きし、先のプロセスが終了管理から外れる。独立レビューで発見したため、Task環境では複数設定を起動前に拒否する。複数常駐統括のsession mapを実装したという意味ではない。

| 入口 | Task環境の動作 |
| --- | --- |
| HTTP POST `spawn / inject / reverse-inject / send / summarize / setMode / chat-permission` | `/control/`配下で409。要求本文の解釈・実行より先に拒否 |
| WebSocket `spawn / input / setMode / summarize` | 実行前に契約・チャットの案内を返す |
| 直接のspawn・send・要約helper | 同じTask環境の判定で拒否 |
| capabilities | 担当追加・旧要約を無効とする |
| Taskと保存状態の読取 | 既存の認証・開始保留・authority検査を維持 |
| 旧agent一覧・資料・添付・usage/ACK | 新しいモデル実行を起こさない既存操作を維持。保存保留時の既存503は優先 |

Taskカタログとsetup rootを指定しない独立した互換ホストでは、既存のClaude/Gemini等の動的・固定起動とSupervisorを残す。旧コード・設定・履歴を削除していない。Taskの失敗から同じ書込依頼を旧PTYへ自動再送する経路は追加しない。

### M3画面

共通Material 3 Expressive画面は、Task環境のcapabilitiesに従って「担当を追加」を表示しない。未接続のチームでは、統括の接続確認と作業一覧への操作を示す。Taskの深いリンク、契約のキーボード開閉、再読は使える。空状態の案内は`text-wrap: balance`で、文末2文字だけの行を避ける。

### 検証

- 関連5ファイル30/30成功、失敗・取消・skip 0（226822.1113ms、exit 0）。この実行の途中に統括数制限を追加したため、最終変更後の全件実行とは扱わない。
- 最終の境界テスト6/6成功、失敗・取消・skip 0（34211.913ms、exit 0）。実HTTP/WSと起動前sentinelで旧HTTP7経路・WS4操作、未保存setup、破損catalog、単独の旧担当・Claude chat・Codex terminal、混在、2つの有効統括、独立互換を確認した。共有schedulerのsubmit/claim/settleとチャット1turnは合成providerで、実モデルではない。先行30件と合算しない。
- 型検査、最終ビルド、差分検査が成功。最終client assetsは`index-DHYLeU02.css` / `index-pKJQL3xk.js`。
- compiled通常serverとCookieログインでGUI7ケース成功。1440×1000・375×812・320×812の明暗、旧追加操作非表示、Taskの深いリンク・契約のキーボード開閉・reload、独立互換の追加dialogを開きEscapeで取消を確認した。横超過・overlay・console/page error 0。Taskの実行操作は押していない。
- 案内の行文字数は1440/375pxで16・17、320pxで10・10・13。最終320px暗色・1440px明色の画像を直接確認した。UI確認中のserver/CSS原文SHAは一致し、所有server/browserは終了した。実モデルturn・PTY開始0。
- 独立読取レビューで複数統括問題を修正後、新たな具体的な旧起動迂回は確認されなかった。実provider・全体テストはレビュー側で実行していない。

最初のlegacy用合成providerは非residentの省略configに対応せず起動失敗、次の合成turnもfixture threadの保存不足で停止した。要求を再送せずfixtureごと終了し、fixture対応と観測先の誤りを修正した。実providerの改善へ換算しない。最初のGUIも同名の非表示optionを待つselector誤りで失敗し、修正後に全ケースをやり直した。失敗・最終証拠は公開差分外に保持する。Browser plugin not availableのため既存Playwrightを使った。

### 残条件

これは管理ホスト内の実行境界の進捗である。外部の旧process・別ホスト・同一OSユーザーの別writerを隔離する証明ではない。native Luna調査の無条件保留を継続する。構造的MCP隔離、実Astra→Sol→レビュー→Astraの通し作業、実機safe-area/仮想キーボードと人間受入など、Phase0–8の残条件を維持し、全73要件のゴールはACTIVE。
