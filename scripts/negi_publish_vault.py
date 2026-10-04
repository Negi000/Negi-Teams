"""Create-only directory publication. No copy, merge, overwrite, or rename fallback."""
import argparse
import ctypes
import json
import os
from pathlib import Path
import stat
import sys


def regular_directory(path: Path):
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or path.is_symlink() or getattr(info, "st_file_attributes", 0) & 0x400:
        raise ValueError("Publication directory is a link or invalid")
    return info


def publish(source: Path, target: Path, device: str, inode: str, source_device: str, source_inode: str):
    # Both names are canonical siblings on one filesystem, pinned by the server.
    if not source.is_absolute() or not target.is_absolute() or source.parent != target.parent:
        raise ValueError("Publication names must be absolute siblings")
    parent = regular_directory(target.parent)
    if str(parent.st_dev) != device or str(parent.st_ino) != inode or target.parent.resolve(strict=True) != target.parent:
        raise ValueError("Publication parent changed")
    def check_source():
        info = regular_directory(source)
        if str(info.st_dev) != source_device or str(info.st_ino) != source_inode:
            raise ValueError("Publication source identity changed")
    check_source()
    if os.name == "nt":
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        move = kernel.MoveFileW
        move.argtypes = (ctypes.c_wchar_p, ctypes.c_wchar_p)
        move.restype = ctypes.c_int
        def extended(path):
            raw = str(path)
            return raw if raw.startswith("\\\\?\\") else "\\\\?\\" + raw
        check_source()
        if not move(extended(source), extended(target)):
            code = ctypes.get_last_error()
            raise OSError(code, "Create-only MoveFileW failed", str(target))
    elif sys.platform == "linux":
        libc = ctypes.CDLL(None, use_errno=True)
        move = getattr(libc, "renameat2", None)
        if move is None:
            raise OSError("Create-only directory publication is unsupported")
        move.argtypes = (ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint)
        move.restype = ctypes.c_int
        # Open the pinned parent, so rename is relative to its actual directory.
        fd = os.open(target.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            current = os.fstat(fd)
            if current.st_dev != parent.st_dev or current.st_ino != parent.st_ino:
                raise ValueError("Publication parent changed while opening")
            check_source()
            if move(fd, os.fsencode(source.name), fd, os.fsencode(target.name), 1) != 0:
                code = ctypes.get_errno()
                raise OSError(code, os.strerror(code), str(target))
            os.fsync(fd)
        finally:
            os.close(fd)
    else:
        raise OSError("Create-only directory publication is unsupported")
    print('{"published":true,"primitive":"' + ("MoveFileW" if os.name == "nt" else "renameat2-noreplace") + '"}')


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--identity")
    parser.add_argument("--source")
    parser.add_argument("--target")
    parser.add_argument("--device")
    parser.add_argument("--inode")
    parser.add_argument("--source-device")
    parser.add_argument("--source-inode")
    args = parser.parse_args()
    if args.identity:
        info = regular_directory(Path(args.identity))
        print(json.dumps({"device": str(info.st_dev), "inode": str(info.st_ino)}))
    elif all((args.source, args.target, args.device, args.inode, args.source_device, args.source_inode)):
        publish(Path(args.source), Path(args.target), args.device, args.inode, args.source_device, args.source_inode)
    else:
        parser.error("Publication requires source, target, device and inode")
