"""Local, disposable L1/L2 context cache. Source notes and approvals stay authoritative."""
from __future__ import annotations

import hashlib
import hmac
import json
import marshal
import os
import ctypes
from contextlib import ExitStack, contextmanager
from ctypes import wintypes
from itertools import islice
from pathlib import Path
import re
import stat
import sys

_LOADED_MODULE_CODE_SHA = hashlib.sha256(marshal.dumps(sys._getframe().f_code)).hexdigest()
_LOADED_SOURCE_SHA = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()

SCHEMA = "negi-context-cache/1"
MAX_BYTES = 5_000_000
MAX_ENTRIES = 4096
NAME = re.compile(r"(l1|l2)-[0-9a-f]{64}\.json")


class CachePathError(ValueError):
    pass


class CacheUnavailable(ValueError):
    pass


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def digest(value):
    return hashlib.sha256(encoded(value)).hexdigest()


def linked(path):
    info = path.lstat()
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, "st_file_attributes", 0) & 0x400)


def ordinary(path, maximum):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or linked(path) or info.st_nlink != 1 or info.st_size > maximum:
        raise CacheUnavailable("cache file identity/type invalid")
    data = path.read_bytes()
    after = path.lstat()
    if len(data) > maximum or (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns) != \
            (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns):
        raise CacheUnavailable("cache file changed during read")
    return data


def exclusive(path, data):
    with path.open("xb") as file:
        if os.name != "nt":
            os.chmod(path, 0o600)
        file.write(data)
        file.flush()
        os.fsync(file.fileno())


@contextmanager
def pin_directory(kernel, path, create=False, expected_identity=None):
    from negi_recover_writer import windows_extended, windows_normal, win_info
    # READ_ATTRIBUTES alone does not participate in Windows rename sharing.
    # GENERIC_READ + no FILE_SHARE_DELETE pins the actual directory entry.
    created = False
    if create:
        # NtCreateFile returns the created/opened directory handle in the same
        # operation. mkdir followed by open would permit ordinary-inode substitution.
        class UnicodeString(ctypes.Structure):
            _fields_ = [("length", wintypes.USHORT), ("maximum", wintypes.USHORT), ("buffer", wintypes.LPWSTR)]
        class ObjectAttributes(ctypes.Structure):
            _fields_ = [("length", wintypes.ULONG), ("root", wintypes.HANDLE),
                        ("name", ctypes.POINTER(UnicodeString)), ("attributes", wintypes.ULONG),
                        ("security", ctypes.c_void_p), ("quality", ctypes.c_void_p)]
        class IoStatus(ctypes.Structure):
            _fields_ = [("status", ctypes.c_void_p), ("information", ctypes.c_size_t)]
        native = ctypes.WinDLL("ntdll", use_last_error=True)
        native.NtCreateFile.argtypes = [ctypes.POINTER(wintypes.HANDLE), wintypes.ULONG,
            ctypes.POINTER(ObjectAttributes), ctypes.POINTER(IoStatus), ctypes.c_void_p,
            wintypes.ULONG, wintypes.ULONG, wintypes.ULONG, wintypes.ULONG, ctypes.c_void_p, wintypes.ULONG]
        native.NtCreateFile.restype = ctypes.c_long
        native.RtlNtStatusToDosError.argtypes = [ctypes.c_long]
        native.RtlNtStatusToDosError.restype = wintypes.ULONG
        text = "\\??\\" + windows_extended(path)[4:]
        buffer = ctypes.create_unicode_buffer(text)
        name = UnicodeString(len(text.encode("utf-16-le")), ctypes.sizeof(buffer), ctypes.cast(buffer, wintypes.LPWSTR))
        attributes = ObjectAttributes(ctypes.sizeof(ObjectAttributes), None, ctypes.pointer(name), 0x40, None, None)
        result, io = wintypes.HANDLE(), IoStatus()
        status = native.NtCreateFile(ctypes.byref(result), 0x80000000 | 0x100000, ctypes.byref(attributes),
            ctypes.byref(io), None, 0x80, 3, 3, 0x1 | 0x20 | 0x200000, None, 0)
        if status < 0:
            raise ctypes.WinError(native.RtlNtStatusToDosError(status))
        handle, created = result.value, io.information == 2
    else:
        handle = kernel.CreateFileW(windows_extended(path), 0x80000000, 3, None, 3,
                                    0x02000000 | 0x00200000, None)
        if handle == ctypes.c_void_p(-1).value:
            raise ctypes.WinError(ctypes.get_last_error())
    try:
        win_info(kernel, handle, True)
        buffer = ctypes.create_unicode_buffer(32768)
        length = kernel.GetFinalPathNameByHandleW(handle, buffer, len(buffer), 0)
        if not 0 < length < len(buffer) or os.path.normcase(windows_normal(buffer.value)) != os.path.normcase(str(path)):
            raise CachePathError("cache directory alias changed")
        if expected_identity is not None:
            current = path.lstat()
            if (current.st_dev, current.st_ino) != expected_identity:
                raise CachePathError("cache directory identity changed before pin")
        yield created
    finally:
        kernel.CloseHandle(handle)


class ContextCache:
    def __init__(self, directory: str, vault: Path, processor: str):
        self.boundary = ExitStack()
        try:
            self.initialize(directory, vault, processor)
        except BaseException:
            self.boundary.close()
            raise

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.boundary.close()

    def initialize(self, directory: str, vault: Path, processor: str):
        if os.name != "nt":
            raise CacheUnavailable("native cache exclusion is currently Windows-only")
        from negi_recover_writer import windows_kernel, windows_extended, win_info
        self.kernel = windows_kernel()
        raw = Path(directory).absolute()
        if not raw.name or raw.name != raw.name.rstrip(" .") or any(char in raw.name for char in '<>:"|?*'):
            raise CachePathError("cache directory name invalid")
        identities = {}
        # Capture the complete existing chain before acquiring any handle. Opening
        # the same pathname after an ordinary directory swap must not adopt it.
        for ancestor in (raw, *raw.parents):
            if os.path.lexists(ancestor):
                info = ancestor.lstat()
                if linked(ancestor):
                    raise CachePathError("cache path cannot contain links or reparse points")
                identities[ancestor] = (info.st_dev, info.st_ino)
        parent = raw.parent.resolve(strict=True)
        root = parent / raw.name
        if root == vault or root.is_relative_to(vault) or vault.is_relative_to(root):
            raise CachePathError("cache must be separate from the source Vault")
        # Pin every existing ancestor before creating or touching a cache file.
        # FILE_SHARE_DELETE is denied for the whole operation, including cleanup.
        for ancestor in reversed((parent, *parent.parents)):
            if ancestor not in identities:
                raise CachePathError("cache parent identity unavailable")
            self.boundary.enter_context(pin_directory(self.kernel, ancestor, expected_identity=identities[ancestor]))
        created = self.boundary.enter_context(pin_directory(self.kernel, root, create=True,
                                                            expected_identity=identities.get(raw)))
        self.root, self.vault, self.processor = root, vault, processor
        self.scope = digest({"vault": str(vault)})
        self.counts = {"l1_hit": 0, "l1_miss": 0, "l2_hit": 0, "l2_miss": 0,
                       "invalid": 0, "pruned": 0, "write_skipped": 0}
        key_path, marker_path = root / "cache-signing-key", root / "cache-registration.json"
        if not created:
            try:
                self.key = ordinary(key_path, 32)
                if len(self.key) != 32:
                    raise CacheUnavailable("cache key invalid")
                registration = self.verify(json.loads(ordinary(marker_path, 4096)))
                if registration != {"schema": SCHEMA, "root": str(root)}:
                    raise CacheUnavailable("cache registration differs")
            except (OSError, ValueError, TypeError, KeyError) as error:
                raise CacheUnavailable("cache registration requires inspection") from error
        guard = self.kernel.CreateFileW(windows_extended(root / "cache-guard.lock"),
                                        0x80000000, 0, None, 4, 0x00200000, None)
        if guard == ctypes.c_void_p(-1).value:
            raise CacheUnavailable("cache busy or unavailable; compile from sources")
        self.boundary.callback(self.kernel.CloseHandle, guard)
        win_info(self.kernel, guard, limit=0)
        if created:
            self.key = os.urandom(32)
            exclusive(key_path, self.key)
            exclusive(marker_path, encoded(self.envelope({"schema": SCHEMA, "root": str(root)})))
        self.directory = root / self.scope
        namespace_info = self.directory.lstat() if os.path.lexists(self.directory) else None
        namespace_identity = (namespace_info.st_dev, namespace_info.st_ino) if namespace_info is not None else None
        created_namespace = self.boundary.enter_context(pin_directory(self.kernel, self.directory, create=True,
                                                                      expected_identity=namespace_identity))
        namespace_marker = self.directory / "namespace-registration.json"
        namespace = {"schema": SCHEMA, "scope": self.scope}
        if created_namespace:
            exclusive(namespace_marker, encoded(self.envelope(namespace)))
        elif self.verify(json.loads(ordinary(namespace_marker, 4096))) != namespace:
            raise CacheUnavailable("cache namespace registration differs")
        if len(list(islice(self.directory.iterdir(), MAX_ENTRIES + 1))) > MAX_ENTRIES:
            raise CacheUnavailable("cache namespace exceeds retention limit")
        self.l1_keys = set()

    @contextmanager
    def entry(self, path, remove=False):
        from negi_recover_writer import windows_extended, win_bytes, win_info
        # No writer or replacement can race a signed read or handle-based delete.
        handle = self.kernel.CreateFileW(windows_extended(path),
            0x80000000 | (0x10000 if remove else 0), 1, None, 3, 0x00200000, None)
        if handle == ctypes.c_void_p(-1).value:
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            info = win_info(self.kernel, handle, limit=MAX_BYTES)
            yield handle, win_bytes(self.kernel, handle, info.size_high << 32 | info.size_low)
        finally:
            self.kernel.CloseHandle(handle)

    def envelope(self, value):
        return {"payload": value, "signature": hmac.new(self.key, encoded(value), hashlib.sha256).hexdigest()}

    def verify(self, envelope):
        payload, signature = envelope["payload"], envelope["signature"]
        expected = hmac.new(self.key, encoded(payload), hashlib.sha256).hexdigest()
        if not isinstance(signature, str) or not hmac.compare_digest(signature, expected):
            raise CacheUnavailable("cache signature invalid")
        return payload

    def filename(self, tier, inputs):
        if tier not in ("l1", "l2"):
            raise ValueError("cache tier invalid")
        return f"{tier}-{digest({'schema': SCHEMA, 'scope': self.scope, 'processor': self.processor, 'inputs': inputs})}.json"

    def get(self, tier, inputs):
        name = self.filename(tier, inputs)
        if tier == "l1":
            self.l1_keys.add(name)
        try:
            with self.entry(self.directory / name) as (_, data):
                payload = self.verify(json.loads(data))
            if payload.get("schema") != SCHEMA or payload.get("scope") != self.scope or \
                    payload.get("name") != name or payload.get("processor") != self.processor:
                raise CacheUnavailable("cache entry registration differs")
            self.counts[tier + "_hit"] += 1
            return payload["value"]
        except FileNotFoundError:
            pass
        except (OSError, ValueError, TypeError, KeyError, AttributeError):
            self.counts["invalid"] += 1
        self.counts[tier + "_miss"] += 1
        return None

    def put(self, tier, inputs, value, epoch=None):
        name = self.filename(tier, inputs)
        payload = {"schema": SCHEMA, "scope": self.scope, "processor": self.processor,
                   "name": name, "epoch": epoch, "value": value}
        data = encoded(self.envelope(payload))
        if len(data) > MAX_BYTES:
            self.counts["write_skipped"] += 1
            return
        try:
            if len(list(islice(self.directory.iterdir(), MAX_ENTRIES))) >= MAX_ENTRIES:
                self.counts["write_skipped"] += 1
                return
            exclusive(self.directory / name, data)
        except OSError:
            # A concurrent publisher or a partial/corrupt entry never authorizes its bytes.
            self.counts["write_skipped"] += 1

    def prune(self, epoch):
        entries = list(islice(self.directory.iterdir(), MAX_ENTRIES + 1))
        if len(entries) > MAX_ENTRIES:
            raise CacheUnavailable("cache namespace exceeds retention limit")
        for path in entries:
            if not NAME.fullmatch(path.name):
                continue
            if path.name.startswith("l1-") and path.name in self.l1_keys:
                continue
            try:
                with self.entry(path, remove=True) as (handle, data):
                    payload = self.verify(json.loads(data))
                    if payload.get("schema") != SCHEMA or payload.get("scope") != self.scope or payload.get("name") != path.name:
                        continue
                    stale = (path.name.startswith("l1-") and path.name not in self.l1_keys) or \
                        (path.name.startswith("l2-") and payload.get("epoch") != epoch)
                    if stale:
                        # Delete only the exact verified handle, never a path selected
                        # by a previous read. Unknown/corrupt files remain for inspection.
                        disposition = ctypes.c_ubyte(1)
                        if not self.kernel.SetFileInformationByHandle(handle, 4, ctypes.byref(disposition), 1):
                            raise ctypes.WinError(ctypes.get_last_error())
                        self.counts["pruned"] += 1
            except (OSError, ValueError, TypeError, KeyError, AttributeError):
                self.counts["invalid"] += 1
