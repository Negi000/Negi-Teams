"""Candidate inventory for Master conversation stages, independent of editable journals.

No provider calls, owner removal, receipt publication, migration or automatic repair.
The database detects missing/rolled-back journal files while the independent database
and signing authority survive. It is not an external monotonic anchor or a sandbox.
One bounded stdin JSON request; keys and artifact bytes never appear in argv/env.
"""
from contextlib import ExitStack, contextmanager
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import sys
from datetime import datetime
from functools import lru_cache

VERSION = 1
APPLICATION_ID = 0x4E544331
MAX_EVENTS = 50000  # Five stages for each of the existing 10,000 candidate operations.
MAX_TOTAL_EVENTS = 50000  # Whole DB budget, separately enforced across registered Masters.
MAX_MASTERS = 10000
MAX_ARTIFACT = 24000
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
SHA = re.compile(r"[0-9a-f]{64}")
MASTER = re.compile(r"[a-zA-Z0-9_-]{1,100}")
SCHEMA = [
    "CREATE TABLE meta (id INTEGER PRIMARY KEY CHECK(id=1), body BLOB NOT NULL, signature TEXT NOT NULL)",
    "CREATE TABLE masters (master_id TEXT PRIMARY KEY, body BLOB NOT NULL, seq INTEGER NOT NULL, last_sha TEXT NOT NULL, signature TEXT NOT NULL) WITHOUT ROWID",
    "CREATE TABLE events (master_id TEXT NOT NULL REFERENCES masters(master_id), seq INTEGER NOT NULL, path TEXT NOT NULL, body BLOB NOT NULL, artifact BLOB NOT NULL, entry_sha TEXT NOT NULL, signature TEXT NOT NULL, PRIMARY KEY(master_id,seq), UNIQUE(master_id,path)) WITHOUT ROWID",
]


def require(condition, reason):
    if not condition:raise ValueError("Master inventory: " + reason)


def unique(pairs):
    value = {}
    for key, item in pairs:
        require(key not in value, "duplicate JSON field")
        value[key] = item
    return value


def encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")


def canonical(raw, limit):
    require(type(raw) is bytes and 0 < len(raw) <= limit, "artifact size/type")
    value = json.loads(raw, object_pairs_hook=unique)
    require(type(value) is dict and encoded(value) + b"\n" == raw, "noncanonical JSON")
    return value


def sha(raw):return hashlib.sha256(raw).hexdigest()


def signature(key, domain, raw):return hmac.new(key, domain.encode("ascii") + b"\0" + raw, hashlib.sha256).hexdigest()


def valid_sha(value):return type(value) is str and SHA.fullmatch(value) is not None


def valid_uuid(value):return type(value) is str and UUID.fullmatch(value) is not None


def text_length(value):return len(value.encode("utf-16-le")) // 2


def label(value):return type(value) is str and 0 < text_length(value) <= 200 and not any(char in value for char in "\r\n\0")


def date(value):
    require(type(value) is str and re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z", value), "timestamp")
    datetime.fromisoformat(value.replace("Z", "+00:00"))


def identity(info):return [str(info.st_dev), str(info.st_ino)]


def fingerprint(info):
    return [*identity(info), str(info.st_size), str(info.st_mtime_ns), str(info.st_ctime_ns), str(info.st_nlink)]


@lru_cache(maxsize=1)
def native_kernel():
    from negi_recover_writer import windows_kernel
    return windows_kernel()


def normal(path, directory=False):
    info = path.lstat()
    require((stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode))
            and not stat.S_ISLNK(info.st_mode) and not getattr(info, "st_file_attributes", 0) & 0x400,
            "unsafe file/directory")
    if not directory:require(info.st_nlink == 1, "hardlinked file")
    # Parent directories are canonical and held/checked separately. A fixed leaf
    # cannot be a symlink/reparse/hardlink, so re-resolving every file adds no proof.
    if directory:require(os.path.normcase(str(path.resolve(strict=True))) == os.path.normcase(str(path)), "path alias")
    return info


def read_file(path, limit):
    before = normal(path)
    require(before.st_size <= limit, "oversized file")
    if os.name == "nt":
        # Python's Windows lstat/fstat can expose different ctime semantics.
        # Compare handles from the same native API, including file ID and bytes.
        from negi_recover_writer import win_open_reader, win_info, win_bytes
        import ctypes
        kernel = native_kernel()
        def stamp(info):
            return [info.volume, info.index_high, info.index_low, info.size_high, info.size_low, info.links,
                    info.created.dwHighDateTime, info.created.dwLowDateTime, info.written.dwHighDateTime, info.written.dwLowDateTime]
        handle = win_open_reader(kernel, path)
        require(handle != ctypes.c_void_p(-1).value, "file handle unavailable")
        try:
            pinned = stamp(win_info(kernel, handle, limit=limit))
            raw = win_bytes(kernel, handle, limit)
            require(pinned == stamp(win_info(kernel, handle, limit=limit)), "file changed during read")
            current = win_open_reader(kernel, path)
            require(current != ctypes.c_void_p(-1).value, "file path changed during read")
            try:
                require(pinned == stamp(win_info(kernel, current, limit=limit))
                        == stamp(win_info(kernel, handle, limit=limit)), "file replaced during read")
            finally:kernel.CloseHandle(current)
            normal(path)
            return raw
        finally:kernel.CloseHandle(handle)
    with path.open("rb") as stream:
        pinned = os.fstat(stream.fileno())
        require(fingerprint(before) == fingerprint(pinned), "file changed before read")
        raw = stream.read(limit + 1)
        require(len(raw) == before.st_size and fingerprint(pinned) == fingerprint(os.fstat(stream.fileno()))
                == fingerprint(normal(path)), "file changed during read")
    return raw


def absent(path):return not os.path.lexists(path)


def catalog(path, limit=MAX_MASTERS):
    normal(path, True)
    return names(path, limit)


def names(path, limit=MAX_MASTERS):
    names = sorted(os.listdir(path))
    require(len(names) <= limit, "directory inventory limit")
    return names


def no_sidecars(db):
    for suffix in ("-journal", "-wal", "-shm"):
        require(absent(Path(str(db) + suffix)), "journal/WAL/SHM requires explicit reconciliation")


def schema_objects(conn):
    return conn.execute("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").fetchall()


def expected_schema():
    with sqlite3.connect(":memory:") as conn:
        for sql in SCHEMA:conn.execute(sql)
        return schema_objects(conn)


def validate_schema(conn, integrity=True):
    require(conn.execute("PRAGMA application_id").fetchone()[0] == APPLICATION_ID
            and conn.execute("PRAGMA user_version").fetchone()[0] == VERSION, "database version/application")
    require(schema_objects(conn) == expected_schema(), "unexpected database schema")
    if integrity:
        require(conn.execute("PRAGMA quick_check").fetchall() == [("ok",)], "database integrity")
        require(conn.execute("PRAGMA foreign_key_check").fetchall() == [], "orphan inventory event")


def process_identity():
    pid = os.getppid()
    if os.name == "nt":
        from negi_recover_writer import wintypes
        import ctypes
        kernel = native_kernel()
        function = kernel.GetProcessTimes
        function.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.FILETIME), ctypes.POINTER(wintypes.FILETIME), ctypes.POINTER(wintypes.FILETIME), ctypes.POINTER(wintypes.FILETIME)]
        function.restype = wintypes.BOOL
        handle = kernel.OpenProcess(0x00100000 | 0x1000, False, pid)
        require(bool(handle), "parent process identity unavailable")
        try:
            require(kernel.WaitForSingleObject(handle, 0) == 258, "parent process is not live")
            times = [wintypes.FILETIME() for _ in range(4)]
            require(function(handle, *(ctypes.byref(value) for value in times)), "parent process creation time unavailable")
            created = times[0].dwHighDateTime << 32 | times[0].dwLowDateTime
            return {"platform": "windows", "pid": pid, "startToken": str(created)}
        finally:kernel.CloseHandle(handle)
    require(sys.platform == "linux", "process identity platform unsupported")
    # Boot ID plus kernel start ticks distinguish PID reuse and reboot; no wall-clock inference.
    raw = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8")
    ticks = raw[raw.rfind(")") + 2:].split()[19]
    boot = Path("/proc/sys/kernel/random/boot_id").read_text(encoding="ascii").strip()
    require(ticks.isdigit() and re.fullmatch(r"[0-9a-f-]{36}", boot), "parent process token unavailable")
    return {"platform": "linux", "pid": pid, "startToken": boot + ":" + ticks}


class Inventory:
    def __init__(self, root, master_id):
        require(type(root) is str and os.path.isabs(root), "absolute authority root required")
        require(type(master_id) is str and MASTER.fullmatch(master_id), "master registration")
        self.root = Path(os.path.abspath(root))
        self.db = Path(str(self.root) + ".inventory.sqlite3")
        self.master_id = master_id
        self.masters = self.root / "masters"
        self.master = self.masters / master_id
        self.key_path = self.root / "signing-key.json"

    def authority(self):
        normal(self.root.parent, True)
        root_info = normal(self.root, True)
        require(catalog(self.root) == ["masters", "signing-key.json"], "authority inventory")
        masters_info = normal(self.masters, True)
        key_raw = read_file(self.key_path, 1000)
        key_row = canonical(key_raw, 1000)
        require(set(key_row) == {"schemaVersion", "key"} and key_row["schemaVersion"] == "negi-master-conversation-key/1"
                and valid_sha(key_row["key"]), "signing key")
        self.key = bytes.fromhex(key_row["key"])
        return {"schema": "negi-master-inventory/1", "root": str(self.root), "rootIdentity": identity(root_info),
                "mastersIdentity": identity(masters_info), "keyIdentity": identity(normal(self.key_path)), "keySha256": sha(key_raw)}

    @contextmanager
    def guarded(self, initialize=False):
        # On Windows hold canonical parent handles without delete sharing. Other
        # platforms retain before/after detection; hostile same-UID races are not a claim.
        with ExitStack() as stack:
            if os.name == "nt":
                from negi_recover_writer import windows_parent
                for path in (self.root.parent, self.root, self.masters):stack.enter_context(windows_parent(path))
                for name in catalog(self.masters):
                    require(MASTER.fullmatch(name), "unexpected master directory")
                    stack.enter_context(windows_parent(self.masters / name))
            meta = self.authority()
            no_sidecars(self.db)
            if initialize:
                require(absent(self.db), "existing database must never be replaced")
                # Create-only bootstrap. A crash leaving a zero/partial database holds;
                # a second initialize does not replace it or regenerate an authority.
                fd = os.open(self.db, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                try:os.fsync(fd)
                finally:os.close(fd)
                if os.name != "nt":
                    parent_fd = os.open(self.root.parent, os.O_RDONLY | os.O_DIRECTORY)
                    try:os.fsync(parent_fd)
                    finally:os.close(parent_fd)
            pinned = normal(self.db)
            if os.name == "nt":
                from negi_recover_writer import windows_kernel, windows_extended, win_info
                import ctypes
                kernel = windows_kernel()
                handle = kernel.CreateFileW(windows_extended(self.db), 0x80000000, 3, None, 3, 0x00200000, None)
                require(handle != ctypes.c_void_p(-1).value, "database handle unavailable")
                stack.callback(kernel.CloseHandle, handle)
                win_info(kernel, handle, limit=1_500_000_000)
            require(pinned.st_size <= 1_500_000_000, "database size limit; migrate explicitly")
            yield meta
            require(identity(normal(self.db)) == identity(pinned) and self.authority() == meta, "authority/database identity changed")
            no_sidecars(self.db)

    @contextmanager
    def connection(self, writable=False, initialize=False):
        with self.guarded(initialize) as meta:
            # mode=ro deliberately refuses missing DBs and hot-journal repair.
            uri = self.db.as_uri() + ("?mode=rw" if writable else "?mode=ro")
            conn = sqlite3.connect(uri, uri=True, timeout=0.1, isolation_level=None)
            try:
                conn.execute("PRAGMA trusted_schema=OFF")
                conn.execute("PRAGMA foreign_keys=ON")
                if writable:
                    require(conn.execute("PRAGMA journal_mode=DELETE").fetchone()[0] == "delete", "DELETE journal unavailable")
                    conn.execute("PRAGMA synchronous=FULL")
                    conn.execute("BEGIN IMMEDIATE")
                else:conn.execute("BEGIN")
                yield conn, meta
                conn.execute("COMMIT")
            except BaseException:
                if conn.in_transaction:conn.execute("ROLLBACK")
                raise
            finally:conn.close()

    def signed_head(self, body, seq, last):
        raw = encoded({"masterSha256": sha(body), "seq": seq, "lastSha256": last})
        return signature(self.key, "negi-master-inventory-head/1", raw)

    def empty_master(self, master_id):
        path = self.masters / master_id
        require(MASTER.fullmatch(master_id) and catalog(path) == [], "initialization/registration requires empty master")
        return encoded({"masterId": master_id, "path": str(path), "identity": identity(normal(path, True))})

    def initialize(self):
        # Validate every master BEFORE creating the sibling DB; populated old records
        # need an explicit migration, never a silent adoption from current files.
        self.authority()
        names = catalog(self.masters)
        require(self.master_id in names, "master directory missing")
        bodies = {name: self.empty_master(name) for name in names}
        with self.connection(True, True) as (conn, meta):
            require({name: self.empty_master(name) for name in catalog(self.masters)} == bodies, "bootstrap inventory changed")
            conn.execute(f"PRAGMA application_id={APPLICATION_ID}")
            conn.execute(f"PRAGMA user_version={VERSION}")
            for sql in SCHEMA:conn.execute(sql)
            raw = encoded(meta)
            conn.execute("INSERT INTO meta VALUES (1,?,?)", (raw, signature(self.key, "negi-master-inventory-meta/1", raw)))
            for name, body in bodies.items():
                conn.execute("INSERT INTO masters VALUES (?,?,0,?,?)", (name, body, "0" * 64, self.signed_head(body, 0, "0" * 64)))
            return {"schema": "negi-master-inventory-result/1", "action": "initialize", "masterId": self.master_id}

    def validated(self, conn, meta, registering=False, integrity=True):
        validate_schema(conn, integrity)
        rows = conn.execute("SELECT id,body,signature FROM meta").fetchall()
        require(len(rows) == 1 and rows[0][0] == 1 and rows[0][1] == encoded(meta)
                and hmac.compare_digest(rows[0][2], signature(self.key, "negi-master-inventory-meta/1", rows[0][1])), "authority/key metadata mismatch")
        masters = conn.execute("SELECT master_id,body,seq,last_sha,signature FROM masters ORDER BY master_id").fetchall()
        require(0 < len(masters) <= MAX_MASTERS and all(MASTER.fullmatch(row[0]) for row in masters), "master registry")
        require(conn.execute("SELECT COUNT(*) FROM events").fetchone()[0] <= MAX_TOTAL_EVENTS, "global event capacity; migrate explicitly")
        require(conn.execute("SELECT 1 FROM events WHERE typeof(seq)!='integer' OR seq<1 OR seq>? LIMIT 1", (MAX_EVENTS,)).fetchone() is None, "global event sequence type/range")
        groups = {name: (count, first, last) for name, count, first, last in conn.execute("SELECT master_id,COUNT(*),MIN(seq),MAX(seq) FROM events GROUP BY master_id")}
        require(set(groups) <= {row[0] for row in masters}, "unregistered global inventory event")
        require(not registering or len(masters) < MAX_MASTERS, "master registry capacity; migrate explicitly")
        names = catalog(self.masters)
        expected = sorted([row[0] for row in masters] + ([self.master_id] if registering else []))
        require(names == expected and (not registering or self.master_id not in [row[0] for row in masters]), "master registry differs from filesystem")
        selected = None
        for name, body, seq, last, sig in masters:
            require(type(body) is bytes and type(seq) is int and 0 <= seq <= MAX_EVENTS and valid_sha(last) and valid_sha(sig), "master checkpoint shape")
            expected_body = encoded({"masterId": name, "path": str(self.masters / name), "identity": identity(normal(self.masters / name, True))})
            require(body == expected_body and hmac.compare_digest(sig, self.signed_head(body, seq, last)), "master identity/checkpoint signature")
            require(groups.get(name) == ((seq, 1, seq) if seq else None), "global event rows differ from signed checkpoint")
            if seq:
                require(conn.execute("SELECT entry_sha FROM events WHERE master_id=? AND seq=?", (name, seq)).fetchone() == (last,), "global event tail differs from signed checkpoint")
            if name == self.master_id:selected = (body, seq, last)
        require(registering or selected is not None, "master not registered")
        return selected

    def register(self):
        with self.connection(True) as (conn, meta):
            self.validated(conn, meta, registering=True)
            body = self.empty_master(self.master_id)
            conn.execute("INSERT INTO masters VALUES (?,?,0,?,?)", (self.master_id, body, "0" * 64, self.signed_head(body, 0, "0" * 64)))
            return {"schema": "negi-master-inventory-result/1", "action": "register", "masterId": self.master_id}

    def stage(self, raw):
        envelope = canonical(raw, MAX_ARTIFACT)
        require(set(envelope) == {"payload", "signature"} and type(envelope["payload"]) is dict and valid_sha(envelope["signature"]), "stage envelope")
        payload = envelope["payload"]
        require(set(payload) == {"schemaVersion", "request", "stage", "previousSha256", "identity", "reason", "at"}
                and payload["schemaVersion"] == "negi-master-conversation/1", "stage payload")
        require(hmac.compare_digest(envelope["signature"], hmac.new(self.key, encoded(payload), hashlib.sha256).hexdigest()), "stage HMAC")
        request = payload["request"]
        require(type(request) is dict and set(request) == {"requestId", "masterId", "mode", "oldThreadId", "cwd", "model", "effort", "provider", "settingsSha256"}
                and valid_uuid(request["requestId"]) and request["masterId"] == self.master_id
                and request["mode"] in ("start", "rotate")
                and (request["oldThreadId"] is None if request["mode"] == "start" else label(request["oldThreadId"]))
                and type(request["cwd"]) is str and os.path.isabs(request["cwd"])
                and label(request["model"]) and label(request["effort"])
                and (request["provider"] is None or label(request["provider"])) and valid_sha(request["settingsSha256"]), "stage request")
        require(payload["stage"] in ("requested", "old_idle", "start_dispatched", "bound", "completed", "cancelled", "needs_reconciliation")
                and (payload["previousSha256"] is None or valid_sha(payload["previousSha256"]))
                and (payload["reason"] is None or type(payload["reason"]) is str and text_length(payload["reason"]) <= 1000), "stage fields")
        date(payload["at"])
        found = payload["identity"]
        if found is not None:
            require(type(found) is dict and set(found) == {"threadId", "requestedModel", "resolvedModel", "modelProvider", "rerouted"}
                    and label(found["threadId"]) and found["threadId"] != request["oldThreadId"]
                    and found["requestedModel"] == found["resolvedModel"] == request["model"] and found["rerouted"] is False
                    and label(found["modelProvider"]) and (request["provider"] is None or request["provider"] == found["modelProvider"]), "stage thread identity")
        if payload["stage"] in ("bound", "completed"):require(found is not None, "missing bound thread")
        if payload["stage"] not in ("bound", "completed", "needs_reconciliation"):require(found is None, "unexpected bound thread")
        return payload

    def transition(self, previous, current, previous_sha):
        old, new = (previous["stage"] if previous else None), current["stage"]
        valid = (new == "requested" if old is None else
                 old in ("requested", "old_idle") if new == "cancelled" else
                 old in ("start_dispatched", "bound") if new == "needs_reconciliation" else
                 {"requested": "old_idle", "old_idle": "start_dispatched", "start_dispatched": "bound", "bound": "completed"}.get(old) == new)
        require(valid and current["previousSha256"] == previous_sha, "stage transition/predecessor")
        if previous:
            require(previous["request"] == current["request"], "stage request changed")
            if previous["identity"] is not None:require(previous["identity"] == current["identity"], "bound identity changed")

    def events(self, conn, checkpoint):
        body, head_seq, head_sha = checkpoint
        last, count, paths, operations = "0" * 64, 0, {}, {}
        # Stream bounded artifacts rather than fetching up to 1.2GB into memory.
        for seq, path, raw, artifact, entry_sha, sig in conn.execute("SELECT seq,path,body,artifact,entry_sha,signature FROM events WHERE master_id=? ORDER BY seq", (self.master_id,)):
            count += 1
            require(count <= MAX_EVENTS and seq == count and type(raw) is bytes and len(raw) <= 2000 and valid_sha(entry_sha) and valid_sha(sig), "event sequence/shape")
            event = json.loads(raw, object_pairs_hook=unique)
            require(type(event) is dict and encoded(event) == raw and set(event) == {"schema", "masterId", "masterSha256", "seq", "previousSha256", "type", "relativePath", "requestId", "stage", "artifactSha256", "ownerSha256"}
                    and event["schema"] == "negi-master-inventory-event/1" and event["masterId"] == self.master_id
                    and event["masterSha256"] == sha(body) and event["seq"] == seq and event["previousSha256"] == last
                    and event["type"] == "stage" and event["relativePath"] == path and valid_uuid(event["requestId"])
                    and valid_sha(event["ownerSha256"]), "event identity/predecessor")
            require(hmac.compare_digest(sig, signature(self.key, "negi-master-inventory-event/1", raw))
                    and entry_sha == sha(raw + b"\0" + sig.encode("ascii")), "event signature/hash")
            payload = self.stage(artifact)
            request_id = payload["request"]["requestId"]
            prior = operations.get(request_id)
            index = prior[2] if prior else 0
            self.transition(prior[0] if prior else None, payload, prior[1] if prior else None)
            require(index < 5 and path == f"{request_id}/0{index}-{payload['stage']}.json" and path not in paths
                    and event["requestId"] == request_id and event["stage"] == payload["stage"]
                    and event["artifactSha256"] == sha(artifact), "event artifact/path")
            paths[path] = {"sha256": sha(artifact), "size": len(artifact)}
            operations[request_id] = (payload, sha(artifact), index + 1)
            require(len(operations) <= 10000, "operation capacity; migrate explicitly")
            last = entry_sha
        require(count == head_seq and last == head_sha, "event tail differs from signed checkpoint")
        return paths, operations

    def scan(self, paths):
        expected_dirs = sorted({path.split("/")[0] for path in paths})
        inventory, actual = [], {}
        master_identity = identity(normal(self.master, True))
        master_names = names(self.master, MAX_MASTERS + 3)
        for name in master_names:
            path = self.master / name
            if name == "owner.lock":
                # A separately validated owner is not a conversation stage.
                read_file(path, 2000)
                continue
            if name == "owner-recovery-flock-v2.lock":
                require(read_file(path, 1) == b"", "native guard")
                continue
            if name == "recoveries":
                require(catalog(path) == [], "receipt indexing is not integrated; preserve legacy receipt")
                inventory.append([name, identity(normal(path, True)), []])
                continue
            require(name in expected_dirs and valid_uuid(name), "unindexed operation directory")
            info = normal(path, True)
            files = names(path)
            inventory.append([name, identity(info), files])
            for filename in files:
                relative = name + "/" + filename
                require(relative in paths, "unindexed stage file")
                raw = read_file(path / filename, MAX_ARTIFACT)
                found = {"sha256": sha(raw), "size": len(raw)}
                require(found == paths[relative], "indexed stage changed or partial")
                actual[relative] = [found, fingerprint(normal(path / filename))]
        missing = sorted(set(paths) - set(actual))
        require(master_identity == identity(normal(self.master, True)) and master_names == names(self.master, MAX_MASTERS + 3), "master inventory changed during scan")
        return inventory, actual, missing

    def audited(self, conn, meta):
        checkpoint = self.validated(conn, meta)
        paths, operations = self.events(conn, checkpoint)
        # Do not keep a SQLite read/write transaction open during full FS reads.
        # Recheck the selected signed head afterward; other Masters may progress.
        conn.execute("COMMIT")
        before = self.scan(paths)
        require(before == self.scan(paths), "journal inventory/content changed during audit")
        conn.execute("BEGIN")
        require(self.validated(conn, meta, integrity=False) == checkpoint, "selected checkpoint changed during audit")
        return checkpoint, paths, operations, before[2]

    def result(self, checkpoint, paths, missing):
        _, seq, last = checkpoint
        return {"schema": "negi-master-inventory-result/1", "action": "audit", "masterId": self.master_id,
                "head": {"seq": seq, "sha256": last}, "state": "pending" if missing else "clean",
                "artifactCount": len(paths), "missing": missing}

    def audit(self):
        with self.connection() as (conn, meta):
            checkpoint, paths, _, missing = self.audited(conn, meta)
            return self.result(checkpoint, paths, missing)

    def owner(self, expected_sha):
        require(valid_sha(expected_sha), "exact owner SHA required")
        raw = read_file(self.master / "owner.lock", 2000)
        require(sha(raw) == expected_sha, "owner bytes changed")
        value = canonical(raw, 2000)
        require(set(value) == {"schema", "pid", "owner", "createdAt", "masterId", "kind", "cwdSha256", "operation", "evidenceSha256", "signature", "processIdentity"}
                and value["schema"] == "negi-master-conversation-owner/3" and value["masterId"] == self.master_id
                and type(value["pid"]) is int and 0 < value["pid"] <= 0x7fffffff and valid_uuid(value["owner"])
                and value["kind"] == "thread-start" and valid_sha(value["cwdSha256"]) and valid_sha(value["evidenceSha256"])
                and valid_sha(value["signature"]), "stage owner shape/kind")
        date(value["createdAt"])
        payload = {key: item for key, item in value.items() if key != "signature"}
        require(hmac.compare_digest(value["signature"], hmac.new(self.key, encoded(payload), hashlib.sha256).hexdigest()), "owner HMAC")
        require(value["pid"] == os.getppid() and value["processIdentity"] == process_identity(), "owner process creation token differs from invoking parent")
        operation = value["operation"]
        require(type(operation) is dict and set(operation) == {"domain", "requestId", "hash"}
                and operation["domain"] == "master-conversation" and valid_uuid(operation["requestId"]) and valid_sha(operation["hash"]), "owner operation")
        return raw, value

    def append(self, request):
        require(set(request) == {"action", "root", "masterId", "expectedHead", "ownerSha256", "relativePath", "bytes"}, "append input fields")
        expected = request["expectedHead"]
        require(type(expected) is dict and set(expected) == {"seq", "sha256"} and type(expected["seq"]) is int
                and 0 <= expected["seq"] < MAX_EVENTS and valid_sha(expected["sha256"]), "expected checkpoint")
        require(type(request["bytes"]) is str, "stage bytes input")
        artifact = request["bytes"].encode("utf-8")
        with self.connection() as (conn, meta):
            checkpoint, paths, operations, missing = self.audited(conn, meta)
            require(not missing, "previous intent is not materialized; hold before next append")
            body, seq, last = checkpoint
            require(expected == {"seq": seq, "sha256": last}, "stale checkpoint; never retry automatically")
            owner_raw, owner = self.owner(request["ownerSha256"])
            payload = self.stage(artifact)
            stage_request = payload["request"]
            request_id = stage_request["requestId"]
            require(all(identifier == request_id or previous[0]["stage"] in ("completed", "cancelled")
                        for identifier, previous in operations.items()), "another operation requires reconciliation")
            require(owner["operation"]["requestId"] == request_id and owner["operation"]["hash"] == sha(encoded(stage_request) + b"\n")
                    and owner["cwdSha256"] == sha(stage_request["cwd"].encode("utf-8")), "owner/request binding")
            require(absent(self.master / "owner-recovery.lock"), "legacy recovery guard must be preserved")
            prior = operations.get(request_id)
            index = prior[2] if prior else 0
            self.transition(prior[0] if prior else None, payload, prior[1] if prior else None)
            relative_path = f"{request_id}/0{index}-{payload['stage']}.json"
            require(index < 5 and request["relativePath"] == relative_path and relative_path not in paths
                    and (prior is not None or len(operations) < 10000), "stage path/capacity")
            event = {"schema": "negi-master-inventory-event/1", "masterId": self.master_id, "masterSha256": sha(body),
                     "seq": seq + 1, "previousSha256": last, "type": "stage", "relativePath": relative_path,
                     "requestId": request_id, "stage": payload["stage"], "artifactSha256": sha(artifact), "ownerSha256": request["ownerSha256"]}
            raw = encoded(event)
            sig = signature(self.key, "negi-master-inventory-event/1", raw)
            entry_sha = sha(raw + b"\0" + sig.encode("ascii"))
            require(read_file(self.master / "owner.lock", 2000) == owner_raw, "owner changed after preflight")
        require(self.scan(paths)[2] == [], "journal changed before append")
        # Only the final CAS + inserts hold the root's SQLite write transaction.
        # The exact owner remains a separate prerequisite, not a retryable DB lease.
        with self.connection(True) as (conn, meta):
            require(self.validated(conn, meta, integrity=False) == checkpoint
                    and read_file(self.master / "owner.lock", 2000) == owner_raw
                    and self.owner(request["ownerSha256"])[1] == owner, "owner/checkpoint changed before commit")
            require(conn.execute("SELECT COUNT(*) FROM events").fetchone()[0] < MAX_TOTAL_EVENTS, "global event capacity; migrate explicitly")
            conn.execute("INSERT INTO events VALUES (?,?,?,?,?,?,?)", (self.master_id, seq + 1, relative_path, raw, artifact, entry_sha, sig))
            conn.execute("UPDATE masters SET seq=?,last_sha=?,signature=? WHERE master_id=?", (seq + 1, entry_sha, self.signed_head(body, seq + 1, entry_sha), self.master_id))
            require(read_file(self.master / "owner.lock", 2000) == owner_raw, "owner changed before commit")
            # The surrounding transaction commits intent + checkpoint together.
            # Caller may create the directory/file only after this succeeds.
            return {"schema": "negi-master-inventory-result/1", "action": "append", "masterId": self.master_id,
                    "head": {"seq": seq + 1, "sha256": entry_sha}, "relativePath": relative_path, "artifactSha256": sha(artifact)}

    def lookup(self, request):
        require(set(request) == {"action", "root", "masterId", "relativePath"} and type(request["relativePath"]) is str, "lookup input fields")
        with self.connection() as (conn, meta):
            checkpoint, paths, _, missing = self.audited(conn, meta)
            require(request["relativePath"] in paths, "unindexed artifact lookup")
            row = conn.execute("SELECT artifact FROM events WHERE master_id=? AND path=?", (self.master_id, request["relativePath"])).fetchone()
            result = self.result(checkpoint, paths, missing)
            result.update(action="lookup", relativePath=request["relativePath"], bytes=row[0].decode("utf-8"), artifactSha256=sha(row[0]))
            return result


def main():
    raw = sys.stdin.buffer.read(100001)
    require(0 < len(raw) <= 100000, "input size")
    request = json.loads(raw, object_pairs_hook=unique)
    require(type(request) is dict and {"action", "root", "masterId"} <= set(request), "input shape")
    inventory = Inventory(request["root"], request["masterId"])
    action = request["action"]
    if action == "processIdentity":
        require(set(request) == {"action", "root", "masterId"}, "input fields")
        result = {"schema": "negi-master-inventory-result/1", "action": action, "masterId": inventory.master_id, "processIdentity": process_identity()}
    elif action in ("initialize", "register", "audit"):
        require(set(request) == {"action", "root", "masterId"}, "input fields")
        result = getattr(inventory, action)()
    elif action == "append":result = inventory.append(request)
    elif action == "lookup":result = inventory.lookup(request)
    else:raise ValueError("Master inventory: unsupported action")
    sys.stdout.buffer.write(encoded(result) + b"\n")


if __name__ == "__main__":
    try:main()
    except Exception as error:
        # Avoid printing payloads, keys, traceback or child environment.
        sys.stderr.write(str(error)[:300] + "\n")
        sys.exit(1)
