"""Fixed native leaf operation after an authenticated indexed receipt intent.

The legacy CLI stays DB-fenced. This module is called only by the inventory's
stdin protocol under the already-existing root guard, never by provider tools.
"""
import ctypes
from contextlib import contextmanager
import os
import json
from pathlib import Path
import subprocess
import negi_recover_writer as native


@contextmanager
def scheduler_guard(path):
    """Hold the same create-only leaf used by every FileScheduler writer.

    Acquire without waiting while the Master root guard is held, so an existing
    scheduler writer cannot create a lock-order deadlock. Never steal its file or
    create a missing parent. Delete-on-close removes only our native handle's leaf.
    """
    if os.name != "nt":raise ValueError("Indexed owner recovery requires Windows")
    scheduler = Path(path)
    with native.windows_parent(scheduler.parent) as (kernel, _):
        handle = kernel.CreateFileW(native.windows_extended(Path(str(scheduler) + ".lock")),
                                    0x80000000 | 0x40000000 | 0x10000, 0, None, 1,
                                    0x00200000 | 0x04000000, None)
        if handle == ctypes.c_void_p(-1).value:
            raise ValueError("Scheduler writer exclusion unavailable; preserve recovery state") from ctypes.WinError(ctypes.get_last_error())
        try:
            native.win_info(kernel, handle, limit=0)
            yield
        finally:
            if not kernel.CloseHandle(handle):raise ctypes.WinError(ctypes.get_last_error())


def verify_authority(root, master_id, context, owner_bytes, proof, cwd, present):
    script = Path(__file__).with_name("negi_verify_master_recovery.mjs")
    args = ["node"] + (["--import", "tsx"] if (script.parent.parent / "src/server/orchestration/masterConversations.ts").is_file() else []) + [str(script)]
    request = {"root": str(root), "masterId": master_id, "turnRoot": context["turnRoot"], "schedulerPath": context["schedulerPath"],
               "cwd": cwd, "ownerBytes": owner_bytes, "expectedProofSha256": proof, "ownerPresent": present}
    result = subprocess.run(args, input=json.dumps(request, ensure_ascii=False).encode("utf-8"), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if result.returncode != 0 or result.stdout.strip() != b'{"verified":true}':
        raise ValueError("Current Master recovery evidence held: " + result.stderr.decode("utf-8", errors="replace")[-500:])


def dead_owner(root, raw):
    if os.name != "nt":raise ValueError("Indexed owner recovery requires Windows")
    owner = json.loads(raw)
    operation = owner["operation"]
    pid = native.validate(raw, "master", operation["domain"], operation["requestId"], operation["hash"])
    with native.windows_parent(root) as (kernel, _):
        handle = native.win_open_reader(kernel, root / "owner.lock")
        if handle == ctypes.c_void_p(-1).value:raise ctypes.WinError(ctypes.get_last_error())
        try:
            native.win_info(kernel, handle, limit=2000)
            if native.win_bytes(kernel, handle, 2000) != raw:raise ValueError("Indexed owner changed")
            native.win_dead(kernel, pid, native.master_start_token(raw, "master"))
        finally:kernel.CloseHandle(handle)


def release_windows(root, owner_raw, receipt_text, check):
    if os.name != "nt":raise ValueError("Indexed owner recovery requires Windows")
    owner = json.loads(owner_raw)
    operation = owner["operation"]
    pid = native.validate(owner_raw, "master", operation["domain"], operation["requestId"], operation["hash"])
    with native.windows_guard(root, "master") as kernel:
        check("before")
        handle = kernel.CreateFileW(native.windows_extended(root / "owner.lock"), 0x80000000 | 0x10000, 3, None, 3, 0x00200000, None)
        if handle == ctypes.c_void_p(-1).value:raise ctypes.WinError(ctypes.get_last_error())
        try:
            native.win_info(kernel, handle, limit=2000)
            if native.win_bytes(kernel, handle, 2000) != owner_raw:raise ValueError("Exact indexed owner changed")
            token = native.master_start_token(owner_raw, "master")
            native.win_dead(kernel, pid, token)
            native._publish_receipt_windows(kernel, root, owner_raw, receipt_text, lambda: check("before"), require_prefix=True)
            check("published")
            if native.win_bytes(kernel, handle, 2000) != owner_raw:raise ValueError("Indexed owner changed before removal")
            native.win_dead(kernel, pid, token)
            disposition = ctypes.c_ubyte(1)
            if not kernel.SetFileInformationByHandle(handle, 4, ctypes.byref(disposition), 1):
                raise ctypes.WinError(ctypes.get_last_error())
        finally:kernel.CloseHandle(handle)
