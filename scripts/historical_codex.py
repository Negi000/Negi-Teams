"""Offline, metadata-only importer for Codex rollout JSONL.

The source paths are explicit. Original files are opened only for reading. No
message text, tool arguments, tool output, or reasoning is stored in SQLite.
"""

from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from contextlib import closing
from datetime import datetime, timezone
import hashlib
from itertools import chain
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import tempfile


PARSER_VERSION = "phase1-3"
UUID_IN_NAME = re.compile(r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})", re.I)
TOKEN_FIELDS = (
    "input_tokens", "cached_input_tokens", "cache_write_input_tokens",
    "output_tokens", "reasoning_output_tokens", "total_tokens",
)
KNOWN_OUTER = {
    "session_meta", "turn_context", "event_msg", "response_item", "compacted",
    "world_state", "token_usage_record", "inter_agent_communication_metadata",
}
KNOWN_INNER = {
    "event_msg": {"task_started", "task_complete", "token_count", "item_completed",
                  "thread_settings_applied", "thread_goal_updated", "user_message"},
    "response_item": {"message", "reasoning", "function_call", "function_call_output",
                      "custom_tool_call", "custom_tool_call_output", "agent_message"},
}


class SourceChangedDuringRead(RuntimeError):
    """A live rollout changed while being inspected; its transaction is rolled back."""


def obj(value):
    return value if isinstance(value, dict) else {}


def scalar(value):
    return value if isinstance(value, str) and value else None


def nonnegative_int(value):
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def file_digests(path: Path, prefix_bytes: int = 0) -> tuple[str, str]:
    full = hashlib.sha256()
    prefix = hashlib.sha256()
    remaining = prefix_bytes
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            full.update(chunk)
            if remaining:
                part = chunk[:remaining]
                prefix.update(part)
                remaining -= len(part)
    return full.hexdigest(), prefix.hexdigest()


def file_digest(path: Path) -> str:
    return file_digests(path)[0]


def connect(out_dir: Path):
    allowed = {"historical-codex.sqlite3", "historical-codex.sqlite3-journal",
               "historical-codex.sqlite3-wal", "historical-codex.sqlite3-shm", "report.md"}
    if out_dir.exists():
        if not out_dir.is_dir() or out_dir.is_symlink():
            raise ValueError("--out は診断専用ディレクトリを指定してください")
        children = list(out_dir.iterdir())
        if any(child.name not in allowed or child.is_symlink() or not child.is_file()
               for child in children):
            raise ValueError("--out は診断専用ディレクトリを指定してください")
        database = out_dir / "historical-codex.sqlite3"
        if not database.exists() and children:
            raise ValueError("既存の診断ファイルに対応するDBがありません")
        if database.exists():
            with closing(sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True)) as probe:
                tables = {row[0] for row in probe.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'")}
            if not {"source_files", "events", "event_locations", "issues",
                    "usage_observations", "skipped_sources"}.issubset(tables):
                raise ValueError("既存のSQLiteファイルはCodex履歴診断DBではありません")
        report_path = out_dir / "report.md"
        if report_path.exists():
            with report_path.open("rb") as stream:
                if not stream.read(64).startswith("# Codex履歴ローカル診断（Phase 1）".encode("utf-8")):
                    raise ValueError("既存のreport.mdはCodex履歴診断ではありません")
    out_dir.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(out_dir / "historical-codex.sqlite3")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS source_files (
            id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL,
            bytes INTEGER NOT NULL, mtime_ns INTEGER NOT NULL, session_id TEXT,
            cli_version TEXT, source_kind TEXT, parent_session_id TEXT,
            parser_version TEXT NOT NULL, line_count INTEGER NOT NULL,
            complete_offset INTEGER NOT NULL,
            imported_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS events (
            event_key TEXT PRIMARY KEY, session_id TEXT NOT NULL, timestamp TEXT,
            ordinal INTEGER, outer_type TEXT, inner_type TEXT, turn_id TEXT,
            root_turn_id TEXT, role TEXT, model TEXT, effort TEXT, tool_name TEXT,
            call_id TEXT, response_id TEXT, result_status TEXT, duration_ms INTEGER,
            parent_session_id TEXT, item_type TEXT, exit_code INTEGER,
            unknown_event INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS event_locations (
            source_id INTEGER NOT NULL REFERENCES source_files(id) ON DELETE CASCADE,
            line_no INTEGER NOT NULL, byte_offset INTEGER NOT NULL,
            event_key TEXT NOT NULL REFERENCES events(event_key) ON DELETE CASCADE,
            PRIMARY KEY(source_id, line_no)
        );
        CREATE TABLE IF NOT EXISTS issues (
            source_id INTEGER NOT NULL REFERENCES source_files(id) ON DELETE CASCADE,
            line_no INTEGER NOT NULL, byte_offset INTEGER NOT NULL,
            kind TEXT NOT NULL, line_sha256 TEXT NOT NULL,
            PRIMARY KEY(source_id, line_no, kind)
        );
        CREATE TABLE IF NOT EXISTS skipped_sources (
            path TEXT PRIMARY KEY, reason TEXT NOT NULL, observed_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS usage_observations (
            event_key TEXT NOT NULL REFERENCES events(event_key) ON DELETE CASCADE,
            scope TEXT NOT NULL, response_id TEXT, input_tokens INTEGER,
            cached_input_tokens INTEGER, cache_write_input_tokens INTEGER,
            output_tokens INTEGER, reasoning_output_tokens INTEGER, total_tokens INTEGER,
            PRIMARY KEY(event_key, scope)
        );
        CREATE INDEX IF NOT EXISTS events_session_idx ON events(session_id, timestamp, ordinal);
        CREATE INDEX IF NOT EXISTS events_turn_idx ON events(session_id, turn_id);
        CREATE INDEX IF NOT EXISTS event_locations_event_idx ON event_locations(event_key);
        CREATE TEMP TABLE IF NOT EXISTS changed_event_keys(event_key TEXT PRIMARY KEY);
    """)
    return conn


def source_files(paths: list[str] | None, out_dir: Path) -> list[Path]:
    if not paths:
        raise ValueError("--source を少なくとも一つ指定してください")
    result = set()
    for raw in paths:
        requested = Path(raw).expanduser()
        if requested.is_symlink():
            raise ValueError(f"シンボリックリンクの入力は対象外です: {requested}")
        root = requested.resolve(strict=True)
        if root.is_dir():
            if out_dir == root or out_dir.is_relative_to(root):
                raise ValueError("出力先を入力ディレクトリの下に置けません")
            candidates = root.rglob("rollout-*.jsonl")
        else:
            candidates = [root]
        for candidate in candidates:
            if candidate.is_symlink() or not candidate.is_file() or not candidate.name.startswith("rollout-") or candidate.suffix != ".jsonl":
                raise ValueError(f"Codex rollout JSONL 以外は対象外です: {candidate}")
            resolved = candidate.resolve(strict=True)
            if resolved == out_dir or out_dir in resolved.parents:
                raise ValueError("出力先を入力にできません")
            result.add(resolved)
    if not result:
        raise ValueError("指定範囲にrollout JSONLがありません")
    return sorted(result)


def _session_id(path: Path, payload: dict) -> str:
    found = scalar(payload.get("id")) or scalar(payload.get("session_id"))
    if found:
        return found
    match = UUID_IN_NAME.search(path.name)
    return match.group(1) if match else "unidentified:" + digest(str(path).encode())[:20]


def _parent_id(payload: dict):
    spawn = obj(obj(obj(payload.get("source")).get("subagent")).get("thread_spawn"))
    return scalar(spawn.get("parent_thread_id"))


def _usage_rows(outer: str | None, inner: str | None, payload: dict):
    if outer == "token_usage_record":
        for scope, field in (("response_incremental", "usage"),
                             ("turn_cumulative", "turn_token_usage"),
                             ("thread_cumulative", "thread_token_usage")):
            value = payload.get(field)
            if isinstance(value, dict):
                yield scope, value, scalar(payload.get("response_id"))
    elif outer == "event_msg" and inner == "token_count":
        info = obj(payload.get("info"))
        for scope, field in (("session_cumulative_reported", "total_token_usage"),
                             ("response_last_reported", "last_token_usage")):
            value = info.get(field)
            if isinstance(value, dict):
                yield scope, value, None


def _insert_event(conn, source_id: int, path: Path, line_no: int, offset: int,
                  raw: bytes, record: dict, state: dict, occurrences: Counter):
    payload = obj(record.get("payload"))
    outer = scalar(record.get("type"))
    inner = scalar(payload.get("type"))
    if outer == "session_meta":
        state["session_id"] = _session_id(path, payload)
        state["cli_version"] = scalar(payload.get("cli_version"))
        state["source_kind"] = scalar(payload.get("thread_source"))
        state["parent_session_id"] = _parent_id(payload)
    elif outer == "event_msg" and inner == "task_started":
        state["turn_id"] = scalar(payload.get("turn_id"))
        state["root_turn_id"] = scalar(payload.get("root_turn_id"))
        state["model"] = None
        state["effort"] = None
    elif outer == "turn_context":
        state["turn_id"] = scalar(payload.get("turn_id")) or state["turn_id"]
        state["root_turn_id"] = scalar(payload.get("root_turn_id")) or state["root_turn_id"]
        # An absent field never inherits a previous model or effort.
        state["model"] = scalar(payload.get("model"))
        state["effort"] = scalar(payload.get("effort"))

    canonical = json.dumps(record, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    line_hash = digest(canonical)
    ordinal = nonnegative_int(record.get("ordinal"))
    discriminator = str(ordinal) if ordinal is not None else str(occurrences[line_hash])
    occurrences[line_hash] += 1
    event_key = digest((state["session_id"] + "\0" + discriminator + "\0" + line_hash).encode())
    turn_id = scalar(payload.get("turn_id")) or state["turn_id"]
    root_turn_id = scalar(payload.get("root_turn_id")) or state["root_turn_id"]
    role = scalar(payload.get("role")) if outer == "response_item" else None
    tool_name = scalar(payload.get("name")) if inner in ("function_call", "custom_tool_call") else None
    call_id = scalar(payload.get("call_id")) if outer == "response_item" else None
    response_id = scalar(payload.get("response_id")) if outer == "token_usage_record" else None
    status = scalar(payload.get("status")) if outer == "response_item" else None
    item = obj(payload.get("item")) if inner == "item_completed" else {}
    item_type = scalar(item.get("type"))
    exit_code = item.get("exit_code") if isinstance(item.get("exit_code"), int) and not isinstance(item.get("exit_code"), bool) else None
    duration = nonnegative_int(payload.get("duration_ms")) if inner == "task_complete" else None
    if inner == "item_completed":
        started = nonnegative_int(payload.get("started_at_ms"))
        ended = nonnegative_int(payload.get("completed_at_ms"))
        duration = ended - started if started is not None and ended is not None and ended >= started else None
    unknown = int(outer not in KNOWN_OUTER or (outer in KNOWN_INNER and inner not in KNOWN_INNER[outer]))
    conn.execute("""INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(event_key) DO UPDATE SET
        session_id=excluded.session_id,timestamp=excluded.timestamp,ordinal=excluded.ordinal,
        outer_type=excluded.outer_type,inner_type=excluded.inner_type,turn_id=excluded.turn_id,
        root_turn_id=excluded.root_turn_id,role=excluded.role,model=excluded.model,
        effort=excluded.effort,tool_name=excluded.tool_name,call_id=excluded.call_id,
        response_id=excluded.response_id,result_status=excluded.result_status,
        duration_ms=excluded.duration_ms,parent_session_id=excluded.parent_session_id,
        item_type=excluded.item_type,exit_code=excluded.exit_code,unknown_event=excluded.unknown_event""",
                 (event_key, state["session_id"], scalar(record.get("timestamp")), ordinal,
                  outer, inner, turn_id, root_turn_id, role, state["model"], state["effort"],
                  tool_name, call_id, response_id, status, duration, state["parent_session_id"],
                  item_type, exit_code, unknown))
    conn.execute("INSERT OR REPLACE INTO event_locations VALUES (?,?,?,?)",
                 (source_id, line_no, offset, event_key))
    conn.execute("DELETE FROM usage_observations WHERE event_key=?", (event_key,))
    for scope, usage, usage_response_id in _usage_rows(outer, inner, payload):
        conn.execute("""INSERT INTO usage_observations VALUES (?,?,?,?,?,?,?,?,?)""",
                     (event_key, scope, usage_response_id,
                      *(nonnegative_int(usage.get(field)) for field in TOKEN_FIELDS)))


def import_file(conn, path: Path) -> str:
    before = path.stat()
    old = conn.execute("""SELECT id,sha256,parser_version,bytes,line_count,complete_offset,
        session_id,cli_version,source_kind,parent_session_id FROM source_files WHERE path=?""",
        (str(path),)).fetchone()
    prefix_length = old[3] if old and before.st_size > old[3] and old[2] == PARSER_VERSION else 0
    sha, prefix_sha = file_digests(path, prefix_length)
    if (before.st_size, before.st_mtime_ns) != (path.stat().st_size, path.stat().st_mtime_ns):
        raise SourceChangedDuringRead(f"読み取り中に入力ファイルが変化しました: {path}")
    if old and old[1] == sha and old[2] == PARSER_VERSION:
        return "unchanged"
    append = bool(old and prefix_length and prefix_sha == old[1])
    # The older no-ordinal fallback depends on prior occurrence counts. Reparse
    # these unusual files fully rather than guessing the next discriminator.
    if append and conn.execute("""SELECT 1 FROM event_locations l JOIN events e ON e.event_key=l.event_key
        WHERE l.source_id=? AND e.ordinal IS NULL LIMIT 1""", (old[0],)).fetchone():
        append = False
    state = dict(session_id=_session_id(path, {}), cli_version=None, source_kind=None,
                 parent_session_id=None, turn_id=None, root_turn_id=None, model=None, effort=None)
    occurrences = Counter()
    line_count = 0
    complete_offset = 0
    parsed_hash = hashlib.sha256()
    start_offset = 0
    if append:
        state.update(session_id=old[6], cli_version=old[7], source_kind=old[8], parent_session_id=old[9])
        previous = conn.execute("""SELECT e.turn_id,e.root_turn_id,e.model,e.effort
            FROM event_locations l JOIN events e ON e.event_key=l.event_key
            WHERE l.source_id=? ORDER BY l.line_no DESC LIMIT 1""", (old[0],)).fetchone()
        if previous:
            state.update(zip(("turn_id", "root_turn_id", "model", "effort"), previous))
        pending = conn.execute("""SELECT line_no,byte_offset FROM issues WHERE source_id=?
            AND kind='incomplete_final_line' AND line_no=?""", (old[0], old[4])).fetchone()
        start_offset = pending[1] if pending else old[3]
        line_count = old[4] - (1 if pending else 0)
        complete_offset = old[5]
    conn.execute("BEGIN")
    try:
        conn.execute("""INSERT INTO source_files
            (path,sha256,bytes,mtime_ns,session_id,cli_version,source_kind,parent_session_id,parser_version,line_count,complete_offset,imported_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(path) DO UPDATE SET sha256=excluded.sha256,bytes=excluded.bytes,
            mtime_ns=excluded.mtime_ns,session_id=excluded.session_id,cli_version=excluded.cli_version,
            source_kind=excluded.source_kind,parent_session_id=excluded.parent_session_id,
            parser_version=excluded.parser_version,line_count=excluded.line_count,
            complete_offset=excluded.complete_offset,imported_at=excluded.imported_at""",
            (str(path), sha, before.st_size, before.st_mtime_ns, state["session_id"], None, None, None,
             PARSER_VERSION, 0, 0, datetime.now(timezone.utc).isoformat()))
        source_id = conn.execute("SELECT id FROM source_files WHERE path=?", (str(path),)).fetchone()[0]
        conn.execute("DELETE FROM changed_event_keys")
        if append:
            conn.execute("""INSERT OR IGNORE INTO changed_event_keys
                SELECT event_key FROM event_locations WHERE source_id=? AND byte_offset>=?""",
                (source_id, start_offset))
            conn.execute("DELETE FROM event_locations WHERE source_id=? AND byte_offset>=?", (source_id, start_offset))
            conn.execute("DELETE FROM issues WHERE source_id=? AND byte_offset>=?", (source_id, start_offset))
        else:
            conn.execute("""INSERT OR IGNORE INTO changed_event_keys
                SELECT event_key FROM event_locations WHERE source_id=?""", (source_id,))
            conn.execute("DELETE FROM event_locations WHERE source_id=?", (source_id,))
            conn.execute("DELETE FROM issues WHERE source_id=?", (source_id,))
        with path.open("rb") as stream:
            stream.seek(start_offset)
            while raw := stream.readline():
                parsed_hash.update(raw)
                line_count += 1
                if line_count % 1000 == 0:
                    current = path.stat()
                    if (before.st_size, before.st_mtime_ns) != (current.st_size, current.st_mtime_ns):
                        raise SourceChangedDuringRead(f"読み取り中に入力ファイルが変化しました: {path}")
                offset = stream.tell() - len(raw)
                if not raw.endswith(b"\n"):
                    kind = "incomplete_final_line"
                else:
                    try:
                        record = json.loads(raw.decode("utf-8"))
                        if not isinstance(record, dict):
                            kind = "invalid_record"
                        else:
                            _insert_event(conn, source_id, path, line_count, offset, raw, record, state, occurrences)
                            complete_offset = stream.tell()
                            continue
                    except UnicodeDecodeError:
                        kind = "invalid_utf8"
                    except json.JSONDecodeError:
                        kind = "invalid_json"
                conn.execute("INSERT INTO issues VALUES (?,?,?,?,?)",
                             (source_id, line_count, offset, kind, digest(raw.rstrip(b"\r\n"))))
        after = path.stat()
        if ((not append and parsed_hash.hexdigest() != sha) or
                (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns)):
            raise SourceChangedDuringRead(f"読み取り中に入力ファイルが変化しました: {path}")
        conn.execute("""UPDATE source_files SET session_id=?,cli_version=?,source_kind=?,
            parent_session_id=?,line_count=?,complete_offset=? WHERE id=?""",
            (state["session_id"], state["cli_version"], state["source_kind"],
             state["parent_session_id"], line_count, complete_offset, source_id))
        conn.execute("""DELETE FROM events WHERE event_key IN (SELECT event_key FROM changed_event_keys)
            AND NOT EXISTS (SELECT 1 FROM event_locations WHERE event_key=events.event_key)""")
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return "appended" if append else "imported"


def calculate_usage(conn):
    """One canonical lane per session; never add nested token fields together."""
    sessions = [row[0] for row in conn.execute("SELECT DISTINCT session_id FROM events ORDER BY session_id")]
    totals = {field: 0 for field in TOKEN_FIELDS}
    coverage = Counter()
    reset_count = 0
    conflict_count = 0
    per_turn = defaultdict(lambda: {field: None for field in TOKEN_FIELDS})
    per_turn_refs = {}
    for session_id in sessions:
        subtotal = {field: 0 for field in TOKEN_FIELDS}
        observed = Counter()

        def add_observation(tokens, turn_id, event_key, scope, previous_event_key=None):
            contributed = False
            for field, value in zip(TOKEN_FIELDS, tokens):
                if value is None:
                    continue
                contributed = True
                subtotal[field] += value
                observed[field] += 1
                if turn_id:
                    values = per_turn[(session_id, turn_id)]
                    values[field] = (values[field] or 0) + value
            if contributed and turn_id:
                key = (session_id, turn_id)
                if key not in per_turn_refs:
                    per_turn_refs[key] = dict(event_key=event_key, scope=scope,
                                              previous_event_key=previous_event_key,
                                              observations=0)
                per_turn_refs[key]["observations"] += 1

        records = conn.execute("""SELECT u.response_id,e.event_key,e.turn_id,
            u.input_tokens,u.cached_input_tokens,u.cache_write_input_tokens,
            u.output_tokens,u.reasoning_output_tokens,u.total_tokens
            FROM usage_observations u JOIN events e ON e.event_key=u.event_key
            WHERE e.session_id=? AND u.scope='response_incremental'
            ORDER BY e.timestamp,e.ordinal,e.event_key""", (session_id,))
        first_record = records.fetchone()
        if first_record:
            coverage["response_incremental_sessions"] += 1
            seen = {}
            for response_id, event_key, turn_id, *tokens in chain((first_record,), records):
                key = response_id or event_key
                if key in seen:
                    if seen[key] != tokens:
                        conflict_count += 1
                    coverage["duplicate_usage_records"] += 1
                    continue
                seen[key] = tokens
                add_observation(tokens, turn_id, event_key, "response_incremental")
        else:
            # Forked/subagent rollouts can start with their parent's cumulative
            # counter. Treat the first observation as an inherited baseline,
            # not as tokens spent by the child.
            parented = conn.execute("""SELECT 1 FROM source_files WHERE session_id=?
                AND parent_session_id IS NOT NULL LIMIT 1""", (session_id,)).fetchone() is not None
            samples = conn.execute("""SELECT e.event_key,e.turn_id,u.input_tokens,u.cached_input_tokens,
                u.cache_write_input_tokens,u.output_tokens,u.reasoning_output_tokens,u.total_tokens
                FROM usage_observations u JOIN events e ON e.event_key=u.event_key
                WHERE e.session_id=? AND u.scope='session_cumulative_reported'
                ORDER BY e.timestamp,e.ordinal,e.event_key""", (session_id,))
            first_sample = samples.fetchone()
            if first_sample:
                coverage["cumulative_fallback_sessions"] += 1
            previous = [None] * len(TOKEN_FIELDS)
            previous_event_key = None
            for index, (event_key, turn_id, *tokens) in enumerate(chain((first_sample,), samples) if first_sample else ()):
                if index == 0 and parented:
                    previous = list(tokens)
                    previous_event_key = event_key
                    coverage["parent_baseline_excluded_sessions"] += 1
                    continue
                delta = []
                for i, current in enumerate(tokens):
                    prior = previous[i]
                    if current is None:
                        delta.append(None)
                    elif prior is None:
                        # A field that first appears later in a child can still
                        # contain the inherited counter; establish its baseline.
                        delta.append(None if parented else current)
                        previous[i] = current
                    elif current < prior:
                        reset_count += 1
                        delta.append(current)
                        previous[i] = current
                    else:
                        delta.append(current - prior)
                        previous[i] = current
                add_observation(delta, turn_id, event_key,
                                "session_cumulative_reported", previous_event_key)
                previous_event_key = event_key
        for field in TOKEN_FIELDS:
            if observed[field]:
                totals[field] += subtotal[field]
                coverage[field + "_sessions"] += 1
    return ({field: totals[field] if coverage[field + "_sessions"] else None for field in TOKEN_FIELDS},
            coverage, reset_count, conflict_count, per_turn, per_turn_refs)


def report(conn) -> str:
    sources = conn.execute("SELECT path,bytes,line_count,session_id,cli_version,source_kind,parent_session_id,sha256,complete_offset FROM source_files ORDER BY path").fetchall()
    last_imported_at = conn.execute("SELECT max(imported_at) FROM source_files").fetchone()[0]
    event_count = conn.execute("SELECT count(*) FROM events").fetchone()[0]
    location_count = conn.execute("SELECT count(*) FROM event_locations").fetchone()[0]
    sessions = conn.execute("SELECT count(DISTINCT session_id) FROM events").fetchone()[0]
    multi_source = conn.execute("""SELECT session_id,count(*),count(DISTINCT sha256)
        FROM source_files GROUP BY session_id HAVING count(*)>1 ORDER BY count(*) DESC,session_id""").fetchall()
    shared_turns = conn.execute("""SELECT turn_id,count(*) FROM (
        SELECT DISTINCT session_id,turn_id FROM events WHERE turn_id IS NOT NULL
        ) GROUP BY turn_id HAVING count(*)>1 ORDER BY count(*) DESC,turn_id""").fetchall()
    shared_uuid_turns = [row for row in shared_turns if UUID_IN_NAME.fullmatch(row[0])]
    shared_other_turns = [row for row in shared_turns if not UUID_IN_NAME.fullmatch(row[0])]
    turns = conn.execute("SELECT count(DISTINCT session_id || ':' || turn_id) FROM events WHERE turn_id IS NOT NULL").fetchone()[0]
    context_turns = conn.execute("""SELECT count(DISTINCT session_id || ':' || turn_id)
        FROM events WHERE outer_type='turn_context' AND turn_id IS NOT NULL""").fetchone()[0]
    issue_count = conn.execute("SELECT count(*) FROM issues").fetchone()[0]
    issue_counts = conn.execute("SELECT kind,count(*) FROM issues GROUP BY kind ORDER BY kind").fetchall()
    issue_examples = conn.execute("""SELECT s.path,i.line_no,i.byte_offset,i.kind FROM issues i
        JOIN source_files s ON s.id=i.source_id ORDER BY s.path,i.line_no LIMIT 20""").fetchall()
    skipped = conn.execute("""SELECT k.path,k.reason,k.observed_at,s.bytes,s.sha256
        FROM skipped_sources k LEFT JOIN source_files s ON s.path=k.path ORDER BY k.path""").fetchall()
    kinds = conn.execute("SELECT coalesce(outer_type,'(missing)'),coalesce(inner_type,''),count(*) FROM events GROUP BY 1,2 ORDER BY 3 DESC").fetchall()
    model_dist = conn.execute("""SELECT coalesce(model,'(unknown)'),coalesce(effort,'(unknown)'),count(*)
        FROM events WHERE outer_type='turn_context' GROUP BY 1,2 ORDER BY 3 DESC""").fetchall()
    contexts = conn.execute("""SELECT count(*),sum(CASE WHEN model IS NULL THEN 1 ELSE 0 END),
        sum(CASE WHEN effort IS NULL THEN 1 ELSE 0 END) FROM events WHERE outer_type='turn_context'""").fetchone()
    user_turn_keys = set(conn.execute("""SELECT DISTINCT session_id,turn_id FROM events
        WHERE turn_id IS NOT NULL AND
        ((outer_type='response_item' AND inner_type='message' AND role='user') OR
         (outer_type='event_msg' AND inner_type='user_message'))"""))
    started_turn_keys = set(conn.execute("""SELECT DISTINCT session_id,turn_id FROM events
        WHERE turn_id IS NOT NULL AND outer_type='event_msg' AND inner_type='task_started'"""))
    boundary_keys = user_turn_keys | started_turn_keys
    user_turns = len(user_turn_keys)
    completed = conn.execute("SELECT count(*),count(duration_ms),sum(duration_ms) FROM events WHERE inner_type='task_complete'").fetchone()
    commands = conn.execute("""SELECT count(*),count(exit_code),sum(CASE WHEN exit_code != 0 THEN 1 ELSE 0 END),
        count(duration_ms),sum(duration_ms) FROM events WHERE item_type='CommandExecution'""").fetchone()
    unknown = conn.execute("SELECT count(*) FROM events WHERE unknown_event=1").fetchone()[0]
    minmax = conn.execute("SELECT min(timestamp),max(timestamp) FROM events").fetchone()
    timestamp_missing = conn.execute("SELECT count(*) FROM events WHERE timestamp IS NULL").fetchone()[0]
    totals, coverage, resets, conflicts, per_turn, per_turn_refs = calculate_usage(conn)
    usage_turn_keys = set(per_turn)
    def event_ref(event_key):
        return conn.execute("""SELECT s.path,l.line_no,l.byte_offset FROM event_locations l
            JOIN source_files s ON s.id=l.source_id WHERE l.event_key=?
            ORDER BY s.path,l.line_no LIMIT 1""", (event_key,)).fetchone()
    lines = ["# Codex履歴ローカル診断（Phase 1）", "",
             f"生成時刻: {datetime.now(timezone.utc).isoformat()}",
             f"保存済みファイルの最終取込時刻: {last_imported_at or '未取得'}。生成時刻は全候補の再走査時刻ではない。",
             "保存内容は各ファイルの読取時点のスナップショット。保留件数は検出できた変化のみで、生成時点の全元ファイルとの一致を保証しない。",
             f"Parser: {PARSER_VERSION}。SQLiteにはイベントのメタデータと参照位置のみを保存。会話本文・ツール引数・出力・推論本文は保存しない。", "",
             "## 対象と形式", "",
             f"入力ファイル: {len(sources)}、入力行: {sum(x[2] for x in sources)}、ユニークイベント: {event_count}、出現箇所: {location_count}。",
             f"観測セッション: {sessions}、turn識別子: {turns}、ユーザーメッセージを観測したturn: {user_turns}。",
             f"イベント時刻範囲: {minmax[0] or '不明'} ～ {minmax[1] or '不明'}。",
             "ファイル一覧（元ファイル参照。各ファイルは読み取りのみ）:", ""]
    for path, size, count, sid, version, kind, parent, sha, complete_offset in sources:
        lines.append(f"- `{path}` — {size} bytes / {count} 行 / 完了読取位置 {complete_offset} bytes / SHA-256 `{sha}` / session `{sid or '不明'}` / CLI `{version or '不明'}` / source `{kind or '不明'}` / parent `{parent or 'なし・不明'}`")
    stale_count = sum(sha is not None for _, _, _, _, sha in skipped)
    lines.append(f"保留中の入力ファイル: {len(skipped)}（未取込: {len(skipped) - stale_count}、過去版を集計に保持: {stale_count}）。"
                 "現在の内容は未反映。過去版があるファイルは上の件数・usageにその版だけを含む。")
    for path, reason, observed_at, size, sha in skipped:
        prior = f"過去版 {size} bytes / SHA-256 `{sha}` を集計に保持" if sha else "未取込"
        lines.append(f"- `{path}` — {reason} / {prior} / 最終観測 {observed_at}")
    lines.append(f"複数ソースに現れたsession: {len(multi_source)}（コピー・移動・再開の候補であり、再開の確定ではない）。")
    for sid, file_count, hash_count in multi_source[:10]:
        lines.append(f"- session `{sid}`: {file_count} ファイル / 異なる内容hash {hash_count}")
    lines += ["", "## 欠測・重複・異常", "",
              f"turn_context: {contexts[0]}、model欠測: {contexts[1] or 0} ({(contexts[1] or 0) / contexts[0] * 100 if contexts[0] else 0:.1f}%)、effort欠測: {contexts[2] or 0} ({(contexts[2] or 0) / contexts[0] * 100 if contexts[0] else 0:.1f}%)。分母はturn_context行であり、全turnではない。",
              f"turn候補でturn_context未観測: {turns - context_turns}/{turns} ({(turns - context_turns) / turns * 100 if turns else 0:.1f}%)。これらのmodel/effortは未確認で、前のturnから補完しない。",
              f"timestamp欠測イベント: {timestamp_missing}/{event_count} ({timestamp_missing / event_count * 100 if event_count else 0:.1f}%)。usageがあるturn候補: {len(per_turn)}/{turns}（なし・対応不可 {turns - len(per_turn)}、{(turns - len(per_turn)) / turns * 100 if turns else 0:.1f}%）。",
              f"重複イベント出現箇所: {location_count - event_count}（同じsession・ordinal・内容の再出現）。response ID重複usage通知: {coverage['duplicate_usage_records']}、内容衝突: {conflicts}。",
              f"複数sessionに現れた同一turn ID: {len(shared_turns)} 種 / {sum(count for _, count in shared_turns)} session-turn（UUID形式 {len(shared_uuid_turns)} 種、その他 {len(shared_other_turns)} 種）。再開・継承・重複の候補であり、同じ作業やusageの二重計上とは未確定。",
              f"未知イベント: {unknown}、破損・未完了行: {issue_count}。"]
    for turn_id, session_count in (shared_uuid_turns + shared_other_turns)[:5]:
        refs = conn.execute("""SELECT session_id,path,line_no FROM (
            SELECT e.session_id,s.path,l.line_no,
                row_number() OVER (PARTITION BY e.session_id ORDER BY s.path,l.line_no) AS rn
            FROM events e JOIN event_locations l ON l.event_key=e.event_key
            JOIN source_files s ON s.id=l.source_id WHERE e.turn_id=?
            ) WHERE rn=1 ORDER BY session_id LIMIT 3""",
            (turn_id,)).fetchall()
        evidence = "、".join(f"session `{sid}` `{path}:{line_no}`" for sid, path, line_no in refs)
        lines.append(f"- 同一turn ID `{turn_id}`: {session_count} session — {evidence}")
    if len(shared_turns) > 5:
        lines.append(f"- その他 {len(shared_turns)-5} 種はSQLiteのevents表を参照。")
    for kind, count in issue_counts:
        lines.append(f"- {kind}: {count}")
    for path, line_no, offset, kind in issue_examples:
        lines.append(f"- 根拠: `{path}:{line_no}` byte {offset} — {kind}")
    if issue_count > 20:
        lines.append(f"- その他 {issue_count-20} 件はSQLiteのissues表を参照。")
    unknown_refs = conn.execute("""SELECT s.path,l.line_no,e.outer_type,e.inner_type FROM events e
        JOIN event_locations l ON l.event_key=e.event_key JOIN source_files s ON s.id=l.source_id
        WHERE e.unknown_event=1 ORDER BY s.path,l.line_no LIMIT 10""").fetchall()
    for path, line_no, outer, inner in unknown_refs:
        lines.append(f"- 未知イベント根拠: `{path}:{line_no}` — `{outer}/{inner or '-'}`")
    lines += ["", "## モデルとeffort（turn_context行の観測分布）", ""]
    for model, effort, count in model_dist:
        lines.append(f"- `{model}` / `{effort}`: {count}")
    if not model_dist:
        lines.append("- 未観測")
    lines += ["", "## イベント・工程・時間", ""]
    for outer, inner, count in kinds[:30]:
        lines.append(f"- `{outer}/{inner or '-'}`: {count}")
    if len(kinds) > 30:
        lines.append(f"- その他 {len(kinds)-30} 種はSQLiteのevents表を参照。")
    lines += [f"task_complete通知: {completed[0]}、duration_ms取得: {completed[1]}、その単純合計: {completed[2] if completed[2] is not None else '不明'} ms。並列・重複の可能性があるため壁時計時間ではない。",
              f"CommandExecution完了item: {commands[0]}、exit_code取得: {commands[1]}、非0: {commands[2] or 0}、duration取得: {commands[3]}、単純合計: {commands[4] if commands[4] is not None else '不明'} ms。実行コマンド本文は保存せず、テスト合否とは分類しない。",
              "モデル応答待ち・ツール実行・キュー・人間待ちの内訳は、この診断では未計測。", "",
              "turn候補（新しい順、最大20件。task受入判定ではない）:", ""]
    turn_rows = conn.execute("""SELECT session_id,turn_id,min(timestamp),
        sum(CASE WHEN outer_type='response_item' AND inner_type='message' AND role='user' THEN 1 ELSE 0 END),
        sum(CASE WHEN tool_name IS NOT NULL THEN 1 ELSE 0 END),
        sum(CASE WHEN inner_type='task_complete' THEN 1 ELSE 0 END),
        count(DISTINCT CASE WHEN outer_type='turn_context' THEN coalesce(model,'?') || '/' || coalesce(effort,'?') END)
        FROM events WHERE turn_id IS NOT NULL GROUP BY session_id,turn_id
        ORDER BY min(timestamp) DESC LIMIT 20""").fetchall()
    for sid, turn_id, first_at, user_count, tool_count, complete_count, model_pairs in turn_rows:
        values = per_turn.get((sid, turn_id))
        usage = f"input {values['input_tokens'] if values['input_tokens'] is not None else '未取得'} / output {values['output_tokens'] if values['output_tokens'] is not None else '未取得'}" if values else "usage未対応"
        loc = conn.execute("""SELECT s.path,l.line_no FROM events e JOIN event_locations l ON l.event_key=e.event_key
            JOIN source_files s ON s.id=l.source_id WHERE e.session_id=? AND e.turn_id=?
            ORDER BY e.timestamp,e.ordinal,s.path,l.line_no LIMIT 1""", (sid, turn_id)).fetchone()
        evidence = f"`{loc[0]}:{loc[1]}`" if loc else "参照不明"
        lines.append(f"- `{first_at or '時刻不明'}` session `{sid}` turn `{turn_id}`: user {user_count} / tool呼出 {tool_count} / task_complete {complete_count} / model-effort組 {model_pairs} / {usage} — {evidence}")
    if not turn_rows:
        lines.append("- 未観測")
    lines += ["", "## turn境界候補とusageの対応", "",
              f"ユーザー入力を観測した(session,turn): {len(user_turn_keys)}、task_startedを観測: {len(started_turn_keys)}、どちらかを観測: {len(boundary_keys)}。重なりは一度だけ数える。",
              f"境界候補のうちusage観測: {len(boundary_keys & usage_turn_keys)}、usage未観測: {len(boundary_keys - usage_turn_keys)}。usageはあるが両方の境界を観測しないturn: {len(usage_turn_keys - boundary_keys)}。",
              "対応キーは(session_id,turn_id)。異なるsessionで同じturn IDがあっても自動統合しない。正式なTask/Run IDとの対応や意味的な再開の同一性は未確認。", ""]
    for session_id, turn_id in sorted(boundary_keys & usage_turn_keys)[:3]:
        boundary_ref = conn.execute("""SELECT s.path,l.line_no,l.byte_offset FROM events e
            JOIN event_locations l ON l.event_key=e.event_key
            JOIN source_files s ON s.id=l.source_id
            WHERE e.session_id=? AND e.turn_id=? AND
            ((e.outer_type='response_item' AND e.inner_type='message' AND e.role='user') OR
             (e.outer_type='event_msg' AND e.inner_type IN ('user_message','task_started')))
            ORDER BY s.path,l.line_no LIMIT 1""", (session_id, turn_id)).fetchone()
        usage_evidence = per_turn_refs[(session_id, turn_id)]
        usage_ref = event_ref(usage_evidence["event_key"])
        if boundary_ref and usage_ref:
            previous_ref = event_ref(usage_evidence["previous_event_key"]) if usage_evidence["previous_event_key"] else None
            previous = f"、直前通知 `{previous_ref[0]}:{previous_ref[1]}` byte {previous_ref[2]}" if previous_ref else ""
            lines.append(f"- session `{session_id}` turn `{turn_id}`: 境界 `{boundary_ref[0]}:{boundary_ref[1]}` byte {boundary_ref[2]}、usage代表 `{usage_ref[0]}:{usage_ref[1]}` byte {usage_ref[2]}（{usage_evidence['scope']}、加算通知 {usage_evidence['observations']} 件{previous}）")
    lines += ["", "## 成果の裏づけ", "",
              f"turn終了通知（task_complete）: {completed[0]}件。これは成果の受入や実装品質の証明ではない。",
              "テスト合否: 未取得。CommandExecutionの終了コードだけではテスト結果と分類しない。",
              "Git差分・CI結果: 未照合。ユーザーの明示評価・受入: 未取得。無返信や次の指示を受入とみなさない。"]
    lines += ["",
              "## usage（観測値のみ）", "",
              f"response増分を使ったsession: {coverage['response_incremental_sessions']}、累計通知を差分化したsession: {coverage['cumulative_fallback_sessions']}。親付きsessionの初回累計を継承基準値として除外: {coverage['parent_baseline_excluded_sessions']} session。累計リセット検出: {resets} フィールド。",
              "親付きsessionの初回累計と、後から初めて現れる未観測フィールドは親からの継承分を含み得るため加算しない。子自身の初回利用量もこの基準値に含まれる場合は未取得となる。",
              "同一sessionに両形式がある場合はresponse増分を採用し、累計通知を加算しない。欠けたresponseを累計値で補う処理は未実装。",
              "以下は継承基準値を除いた対象session別観測値の単純和（診断用）。親子間の包括・排他scopeは未確認であり、実際の全体使用量や請求総量とは扱わない。",
              "cached_input_tokensはinput_tokensの内訳、reasoning_output_tokensはoutput_tokensの内訳として表示し、総量へ加算しない。", ""]
    for field in TOKEN_FIELDS:
        value = totals[field]
        lines.append(f"- {field}: {value if value is not None else '未取得'}（取得session {coverage[field + '_sessions']}/{sessions}）")
    lines += ["- API実請求額: 未取得。API単価による参考試算: 未実施。サブスクリプション枠: 未取得。", "",
              "usage上位turn（観測されたinput+output。内訳を再加算しない。根拠は実際に加算した通知の代表1件）:", ""]
    ranked = sorted(per_turn.items(), key=lambda pair: (pair[1]["input_tokens"] or 0) + (pair[1]["output_tokens"] or 0), reverse=True)[:10]
    for (session_id, turn_id), values in ranked:
        usage_evidence = per_turn_refs[(session_id, turn_id)]
        loc = event_ref(usage_evidence["event_key"])
        evidence = f"`{loc[0]}:{loc[1]}` byte {loc[2]} / {usage_evidence['scope']} / 加算通知 {usage_evidence['observations']} 件" if loc else "参照不明"
        lines.append(f"- session `{session_id}` turn `{turn_id}`: input {values['input_tokens'] if values['input_tokens'] is not None else '未取得'} / output {values['output_tokens'] if values['output_tokens'] is not None else '未取得'} — {evidence}")
    if not ranked:
        lines.append("- 未観測")
    lines += ["", "## 解釈と未確認", "",
              "turnは観測されたユーザー入力・task_started・turn_contextを境界候補とする。セッションを単一タスクと断定しない。",
              "task_completeはturn終了通知であり、成果の受入・Git/CI確認・ユーザー評価ではない。テスト合否や明示評価は本文を保存せず、この段階では未確認。",
              "モデル/effortはturn_context時点の観測値。usageへの対応は近傍のturn_contextによる時系列対応で、provider側のresponse単位の確定値ではない。",
              "親子session間のusage包含関係は未確認。再開・compactionはイベントとして保持し、同一作業への意味的な統合は未実施。",
              "このレポートは出力DBに累積保存されたファイルに限る。今回のコマンドで指定したファイルだけの集計ではない。既存ログ全体の性能差、浪費、節約率を推定しない。", ""]
    return "\n".join(lines)


def saved_source_status(out_dir: Path) -> tuple[dict, bool]:
    """Compare recorded file metadata without opening logs or modifying the DB."""
    database = out_dir / "historical-codex.sqlite3"
    if (not out_dir.is_dir() or out_dir.is_symlink() or not database.is_file()
            or database.is_symlink()):
        raise ValueError("既存のCodex履歴診断DBを指定してください")
    with closing(sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True)) as conn:
        tables = {row[0] for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'")}
        if not {"source_files", "skipped_sources"}.issubset(tables):
            raise ValueError("既存のSQLiteファイルはCodex履歴診断DBではありません")
        sources = conn.execute(
            "SELECT path,bytes,mtime_ns FROM source_files ORDER BY path").fetchall()
        pending = conn.execute(
            "SELECT path,reason FROM skipped_sources ORDER BY path").fetchall()
    counts = Counter()
    examples = []
    for name, saved_bytes, saved_mtime_ns in sources:
        path = Path(name)
        if path.is_symlink():
            state = "symlink"
        else:
            try:
                current = path.stat()
            except OSError:
                state = "missing_or_unreadable"
            else:
                if not path.is_file():
                    state = "missing_or_unreadable"
                elif (current.st_size, current.st_mtime_ns) == (saved_bytes, saved_mtime_ns):
                    state = "metadata_matches"
                else:
                    state = "metadata_changed"
        counts[state] += 1
        if state != "metadata_matches" and len(examples) < 10:
            examples.append({"path": name, "state": state,
                             "saved_bytes": saved_bytes})
    result = {
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "saved_sources": len(sources),
        "metadata_matches": counts["metadata_matches"],
        "metadata_changed": counts["metadata_changed"],
        "missing_or_unreadable": counts["missing_or_unreadable"],
        "symlink": counts["symlink"],
        "pending_sources": [{"path": name, "reason": reason} for name, reason in pending],
        "changed_examples": examples,
        "limit": "サイズ・更新時刻だけの照合。内容SHA-256や新規ログの探索は行わない。",
    }
    stale = len(pending) > 0 or any(counts[state] for state in (
        "metadata_changed", "missing_or_unreadable", "symlink"))
    return result, stale


def write_report_atomic(out_dir: Path, markdown: str) -> Path:
    """Keep the previous diagnosis intact if writing or replacement fails."""
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", newline="\n",
                                         prefix=".report-", suffix=".tmp", dir=out_dir,
                                         delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(markdown)
            stream.flush()
            os.fsync(stream.fileno())
        report_path = out_dir / "report.md"
        os.replace(temporary, report_path)
        return report_path
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def report_from_saved_database(out_dir: Path) -> Path:
    """Regenerate only our report from the saved DB; never open source logs."""
    database = out_dir / "historical-codex.sqlite3"
    report_path = out_dir / "report.md"
    if (not out_dir.is_dir() or out_dir.is_symlink() or not database.is_file()
            or database.is_symlink() or report_path.is_symlink()):
        raise ValueError("既存のCodex履歴診断DBと安全なレポート出力先を指定してください")
    if report_path.exists():
        with report_path.open("rb") as stream:
            if not stream.read(64).startswith("# Codex履歴ローカル診断（Phase 1）".encode("utf-8")):
                raise ValueError("既存のreport.mdはCodex履歴診断ではありません")
    with closing(sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True)) as conn:
        tables = {row[0] for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'")}
        if not {"source_files", "events", "event_locations", "issues",
                "usage_observations", "skipped_sources"}.issubset(tables):
            raise ValueError("既存のSQLiteファイルはCodex履歴診断DBではありません")
        markdown = report(conn)
    return write_report_atomic(out_dir, markdown)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Offline Codex rollout JSONL importer")
    parser.add_argument("--source", action="append", help="明示したrollout JSONLファイルまたはそのディレクトリ")
    parser.add_argument("--out", required=True, help="専用出力ディレクトリ（入力の外）")
    parser.add_argument("--status-only", action="store_true",
                        help="保存済み元ログのサイズと更新時刻だけを照合（DBとレポートは変更しない）")
    parser.add_argument("--report-from-db", action="store_true",
                        help="元ログを読まず保存DBから診断レポートだけを再生成")
    args = parser.parse_args(argv)
    try:
        raw_out = Path(args.out).expanduser()
        if raw_out.is_symlink():
            raise ValueError("--out にシンボリックリンクを指定できません")
        out_dir = raw_out.resolve()
        if args.status_only and args.report_from_db:
            raise ValueError("--status-only と --report-from-db は同時指定できません")
        if args.status_only:
            if args.source:
                raise ValueError("--status-only と --source は同時指定できません")
            status, stale = saved_source_status(out_dir)
            # ASCII JSON survives Windows PowerShell's native-command pipe encoding.
            print(json.dumps(status, indent=2))
            return 2 if stale else 0
        if args.report_from_db:
            if args.source:
                raise ValueError("--report-from-db と --source は同時指定できません")
            path = report_from_saved_database(out_dir)
            print(f"保存DBから診断を再生成: {path}。元ログは読み取っていません。")
            return 0
        paths = source_files(args.source, out_dir)
        with closing(connect(out_dir)) as conn:
            results = Counter()
            changed_sources = []
            for index, path in enumerate(paths, 1):
                try:
                    results[import_file(conn, path)] += 1
                except SourceChangedDuringRead:
                    changed_sources.append(path)
                    conn.execute("""INSERT INTO skipped_sources VALUES (?,?,?)
                        ON CONFLICT(path) DO UPDATE SET reason=excluded.reason,observed_at=excluded.observed_at""",
                        (str(path), "changed_during_read", datetime.now(timezone.utc).isoformat()))
                    conn.commit()
                else:
                    conn.execute("DELETE FROM skipped_sources WHERE path=?", (str(path),))
                    conn.commit()
                if index % 10 == 0 or index == len(paths):
                    print(f"読取進捗 {index}/{len(paths)}、全読込 {results['imported']}、追記 {results['appended']}、変化中 {len(changed_sources)}", flush=True)
            # A live rollout can grow just after import_file commits. Keep its
            # saved snapshot, but show that it is already stale at this check.
            for path in paths:
                if path in changed_sources:
                    continue
                saved = conn.execute("SELECT bytes,mtime_ns FROM source_files WHERE path=?",
                                     (str(path),)).fetchone()
                try:
                    current = path.stat()
                except OSError:
                    current = None
                if saved and (current is None or
                              (saved[0], saved[1]) != (current.st_size, current.st_mtime_ns)):
                    changed_sources.append(path)
                    conn.execute("""INSERT INTO skipped_sources VALUES (?,?,?)
                        ON CONFLICT(path) DO UPDATE SET reason=excluded.reason,observed_at=excluded.observed_at""",
                        (str(path), "changed_after_import", datetime.now(timezone.utc).isoformat()))
                    conn.commit()
            markdown = report(conn)
            stored_sources = conn.execute("SELECT count(*) FROM source_files").fetchone()[0]
        report_path = write_report_atomic(out_dir, markdown)
    except (ValueError, OSError, sqlite3.Error, RuntimeError) as error:
        print(f"取り込み失敗: {error}", file=sys.stderr)
        return 1
    print(f"今回対象 {len(paths)} / DB累積 {stored_sources} / 全読込 {results['imported']} / 追記 {results['appended']} / 未変更 {results['unchanged']} / 変化中 {len(changed_sources)} / 診断 {report_path}")
    for path in changed_sources:
        print(f"再試行が必要な変化中のログ: {path}", file=sys.stderr)
    return 2 if changed_sources else 0


if __name__ == "__main__":
    raise SystemExit(main())
