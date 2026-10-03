"""Signed, project-scoped Lesson journal. No model or network calls.

The server writes a receipt before applying its exact bytes. A pending or revoked
receipt therefore withholds the previous Lesson even after a crash or rollback.
The private signing directory must remain outside model writable directories.
"""
from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import marshal
import os
from pathlib import Path
import re
import sys

import negi_vault as vault

_LOADED_MODULE_CODE_SHA = hashlib.sha256(marshal.dumps(sys._getframe().f_code)).hexdigest()
_LOADED_SOURCE_SHA = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()

UUID = re.compile(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}")
HEX = re.compile(r"[0-9a-f]{64}")
MARKER = "negi-knowledge:"


def managed(note):
    return vault.managed_knowledge_note(note)


class KnowledgeAuthority:
    def __init__(self, directory: str, root: Path):
        raw = Path(directory).absolute()
        if raw.is_symlink():
            raise vault.VaultError("Knowledge署名ディレクトリのリンクを拒否")
        self.directory = raw.resolve(strict=True)
        if self.directory == root or self.directory.is_relative_to(root):
            raise vault.VaultError("Knowledge署名はVault外に置く")
        key_file = self.directory / "server-signing-key"
        if key_file.is_symlink() or not key_file.is_file() or key_file.stat().st_size != 32:
            raise vault.VaultError("Knowledge署名鍵が不正")
        key = key_file.read_bytes()
        paths = sorted(self.directory.glob("*.json"))
        if len(paths) > 10000:
            raise vault.VaultError("Knowledge履歴の上限超過")
        self.events = {}
        for path in paths:
            if not UUID.fullmatch(path.stem) or path.is_symlink() or path.stat().st_size > 24000:
                raise vault.VaultError("Knowledge署名ファイルが不正")
            try:
                envelope = json.loads(path.read_text(encoding="utf-8"))
                receipt = envelope["receipt"]
                payload = json.dumps(receipt, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
                signature = hmac.new(key, payload, hashlib.sha256).hexdigest()
                if not hmac.compare_digest(signature, envelope["signature"]):
                    raise ValueError("signature")
                data = receipt["data"]
                if (receipt["schema"] != "negi-human-review/1" or receipt["id"] != path.stem or
                        receipt["source"] != "authenticated-browser" or receipt["action"] != "operation" or
                        data["domain"] != "knowledge"):
                    raise ValueError("domain")
                # One server journal can contain explicitly registered separate Vaults.
                if os.path.normcase(data["vaultRoot"]) != os.path.normcase(str(root)):
                    continue
                relative = data["notePath"]
                if not re.fullmatch(r"40_Lessons/[A-Za-z0-9][A-Za-z0-9._-]*\.md", relative):
                    raise ValueError("path")
                note = vault.parse_note(data["content"].encode("utf-8"), root / relative, relative)
                op = data["op"]
                status = {"candidate": "candidate", "revise": "candidate", "activate": "active",
                          "deprecate": "deprecated"}.get(op)
                if (not status or note.properties["kind"] != "Lesson" or
                        note.properties["scope"] != "project" or note.properties["sensitivity"] != "local" or
                        note.properties["status"] != status or note.id != data["noteId"] or
                        note.properties["project"] != data["project"] or note.sha256 != receipt["artifactSha256"] or
                        receipt["caseId"] != "knowledge:" + note.id or
                        not HEX.fullmatch(data["previousSha256"]) or
                        MARKER + note.id not in note.properties["source_refs"] or
                        not note.properties["task_classes"] or not note.properties["source_versions"] or
                        (status == "active" and note.properties.get("approval_ref") !=
                         "user:http-knowledge:" + receipt["id"])):
                    raise ValueError("metadata")
            except (KeyError, TypeError, ValueError) as error:
                raise vault.VaultError(f"Knowledge署名または内容が不正: {path.name}") from error
            self.events.setdefault(note.id.casefold(), []).append((receipt, note))
        for events in self.events.values():
            events.sort(key=lambda pair: int(pair[1].properties["version"]))
            for index, (receipt, note) in enumerate(events):
                data = receipt["data"]
                if int(note.properties["version"]) != index + 1:
                    raise vault.VaultError("Knowledge版が重複または欠落")
                if index == 0:
                    if data["op"] != "candidate" or data["previousSha256"] != "0" * 64:
                        raise vault.VaultError("Knowledge候補の起点が不正")
                    continue
                previous_receipt, previous = events[index - 1]
                before = previous.properties["status"]
                if (data["previousSha256"] != previous.sha256 or note.relative != previous.relative or
                        note.properties["project"] != previous.properties["project"] or before == "deprecated" or
                        (data["op"] == "activate" and before != "candidate") or data["op"] == "candidate" or
                        note.properties["source_versions"] != previous.properties["source_versions"] or
                        note.properties["source_refs"] != previous.properties["source_refs"] or
                        data["origin"] != previous_receipt["data"]["origin"] or
                        receipt["runId"] != previous_receipt["runId"]):
                    raise vault.VaultError("Knowledge履歴の遷移が不正")
                if data["op"] in {"activate", "deprecate"} and (
                        note.body != previous.body or data["fields"] != previous_receipt["data"]["fields"] or
                        note.properties["task_classes"] != previous.properties["task_classes"]):
                    raise vault.VaultError("状態変更時にKnowledge本文は変更しない")

    def allows(self, note):
        events = self.events.get(note.id.casefold())
        if not events:
            return not managed(note)
        receipt, latest = events[-1]
        return (receipt["data"]["op"] == "activate" and latest.sha256 == note.sha256 and
                latest.relative == note.relative and latest.properties["status"] == "active")

    def apply(self, root: Path, request_id: str):
        match = next(((receipt, note) for events in self.events.values() for receipt, note in events
                      if receipt["id"] == request_id), None)
        if match is None:
            raise vault.VaultError("Knowledge操作の署名がない")
        receipt, note = match
        if self.events[note.id.casefold()][-1][0]["id"] != request_id:
            raise vault.VaultError("最新のKnowledge操作だけを適用する")
        data = receipt["data"]
        with vault._writer_lock(root):
            parent = root / "40_Lessons"
            parent.mkdir(exist_ok=True)
            if parent.is_symlink() or parent.resolve(strict=True) != parent:
                raise vault.VaultError("Knowledge保存先のリンクを拒否")
            notes = vault.load_notes(root)
            current = notes.get(note.id.casefold())
            if current and current.relative != note.relative:
                raise vault.VaultError("Knowledge IDの保存先が変わった")
            if current and current.sha256 == note.sha256:
                return note.sha256
            rollback = (data["op"] == "deprecate" and (current is None or
                        any(current.sha256 == prior.sha256 for _, prior in self.events[note.id.casefold()][:-1])))
            if (current.sha256 if current else "0" * 64) != data["previousSha256"] and not rollback:
                raise vault.VaultError("Knowledgeの手編集または同時変更と競合")
            if data["op"] == "activate":
                fields = json.loads(data["fields"])
                if any(not isinstance(fields.get(key), str) or not fields[key].strip()
                       for key in ("title", "taskClass", "recommendation", "nonApplicability", "counterexample")):
                    raise vault.VaultError("Knowledge承認には推奨・非適用条件・反例が必要")
                task_class = note.properties["task_classes"][0]
                if task_class == "unclassified" or not vault.lesson_applies(
                        note, notes, task_class, note.properties["project"], knowledge_authority=self):
                    raise vault.VaultError("Knowledgeの分類または根拠版が失効している")
            content = data["content"].encode("utf-8")
            if current:
                def check():
                    if note.path.is_symlink() or vault.sha256(note.path.read_bytes()) != current.sha256:
                        raise vault.VaultError("Knowledgeの同時変更と競合")
                vault._atomic_write(note.path, content, check)
            else:
                descriptor = os.open(note.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                with os.fdopen(descriptor, "wb") as stream:
                    stream.write(content)
                    stream.flush()
                    os.fsync(stream.fileno())
        return note.sha256

    def views(self, root: Path):
        notes = vault.load_notes(root)
        result = []
        for events in self.events.values():
            receipt, desired = events[-1]
            current = notes.get(desired.id.casefold())
            exact = bool(current and current.sha256 == desired.sha256 and current.relative == desired.relative)
            applies = vault.lesson_applies(desired, notes, desired.properties["task_classes"][0],
                                          desired.properties["project"], knowledge_authority=self)
            result.append({"id": desired.id, "project": desired.properties["project"],
                           "status": desired.properties["status"], "version": int(desired.properties["version"]),
                           "sha256": desired.sha256, "content": receipt["data"]["content"],
                           "fields": json.loads(receipt["data"]["fields"]),
                           "origin": json.loads(events[0][0]["data"]["origin"]),
                           "sourceVersions": desired.properties["source_versions"],
                           "sourceRefs": desired.properties["source_refs"], "runId": receipt["runId"],
                           "exact": exact, "sourcesCurrent": applies,
                           "canActivate": exact and applies and desired.properties["status"] == "candidate" and
                           desired.properties["task_classes"] != ["unclassified"],
                           "history": [{"id": event[0]["id"], "at": event[0]["at"],
                                        "op": event[0]["data"]["op"], "version": int(event[1].properties["version"]),
                                        "reason": event[0]["data"].get("reason", ""),
                                        "sha256": event[1].sha256} for event in events]})
        return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--vault", required=True)
    parser.add_argument("--proof-dir", required=True)
    parser.add_argument("command", choices=["list", "apply"])
    parser.add_argument("--request-id")
    args = parser.parse_args(argv)
    try:
        root = vault.vault_root(args.vault)
        authority = KnowledgeAuthority(args.proof_dir, root)
        result = authority.views(root) if args.command == "list" else authority.apply(root, args.request_id)
        print(json.dumps(result, ensure_ascii=False))
    except (vault.VaultError, OSError) as error:
        parser.exit(2, f"Knowledge処理失敗: {error}\n")


if __name__ == "__main__":
    main()
