#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SOURCE=${VEHICLE_VLLM_OMNI_SOURCE:-$ROOT/third_party/vllm-omni}
PYTHON=${VEHICLE_VLLM_PYTHON:-python}

if [[ -e "$SOURCE" ]]; then
    echo "Source already exists: $SOURCE" >&2
    exit 1
fi

git clone --depth 1 --branch v0.25.0rc1 https://github.com/vllm-project/vllm-omni.git "$SOURCE"
[[ $(git -C "$SOURCE" rev-parse HEAD) == d3c47efc4f818931f29e5f1567c94c454561631c ]] || {
    echo 'Unexpected vLLM-Omni source revision' >&2
    exit 1
}
git -C "$SOURCE" apply -p3 "$ROOT/patches/vllm_omni_speech.patch"
"$PYTHON" -m pip install -e "$SOURCE"
"$PYTHON" -c 'import vllm, vllm_omni; assert vllm.__version__ == "0.25.1"'
