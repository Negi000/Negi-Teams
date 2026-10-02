"""Release only an exact dead operation writer under process-lifetime OS exclusion.

This is not a general lock remover. The caller verifies the human signature;
the native boundary permits only four fixed writer names and exact operation IDs.
Inspection is read only and never acquires or creates a recovery guard.
"""
import argparse
from contextlib import contextmanager
import ctypes
from ctypes import wintypes
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys


def regular(info, directory=False):
    if (not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode))
            or getattr(info, "st_file_attributes", 0) & 0x400):
        raise ValueError("Recovery entry is not a normal file/directory")


def paths(kind):
    if kind == "master":return ("owner.lock", "owner-recovery.lock", "owner-recovery-flock-v2.lock")
    if kind == "setup":return ("setup-writer.lock", "setup-recovery.lock", "setup-recovery-flock-v2.lock")
    if kind not in ("vault", "configuration"):raise ValueError("Unknown writer kind")
    return ((".writer.lock", ".recovery.lock", ".writer-recovery-flock-v2.lock") if kind == "vault"
            else ("configuration-writer.lock", "configuration-recovery.lock", "configuration-recovery-flock-v2.lock"))


def master_inventory_absent(root):
    # Owner/2 receipt publication/deletion is not integrated with the independent
    # index yet. A TS-only fence would leave this direct native entry unprotected.
    if root.parent.name != "masters":raise ValueError("Canonical Master authority layout required")
    database = str(root.parent.parent) + ".inventory.sqlite3"
    for suffix in ("", "-journal", "-wal", "-shm"):
        try:Path(database + suffix).lstat()
        except FileNotFoundError:continue
        else:raise ValueError("Independent Master inventory requires migration; preserve owner and receipt")


def validate(raw, kind, domain, request_id, expected_hash):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:raise ValueError("Duplicate writer field")
            result[key] = value
        return result
    value = json.loads(raw.decode("utf-8"), object_pairs_hook=unique)
    common = {"schema", "pid", "owner", "createdAt"}
    required = common | ({"operation", "masterId", "kind", "cwdSha256", "evidenceSha256", "signature"} if kind == "master" else
                         {"requestId", "hash"} if kind != "configuration" else {"operation"})
    schema = {"vault":"negi-vault-writer/1", "setup":"negi-setup-writer/1", "configuration":"negi-configuration-writer/1",
              "master":"negi-master-conversation-owner/2"}[kind]
    if (not isinstance(value, dict) or set(value) != required or value.get("schema") != schema
            or type(value.get("pid")) is not int or not 0 < value["pid"] <= 0x7fffffff
            or not isinstance(value.get("owner"), str) or not UUID.fullmatch(value["owner"])
            or not isinstance(value.get("createdAt"), str)
            or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z", value["createdAt"])):
        raise ValueError("Writer ownership is unknown; preserve it")
    from datetime import datetime
    datetime.fromisoformat(value["createdAt"].replace("Z", "+00:00"))
    if kind == "master":
        if (domain != "master-conversation" or value["operation"] != {"domain":domain, "requestId":request_id, "hash":expected_hash}
                or not isinstance(value["masterId"], str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,100}", value["masterId"])
                or value["kind"] not in ("inspection", "turn-admission", "thread-start")
                or not isinstance(value["cwdSha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", value["cwdSha256"])
                or not isinstance(value["evidenceSha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", value["evidenceSha256"])
                or not isinstance(value["signature"], str) or not re.fullmatch(r"[0-9a-f]{64}", value["signature"])):
            raise ValueError("Master writer evidence identity invalid")
    elif kind != "configuration":
        if domain != ("vault-initialization" if kind == "vault" else "project-setup") or value["requestId"] != request_id or value["hash"] != expected_hash:
            raise ValueError("Writer belongs to another request")
    elif value["operation"] != {"domain": domain, "requestId": request_id, "hash": expected_hash}:
        raise ValueError("Writer belongs to another operation")
    return value["pid"]


# Match the existing receipt contract, including historical nil/non-RFC IDs.
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")


def windows_extended(path):
    raw = str(path)
    if raw.startswith("\\\\?\\"):return raw
    if raw.startswith("\\\\"):return "\\\\?\\UNC\\" + raw[2:]
    return "\\\\?\\" + raw


def windows_normal(path):
    if path.lower().startswith("\\\\?\\unc\\"):return "\\\\" + path[8:]
    return path[4:] if path.startswith("\\\\?\\") else path


def windows_kernel():
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    for name, args, result in [
        ("CreateMutexW", [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR], wintypes.HANDLE),
        ("WaitForSingleObject", [wintypes.HANDLE, wintypes.DWORD], wintypes.DWORD),
        ("ReleaseMutex", [wintypes.HANDLE], wintypes.BOOL),
        ("CloseHandle", [wintypes.HANDLE], wintypes.BOOL),
        ("OpenProcess", [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD], wintypes.HANDLE),
        ("CreateFileW", [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE], wintypes.HANDLE),
        ("GetFinalPathNameByHandleW", [wintypes.HANDLE, wintypes.LPWSTR, wintypes.DWORD, wintypes.DWORD], wintypes.DWORD),
        ("GetFileInformationByHandle", [wintypes.HANDLE, ctypes.c_void_p], wintypes.BOOL),
        ("ReadFile", [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p], wintypes.BOOL),
        ("WriteFile", [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p], wintypes.BOOL),
        ("FlushFileBuffers", [wintypes.HANDLE], wintypes.BOOL),
        ("SetEndOfFile", [wintypes.HANDLE], wintypes.BOOL),
        ("MoveFileExW", [wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD], wintypes.BOOL),
        ("SetFilePointerEx", [wintypes.HANDLE, ctypes.c_longlong, ctypes.c_void_p, wintypes.DWORD], wintypes.BOOL),
        ("SetFileInformationByHandle", [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD], wintypes.BOOL),
    ]:
        function = getattr(kernel, name);function.argtypes = args;function.restype = result
    return kernel


class FileInfo(ctypes.Structure):
    _fields_ = [("attributes", wintypes.DWORD), ("created", wintypes.FILETIME), ("accessed", wintypes.FILETIME),
                ("written", wintypes.FILETIME), ("volume", wintypes.DWORD), ("size_high", wintypes.DWORD),
                ("size_low", wintypes.DWORD), ("links", wintypes.DWORD), ("index_high", wintypes.DWORD), ("index_low", wintypes.DWORD)]


def win_info(kernel, handle, directory=False, limit=2000):
    info = FileInfo()
    if not kernel.GetFileInformationByHandle(handle, ctypes.byref(info)):
        raise ctypes.WinError(ctypes.get_last_error())
    if info.attributes & 0x400 or bool(info.attributes & 0x10) != directory:
        raise ValueError("Recovery handle is a reparse point or wrong type")
    if not directory and (info.links != 1 or info.size_high or info.size_low > limit):
        raise ValueError("Writer size or link count invalid")
    return info


def win_dead(kernel, pid):
    # os.kill(pid, 0) must not be used on Windows: Python uses TerminateProcess.
    handle = kernel.OpenProcess(0x00100000 | 0x1000, False, pid)
    if not handle:
        code = ctypes.get_last_error()
        if code == 87:return
        raise ctypes.WinError(code)
    try:
        result = kernel.WaitForSingleObject(handle, 0)
        if result == 0:return
        if result == 258:raise ValueError("Writer is still live")
        raise ctypes.WinError(ctypes.get_last_error())
    finally:kernel.CloseHandle(handle)


def win_bytes(kernel, handle, limit=2000):
    win_info(kernel, handle, limit=limit)
    if not kernel.SetFilePointerEx(handle, 0, None, 0):raise ctypes.WinError(ctypes.get_last_error())
    buffer = ctypes.create_string_buffer(limit+1);count = wintypes.DWORD()
    if not kernel.ReadFile(handle, buffer, limit+1, ctypes.byref(count), None):raise ctypes.WinError(ctypes.get_last_error())
    if count.value > limit:raise ValueError("Writer grew")
    return buffer.raw[:count.value]


def win_open_reader(kernel, path):
    # Observation must not prevent the actual writer's finally/unlink.
    return kernel.CreateFileW(windows_extended(path), 0x80000000, 7, None, 3, 0x00200000, None)


def win_identity(info):
    return (info.volume, info.index_high, info.index_low)


@contextmanager
def windows_parent(root):
    kernel = windows_kernel()
    parent = kernel.CreateFileW(windows_extended(root), 0x80, 3, None, 3, 0x02000000 | 0x00200000, None)
    if parent == ctypes.c_void_p(-1).value:raise ctypes.WinError(ctypes.get_last_error())
    try:
        win_info(kernel, parent, True)
        buffer = ctypes.create_unicode_buffer(32768)
        length = kernel.GetFinalPathNameByHandleW(parent, buffer, len(buffer), 0)
        if not 0 < length < len(buffer):raise ValueError("Canonical recovery root unavailable")
        canonical = windows_normal(buffer.value)
        if os.path.normcase(canonical) != os.path.normcase(str(root)):raise ValueError("Recovery root alias changed")
        yield kernel, canonical
    finally:kernel.CloseHandle(parent)


@contextmanager
def windows_guard(root, kind):
    with windows_parent(root) as (kernel, canonical):
      mutex = None;owned = False
      try:
        name = "Global\\NegiWriterRecoveryV2-" + hashlib.sha256((os.path.normcase(canonical)+"\0"+kind).encode("utf-8")).hexdigest()
        mutex = kernel.CreateMutexW(None, False, name)
        if not mutex:raise ctypes.WinError(ctypes.get_last_error())
        result = kernel.WaitForSingleObject(mutex, 0)
        if result not in (0, 128):raise ValueError("Native recovery guard busy or unavailable")
        owned = True
        if os.path.lexists(root / paths(kind)[1]):raise ValueError("Legacy recovery guard must be preserved")
        yield kernel
      finally:
        if owned:kernel.ReleaseMutex(mutex)
        if mutex:kernel.CloseHandle(mutex)


def receipt_data(root, owner_raw, text):
    # HMAC authorization belongs to TypeScript. This native boundary additionally
    # pins the exact raw owner and complete receipt before changing fixed names.
    if not isinstance(text, str) or not 0 < len(text.encode("utf-8")) <= 8000:
        raise ValueError("Master recovery requires a bounded signed receipt")
    def unique(pairs):
        value = {}
        for key, item in pairs:
            if key in value:raise ValueError("Duplicate receipt field")
            value[key] = item
        return value
    row = json.loads(text, object_pairs_hook=unique);owner = json.loads(owner_raw)
    payload = row.get("payload") if isinstance(row, dict) else None
    if (set(row) != {"payload", "signature"} or not isinstance(payload, dict)
            or set(payload) != {"schemaVersion", "masterId", "decisionId", "cwdSha256", "owner", "proofSha256", "action", "at"}
            or payload["schemaVersion"] != "negi-master-owner-recovery/1" or payload["owner"] != owner
            or owner["masterId"] != root.name or payload["masterId"] != root.name
            or not isinstance(payload["decisionId"], str) or not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", payload["decisionId"])
            or payload["cwdSha256"] != owner["cwdSha256"]
            or payload["action"] != "release-owner-only"
            or not isinstance(payload["proofSha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", payload["proofSha256"])
            or not isinstance(row["signature"], str) or not re.fullmatch(r"[0-9a-f]{64}", row["signature"])
            or not isinstance(payload["at"], str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", payload["at"])):
        raise ValueError("Receipt does not bind this exact owner and decision")
    from datetime import datetime
    datetime.fromisoformat(payload["at"].replace("Z", "+00:00"))
    return text.encode("utf-8"), owner["owner"]+".json", ".pending-"+owner["owner"]+"-"+payload["decisionId"]+".json"


def receipt_names(names, pending, final):
    if len(names) > 10000 or any(name.startswith(".pending-") and name != pending for name in names):
        raise ValueError("Another pending recovery decision must be preserved")
    if final not in names and pending not in names and len(names) >= 10000:
        raise ValueError("No capacity for a new recovery receipt")


def publish_receipt_windows(kernel, root, owner_raw, text):
    raw, final_name, pending_name = receipt_data(root, owner_raw, text)
    master_inventory_absent(root)
    receipts = root / "recoveries"
    try:receipts.mkdir(mode=0o700)
    except FileExistsError:pass
    with windows_parent(receipts):
        receipt_names(os.listdir(receipts), pending_name, final_name)
        final, pending = receipts / final_name, receipts / pending_name
        handle = win_open_reader(kernel, final)
        if handle != ctypes.c_void_p(-1).value:
            try:
                if win_bytes(kernel, handle, 8000) != raw:raise ValueError("Existing recovery receipt differs")
            finally:kernel.CloseHandle(handle)
            if os.path.lexists(pending):raise ValueError("Unexpected pending record beside final receipt")
            return
        if ctypes.get_last_error() != 2:raise ctypes.WinError(ctypes.get_last_error())
        # Do not truncate until the opened entry is proven ordinary and unshared.
        master_inventory_absent(root)
        handle = kernel.CreateFileW(windows_extended(pending), 0xc0000000, 0, None, 4, 0x00200000, None)
        if handle == ctypes.c_void_p(-1).value:raise ctypes.WinError(ctypes.get_last_error())
        try:
            win_info(kernel, handle, limit=8000)
            if not kernel.SetFilePointerEx(handle, 0, None, 0) or not kernel.SetEndOfFile(handle):raise ctypes.WinError(ctypes.get_last_error())
            buffer = ctypes.create_string_buffer(raw);count = wintypes.DWORD()
            if not kernel.WriteFile(handle, buffer, len(raw), ctypes.byref(count), None) or count.value != len(raw):raise ctypes.WinError(ctypes.get_last_error())
            if not kernel.FlushFileBuffers(handle):raise ctypes.WinError(ctypes.get_last_error())
            if win_bytes(kernel, handle, 8000) != raw:raise ValueError("Staged receipt changed")
        finally:kernel.CloseHandle(handle)
        # No REPLACE_EXISTING/COPY_ALLOWED fallback. Same-volume create-only move.
        master_inventory_absent(root)
        if not kernel.MoveFileExW(windows_extended(pending), windows_extended(final), 0x8):raise ctypes.WinError(ctypes.get_last_error())
        handle = win_open_reader(kernel, final)
        if handle == ctypes.c_void_p(-1).value:raise ctypes.WinError(ctypes.get_last_error())
        try:
            if win_bytes(kernel, handle, 8000) != raw:raise ValueError("Published receipt changed")
        finally:kernel.CloseHandle(handle)


def recover_windows(root, kind, domain, request_id, expected_hash, owner_sha256=None, receipt_json=None):
    if kind == "master":
        if root.parent.name != "masters":raise ValueError("Canonical Master authority layout required")
        sibling_directory = str(Path(__file__).parent)
        if sibling_directory not in sys.path:sys.path.insert(0, sibling_directory)
        from negi_master_storage_guard import storage_guard
        with storage_guard(root.parent.parent):
            return _recover_windows(root, kind, domain, request_id, expected_hash, owner_sha256, receipt_json)
    return _recover_windows(root, kind, domain, request_id, expected_hash, owner_sha256, receipt_json)


def _recover_windows(root, kind, domain, request_id, expected_hash, owner_sha256=None, receipt_json=None):
    if kind == "master":master_inventory_absent(root)
    with windows_guard(root, kind) as kernel:
        if kind == "master":master_inventory_absent(root)
        path = root / paths(kind)[0]
        handle = kernel.CreateFileW(windows_extended(path), 0x80000000 | 0x10000, 3, None, 3, 0x00200000, None)
        if handle == ctypes.c_void_p(-1).value:
            code = ctypes.get_last_error()
            if code == 2:return False
            raise ctypes.WinError(code)
        try:
            win_info(kernel, handle);raw = win_bytes(kernel, handle)
            if owner_sha256 is not None and hashlib.sha256(raw).hexdigest() != owner_sha256:raise ValueError("Observed owner bytes changed")
            pid = validate(raw, kind, domain, request_id, expected_hash);win_dead(kernel, pid)
            if kind == "master":publish_receipt_windows(kernel, root, raw, receipt_json)
            if win_bytes(kernel, handle) != raw:raise ValueError("Writer changed during recovery")
            win_dead(kernel, pid)
            if kind == "master":master_inventory_absent(root)
            # Delete the exact opened file on close; path substitution cannot make
            # us unlink another entry. The handle denies FILE_SHARE_DELETE.
            disposition = ctypes.c_ubyte(1)
            if not kernel.SetFileInformationByHandle(handle, 4, ctypes.byref(disposition), 1):
                raise ctypes.WinError(ctypes.get_last_error())
        finally:kernel.CloseHandle(handle)
        return True


@contextmanager
def linux_guard(root, kind):
    import fcntl
    before = root.lstat();regular(before, True)
    parent = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW)
    guard = None
    try:
        if (os.fstat(parent).st_dev, os.fstat(parent).st_ino) != (before.st_dev, before.st_ino):raise ValueError("Recovery parent changed")
        guard = os.open(paths(kind)[2], os.O_CREAT | os.O_RDWR | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600, dir_fd=parent)
        info = os.fstat(guard);regular(info)
        if info.st_size or info.st_nlink != 1 or info.st_uid != os.getuid() or before.st_uid != os.getuid():raise ValueError("Native guard ownership invalid")
        fcntl.flock(guard, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:os.stat(paths(kind)[1], dir_fd=parent, follow_symlinks=False)
        except FileNotFoundError:pass
        else:raise ValueError("Legacy recovery guard must be preserved")
        yield parent
    finally:
        if guard is not None:os.close(guard)
        os.close(parent)


def recover_linux(root, kind, domain, request_id, expected_hash, owner_sha256=None, receipt_json=None):
    # A stat/byte recheck followed by pathname unlink cannot guarantee removal
    # of the opened owner. Keep Master ownership until a proven native protocol
    # and cooperating writers exist; do not publish a receipt or create a guard.
    if kind == "master":raise ValueError("Exact Master owner deletion is unsupported on Linux; preserve owner")
    with linux_guard(root, kind) as parent:
        name = paths(kind)[0]
        try:fd = os.open(name, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW, dir_fd=parent)
        except FileNotFoundError:return False
        try:
            info = os.fstat(fd);regular(info)
            if info.st_size > 2000 or info.st_nlink != 1 or info.st_uid != os.getuid():raise ValueError("Writer metadata invalid")
            raw = os.read(fd, 2001)
            if len(raw) > 2000:raise ValueError("Writer grew")
            if owner_sha256 is not None and hashlib.sha256(raw).hexdigest() != owner_sha256:raise ValueError("Observed owner bytes changed")
            pid = validate(raw, kind, domain, request_id, expected_hash)
            try:os.kill(pid, 0)
            except ProcessLookupError:pass
            else:raise ValueError("Writer is still live")
            os.lseek(fd, 0, 0)
            current = os.stat(name, dir_fd=parent, follow_symlinks=False)
            if (current.st_dev, current.st_ino) != (info.st_dev, info.st_ino) or os.read(fd, 2001) != raw:raise ValueError("Writer changed during recovery")
            try:os.kill(pid, 0)
            except ProcessLookupError:pass
            else:raise ValueError("Writer is still live or its PID was reused")
            os.unlink(name, dir_fd=parent);os.fsync(parent)
        finally:os.close(fd)
        return True


def observation(raw, kind, dead):
    # Parsing once locates the declared operation; validate() reparses with
    # duplicate rejection and checks its complete schema before probing a PID.
    result = {"state":"unknown", "operation":None, "sha256":hashlib.sha256(raw).hexdigest()}
    try:
        value = json.loads(raw.decode("utf-8"))
        operation = value.get("operation") if kind in ("configuration", "master") else {
            "domain":"vault-initialization" if kind == "vault" else "project-setup", "requestId":value.get("requestId"), "hash":value.get("hash")}
        if (not isinstance(operation, dict) or set(operation) != {"domain", "requestId", "hash"}
                or operation["domain"] not in ("project-setup", "project-configuration", "vault-initialization", "master-conversation")
                or not isinstance(operation["requestId"], str) or not UUID.fullmatch(operation["requestId"])
                or not isinstance(operation["hash"], str) or not re.fullmatch(r"[0-9a-f]{64}", operation["hash"])):return result
        pid = validate(raw, kind, operation["domain"], operation["requestId"], operation["hash"])
        try:dead(pid)
        except ValueError:result.update(state="live", operation=operation)
        except OSError:pass
        else:result.update(state="dead", operation=operation)
    except (ValueError, TypeError, AttributeError, KeyError):pass
    return result


def inspect_writer(root, kind):
    result = {"state":"unknown", "operation":None, "sha256":None,
              "legacyGuard":os.path.lexists(root / paths(kind)[1])}
    if os.name == "nt":
        with windows_parent(root) as (kernel, _):
            path = root / paths(kind)[0];handle = win_open_reader(kernel, path)
            if handle == ctypes.c_void_p(-1).value:
                if ctypes.get_last_error() == 2:result["state"] = "absent"
                return result
            try:
                before = win_info(kernel, handle);raw = win_bytes(kernel, handle)
                observed = observation(raw, kind, lambda pid:win_dead(kernel, pid))
                current = win_open_reader(kernel, path)
                if current != ctypes.c_void_p(-1).value:
                    try:
                        if win_identity(win_info(kernel, current)) == win_identity(before) and win_bytes(kernel, current) == raw and win_bytes(kernel, handle) == raw:result.update(observed)
                    finally:kernel.CloseHandle(current)
            except (OSError, ValueError):pass
            finally:kernel.CloseHandle(handle)
    elif sys.platform == "linux":
        before = root.lstat();regular(before, True)
        parent = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW)
        try:
            pinned = os.fstat(parent);regular(pinned, True)
            if (pinned.st_dev, pinned.st_ino) != (before.st_dev, before.st_ino) or pinned.st_uid != os.getuid():return result
            try:fd = os.open(paths(kind)[0], os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW, dir_fd=parent)
            except FileNotFoundError:result["state"] = "absent";return result
            try:
                info = os.fstat(fd);regular(info)
                if info.st_size > 2000 or info.st_nlink != 1 or info.st_uid != os.getuid():return result
                raw = os.read(fd, 2001)
                if len(raw) > 2000:return result
                def dead(pid):
                    try:os.kill(pid, 0)
                    except ProcessLookupError:return
                    raise ValueError("Writer is still live")
                observed = observation(raw, kind, dead);os.lseek(fd, 0, 0)
                now = os.stat(paths(kind)[0], dir_fd=parent, follow_symlinks=False)
                if (now.st_dev, now.st_ino) == (info.st_dev, info.st_ino) and os.read(fd, 2001) == raw:result.update(observed)
            except (OSError, ValueError):pass
            finally:os.close(fd)
        finally:os.close(parent)
    else:
        # Unsupported deletion platforms may still display a normal idle setup.
        try:os.lstat(root / paths(kind)[0])
        except FileNotFoundError:result["state"] = "absent"
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True);parser.add_argument("--kind", choices=["vault", "configuration", "setup", "master"], required=True)
    parser.add_argument("--inspect", action="store_true")
    parser.add_argument("--domain", choices=["vault-initialization", "project-configuration", "project-setup", "master-conversation"])
    parser.add_argument("--request-id");parser.add_argument("--hash");parser.add_argument("--owner-sha256");parser.add_argument("--receipt-json")
    args = parser.parse_args();root = Path(args.root)
    if not root.is_absolute() or root.resolve(strict=True) != root:raise ValueError("Canonical recovery root required")
    regular(root.lstat(), True)
    if args.inspect:
        print(json.dumps(inspect_writer(root, args.kind)));sys.exit(0)
    if not all((args.domain, args.request_id, args.hash)):parser.error("Recovery requires an exact operation")
    if not UUID.fullmatch(args.request_id) or not re.fullmatch(r"[0-9a-f]{64}", args.hash):raise ValueError("Recovery operation identity invalid")
    if args.kind == "master" and args.owner_sha256 is None:raise ValueError("Master recovery requires observed owner bytes")
    if args.owner_sha256 is not None and not re.fullmatch(r"[0-9a-f]{64}", args.owner_sha256):raise ValueError("Observed owner hash invalid")
    function = recover_windows if os.name == "nt" else recover_linux if sys.platform == "linux" else None
    if function is None:raise ValueError("Native recovery guard is unsupported")
    print(json.dumps({"released": function(root, args.kind, args.domain, args.request_id, args.hash, args.owner_sha256, args.receipt_json)}))
