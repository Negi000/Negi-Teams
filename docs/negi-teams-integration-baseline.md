# 受入済みの統合成果から次のTaskへ

## 接続した導線

通常の統合レビューに、Material 3 Expressiveの「次の作業へ」を追加した。

1. 元Taskの固定版・差分・記録された統合検証をレビューする。
2. その版を人が受け入れる。
3. 対応する設定済みプロジェクトで「次の作業の基準を保存」を選ぶ。
4. 「続きの契約を確認」から、その基準を引き継ぐ契約案だけを表示する。まだ案がない場合は、先行成果へのリンクを含む依頼文をコピーし、続きの目的を統括へ伝える。
5. Astraが仕様を読み、保存済み基準を選んだ新しい契約案を作る。人の確定操作で、そのGit基準から専用worktreeを作り、既存schedulerへ登録する。
6. 通常のTask開始・Solへの直接実行・検証・固定差分レビューへ進む。

元の分解案の後続nodeを、そのまま古い基準で実行する操作ではない。保存した先行成果と新しい契約の基準SHA・レビュー・元Task・統合manifestのhashを記録する。受入前、取消済み、版や保存証拠が変わった基準は次の作業へ使えない。

## 保存と実行の境界

- 保存先、モデル、コマンド、検証条件、権限は設定済みprofileを継承する。ブラウザとnative toolは新しいパスやコマンドを登録できない。native toolは基準の保存・レビュー受入を行えない。
- 統合checkoutとprofileのGit common directoryが一致するときだけ、そのprofileへ基準を結び付ける。大文字小文字の同一視はWindowsだけで行う。
- 受入済みの固定ファイルを別indexでGit tree/commitへ保存し、`refs/negi/baselines/<id>`へ固定する。元checkoutのHEAD・index・作業差分を維持する。これはローカルのチェックポイントであり、外部へのpushは行わない。
- browser操作のintentと保存結果を別々の署名証拠へ結び付ける。結果record、ref、tree、parent、manifest、受入、元Taskの固定成果を照合する。protected storageは、統合checkout・別catalogを含む全登録model writable rootと重ねない。
- 受入取消と、基準保存・案の保存・契約確定・開始要求・schedulerのclaimを、レビュー単位の共通lockで順序付ける。開始要求と実行枠への入場を区別し、待機中に取消が先に完了した場合はprovider起動前に停止する。
- 単なるlock競合ではqueued Taskを取消さず、停止signalとTaskの時間上限に従って入場を待つ。claim済みの進行中Taskを、先行成果の受入取消だけで自動再送・巻戻しすることはない。
- 再起動は署名済みの既存契約/worktreeを登録し、通常開始とclaimの条件を復元する。providerを再送しない。

## 途中停止の扱い

intent・署名・ref・recordの一部だけが残った場合は、画面で照合待ちを示す。別request IDで保存をやり直さない。元の操作を確認し、同じ認証済みrequestに限って既存内容を照合できる。停止後のdecision/writer lockは自動削除しない。通常画面からの手動照合・取消・再開の一式は、引き続き未完了である。

## 確認した範囲と残る条件

実Git・Vault・HTTP・署名・通常Task service/schedulerを使う専用fixtureで、独立2Taskの検証済み変更 → 統合 → 人の操作を模した受入 → 保存した新基準 → native toolの後続案 → 契約確定 → Sol fixture → レビュー待ちを確認する。追加Astra attemptは0で、後続の人間受入はnull。改変、取消、別repository、保護領域重複、同時保存、同じintentの途中状態、再起動、Cookie/same-origin、入場lockの競合も検証対象とする。fixtureの受入を、利用者による実成果・実UIの受入とは扱わない。

実subscriptionでの統合後計画、任意の実コード変更・競合解消、通常UIからの統合実行/第三worktree準備、実機safe area/仮想キーボード、全73要件の完成は未証明。既存の統合実行は信頼済みローカル設定/CLIによるもので、この追加は登録済み統合レビューから後続契約を作る経路を接続する。

全Phase0〜8とNT-001〜NT-073を維持し、残る旧dispatch移行、provider照合、通知再発行、Jev全gate/日本語校正/残高上限、知識の複数事例/寿命/派生失効、政策の利益実証/承認、履歴最新性、初回profile設定・契約版移行・会話との結果関連付けを省略しない。

最終検証（2026-10-02）: 標準TS700件中698成功・失敗0・2skip、型検査・ビルド成功。実Gitを使う合成結合で上記の接続を確認した。Chromium1440/320/375px・light/dark、版の展開、48px操作、キーボードによる契約確定を確認。実モデル・実機・利用者の受入とは区別する。
