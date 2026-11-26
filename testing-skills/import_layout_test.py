#!/usr/bin/env python3
"""Runs import_layout_test.ts (chord placement in the import-sheet function) with Deno, if installed."""
import shutil
import subprocess
import sys
from pathlib import Path

deno = shutil.which("deno")
if not deno:
    print("import_layout_test: skipped (install Deno to run it: https://deno.com).")
    sys.exit(0)
test = Path(__file__).with_name("import_layout_test.ts")
sys.exit(subprocess.run([deno, "run", "--allow-read", "--allow-write", str(test)]).returncode)
