# Negi-Teams Phase 2: 最小Vault連携

2026-10-03追加: [Context Packの再利用と知識の失効](negi-teams-context-cache.md)を通常の登録Taskへ接続した。以下の初期CLI記録を保持し、L1/L2の現在条件・署名・処理版とWindows保存境界を追加して確認する。

`scripts/negi_vault.py` は明示したローカルObsidian VaultのMarkdownを直接読む。既存のebi-team実行経路、認証、MCP、Codex設定は変更しない。モデル、Jev、ネットワークへの送信は行わない。後続のPhase 3ではオフラインの単一run台帳を追加したが、このVault CLIだけではrun起動・スケジューラ・Task Contract固定を行わない。

## 所有権と対象

- **正本:** `status: active` のVaultノート。Context Packは再生成可能な派生物で、Vault外の明示した出力先に置く。Phase 2仕様は2026-09-29のユーザーの継続指示を承認参照として、`NT-SPEC-VAULT-PHASE2` v3をactive化した。元の全体計画は設計と出典として保持し、Phase 2の運用条件を二重編集しない。
- **読み取り:** `--vault` で指定したフォルダ内の計画書で定義された分類ディレクトリ（`00_System`、`10_Projects`、`40_Lessons`、`80_Tasks`等）の `.md` のみ。`.obsidian`、別プロジェクト、`85_Derived`、`90_Archive`、非activeノートはPack候補から外す。シンボリックリンクのノートは拒否する。
- **書き込み:** Agentが既存ノートを変更する場合は `update` を通す。単一Writerのlock、更新前SHA-256、ID、増加したversion、Propertiesを検証し、一時ファイルから置換する。kind/project/scope/sensitivityの変更と通常の`update`によるstatus変更は拒否し、candidateからactiveへの変更だけを`activate`に分ける。人間がObsidianで行った手編集とhashが競合すれば上書きしない。外部エディタとの完全な同時刻原子性は保証しないため、更新失敗時は現在のノートを再読する。停止後に `.negi-writer.lock` が残った場合は稼働中Writerの有無を確認してから対処する。
- **秘密:** `sensitivity: local/private` は分類であって外部送信許可ではない。`private` は検索・Packから既定で除外し、必須なら失敗する。明示的な `--allow-private` はローカル検索・Packに含めるだけで、モデルへの送信許可ではない。このCLIはローカル出力だけを行う。個人ノート、認証情報、生ログを自動的に検索対象へ混ぜない。

2026-09-28に `E:\Negi-Teams\Negi-Teams-Vault` を新設し、2026-09-29にProject ID v2とPhase 2仕様 v3をactive化した。実Vaultから `.ebi-team/context-packs/phase2.md` を生成し、両ノートが全文・ID・版・hash付きで含まれることを確認した。既存Vaultの別の場所が後から判明した場合は、正本を二つにせず移行先を再確認する。

## 対応するProperties

Python標準ライブラリだけで動くよう、初期版は平坦なYAML Propertiesの小さな部分集合を厳密に扱う。文字列、`true`/`false`、2スペース字下げの文字列リスト、`[]`に対応する。ネスト、アンカー、複数行値は明示的に拒否する。Obsidian内で普通のMarkdown本文を編集できる。

```markdown
---
id: NT-SPEC-001
kind: Spec
project: negi-teams
scope: project
status: candidate
version: 1
updated: 2026-09-28
sensitivity: local
verification_status: unknown
title: 仕様候補の例
summary: 検索時に表示する短い説明
required: false
source_refs:
  - repo:docs/original-spec.md
depends_on: []
roles:
  - astra
  - sol
---
本文。承認済みの仕様へ切り替えるまではcandidateのままにする。
```

必須項目は `id/kind/project/scope/status/version/updated/sensitivity`。`id` はVault全体で一意、`version` は正整数。`status` と `verification_status` は独立し、`active` を観測済みと取り違えない。`active` のSpec/Task/Lesson/Policyには `source_refs` が必要。絶対パスで記したローカル出典は存在を検査する。`depends_on` のIDが存在しない、非active、別プロジェクト、または依存先に不正なPropertiesがある場合、Packを生成しない。

## ローカル操作

```powershell
python scripts/negi_vault.py --vault 'E:\Negi-Teams\Negi-Teams-Vault' validate
python scripts/negi_vault.py --vault 'E:\Negi-Teams\Negi-Teams-Vault' search --project negi-teams --query 'Vault'
python scripts/negi_vault.py --vault 'E:\Negi-Teams\Negi-Teams-Vault' read --id NT-SPEC-VAULT-PHASE2
python scripts/negi_vault.py --vault 'E:\Negi-Teams\Negi-Teams-Vault' pack --project negi-teams --role sol --query 'Vault' --out '.ebi-team\context-packs\phase2.md'
```

`NT-SPEC-VAULT-PHASE2` は `required: true` なので、明示的な `--require` がなくてもPackに入る。関連するProject IDも依存として全文で入る。

`pack` はactiveかつ同じprojectまたはglobalの必須ノート（`required: true`と`--require`）と、その依存を先に全文で含める。短い候補はローカルのタイトル・summary・本文一致で選び、Packにはmetadata/summaryを含める。候補の `roles` が指定されていれば対応する役割にだけ含める。必須条件が文字数上限を超えたら、黙って切らず失敗し、既存Packは保持する。PackにはID、版、SHA-256、相対パス、粒度、生成器版、概算トークン数を記録する。これはproviderの正確なトークン数ではない。曖昧な要約は `read` で原文を確認する。

Agentによる既存ノート更新時は、まず `search` またはPackで現在のSHA-256を確認し、版を増やした新しいMarkdownファイルを用意する。

```powershell
python scripts/negi_vault.py --vault 'E:\Negi-Teams\Negi-Teams-Vault' update --id NT-SPEC-VAULT-PHASE2 --from-file 'E:\temp\reviewed-spec.md' --expected-sha '<現在の64桁SHA-256>'
```

`status: candidate` を `active` に変えることは仕様の権威変更なので、出典・レビュー・承認を確認してから `activate --approval-ref user:<承認参照>` を使う。この文字列は承認の記録欄であり、CLI単体では発言者の認証や承認内容の照合を行えない。通常の `update` は権威変更を拒否する。`rename --id ... --filename ... --expected-sha ...` は内容とIDを保ったまま同じフォルダで名前だけを変える。Phase 2の採用時には全体計画の冒頭にVault ID・版・hashを明示し、元文書を二重の運用正本にしていない。

## 検証と残る境界

```powershell
python -m unittest discover -s test -p negi_vault_test.py -v
```

合成fixtureで必須仕様・依存・別projectの分離・役割別候補・不正Properties・出典欠落・同時手編集・権威変更の拒否と明示承認によるactive化・二重Writerの拒否・IDを保つ名前変更・容量上限時の最後の正常Pack保持・外部通信なしを確認する。実VaultのPack生成と元ノートhashの照合も行った。実モデルへのContext投入やObsidianアプリでの目視・同期サービス上の競合試験は行わない。大規模Vaultの検索速度、意味検索、Provider Prompt Cacheも対象外である。

## ロールバック

このCLI、テスト、文書、READMEのPhase 2リンクを戻す。生成したContext Packは派生物なので、場所を確認してから除去できる。全体計画の運用追記を戻す場合は、Vaultの正本を先に移行・失効させてから参照を直す。Vaultの人間編集ノートは自動削除しない。`update` で変更したノートを戻すときは、元の版とhashを確認し、新しいversionで訂正する。
