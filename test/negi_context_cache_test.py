"""Cache correctness, privacy invalidation and native publication/cleanup boundaries."""
import json
import os
from contextlib import contextmanager
import shutil
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import negi_context_cache as module
import negi_vault as vault
from negi_knowledge import KnowledgeAuthority
from negi_vault_test import note_text


@unittest.skipUnless(os.name == "nt", "native cache currently supports Windows")
class ContextCacheTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.root = self.directory / "Vault"
        self.root.mkdir()
        self.cache = self.directory / "cache"
        self.spec = self.add("10_Projects/spec.md", note_text("SPEC-CACHE", required=True))

    def tearDown(self):
        self.temp.cleanup()

    def add(self, relative, content):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        return path

    def pack(self, **changes):
        options = dict(root=self.root, project="negi", role="sol", query="cache", required_ids=[],
                       max_chars=16000, cache_directory=str(self.cache))
        options.update(changes)
        return vault.compile_current_pack(**options)

    def entries(self, tier):
        return list(self.cache.glob(f"*/{tier}-*.json"))

    def test_cold_warm_equal_fresh_and_preserve_other_role(self):
        cold, counts = self.pack()
        self.assertTrue(counts["enabled"])
        self.assertEqual(counts["counts"]["l1_miss"], 1)
        fresh, _ = self.pack(cache_directory=None)
        self.assertEqual(cold, fresh)
        astra, _ = self.pack(role="astra")
        warm, counts = self.pack()
        self.assertEqual(warm, cold)
        self.assertEqual(counts["counts"]["l1_hit"], 1)
        self.assertEqual(counts["counts"]["l2_hit"], 1)
        self.assertNotEqual(astra, warm)
        self.assertEqual(len(self.entries("l2")), 2)

    def test_actual_request_conditions_separate_l2(self):
        baseline, _ = self.pack()
        for changes in ({"query": "another"}, {"role": "astra"}, {"max_chars": 17000},
                        {"task_class": "code-review"}, {"required_ids": ["SPEC-CACHE"]}):
            content, stats = self.pack(**changes)
            self.assertEqual(stats["counts"]["l2_miss"], 1)
            expected, _ = self.pack(cache_directory=None, **changes)
            self.assertEqual(content, expected)
        self.assertEqual(self.pack()[0], baseline)
        self.assertEqual(len(self.entries("l2")), 6)

    def test_change_rename_deprecate_delete_and_add_required(self):
        optional = self.add("30_Patterns/optional.md", note_text("PATTERN-CACHE", kind="Pattern",
            title="cache", summary="old optional summary"))
        original, _ = self.pack()
        self.assertIn("old optional summary", original)
        optional.write_text(note_text("PATTERN-CACHE", kind="Pattern", title="cache",
            version=2, summary="new optional summary"), encoding="utf-8")
        changed, counts = self.pack()
        self.assertNotIn("old optional summary", changed)
        self.assertIn("new optional summary", changed)
        self.assertGreaterEqual(counts["counts"]["pruned"], 2)
        renamed = optional.with_name("renamed.md")
        optional.rename(renamed)
        self.assertIn("30_Patterns/renamed.md", self.pack()[0])
        renamed.write_text(note_text("PATTERN-CACHE", kind="Pattern", status="deprecated",
            version=3, title="cache", summary="deprecated text"), encoding="utf-8")
        self.assertNotIn("PATTERN-CACHE", self.pack()[0])
        renamed.unlink()
        self.pack()
        self.add("50_Policies/new.md", note_text("POLICY-NEW", kind="Policy", required=True,
            body="New mandatory condition."))
        self.assertIn("New mandatory condition.", self.pack()[0])
        self.spec.unlink()
        with self.assertRaises(vault.VaultError):
            self.pack(required_ids=["SPEC-CACHE"])

    def test_private_clearance_does_not_survive_public_request(self):
        private = self.add("30_Patterns/private.md", note_text("PRIVATE-CACHE", kind="Pattern",
            sensitivity="private", title="cache", summary="Unique private sentinel."))
        self.assertNotIn("Unique private sentinel", self.pack()[0])
        self.assertFalse(any("Unique private sentinel" in path.read_text(encoding="utf-8")
                             for path in self.entries("l1") + self.entries("l2")))
        self.assertIn("Unique private sentinel", self.pack(allow_private=True)[0])
        self.assertNotIn("Unique private sentinel", self.pack()[0])
        self.assertFalse(any("Unique private sentinel" in path.read_text(encoding="utf-8")
                             for path in self.entries("l1") + self.entries("l2")))
        private.write_text(note_text("PRIVATE-CACHE", required=True, sensitivity="private"), encoding="utf-8")
        with self.assertRaisesRegex(vault.VaultError, "private"):
            self.pack()

    def test_corrupt_entries_cannot_inject_or_bypass_required_rules(self):
        original, _ = self.pack()
        l1, l2 = self.entries("l1")[0], self.entries("l2")[0]
        row = json.loads(l1.read_bytes())
        row["payload"]["value"]["body"] = "Injected invalid body"
        l1.write_bytes(module.encoded(row))
        l2.write_bytes(b'{"partial":')
        actual, stats = self.pack()
        self.assertEqual(actual, original)
        self.assertGreaterEqual(stats["counts"]["invalid"], 2)
        self.assertNotIn("Injected", actual)
        self.assertEqual(l2.read_bytes(), b'{"partial":')
        self.spec.write_text("malformed source", encoding="utf-8")
        with self.assertRaises(vault.VaultError):
            self.pack()

    def test_processor_change_invalidate_both_tiers(self):
        original, _ = self.pack()
        with patch.object(vault, "compiler_fingerprint", return_value="new-processor"):
            actual, stats = self.pack()
            self.assertEqual(actual, original)
            self.assertEqual(stats["counts"]["l1_miss"], 1)
            self.assertEqual(stats["counts"]["l2_miss"], 1)
            self.assertEqual(stats["counts"]["pruned"], 2)

    def test_old_loaded_code_cannot_publish_under_successor_disk_fingerprint(self):
        copied = self.directory / "compiler"
        copied.mkdir()
        for name in ("negi_vault.py", "negi_context_cache.py", "negi_knowledge.py", "negi_recover_writer.py"):
            shutil.copyfile(Path(vault.__file__).parent / name, copied / name)
        code = ("import sys; from pathlib import Path; import negi_vault as v; "
                "path=Path(v.__file__); "
                "text=path.read_text(encoding='utf-8').replace('必須ノートは原文。', 'UPDATED-B-RUNTIME.'); "
                "path.write_text(text, encoding='utf-8'); "
                "v.compile_current_pack(Path(sys.argv[1]), 'negi', 'sol', 'cache', [], 16000, "
                "cache_directory=sys.argv[2])")
        environment = {**os.environ, "PYTHONPATH": str(copied), "PYTHONIOENCODING": "utf-8"}
        old = subprocess.run([sys.executable, "-c", code, str(self.root), str(self.cache)],
                             cwd=copied, env=environment, capture_output=True, encoding="utf-8", timeout=10)
        self.assertNotEqual(old.returncode, 0)
        self.assertIn("処理版が読み込み後に変化", old.stderr)
        self.assertFalse(self.cache.exists())
        arguments = [sys.executable, str(copied / "negi_vault.py"), "--vault", str(self.root),
                     "pack", "--project", "negi", "--role", "sol", "--query", "cache", "--stdout"]
        fresh = subprocess.run(arguments, cwd=copied, env=environment, capture_output=True, encoding="utf-8", timeout=10)
        self.assertEqual(fresh.returncode, 0, fresh.stderr)
        self.assertIn("UPDATED-B-RUNTIME.", fresh.stdout)
        for _ in range(2):
            cached = subprocess.run(arguments + ["--cache-dir", str(self.cache)], cwd=copied,
                                    env=environment, capture_output=True, encoding="utf-8", timeout=10)
            self.assertEqual(cached.returncode, 0, cached.stderr)
            self.assertEqual(cached.stdout, fresh.stdout)

    def test_source_changed_during_cold_build_and_warm_read_fail_closed(self):
        build = vault.build_pack
        def changed(*args, **kwargs):
            result = build(*args, **kwargs)
            self.spec.write_text(note_text("SPEC-CACHE", required=True, body="Changed."), encoding="utf-8")
            return result
        with patch.object(vault, "build_pack", side_effect=changed):
            with self.assertRaisesRegex(vault.VaultError, "作成中"):
                self.pack()
        self.pack()
        fingerprint = vault.source_fingerprint
        def changed_read(root):
            self.spec.write_text(note_text("SPEC-CACHE", required=True, body="Changed again."), encoding="utf-8")
            return fingerprint(root)
        with patch.object(vault, "source_fingerprint", side_effect=changed_read):
            with self.assertRaisesRegex(vault.VaultError, "作成中"):
                self.pack()

    def test_missing_local_reference_is_not_bypassed_by_warm_parsed_note(self):
        reference = self.directory / "source.txt"
        reference.write_text("Local source", encoding="utf-8")
        self.spec.write_text(note_text("SPEC-CACHE", required=True, source_refs=[str(reference)]), encoding="utf-8")
        original, _ = self.pack()
        self.assertEqual(self.pack()[0], original)
        reference.unlink()
        with self.assertRaisesRegex(vault.VaultError, "ローカル出典"):
            self.pack()
        with self.assertRaisesRegex(vault.VaultError, "ローカル出典"):
            self.pack(cache_directory=None)

    def test_local_reference_deleted_during_build_is_withheld(self):
        reference = self.directory / "source.txt"
        reference.write_text("Local source", encoding="utf-8")
        self.spec.write_text(note_text("SPEC-CACHE", required=True, source_refs=[str(reference)]), encoding="utf-8")
        build = vault.build_pack
        def changed(*args, **kwargs):
            content = build(*args, **kwargs)
            reference.unlink()
            return content
        with patch.object(vault, "build_pack", side_effect=changed):
            with self.assertRaisesRegex(vault.VaultError, "ローカル出典"):
                self.pack()

    def test_native_exclusion_and_directory_pins_release_on_exception(self):
        original, _ = self.pack()
        with module.ContextCache(str(self.cache), self.root, vault.compiler_fingerprint()) as cache:
            with self.assertRaises(OSError):
                self.cache.rename(self.directory / "moved")
            with self.assertRaises(OSError):
                cache.directory.rename(self.directory / "namespace-moved")
            output = subprocess.run([sys.executable, str(Path(vault.__file__)), "--vault", str(self.root),
                "pack", "--project", "negi", "--role", "sol", "--query", "cache", "--stdout",
                "--cache-dir", str(self.cache), "--cache-stats"], capture_output=True, encoding="utf-8",
                env={**os.environ, "PYTHONIOENCODING": "utf-8"}, timeout=10)
            self.assertEqual(output.returncode, 0, output.stderr)
            self.assertEqual(output.stdout, original)
            self.assertFalse(json.loads(output.stderr)["context_cache"]["enabled"])
        self.assertTrue(self.pack()[1]["enabled"])

    def test_atomic_creation_pins_before_first_python_scheduling_point(self):
        original_pin = module.pin_directory
        attempts = []
        @contextmanager
        def racing(kernel, path, create=False, expected_identity=None):
            with original_pin(kernel, path, create, expected_identity) as created:
                if created:
                    with self.assertRaises(OSError):
                        path.rename(self.directory / ("displaced-" + path.name))
                    attempts.append(path)
                yield created
        with patch.object(module, "pin_directory", racing):
            self.assertTrue(self.pack()[1]["enabled"])
        self.assertEqual(len(attempts), 2)

    def test_existing_ancestor_substitution_is_rejected_before_writing(self):
        original_pin = module.pin_directory
        displaced = self.directory.with_name(self.directory.name + "-displaced")
        operator = self.directory / "operator-data"
        operator.mkdir()
        (operator / "sentinel.txt").write_text("keep", encoding="utf-8")
        replaced = False
        @contextmanager
        def racing(kernel, path, create=False, expected_identity=None):
            nonlocal replaced
            if path == self.directory:
                self.directory.rename(displaced)
                (displaced / "operator-data").rename(self.directory)
                replaced = True
            with original_pin(kernel, path, create, expected_identity) as created:
                yield created
        try:
            with patch.object(module, "pin_directory", racing):
                with self.assertRaisesRegex(vault.VaultError, "identity changed"):
                    self.pack()
            self.assertTrue(replaced)
            self.assertEqual(sorted(path.name for path in self.directory.iterdir()), ["sentinel.txt"])
        finally:
            if replaced:
                self.directory.rename(displaced / "operator-data")
                displaced.rename(self.directory)

    def test_abrupt_owned_process_exit_releases_guard_without_deleting_lock(self):
        self.pack()
        code = ("import sys; from pathlib import Path; import negi_context_cache as c; "
                "cache=c.ContextCache(sys.argv[1], Path(sys.argv[2]), sys.argv[3]); "
                "print('ready', flush=True); sys.stdin.readline()")
        child = subprocess.Popen([sys.executable, "-c", code, str(self.cache), str(self.root),
            vault.compiler_fingerprint()], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, env={**os.environ, "PYTHONPATH": str(Path(vault.__file__).parent)})
        try:
            self.assertEqual(child.stdout.readline().strip(), "ready")
            self.assertFalse(self.pack()[1]["enabled"])
            child.terminate()  # exact test-owned process; simulate abrupt death
            child.wait(timeout=10)
            self.assertEqual((self.cache / "cache-guard.lock").read_bytes(), b"")
            self.assertTrue(self.pack()[1]["enabled"])
        finally:
            if child.poll() is None:
                child.terminate()
            child.communicate(timeout=10)

    def test_authority_changed_during_warm_hit_is_withheld(self):
        self.add("40_Lessons/local.md", note_text("LESSON-CACHE", kind="Lesson", title="cache"))
        proof = self.directory / "proof"
        proof.mkdir()
        (proof / "server-signing-key").write_bytes(os.urandom(32))
        self.pack(knowledge_proof_dir=str(proof))
        with patch.object(KnowledgeAuthority, "allows", side_effect=[True, False]):
            with self.assertRaisesRegex(vault.VaultError, "作成中"):
                self.pack(knowledge_proof_dir=str(proof))

    def test_source_clearance_changed_without_version_bump_invalidates(self):
        original, _ = self.pack()
        self.spec.write_text(note_text("SPEC-CACHE", required=True, sensitivity="private"), encoding="utf-8")
        with self.assertRaisesRegex(vault.VaultError, "private"):
            self.pack()
        self.assertEqual(self.pack(allow_private=True)[0],
                         self.pack(allow_private=True, cache_directory=None)[0])
        self.assertNotEqual(self.pack(allow_private=True)[0], original)

    def test_unknown_root_partial_registration_and_corrupt_files_are_preserved(self):
        self.cache.mkdir()
        unrelated = self.cache / "unrelated.txt"
        unrelated.write_text("Keep operator data", encoding="utf-8")
        self.assertFalse(self.pack()[1]["enabled"])
        self.assertEqual(unrelated.read_text(encoding="utf-8"), "Keep operator data")
        self.assertFalse((self.cache / "cache-signing-key").exists())
        self.assertFalse((self.cache / "cache-guard.lock").exists())
        self.cache = self.directory / "registered"
        self.pack()
        unknown = self.entries("l1")[0].parent / ("l1-" + "f" * 64 + ".json")
        unknown.write_text("Untrusted file", encoding="utf-8")
        self.pack(query="change")
        self.assertEqual(unknown.read_text(encoding="utf-8"), "Untrusted file")

    def test_retention_limit_skips_publication_without_deleting_unknown_files(self):
        original, _ = self.pack()
        namespace = self.entries("l1")[0].parent
        for name in ("unknown1", "unknown2"):
            (namespace / name).write_text("keep", encoding="utf-8")
        with patch.object(module, "MAX_ENTRIES", 5):
            actual, stats = self.pack(query="new request")
            self.assertEqual(actual, self.pack(query="new request", cache_directory=None)[0])
            self.assertEqual(stats["counts"]["write_skipped"], 1)
            self.assertEqual(len(list(namespace.iterdir())), 5)
        self.assertEqual(self.pack()[0], original)

    def test_cache_maintenance_failure_after_fence_keeps_verified_pack(self):
        original, _ = self.pack()
        with patch.object(module.ContextCache, "prune", side_effect=module.CacheUnavailable("limit")):
            content, stats = self.pack(query="another")
            self.assertEqual(content, self.pack(query="another", cache_directory=None)[0])
            self.assertTrue(stats["maintenance_skipped"])
        with patch.object(module.ContextCache, "prune", side_effect=OSError("permission")):
            self.assertEqual(self.pack()[0], original)

    def test_hardlink_and_junction_not_read_or_deleted(self):
        original, _ = self.pack()
        source = self.entries("l2")[0]
        external = self.directory / "hardlink.json"
        os.link(source, external)
        actual, stats = self.pack()
        self.assertEqual(actual, original)
        self.assertGreater(stats["counts"]["invalid"], 0)
        self.assertEqual(source.read_bytes(), external.read_bytes())
        target = self.directory / "outside"
        target.mkdir()
        junction = self.directory / "junction"
        subprocess.run(["cmd", "/c", "mklink", "/J", str(junction), str(target)],
                       check=True, capture_output=True, timeout=10)
        try:
            with self.assertRaises(vault.VaultError):
                self.pack(cache_directory=str(junction / "cache"))
            self.assertFalse((target / "cache").exists())
        finally:
            junction.rmdir()

    def test_cache_cannot_overlap_vault_or_share_values_between_vaults(self):
        for path in (self.root, self.root / "cache", self.directory):
            with self.assertRaises(vault.VaultError):
                self.pack(cache_directory=str(path))
        original, _ = self.pack()
        other = self.directory / "OtherVault"
        (other / "10_Projects").mkdir(parents=True)
        (other / "10_Projects/spec.md").write_text(note_text("SPEC-CACHE", required=True,
            body="Different Vault rule."), encoding="utf-8")
        content, stats = self.pack(root=other)
        self.assertIn("Different Vault rule.", content)
        self.assertEqual(stats["counts"]["l2_miss"], 1)
        self.assertEqual(self.pack()[0], original)


if __name__ == "__main__":
    unittest.main()
