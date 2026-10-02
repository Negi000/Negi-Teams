"""Explicit signed normal-turn/scheduler index. No provider, repair or replay.

Uses the existing signing authority and participating native storage scope.
Independent root-wide index: shared Task scheduler events are not attributed to
one Master's stage history. Registered raw bytes are evidence, not human approval.
"""
from contextlib import ExitStack, contextmanager
import hmac
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
from negi_master_conversation_inventory import (Inventory, absent, canonical, catalog,
    encoded, fingerprint, identity, no_sidecars, normal, read_file, require, sha,
    signature, unique, valid_sha, valid_uuid)
from negi_master_storage_guard import storage_guard

APPLICATION = 0x4E545231
SCHEMA = [
    "CREATE TABLE meta (id INTEGER PRIMARY KEY CHECK(id=1), body BLOB NOT NULL, signature TEXT NOT NULL, seq INTEGER NOT NULL, last_sha TEXT NOT NULL, head_signature TEXT NOT NULL)",
    "CREATE TABLE events (seq INTEGER PRIMARY KEY, body BLOB NOT NULL, data BLOB NOT NULL, entry_sha TEXT NOT NULL, signature TEXT NOT NULL)",
]
WORK = re.compile(r"master-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
FILES = {"request.json": 1000000, "dispatch.json": 8000, "provider.json": 8000,
         "outcome.json": 2000000, "not-sent.json": 8000}
MAX_LOG = 64000000
MAX_EVENTS = 100000
MAX_TURNS = 10000
MAX_DATABASE_BYTES = 1500000000
ZERO = "0" * 64


class RuntimeInventory:
    def __init__(self, request):
        self.authority = Inventory(request["root"], "runtime")
        self.root = self.authority.root
        context = request["context"]
        require(type(context) is dict and set(context) == {"turnRoot", "schedulerPath"}, "runtime registration fields")
        require(all(type(value) is str and os.path.isabs(value) and str(Path(os.path.abspath(value))) == value for value in context.values()), "runtime absolute canonical registration")
        self.context = context
        self.turns = Path(context["turnRoot"])
        self.scheduler = Path(context["schedulerPath"])
        require(self.turns != self.root and self.root not in self.turns.parents and self.turns not in self.root.parents and
                self.root not in self.scheduler.parents and self.turns not in self.scheduler.parents,
                "runtime storage namespaces overlap")
        self.db = Path(str(self.scheduler) + ".negi-runtime.sqlite3")
        self.registration = Path(str(self.scheduler) + ".negi-runtime-registration.json")

    @contextmanager
    def scope(self):
        with ExitStack() as stack:
            meta = stack.enter_context(self.authority.authority_guard())
            if os.name == "nt":
                from negi_recover_writer import windows_parent
                for path in (self.scheduler.parent, self.turns):stack.enter_context(windows_parent(path))
            context = {**self.context, "turnIdentity": identity(normal(self.turns, True)),
                       "schedulerParentIdentity": identity(normal(self.scheduler.parent, True))}
            self.binding = {"authoritySha256": sha(encoded(meta)), "context": context}
            yield
            require(context["turnIdentity"] == identity(normal(self.turns, True)) and
                    context["schedulerParentIdentity"] == identity(normal(self.scheduler.parent, True)), "runtime registered directory changed")

    def snapshot(self):
        before = identity(normal(self.turns, True))
        dirs = catalog(self.turns, MAX_TURNS)
        artifacts, stamps = {}, {}
        for work in dirs:
            require(WORK.fullmatch(work), "runtime unexpected turn directory")
            directory = self.turns / work
            stamp = identity(normal(directory, True));names = catalog(directory, 5)
            require("request.json" in names and all(name in FILES for name in names), "runtime partial/unrecognized turn directory")
            for name in names:
                path = directory / name;raw = read_file(path, FILES[name]);self.turn_path(work + "/" + name, raw)
                artifacts[work + "/" + name] = raw;stamps[work + "/" + name] = fingerprint(normal(path))
            require(stamp == identity(normal(directory, True)) and names == catalog(directory, 5), "runtime turn changed during scan")
            stamps[work + "/"] = stamp
        require(before == identity(normal(self.turns, True)) and dirs == catalog(self.turns, MAX_TURNS), "runtime turn inventory changed")
        raw = b"" if absent(self.scheduler) else read_file(self.scheduler, MAX_LOG)
        require(not raw or raw.endswith(b"\n"), "runtime scheduler partial tail")
        keys = set()
        for line in raw.splitlines():
            if not line:continue  # Preserve legacy JSONL whitespace/order in baseline bytes.
            value = json.loads(line, object_pairs_hook=unique)
            require(type(value) is dict and type(value.get("key")) is str and value["key"] not in keys, "runtime scheduler duplicate/invalid key")
            keys.add(value["key"])
        stamps["scheduler"] = None if absent(self.scheduler) else fingerprint(normal(self.scheduler))
        return raw, artifacts, stamps

    def preview_value(self, snapshot):
        scheduler, artifacts, stamps = snapshot
        rows = [{"path": path, "sha256": sha(raw), "size": len(raw)} for path, raw in sorted(artifacts.items())]
        proof = sha(encoded({**self.binding, "schedulerSha256": sha(scheduler), "schedulerBytes": len(scheduler),
                             "artifacts": rows, "stamps": stamps}))
        return {"proofSha256": proof, "schedulerSha256": sha(scheduler), "schedulerBytes": len(scheduler), "schedulerPresent": stamps["scheduler"] is not None, "artifactCount": len(rows)}

    def preview(self):
        require(absent(self.db) and absent(self.registration), "runtime already/partially registered; preserve original decision")
        no_sidecars(self.db)
        first = self.snapshot();second = self.snapshot()
        require(first == second, "runtime baseline changed")
        return self.preview_value(first)

    def signed_head(self, raw, seq, last):
        return signature(self.authority.key, "negi-runtime-head/1", encoded({"metaSha256": sha(raw), "seq": seq, "lastSha256": last}))

    @contextmanager
    def connection(self, writable=False):
        no_sidecars(self.db);pinned = normal(self.db)
        require(pinned.st_size <= MAX_DATABASE_BYTES, "runtime database size limit")
        with ExitStack() as stack:
            if os.name == "nt":
                import ctypes
                from negi_recover_writer import windows_kernel, windows_extended, win_info
                kernel = windows_kernel();handle = kernel.CreateFileW(windows_extended(self.db), 0x80000000, 3, None, 3, 0x00200000, None)
                require(handle != ctypes.c_void_p(-1).value, "runtime DB handle unavailable")
                stack.callback(kernel.CloseHandle, handle);win_info(kernel, handle, limit=MAX_DATABASE_BYTES)
            conn = sqlite3.connect(self.db.as_uri() + ("?mode=rw" if writable else "?mode=ro"), uri=True, timeout=0.1, isolation_level=None)
            try:
                conn.execute("PRAGMA trusted_schema=OFF")
                if writable:
                    require(conn.execute("PRAGMA journal_mode=DELETE").fetchone()[0] == "delete", "runtime DELETE journal unavailable")
                    conn.execute("PRAGMA synchronous=FULL")
                    page_size = conn.execute("PRAGMA page_size").fetchone()[0]
                    limit = MAX_DATABASE_BYTES // page_size
                    require(limit > 0 and conn.execute("PRAGMA max_page_count=" + str(limit)).fetchone()[0] == limit, "runtime database page capacity")
                conn.execute("BEGIN IMMEDIATE" if writable else "BEGIN")
                yield conn
                require(conn.execute("PRAGMA page_count").fetchone()[0] * conn.execute("PRAGMA page_size").fetchone()[0] <= MAX_DATABASE_BYTES,
                        "runtime database capacity before commit")
                conn.execute("COMMIT")
            except BaseException:
                if conn.in_transaction:conn.execute("ROLLBACK")
                raise
            finally:conn.close()
            require(identity(pinned) == identity(normal(self.db)), "runtime DB replaced")
            require(normal(self.db).st_size <= MAX_DATABASE_BYTES, "runtime database capacity after commit; preserve outcome")
            no_sidecars(self.db)

    def validated(self, conn):
        require(conn.execute("PRAGMA application_id").fetchone()[0] == APPLICATION and conn.execute("PRAGMA user_version").fetchone()[0] == 1, "runtime DB version/application")
        with sqlite3.connect(":memory:") as reference:
            for sql in SCHEMA:reference.execute(sql)
            sql = "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name"
            require(conn.execute(sql).fetchall() == reference.execute(sql).fetchall(), "runtime DB schema")
        require(conn.execute("PRAGMA quick_check").fetchall() == [("ok",)], "runtime DB integrity")
        rows = conn.execute("SELECT id,body,signature,seq,last_sha,head_signature FROM meta").fetchall()
        require(len(rows) == 1 and rows[0][0] == 1, "runtime DB metadata")
        _, raw, sig, seq, last, head_sig = rows[0]
        require(type(raw) is bytes and len(raw) <= 8000 and valid_sha(sig) and valid_sha(last) and valid_sha(head_sig) and
                type(seq) is int and 1 <= seq <= MAX_EVENTS and hmac.compare_digest(sig, signature(self.authority.key, "negi-runtime-registration/1", raw)) and
                hmac.compare_digest(head_sig, self.signed_head(raw, seq, last)), "runtime metadata/head signature")
        meta = json.loads(raw, object_pairs_hook=unique)
        require(encoded(meta) == raw and set(meta) == {"schema", "binding", "decisionId", "proofSha256", "schedulerSha256", "schedulerBytes", "schedulerPresent", "artifactCount"} and
                meta["schema"] == "negi-runtime-registration/1" and meta["binding"] == self.binding and valid_uuid(meta["decisionId"]) and valid_sha(meta["proofSha256"]) and
                valid_sha(meta["schedulerSha256"]) and type(meta["schedulerPresent"]) is bool and type(meta["schedulerBytes"]) is int and 0 <= meta["schedulerBytes"] <= MAX_LOG and
                type(meta["artifactCount"]) is int and 0 <= meta["artifactCount"] <= 50000, "runtime fixed registration mismatch")
        marker = canonical(read_file(self.registration, 10000), 10000)
        require(marker == {"payload": meta, "signature": sig}, "runtime registration marker changed")
        return raw, meta, seq, last

    def indexed(self, conn):
        raw, meta, seq, last = self.validated(conn)
        scheduler, artifacts, chain = b"", {}, ZERO
        keys = set();count = 0;baseline_artifacts = 0
        for n, body, data, digest, sig in conn.execute("SELECT seq,body,data,entry_sha,signature FROM events ORDER BY seq"):
            count += 1
            require(count == n and count <= MAX_EVENTS and type(body) is bytes and len(body) <= 2000 and type(data) is bytes and
                    len(data) <= (MAX_LOG if n == 1 else 2000000) and valid_sha(digest) and valid_sha(sig), "runtime event shape/sequence")
            event = json.loads(body, object_pairs_hook=unique)
            require(encoded(event) == body and set(event) == {"schema", "seq", "previousSha256", "metaSha256", "kind", "path", "dataSha256", "previousBytes", "previousSha"} and
                    event["schema"] == "negi-runtime-event/1" and event["seq"] == n and event["previousSha256"] == chain and
                    event["metaSha256"] == sha(raw) and event["dataSha256"] == sha(data) and
                    hmac.compare_digest(sig, signature(self.authority.key, "negi-runtime-event/1", body)) and digest == sha(body + b"\0" + sig.encode("ascii")), "runtime event authentication")
            kind, path = event["kind"], event["path"]
            if n == 1:
                require(kind == "scheduler-baseline" and path == "scheduler" and event["previousBytes"] == 0 and event["previousSha"] == sha(b"") and
                        sha(data) == meta["schedulerSha256"] and len(data) == meta["schedulerBytes"], "runtime scheduler baseline")
                scheduler = data
            elif kind == "scheduler":
                require(path == "scheduler" and event["previousBytes"] == len(scheduler) and event["previousSha"] == sha(scheduler), "runtime scheduler predecessor")
                item = canonical(data, 1000000)
                require(type(item.get("key")) is str and item["key"] not in keys, "runtime scheduler idempotency key")
                scheduler += data
            else:
                require(kind in ("turn-baseline", "turn") and event["previousBytes"] == 0 and event["previousSha"] == sha(b"") and path not in artifacts, "runtime turn event")
                self.turn_path(path, data)
                if kind == "turn-baseline":
                    require(n <= 1 + meta["artifactCount"], "runtime baseline after live publication")
                    baseline_artifacts += 1
                else:require(n > 1 + meta["artifactCount"], "runtime live intent within baseline")
                artifacts[path] = data
            if kind in ("scheduler-baseline", "scheduler"):
                for line in data.splitlines():
                    if not line:continue
                    item = json.loads(line, object_pairs_hook=unique)
                    require(type(item) is dict and type(item.get("key")) is str and item["key"] not in keys, "runtime scheduler key reused")
                    keys.add(item["key"])
            chain = digest
        require(count == seq and chain == last and baseline_artifacts == meta["artifactCount"] and len(scheduler) <= MAX_LOG, "runtime signed tail/baseline differs")
        return raw, meta, seq, last, scheduler, artifacts

    def turn_path(self, path, data):
        require(type(path) is str and path.count("/") == 1, "runtime turn path")
        work, name = path.split("/")
        require(WORK.fullmatch(work) and name in FILES, "runtime turn path/name")
        value = canonical(data, FILES[name])
        require(value.get("workId") == work, "runtime turn work identity")
        return work, name

    def audited(self, conn):
        state = self.indexed(conn);_, _, seq, last, scheduler, artifacts = state
        # Missing intent targets are pending; any replacement/extra/partial target holds.
        def scan():
            found, stamps, missing = {}, {}, []
            for work in catalog(self.turns, MAX_TURNS):
                require(WORK.fullmatch(work), "runtime unexpected turn directory")
                directory = self.turns / work;stamps[work + "/"] = identity(normal(directory, True))
                files = catalog(directory, 5)
                require(any(path.startswith(work + "/") for path in artifacts), "runtime unindexed turn directory")
                for name in files:
                    path = work + "/" + name
                    require(path in artifacts, "runtime unindexed turn artifact")
                    data = read_file(directory / name, FILES[name]);require(data == artifacts[path], "runtime turn artifact changed/partial")
                    found[path] = data;stamps[path] = fingerprint(normal(directory / name))
            missing.extend(sorted(set(artifacts) - set(found)))
            present = not absent(self.scheduler)
            physical = read_file(self.scheduler, MAX_LOG) if present else b""
            expected_present = state[1]["schedulerPresent"] or len(scheduler) > 0
            if not present and expected_present:missing.append("scheduler")
            elif present and not expected_present:raise ValueError("Runtime inventory: unindexed empty scheduler file")
            elif physical != scheduler:
                require(scheduler.startswith(physical), "runtime scheduler changed outside intent")
                missing.append("scheduler")
            stamps["scheduler"] = None if absent(self.scheduler) else fingerprint(normal(self.scheduler))
            return missing, stamps, physical
        before = scan();require(before == scan(), "runtime files changed during audit")
        return state, {"head": {"seq": seq, "sha256": last}, "state": "pending" if before[0] else "clean",
                       "missing": before[0], "artifactCount": len(artifacts), "schedulerSha256": sha(scheduler), "schedulerBytes": len(scheduler),
                       "schedulerPresent": state[1]["schedulerPresent"] or len(scheduler) > 0}

    def add(self, conn, raw, seq, last, kind, path, data, previous=b""):
        require(seq < MAX_EVENTS, "runtime event capacity; explicit retention required")
        body = encoded({"schema": "negi-runtime-event/1", "seq": seq + 1, "previousSha256": last, "metaSha256": sha(raw),
                        "kind": kind, "path": path, "dataSha256": sha(data), "previousBytes": len(previous), "previousSha": sha(previous)})
        sig = signature(self.authority.key, "negi-runtime-event/1", body);digest = sha(body + b"\0" + sig.encode("ascii"))
        conn.execute("INSERT INTO events VALUES (?,?,?,?,?)", (seq + 1, body, data, digest, sig))
        conn.execute("UPDATE meta SET seq=?,last_sha=?,head_signature=? WHERE id=1", (seq + 1, digest, self.signed_head(raw, seq + 1, digest)))
        return seq + 1, digest

    def adopt(self, request):
        require(valid_uuid(request["decisionId"]) and valid_sha(request["expectedProofSha256"]), "runtime explicit baseline decision/proof")
        if not absent(self.db):
            with self.connection() as conn:
                state, result = self.audited(conn);meta = state[1]
                require(meta["decisionId"] == request["decisionId"] and meta["proofSha256"] == request["expectedProofSha256"], "runtime baseline decision differs")
                return {**result, "decisionId": meta["decisionId"], "proofSha256": meta["proofSha256"]}
        require(absent(self.registration), "runtime partial bootstrap; preserve original registration")
        preview = self.preview();snapshot = self.snapshot()
        require(preview == self.preview_value(snapshot) and preview["proofSha256"] == request["expectedProofSha256"], "runtime baseline proof changed")
        require(1 + len(snapshot[1]) <= MAX_EVENTS and len(snapshot[0]) + sum(len(data) + 2200 for data in snapshot[1].values()) + 32768 <= MAX_DATABASE_BYTES,
                "runtime baseline capacity before registration")
        meta = {"schema": "negi-runtime-registration/1", "binding": self.binding, "decisionId": request["decisionId"], **preview}
        raw = encoded(meta);sig = signature(self.authority.key, "negi-runtime-registration/1", raw)
        require(len(raw) <= 8000, "runtime registration size limit")
        for path, data in ((self.registration, encoded({"payload": meta, "signature": sig}) + b"\n"), (self.db, b"")):
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                with os.fdopen(fd, "wb", closefd=False) as stream:stream.write(data);stream.flush();os.fsync(fd)
            finally:os.close(fd)
        if os.name != "nt":
            fd = os.open(self.scheduler.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:os.fsync(fd)
            finally:os.close(fd)
        with self.connection(True) as conn:
            conn.execute(f"PRAGMA application_id={APPLICATION}");conn.execute("PRAGMA user_version=1")
            for sql in SCHEMA:conn.execute(sql)
            conn.execute("INSERT INTO meta VALUES (1,?,?,0,?,?)", (raw, sig, ZERO, self.signed_head(raw, 0, ZERO)))
            seq, last = self.add(conn, raw, 0, ZERO, "scheduler-baseline", "scheduler", snapshot[0])
            for path, data in sorted(snapshot[1].items()):seq, last = self.add(conn, raw, seq, last, "turn-baseline", path, data)
            require(snapshot == self.snapshot(), "runtime baseline changed before commit")
            _, result = self.audited(conn)
        return {**result, "decisionId": meta["decisionId"], "proofSha256": meta["proofSha256"]}

    def audit(self, request):
        with self.connection() as conn:
            _, result = self.audited(conn)
            if "schedulerSha256" in request:
                require(request["schedulerSha256"] == result["schedulerSha256"] and request["schedulerBytes"] == result["schedulerBytes"], "runtime scheduler snapshot differs from index")
            return result

    def append(self, request, scheduler):
        require(type(request["bytes"]) is str and type(request["expectedHead"]) is dict and set(request["expectedHead"]) == {"seq", "sha256"} and
                type(request["expectedHead"]["seq"]) is int and 1 <= request["expectedHead"]["seq"] <= MAX_EVENTS and valid_sha(request["expectedHead"]["sha256"]), "runtime intent/head shape")
        data = request["bytes"].encode("utf-8")
        with self.connection(True) as conn:
            state, result = self.audited(conn);raw, _, seq, last, prior, artifacts = state
            require(result["state"] == "clean" and request["expectedHead"] == result["head"], "runtime pending/stale intent")
            if scheduler:
                canonical(data, 1000000)
                require(type(request["previousBytes"]) is int and request["previousSha256"] == sha(prior) and request["previousBytes"] == len(prior) and len(prior) + len(data) <= MAX_LOG, "runtime scheduler predecessor/limit")
                kind, path = "scheduler", "scheduler"
            else:
                path = request["relativePath"];work, name = self.turn_path(path, data)
                require(path not in artifacts and (name == "request.json" or work + "/request.json" in artifacts), "runtime turn duplicate/predecessor")
                require(name != "request.json" or len({path.split("/")[0] for path in artifacts}) < MAX_TURNS, "runtime turn directory capacity before intent")
                kind = "turn"
            seq, last = self.add(conn, raw, seq, last, kind, path, data, prior if scheduler else b"")
            # Validate the new signed row/chain before commit, without materializing.
            self.indexed(conn)
        return {"head": {"seq": seq, "sha256": last}, "dataSha256": sha(data)}


def main():
    raw = sys.stdin.buffer.read(8000001);require(0 < len(raw) <= 8000000, "runtime request size")
    request = json.loads(raw, object_pairs_hook=unique);require(type(request) is dict, "runtime input object")
    ticket = request.pop("storageTicket", None);action = request.get("action")
    fields = {"root", "context", "action"}
    extras = {"preview": set(), "adopt": {"decisionId", "expectedProofSha256"}, "audit": set(),
              "auditScheduler": {"schedulerSha256", "schedulerBytes"},
              "appendScheduler": {"expectedHead", "bytes", "previousSha256", "previousBytes"},
              "appendTurn": {"expectedHead", "bytes", "relativePath"}}
    require(action in extras and set(request) == fields | extras[action], "runtime request fields/action")
    inventory = RuntimeInventory(request)
    with storage_guard(inventory.root, ticket, create=False), inventory.scope():
        if action == "preview":result = inventory.preview()
        elif action == "adopt":
            # Exclude existing default FileScheduler writers before installing
            # the persistent fence. Never steal an existing leaf lock.
            from negi_master_inventory_owner_recovery import scheduler_guard
            with scheduler_guard(inventory.scheduler):result = inventory.adopt(request)
        elif action in ("audit", "auditScheduler"):result = inventory.audit(request)
        else:result = inventory.append(request, action == "appendScheduler")
    sys.stdout.buffer.write(encoded({"schema": "negi-runtime-result/1", "action": action, **result}) + b"\n")


if __name__ == "__main__":
    try:main()
    except Exception as error:
        sys.stderr.write(str(error)[:300] + "\n");sys.exit(1)
