"""Export one active Vault Task as an immutable local Phase 3 contract snapshot.

This reads Markdown through the Phase 2 validator. It does not launch a model,
run verification commands, change the Vault, or grant execution permission.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path, PurePosixPath
import re

import negi_vault as vault


CONTRACT_BLOCK = re.compile(r"(?ms)^```negi-task-contract[ \t]*\r?\n(.*?)^```[ \t]*\r?$")
SHA = re.compile(r"[0-9a-f]{40}(?:[0-9a-f]{24})?", re.I)
FIELDS = {
    "objective", "in_scope", "out_of_scope", "allowed_paths", "invariants",
    "acceptance", "verification", "escalation", "base_sha", "max_attempts",
    "time_limit_minutes",
}


def _strings(value, name: str, required: bool = True) -> list[str]:
    if (not isinstance(value, list) or (required and not value) or
            any(not isinstance(item, str) or not item.strip() or len(item) > 1000
                for item in value) or len(value) > 50):
        raise vault.VaultError(f"Task Contractの{name}は短い文字列リストにする")
    if len(value) != len(set(value)):
        raise vault.VaultError(f"Task Contractの{name}に重複がある")
    return value


def _allowed_paths(value) -> list[str]:
    paths = _strings(value, "allowed_paths")
    for item in paths:
        parts = PurePosixPath(item).parts
        if (item.startswith("/") or "\\" in item or ":" in item or
                any(part in {"", ".", ".."} for part in item.split("/")) or
                any(char in item for char in "*?[]{}") or
                not parts or parts[0] in {".", ".."}):
            raise vault.VaultError(f"Task Contractのallowed_pathsが安全な相対パスではない: {item}")
    return paths


def export_contract(notes: dict[str, vault.Note], note_id: str, project: str) -> dict:
    task = notes.get(note_id.casefold())
    if (task is None or task.properties["kind"] != "Task" or
            task.properties["status"] != "active" or
            task.properties["project"] != project or
            task.properties["sensitivity"] != "local" or
            task.relative.split("/", 1)[0] != "80_Tasks" or
            not str(task.properties.get("approval_ref", "")).startswith("user:")):
        raise vault.VaultError("activeかつ明示承認済みのlocal Taskノートが必要")
    blocks = CONTRACT_BLOCK.findall(task.body)
    if len(blocks) != 1:
        raise vault.VaultError("Taskノートにnegi-task-contract JSONブロックが一つ必要")
    try:
        def unique_pairs(pairs):
            result = {}
            for key, value in pairs:
                if key in result:
                    raise vault.VaultError(f"Task Contract JSONに重複キー: {key}")
                result[key] = value
            return result
        data = json.loads(blocks[0], object_pairs_hook=unique_pairs)
    except json.JSONDecodeError as error:
        raise vault.VaultError(f"Task Contract JSONが不正: {error.msg}") from error
    if not isinstance(data, dict) or set(data) != FIELDS:
        raise vault.VaultError("Task Contractの項目が不足または過剰")
    if (not isinstance(data["objective"], str) or not data["objective"].strip() or
            len(data["objective"]) > 2000 or
            not isinstance(data["base_sha"], str) or not SHA.fullmatch(data["base_sha"])):
        raise vault.VaultError("Task Contractの目的または基準SHAが不正")
    for name in ("in_scope", "out_of_scope", "invariants", "acceptance",
                 "verification", "escalation"):
        _strings(data[name], name)
    _allowed_paths(data["allowed_paths"])
    for name, maximum in (("max_attempts", 3), ("time_limit_minutes", 480)):
        value = data[name]
        if type(value) is not int or not 1 <= value <= maximum:
            raise vault.VaultError(f"Task Contractの{name}が不正")
    required = {key for key, note in notes.items()
                if note.properties["status"] == "active" and
                note.properties.get("required") and
                (note.properties["project"] == project or note.properties["scope"] == "global")}
    selected = vault._required_closure(notes, required | {task.id.casefold()}, project)
    source_notes = [
        {"id": notes[key].id, "kind": notes[key].properties["kind"],
         "version": int(notes[key].properties["version"]), "sha256": notes[key].sha256,
         "path": notes[key].relative}
        for key in sorted(selected)
    ]
    return {
        "schemaVersion": "negi-task-contract/1", "vaultId": task.id,
        "version": int(task.properties["version"]), "sha256": task.sha256,
        "project": project, "objective": data["objective"],
        "acceptance": data["acceptance"], "baseSha": data["base_sha"].lower(),
        "scope": {"in": data["in_scope"], "out": data["out_of_scope"],
                  "allowedPaths": data["allowed_paths"]},
        "invariants": data["invariants"], "verification": data["verification"],
        "escalation": data["escalation"],
        "limits": {"maxAttempts": data["max_attempts"],
                   "timeLimitMinutes": data["time_limit_minutes"]},
        "sourceNotes": source_notes,
    }


def save_snapshot(root: Path, snapshot: dict, raw_out: str) -> Path:
    out = Path(raw_out).expanduser().absolute()
    parent = out.parent.resolve(strict=True)
    if parent == root or parent.is_relative_to(root):
        raise vault.VaultError("Task Contract派生物はVault外へ保存する")
    if out.exists() or out.is_symlink():
        raise vault.VaultError("既存のTask Contract派生物を上書きしない")
    content = (json.dumps(snapshot, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8")
    descriptor = os.open(out, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(content)
        stream.flush()
        os.fsync(stream.fileno())
    return out


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Export an approved local Task Contract")
    parser.add_argument("--vault", required=True)
    parser.add_argument("--id", required=True)
    parser.add_argument("--project", required=True)
    destination = parser.add_mutually_exclusive_group(required=True)
    destination.add_argument("--out")
    destination.add_argument("--stdout-json", action="store_true")
    args = parser.parse_args(argv)
    try:
        root = vault.vault_root(args.vault)
        snapshot = export_contract(vault.load_notes(root), args.id, args.project)
        out = save_snapshot(root, snapshot, args.out) if args.out else None
    except (vault.VaultError, OSError) as error:
        parser.exit(2, f"Task Contract export failed: {error}\n")
    if args.stdout_json:
        print(json.dumps(snapshot, ensure_ascii=False, sort_keys=True))
    else:
        print(json.dumps({"path": str(out), "vaultId": snapshot["vaultId"],
                          "version": snapshot["version"], "sha256": snapshot["sha256"]},
                         ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
