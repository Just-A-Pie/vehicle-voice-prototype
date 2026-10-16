#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
if [[ ! -x .venv-demo/bin/python ]]; then echo '请先运行 install.command。'; exit 1; fi
exec .venv-demo/bin/python scripts/demo.py start
