"""Candidate inventory for Master conversation stages, independent of editable journals.

No provider calls or automatic repair. Explicit indexed recovery publishes only
the committed signed receipt before removing its exact native dead owner.
Legacy adoption is explicit, create-only, and records the accepted snapshot/decision.
The database detects missing/rolled-back journal files while the independent database
and signing authority survive. It is not an external monotonic anchor or a sandbox.
One bounded stdin JSON request; keys and artifact bytes never appear in argv/env.
"""
from contextlib import ExitStack, contextmanager, nullcontext
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
from functools import lru_cache, wraps
from negi_master_storage_guard import storage_guard
from concurrent.futures import ThreadPoolExecutor
from types import MappingProxyType
from threading import Lock

VERSION = 2
APPLICATION_ID = 0x4E544331
MAX_STAGE_EVENTS = 50000  # Preserve five stages for each of 10,000 operations.
MAX_TOTAL_STAGE_EVENTS = 50000  # Existing whole-DB stage allowance is unchanged.
MAX_RECEIPTS = 10000
MAX_TOTAL_RECEIPTS = 50000  # Receipts have a separate whole-DB allowance.
MAX_EVENTS = 60000  # Per-Master aggregate; receipts do not consume stage capacity.
MAX_TOTAL_EVENTS = 100000
MAX_MASTERS = 10000
MAX_ARTIFACT = 24000
MAX_DATABASE_BYTES = 1_500_000_000
READ_WORKERS = 8  # Concurrent operation readers; retained handles have a separate budget.
MAX_RETAINED_HANDLES = 8192  # Per one-shot append; larger histories keep legacy full-open reads.
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
SHA = re.compile(r"[0-9a-f]{64}")
MASTER = re.compile(r"[a-zA-Z0-9_-]{1,100}")
SCHEMA = [
    "CREATE TABLE meta (id INTEGER PRIMARY KEY CHECK(id=1), body BLOB NOT NULL, signature TEXT NOT NULL)",
    "CREATE TABLE masters (master_id TEXT PRIMARY KEY, body BLOB NOT NULL, seq INTEGER NOT NULL, last_sha TEXT NOT NULL, signature TEXT NOT NULL) WITHOUT ROWID",
    "CREATE TABLE events (master_id TEXT NOT NULL REFERENCES masters(master_id), seq INTEGER NOT NULL, path TEXT NOT NULL, body BLOB NOT NULL, artifact BLOB NOT NULL, entry_sha TEXT NOT NULL, signature TEXT NOT NULL, PRIMARY KEY(master_id,seq), UNIQUE(master_id,path)) WITHOUT ROWID",
    "CREATE TABLE adoptions (id INTEGER PRIMARY KEY CHECK(id=1), body BLOB NOT NULL, signature TEXT NOT NULL)",
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


def native_stamp(info):
    return (info.volume, info.index_high, info.index_low, info.size_high, info.size_low, info.links,
            info.created.dwHighDateTime, info.created.dwLowDateTime, info.written.dwHighDateTime, info.written.dwLowDateTime)


class RetainedStageReads:
    """One append only: retain protected handles, never cached artifact bytes.

    Every pass still reads and hashes every stage. Windows denies compatible
    write/delete opens until commit/hold and cleanup; attribute/path checks remain.
    """
    def __init__(self):
        require(os.name == "nt", "protected stage handles require Windows")
        self.kernel = native_kernel()
        self.files, self.directories = {}, {}
        self.lock = Lock()
        self.enabled = None

    def choose(self, paths):
        estimate = len(paths) + len({path.split("/")[0] for path in paths})
        if self.enabled is None:
            require(not self.files and not self.directories, "select protection before acquiring handles")
            self.enabled = estimate <= MAX_RETAINED_HANDLES
        elif self.enabled:require(estimate <= MAX_RETAINED_HANDLES, "protected handle estimate changed")

    def opened(self, path, directory=False):
        from negi_recover_writer import windows_extended, windows_normal, win_info
        import ctypes
        flags = 0x00200000 | (0x02000000 if directory else 0)
        # Directory access permits child creation; no DELETE sharing pins its name.
        # Stage access permits READ only, including rejection of writable mappings.
        handle = self.kernel.CreateFileW(windows_extended(path), 0x80 if directory else 0x80000000,
                                         3 if directory else 1, None, 3, flags, None)
        require(handle != ctypes.c_void_p(-1).value, "protected stage handle unavailable; preserve competing writer")
        try:
            win_info(self.kernel, handle, directory, MAX_ARTIFACT)
            if directory:
                buffer = ctypes.create_unicode_buffer(32768)
                length = self.kernel.GetFinalPathNameByHandleW(handle, buffer, len(buffer), 0)
                require(0 < length < len(buffer) and os.path.normcase(windows_normal(buffer.value)) == os.path.normcase(str(path)),
                        "protected operation directory alias")
            return handle
        except BaseException:
            self.kernel.CloseHandle(handle)
            raise

    def directory(self, path, before):
        with self.lock:entry = self.directories.get(path)
        if entry is not None:
            require(entry[1] == tuple(before), "protected operation directory changed")
            return
        handle = self.opened(path, True)
        try:
            require(before == identity(normal(path, True)), "operation replaced before protection")
            with self.lock:
                require(path not in self.directories and len(self.directories) < MAX_MASTERS
                        and len(self.files) + len(self.directories) < MAX_RETAINED_HANDLES, "protected directory capacity")
                self.directories[path] = (handle, tuple(before))
        except BaseException:
            self.kernel.CloseHandle(handle)
            raise

    def read(self, path, limit):
        from negi_recover_writer import win_info, win_bytes
        before = tuple(fingerprint(normal(path)))
        with self.lock:entry = self.files.get(path)
        if entry is not None:
            handle, stamp, pinned, bound = entry
            require(bound == limit and pinned == before, "protected stage metadata/path changed")
            require(stamp == native_stamp(win_info(self.kernel, handle, limit=limit)), "protected stage changed")
            raw = win_bytes(self.kernel, handle, limit)
            require(stamp == native_stamp(win_info(self.kernel, handle, limit=limit)) and pinned == tuple(fingerprint(normal(path)))
                    and len(raw) == int(pinned[2]), "protected stage changed during read")
            return raw
        handle = self.opened(path)
        try:
            stamp = native_stamp(win_info(self.kernel, handle, limit=limit))
            raw = win_bytes(self.kernel, handle, limit)
            require(stamp == native_stamp(win_info(self.kernel, handle, limit=limit)) and before == tuple(fingerprint(normal(path)))
                    and len(raw) == int(before[2]), "stage changed before protection")
            with self.lock:
                require(path not in self.files and len(self.files) < MAX_EVENTS
                        and len(self.files) + len(self.directories) < MAX_RETAINED_HANDLES, "protected stage capacity")
                self.files[path] = (handle, stamp, before, limit)
            return raw
        except BaseException:
            self.kernel.CloseHandle(handle)
            raise

    def close(self):
        # Caller has joined every reader first, including failures/cancellations.
        ok = True
        for rows in (self.files, self.directories):
            for entry in rows.values():ok = bool(self.kernel.CloseHandle(entry[0])) and ok
            rows.clear()
        require(ok, "protected handles did not all close")


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
        handle = win_open_reader(kernel, path)
        require(handle != ctypes.c_void_p(-1).value, "file handle unavailable")
        try:
            pinned = native_stamp(win_info(kernel, handle, limit=limit))
            raw = win_bytes(kernel, handle, limit)
            require(pinned == native_stamp(win_info(kernel, handle, limit=limit)), "file changed during read")
            current = win_open_reader(kernel, path)
            require(current != ctypes.c_void_p(-1).value, "file path changed during read")
            try:
                require(pinned == native_stamp(win_info(kernel, current, limit=limit))
                        == native_stamp(win_info(kernel, handle, limit=limit)), "file replaced during read")
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


def absent(path):
    # Permission, invalid-name and other stat failures are ambiguity, not absence.
    try:os.lstat(path)
    except FileNotFoundError:return True
    return False


def recovery_namespace_absent(db):
    for suffix in (".recoveries", ".recoveries.pending"):
        require(absent(Path(str(db) + suffix)), "recovery ledger survives; never recreate database")


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


def expected_schema(version=VERSION):
    with sqlite3.connect(":memory:") as conn:
        for sql in (SCHEMA if version == 2 else SCHEMA[:3]):conn.execute(sql)
        return schema_objects(conn)


def validate_schema(conn, integrity=True):
    version = conn.execute("PRAGMA user_version").fetchone()[0]
    require(conn.execute("PRAGMA application_id").fetchone()[0] == APPLICATION_ID
            and version in (1, VERSION), "database version/application")
    require(schema_objects(conn) == expected_schema(version), "unexpected database schema")
    if integrity:
        require(conn.execute("PRAGMA quick_check").fetchall() == [("ok",)], "database integrity")
        require(conn.execute("PRAGMA foreign_key_check").fetchall() == [], "orphan inventory event")
    return version


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


def storage_action(function):
    @wraps(function)
    def guarded(self, *args, **kwargs):
        with storage_guard(self.root, create=function.__name__ not in ("audit", "lookup", "latest_stage", "append_receipt", "recovery_intent", "release_recovery", "preview_migration", "preview", "recover")):return function(self, *args, **kwargs)
    return guarded


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
        self.retained = None
        self.adoption = None
        self.recovery_access = False

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
    def authority_guard(self):
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
            yield meta
            require(self.authority() == meta, "authority identity changed")

    @contextmanager
    def guarded(self, initialize=False):
        with ExitStack() as stack:
            meta = stack.enter_context(self.authority_guard())
            if initialize:recovery_namespace_absent(self.db)
            if not self.recovery_access:
                from negi_master_inventory_recovery import DatabaseRecovery
                DatabaseRecovery(self).assert_idle(meta)
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
                win_info(kernel, handle, limit=MAX_DATABASE_BYTES)
            require(pinned.st_size <= MAX_DATABASE_BYTES, "database size limit; migrate explicitly")
            yield meta
            require(identity(normal(self.db)) == identity(pinned) and self.authority() == meta, "authority/database identity changed")
            require(normal(self.db).st_size <= MAX_DATABASE_BYTES, "database size limit; preserve committed outcome for inspection")
            no_sidecars(self.db)

    @contextmanager
    def connection(self, writable=False, initialize=False):
        with storage_guard(self.root, create=writable), self.guarded(initialize) as meta:
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

    @storage_action
    def initialize(self):
        recovery_namespace_absent(self.db)
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

    def validated_adoption(self, conn, meta):
        rows = conn.execute("SELECT id,body,signature FROM adoptions").fetchall()
        if not rows:return None
        require(len(rows) == 1 and rows[0][0] == 1 and type(rows[0][1]) is bytes and valid_sha(rows[0][2]), "adoption envelope")
        raw, sig = rows[0][1:]
        require(hmac.compare_digest(sig, signature(self.key, "negi-master-inventory-adoption/1", raw)), "adoption HMAC")
        value = json.loads(raw, object_pairs_hook=unique)
        require(type(value) is dict and encoded(value) == raw and set(value) == {"schema", "authoritySha256", "decisionId", "proofSha256", "masters"}
                and value["schema"] == "negi-master-inventory-adoption/1" and value["authoritySha256"] == sha(encoded(meta))
                and valid_uuid(value["decisionId"]) and valid_sha(value["proofSha256"])
                and type(value["masters"]) is list and 0 < len(value["masters"]) <= MAX_MASTERS, "adoption identity")
        identifiers, stages, receipts = [], 0, 0
        for row in value["masters"]:
            require(type(row) is dict and set(row) == {"masterId", "masterSha256", "stageCount", "receiptCount", "artifactSha256"}
                    and type(row["masterId"]) is str and MASTER.fullmatch(row["masterId"]) and valid_sha(row["masterSha256"])
                    and valid_sha(row["artifactSha256"]) and type(row["stageCount"]) is int and 0 <= row["stageCount"] <= MAX_STAGE_EVENTS
                    and type(row["receiptCount"]) is int and 0 <= row["receiptCount"] <= MAX_RECEIPTS
                    and row["stageCount"] + row["receiptCount"] <= MAX_EVENTS, "adoption master summary")
            identifiers.append(row["masterId"]);stages += row["stageCount"];receipts += row["receiptCount"]
        require(identifiers == sorted(set(identifiers)) and stages <= MAX_TOTAL_STAGE_EVENTS
                and receipts <= MAX_TOTAL_RECEIPTS and stages + receipts <= MAX_TOTAL_EVENTS, "adoption capacity/order")
        return raw, value

    def absent_owners(self):
        for name in catalog(self.masters):
            require(MASTER.fullmatch(name), "legacy master identity")
            for filename in ("owner.lock", "owner-recovery.lock"):
                require(absent(self.masters / name / filename), "all legacy owners/recovery writers must be absent")

    def legacy_snapshot(self, check_database=True):
        if check_database:
            no_sidecars(self.db)
            require(absent(self.db), "existing database must never be replaced or silently upgraded")
            recovery_namespace_absent(self.db)
        meta = self.authority();self.absent_owners()
        master_names = catalog(self.masters)
        require(self.master_id in master_names, "migration target master missing")
        snapshot, sources, summaries, total_stages, total_receipts = [], {}, [], 0, 0
        original_id, original_master = self.master_id, self.master
        try:
            for name in master_names:
                require(MASTER.fullmatch(name), "legacy master registration")
                self.master_id, self.master = name, self.masters / name
                before = identity(normal(self.master, True));entries = catalog(self.master, MAX_MASTERS + 3)
                body = encoded({"masterId": name, "path": str(self.master), "identity": before})
                files, records, directories, decisions = [], [], [], set()
                operations = 0;receipts = 0
                for entry in entries:
                    path = self.master / entry
                    if entry == "owner-recovery-flock-v2.lock":
                        require(read_file(path, 1) == b"", "legacy native recovery guard")
                        files.append({"path": entry, "stamp": fingerprint(normal(path)), "sha256": sha(b""), "size": 0})
                        continue
                    if entry == "recoveries":
                        directory_id = identity(normal(path, True));receipt_names = catalog(path)
                        directories.append([entry, directory_id, receipt_names])
                        for filename in receipt_names:
                            relative = entry + "/" + filename
                            raw = read_file(path / filename, 8000);payload = self.receipt(raw, filename)
                            require(payload["decisionId"] not in decisions, "duplicate legacy recovery decision")
                            decisions.add(payload["decisionId"]);receipts += 1
                            require(receipts <= MAX_RECEIPTS, "migration receipt capacity; preserve legacy history")
                            records.append(("receipt", relative, sha(raw), len(raw), payload["owner"]["operation"]["requestId"], None))
                            files.append({"path": relative, "stamp": fingerprint(normal(path / filename)), "sha256": sha(raw), "size": len(raw)})
                        require(directory_id == identity(normal(path, True)) and receipt_names == catalog(path), "legacy receipts changed")
                        continue
                    require(valid_uuid(entry), "unknown legacy entry or unresolved writer")
                    operations += 1;require(operations <= 10000, "legacy operation capacity")
                    directory_id = identity(normal(path, True));stage_names = catalog(path, 5)
                    require(stage_names, "empty legacy operation needs reconciliation")
                    previous = None;previous_sha = None
                    for index, filename in enumerate(stage_names):
                        raw = read_file(path / filename, MAX_ARTIFACT);payload = self.stage(raw)
                        self.transition(previous, payload, previous_sha)
                        require(payload["request"]["requestId"] == entry and filename == f"0{index}-{payload['stage']}.json", "legacy stage path/order")
                        relative = entry + "/" + filename
                        records.append(("stage", relative, sha(raw), len(raw), payload["request"]["requestId"], payload["stage"]))
                        files.append({"path": relative, "stamp": fingerprint(normal(path / filename)), "sha256": sha(raw), "size": len(raw)})
                        previous, previous_sha = payload, sha(raw)
                    require(directory_id == identity(normal(path, True)) and stage_names == catalog(path, 5), "legacy operation changed")
                    directories.append([entry, directory_id, stage_names])
                require(before == identity(normal(self.master, True)) and entries == catalog(self.master, MAX_MASTERS + 3), "legacy master changed")
                records.sort(key=lambda row: row[1]);files.sort(key=lambda row: row["path"])
                stage_count = len(records) - receipts;total_stages += stage_count;total_receipts += receipts
                require(stage_count <= MAX_STAGE_EVENTS and len(records) <= MAX_EVENTS and total_stages <= MAX_TOTAL_STAGE_EVENTS
                        and total_receipts <= MAX_TOTAL_RECEIPTS and total_stages + total_receipts <= MAX_TOTAL_EVENTS,
                        "migration event capacity; preserve legacy history")
                artifacts = [{"path": row[1], "sha256": row[2], "size": row[3]} for row in records]
                summaries.append({"masterId": name, "masterSha256": sha(body), "stageCount": stage_count, "receiptCount": receipts, "artifactSha256": sha(encoded(artifacts))})
                snapshot.append({"masterId": name, "identity": before, "entries": entries, "directories": directories, "files": files})
                sources[name] = (body, records)
        finally:self.master_id, self.master = original_id, original_master
        self.absent_owners()
        require(meta == self.authority() and master_names == catalog(self.masters), "legacy authority changed")
        proof = sha(encoded({"schema": "negi-master-inventory-migration-preview/1", "authority": meta, "masters": snapshot}))
        return meta, proof, sources, summaries

    def migration_result(self, action, proof, summaries, decision=None):
        result = {"schema": "negi-master-inventory-result/1", "action": action, "masterId": self.master_id, "proofSha256": proof,
                  "masterCount": len(summaries), "stageCount": sum(row["stageCount"] for row in summaries), "receiptCount": sum(row["receiptCount"] for row in summaries)}
        if decision is not None:result["decisionId"] = decision
        return result

    @storage_action
    def preview_migration(self):
        with self.authority_guard():
            first = self.legacy_snapshot()
            require(first == self.legacy_snapshot(), "legacy snapshot changed during preview")
            return self.migration_result("previewMigration", first[1], first[3])

    @storage_action
    def migrate(self, request):
        require(set(request) == {"action", "root", "masterId", "decisionId", "expectedProofSha256"}
                and valid_uuid(request["decisionId"]) and valid_sha(request["expectedProofSha256"]), "migration decision/proof")
        # Exact retries inspect the accepted decision and EVERY registered Master;
        # they never replace an existing DB or replay an import transaction.
        if not absent(self.db):
            with self.connection() as (conn, meta):
                self.absent_owners();self.validated(conn, meta)
                require(self.adoption is not None, "existing database has no accepted legacy adoption")
                adoption = self.adoption[1]
                require(adoption["decisionId"] == request["decisionId"] and adoption["proofSha256"] == request["expectedProofSha256"], "different migration decision or proof")
                original_id, original_master = self.master_id, self.master
                try:
                    for name in catalog(self.masters):
                        self.master_id, self.master = name, self.masters / name
                        require(self.audited(conn, meta)[3] == [], "accepted migration has missing artifacts")
                finally:self.master_id, self.master = original_id, original_master
                self.absent_owners()
                return self.migration_result("migrate", adoption["proofSha256"], adoption["masters"], adoption["decisionId"])
        with self.authority_guard():
            source = self.legacy_snapshot()
            require(source[1] == request["expectedProofSha256"] and source == self.legacy_snapshot(), "migration preview changed; obtain a new preview")
            meta, proof, masters, summaries = source
            adoption = encoded({"schema": "negi-master-inventory-adoption/1", "authoritySha256": sha(encoded(meta)), "decisionId": request["decisionId"], "proofSha256": proof, "masters": summaries})
            with self.connection(True, True) as (conn, current_meta):
                require(current_meta == meta, "migration authority changed before database creation")
                conn.execute(f"PRAGMA application_id={APPLICATION_ID}");conn.execute(f"PRAGMA user_version={VERSION}")
                for sql in SCHEMA:conn.execute(sql)
                raw = encoded(meta)
                conn.execute("INSERT INTO meta VALUES (1,?,?)", (raw, signature(self.key, "negi-master-inventory-meta/1", raw)))
                conn.execute("INSERT INTO adoptions VALUES (1,?,?)", (adoption, signature(self.key, "negi-master-inventory-adoption/1", adoption)))
                for name, (body, records) in masters.items():
                    last = "0" * 64
                    conn.execute("INSERT INTO masters VALUES (?,?,0,?,?)", (name, body, last, self.signed_head(body, 0, last)))
                    for seq, (kind, path, expected_sha, size, request_id, stage) in enumerate(records, 1):
                        # Stream each original artifact into SQLite; do not retain
                        # up to 1.2GB of legacy payloads in the snapshot manifest.
                        artifact = read_file(self.masters / name / path, MAX_ARTIFACT if kind == "stage" else 8000)
                        require(sha(artifact) == expected_sha and len(artifact) == size, "legacy artifact changed during import")
                        event = {"schema": "negi-master-inventory-event/2", "masterId": name, "masterSha256": sha(body), "seq": seq, "previousSha256": last,
                                 "type": kind, "relativePath": path, "requestId": request_id,
                                 "stage": stage, "artifactSha256": sha(artifact), "migrationSha256": sha(adoption)}
                        raw = encoded(event);sig = signature(self.key, "negi-master-inventory-event/2", raw);last = sha(raw + b"\0" + sig.encode("ascii"))
                        conn.execute("INSERT INTO events VALUES (?,?,?,?,?,?,?)", (name, seq, path, raw, artifact, last, sig))
                    conn.execute("UPDATE masters SET seq=?,last_sha=?,signature=? WHERE master_id=?", (len(records), last, self.signed_head(body, len(records), last), name))
                require(conn.execute("PRAGMA page_count").fetchone()[0] * conn.execute("PRAGMA page_size").fetchone()[0] <= MAX_DATABASE_BYTES,
                        "migration database capacity; preserve source and partial DB")
                require(source == self.legacy_snapshot(False), "legacy bytes/owners changed before migration commit")
                # A crash before COMMIT leaves the exact partial DB for inspection.
                # No source file/owner/receipt is changed. SQLite manages its own
                # transaction journal; this code never manually removes it.
                return self.migration_result("migrate", proof, summaries, request["decisionId"])

    def validated(self, conn, meta, registering=False, integrity=True):
        version = validate_schema(conn, integrity)
        rows = conn.execute("SELECT id,body,signature FROM meta").fetchall()
        require(len(rows) == 1 and rows[0][0] == 1 and rows[0][1] == encoded(meta)
                and hmac.compare_digest(rows[0][2], signature(self.key, "negi-master-inventory-meta/1", rows[0][1])), "authority/key metadata mismatch")
        self.adoption = self.validated_adoption(conn, meta) if version == 2 else None
        masters = conn.execute("SELECT master_id,body,seq,last_sha,signature FROM masters ORDER BY master_id").fetchall()
        require(0 < len(masters) <= MAX_MASTERS and all(MASTER.fullmatch(row[0]) for row in masters), "master registry")
        # Imported counts come from the signed adoption. New receipt counts
        # authenticate positive event headers rather than trusting SQL paths.
        receipt_counts = self.receipt_counts(conn)
        total = conn.execute("SELECT COUNT(*) FROM events").fetchone()[0];receipts = sum(receipt_counts.values())
        require(total <= MAX_TOTAL_EVENTS and receipts <= MAX_TOTAL_RECEIPTS and total - receipts <= MAX_TOTAL_STAGE_EVENTS,
                "global event capacity; migrate explicitly")
        require(conn.execute("SELECT 1 FROM events WHERE typeof(seq)!='integer' OR seq<1 OR seq>? LIMIT 1", (MAX_EVENTS,)).fetchone() is None, "global event sequence type/range")
        groups = {}
        for name, count, first, last in conn.execute("SELECT master_id,COUNT(*),MIN(seq),MAX(seq) FROM events GROUP BY master_id"):
            receipts = receipt_counts.get(name, 0)
            require(receipts <= count <= MAX_EVENTS and receipts <= MAX_RECEIPTS and count - receipts <= MAX_STAGE_EVENTS,
                    "master event capacity; migrate explicitly")
            groups[name] = (count, first, last)
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
        if self.adoption:
            registered = {name: sha(body) for name, body, *_ in masters}
            require(all(registered.get(row["masterId"]) == row["masterSha256"] for row in self.adoption[1]["masters"]), "adopted master removed or replaced")
        require(registering or selected is not None, "master not registered")
        return selected

    def receipt_counts(self, conn):
        counts = {row["masterId"]: row["receiptCount"] for row in self.adoption[1]["masters"]} if self.adoption else {}
        bodies = dict(conn.execute("SELECT master_id,body FROM masters"))
        # The byte filter is an optimization, not authorization: a false negative
        # counts the row as a stage and makes capacity stricter. A positive may
        # subtract a stage only after the fixed signed type/coordinates match.
        for name, seq, path, raw, entry_sha, sig in conn.execute("SELECT master_id,seq,path,body,entry_sha,signature FROM events WHERE instr(body,?)>0", (b'"type":"receipt"',)):
            require(type(raw) is bytes and len(raw) <= 2000, "receipt event header bound")
            event = json.loads(raw, object_pairs_hook=unique)
            if event.get("schema") == "negi-master-inventory-event/2":continue
            require(encoded(event) == raw and set(event) == {"schema", "masterId", "masterSha256", "seq", "previousSha256", "type", "relativePath", "requestId", "stage", "artifactSha256", "ownerSha256", "contextSha256"}
                    and event["schema"] == "negi-master-inventory-event/3" and event["type"] == "receipt"
                    and event["masterId"] == name and event["masterSha256"] == sha(bodies[name]) and event["seq"] == seq
                    and event["relativePath"] == path and re.fullmatch(r"recoveries/" + UUID.pattern + r"\.json", path)
                    and valid_uuid(event["requestId"]) and event["stage"] is None
                    and all(valid_sha(event[field]) for field in ("previousSha256", "artifactSha256", "ownerSha256", "contextSha256"))
                    and valid_sha(sig) and hmac.compare_digest(sig, signature(self.key, event["schema"], raw))
                    and entry_sha == sha(raw + b"\0" + sig.encode("ascii")), "authenticated receipt capacity header")
            counts[name] = counts.get(name, 0) + 1
        return counts

    @storage_action
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

    def receipt(self, raw, filename):
        from negi_recover_writer import validate
        envelope = canonical(raw, 8000)
        require(set(envelope) == {"payload", "signature"} and type(envelope["payload"]) is dict and valid_sha(envelope["signature"]), "recovery envelope")
        payload = envelope["payload"]
        require(set(payload) == {"schemaVersion", "masterId", "decisionId", "cwdSha256", "owner", "proofSha256", "action", "at"}
                and payload["schemaVersion"] == "negi-master-owner-recovery/1" and payload["masterId"] == self.master_id
                and valid_uuid(payload["decisionId"]) and valid_sha(payload["cwdSha256"]) and valid_sha(payload["proofSha256"])
                and payload["action"] == "release-owner-only" and type(payload["owner"]) is dict, "recovery payload")
        date(payload["at"])
        owner = payload["owner"];operation = owner.get("operation")
        require(type(operation) is dict and set(operation) == {"domain", "requestId", "hash"} and operation["domain"] == "master-conversation"
                and valid_uuid(operation["requestId"]) and valid_sha(operation["hash"]), "recovered owner operation")
        validate(encoded(owner) + b"\n", "master", "master-conversation", operation["requestId"], operation["hash"])
        require(owner["masterId"] == self.master_id and valid_uuid(owner["owner"]) and filename == owner["owner"] + ".json"
                and owner["cwdSha256"] == payload["cwdSha256"], "recovery owner identity")
        date(owner["createdAt"])
        unsigned = {name: item for name, item in owner.items() if name != "signature"}
        require(hmac.compare_digest(owner["signature"], hmac.new(self.key, encoded(unsigned), hashlib.sha256).hexdigest())
                and hmac.compare_digest(envelope["signature"], hmac.new(self.key, encoded(payload), hashlib.sha256).hexdigest()), "recovery/owner HMAC")
        return payload

    def events(self, conn, checkpoint):
        body, head_seq, head_sha = checkpoint
        last, count, paths, operations = "0" * 64, 0, {}, {}
        adopted, receipts, seen_live, adopted_receipts = [], set(), False, 0
        self.receipt_artifacts = {}
        # Stream bounded artifacts rather than fetching up to 1.2GB into memory.
        for seq, path, raw, artifact, entry_sha, sig in conn.execute("SELECT seq,path,body,artifact,entry_sha,signature FROM events WHERE master_id=? ORDER BY seq", (self.master_id,)):
            count += 1
            require(count <= MAX_EVENTS and seq == count and type(raw) is bytes and len(raw) <= 2000 and valid_sha(entry_sha) and valid_sha(sig), "event sequence/shape")
            event = json.loads(raw, object_pairs_hook=unique)
            imported = type(event) is dict and event.get("schema") == "negi-master-inventory-event/2"
            recovery = type(event) is dict and event.get("schema") == "negi-master-inventory-event/3"
            source_field = "migrationSha256" if imported else "ownerSha256"
            require(type(event) is dict and encoded(event) == raw and set(event) == {"schema", "masterId", "masterSha256", "seq", "previousSha256", "type", "relativePath", "requestId", "stage", "artifactSha256", source_field} | ({"contextSha256"} if recovery else set())
                    and event["schema"] in ("negi-master-inventory-event/1", "negi-master-inventory-event/2", "negi-master-inventory-event/3") and event["masterId"] == self.master_id
                    and event["masterSha256"] == sha(body) and event["seq"] == seq and event["previousSha256"] == last
                    and event["type"] in (("stage", "receipt") if imported else ("receipt",) if recovery else ("stage",)) and event["relativePath"] == path and valid_uuid(event["requestId"])
                    and (not recovery or valid_sha(event["contextSha256"]))
                    and valid_sha(event[source_field]), "event identity/predecessor")
            require(hmac.compare_digest(sig, signature(self.key, event["schema"], raw))
                    and entry_sha == sha(raw + b"\0" + sig.encode("ascii")), "event signature/hash")
            require(path not in paths and event["artifactSha256"] == sha(artifact), "event artifact/path")
            if imported:
                require(not seen_live and self.adoption is not None and event["migrationSha256"] == sha(self.adoption[0]), "adopted event lacks accepted baseline")
                adopted.append({"path": path, "sha256": sha(artifact), "size": len(artifact)})
            else:seen_live = True
            if event["type"] == "receipt":
                require(path.startswith("recoveries/") and path.count("/") == 1, "receipt path")
                payload = self.receipt(artifact, path.split("/")[1])
                require(payload["decisionId"] not in receipts and event["stage"] is None and event["requestId"] == payload["owner"]["operation"]["requestId"], "receipt decision/event mismatch")
                require(imported or event["ownerSha256"] == sha(encoded(payload["owner"]) + b"\n"), "receipt exact owner hash")
                adopted_receipts += int(imported)
                self.receipt_artifacts[path] = (artifact, payload, imported, event.get("contextSha256"))
                receipts.add(payload["decisionId"]);require(len(receipts) <= MAX_RECEIPTS, "receipt capacity; migrate explicitly")
                paths[path] = {"sha256": sha(artifact), "size": len(artifact)};last = entry_sha
                continue
            require(count - len(receipts) <= MAX_STAGE_EVENTS, "stage capacity; migrate explicitly")
            payload = self.stage(artifact)
            request_id = payload["request"]["requestId"]
            prior = operations.get(request_id)
            index = prior[2] if prior else 0
            self.transition(prior[0] if prior else None, payload, prior[1] if prior else None)
            require(index < 5 and path == f"{request_id}/0{index}-{payload['stage']}.json"
                    and event["requestId"] == request_id and event["stage"] == payload["stage"]
                    and event["artifactSha256"] == sha(artifact), "event artifact/path")
            paths[path] = {"sha256": sha(artifact), "size": len(artifact)}
            operations[request_id] = (payload, sha(artifact), index + 1)
            require(len(operations) <= 10000, "operation capacity; migrate explicitly")
            last = entry_sha
        if self.adoption:
            baseline = next((row for row in self.adoption[1]["masters"] if row["masterId"] == self.master_id), None)
            require((baseline is not None or not adopted), "adoption has no registered master baseline")
            if baseline:
                require(adopted == sorted(adopted, key=lambda row: row["path"]) and adopted_receipts == baseline["receiptCount"]
                        and len(adopted) == baseline["stageCount"] + baseline["receiptCount"]
                        and sha(encoded(adopted)) == baseline["artifactSha256"], "adopted artifacts differ from accepted baseline")
        require(count == head_seq and last == head_sha, "event tail differs from signed checkpoint")
        return paths, operations

    def scan_operation(self, name, paths):
        path = self.master / name
        before = identity(normal(path, True))
        if self.retained is not None and self.retained.enabled:self.retained.directory(path, before)
        files = names(path)
        require(len(files) <= 5, "operation file capacity")
        actual = {}
        for filename in files:
            relative = name + "/" + filename
            require(relative in paths, "unindexed stage file")
            raw = self.retained.read(path / filename, MAX_ARTIFACT) if self.retained is not None and self.retained.enabled else read_file(path / filename, MAX_ARTIFACT)
            found = {"sha256": sha(raw), "size": len(raw)}
            require(found == paths[relative], "indexed stage changed or partial")
            actual[relative] = [found, fingerprint(normal(path / filename))]
        require(before == identity(normal(path, True)) and files == names(path), "operation changed during scan")
        return [name, before, files], actual

    def scan_receipts(self, paths):
        root = self.master / "recoveries";before = identity(normal(root, True));files = catalog(root)
        if self.retained is not None and self.retained.enabled:self.retained.directory(root, before)
        actual = {}
        for filename in files:
            relative = "recoveries/" + filename
            if filename.startswith(".pending-"):
                match = re.fullmatch(r"\.pending-(" + UUID.pattern + r")-(" + UUID.pattern + r")\.json", filename)
                require(match is not None, "unknown pending receipt")
                final = "recoveries/" + match[1] + ".json"
                indexed = self.receipt_artifacts.get(final)
                require(indexed and not indexed[2] and indexed[1]["decisionId"] == match[2]
                        and match[1] + ".json" not in files, "pending receipt lacks its exact intent")
                raw = read_file(root / filename, 8000)
                require(len(raw) <= len(indexed[0]) and indexed[0].startswith(raw), "pending receipt differs from fixed signed bytes")
                actual[relative] = [{"sha256": sha(raw), "size": len(raw)}, fingerprint(normal(root / filename))]
                continue
            require(relative in paths, "unindexed recovery receipt; preserve it")
            raw = self.retained.read(root / filename, 8000) if self.retained is not None and self.retained.enabled else read_file(root / filename, 8000)
            found = {"sha256": sha(raw), "size": len(raw)}
            require(found == paths[relative], "indexed recovery receipt changed or partial")
            actual[relative] = [found, fingerprint(normal(root / filename))]
        require(before == identity(normal(root, True)) and files == catalog(root), "recovery receipts changed during scan")
        return ["recoveries", before, files], actual

    def scan(self, paths):
        if self.retained is not None:self.retained.choose(paths)
        expected_paths = MappingProxyType({path: MappingProxyType(value) for path, value in paths.items()})
        expected_dirs = {path.split("/")[0] for path in expected_paths}
        inventory, actual, operations = [], {}, []
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
                entry, files = self.scan_receipts(expected_paths)
                inventory.append(entry);actual.update(files)
                continue
            require(name in expected_dirs and valid_uuid(name), "unindexed operation directory")
            operations.append(name)
        if operations:
            if os.name == "nt":native_kernel()  # Initialize immutable ctypes signatures on the main thread.
            # A failed worker cancels queued work and joins all running readers
            # before canonical parent handles/SQLite scopes can be closed.
            with ThreadPoolExecutor(max_workers=READ_WORKERS, thread_name_prefix="negi-inventory-read") as pool:
                futures = [pool.submit(self.scan_operation, name, expected_paths) for name in operations]
                try:
                    for future in futures:  # Preserve deterministic name order regardless of completion order.
                        entry, files = future.result()
                        inventory.append(entry); actual.update(files)
                except BaseException:
                    for future in futures:future.cancel()
                    raise
        inventory.sort(key=lambda entry: entry[0])
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

    @storage_action
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

    @storage_action
    def append(self, request):
        require(self.retained is None, "nested append is not supported")
        if os.name != "nt":return self.append_checked(request)
        self.retained = RetainedStageReads()
        try:return self.append_checked(request)
        finally:
            try:self.retained.close()
            finally:self.retained = None

    def append_checked(self, request):
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
            receipt_counts = self.receipt_counts(conn)
            total = conn.execute("SELECT COUNT(*) FROM events").fetchone()[0];receipts = sum(receipt_counts.values())
            stages = seq - receipt_counts.get(self.master_id, 0)
            require(total < MAX_TOTAL_EVENTS and total - receipts < MAX_TOTAL_STAGE_EVENTS and stages < MAX_STAGE_EVENTS,
                    "global event capacity or master stage capacity; migrate explicitly")
            conn.execute("INSERT INTO events VALUES (?,?,?,?,?,?,?)", (self.master_id, seq + 1, relative_path, raw, artifact, entry_sha, sig))
            conn.execute("UPDATE masters SET seq=?,last_sha=?,signature=? WHERE master_id=?", (seq + 1, entry_sha, self.signed_head(body, seq + 1, entry_sha), self.master_id))
            require(read_file(self.master / "owner.lock", 2000) == owner_raw, "owner changed before commit")
            # The surrounding transaction commits intent + checkpoint together.
            # Caller may create the directory/file only after this succeeds.
            return {"schema": "negi-master-inventory-result/1", "action": "append", "masterId": self.master_id,
                    "head": {"seq": seq + 1, "sha256": entry_sha}, "relativePath": relative_path, "artifactSha256": sha(artifact)}



    def recovery_context(self, value):
        require(type(value) is dict and set(value) == {"turnRoot", "schedulerPath"}
                and all(type(path) is str and os.path.isabs(path) and len(path.encode("utf-8")) <= 16000 for path in value.values()), "registered recovery context invalid")
        return {"turnRoot": value["turnRoot"], "schedulerPath": value["schedulerPath"]}

    def recovery_cwd(self, owner, operations):
        require(owner["kind"] == "thread-start", "indexed inspection/admission recovery is not connected")
        target = operations.get(owner["operation"]["requestId"])
        require(target and sha(encoded(target[0]["request"]) + b"\n") == owner["operation"]["hash"], "indexed recovery target differs")
        return target[0]["request"]["cwd"]

    def verify_recovery(self, context, owner_raw, proof, cwd, present):
        from negi_master_inventory_owner_recovery import verify_authority
        verify_authority(self.root, self.master_id, context, owner_raw.decode("utf-8"), proof, cwd, present)
    @storage_action
    def append_receipt(self, request):
        require(set(request) == {"action", "root", "masterId", "expectedHead", "ownerSha256", "bytes", "recoveryContext"}, "recovery intent input")
        context = self.recovery_context(request["recoveryContext"])
        expected = request["expectedHead"]
        require(type(expected) is dict and set(expected) == {"seq", "sha256"} and type(expected["seq"]) is int
                and 0 <= expected["seq"] < MAX_EVENTS and valid_sha(expected["sha256"])
                and valid_sha(request["ownerSha256"]) and type(request["bytes"]) is str, "recovery intent head/owner")
        artifact = request["bytes"].encode("utf-8")
        envelope = canonical(artifact, 8000)
        owner = envelope.get("payload", {}).get("owner", {})
        require(type(owner) is dict and valid_uuid(owner.get("owner")), "recovery intent owner")
        relative = "recoveries/" + owner["owner"] + ".json"
        owner_raw = encoded(owner) + b"\n"
        require(sha(owner_raw) == request["ownerSha256"], "recovery intent exact owner hash")
        from negi_master_inventory_owner_recovery import dead_owner, scheduler_guard
        with self.connection() as (conn, meta):
            checkpoint, paths, operations, missing = self.audited(conn, meta)
            payload = self.receipt(artifact, owner["owner"] + ".json")
            cwd = self.recovery_cwd(payload["owner"], operations)
            require(not missing, "previous intent is not materialized")
            body, seq, last = checkpoint
            require(expected == {"seq": seq, "sha256": last}, "recovery intent stale head")
            require(relative not in paths and all(row[1]["decisionId"] != payload["decisionId"] for row in self.receipt_artifacts.values()), "recovery owner/decision already indexed")
            require(absent(self.master / "owner-recovery.lock") and read_file(self.master / "owner.lock", 2000) == owner_raw, "recovery exact owner changed")
            dead_owner(self.master, owner_raw)
            self.verify_recovery(context, owner_raw, payload["proofSha256"], cwd, True)
        require(not self.scan(paths)[2], "storage changed before recovery intent")
        # Enter scheduler exclusion before the write transaction. Its native
        # handle remains open after connection.__exit__ commits the signed intent.
        with scheduler_guard(context["schedulerPath"]), self.connection(True) as (conn, meta):
            require(self.validated(conn, meta, integrity=False) == checkpoint
                    and read_file(self.master / "owner.lock", 2000) == owner_raw, "recovery owner/head changed")
            dead_owner(self.master, owner_raw)
            self.verify_recovery(context, owner_raw, payload["proofSha256"], cwd, True)
            counts = self.receipt_counts(conn)
            total = conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]
            require(total < MAX_TOTAL_EVENTS and seq < MAX_EVENTS and counts.get(self.master_id, 0) < MAX_RECEIPTS
                    and sum(counts.values()) < MAX_TOTAL_RECEIPTS, "recovery receipt capacity; preserve owner")
            event = {"schema": "negi-master-inventory-event/3", "masterId": self.master_id, "masterSha256": sha(body),
                     "seq": seq + 1, "previousSha256": last, "type": "receipt", "relativePath": relative,
                     "requestId": owner["operation"]["requestId"], "stage": None, "artifactSha256": sha(artifact), "ownerSha256": request["ownerSha256"], "contextSha256": sha(encoded(context))}
            raw = encoded(event);sig = signature(self.key, event["schema"], raw);entry_sha = sha(raw + b"\0" + sig.encode("ascii"))
            conn.execute("INSERT INTO events VALUES (?,?,?,?,?,?,?)", (self.master_id, seq + 1, relative, raw, artifact, entry_sha, sig))
            conn.execute("UPDATE masters SET seq=?,last_sha=?,signature=? WHERE master_id=?", (seq + 1, entry_sha, self.signed_head(body, seq + 1, entry_sha), self.master_id))
            require(read_file(self.master / "owner.lock", 2000) == owner_raw, "owner changed before recovery intent commit")
            return {"schema": "negi-master-inventory-result/1", "action": "appendRecoveryIntent", "masterId": self.master_id,
                    "head": {"seq": seq + 1, "sha256": entry_sha}, "relativePath": relative, "artifactSha256": sha(artifact)}

    def selected_recovery(self, decision_id, live_only=False):
        return next(((path, raw, payload, context_sha) for path, (raw, payload, imported, context_sha) in self.receipt_artifacts.items()
                     if (not live_only or not imported) and payload["decisionId"] == decision_id), None)

    @storage_action
    def recovery_intent(self, request):
        require(set(request) == {"action", "root", "masterId", "decisionId"} and valid_uuid(request["decisionId"]), "recovery intent lookup input")
        with self.connection() as (conn, meta):
            checkpoint, paths, _, missing = self.audited(conn, meta)
            selected = self.selected_recovery(request["decisionId"])
            receipt = {"relativePath": selected[0], "bytes": selected[1].decode("utf-8"), "artifactSha256": sha(selected[1])} if selected else None
            result = self.result(checkpoint, paths, missing)
            result.update(action="recoveryIntent", decisionId=request["decisionId"], receipt=receipt)
            return result

    @storage_action
    def release_recovery(self, request):
        require(set(request) == {"action", "root", "masterId", "decisionId", "expectedProofSha256", "recoveryContext"}
                and valid_uuid(request["decisionId"]) and valid_sha(request["expectedProofSha256"]), "indexed recovery release input")
        context = self.recovery_context(request["recoveryContext"])
        with self.connection() as (conn, meta):
            checkpoint, paths, operations, missing = self.audited(conn, meta)
            selected = self.selected_recovery(request["decisionId"], live_only=True)
            require(selected and selected[2]["proofSha256"] == request["expectedProofSha256"], "indexed recovery decision/proof absent")
            relative, raw, payload, context_sha = selected
            require(context_sha == sha(encoded(context)), "registered recovery context changed")
            cwd = self.recovery_cwd(payload["owner"], operations)
            require(missing in ([], [relative]), "other indexed artifacts missing; preserve owner")
        owner_raw = encoded(payload["owner"]) + b"\n"
        owner_path = self.master / "owner.lock"
        require(absent(self.master / "owner-recovery.lock"), "legacy recovery guard present")
        def check(phase):
            with self.connection() as (conn, meta):
                current, current_paths, _, gaps = self.audited(conn, meta)
                require(current == checkpoint and self.selected_recovery(request["decisionId"]) == selected
                        and (not gaps if phase == "published" else gaps in ([], [relative])), "indexed recovery evidence changed")
                require(read_file(owner_path, 2000) == owner_raw, "indexed recovery owner replaced")
            self.verify_recovery(context, owner_raw, payload["proofSha256"], cwd, True)
        from negi_master_inventory_owner_recovery import release_windows, scheduler_guard
        historical = absent(owner_path)
        # A historical ACK reads its saved receipt; a current release excludes
        # scheduler writers until post-delete proof and final audit have finished.
        with nullcontext() if historical else scheduler_guard(context["schedulerPath"]):
            if historical:
                require(not missing and read_file(self.master / relative, 8000) == raw, "absent owner has no exact published receipt")
            else:
                release_windows(self.master, owner_raw, raw.decode("utf-8"), check)
                self.verify_recovery(context, owner_raw, payload["proofSha256"], cwd, False)
            require(absent(owner_path), "new owner appeared after indexed recovery")
            with self.connection() as (conn, meta):
                current, paths, _, missing = self.audited(conn, meta)
                require(current == checkpoint and not missing and self.selected_recovery(request["decisionId"]) == selected, "indexed recovery not materialized")
                require(absent(owner_path), "new owner appeared during final recovery audit")
                result = self.result(current, paths, missing)
                result.update(action="releaseRecovery", decisionId=request["decisionId"], requestId=payload["owner"]["operation"]["requestId"], ownerReleased=True, operationComplete=False)
                return result
    @storage_action
    def lookup(self, request):
        require(set(request) == {"action", "root", "masterId", "relativePath"} and type(request["relativePath"]) is str, "lookup input fields")
        with self.connection() as (conn, meta):
            checkpoint, paths, _, missing = self.audited(conn, meta)
            require(request["relativePath"] in paths, "unindexed artifact lookup")
            row = conn.execute("SELECT artifact FROM events WHERE master_id=? AND path=?", (self.master_id, request["relativePath"])).fetchone()
            result = self.result(checkpoint, paths, missing)
            result.update(action="lookup", relativePath=request["relativePath"], bytes=row[0].decode("utf-8"), artifactSha256=sha(row[0]))
            return result

    @storage_action
    def latest_stage(self, request):
        require(set(request) == {"action", "root", "masterId", "requestId"} and valid_uuid(request["requestId"]), "latest stage input")
        with self.connection() as (conn, meta):
            checkpoint, paths, operations, missing = self.audited(conn, meta)
            operation = operations.get(request["requestId"])
            latest = None
            if operation:
                payload, expected_sha, count = operation
                path = f"{request['requestId']}/0{count - 1}-{payload['stage']}.json"
                require(path in paths, "latest stage not indexed")
                raw = conn.execute("SELECT artifact FROM events WHERE master_id=? AND path=?", (self.master_id, path)).fetchone()[0]
                require(sha(raw) == expected_sha == paths[path]["sha256"], "latest stage bytes changed")
                latest = {"relativePath": path, "bytes": raw.decode("utf-8"), "artifactSha256": expected_sha}
            result = self.result(checkpoint, paths, missing)
            result.update(action="latestStage", requestId=request["requestId"], latest=latest)
            return result


def main():
    raw = sys.stdin.buffer.read(100001)
    require(0 < len(raw) <= 100000, "input size")
    request = json.loads(raw, object_pairs_hook=unique)
    require(type(request) is dict and {"action", "root", "masterId"} <= set(request), "input shape")
    inventory = Inventory(request["root"], request["masterId"])
    ticket = request.pop("storageTicket", None)
    action = request["action"]
    if action == "processIdentity":
        require(set(request) == {"action", "root", "masterId"}, "input fields")
        result = {"schema": "negi-master-inventory-result/1", "action": action, "masterId": inventory.master_id, "processIdentity": process_identity()}
    else:
        with storage_guard(inventory.root, ticket, create=action not in ("audit", "lookup", "latestStage", "appendRecoveryIntent", "recoveryIntent", "releaseRecovery", "previewMigration", "previewDatabaseRecovery", "recoverDatabase")):
            if action in ("initialize", "register", "audit"):
                require(set(request) == {"action", "root", "masterId"}, "input fields")
                result = getattr(inventory, action)()
            elif action == "append":result = inventory.append(request)
            elif action == "lookup":result = inventory.lookup(request)
            elif action == "latestStage":result = inventory.latest_stage(request)
            elif action == "appendRecoveryIntent":result = inventory.append_receipt(request)
            elif action == "recoveryIntent":result = inventory.recovery_intent(request)
            elif action == "releaseRecovery":result = inventory.release_recovery(request)
            elif action == "previewMigration":
                require(set(request) == {"action", "root", "masterId"}, "migration preview fields")
                result = inventory.preview_migration()
            elif action == "migrate":result = inventory.migrate(request)
            elif action in ("previewDatabaseRecovery", "recoverDatabase"):
                from negi_master_inventory_recovery import DatabaseRecovery
                recovery = DatabaseRecovery(inventory)
                if action == "previewDatabaseRecovery":
                    require(set(request) == {"action", "root", "masterId"}, "database recovery preview fields")
                    result = recovery.preview()
                else:result = recovery.recover(request)
            else:raise ValueError("Master inventory: unsupported action")
    sys.stdout.buffer.write(encoded(result) + b"\n")


if __name__ == "__main__":
    try:main()
    except Exception as error:
        # Avoid printing payloads, keys, traceback or child environment.
        sys.stderr.write(str(error)[:300] + "\n")
        sys.exit(1)
