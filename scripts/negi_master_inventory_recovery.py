"""Explicit, authenticated SQLite-owned rollback of an inventory hot journal.

Preview rolls back a disposable clone only. Original DB replacement and manual
journal deletion are forbidden. Signed intents/completions survive lost replies.
"""
from contextlib import ExitStack, contextmanager
import hashlib
import os
from pathlib import Path
import shutil
import sqlite3
import struct
import tempfile

import negi_master_conversation_inventory as m

MAGIC = bytes.fromhex("d9d505f920a163d7")
MAX_DECISIONS = 10000
MAX_RECORD_BYTES = 16000


def journal_limit():
    # A page appears at most once; allow a padded header/alignment around every
    # record, at the smallest page and largest supported sector. Stream only.
    return m.MAX_DATABASE_BYTES + (m.MAX_DATABASE_BYTES // 512) * (8 + 2 * 65536) + 65536


def snapshot(path, destination=None, limit=None, journal=False):
    """Stream bounded bytes through a protected native reader, without a cache."""
    limit = m.MAX_DATABASE_BYTES if limit is None else limit
    before = m.normal(path)
    m.require(before.st_size <= limit, "recovery file capacity")
    handle = None
    if os.name == "nt":
        import ctypes
        import msvcrt
        from negi_recover_writer import windows_extended, win_info
        kernel = m.native_kernel()
        handle = kernel.CreateFileW(windows_extended(path), 0x80000000, 1, None, 3, 0x00200000, None)
        m.require(handle != ctypes.c_void_p(-1).value, "recovery source reader unavailable; preserve external writer")
        try:
            stamp = list(m.native_stamp(win_info(kernel, handle, limit=limit)))
            fd = msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY)
        except BaseException:
            kernel.CloseHandle(handle)
            raise
        stream = os.fdopen(fd, "rb")  # Closing the CRT descriptor closes its native handle.
    else:
        stream = path.open("rb");stamp = m.fingerprint(os.fstat(stream.fileno()))
    digest, size = hashlib.sha256(), 0
    try:
        if journal:
            hot_journal_stream(stream, before.st_size)
            stream.seek(0)
        output = destination.open("xb") if destination is not None else None
        try:
            while chunk := stream.read(1024 * 1024):
                size += len(chunk);m.require(size <= limit, "recovery source grew")
                digest.update(chunk)
                if output is not None:output.write(chunk)
            if output is not None:output.flush();os.fsync(output.fileno())
            if os.name == "nt":
                m.require(stamp == list(m.native_stamp(win_info(kernel, handle, limit=limit))), "recovery source changed")
            else:m.require(stamp == m.fingerprint(os.fstat(stream.fileno())), "recovery source changed")
            m.require(size == before.st_size and m.fingerprint(before) == m.fingerprint(m.normal(path)), "recovery source path changed")
        finally:
            if output is not None:output.close()
    finally:stream.close()
    return {"sha256": digest.hexdigest(), "size": size, "identity": m.identity(before), "stamp": stamp}


def hot_journal(path):
    # Only standalone rollback-mode journals. Never let a clone follow an
    # embedded super-journal path to another database or external directory.
    with path.open("rb") as stream:
        hot_journal_stream(stream, m.normal(path).st_size)


def hot_journal_stream(stream, size):
    m.require(size > 512, "non-hot or partial rollback journal; preserve it")
    header = stream.read(28);stream.seek(-8, os.SEEK_END);tail = stream.read(8)
    m.require(len(header) == 28 and header[:8] == MAGIC and tail != MAGIC, "only standalone hot rollback journals are supported")
    _, _, pages, sector, page_size = struct.unpack(">IIIII", header[8:28])
    m.require(pages > 0 and 512 <= sector <= 65536 and sector & (sector - 1) == 0
              and 512 <= page_size <= 65536 and page_size & (page_size - 1) == 0
              and pages * page_size <= m.MAX_DATABASE_BYTES
              and size <= pages * (page_size + 8 + 2 * sector) + sector, "hot journal header/capacity")


def sqlite_rollback(path):
    # The first schema read invokes SQLite's hot-journal recovery, including its
    # own locking/sync/deletion sequence. Do not BEGIN a replacement transaction.
    conn = sqlite3.connect(path.as_uri() + "?mode=rw", uri=True, timeout=0.1, isolation_level=None)
    try:
        conn.execute("PRAGMA trusted_schema=OFF")
        conn.execute("PRAGMA synchronous=FULL")
        conn.execute("SELECT COUNT(*) FROM sqlite_master").fetchone()
    finally:conn.close()
    m.no_sidecars(path)


class DatabaseRecovery:
    def __init__(self, inventory):
        self.inventory = inventory;self.root = inventory.root;self.db = inventory.db
        self.journal = Path(str(self.db) + "-journal")
        self.records_path = Path(str(self.db) + ".recoveries")
        self.pending_path = Path(str(self.records_path) + ".pending")

    def envelope(self, payload):
        raw = m.encoded(payload)
        return m.encoded({"payload": payload, "signature": m.signature(self.inventory.key, payload["schema"], raw)}) + b"\n"

    @contextmanager
    def database_guard(self):
        before = m.normal(self.db)
        handle = None
        if os.name == "nt":
            import ctypes
            from negi_recover_writer import windows_extended, win_info
            kernel = m.native_kernel()
            # Permit SQLite's own read/write opens while preventing replacement
            # or deletion of the authenticated original DB pathname.
            handle = kernel.CreateFileW(windows_extended(self.db), 0x80, 3, None, 3, 0x00200000, None)
            m.require(handle != ctypes.c_void_p(-1).value, "recovery database identity handle unavailable")
            try:win_info(kernel, handle, limit=m.MAX_DATABASE_BYTES)
            except BaseException:kernel.CloseHandle(handle);raise
        try:
            yield
            m.require(m.identity(m.normal(self.db)) == m.identity(before), "recovery database replaced; preserve decision")
        finally:
            if handle is not None:kernel.CloseHandle(handle)

    def record(self, decision, kind, meta):
        path = self.records_path / (decision + "." + kind + ".json")
        if m.absent(path):return None
        raw = m.read_file(path, MAX_RECORD_BYTES);value = m.canonical(raw, MAX_RECORD_BYTES)
        m.require(set(value) == {"payload", "signature"} and type(value["payload"]) is dict and m.valid_sha(value["signature"]), "recovery record envelope")
        payload = value["payload"];schema = "negi-master-inventory-recovery-" + kind + "/1"
        common = {"schema", "authoritySha256", "decisionId", "preview"}
        fields = common | ({"source", "fsProofSha256"} if kind == "intent" else {"intentSha256"})
        m.require(set(payload) == fields and payload["schema"] == schema and payload["authoritySha256"] == m.sha(m.encoded(meta))
                  and payload["decisionId"] == decision and m.hmac.compare_digest(value["signature"], m.signature(self.inventory.key, schema, m.encoded(payload))), "recovery record authentication/identity")
        self.validate_preview(payload["preview"])
        if kind == "intent":
            m.require(m.valid_sha(payload["fsProofSha256"]) and type(payload["source"]) is dict and set(payload["source"]) == {"database", "journal"}, "recovery intent source")
            for kind, source in payload["source"].items():
                m.require(type(source) is dict and set(source) == {"sha256", "size", "identity", "stamp"} and m.valid_sha(source["sha256"])
                          and type(source["size"]) is int and 0 < source["size"] <= (journal_limit() if kind == "journal" else m.MAX_DATABASE_BYTES)
                          and type(source["identity"]) is list and len(source["identity"]) == 2 and all(type(v) is str and v.isdigit() for v in source["identity"])
                          and type(source["stamp"]) is list and 6 <= len(source["stamp"]) <= 11, "recovery source shape")
            m.require(payload["preview"]["databaseSha256"] == payload["source"]["database"]["sha256"]
                      and payload["preview"]["journalSha256"] == payload["source"]["journal"]["sha256"], "recovery source hash binding")
        else:m.require(m.valid_sha(payload["intentSha256"]), "recovery completion intent hash")
        return raw, payload

    def validate_preview(self, value):
        m.require(type(value) is dict and set(value) == {"proofSha256", "databaseSha256", "journalSha256", "recoveredSha256", "masterCount", "artifactCount", "missingCount"}
                  and all(m.valid_sha(value[k]) for k in ("proofSha256", "databaseSha256", "journalSha256", "recoveredSha256"))
                  and type(value["masterCount"]) is int and 0 < value["masterCount"] <= m.MAX_MASTERS
                  and type(value["artifactCount"]) is int and 0 <= value["artifactCount"] <= m.MAX_TOTAL_EVENTS
                  and type(value["missingCount"]) is int and 0 <= value["missingCount"] <= value["artifactCount"], "recovery preview shape")

    def records(self, meta):
        m.require(m.absent(self.pending_path), "pending recovery namespace needs inspection; preserve it")
        if m.absent(self.records_path):return {}
        directory = m.identity(m.normal(self.records_path, True));names = m.catalog(self.records_path, 2 * MAX_DECISIONS)
        decisions = {}
        for name in names:
            parts = name.split(".")
            m.require(len(parts) == 3 and m.valid_uuid(parts[0]) and parts[1] in ("intent", "done") and parts[2] == "json", "unknown recovery ledger entry; preserve it")
            decisions.setdefault(parts[0], {})[parts[1]] = self.record(parts[0], parts[1], meta)
        for rows in decisions.values():
            m.require(rows.get("intent") is not None, "completion has no recovery intent")
            if "done" in rows:
                m.require(rows["done"][1]["intentSha256"] == m.sha(rows["intent"][0]) and rows["done"][1]["preview"] == rows["intent"][1]["preview"], "recovery completion differs from intent")
        m.require(len(decisions) <= MAX_DECISIONS and directory == m.identity(m.normal(self.records_path, True))
                  and names == m.catalog(self.records_path, 2 * MAX_DECISIONS), "recovery ledger changed/capacity")
        return decisions

    def assert_idle(self, meta):
        m.require(all("done" in rows for rows in self.records(meta).values()), "unfinished SQLite recovery requires its exact decision")

    def publish(self, decision, kind, payload):
        # Establish the first ledger with its flushed intent inside a staged
        # sibling directory. Both file and directory moves are create-only,
        # same-volume WRITE_THROUGH publications, before touching the original DB.
        m.require(os.name == "nt", "durable recovery publication requires Windows")
        import ctypes
        from ctypes import wintypes
        from negi_recover_writer import windows_parent, windows_extended, win_bytes
        m.require(m.absent(self.pending_path), "pending recovery namespace needs inspection; preserve it")
        first = m.absent(self.records_path)
        directory = self.pending_path if first else self.records_path
        raw = self.envelope(payload)
        m.require(len(raw) <= MAX_RECORD_BYTES, "recovery decision capacity")
        with windows_parent(self.root.parent) as (kernel, _):
            if first:
                m.require(kind == "intent", "first recovery record must be an intent")
                directory.mkdir(mode=0o700)
            with windows_parent(directory):
                final = directory / (decision + "." + kind + ".json")
                pending = directory / (".pending-" + decision + "." + kind + ".json")
                m.require(m.absent(final) and m.absent(pending), "existing recovery record must be preserved")
                handle = kernel.CreateFileW(windows_extended(pending), 0xc0000000, 0, None, 1, 0x80200000, None)
                m.require(handle != ctypes.c_void_p(-1).value, "recovery record create unavailable")
                try:
                    buffer = ctypes.create_string_buffer(raw);count = wintypes.DWORD()
                    m.require(kernel.WriteFile(handle, buffer, len(raw), ctypes.byref(count), None) and count.value == len(raw), "recovery record write incomplete")
                    m.require(kernel.FlushFileBuffers(handle), "recovery record flush failed")
                    m.require(win_bytes(kernel, handle, MAX_RECORD_BYTES) == raw, "staged recovery record changed")
                finally:kernel.CloseHandle(handle)
                self.move(kernel, pending, final)
                m.require(m.read_file(final, MAX_RECORD_BYTES) == raw, "recovery decision changed after publication")
            if first:self.move(kernel, directory, self.records_path)
            m.require(m.read_file(self.records_path / final.name, MAX_RECORD_BYTES) == raw, "recovery namespace publication changed")

    def move(self, kernel, source, destination):
        from negi_recover_writer import windows_extended
        # Never REPLACE_EXISTING, COPY_ALLOWED, truncate, or clean up uncertain work.
        m.require(kernel.MoveFileExW(windows_extended(source), windows_extended(destination), 0x8), "recovery namespace move failed; preserve staged record")

    @contextmanager
    def access(self, path):
        i = self.inventory;old = i.db, i.recovery_access
        i.db, i.recovery_access = path, True
        try:yield
        finally:i.db, i.recovery_access = old

    def audit_all(self, path):
        i = self.inventory;selected = i.master_id, i.master
        names = m.catalog(i.masters);rows, artifacts, missing = [], 0, 0
        m.require(i.master_id in names, "recovery selected Master missing")
        try:
            with self.access(path), i.connection() as (conn, meta):
                i.validated(conn, meta)
                checkpoints = conn.execute("SELECT master_id,body,seq,last_sha FROM masters ORDER BY master_id").fetchall()
                adoption = i.adoption
                expected = {}
                for name, body, seq, last in checkpoints:
                    i.master_id, i.master = name, i.masters / name
                    paths, _ = i.events(conn, (body, seq, last))
                    expected[name] = paths
                conn.execute("COMMIT")
                scans = {}
                for name in names:
                    i.master_id, i.master = name, i.masters / name
                    scans[name] = i.scan(expected[name])
                for name, body, seq, last in checkpoints:
                    i.master_id, i.master = name, i.masters / name
                    paths, scan = expected[name], scans[name]
                    m.require(scan == i.scan(paths), "recovery filesystem changed")
                    rows.append({"masterId": name, "bodySha256": m.sha(body), "seq": seq, "sha256": last, "paths": paths, "filesystem": scan})
                    artifacts += len(paths);missing += len(scan[2])
                conn.execute("BEGIN")
                i.master_id, i.master = selected
                i.validated(conn, meta, integrity=False)
                m.require(checkpoints == conn.execute("SELECT master_id,body,seq,last_sha FROM masters ORDER BY master_id").fetchall()
                          and adoption == i.adoption, "recovery global checkpoint/adoption changed")
        finally:i.master_id, i.master = selected
        m.require(names == m.catalog(i.masters), "recovery Masters changed")
        return {"masterCount": len(names), "artifactCount": artifacts, "missingCount": missing}, m.sha(m.encoded(rows))

    def source(self, destination=None):
        for suffix in ("-wal", "-shm"):m.require(m.absent(Path(str(self.db) + suffix)), "WAL/SHM recovery is unsupported")
        self.inventory.absent_owners()
        database = snapshot(self.db, destination)
        journal = snapshot(self.journal, Path(str(destination) + "-journal") if destination is not None else None, limit=journal_limit(), journal=True)
        m.require(journal["size"] > 512, "non-hot or partial rollback journal; preserve it")
        return {"database": database, "journal": journal}

    def candidate(self, meta):
        needed = m.normal(self.db).st_size + m.normal(self.journal).st_size + 1024 * 1024
        m.require(shutil.disk_usage(self.root.parent).free >= needed, "insufficient space for disposable recovery clone; preserve source")
        with tempfile.TemporaryDirectory(prefix=".negi-inventory-recovery-", dir=self.root.parent) as temporary:
            clone = Path(temporary) / "inventory.sqlite3"
            source = self.source(clone);hot_journal(Path(str(clone) + "-journal"))
            sqlite_rollback(clone)
            summary, fs_proof = self.audit_all(clone)
            recovered = snapshot(clone)["sha256"]
            m.require(source == self.source() and meta == self.inventory.authority(), "recovery source changed during clone audit")
            preview = {"databaseSha256": source["database"]["sha256"], "journalSha256": source["journal"]["sha256"], "recoveredSha256": recovered, **summary}
            proof = m.sha(m.encoded({"schema": "negi-master-inventory-recovery-preview/1", "authority": meta, "source": source, "fsProofSha256": fs_proof, "preview": preview}))
            preview = {"proofSha256": proof, **preview}
            return {"source": source, "fsProofSha256": fs_proof, "preview": preview}

    def result(self, action, preview, decision=None):
        result = {"schema": "negi-master-inventory-result/1", "action": action, "masterId": self.inventory.master_id, **preview}
        if decision is not None:result.update(decisionId=decision, recovered=True)
        return result

    @m.storage_action
    def preview(self):
        i = self.inventory
        with i.authority_guard() as meta, self.database_guard():
            self.assert_idle(meta)
            first = self.candidate(meta)
            m.require(first == self.candidate(meta), "recovery preview changed")
            return self.result("previewDatabaseRecovery", first["preview"])

    @m.storage_action
    def recover(self, request):
        m.require(set(request) == {"action", "root", "masterId", "decisionId", "expectedProofSha256"}
                  and m.valid_uuid(request["decisionId"]) and m.valid_sha(request["expectedProofSha256"]), "recovery decision/proof input")
        i = self.inventory;decision = request["decisionId"]
        with i.authority_guard() as meta, ExitStack() as pinned:
            # A completed decision is historical. Later owners/journals must not
            # authorize another rollback or invalidate this immutable query.
            if not m.absent(self.records_path):
                m.normal(self.records_path, True)
                done = self.record(decision, "done", meta)
                if done:
                    intent = self.record(decision, "intent", meta)
                    m.require(intent and done[1]["intentSha256"] == m.sha(intent[0]) and done[1]["preview"] == intent[1]["preview"]
                              and done[1]["preview"]["proofSha256"] == request["expectedProofSha256"], "completed recovery decision differs")
                    return self.result("recoverDatabase", done[1]["preview"], decision)
            pinned.enter_context(self.database_guard())
            records = self.records(meta)
            m.require(all("done" in rows or name == decision for name, rows in records.items()), "another SQLite recovery decision is pending")
            intent = records.get(decision, {}).get("intent")
            i.absent_owners()
            if intent:
                accepted = intent[1]
                m.require(accepted["preview"]["proofSha256"] == request["expectedProofSha256"], "different pending recovery proof")
            else:
                m.require(len(records) < MAX_DECISIONS, "recovery ledger capacity")
                candidate = self.candidate(meta)
                m.require(candidate["preview"]["proofSha256"] == request["expectedProofSha256"] and candidate == self.candidate(meta), "stale recovery preview")
                accepted = {"schema": "negi-master-inventory-recovery-intent/1", "authoritySha256": m.sha(m.encoded(meta)), "decisionId": decision, **candidate}
                self.publish(decision, "intent", accepted);intent = self.record(decision, "intent", meta)
            if not m.absent(self.journal):
                candidate = self.candidate(meta)
                # A interrupted SQLite rollback can already have restored some
                # DB pages. Only the same intent may resume that intermediate
                # pair, and its clone must reach the identical accepted target.
                m.require(candidate["source"]["database"]["identity"] == accepted["source"]["database"]["identity"]
                          and candidate["source"]["journal"] == accepted["source"]["journal"]
                          and candidate["preview"]["recoveredSha256"] == accepted["preview"]["recoveredSha256"]
                          and candidate["fsProofSha256"] == accepted["fsProofSha256"]
                          and candidate["source"] == self.source(), "pending recovery no longer reaches its accepted target")
                i.absent_owners()
                sqlite_rollback(self.db)
            m.no_sidecars(self.db);current = snapshot(self.db)
            m.require(current["identity"] == accepted["source"]["database"]["identity"]
                      and current["sha256"] == accepted["preview"]["recoveredSha256"], "recovery outcome differs; preserve decision for inspection")
            summary, fs_proof = self.audit_all(self.db);i.absent_owners()
            m.require(fs_proof == accepted["fsProofSha256"] and all(summary[k] == accepted["preview"][k] for k in summary)
                      and current == snapshot(self.db) and meta == i.authority(), "recovered authority/filesystem changed")
            completion = {"schema": "negi-master-inventory-recovery-done/1", "authoritySha256": accepted["authoritySha256"], "decisionId": decision,
                          "intentSha256": m.sha(intent[0]), "preview": accepted["preview"]}
            self.publish(decision, "done", completion)
            return self.result("recoverDatabase", accepted["preview"], decision)
