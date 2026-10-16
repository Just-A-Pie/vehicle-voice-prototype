#!/usr/bin/env bash
set -euo pipefail
umask 077
: "${AUDIO_TRAIN_ROOT:?Set the training project path on the GPU server}"
: "${VEHICLE_CHECKPOINT:?Set the exact checkpoint-48 path}"
: "${AUDIO_KOKORO_MODEL:?Set the Kokoro model path}"
: "${OUTPUT_ROOT:?Set a private output directory for this service run}"
PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
export AUDIO_TTS_PORT=18786
export VEHICLE_RPC_PORT="${VEHICLE_RPC_PORT:-18948}"
mkdir -p "$OUTPUT_ROOT"
bash "$AUDIO_TRAIN_ROOT/scripts/with_teacher_runtime.sh" tts -u -m audio_agent.inference.kokoro_server > "$OUTPUT_ROOT/tts.log" 2>&1 &
TTS_PID=$!
trap 'kill "$TTS_PID" 2>/dev/null || true' EXIT INT TERM
python3 - "$TTS_PID" <<'PY'
import os,sys,time,urllib.request
client=urllib.request.build_opener(urllib.request.ProxyHandler({}))
for _ in range(120):
 os.kill(int(sys.argv[1]),0)
 try:
  with client.open('http://127.0.0.1:18786/status',timeout=2) as r:
   if r.status==200:break
 except OSError:time.sleep(2)
else:raise RuntimeError('TTS startup timed out')
PY
timeout --signal=TERM "${VEHICLE_SERVICE_SECONDS:-10800}" bash "$AUDIO_TRAIN_ROOT/scripts/with_teacher_runtime.sh" asr -u "$PROJECT/checkpoint48/worker.py"
