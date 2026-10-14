"""Vehicle API process for a local two-GPU vLLM-Omni model server."""

import json
import os
import socket
import sys
import time
from pathlib import Path

import uvicorn

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import agent_service as service
from server_omni25_opt.vllm_backend import VllmBackend


def main():
    model_name = os.environ.get("VEHICLE_SERVED_MODEL", "Qwen/Qwen2.5-Omni-3B")
    base_url = os.environ.get("VEHICLE_VLLM_URL", "http://127.0.0.1:8118")
    port = int(os.environ.get("VEHICLE_PORT", "18825"))
    service.backend = VllmBackend(model_name, base_url)
    service.CABIN_PROMPT = (ROOT / "small_model_eval/compact_prompt.txt").read_text()
    service.BUILD = "native3b-vllm-streaming-v1"
    endpoint = ROOT / "runtime/endpoint.json"
    endpoint.parent.mkdir(exist_ok=True)
    endpoint.write_text(
        json.dumps(
            {
                "host": socket.gethostbyname(socket.gethostname()),
                "port": port,
                "token": service.TOKEN,
                "pid": os.getpid(),
                "started": time.time(),
            }
        )
    )
    endpoint.chmod(0o600)
    print("VEHICLE_VLLM_READY", flush=True)
    uvicorn.run(service.app, host="0.0.0.0", port=port)


if __name__ == "__main__":
    main()
