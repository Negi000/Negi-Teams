"""Synthetic, content-free tests for the offline historical importer."""

import importlib.util
from contextlib import closing, redirect_stderr, redirect_stdout
import io
import json
from pathlib import Path
import socket
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch


MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "historical_codex.py"
SPEC = importlib.util.spec_from_file_location("historical_codex", MODULE_PATH)
historical = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = historical
SPEC.loader.exec_module(historical)


def row(ordinal, outer, payload):
    return json.dumps({"timestamp": f"2026-09-01T00:00:{ordinal:02d}Z", "ordinal": ordinal,
                       "type": outer, "payload": payload}, ensure_ascii=False).encode() + b"\n"


def tokens(input_value, output_value, cached=0, reasoning=0):
    return dict(input_tokens=input_value, cached_input_tokens=cached,
                output_tokens=output_value, reasoning_output_tokens=reasoning,
                total_tokens=input_value + output_value)


class HistoricalCodexTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.out = self.root / "out"

    def tearDown(self):
        self.temp.cleanup()

    def import_paths(self, *paths):
        conn = historical.connect(self.out)
        try:
            for path in paths:
                historical.import_file(conn, path)
            return conn
        except Exception:
            conn.close()
            raise

    def test_status_only_detects_stale_snapshot_without_changing_database_or_report(self):
        source = self.root / "rollout-status.jsonl"
        source.write_bytes(row(1, "session_meta", {"id": "session-status"}))
        with closing(historical.connect(self.out)) as conn:
            historical.import_file(conn, source)
        report_path = self.out / "report.md"
        report_path.write_text("# Codex履歴ローカル診断（Phase 1）\nfixture\n", encoding="utf-8")
        database = self.out / "historical-codex.sqlite3"
        database_before = database.read_bytes()
        report_before = report_path.read_bytes()
        with redirect_stdout(io.StringIO()) as output:
            self.assertEqual(historical.main(["--status-only", "--out", str(self.out)]), 0)
        fresh = json.loads(output.getvalue())
        self.assertEqual((fresh["saved_sources"], fresh["metadata_matches"]), (1, 1))
        self.assertEqual(fresh["metadata_changed"], 0)

        with source.open("ab") as stream:
            stream.write(row(2, "event_msg", {"type": "task_complete"}))
        with redirect_stdout(io.StringIO()) as output:
            self.assertEqual(historical.main(["--status-only", "--out", str(self.out)]), 2)
        stale = json.loads(output.getvalue())
        self.assertEqual(stale["metadata_changed"], 1)
        self.assertEqual(stale["changed_examples"][0]["path"], str(source))
        self.assertEqual(database.read_bytes(), database_before)
        self.assertEqual(report_path.read_bytes(), report_before)

    def test_observed_turn_boundary_and_usage_mapping_keeps_unmatched_turns_explicit(self):
        source = self.root / "rollout-turn-map.jsonl"
        source.write_bytes(b"".join([
            row(1, "session_meta", {"id": "session-map"}),
            row(2, "event_msg", {"type": "task_started", "turn_id": "turn-a"}),
            row(3, "response_item", {"type": "message", "role": "user", "turn_id": "turn-a"}),
            row(4, "event_msg", {"type": "token_count", "info": {}}),
            row(5, "token_usage_record", {"turn_id": "turn-a", "response_id": "response-a",
                                          "usage": tokens(10, 2)}),
            row(6, "event_msg", {"type": "task_started", "turn_id": "turn-b"}),
            row(7, "token_usage_record", {"turn_id": "turn-orphan", "response_id": "response-b",
                                          "usage": tokens(3, 1)}),
        ]))
        with closing(historical.connect(self.out)) as conn:
            historical.import_file(conn, source)
            diagnostic = historical.report(conn)
        self.assertIn("ユーザー入力を観測した(session,turn): 1、task_startedを観測: 2、どちらかを観測: 2", diagnostic)
        self.assertIn("境界候補のうちusage観測: 1、usage未観測: 1。usageはあるが両方の境界を観測しないturn: 1", diagnostic)
        self.assertIn(f"境界 `{source}:2`", diagnostic)
        self.assertIn(f"usage代表 `{source}:5`", diagnostic)
        self.assertNotIn(f"usage代表 `{source}:4`", diagnostic)
        report_path = self.out / "report.md"
        report_path.write_text("# Codex履歴ローカル診断（Phase 1）\nold\n", encoding="utf-8")
        database = self.out / "historical-codex.sqlite3"
        database_before = database.read_bytes()
        source_before = source.read_bytes()
        report_before = report_path.read_bytes()
        with patch.object(historical.os, "replace", side_effect=OSError("replacement failed")):
            with self.assertRaisesRegex(OSError, "replacement failed"):
                historical.report_from_saved_database(self.out)
        self.assertEqual(report_path.read_bytes(), report_before)
        self.assertEqual(list(self.out.glob(".report-*.tmp")), [])
        with redirect_stdout(io.StringIO()):
            self.assertEqual(historical.main(["--report-from-db", "--out", str(self.out)]), 0)
        self.assertIn("境界候補のうちusage観測: 1", report_path.read_text(encoding="utf-8"))
        self.assertEqual(database.read_bytes(), database_before)
        self.assertEqual(source.read_bytes(), source_before)

    def test_existing_unrelated_output_is_not_overwritten(self):
        unrelated = self.root / "unrelated-out"
        unrelated.mkdir()
        database = unrelated / "historical-codex.sqlite3"
        with closing(sqlite3.connect(database)) as conn:
            conn.execute("CREATE TABLE private_data(value TEXT)")
            conn.commit()
        before = database.read_bytes()
        with self.assertRaisesRegex(ValueError, "診断DBではありません"):
            historical.connect(unrelated)
        self.assertEqual(database.read_bytes(), before)

        guarded = self.root / "guarded-out"
        with closing(historical.connect(guarded)):
            pass
        report = guarded / "report.md"
        report.write_text("unrelated report", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "report.md"):
            historical.connect(guarded)
        self.assertEqual(report.read_text(encoding="utf-8"), "unrelated report")

    def test_output_symlink_cannot_write_through_to_unrelated_file(self):
        guarded = self.root / "guarded-out"
        with closing(historical.connect(guarded)):
            pass
        report = guarded / "report.md"
        target = self.root / "private.txt"
        target.write_text("private", encoding="utf-8")
        try:
            report.symlink_to(target)
        except (OSError, NotImplementedError):
            self.skipTest("symlink creation unavailable on this Windows host")
        with self.assertRaises(ValueError):
            historical.connect(guarded)
        self.assertEqual(target.read_text(encoding="utf-8"), "private")

    def test_incremental_dedup_copy_model_change_parent_and_private_content(self):
        path = self.root / "rollout-main.jsonl"
        copied = self.root / "rollout-copy.jsonl"
        sentinel = "PRIVATE_PROMPT_MUST_NOT_BE_STORED"
        data = b"".join([
            row(1, "session_meta", {"id": "session-a", "cli_version": "0.test", "thread_source": "subagent",
                                     "source": {"subagent": {"thread_spawn": {"parent_thread_id": "parent-a"}}}}),
            row(2, "event_msg", {"type": "task_started", "turn_id": "turn-1"}),
            row(3, "turn_context", {"turn_id": "turn-1", "model": "model-a", "effort": "low"}),
            row(4, "response_item", {"type": "message", "role": "user", "content": sentinel}),
            row(5, "token_usage_record", {"turn_id": "turn-1", "response_id": "response-1",
                                          "usage": tokens(100, 20, 40, 5),
                                          "thread_token_usage": tokens(100, 20, 40, 5)}),
            row(6, "event_msg", {"type": "token_count", "info": {"total_token_usage": tokens(100, 20, 40, 5)}}),
            row(7, "turn_context", {"turn_id": "turn-1", "model": "model-b", "effort": "high"}),
            row(8, "token_usage_record", {"turn_id": "turn-1", "response_id": "response-2",
                                          "usage": tokens(50, 10, 10, 3)}),
            row(9, "compacted", {"window_number": 1}),
            row(10, "event_msg", {"type": "unknown_future_event"}),
            row(11, "event_msg", {"type": "task_complete", "turn_id": "turn-1", "duration_ms": 1200}),
        ])
        path.write_bytes(data)
        copied.write_bytes(data)
        original_hash = historical.file_digest(path)
        with patch.object(socket, "socket", side_effect=AssertionError("network used")):
            conn = self.import_paths(path, copied)
            self.assertEqual(historical.import_file(conn, path), "unchanged")
        totals, coverage, resets, conflicts, per_turn, _ = historical.calculate_usage(conn)
        self.assertEqual((totals["input_tokens"], totals["output_tokens"]), (150, 30))
        self.assertEqual((totals["cached_input_tokens"], totals["reasoning_output_tokens"]), (50, 8))
        self.assertEqual(coverage["response_incremental_sessions"], 1)
        self.assertEqual((resets, conflicts), (0, 0))
        self.assertEqual(per_turn[("session-a", "turn-1")]["input_tokens"], 150)
        self.assertEqual(conn.execute("SELECT count(*) FROM events").fetchone()[0], 11)
        self.assertEqual(conn.execute("SELECT count(*) FROM event_locations").fetchone()[0], 22)
        self.assertEqual(conn.execute("SELECT count(*) FROM events WHERE unknown_event=1").fetchone()[0], 1)
        self.assertEqual(conn.execute("SELECT count(*) FROM events WHERE outer_type='compacted'").fetchone()[0], 1)
        self.assertEqual(conn.execute("SELECT count(*) FROM events WHERE parent_session_id='parent-a'").fetchone()[0], 11)
        self.assertEqual(conn.execute("SELECT count(DISTINCT model) FROM events WHERE outer_type='turn_context'").fetchone()[0], 2)
        self.assertNotIn(sentinel.encode(), (self.out / "historical-codex.sqlite3").read_bytes())
        self.assertEqual(historical.file_digest(path), original_hash)
        self.assertIn("重複イベント出現箇所: 11", historical.report(conn))
        conn.close()

    def test_cumulative_reset_missing_corrupt_and_unfinished(self):
        path = self.root / "rollout-old.jsonl"
        path.write_bytes(b"".join([
            row(1, "session_meta", {"id": "old-session"}),
            row(2, "event_msg", {"type": "task_started", "turn_id": "turn-a"}),
            row(3, "turn_context", {"turn_id": "turn-a"}),
            row(4, "event_msg", {"type": "token_count", "info": {"total_token_usage": tokens(10, 2, 4, 1)}}),
            row(5, "event_msg", {"type": "token_count", "info": {"total_token_usage": tokens(15, 5, 5, 2)}}),
            row(6, "event_msg", {"type": "token_count", "info": {"total_token_usage": tokens(3, 1, 1, 0)}}),
            b"not-json\n", b'{"timestamp":"partial"'
        ]))
        conn = self.import_paths(path)
        totals, coverage, resets, _, _, _ = historical.calculate_usage(conn)
        self.assertEqual((totals["input_tokens"], totals["output_tokens"]), (18, 6))
        self.assertGreater(resets, 0)
        self.assertEqual(coverage["cumulative_fallback_sessions"], 1)
        self.assertEqual(dict(conn.execute("SELECT kind,count(*) FROM issues GROUP BY kind")),
                         {"invalid_json": 1, "incomplete_final_line": 1})
        self.assertEqual(conn.execute("SELECT count(*) FROM events WHERE outer_type='turn_context' AND model IS NULL AND effort IS NULL").fetchone()[0], 1)
        self.assertIn("model欠測: 1", historical.report(conn))
        self.assertIn("## 成果の裏づけ", historical.report(conn))
        self.assertIn("テスト合否: 未取得", historical.report(conn))
        self.assertIn("ユーザーの明示評価・受入: 未取得", historical.report(conn))
        self.assertIn("生成時刻は全候補の再走査時刻ではない", historical.report(conn))
        conn.close()

    def test_child_cumulative_starts_from_inherited_parent_baseline(self):
        parent = self.root / "rollout-parent.jsonl"
        child = self.root / "rollout-child.jsonl"
        parent.write_bytes(b"".join([
            row(1, "session_meta", {"id": "parent-a", "thread_source": "user"}),
            row(2, "event_msg", {"type": "task_started", "turn_id": "parent-turn"}),
            row(3, "event_msg", {"type": "token_count", "info": {
                "total_token_usage": tokens(100, 10)}}),
        ]))
        child.write_bytes(b"".join([
            row(1, "session_meta", {"id": "child-a", "thread_source": "subagent",
                                    "source": {"subagent": {"thread_spawn": {
                                        "parent_thread_id": "parent-a"}}}}),
            row(2, "event_msg", {"type": "task_started", "turn_id": "child-turn"}),
            row(3, "event_msg", {"type": "token_count", "info": {
                "total_token_usage": tokens(100, 10)}}),
            row(4, "event_msg", {"type": "token_count", "info": {
                "total_token_usage": tokens(130, 15)}}),
        ]))
        conn = self.import_paths(parent, child)
        totals, coverage, _, _, per_turn, refs = historical.calculate_usage(conn)
        self.assertEqual((totals["input_tokens"], totals["output_tokens"]), (130, 15))
        self.assertEqual((per_turn[("child-a", "child-turn")]["input_tokens"],
                          per_turn[("child-a", "child-turn")]["output_tokens"]), (30, 5))
        self.assertEqual(coverage["parent_baseline_excluded_sessions"], 1)
        self.assertEqual(refs[("child-a", "child-turn")]["scope"], "session_cumulative_reported")
        self.assertIsNotNone(refs[("child-a", "child-turn")]["previous_event_key"])
        self.assertIn("継承基準値として除外: 1 session", historical.report(conn))
        self.assertIn(f"usage代表 `{child}:4`", historical.report(conn))
        self.assertIn(f"直前通知 `{child}:3`", historical.report(conn))
        self.assertIn("turn候補でturn_context未観測: 2/2", historical.report(conn))
        conn.close()

    def test_changed_source_replaces_old_locations_and_rejects_unsafe_sources(self):
        path = self.root / "rollout-replace.jsonl"
        path.write_bytes(row(1, "session_meta", {"id": "replace"}) + row(2, "response_item", {"type": "message", "role": "user", "content": "old"}))
        conn = self.import_paths(path)
        self.assertEqual(conn.execute("SELECT count(*) FROM events").fetchone()[0], 2)
        path.write_bytes(row(1, "session_meta", {"id": "replace"}))
        self.assertEqual(historical.import_file(conn, path), "imported")
        self.assertEqual(conn.execute("SELECT count(*) FROM events").fetchone()[0], 1)
        conn.close()
        bad = self.root / "auth.json"
        bad.write_text("{}")
        with self.assertRaises(ValueError):
            historical.source_files([str(bad)], self.out)
        with self.assertRaises(ValueError):
            historical.source_files([str(self.root)], self.out)
        unrelated = self.root / "not-dedicated"
        unrelated.mkdir()
        (unrelated / "auth.json").write_text("{}")
        with self.assertRaises(ValueError):
            historical.connect(unrelated)
        self.assertEqual((unrelated / "auth.json").read_text(), "{}")

    def test_append_replays_only_tail_and_completes_pending_final_line(self):
        path = self.root / "rollout-growing.jsonl"
        prefix = b"".join([
            row(1, "session_meta", {"id": "growing"}),
            row(2, "event_msg", {"type": "task_started", "turn_id": "turn-grow"}),
            row(3, "turn_context", {"turn_id": "turn-grow", "model": "observed-model", "effort": "medium"}),
            row(4, "token_usage_record", {"response_id": "r1", "usage": tokens(10, 2)}),
        ])
        path.write_bytes(prefix)
        conn = self.import_paths(path)
        new_row = row(5, "token_usage_record", {"response_id": "r2", "usage": tokens(7, 3)})
        with path.open("ab") as stream:
            stream.write(new_row)
        with patch.object(historical, "_insert_event", wraps=historical._insert_event) as insert:
            self.assertEqual(historical.import_file(conn, path), "appended")
            self.assertEqual(insert.call_count, 1)
        self.assertEqual(conn.execute("SELECT count(*) FROM events").fetchone()[0], 5)
        self.assertEqual(historical.calculate_usage(conn)[0]["input_tokens"], 17)
        self.assertEqual(conn.execute("SELECT model FROM events WHERE response_id='r2'").fetchone()[0], "observed-model")

        unfinished = row(6, "event_msg", {"type": "task_complete", "turn_id": "turn-grow"})
        with path.open("ab") as stream:
            stream.write(unfinished[:-4])
        self.assertEqual(historical.import_file(conn, path), "appended")
        self.assertEqual(conn.execute("SELECT kind FROM issues").fetchone()[0], "incomplete_final_line")
        with path.open("ab") as stream:
            stream.write(unfinished[-4:])
        with patch.object(historical, "_insert_event", wraps=historical._insert_event) as insert:
            self.assertEqual(historical.import_file(conn, path), "appended")
            self.assertEqual(insert.call_count, 1)
        self.assertEqual(conn.execute("SELECT count(*) FROM issues").fetchone()[0], 0)
        self.assertEqual(conn.execute("SELECT count(*) FROM events").fetchone()[0], 6)
        self.assertEqual(conn.execute("SELECT count(*) FROM event_locations").fetchone()[0], 6)
        self.assertEqual(historical.import_file(conn, path), "unchanged")
        conn.close()

    def test_two_files_same_session_keep_distinct_turns_as_resume_candidate(self):
        first = self.root / "rollout-resume-one.jsonl"
        second = self.root / "rollout-resume-two.jsonl"
        first.write_bytes(b"".join([
            row(1, "session_meta", {"id": "shared-session", "cli_version": "old"}),
            row(2, "event_msg", {"type": "task_started", "turn_id": "first-turn"}),
            row(3, "turn_context", {"turn_id": "first-turn", "model": "model-a", "effort": "low"}),
            row(4, "token_usage_record", {"response_id": "first-response", "usage": tokens(5, 1)}),
        ]))
        second.write_bytes(b"".join([
            row(1, "session_meta", {"id": "shared-session", "cli_version": "new"}),
            row(2, "event_msg", {"type": "task_started", "turn_id": "second-turn"}),
            row(3, "turn_context", {"turn_id": "second-turn", "model": "model-b", "effort": "high"}),
            row(4, "token_usage_record", {"response_id": "second-response", "usage": tokens(8, 2)}),
        ]))
        conn = self.import_paths(first, second)
        self.assertEqual(conn.execute("SELECT count(DISTINCT session_id) FROM events").fetchone()[0], 1)
        self.assertEqual(conn.execute("SELECT count(DISTINCT turn_id) FROM events WHERE turn_id IS NOT NULL").fetchone()[0], 2)
        self.assertEqual(historical.calculate_usage(conn)[0]["input_tokens"], 13)
        self.assertIn("複数ソースに現れたsession: 1", historical.report(conn))
        self.assertIn("異なる内容hash 2", historical.report(conn))
        conn.close()

    def test_same_turn_id_across_sessions_is_reported_separately_from_event_duplicates(self):
        first = self.root / "rollout-parent-turn.jsonl"
        second = self.root / "rollout-child-turn.jsonl"
        for path, session_id in ((first, "parent-a"), (second, "child-a")):
            path.write_bytes(b"".join([
                row(1, "session_meta", {"id": session_id}),
                row(2, "event_msg", {"type": "task_started", "turn_id": "shared-turn"}),
                row(3, "token_usage_record", {"turn_id": "shared-turn",
                                               "response_id": session_id,
                                               "usage": tokens(10, 1)}),
            ]))
        conn = self.import_paths(first, second)
        diagnostic = historical.report(conn)
        self.assertIn("重複イベント出現箇所: 0", diagnostic)
        self.assertIn("複数sessionに現れた同一turn ID: 1 種 / 2 session-turn", diagnostic)
        self.assertIn("UUID形式 0 種、その他 1 種", diagnostic)
        self.assertIn("session `parent-a`", diagnostic)
        self.assertIn("session `child-a`", diagnostic)
        conn.close()

    def test_source_symlink_is_rejected_before_resolving(self):
        target = self.root / "rollout-target.jsonl"
        alias = self.root / "rollout-alias.jsonl"
        target.write_bytes(row(1, "session_meta", {"id": "target"}))
        try:
            alias.symlink_to(target)
        except (OSError, NotImplementedError):
            self.skipTest("symlink creation unavailable on this Windows host")
        with self.assertRaisesRegex(ValueError, "シンボリックリンク"):
            historical.source_files([str(alias)], self.out)

    def test_new_turn_does_not_inherit_model_and_parser_rebuild_updates_event(self):
        path = self.root / "rollout-model-gap.jsonl"
        path.write_bytes(b"".join([
            row(1, "session_meta", {"id": "model-gap"}),
            row(2, "event_msg", {"type": "task_started", "turn_id": "first"}),
            row(3, "turn_context", {"turn_id": "first", "model": "observed-a", "effort": "high"}),
            row(4, "event_msg", {"type": "task_started", "turn_id": "second"}),
            row(5, "token_usage_record", {"turn_id": "second", "response_id": "gap-response",
                                          "usage": tokens(2, 1)}),
        ]))
        conn = self.import_paths(path)
        self.assertEqual(conn.execute("SELECT model,effort FROM events WHERE response_id='gap-response'").fetchone(),
                         (None, None))
        conn.execute("UPDATE events SET model='stale',effort='stale' WHERE response_id='gap-response'")
        conn.execute("UPDATE source_files SET parser_version='old' WHERE path=?", (str(path),))
        conn.commit()
        self.assertEqual(historical.import_file(conn, path), "imported")
        self.assertEqual(conn.execute("SELECT model,effort FROM events WHERE response_id='gap-response'").fetchone(),
                         (None, None))
        self.assertEqual(conn.execute("SELECT count(*) FROM events").fetchone()[0], 5)
        conn.close()

    def test_missing_usage_field_stays_unknown_while_observed_zero_stays_zero(self):
        path = self.root / "rollout-partial-usage.jsonl"
        path.write_bytes(b"".join([
            row(1, "session_meta", {"id": "partial-usage"}),
            row(2, "event_msg", {"type": "task_started", "turn_id": "partial-turn"}),
            row(3, "token_usage_record", {"turn_id": "partial-turn", "response_id": "partial-response",
                                          "usage": {"output_tokens": 0}}),
        ]))
        conn = self.import_paths(path)
        totals, _, _, _, per_turn, _ = historical.calculate_usage(conn)
        self.assertIsNone(totals["input_tokens"])
        self.assertEqual(totals["output_tokens"], 0)
        self.assertIsNone(per_turn[("partial-usage", "partial-turn")]["input_tokens"])
        self.assertEqual(per_turn[("partial-usage", "partial-turn")]["output_tokens"], 0)
        self.assertIn("input 未取得 / output 0", historical.report(conn))
        conn.close()

    def test_changed_source_is_reported_and_other_files_continue(self):
        moving = self.root / "rollout-a-moving.jsonl"
        stable = self.root / "rollout-b-stable.jsonl"
        moving.write_bytes(row(1, "session_meta", {"id": "moving"}))
        stable.write_bytes(row(1, "session_meta", {"id": "stable"}))
        arguments = ["--source", str(moving), "--source", str(stable), "--out", str(self.out)]
        original = historical.import_file

        def import_or_change(conn, path):
            if path == moving:
                raise historical.SourceChangedDuringRead("fixture changed")
            return original(conn, path)

        with patch.object(historical, "import_file", side_effect=import_or_change), \
                redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            self.assertEqual(historical.main(arguments), 2)
        with closing(sqlite3.connect(self.out / "historical-codex.sqlite3")) as conn:
            self.assertEqual(conn.execute("SELECT count(*) FROM source_files").fetchone()[0], 1)
            self.assertEqual(conn.execute("SELECT count(*) FROM skipped_sources").fetchone()[0], 1)
        self.assertIn("保留中の入力ファイル: 1", (self.out / "report.md").read_text(encoding="utf-8"))
        with redirect_stdout(io.StringIO()):
            self.assertEqual(historical.main(arguments), 0)
        with closing(sqlite3.connect(self.out / "historical-codex.sqlite3")) as conn:
            self.assertEqual(conn.execute("SELECT count(*) FROM source_files").fetchone()[0], 2)
            self.assertEqual(conn.execute("SELECT count(*) FROM skipped_sources").fetchone()[0], 0)
        with patch.object(historical, "import_file", side_effect=import_or_change), \
                redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            self.assertEqual(historical.main(arguments), 2)
        report = (self.out / "report.md").read_text(encoding="utf-8")
        self.assertIn("保留中の入力ファイル: 1（未取込: 0、過去版を集計に保持: 1）", report)
        self.assertIn("現在の内容は未反映", report)
        self.assertIn("過去版", report)

    def test_source_changed_during_hash_is_rejected_before_database_write(self):
        path = self.root / "rollout-live.jsonl"
        path.write_bytes(row(1, "session_meta", {"id": "live"}))
        original = historical.file_digests

        def hash_then_append(source, prefix_bytes=0):
            result = original(source, prefix_bytes)
            with source.open("ab") as stream:
                stream.write(row(2, "event_msg", {"type": "task_started", "turn_id": "new"}))
            return result

        with closing(historical.connect(self.out)) as conn:
            with patch.object(historical, "file_digests", side_effect=hash_then_append):
                with self.assertRaises(historical.SourceChangedDuringRead):
                    historical.import_file(conn, path)
            self.assertEqual(conn.execute("SELECT count(*) FROM source_files").fetchone()[0], 0)

    def test_source_growing_just_after_import_is_reported_as_stale_snapshot(self):
        path = self.root / "rollout-growing-after-import.jsonl"
        path.write_bytes(row(1, "session_meta", {"id": "growing-after-import"}))
        arguments = ["--source", str(path), "--out", str(self.out)]
        original = historical.import_file

        def append_after_import(conn, source):
            result = original(conn, source)
            with source.open("ab") as stream:
                stream.write(row(2, "event_msg", {"type": "task_started", "turn_id": "later"}))
            return result

        with patch.object(historical, "import_file", side_effect=append_after_import), \
                redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            self.assertEqual(historical.main(arguments), 2)
        with closing(sqlite3.connect(self.out / "historical-codex.sqlite3")) as conn:
            self.assertEqual(conn.execute("SELECT count(*) FROM events").fetchone()[0], 1)
            self.assertEqual(conn.execute("SELECT reason FROM skipped_sources").fetchone()[0],
                             "changed_after_import")
        diagnostic = (self.out / "report.md").read_text(encoding="utf-8")
        self.assertIn("過去版を集計に保持: 1", diagnostic)
        self.assertIn("生成時点の全元ファイルとの一致を保証しない", diagnostic)
        with redirect_stdout(io.StringIO()):
            self.assertEqual(historical.main(arguments), 0)
        with closing(sqlite3.connect(self.out / "historical-codex.sqlite3")) as conn:
            self.assertEqual(conn.execute("SELECT count(*) FROM events").fetchone()[0], 2)
            self.assertEqual(conn.execute("SELECT count(*) FROM skipped_sources").fetchone()[0], 0)


if __name__ == "__main__":
    unittest.main()
