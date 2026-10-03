# Negi-Teams / 既存ebi-team接続点

- 契約: NT-TASK-PHASE3-LIVE-MAP v2
- 契約SHA256: e2fce6886cc41cd115899165c1da5334c0f248873e1f80c2241b1501c5943d17
- 基準SHA: 2bbad19d0589c7a78f353813da958d67290c2267
- 根拠: 指定5ファイルの静的コードのみ。実行時検証・import先の追跡は行っていない。

## ファイル別の役割と接続点

| ファイル・実在シンボル参照 | 確認できた役割・接続 |
| --- | --- |
| `src/server/index.ts:397` `startMasterChatSession` | `MasterSession`を生成し、イベント・状態をbroadcast、usageをusageStoreへ渡す。435行でregistry.setChatTargetにrecord/deliverを登録し、452行でsession.startを呼ぶ。 |
| `src/server/master/index.ts:28` `createMasterBrain` | brain IDによる生成窓口。claudeはClaudeHeadlessBrain、codexはCodexHeadlessBrainを生成し、その他は例外を投げる。 |
| `src/server/master/session.ts:232` `MasterSession` | チャットセッション管理。324行で差し替え可能な生成関数を選び、343行でbrain.start、373行でbrain.eventsを処理する。 |
| `src/server/agent.ts:391` `Agent` | PTYエージェント。571行のconstructorでlaunchを受け、589行でbackendを選択、619行で環境を構築、632行でpty.spawnを呼ぶ。 |
| `src/server/backends/codex.ts:90` `CODEX_BACKEND` | Codex用PTYバックエンド定義。115行のbuildArgsでCLI引数を組み立て、167行のinitialInjectTextで役割プロンプトを返す。 |

## 確認できた呼出関係

- チャット起動: `src/server/index.ts:401`のMasterSession生成 → `src/server/master/session.ts:324`のcreateMasterBrain選択 → `src/server/master/index.ts:28`の生成窓口。
- チャット受信: `src/server/index.ts:1006`でsession.sendUserTextを呼ぶ。`src/server/master/session.ts:510`のsendUserTextは543行でbrain.sendへ渡す。
- エビからの配送: `src/server/index.ts:437`でsession.deliverFromEbiへ接続。`src/server/master/session.ts:554`のdeliverFromEbiは560行でbrain.sendを待つ。
- チャット出力: `src/server/master/session.ts:373`でbrain.eventsを消費。サーバに渡したonEvent/onStateは`src/server/index.ts:412`と415行でbroadcastを呼ぶ。
- PTY起動要求: `src/server/index.ts:1207`でLaunchParamsを構築し、1209行でbuildLaunchArgs、1217行でinitialInjectFor、1221行でregistry.spawnを呼ぶ。
- PTY実処理: `src/server/agent.ts:632`のpty.spawnへlaunch.command/args/cwdと構築した環境を渡す。833行でlaunch.initialInjectを読み、838行でenqueueWriteを呼ぶ。
- Codex引数: `src/server/backends/codex.ts:118`でcodexSandboxForを利用し、129行で信頼パス変換、133行でcontrolMcp変換の関数を呼ぶ。
- Codex配送特性: `src/server/backends/codex.ts:149`のsupportsChannelInjectはfalse。152行のhasControlBridgeは引数の接頭辞を検査する。
- Codex初期入力: `src/server/backends/codex.ts:160`のsupportsInitialPromptはfalse。167行のinitialInjectTextはsystemPromptをtrimして返す。

## 未確認事項・接続時の境界

- registry.spawnからAgent生成までの内部配線、buildLaunchArgs/initialInjectForからCODEX_BACKENDへの選択処理は未確認（指定範囲外）。
- createMasterBrainが生成する各頭脳の内部処理・利用可能機能は未確認。master/index.tsのcodex stubコメントだけで実装状態を断定しない。
- CodexHeadlessBrainとCODEX_BACKENDの内部共有・直接接続は未確認。確認した呼出点は別々に記載した。
- MCP変換関数、制御API、Mailbox、Registry、UsageStore、ChatLogの内部動作・永続化の成否は未確認。
- 実環境の設定値、認証状態、CLI版、接続成功、配送到達、再起動成功は未確認。
- Negi-Teams固有の追加アダプタや証拠ストアへの保存APIは未確認。既存接続点の記録であり、新規接続の実装ではない。
- 実モデル試行のAstra計画、Sol回答、ローカル検証は別のローカル台帳に保存した。本書の記述だけで成果の受入や一般的な接続成功を示さない。
