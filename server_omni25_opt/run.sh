#!/usr/bin/env bash
set -euo pipefail
umask 077
if [[ -n "${VEHICLE_PROJECT_ROOT:-}" ]]; then cd "$VEHICLE_PROJECT_ROOT"; fi
test -f server_omni25_opt/serve.py
export HF_HUB_OFFLINE=1 TOKENIZERS_PARALLELISM=false OMP_NUM_THREADS=8
mkdir -p evidence/optimized-3b-20261008 runtime
nvidia-smi > evidence/optimized-3b-20261008/gpu.txt
exec timeout --signal=TERM 10800 "${VEHICLE_PYTHON:-python}" -u server_omni25_opt/serve.py
