"""Synthetic Vault Task Contract export checks; no model or network involved."""

import json
from pathlib import Path
import sys
import tempfile
import unittest


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import negi_task_contract as task_contract
import negi_vault as vault


BASE_SHA = "a" * 40


def note(note_id, kind, body, status="active", approval_ref=None,
         depends_on=(), required=False, sensitivity="local"):
    lines = ["---", f"id: {note_id}", f"kind: {kind}", "project: negi",
             "scope: project", f"status: {status}", "version: 1",
             "updated: 2026-09-29", f"sensitivity: {sensitivity}",
             "source_refs:", "  - user:requested", "depends_on:"]
    lines.extend(f"  - {item}" for item in depends_on)
    lines.append(f"required: {'true' if required else 'false'}")
    if approval_ref:
        lines.append(f"approval_ref: {approval_ref}")
    return "\n".join([*lines, "---", body, ""])


def contract_body(**changes):
    data = {
        "objective": "Implement one bounded local fix",
        "in_scope": ["Change the parser"],
        "out_of_scope": ["No deployment"],
        "allowed_paths": ["src/server/orchestration"],
        "invariants": ["Keep auth unchanged"],
        "acceptance": ["The parser handles a missing value"],
        "verification": ["Run the focused parser test"],
        "escalation": ["Stop if the schema differs"],
        "base_sha": BASE_SHA, "max_attempts": 1, "time_limit_minutes": 30,
    }
    data.update(changes)
    return "# Task\n\n```negi-task-contract\n" + json.dumps(data) + "\n```\n"


class TaskContractTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.vault = self.root / "Vault"
        self.vault.mkdir()

    def add(self, relative, content):
        path = self.vault / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        return path

    def prepare(self, body=None, status="active", approval_ref="user:approved",
                sensitivity="local"):
        self.add("10_Projects/negi/spec.md", note("SPEC-ONE", "Spec", "Must keep auth.\n",
                                                  required=True))
        return self.add("80_Tasks/task.md", note("TASK-ONE", "Task", body or contract_body(),
                                                status=status, approval_ref=approval_ref,
                                                depends_on=("SPEC-ONE",), sensitivity=sensitivity))

    def test_active_task_and_required_spec_are_hash_pinned_without_vault_write(self):
        path = self.prepare()
        before = path.read_bytes()
        snapshot = task_contract.export_contract(vault.load_notes(self.vault), "TASK-ONE", "negi")
        self.assertEqual(snapshot["baseSha"], BASE_SHA)
        self.assertEqual(snapshot["scope"]["allowedPaths"], ["src/server/orchestration"])
        self.assertEqual({source["id"] for source in snapshot["sourceNotes"]},
                         {"TASK-ONE", "SPEC-ONE"})
        out = task_contract.save_snapshot(self.vault, snapshot, str(self.root / "contract.json"))
        self.assertEqual(json.loads(out.read_text(encoding="utf-8")), snapshot)
        self.assertEqual(path.read_bytes(), before)
        with self.assertRaisesRegex(vault.VaultError, "上書き"):
            task_contract.save_snapshot(self.vault, snapshot, str(out))
        with self.assertRaisesRegex(vault.VaultError, "Vault外"):
            task_contract.save_snapshot(self.vault, snapshot, str(self.vault / "80_Tasks" / "derived.json"))

    def test_candidate_private_or_unapproved_task_does_not_export(self):
        for status, approval, sensitivity in (("candidate", "user:approved", "local"),
                                               ("active", None, "local"),
                                               ("active", "user:approved", "private")):
            with self.subTest(status=status, approval=approval, sensitivity=sensitivity):
                path = self.prepare(status=status, approval_ref=approval, sensitivity=sensitivity)
                with self.assertRaisesRegex(vault.VaultError, "明示承認済み"):
                    task_contract.export_contract(vault.load_notes(self.vault), "TASK-ONE", "negi")
                path.unlink()

    def test_invalid_scope_duplicate_key_and_missing_dependency_fail_closed(self):
        path = self.prepare(body=contract_body(allowed_paths=["../outside"]))
        with self.assertRaisesRegex(vault.VaultError, "allowed_paths"):
            task_contract.export_contract(vault.load_notes(self.vault), "TASK-ONE", "negi")
        body = contract_body().replace('"objective":', '"objective": "duplicate", "objective":')
        path.write_text(note("TASK-ONE", "Task", body, approval_ref="user:approved",
                             depends_on=("SPEC-ONE",)), encoding="utf-8")
        with self.assertRaisesRegex(vault.VaultError, "重複キー"):
            task_contract.export_contract(vault.load_notes(self.vault), "TASK-ONE", "negi")
        path.write_text(note("TASK-ONE", "Task", contract_body(), approval_ref="user:approved",
                             depends_on=("SPEC-MISSING",)), encoding="utf-8")
        with self.assertRaisesRegex(vault.VaultError, "依存ID"):
            task_contract.export_contract(vault.load_notes(self.vault), "TASK-ONE", "negi")


if __name__ == "__main__":
    unittest.main()
