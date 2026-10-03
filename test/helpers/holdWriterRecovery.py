"""Fault fixture: hold the production native guard until the owned child is killed."""
import importlib.util
import os
from pathlib import Path
import sys
import time

spec = importlib.util.spec_from_file_location("writer", Path(__file__).parents[2] / "scripts/negi_recover_writer.py")
writer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(writer)
root = Path(sys.argv[1]).resolve(strict=True)
guard = writer.windows_guard if os.name == "nt" else writer.linux_guard
with guard(root, sys.argv[2]):
    print("held", flush=True)
    while True:time.sleep(1)
