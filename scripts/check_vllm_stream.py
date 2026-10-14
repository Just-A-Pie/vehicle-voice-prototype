"""Exercise the vehicle NDJSON endpoint with a live Qwen2.5-Omni backend."""

import json
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]


def main():
    endpoint = json.loads((ROOT / "runtime/endpoint.json").read_text())
    base_url = f"http://127.0.0.1:{endpoint['port']}"
    headers = {"Authorization": "Bearer " + endpoint["token"]}
    with httpx.Client(
        base_url=base_url, headers=headers, timeout=180, trust_env=False
    ) as client:
        session = client.post("/session", json={"profile": "slai"})
        session.raise_for_status()
        request = {
            "profile": "slai",
            "session_id": session.json()["session_id"],
            "request_id": "vllm-stream-check",
            "text": "你好",
        }
        with client.stream("POST", "/turn-stream", json=request) as response:
            response.raise_for_status()
            events = [json.loads(line) for line in response.iter_lines() if line]

    types = [event["type"] for event in events]
    assert types[0] == "state" and types[-1] == "done", types
    assert "audio" in types and types.index("audio") > types.index("transcript"), types
    chunks = [event["data"] for event in events if event["type"] == "audio"]
    assert [chunk["sequence"] for chunk in chunks] == list(range(len(chunks)))
    assert all(
        chunk["sample_rate"] == 24000 and chunk["channels"] == 1 for chunk in chunks
    )
    result = events[-1]["data"]
    assert result["semantic_model_calls"] == 1 and result["speech_model_calls"] == 1
    assert result["reply"] == result["agent_reply"]
    print(
        json.dumps(
            {
                "reply": result["reply"],
                "chunks": len(chunks),
                "first_audio_seconds": result["first_audio_seconds"],
                "total_seconds": result["total_seconds"],
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
