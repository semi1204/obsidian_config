from __future__ import annotations

import argparse
import shutil
import subprocess
from pathlib import Path


HERE = Path(__file__).resolve().parent
parser = argparse.ArgumentParser(description="Patch Outliner 4.10.2 so Vim o/O preserves list markers and metadata.")
parser.add_argument("--base", required=True, type=Path, help="Path to the upstream 4.10.2 main.js")
parser.add_argument("--output", required=True, type=Path, help="Output main.js path")
args = parser.parse_args()
base = args.base.expanduser().resolve()
output = args.output.expanduser().resolve()
output.parent.mkdir(parents=True, exist_ok=True)
if base != output:
    shutil.copy2(base, output)
subprocess.run([
    "patch", "--forward", "--batch", str(output), "-i", str(HERE / "outliner-vim.patch")
], check=True)
print(output)

