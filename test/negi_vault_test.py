"""Local-only Phase 2 Vault and context compiler tests."""

import importlib.util
from contextlib import redirect_stderr, redirect_stdout
import io
from pathlib import Path
import socket
import sys
import tempfile
import unittest
from unittest.mock import patch


MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "negi_vault.py"
SPEC = importlib.util.spec_from_file_location("negi_vault", MODULE_PATH)
vault = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = vault
SPEC.loader.exec_module(vault)


def note_text(note_id, kind="Spec", project="negi", scope="project", status="active",
              version=1, source_refs=("user:approved",), depends_on=(), roles=(), required=False,
              sensitivity="local", approval_ref=None, task_classes=(), source_versions=(),
              title="Example", summary="Short summary", body="Essential rule.\n"):
    lines = ["---", f"id: {note_id}", f"kind: {kind}", f"project: {project}",
             f"scope: {scope}", f"status: {status}", f"version: {version}",
             "updated: 2026-09-28", f"sensitivity: {sensitivity}", "verification_status: observed",
             f"title: {title}", f"summary: {summary}", f"required: {'true' if required else 'false'}",
             "source_refs:"]
    lines.extend(f"  - {item}" for item in source_refs)
    lines.append("depends_on:")
    lines.extend(f"  - {item}" for item in depends_on)
    lines.append("roles:")
    lines.extend(f"  - {item}" for item in roles)
    for name, values in [("task_classes", task_classes), ("source_versions", source_versions)]:
        lines.append(f"{name}:")
        lines.extend(f"  - {item}" for item in values)
    if approval_ref is not None:
        lines.append(f"approval_ref: {approval_ref}")
    lines.extend(["---", body])
    return "\n".join(lines)


class VaultTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.vault = self.root / "Vault"
        self.vault.mkdir()
        self.out = self.root / "pack.md"

    def tearDown(self):
        self.temp.cleanup()

    def add(self, relative, content):
        path = self.vault / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        return path

    def test_candidate_creation_and_deprecation_preserve_authority_boundary(self):
        source = self.root / "candidate.md"
        source.write_text(note_text("LESSON-NEW", kind="Lesson", status="candidate",
                                    source_refs=("case:1",)), encoding="utf-8")
        note_id, digest = vault.create_candidate(self.vault, "40_Lessons", "new.md", source)
        self.assertEqual(note_id, "LESSON-NEW")
        current = vault.load_notes(self.vault)
        self.assertEqual(current["lesson-new"].sha256, digest)
        with self.assertRaisesRegex(vault.VaultError, "ID重複"):
            vault.create_candidate(self.vault, "40_Lessons", "other.md", source)
        active = self.root / "active.md"
        active.write_text(note_text("LESSON-NEW", kind="Lesson", status="active",
                                    version=2, source_refs=("case:1",),
                                    approval_ref="user:approved"), encoding="utf-8")
        vault.update_note(self.vault, current, note_id, active, digest, "user:approved")
        current = vault.load_notes(self.vault)
        deprecated = self.root / "deprecated.md"
        deprecated.write_text(note_text("LESSON-NEW", kind="Lesson", status="deprecated",
                                        version=3, source_refs=("case:1", "user:withdraw")),
                              encoding="utf-8")
        with self.assertRaisesRegex(vault.VaultError, "理由参照"):
            vault.deprecate_note(self.vault, current, note_id, deprecated,
                                 current["lesson-new"].sha256, "user:other")
        vault.deprecate_note(self.vault, current, note_id, deprecated,
                             current["lesson-new"].sha256, "user:withdraw")
        current = vault.load_notes(self.vault)
        self.assertEqual(current["lesson-new"].properties["status"], "deprecated")
        self.assertEqual(vault.search_notes(current, "negi", "Example"), [])

    def test_required_spec_dependency_and_project_boundary(self):
        self.add("00_System/guard.md", note_text("SYS-GUARD", kind="Policy", project="global",
                 scope="global", required=True, body="Never remove auth.\n"))
        self.add("10_Projects/negi/spec.md", note_text("SPEC-MAIN", required=True,
                 depends_on=("SYS-GUARD",), body="Critical exception must remain.\n"))
        self.add("40_Lessons/related.md", note_text("LESSON-ONE", kind="Lesson", title="Search target",
                 summary="Relevant short lesson", roles=("sol",),
                 body="Long private example not used in metadata pack.\n"))
        self.add("40_Lessons/astra.md", note_text("LESSON-ASTRA", kind="Lesson", title="Search target",
                 summary="Astra-only lesson", roles=("astra",)))
        self.add("10_Projects/other/spec.md", note_text("OTHER-SPEC", project="other", required=True,
                 title="Search target", body="Other project secret.\n"))
        notes = vault.load_notes(self.vault)
        result = vault.build_pack(notes, "negi", "sol", "Search target", [], 16000)
        self.assertIn("Critical exception must remain.", result)
        self.assertIn("Never remove auth.", result)
        self.assertIn("Relevant short lesson", result)
        self.assertNotIn("Long private example", result)
        self.assertNotIn("Astra-only lesson", result)
        self.assertNotIn("Other project secret", result)
        self.assertIn('"fidelity": "metadata"', result)
        self.assertIn('"sha256":', result)

    def test_conditional_lesson_requires_class_and_current_source_versions(self):
        source = self.add("10_Projects/negi/spec.md", note_text("SPEC-MAIN", required=True,
                         body="Required condition remains.\n"))
        pin = "SPEC-MAIN@1:" + vault.sha256(source.read_bytes())
        lesson = self.add("40_Lessons/review.md", note_text("LESSON-REVIEW", kind="Lesson",
                         title="Review lesson", task_classes=("code-attribution",), source_versions=(pin,),
                         roles=("sol",), body="Applicability and counterexample remain visible.\n"))
        def pack(task_class=None, role="sol", required=()):
            return vault.build_pack(vault.load_notes(self.vault), "negi", role, "Review lesson",
                                    list(required), 16000, task_class=task_class)
        for task_class in [None, "other"]:
            self.assertNotIn("LESSON-REVIEW", pack(task_class))
        self.assertNotIn("LESSON-REVIEW", pack("code-attribution", "astra"))
        included = pack("code-attribution")
        self.assertIn("LESSON-REVIEW", included)
        self.assertIn("Applicability and counterexample remain visible.", included)
        self.assertIn("Required condition remains.", included)
        by_class = vault.build_pack(vault.load_notes(self.vault), "negi", "sol", "別の日本語の目的文",
                                    [], 16000, task_class="code-attribution")
        self.assertIn("LESSON-REVIEW", by_class)
        self.assertIn("Applicability and counterexample remain visible.", by_class)
        with self.assertRaisesRegex(vault.VaultError, "適用条件"):
            pack("other", required=["LESSON-REVIEW"])
        original = source.read_bytes()
        for change in [original + b"source edit", original.replace(b"version: 1", b"version: 2"),
                       original.replace(b"status: active", b"status: deprecated")]:
            source.write_bytes(change)
            if b"status: deprecated" in change:
                with self.assertRaisesRegex(vault.VaultError, "非active"):
                    pack("code-attribution", required=["SPEC-MAIN"])
            else:
                self.assertNotIn("LESSON-REVIEW", pack("code-attribution"))
        source.write_bytes(original)
        for status in ["candidate", "deprecated"]:
            lesson.write_text(note_text("LESSON-REVIEW", kind="Lesson", status=status,
                              title="Review lesson", task_classes=("code-attribution",), source_versions=(pin,)),
                              encoding="utf-8")
            self.assertNotIn("LESSON-REVIEW", pack("code-attribution"))

    def test_conditional_lesson_does_not_cross_source_scope_or_private_clearance(self):
        self.add("10_Projects/negi/spec.md", note_text("SPEC-MAIN", required=True))
        for project, sensitivity in [("other", "local"), ("negi", "private")]:
            source = self.add("10_Projects/other/source.md", note_text("SPEC-SOURCE", project=project,
                             sensitivity=sensitivity))
            pin = "SPEC-SOURCE@1:" + vault.sha256(source.read_bytes())
            self.add("40_Lessons/review.md", note_text("LESSON-REVIEW", kind="Lesson", title="Review",
                     task_classes=("code-attribution",), source_versions=(pin,)))
            result = vault.build_pack(vault.load_notes(self.vault), "negi", "sol", "Review", [], 16000,
                                      task_class="code-attribution")
            self.assertNotIn("LESSON-REVIEW", result)

    def test_missing_dependency_or_inactive_required_fails_closed(self):
        self.add("10_Projects/negi/spec.md", note_text("SPEC-MAIN", required=True,
                 depends_on=("SPEC-MISSING",)))
        notes = vault.load_notes(self.vault)
        with self.assertRaisesRegex(vault.VaultError, "依存ID"):
            vault.build_pack(notes, "negi", "astra", "", [], 16000)
        self.add("10_Projects/negi/dependency.md", note_text("SPEC-MISSING", status="candidate"))
        notes = vault.load_notes(self.vault)
        with self.assertRaisesRegex(vault.VaultError, "非active"):
            vault.build_pack(notes, "negi", "astra", "", [], 16000)

    def test_private_required_note_needs_explicit_local_clearance(self):
        self.add("10_Projects/negi/private.md", note_text("SPEC-PRIVATE", required=True,
                 sensitivity="private", body="Private constraint.\n"))
        notes = vault.load_notes(self.vault)
        with self.assertRaisesRegex(vault.VaultError, "必須private"):
            vault.build_pack(notes, "negi", "sol", "", [], 16000)
        pack = vault.build_pack(notes, "negi", "sol", "", [], 16000, allow_private=True)
        self.assertIn("Private constraint.", pack)
        self.assertFalse(vault.search_notes(notes, "negi", "Private"))

    def test_malformed_properties_duplicate_id_and_source_ref_required(self):
        self.add("10_Projects/negi/bad.md", "---\nid: BAD-NOTE\nkind: Spec\n---\n")
        with self.assertRaisesRegex(vault.VaultError, "必須Properties"):
            vault.load_notes(self.vault)
        (self.vault / "10_Projects/negi/bad.md").unlink()
        self.add("10_Projects/negi/a.md", note_text("SPEC-ONE"))
        self.add("40_Lessons/b.md", note_text("spec-one", kind="Lesson"))
        with self.assertRaisesRegex(vault.VaultError, "ID重複"):
            vault.load_notes(self.vault)
        (self.vault / "40_Lessons/b.md").unlink()
        self.add("40_Lessons/c.md", note_text("LESSON-NO-SOURCE", kind="Lesson", source_refs=()))
        with self.assertRaisesRegex(vault.VaultError, "source_refs"):
            vault.load_notes(self.vault)

    def test_missing_local_source_reference_is_not_silently_accepted(self):
        missing = self.root / "missing-source.md"
        self.add("10_Projects/negi/spec.md", note_text("SPEC-MAIN", required=True,
                 source_refs=(str(missing),)))
        with self.assertRaisesRegex(vault.VaultError, "ローカル出典"):
            vault.load_notes(self.vault)

    def test_guarded_update_detects_hand_edit_and_preserves_id(self):
        path = self.add("10_Projects/negi/spec.md", note_text("SPEC-MAIN", required=True))
        notes = vault.load_notes(self.vault)
        expected = notes["spec-main"].sha256
        replacement = self.root / "replacement.md"
        replacement.write_text(note_text("SPEC-MAIN", version=2, required=True,
                                        body="Improved rule.\n"), encoding="utf-8")
        path.write_text(note_text("SPEC-MAIN", version=1, required=True,
                                  body="Human edit.\n"), encoding="utf-8")
        with self.assertRaisesRegex(vault.VaultError, "競合"):
            vault.update_note(self.vault, notes, "SPEC-MAIN", replacement, expected)
        self.assertIn("Human edit.", path.read_text(encoding="utf-8"))
        current = vault.load_notes(self.vault)
        digest = vault.update_note(self.vault, current, "SPEC-MAIN", replacement,
                                   current["spec-main"].sha256)
        self.assertEqual(digest, vault.sha256(path.read_bytes()))
        self.assertIn("Improved rule.", path.read_text(encoding="utf-8"))

    def test_update_rejects_authority_change_and_second_writer(self):
        path = self.add("10_Projects/negi/spec.md", note_text("SPEC-MAIN", required=True))
        notes = vault.load_notes(self.vault)
        expected = notes["spec-main"].sha256
        replacement = self.root / "replacement.md"
        replacement.write_text(note_text("SPEC-MAIN", status="candidate", version=2,
                                        required=True), encoding="utf-8")
        with self.assertRaisesRegex(vault.VaultError, "status"):
            vault.update_note(self.vault, notes, "SPEC-MAIN", replacement, expected)
        replacement.write_text(note_text("SPEC-MAIN", version=2, required=True), encoding="utf-8")
        lock = self.vault / ".negi-writer.lock"
        lock.write_text("other writer", encoding="utf-8")
        with self.assertRaisesRegex(vault.VaultError, "Writer"):
            vault.update_note(self.vault, notes, "SPEC-MAIN", replacement, expected)
        self.assertEqual(path.read_text(encoding="utf-8"), note_text("SPEC-MAIN", required=True))

    def test_activation_requires_matching_user_approval_reference(self):
        path = self.add("10_Projects/negi/project.md", note_text("PROJECT-ONE", kind="Project",
                 status="candidate"))
        notes = vault.load_notes(self.vault)
        expected = notes["project-one"].sha256
        replacement = self.root / "approved.md"
        replacement.write_text(note_text("PROJECT-ONE", kind="Project", status="active",
                                        version=2, approval_ref="user:2026-09-29:proceed"),
                               encoding="utf-8")
        with self.assertRaisesRegex(vault.VaultError, "status"):
            vault.update_note(self.vault, notes, "PROJECT-ONE", replacement, expected)
        with self.assertRaisesRegex(vault.VaultError, "user承認"):
            vault.update_note(self.vault, notes, "PROJECT-ONE", replacement, expected,
                              "user:wrong")
        digest = vault.update_note(self.vault, notes, "PROJECT-ONE", replacement, expected,
                                   "user:2026-09-29:proceed")
        self.assertEqual(digest, vault.sha256(path.read_bytes()))
        self.assertEqual(vault.load_notes(self.vault)["project-one"].properties["status"], "active")

    def test_rename_preserves_id_and_hash_and_rejects_collision(self):
        path = self.add("10_Projects/negi/old-name.md", note_text("SPEC-MAIN", required=True))
        notes = vault.load_notes(self.vault)
        digest = notes["spec-main"].sha256
        self.add("10_Projects/negi/taken.md", note_text("SPEC-OTHER"))
        with self.assertRaisesRegex(vault.VaultError, "既に存在"):
            vault.rename_note(self.vault, notes, "SPEC-MAIN", "taken.md", digest)
        with self.assertRaisesRegex(vault.VaultError, "安全"):
            vault.rename_note(self.vault, notes, "SPEC-MAIN", "../outside.md", digest)
        relative = vault.rename_note(self.vault, notes, "SPEC-MAIN", "new-name.md", digest)
        self.assertEqual(relative, "10_Projects/negi/new-name.md")
        self.assertFalse(path.exists())
        renamed = vault.load_notes(self.vault)["spec-main"]
        self.assertEqual(renamed.id, "SPEC-MAIN")
        self.assertEqual(renamed.sha256, digest)

    def test_update_rechecks_hash_after_preparing_replacement(self):
        path = self.add("10_Projects/negi/spec.md", note_text("SPEC-MAIN", required=True))
        notes = vault.load_notes(self.vault)
        replacement = self.root / "replacement.md"
        replacement.write_text(note_text("SPEC-MAIN", version=2, required=True), encoding="utf-8")
        original = vault._atomic_write

        def concurrent_edit(target, data, before_replace=None):
            target.write_text(note_text("SPEC-MAIN", required=True, body="Human edit.\n"),
                              encoding="utf-8")
            return original(target, data, before_replace)

        with patch.object(vault, "_atomic_write", side_effect=concurrent_edit):
            with self.assertRaisesRegex(vault.VaultError, "競合"):
                vault.update_note(self.vault, notes, "SPEC-MAIN", replacement,
                                  notes["spec-main"].sha256)
        self.assertIn("Human edit.", path.read_text(encoding="utf-8"))
        self.assertFalse((self.vault / ".negi-writer.lock").exists())

    def test_budget_failure_keeps_last_good_pack_and_network_is_unused(self):
        self.add("10_Projects/negi/spec.md", note_text("SPEC-MAIN", required=True,
                 body="Mandatory rule.\n" * 200))
        self.out.write_text(vault.PACK_MARKER + "\nold good pack\n", encoding="utf-8")
        arguments = ["--vault", str(self.vault), "pack", "--project", "negi",
                     "--role", "sol", "--max-chars", "1000", "--out", str(self.out)]
        with patch.object(socket, "socket", side_effect=AssertionError("network used")), \
                redirect_stderr(io.StringIO()), redirect_stdout(io.StringIO()):
            self.assertEqual(vault.main(arguments), 1)
        self.assertIn("old good pack", self.out.read_text(encoding="utf-8"))

    def test_invalid_hand_edited_note_keeps_last_good_pack(self):
        path = self.add("10_Projects/negi/spec.md", note_text("SPEC-MAIN", required=True))
        arguments = ["--vault", str(self.vault), "pack", "--project", "negi",
                     "--role", "sol", "--out", str(self.out)]
        with redirect_stdout(io.StringIO()):
            self.assertEqual(vault.main(arguments), 0)
        good = self.out.read_bytes()
        path.write_text("---\nid: SPEC-MAIN\nkind: Spec\n---\npartial edit", encoding="utf-8")
        with redirect_stderr(io.StringIO()):
            self.assertEqual(vault.main(arguments), 1)
        self.assertEqual(self.out.read_bytes(), good)

    def test_cli_search_read_pack_and_unrelated_output_protection(self):
        self.add("10_Projects/negi/spec.md", note_text("SPEC-MAIN", required=True,
                 title="Reward safety", body="Do not double grant rewards.\n"))
        self.add("10_Projects/negi/candidate.md", note_text("SPEC-DRAFT", status="candidate",
                 title="Reward draft"))
        with redirect_stdout(io.StringIO()) as output:
            self.assertEqual(vault.main(["--vault", str(self.vault), "search", "--project", "negi",
                                         "--query", "Reward"]), 0)
        self.assertIn("SPEC-MAIN", output.getvalue())
        self.assertNotIn("SPEC-DRAFT", output.getvalue())
        with redirect_stdout(io.StringIO()) as output:
            self.assertEqual(vault.main(["--vault", str(self.vault), "search", "--project", "negi",
                                         "--query", "Reward", "--status", "candidate"]), 0)
        self.assertIn("SPEC-DRAFT", output.getvalue())
        with redirect_stdout(io.StringIO()) as output:
            self.assertEqual(vault.main(["--vault", str(self.vault), "read", "--id", "SPEC-MAIN"]), 0)
        self.assertIn("Do not double grant rewards.", output.getvalue())
        args = ["--vault", str(self.vault), "pack", "--project", "negi",
                "--role", "sol", "--out", str(self.out)]
        with redirect_stdout(io.StringIO()):
            self.assertEqual(vault.main(args), 0)
        self.assertIn("Do not double grant rewards.", self.out.read_text(encoding="utf-8"))
        with redirect_stdout(io.StringIO()) as output:
            self.assertEqual(vault.main(["--vault", str(self.vault), "pack", "--project", "negi",
                                         "--role", "sol", "--stdout"]), 0)
        self.assertEqual(output.getvalue(), self.out.read_text(encoding="utf-8"))
        self.out.write_text("unrelated content", encoding="utf-8")
        with redirect_stderr(io.StringIO()):
            self.assertEqual(vault.main(args), 1)
        self.assertEqual(self.out.read_text(encoding="utf-8"), "unrelated content")


if __name__ == "__main__":
    unittest.main()
