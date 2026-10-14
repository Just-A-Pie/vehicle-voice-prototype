#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
MODEL=${VEHICLE_MODEL_PATH:?Set VEHICLE_MODEL_PATH to the Qwen2.5-Omni-3B checkpoint}
SOURCE=${VEHICLE_VLLM_OMNI_SOURCE:-$ROOT/third_party/vllm-omni}
VLLM_PYTHON=${VEHICLE_VLLM_PYTHON:-python}
API_PYTHON=${VEHICLE_API_PYTHON:-python}
VLLM_PORT=${VEHICLE_VLLM_PORT:-8118}
SERVED_MODEL=${VEHICLE_SERVED_MODEL:-Qwen/Qwen2.5-Omni-3B}
LOG_DIR=${VEHICLE_VLLM_LOG_DIR:-$ROOT/output/vllm_streaming}
mkdir -p "$LOG_DIR"

export QWEN25_OMNI_CHUNKED_AUDIO=1
export QWEN25_OMNI_MEL_CHUNK_BLOCKS=${QWEN25_OMNI_MEL_CHUNK_BLOCKS:-12}
export VLLM_PLUGINS=vllm_omni_register_models
export VEHICLE_VLLM_URL="http://127.0.0.1:$VLLM_PORT"
export VEHICLE_SERVED_MODEL="$SERVED_MODEL"

PYTHONPATH="$SOURCE:$ROOT${PYTHONPATH:+:$PYTHONPATH}" \
    "$VLLM_PYTHON" -m vllm_omni.entrypoints.cli.main serve "$MODEL" \
    --omni --deploy-config "$ROOT/server_omni25_opt/qwen25_omni_3b_streaming.yaml" \
    --served-model-name "$SERVED_MODEL" --host 127.0.0.1 --port "$VLLM_PORT" \
    > "$LOG_DIR/server.log" 2>&1 &
server_pid=$!
trap 'kill "$server_pid" 2>/dev/null || true' EXIT

SERVER_PID="$server_pid" VLLM_PORT="$VLLM_PORT" "$API_PYTHON" - <<'PY'
import os
import time
import urllib.request

url = f"http://127.0.0.1:{os.environ['VLLM_PORT']}/health"
for _ in range(1200):
    if not os.path.exists(f"/proc/{os.environ['SERVER_PID']}"):
        raise RuntimeError('vLLM-Omni exited during startup')
    try:
        with urllib.request.urlopen(url, timeout=2) as response:
            if response.status == 200:
                break
    except OSError:
        time.sleep(1)
else:
    raise TimeoutError('vLLM-Omni did not become healthy within 20 minutes')
PY

cd "$ROOT"
"$API_PYTHON" -m server_omni25_opt.serve_vllm
