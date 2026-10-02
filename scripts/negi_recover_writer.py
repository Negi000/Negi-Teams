"""Release only an exact dead operation writer under process-lifetime OS exclusion.

This is not a general lock remover. The caller verifies the human signature;
the native boundary permits only two fixed writer names and exact operation IDs.
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
    if kind not in ("vault", "configuration"):raise ValueError("Unknown writer kind")
    return ((".writer.lock", ".recovery.lock", ".writer-recovery-flock-v2.lock") if kind == "vault"
            else ("configuration-writer.lock", "configuration-recovery.lock", "configuration-recovery-flock-v2.lock"))


def validate(raw, kind, domain, request_id, expected_hash):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:raise ValueError("Duplicate writer field")
            result[key] = value
        return result
    value = json.loads(raw.decode("utf-8"), object_pairs_hook=unique)
    common = {"schema", "pid", "owner", "createdAt"}
    required = common | ({"requestId", "hash"} if kind == "vault" else {"operation"})
    schema = "negi-vault-writer/1" if kind == "vault" else "negi-configuration-writer/1"
    if (not isinstance(value, dict) or set(value) != required or value.get("schema") != schema
            or type(value.get("pid")) is not int or not 0 < value["pid"] <= 0x7fffffff
            or not isinstance(value.get("owner"), str) or not UUID.fullmatch(value["owner"])
            or not isinstance(value.get("createdAt"), str)
            or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z", value["createdAt"])):
        raise ValueError("Writer ownership is unknown; preserve it")
    from datetime import datetime
    datetime.fromisoformat(value["createdAt"].replace("Z", "+00:00"))
    if kind == "vault":
        if domain != "vault-initialization" or value["requestId"] != request_id or value["hash"] != expected_hash:
            raise ValueError("Writer belongs to another request")
    elif value["operation"] != {"domain": domain, "requestId": request_id, "hash": expected_hash}:
        raise ValueError("Writer belongs to another operation")
    return value["pid"]


UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")


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
        ("SetFilePointerEx", [wintypes.HANDLE, ctypes.c_longlong, ctypes.c_void_p, wintypes.DWORD], wintypes.BOOL),
        ("SetFileInformationByHandle", [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD], wintypes.BOOL),
    ]:
        function = getattr(kernel, name);function.argtypes = args;function.restype = result
    return kernel


class FileInfo(ctypes.Structure):
    _fields_ = [("attributes", wintypes.DWORD), ("created", wintypes.FILETIME), ("accessed", wintypes.FILETIME),
                ("written", wintypes.FILETIME), ("volume", wintypes.DWORD), ("size_high", wintypes.DWORD),
                ("size_low", wintypes.DWORD), ("links", wintypes.DWORD), ("index_high", wintypes.DWORD), ("index_low", wintypes.DWORD)]


def win_info(kernel, handle, directory=False):
    info = FileInfo()
    if not kernel.GetFileInformationByHandle(handle, ctypes.byref(info)):
        raise ctypes.WinError(ctypes.get_last_error())
    if info.attributes & 0x400 or bool(info.attributes & 0x10) != directory:
        raise ValueError("Recovery handle is a reparse point or wrong type")
    if not directory and (info.links != 1 or info.size_high or info.size_low > 2000):
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


def win_bytes(kernel, handle):
    win_info(kernel, handle)
    if not kernel.SetFilePointerEx(handle, 0, None, 0):raise ctypes.WinError(ctypes.get_last_error())
    buffer = ctypes.create_string_buffer(2001);count = wintypes.DWORD()
    if not kernel.ReadFile(handle, buffer, 2001, ctypes.byref(count), None):raise ctypes.WinError(ctypes.get_last_error())
    if count.value > 2000:raise ValueError("Writer grew")
    return buffer.raw[:count.value]


@contextmanager
def windows_guard(root, kind):
    kernel = windows_kernel()
    parent = kernel.CreateFileW(windows_extended(root), 0x80, 3, None, 3, 0x02000000 | 0x00200000, None)
    if parent == ctypes.c_void_p(-1).value:raise ctypes.WinError(ctypes.get_last_error())
    mutex = None;owned = False
    try:
        win_info(kernel, parent, True)
        buffer = ctypes.create_unicode_buffer(32768)
        length = kernel.GetFinalPathNameByHandleW(parent, buffer, len(buffer), 0)
        if not 0 < length < len(buffer):raise ValueError("Canonical recovery root unavailable")
        canonical = windows_normal(buffer.value)
        if os.path.normcase(canonical) != os.path.normcase(str(root)):raise ValueError("Recovery root alias changed")
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
        kernel.CloseHandle(parent)


def recover_windows(root, kind, domain, request_id, expected_hash):
    with windows_guard(root, kind) as kernel:
        path = root / paths(kind)[0]
        handle = kernel.CreateFileW(windows_extended(path), 0x80000000 | 0x10000, 3, None, 3, 0x00200000, None)
        if handle == ctypes.c_void_p(-1).value:
            code = ctypes.get_last_error()
            if code == 2:return False
            raise ctypes.WinError(code)
        try:
            win_info(kernel, handle);raw = win_bytes(kernel, handle)
            pid = validate(raw, kind, domain, request_id, expected_hash);win_dead(kernel, pid)
            if win_bytes(kernel, handle) != raw:raise ValueError("Writer changed during recovery")
            win_dead(kernel, pid)
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


def recover_linux(root, kind, domain, request_id, expected_hash):
    with linux_guard(root, kind) as parent:
        name = paths(kind)[0]
        try:fd = os.open(name, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW, dir_fd=parent)
        except FileNotFoundError:return False
        try:
            info = os.fstat(fd);regular(info)
            if info.st_size > 2000 or info.st_nlink != 1 or info.st_uid != os.getuid():raise ValueError("Writer metadata invalid")
            raw = os.read(fd, 2001)
            if len(raw) > 2000:raise ValueError("Writer grew")
            pid = validate(raw, kind, domain, request_id, expected_hash)
            try:os.kill(pid, 0)
            except ProcessLookupError:pass
            else:raise ValueError("Writer is still live")
            os.lseek(fd, 0, 0)
            current = os.stat(name, dir_fd=parent, follow_symlinks=False)
            if (current.st_dev, current.st_ino) != (info.st_dev, info.st_ino) or os.read(fd, 2001) != raw:raise ValueError("Writer changed during recovery")
            os.unlink(name, dir_fd=parent);os.fsync(parent)
        finally:os.close(fd)
        return True


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True);parser.add_argument("--kind", choices=["vault", "configuration"], required=True)
    parser.add_argument("--domain", choices=["vault-initialization", "project-configuration"], required=True)
    parser.add_argument("--request-id", required=True);parser.add_argument("--hash", required=True)
    args = parser.parse_args();root = Path(args.root)
    if not root.is_absolute() or root.resolve(strict=True) != root:raise ValueError("Canonical recovery root required")
    regular(root.lstat(), True)
    if not UUID.fullmatch(args.request_id) or not re.fullmatch(r"[0-9a-f]{64}", args.hash):raise ValueError("Recovery operation identity invalid")
    function = recover_windows if os.name == "nt" else recover_linux if sys.platform == "linux" else None
    if function is None:raise ValueError("Native recovery guard is unsupported")
    print(json.dumps({"released": function(root, args.kind, args.domain, args.request_id, args.hash)}))
