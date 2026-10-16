#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
PYTHON="${VEHICLE_PYTHON:-$(command -v python3.12 || true)}"
if [[ -z "$PYTHON" ]]; then echo '请先安装 Python 3.12，再运行此文件。'; exit 1; fi
"$PYTHON" -c 'import sys; assert sys.version_info[:2] == (3,12), "Requires Python 3.12"'
"$PYTHON" -m venv .venv-demo
.venv-demo/bin/python -m pip install -r requirements-client-lock.txt
.venv-demo/bin/python scripts/demo.py init
printf '\n安装完成。请填写 runtime/demo-settings.json，然后双击 start.command。\n'
