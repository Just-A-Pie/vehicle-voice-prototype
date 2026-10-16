#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
exec .venv-demo/bin/python scripts/demo.py stop
