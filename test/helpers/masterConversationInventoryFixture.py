"""Synthetic signed index/tree builder for audit measurements, NOT a product writer.

Builds fixed fixture stages in one transaction. It deliberately bypasses the live
append API, so it proves full-read audit cost only, never append throughput or RPC.
"""
import json
import os
from pathlib import Path
import sys
import uuid
import hmac
import hashlib

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
from negi_master_conversation_inventory import Inventory, encoded, sha, signature, require

request = json.load(sys.stdin)
root = Path(request["root"])
require(root.parent.name.startswith("negi-inventory-") and 0 < request["count"] <= 10000, "fixture-only root/count")
inventory = Inventory(str(root), request["masterId"])
with inventory.connection(True) as (conn, meta):
    body, seq, last = inventory.validated(conn, meta)
    require(seq == 0, "fixture requires empty index")
    master = inventory.master
    for _ in range(request["count"]):
        identifier = str(uuid.uuid4())
        operation = master / identifier
        operation.mkdir()
        pinned = {"requestId": identifier, "masterId": inventory.master_id, "mode": "rotate", "oldThreadId": "old",
                  "cwd": str(root.parent / "checkout"), "model": "fixture-astra", "effort": "low", "provider": "fixture", "settingsSha256": "a" * 64}
        previous = None
        for index, stage in enumerate(["requested", "old_idle", "start_dispatched", "bound", "completed"]):
            thread = {"threadId": "fixture-" + identifier, "requestedModel": "fixture-astra", "resolvedModel": "fixture-astra", "modelProvider": "fixture", "rerouted": False}
            payload = {"schemaVersion": "negi-master-conversation/1", "request": pinned, "stage": stage, "previousSha256": sha(previous) if previous else None,
                       "identity": thread if index >= 3 else None, "reason": None, "at": "2026-10-02T00:00:00.000Z"}
            artifact = encoded({"payload": payload, "signature": hmac.new(inventory.key, encoded(payload), hashlib.sha256).hexdigest()}) + b"\n"
            relative = identifier + f"/0{index}-{stage}.json"
            seq += 1
            event = {"schema": "negi-master-inventory-event/1", "masterId": inventory.master_id, "masterSha256": sha(body), "seq": seq,
                     "previousSha256": last, "type": "stage", "relativePath": relative, "requestId": identifier, "stage": stage,
                     "artifactSha256": sha(artifact), "ownerSha256": "b" * 64}
            raw = encoded(event)
            signed = signature(inventory.key, "negi-master-inventory-event/1", raw)
            last = sha(raw + b"\0" + signed.encode("ascii"))
            conn.execute("INSERT INTO events VALUES (?,?,?,?,?,?,?)", (inventory.master_id, seq, relative, raw, artifact, last, signed))
            with (master / relative).open("xb") as stream:stream.write(artifact)
            previous = artifact
    conn.execute("UPDATE masters SET seq=?,last_sha=?,signature=? WHERE master_id=?", (seq, last, inventory.signed_head(body, seq, last), inventory.master_id))
print(json.dumps({"operations": request["count"], "stages": request["count"] * 5}))
