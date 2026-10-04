"""Read planning references and apply an exact authenticated Task approval.

No model, Git, shell, or network invocation. The receipt directory is held by
the server outside Vault and model worktrees. Drafts grant no Vault authority.
"""
from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
from pathlib import Path
import re

import negi_vault as vault
import negi_task_contract as contracts


def inspect(root, project, refs):
    notes = vault.load_notes(root)
    seeds = {n.id.casefold() for n in notes.values()
             if vault._eligible(n, project) and n.properties.get("required")}
    seeds.update(r.casefold() for r in refs)
    selected = vault._required_closure(notes, seeds, project)
    sources = [{"id": n.id, "kind": n.properties["kind"],
                "version": int(n.properties["version"]), "sha256": n.sha256, "path": n.relative}
               for n in sorted((notes[k] for k in selected), key=lambda n: n.id.casefold())]
    if not sources or len(sources) > 50:
        raise vault.VaultError("Task計画には1件以上50件以下の有効な仕様参照が必要")
    context = "\n\n".join(notes[s["id"].casefold()].path.read_text(encoding="utf-8-sig") for s in sources)
    if len(context) > 16000:
        raise vault.VaultError("計画参照が大きすぎるためTaskを分割する")
    return {"sources": sources, "context": context}


def apply(root, proof_dir, request_id):
    if not re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", request_id):
        raise vault.VaultError("Task承認IDが不正")
    raw = Path(proof_dir).absolute()
    directory = raw.resolve(strict=True)
    if raw.is_symlink() or directory.is_relative_to(root):
        raise vault.VaultError("Task承認署名はVault外のリンクでない保存先が必要")
    key_path, path = directory / "server-signing-key", directory / (request_id + ".json")
    if (key_path.is_symlink() or not key_path.is_file() or key_path.stat().st_size != 32 or
            path.is_symlink() or not path.is_file() or path.stat().st_size > 24000):
        raise vault.VaultError("Task承認ファイルが不正")
    envelope = json.loads(path.read_text(encoding="utf-8"))
    receipt = envelope["receipt"]
    signature = hmac.new(key_path.read_bytes(), json.dumps(receipt, ensure_ascii=False,
                         separators=(",", ":")).encode("utf-8"), hashlib.sha256).hexdigest()
    data = receipt["data"]
    if (not hmac.compare_digest(signature, envelope["signature"]) or
            receipt["schema"] != "negi-human-review/1" or receipt["id"] != request_id or
            receipt["source"] != "authenticated-browser" or receipt["action"] != "operation" or
            data["domain"] != "task-authoring" or
            os.path.normcase(data["vault"]) != os.path.normcase(str(root))):
        raise vault.VaultError("Task承認の署名または保存先が一致しない")
    content = data["content"].encode("utf-8")
    relative = "80_Tasks/" + data["taskId"] + ".md"
    if not re.fullmatch(r"80_Tasks/NT-TASK-[0-9a-f-]{36}\.md", relative):
        raise vault.VaultError("Task承認のIDが不正")
    target = root / relative
    desired = vault.parse_note(content, target, relative)
    if (desired.id != data["taskId"] or desired.sha256 != receipt["artifactSha256"] or
            desired.properties["kind"] != "Task" or desired.properties["status"] != "active" or
            desired.properties["sensitivity"] != "local" or desired.properties["scope"] != "project" or
            desired.properties["project"] != data["project"] or desired.properties["version"] != "1" or
            desired.properties["approval_ref"] != "user:http-task-plan:" + request_id):
        raise vault.VaultError("Task承認の内容が不正")
    expected = json.loads(data["sources"])
    with vault._writer_lock(root):
        current = inspect(root, data["project"], [s["id"] for s in expected])
        if current["sources"] != expected:
            raise vault.VaultError("Task案の参照仕様が変更された")
        notes = vault.load_notes(root)
        existing = notes.get(desired.id.casefold())
        if existing:
            if existing.sha256 != desired.sha256 or existing.relative != relative:
                raise vault.VaultError("確定済みTaskとの競合")
        else:
            parent = target.parent
            if parent.is_symlink():
                raise vault.VaultError("Task保存先リンクを拒否")
            parent.mkdir(exist_ok=True)
            if parent.resolve(strict=True) != root / "80_Tasks":
                raise vault.VaultError("Task保存先はVault内に限定")
            descriptor = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())
        # Validate the actual semantic exporter while the writer lock is held.
        return contracts.export_contract(vault.load_notes(root), desired.id, data["project"])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--vault", required=True)
    sub = parser.add_subparsers(dest="command", required=True)
    read = sub.add_parser("inspect")
    read.add_argument("--project", required=True)
    read.add_argument("--reference", action="append", default=[])
    write = sub.add_parser("apply")
    write.add_argument("--proof-dir", required=True)
    write.add_argument("--request-id", required=True)
    args = parser.parse_args()
    try:
        root = vault.vault_root(args.vault)
        result = inspect(root, args.project, args.reference) if args.command == "inspect" else apply(root, args.proof_dir, args.request_id)
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    except (vault.VaultError, KeyError, ValueError, OSError) as error:
        parser.exit(2, str(error) + "\n")


if __name__ == "__main__":
    main()
