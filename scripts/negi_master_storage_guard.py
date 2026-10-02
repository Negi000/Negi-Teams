"""Root-wide exclusion for participating Master storage writers on Windows.

Transferred file handles belong to the direct Node parent, not this helper.
The fixed empty sibling is persistent; never delete it to resolve contention.
"""
from contextlib import contextmanager
from contextvars import ContextVar
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import sys

# CLI and imported recovery must share one reentrancy context in this process.
if __name__ == "__main__":sys.modules["negi_master_storage_guard"] = sys.modules[__name__]

HELD = ContextVar("master_storage_guard", default=None)
SCHEMA = "negi-master-storage-guard/1"


class NotAcquired(ValueError):
    pass


def require(condition, reason):
    if not condition:raise ValueError("Master storage guard: " + reason)


def root_path(raw):
    require(isinstance(raw, str) and len(raw) < 32000, "root invalid")
    root = Path(raw)
    require(root.is_absolute() and root.name not in ("", ".", ".."), "absolute authority root required")
    require(root.name == root.name.rstrip(" .") and not any(value in root.name for value in '<>:"|?*'), "root name alias")
    require(str(root.parent.resolve(strict=True)) == str(root.parent), "parent alias")
    if os.path.lexists(root):
        from negi_recover_writer import regular
        regular(root.lstat(), True)
        require(str(root.resolve(strict=True)) == str(root), "root alias")
    return root


def native():
    require(os.name == "nt", "platform unsupported")
    from negi_recover_writer import windows_kernel
    kernel = windows_kernel()
    kernel.GetCurrentProcess.argtypes = [];kernel.GetCurrentProcess.restype = wintypes.HANDLE
    kernel.DuplicateHandle.argtypes = [wintypes.HANDLE, wintypes.HANDLE, wintypes.HANDLE, ctypes.POINTER(wintypes.HANDLE), wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.DuplicateHandle.restype = wintypes.BOOL
    kernel.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
    kernel.GetProcessTimes.restype = wintypes.BOOL
    return kernel


def parent(kernel):
    pid = os.getppid()
    handle = kernel.OpenProcess(0x00100000 | 0x1000 | 0x40, False, pid)
    require(bool(handle), "direct parent unavailable")
    try:
        require(kernel.WaitForSingleObject(handle, 0) == 258, "parent not live")
        times = [wintypes.FILETIME() for _ in range(4)]
        require(kernel.GetProcessTimes(handle, *(ctypes.byref(value) for value in times)), "parent creation unavailable")
        token = str(times[0].dwHighDateTime << 32 | times[0].dwLowDateTime)
        return handle, pid, token
    except BaseException:
        kernel.CloseHandle(handle);raise


def duplicate(kernel, source_process, source_handle, target_process, flags=2):
    result = wintypes.HANDLE()
    require(kernel.DuplicateHandle(source_process, source_handle, target_process, ctypes.byref(result), 0, False, flags), "handle duplication failed")
    return result.value


def close_sources(kernel, process, handles):
    failure = None
    for handle in handles:
        try:
            # CLOSE_SOURCE closes the source regardless of the BOOL status.
            # The handles and direct parent have already been validated. Keep
            # attempting both; do not leave an unattempted guard after a status.
            kernel.DuplicateHandle(process, int(handle), None, None, 0, False, 1)
        except BaseException as error:failure = error
    if failure is not None:raise failure


def stamp(kernel, handle, path, directory=False):
    from negi_recover_writer import win_info, win_identity, windows_normal
    info = win_info(kernel, handle, directory, limit=0)
    buffer = ctypes.create_unicode_buffer(32768)
    length = kernel.GetFinalPathNameByHandleW(handle, buffer, len(buffer), 0)
    require(0 < length < len(buffer), "handle path unavailable")
    require(windows_normal(buffer.value) == str(path), "handle path differs")
    return list(win_identity(info))


@contextmanager
def opened(root, create=True):
    from negi_recover_writer import windows_parent, windows_extended
    root = root_path(str(root));kernel = native()
    with windows_parent(root.parent):
        parent_handle = kernel.CreateFileW(windows_extended(root.parent), 0x80, 3, None, 3, 0x02000000 | 0x00200000, None)
        require(parent_handle != ctypes.c_void_p(-1).value, "parent pin unavailable")
        guard = None
        try:
            stamp(kernel, parent_handle, root.parent, True)
            path = Path(str(root) + ".storage-guard-v1.lock")
            guard = kernel.CreateFileW(windows_extended(path), 0x80000000, 0, None, 4 if create else 3, 0x00200000, None)
            if guard == ctypes.c_void_p(-1).value:
                guard = None;raise ValueError("Master storage guard: busy or unavailable")
            stamp(kernel, guard, path)
            yield kernel, parent_handle, guard
        finally:
            if guard is not None:kernel.CloseHandle(guard)
            kernel.CloseHandle(parent_handle)


def validate_ticket(ticket, root, kernel, process, pid, token):
    require(isinstance(ticket, dict) and set(ticket) == {"schema", "root", "pid", "startToken", "handles", "identities"}, "ticket fields")
    require(ticket["schema"] == SCHEMA and ticket["pid"] == pid and ticket["startToken"] == token, "ticket parent differs")
    require(ticket["root"] == str(root), "ticket root differs")
    handles = ticket["handles"];identities = ticket["identities"]
    require(isinstance(handles, list) and len(handles) == 2 and len(set(handles)) == 2 and
            all(isinstance(value, str) and value.isdecimal() and 0 < int(value) < (1 << 64) for value in handles), "ticket handles")
    require(isinstance(identities, list) and len(identities) == 2 and all(isinstance(row, list) and len(row) == 3 and
            all(type(value) is int and 0 <= value <= 0xffffffff for value in row) for row in identities), "ticket identities")
    copies = []
    try:
        for index, (path, directory) in enumerate(((root.parent, True), (Path(str(root) + ".storage-guard-v1.lock"), False))):
            copy = duplicate(kernel, process, int(handles[index]), kernel.GetCurrentProcess());copies.append(copy)
            require(stamp(kernel, copy, path, directory) == identities[index], "ticket file replaced")
        return copies
    except BaseException:
        for copy in copies:kernel.CloseHandle(copy)
        raise


def acquire(raw, create=True):
    try:root = root_path(raw);kernel = native();process, pid, token = parent(kernel)
    except Exception as error:raise NotAcquired("Master storage guard: not acquired") from error
    transferred = []
    try:
        with opened(root, create) as (_, parent_handle, guard):
            identities = [stamp(kernel, parent_handle, root.parent, True), stamp(kernel, guard, Path(str(root) + ".storage-guard-v1.lock"))]
            for handle in (parent_handle, guard):transferred.append(duplicate(kernel, kernel.GetCurrentProcess(), handle, process))
            return {"schema": SCHEMA, "root": str(root), "pid": pid, "startToken": token,
                    "handles": [str(handle) for handle in transferred], "identities": identities}
    except BaseException as error:
        if not transferred:raise NotAcquired("Master storage guard: not acquired") from error
        close_sources(kernel, process, transferred)
        raise
    finally:kernel.CloseHandle(process)


def release(ticket):
    root = root_path(ticket.get("root"));kernel = native();process, pid, token = parent(kernel);copies = []
    try:
        copies = validate_ticket(ticket, root, kernel, process, pid, token)
        # Keep the duplicates open while closing the exact source handles. This
        # preserves exclusion through both validated source-close attempts.
        # Close the parent source first and the guard source last. Local copies
        # still pin both through every source-close attempt.
        close_sources(kernel, process, ticket["handles"])
    finally:
        for copy in reversed(copies):kernel.CloseHandle(copy)
        kernel.CloseHandle(process)


@contextmanager
def storage_guard(root, ticket=None, create=True):
    root = root_path(str(root));current = HELD.get()
    if current == str(root):
        yield;return
    kernel = native();process = None;copies = []
    if ticket is not None:
        process, pid, token = parent(kernel)
        try:copies = validate_ticket(ticket, root, kernel, process, pid, token)
        except BaseException:
            kernel.CloseHandle(process);raise
        boundary = None
    else:
        boundary = opened(root, create);boundary.__enter__()
    context = HELD.set(str(root))
    try:yield
    finally:
        HELD.reset(context)
        if boundary is not None:boundary.__exit__(None, None, None)
        for copy in reversed(copies):kernel.CloseHandle(copy)
        if process is not None:kernel.CloseHandle(process)


def main():
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, "duplicate field");result[key] = value
        return result
    raw = sys.stdin.buffer.read(24001);require(len(raw) <= 24000, "input limit")
    request = json.loads(raw.decode("utf-8"), object_pairs_hook=unique)
    require(isinstance(request, dict), "request invalid")
    if set(request) in ({"action", "root"}, {"action", "root", "create"}) and request["action"] == "acquire":
        require(type(request.get("create", True)) is bool, "creation mode")
        result = acquire(request["root"], request.get("create", True))
    elif set(request) == {"action", "ticket"} and request["action"] == "release":
        release(request["ticket"]);result = {"released": True}
    elif request.get("action") == "recover-master":
        require(set(request) <= {"action", "root", "requestId", "hash", "ownerSha256", "receipt", "storageTicket"} and
                {"action", "root", "requestId", "hash", "ownerSha256", "receipt"} <= set(request), "recovery fields")
        from negi_recover_writer import recover_windows, UUID
        import re
        root = root_path(request["root"])
        master_id = json.loads(request["receipt"])["payload"]["masterId"]
        require(isinstance(master_id, str) and re.fullmatch(r"[a-zA-Z0-9_-]{1,100}", master_id), "Master identity")
        require(UUID.fullmatch(request["requestId"]) and all(re.fullmatch(r"[0-9a-f]{64}", request[key]) for key in ("hash", "ownerSha256")), "recovery identity")
        with storage_guard(root, request.get("storageTicket")):
            released = recover_windows(root / "masters" / master_id, "master", "master-conversation",
                                       request["requestId"], request["hash"], request["ownerSha256"], request["receipt"])
        result = {"released": released}
    else:raise ValueError("Master storage guard: unsupported action")
    emit(result)


def emit(result):
    sys.stdout.buffer.write(json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n")
    sys.stdout.buffer.flush()


if __name__ == "__main__":
    try:main()
    except NotAcquired:emit({"notAcquired": True})
    except Exception as error:
        sys.stderr.write(str(error)[:300] + "\n");sys.exit(1)
