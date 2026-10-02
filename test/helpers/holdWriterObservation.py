"""Windows fixture holds the production observation reader, never a writer."""
import importlib.util
from pathlib import Path
import sys
import time

spec = importlib.util.spec_from_file_location("recovery", Path(__file__).resolve().parents[2] / "scripts" / "negi_recover_writer.py")
recovery = importlib.util.module_from_spec(spec);spec.loader.exec_module(recovery)
root = Path(sys.argv[1])
with recovery.windows_parent(root) as (kernel, _):
    handle = recovery.win_open_reader(kernel, root / recovery.paths(sys.argv[2])[0])
    recovery.win_info(kernel, handle)
    try:
        print("held", flush=True)
        while True:time.sleep(1)
    finally:kernel.CloseHandle(handle)
