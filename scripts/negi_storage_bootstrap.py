"""Explicit first authority publication. Never adopt a foreign/partial source.

The signed intent and scheduler fence precede either target directory. Exact
native directory/key identities survive lost replies; the same decision may
finish publication. No database, provider, replay, overwrite or cleanup.
"""
import ctypes
from ctypes import wintypes
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import sys
import uuid
from negi_master_conversation_inventory import (absent, canonical, catalog, encoded,
    fingerprint, identity, normal, read_file, require, sha, signature, unique,
    valid_sha, valid_uuid)
from negi_master_storage_guard import root_path, storage_guard
from negi_recover_writer import windows_parent, windows_extended, windows_kernel, win_bytes

SCHEMA = "negi-storage-bootstrap/1"
LIMIT = 32000
INPUT_LIMIT = 24000
MASTER = re.compile(r"[a-zA-Z0-9_-]{1,100}")


def marker_paths(root, scheduler):
    return Path(str(root) + ".bootstrap-v1.json"), Path(str(scheduler) + ".negi-storage-bootstrap.json")


def write_new(path, data):
    require(len(data) <= LIMIT, "bootstrap file capacity")
    kernel = windows_kernel()
    handle = kernel.CreateFileW(windows_extended(path), 0xc0000000, 0, None, 1, 0x80200000, None)
    require(handle != ctypes.c_void_p(-1).value, "bootstrap create unavailable; preserve existing file")
    try:
        count = wintypes.DWORD();buffer = ctypes.create_string_buffer(data)
        require(kernel.WriteFile(handle, buffer, len(data), ctypes.byref(count), None) and count.value == len(data), "bootstrap incomplete write")
        require(kernel.FlushFileBuffers(handle) and win_bytes(kernel, handle, LIMIT) == data, "bootstrap flush/readback failed")
    finally:kernel.CloseHandle(handle)


def move(source, target):
    # WRITE_THROUGH only. Never REPLACE_EXISTING/COPY_ALLOWED or a fallback.
    require(windows_kernel().MoveFileExW(windows_extended(source), windows_extended(target), 0x8), "bootstrap publication failed; retain intent and source")


class Bootstrap:
    def __init__(self, registration):
        require(os.name == "nt", "native bootstrap requires Windows")
        require(type(registration) is dict and set(registration) == {"root", "turnRoot", "schedulerPath", "masterId"}, "bootstrap registration fields")
        require(type(registration["masterId"]) is str and MASTER.fullmatch(registration["masterId"]), "bootstrap Master ID")
        self.root = root_path(registration["root"])
        self.turns = root_path(registration["turnRoot"])
        scheduler = registration["schedulerPath"]
        require(type(scheduler) is str and os.path.isabs(scheduler) and len(scheduler) < 32000, "bootstrap scheduler path")
        self.scheduler = Path(scheduler)
        require(str(self.scheduler.parent.resolve(strict=True)) == str(self.scheduler.parent) and
                self.scheduler.name == self.scheduler.name.rstrip(" .") and not any(c in self.scheduler.name for c in '<>:"|?*'), "bootstrap scheduler alias")
        # Inspect the current leaf in scheduler_state for initial/partial work.
        # Historical ACK only depends on the signed preparation and its parents.
        require(str(self.root) == registration["root"] and str(self.turns) == registration["turnRoot"] and str(self.scheduler) == registration["schedulerPath"], "bootstrap canonical registration")
        require(self.turns.parent == self.root.parent and self.turns != self.root and self.scheduler not in (self.root, self.turns) and
                self.root not in self.scheduler.parents and self.turns not in self.scheduler.parents, "bootstrap namespace overlap")
        self.registration = registration
        self.intent, self.fence = marker_paths(self.root, self.scheduler)
        self.pending = Path(str(self.intent) + ".pending")
        self.fence_pending = Path(str(self.fence) + ".pending")
        # Every persistent allocation must have its own Windows namespace.
        # In particular, a configured scheduler must not be a guard/intent/DB.
        stage = str(self.root) + ".inventory.sqlite3"
        runtime = str(self.scheduler) + ".negi-runtime.sqlite3"
        # The bundled SQLite Windows VFS cannot open extended-length DB paths.
        # Refuse before preparing a key that its next registration cannot use.
        require(all(len((path + "-journal").encode("utf-16-le")) // 2 < 260 for path in (stage, runtime)),
                "bootstrap Windows SQLite path capacity")
        allocations = [self.root, self.turns, self.scheduler, Path(str(self.scheduler) + ".lock"),
                       Path(str(self.root) + ".storage-guard-v1.lock"), self.intent, self.pending, self.fence, self.fence_pending]
        allocations += [Path(stage + suffix) for suffix in ("", "-journal", "-wal", "-shm", ".recoveries", ".recoveries.pending")]
        allocations += [Path(runtime + suffix) for suffix in ("", "-journal", "-wal", "-shm")]
        allocations.append(Path(str(self.scheduler) + ".negi-runtime-registration.json"))
        normalized = [Path(os.path.normcase(str(path))) for path in allocations]
        for n, left in enumerate(normalized):
            for right in normalized[n + 1:]:
                require(left != right and left not in right.parents and right not in left.parents, "bootstrap storage namespace collision")

    def parent_state(self):
        return {"parent": identity(normal(self.root.parent, True)),
                "schedulerParent": identity(normal(self.scheduler.parent, True))}

    def scheduler_state(self):
        if absent(self.scheduler):return {"stamp": None, "sha256": sha(b"")}
        before = fingerprint(normal(self.scheduler));data = read_file(self.scheduler, 64000000)
        require(before == fingerprint(normal(self.scheduler)), "bootstrap scheduler changed")
        require(not data or data.endswith(b"\n"), "bootstrap scheduler partial tail")
        keys = set()
        for line in data.splitlines():
            if not line:continue
            value = json.loads(line, object_pairs_hook=unique)
            require(type(value) is dict and type(value.get("key")) is str and value["key"] not in keys,
                    "bootstrap scheduler invalid/duplicate key")
            keys.add(value["key"])
        return {"stamp": before, "sha256": sha(data)}

    def indexes_absent(self):
        stage = str(self.root) + ".inventory.sqlite3"
        runtime = str(self.scheduler) + ".negi-runtime.sqlite3"
        paths = [stage + s for s in ("", "-journal", "-wal", "-shm", ".recoveries", ".recoveries.pending")]
        paths += [runtime + s for s in ("", "-journal", "-wal", "-shm")]
        paths.append(str(self.scheduler) + ".negi-runtime-registration.json")
        require(all(absent(Path(p)) for p in paths), "bootstrap index survives; do not replace authority")

    def initial(self):
        require(all(absent(p) for p in (self.root, self.turns, self.intent, self.pending, self.fence, self.fence_pending)), "bootstrap already/partially published; retain original ID")
        self.indexes_absent()
        value = {"schema": SCHEMA, "registration": self.registration, **self.parent_state(), "scheduler": self.scheduler_state()}
        # Check the complete apply request and a conservative signed envelope
        # before preview succeeds or a guard/key/source can be created. Windows
        # native identities are at most 64-bit; reserve 128 digits per component.
        decision = "00000000-0000-4000-8000-000000000000";digest = "f" * 64
        require(len(encoded({"action": "apply", "registration": self.registration, "decisionId": decision,
                             "expectedProofSha256": digest})) + 1 <= INPUT_LIMIT, "bootstrap apply input capacity")
        reserved = {**value, "decisionId": decision, "proofSha256": digest,
                    "seed": ".negi-storage-seed-" + decision + "-" + decision, "keySha256": digest}
        reserved.update({name: ["9" * 128, "9" * 128] for name in ("authority", "turns", "masters", "master", "keyIdentity")})
        require(len(encoded({"payload": reserved, "signature": digest})) + 1 <= LIMIT, "bootstrap signed file capacity")
        from negi_runtime_inventory import MAX_REGISTRATION
        runtime = {"schema": "negi-runtime-registration/1", "decisionId": decision,
                   "binding": {"authoritySha256": digest, "context": {
                       "turnRoot": self.registration["turnRoot"], "schedulerPath": self.registration["schedulerPath"],
                       "turnIdentity": reserved["turns"], "schedulerParentIdentity": ["9" * 128, "9" * 128]}},
                   "proofSha256": digest, "schedulerSha256": digest, "schedulerBytes": 64000000,
                   "schedulerPresent": True, "artifactCount": 50000}
        require(len(encoded(runtime)) <= MAX_REGISTRATION, "bootstrap runtime registration capacity")
        return value

    def preview(self):
        with windows_parent(self.root.parent), windows_parent(self.scheduler.parent):
            if not absent(self.intent) or not absent(self.pending):
                _, value = self.read_intent(None, None)
                complete = self.locations(value) == [self.root, self.turns]
                if complete:self.ready(read_file(self.intent, LIMIT))
                return self.preview_result(value, complete)
            first = self.initial();require(first == self.initial(), "bootstrap preview changed")
            return self.preview_result({**first, "proofSha256": sha(encoded(first)), "decisionId": str(uuid.uuid4())}, False)

    def preview_result(self, value, complete):
        scheduler = value["scheduler"]
        return {"proofSha256": value["proofSha256"], "decisionId": value["decisionId"], "masterCount": 1, "createsAuthority": True,
                "schedulerSha256": scheduler["sha256"], "schedulerBytes": 0 if scheduler["stamp"] is None else int(scheduler["stamp"][2]),
                "schedulerPresent": scheduler["stamp"] is not None, "publicationComplete": complete}

    def status(self):
        if not absent(self.intent) or not absent(self.pending):
            raw, value = self.read_intent(None, None)
            if self.locations(value) == [self.root, self.turns]:
                self.ready(raw);return {"state": "ready"}
            return {"state": "pending"}
        if not absent(self.root):
            require(absent(self.fence) and absent(self.fence_pending) and not absent(self.root / "signing-key.json"), "bootstrap authority incomplete")
            return {"state": "existing"}
        self.initial();return {"state": "available"}

    def source_paths(self, value):
        token = value.get("seed")
        prefix = ".negi-storage-seed-" + value["decisionId"] + "-"
        require(type(token) is str and token.startswith(prefix) and valid_uuid(token[len(prefix):]), "bootstrap source name")
        return self.root.parent / (token + ".authority"), self.root.parent / (token + ".turns")

    def locations(self, value):
        authority, turns = self.source_paths(value)
        selected = []
        for source, target in ((authority, self.root), (turns, self.turns)):
            require(absent(source) != absent(target), "bootstrap requires exactly its original source or target")
            selected.append(source if not absent(source) else target)
        return selected

    def tree(self, value, partial=False):
        authority, turns = self.locations(value)
        require(identity(normal(authority, True)) == value["authority"] and identity(normal(turns, True)) == value["turns"], "bootstrap directory identity changed")
        require(catalog(authority) == ["masters", "signing-key.json"], "bootstrap authority entries changed")
        masters = authority / "masters";master = masters / self.registration["masterId"]
        require(identity(normal(masters, True)) == value["masters"] and identity(normal(master, True)) == value["master"], "bootstrap Master directory changed")
        key_path = authority / "signing-key.json";key_raw = read_file(key_path, 1000);key = canonical(key_raw, 1000)
        require(set(key) == {"schemaVersion", "key"} and key["schemaVersion"] == "negi-master-conversation-key/1" and valid_sha(key["key"]), "bootstrap key format")
        require(identity(normal(key_path)) == value["keyIdentity"] and sha(key_raw) == value["keySha256"], "bootstrap key identity changed; never re-key")
        if partial:
            require(catalog(masters) == [self.registration["masterId"]] and catalog(master) == [] and catalog(turns) == [], "bootstrap source no longer empty")
        return bytes.fromhex(key["key"])

    def accepted(self, raw, decision=None, proof=None):
        envelope = canonical(raw, LIMIT)
        require(set(envelope) == {"payload", "signature"}, "bootstrap envelope fields")
        value = envelope["payload"]
        fields = {"schema", "registration", "decisionId", "proofSha256", "parent", "schedulerParent", "scheduler", "seed", "authority", "turns", "masters", "master", "keyIdentity", "keySha256"}
        require(type(value) is dict and set(value) == fields and value["schema"] == SCHEMA and value["registration"] == self.registration and
                valid_uuid(value["decisionId"]) and valid_sha(value["proofSha256"]) and valid_sha(value["keySha256"]) and valid_sha(envelope["signature"]), "bootstrap signed registration fields")
        require((decision is None or decision == value["decisionId"]) and (proof is None or proof == value["proofSha256"]), "bootstrap original decision/proof differs")
        require({"parent": value["parent"], "schedulerParent": value["schedulerParent"]} == self.parent_state(), "bootstrap parent identity changed")
        key = self.tree(value)
        require(hmac.compare_digest(envelope["signature"], signature(key, SCHEMA, encoded(value))), "bootstrap intent HMAC changed")
        return value

    def read_intent(self, decision, proof):
        require(not (not absent(self.intent) and not absent(self.pending)), "bootstrap ambiguous intent names")
        path = self.intent if not absent(self.intent) else self.pending
        raw = read_file(path, LIMIT);return raw, self.accepted(raw, decision, proof)

    def publish_record(self, final, pending, raw):
        if not absent(final):
            require(absent(pending) and read_file(final, LIMIT) == raw, "bootstrap published record differs")
            return
        if not absent(pending):require(read_file(pending, LIMIT) == raw, "bootstrap staged record differs")
        else:write_new(pending, raw)
        move(pending, final)
        require(read_file(final, LIMIT) == raw, "bootstrap published record changed")

    def ready(self, raw):
        value = self.accepted(raw)
        require(absent(self.pending) and absent(self.fence_pending) and not absent(self.intent) and
                read_file(self.intent, LIMIT) == read_file(self.fence, LIMIT) == raw and
                self.locations(value) == [self.root, self.turns], "bootstrap publication incomplete; retain original ID")
        return value

    def apply(self, decision, proof):
        require(valid_uuid(decision) and valid_sha(proof), "bootstrap explicit decision/proof")
        # Reject fabricated proof/ID before even creating a guard or leaf lock.
        existing = not absent(self.intent) or not absent(self.pending)
        if existing:self.read_intent(decision, proof)
        else:require(self.preview()["proofSha256"] == proof, "bootstrap preview proof changed")
        from negi_master_inventory_owner_recovery import scheduler_guard
        with storage_guard(self.root, create=True), windows_parent(self.root.parent), windows_parent(self.scheduler.parent), scheduler_guard(self.scheduler):
            if not absent(self.intent) or not absent(self.pending):
                raw, value = self.read_intent(decision, proof)
            else:
                initial = self.initial();require(sha(encoded(initial)) == proof, "bootstrap preview changed before intent")
                seed = ".negi-storage-seed-" + decision + "-" + str(uuid.uuid4())
                authority = self.root.parent / (seed + ".authority");turns = self.root.parent / (seed + ".turns")
                # Before an intent, unclaimed random seeds are preserved. Never
                # adopt or remove an unknown directory left by a previous crash.
                authority.mkdir(mode=0o700);turns.mkdir(mode=0o700)
                key = secrets.token_bytes(32);key_raw = encoded({"schemaVersion": "negi-master-conversation-key/1", "key": key.hex()}) + b"\n"
                write_new(authority / "signing-key.json", key_raw)
                masters = authority / "masters";masters.mkdir();master = masters / self.registration["masterId"];master.mkdir()
                value = {**initial, "decisionId": decision, "proofSha256": proof, "seed": seed,
                         "authority": identity(normal(authority, True)), "turns": identity(normal(turns, True)),
                         "masters": identity(normal(masters, True)), "master": identity(normal(master, True)),
                         "keyIdentity": identity(normal(authority / "signing-key.json")), "keySha256": sha(key_raw)}
                raw = encoded({"payload": value, "signature": signature(key, SCHEMA, encoded(value))}) + b"\n"
                require(self.initial() == initial, "bootstrap baseline changed before intent")
                write_new(self.pending, raw)
            value = self.accepted(raw, decision, proof)
            complete = self.locations(value) == [self.root, self.turns]
            if not complete:
                self.indexes_absent();require(value["scheduler"] == self.scheduler_state(), "bootstrap scheduler changed before publication")
                self.tree(value, partial=True)
            self.publish_record(self.intent, self.pending, raw)
            self.publish_record(self.fence, self.fence_pending, raw)
            if not complete:
                authority, turns = self.locations(value)
                for source, target in ((authority, self.root), (turns, self.turns)):
                    self.accepted(raw, decision, proof)
                    if source != target:move(source, target)
                    self.accepted(raw, decision, proof)
            self.ready(raw)
            return {"decisionId": decision, "proofSha256": proof, "initialized": True}


def assert_bootstrap_ready(root, context=None):
    intent = Path(str(root) + ".bootstrap-v1.json");pending = Path(str(intent) + ".pending")
    require(absent(pending), "bootstrap intent needs its original decision")
    if context is not None:
        require(type(context) is dict and set(context) == {"turnRoot", "schedulerPath"} and
                all(type(path) is str and os.path.isabs(path) and str(Path(os.path.abspath(path))) == path for path in context.values()),
                "bootstrap trusted context invalid")
        _, fence = marker_paths(root, context["schedulerPath"])
        # A surviving scheduler receipt also identifies a new authority. Never
        # downgrade a missing root receipt or bind this scheduler to another root.
        if not absent(fence) or not absent(Path(str(fence) + ".pending")):
            require(not absent(intent), "bootstrap root receipt missing; preserve scheduler fence")
    if absent(intent):return None
    raw = read_file(intent, LIMIT);envelope = canonical(raw, LIMIT)
    require(type(envelope.get("payload")) is dict, "bootstrap registration missing")
    registration = envelope["payload"].get("registration")
    require(type(registration) is dict and registration.get("root") == str(root), "bootstrap root differs")
    if context is not None:
        require(context == {"turnRoot": registration.get("turnRoot"), "schedulerPath": registration.get("schedulerPath")}, "bootstrap runtime context differs")
    Bootstrap(registration).ready(raw)
    return sha(raw)


def main():
    import json
    raw = sys.stdin.buffer.read(INPUT_LIMIT + 1);require(0 < len(raw) <= INPUT_LIMIT, "bootstrap input capacity")
    request = json.loads(raw, object_pairs_hook=unique)
    require(type(request) is dict and request.get("action") in ("preview", "status", "apply"), "bootstrap action")
    action = request["action"]
    require(set(request) == ({"action", "registration"} if action != "apply" else {"action", "registration", "decisionId", "expectedProofSha256"}), "bootstrap fields")
    bootstrap = Bootstrap(request["registration"])
    result = bootstrap.preview() if action == "preview" else bootstrap.status() if action == "status" else bootstrap.apply(request["decisionId"], request["expectedProofSha256"])
    sys.stdout.buffer.write(encoded({"schema": "negi-storage-bootstrap-result/1", "action": action, **result}) + b"\n")


if __name__ == "__main__":
    try:main()
    except Exception as error:
        sys.stderr.write(str(error)[:300] + "\n");sys.exit(1)
