# 最初のプロジェクトを準備する

2026-10-02。既存TaskやテンプレートTaskを用意せず、Material 3 Expressiveの `/setup` からプロジェクトを準備し、保存条件を版で管理する入口。

## 起動の準備

- コミット済みで未コミット変更のないGitリポジトリを用意する。仕様には別の既存Vaultと有効な必須Specを使うか、この画面で新しいVaultを作成する。既存ファイルを保持する。
- Codexの実行ファイルと検証プログラムは、ホスト上の絶対パスで指定する。Codexには既存のChatGPTログインが必要。
- `EBI_AUTH_TOKEN` と `NEGI_SETUP_ROOT` を設定して通常サーバーを起動する。保存先はアプリの作業ディレクトリ、対象リポジトリ、Vaultと重ならない絶対パス。親ディレクトリはあらかじめ存在する必要がある。
- 既存の `NEGI_TASK_CONFIG`、レビュー・契約作成・統合・知識の設定がある場合、初回設定の保存は保留され、既存構成を使う。既存構成の移行は別の作業。
- 保存後の構成は一つのCodex統括を起動する。既存の固定担当設定と併存させず、競合時は起動を保留する。

作業一覧の「プロジェクト設定」または `/setup` を開き、アクセストークンでログインする。モデルIDと推論強度は利用者が選ぶ。画面はモデルの既定値を代入しない。

## 新しいVaultを作成する（2026-10-02）

初回設定、またはプロジェクトの「追加」で、表示名・VaultのプロジェクトID・Git・Vaultの絶対パスを入力し、「新しいVaultを作成する」を開く。存在する親フォルダーの下に、まだ存在しない保存先を指定する。仕様の本文には目的、守る条件、変更しない範囲を記述する。

「作成する内容を確認」で、保存先とProject・必須Specの本文を読む。文書の全文とmetadata、標準フォルダー、Git基準、承認するhashは詳細から確認できる。入力変更はプレビューと採用チェックを無効にする。「表示した本文を…必須仕様として採用する」にチェックし、「Vaultを作成」を選ぶ。

確認内容を署名してから、標準11フォルダーと `10_Projects/project.md` / `spec.md` を作る。Specはactive・required、Projectへの参照を持つ。最初の本文とmetadataはプレビューどおりで、Taskノートは作らない。保存先はGit・サーバー保存領域・全設定履歴のGit/Vault・他の署名済みVault作成先と重ねない。署名履歴は64要求まで保持し、自動削除しない。

作成後は同じフォームへ場所とIDを戻す。担当モデル・変更を許可するパス・必須検証を入力し、以下の通常の「内容を確認」→設定保存→再起動へ進む。Vault作成と実行設定の承認は別の操作である。仕様の未検証状態を実装完了や人の成果受入には変えない。

### 作成の保存と途中からの完了

プレビューは読み取りだけで、設定履歴を前後で照合する。作成と完了は設定・開始要求の共通writerを保持し、全履歴の保存先を保護する。署名した本文と場所、親とGitのdirectory identity、Git基準を再確認する。別要求や結果不明のTask/providerのwriterをVaultの再開から解除しない。

新しい確認内容には `stageProtocol: owned-seed/1` を含めて署名する。同じ親のランダムな `.negi-vault-seed-<承認UUID>-<seed UUID>` にowner markerを保存し、承認UUID/hash・親identity・seed名・source identity・stage名をtrusted保存領域のstage intentへ排他的に記録する。その後、create-onlyで `.negi-vault-stage-<承認UUID>` へ移動する。claim前の中断で残ったseedは取り込まず、削除せず、明示完了時に別の新しいseedを使う。

stage intentがある場合は「同じidentityのseedのみ存在」または「同じidentityのstageのみ存在」のどちらか一方を照合する。seedは完全なowner markerのみ、stageはすべての既存entry・型・bytesが署名内容に一致するときだけ不足した予定entryを補完する。両方存在/不在、別identity、予定外entry、claimのない新形式stageは保持して保留する。stage intentは既存の最終保存先を取り込む許可にはならない。ready markerは全inventory・実Vault parser・必須参照の検査後に最後に保存し、ready以後の欠落を補完しない。旧署名済み確認はbytes/hashと旧stageの照合規則を維持し、新しいclaimへ暗黙に変換しない。

公開前に、署名hashとstage directory identityをtrusted保存領域のpublication intentへ保存する。Windowsは[MoveFileW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefilew)、Linuxは[renameat2のRENAME_NOREPLACE](https://man7.org/linux/man-pages/man2/rename.2.html)で、既存の保存先へ置き換えずにdirectoryを公開する。Nodeのrename、copy、mergeへのfallbackはない。Linux対応は実装とAPI仕様の照合で、今回の実filesystem試験はWindowsである。

公開からcatalog保存までの中断は、元のintent・移動前後で同じdirectory identity・stage不在・完全なready/inventoryがそろうときだけ完了できる。他者が同じ本文をコピーした既存Vault、異なるidentity、stageと保存先の同時存在は取り込まない。catalogの公開はcreate-only。完了後のcatalogは作成履歴なので、後の正当なSpec改訂やTask追加は保持する。

GETと再読み込みは修復しない。途中の要求を一覧に表示し、本文とhashを確認してから「このVault作成を完了」を選ぶ。繰り返した「Vaultを作成」は未完了要求を自動で再開しない。解除できるwriterは、同じdomain/UUID/hash、完全なowner/PID/date、終了済みPID、native guard内のexact bytes/identity再照合を満たすものだけ。Vaultと設定改訂のwriterには異なるdomainを記録する。生存中・別domain/要求・所有不明・部分記録・domainのない旧writerは保持する。Vaultの補助記録に不整合があっても、既存設定は表示し、Vault操作だけを保留する。

復旧の排他はWindowsではcanonical root/kindを束縛した[名前付きmutex](https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-createmutexw)、Linuxでは世代を分けた永続0 byte fileへの[flock](https://man7.org/linux/man-pages/man2/flock.2.html)を使う。保持processの終了でOSが排他を解放する。Windowsでは親とwriterのhandleを保持して置換を抑え、[SetFileInformationByHandle](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-setfileinformationbyhandle)で開いたwriterだけを削除する。Linuxでは親dirfdと固定名、exact bytes/dev/inoを照合して削除する。古い `.recovery.lock` / `configuration-recovery.lock` は新guardへ流用せず、その存在だけで保全holdにする。PIDのアクセス拒否・再利用による生存・識別不能は解除しない。Windowsでは[Python os.killの仕様](https://docs.python.org/3/library/os.html#os.kill)による終了操作を避け、process handleで終了を調べる。

claim/markerの部分保存、旧stageのmarker前中断、旧復旧guardの残留、未署名記録、外部writerや停電・全強制終了の汎用復旧は未対応で、記録を保持して照合待ちにする。OS guardは協調する同版processの順序付けであり、同じhostの任意書込やモデルのfilesystemアクセスを隔離するsandboxではない。更新時は旧版processを停止してから同版へそろえる。Windowsのdirectory fsync、hardlink未対応filesystem、Linux以外の非Windows環境にも制限がある。Linuxは今回の実filesystem試験の対象外である。既存/dirtyな場所の初回採用、場所・契約版の移行、保存履歴の安全な削除は別の残る作業である。

## 確認と保存

1. 作業するGitとVault、VaultのプロジェクトID、変更を許可する相対パスを入力する。
2. Codex、Astra、Sol、Taskの試行上限と時間上限を入力する。
3. 必須検証を追加する。条件、実行ファイルの絶対パス、JSON配列の引数、時間上限を指定する。
4. 「内容を確認」で正規化した場所、保存時のGit基準、必須仕様のID・版・hash、検証の完全な引数を確認する。入力を変更すると確認は無効になる。
5. 「この設定を保存」でその条件だけを署名して保存する。設定確認・保存は、Codex、選択した検証プログラム、Taskを実行しない。
6. サーバーを通常の方法で再起動し、この画面を更新する。

再起動時にChatGPT認証とAstra/Sol両方のモデル・推論強度・text対応を実アカウントのカタログで確認する。確認できない場合、担当モデルを代替せず、新しいTask・契約案・統合・チャット入力を保留する。起動失敗を成功表示に変えず、自動再起動も止める。

「プロジェクトの準備ができています」から新しいTaskまたは統括チャットへ進む。まだTaskは0件でよい。契約案の確定とTaskの開始は、それぞれ後の明示操作で行う。共通実行枠は計画1・作業2。

保存時のGit/Specは、その確認の記録である。後の契約案は、その時点の基準と必須仕様を再確認する。保存した古いSpecをそのまま現行仕様として渡さない。

## 保存と保留の境界

- 保存はcreate-only。署名・設定hash・完全な確認内容を照合し、同じ要求だけを重複保存として扱う。
- 保存先に既存の実行記録がある場合は初回保存を保留する。既存記録を消したり別の設定へ取り込んだりしない。
- 未コミット変更、場所の変更、参照変更、署名不一致、途中の保存は保持して確認する。lockを削除して強制的に進めない。
- 保存先と署名キーの場所、ブラウザ認証tokenはモデルの環境変数へ渡さない。
- 最初の署名済み設定は履歴の起点として保持する。後の編集は新しい署名済み版を追加し、旧条件を上書きしない。モデルへ設定ファイルの手編集を任せない。

## 設定の編集と複数プロジェクト

準備済みの画面から「条件を編集」または「追加」を選び、「内容を確認」→変更するプロジェクトと完全な条件の確認→「この版を保存」と進む。Codex実行ファイルとAstraは全プロジェクト共通で、変更時は影響する全プロジェクトを確認する。Sol・許可パス・検証・制限はプロジェクトごとに指定する。保存だけではモデルturnやTaskを開始しない。

保存した版は再起動後に有効になる。それまでは新しいチャット入力・契約案・確定・Task開始・統合開始/再開を保留する。HTTPとnative toolは共通の確認を通る。進行中の固定作業、停止要求、結果とレビューの読み取りは引き続き使える。

既存Taskは承認時の実行条件と署名を保持し、再起動で復元する。旧設定の未承認案は保留にする。統合成果・レビュー・保存した基準も旧実行条件を解決して復元し、別のVault/projectや新しい許可範囲外へ基準を流用しない。

複数プロジェクトは共通schedulerへ接続する。「一覧から外す」は履歴を削除しない操作で、少なくとも一つのプロジェクトを残す。「設定の履歴」の「この条件を確認」から過去の条件を戻す場合も、確認・署名した新しい版として保存する。元の版へ実行ポインタだけを戻さない。

設定ID・Git・Vault・Vault project IDの対応は履歴全体で固定する。一覧から外した対象を別の設定IDへ割り当てない。場所の移行や古い契約の改訂は、この編集操作とは別の照合が必要。active projectは20件、保存版は初回を含め64件まで。履歴上限に達した場合は旧署名・参照を保持した移行が必要で、履歴を自動削除しない。

## 途中の設定保存

完全な保存候補を先にfsyncし、署名した後で、hardlinkによるcreate-only公開を行う。最新の記録が欠けても、独立した署名記録との不一致を検出して保留し、旧設定へ無言で戻らない。

完全な署名済み候補が残る場合、通常の `/setup` で条件と版を確認し「この保存を完了」を選ぶ。元のUUID・hashと一致する保存だけを完了し、再起動の確認を必要とする。Taskやproviderの再実行は伴わない。保存writerが残る場合も、所有記録が正確で、そのPIDの終了が確認できるときだけ、この明示操作で解除できる。生存中・所有不明・PID再利用・照合権限不明は解除しない。

不完全・未署名・複数候補、候補のない残留writer、domainのない旧writer、旧復旧処理の残留lockは保留し、記録を保持する。新しい復旧guardのprocess終了時の解放とdomainの照合は新規Vaultと共通のnative処理を使う。汎用の手動照合画面は残る作業である。保存先にはhardlink対応が必要。WindowsではNodeからdirectory fsyncが使えないため、欠落は次回の署名照合で検出して保留する。この試験は停電時の永続性や全filesystemへの対応を証明するものではない。

## 確認した範囲

自動試験では、Task/Vault Taskが0件の初回構成から、契約案・署名確定・直接Sol fixture・レビュー待ち・再起動復元まで確認した。旧テンプレート構成との互換、Cookie/Origin/入力上限、署名改変、dirty Git、既存記録、場所の正規化、UUID APIのないブラウザも対象にした。

通常のビルド済みサーバーと実Codexで、GUIの保存、再起動、ChatGPTログイン、Astra/Solの起動条件、新しいTaskと統括チャットへの導線を確認した。この追加QAではモデルturnとTaskは開始せず、元のHEAD・差分とVaultの必須Specは不変だった。未対応Solを指定した別の確認記録では、モデルカタログ拒否、HTTP 503、チャット入力の未送信、provider session未作成を確認した。

Chromium1440/320/375px、ライト/ダーク、キーボードでの確認と保存、検証項目の追加/削除、参照の詳細展開を確認した。スマホ幅で右端と下部ナビを直接確認した。チャットの空欄案内を短くし、キーボード操作の説明はtitleへ残した。

実機safe-area・仮想キーボード、人の使いやすさと実成果の受入は残る。全Phase0–8、全73要件の完成宣言ではない。

追加の通常サーバーQAでは、設定編集→追加→再起動で2プロジェクト→一覧から外す→過去の条件を新しい版として戻す→署名済み途中保存のGUI完了→再起動まで確認した。終了した所有writerも合成して照合した。実ChatGPT認証・モデルカタログ・thread初期化のみで、provider turn0、Task0、両リポジトリのHEAD・差分・必須Specは不変だった。Chromium1440/320/375px、ライト/ダーク、キーボード確認/保存/復旧、横幅を確認し、スマホのプロジェクト行で縦に崩れたボタンを修正した。

最終hash照合からMasterの起動確認まで、保存と同じwriterを保持する。保存後のチャット送信と新しい会話の要求は拒否され、会話記録が変わらないことを通常サーバーで確認した。現行Codex Masterの新しい会話切替は既存仕様で未対応。設定保存はその対応を追加するものではない。
