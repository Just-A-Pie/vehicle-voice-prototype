"""Qwen2.5-Omni decision and chunked speech through the local vLLM-Omni server."""

import base64
import io
import json
import time
from pathlib import Path

import httpx
import numpy as np
import soundfile as sf

from single_call import SingleDecisionMixin


class VllmBackend(SingleDecisionMixin):
    def __init__(self, model_name, base_url):
        self.model_name = model_name
        self.client = httpx.Client(base_url=base_url, timeout=180, trust_env=False)
        response = self.client.get("/health")
        response.raise_for_status()
        self.sessions = {}
        self.audio_sink = None
        self.text_sink = None
        self.audit = None
        self.trace = []
        self.timings = []
        self.stage = "agent"
        self.engine_info = {
            "engine": "vllm-omni",
            "speech_model": model_name,
            "native_audio_streaming": True,
            "transport_audio": "ordered_pcm_chunks",
            "devices": 2,
            "speech_text_constraint": "structured_choice",
        }

    @staticmethod
    def _messages(messages):
        converted = []
        for message in messages:
            content = message["content"]
            if isinstance(content, list):
                parts = []
                for part in content:
                    if part["type"] == "text":
                        parts.append(part)
                    elif part["type"] == "audio":
                        path = Path(part["audio"])
                        encoded = base64.b64encode(path.read_bytes()).decode("ascii")
                        parts.append(
                            {
                                "type": "audio_url",
                                "audio_url": {
                                    "url": "data:audio/wav;base64," + encoded
                                },
                            }
                        )
                    else:
                        raise ValueError(f"Unsupported content type: {part['type']}")
                content = parts
            converted.append({"role": message["role"], "content": content})
        return converted

    def generate(self, messages, audio=False, force_text=None, max_new_tokens=None):
        if audio or force_text is not None:
            raise ValueError("Use generate_speech for audio output")
        started = time.monotonic()
        response = self.client.post(
            "/v1/chat/completions",
            json={
                "model": self.model_name,
                "messages": self._messages(messages),
                "modalities": ["text"],
                "stream": False,
                "temperature": 0,
                "max_tokens": max_new_tokens or 512,
            },
        )
        response.raise_for_status()
        body = response.json()
        reply = body["choices"][0]["message"]["content"]
        if not isinstance(reply, str):
            raise TypeError("Decision model returned no text")
        entry = {
            "stage": self.stage,
            "seconds": time.monotonic() - started,
            "output": reply,
            "tokens": body.get("usage", {}).get("completion_tokens"),
        }
        if body.get("metrics"):
            entry["stage_metrics"] = body["metrics"]
        self.trace.append(entry)
        self.timings.append(entry)
        if self.audit:
            self.audit("model_output", entry)
        return reply, None

    def generate_speech(self, messages, reply, sink):
        started = time.monotonic()
        payload = {
            "model": self.model_name,
            "messages": self._messages(messages),
            "modalities": ["text", "audio"],
            "stream": True,
            "temperature": 0,
            "max_tokens": min(1024, max(64, len(reply) * 4 + 16)),
            "structured_outputs": {"choice": [reply]},
        }
        text_parts = []
        audio_parts = []
        finish_reasons = []
        stage_metrics = {}
        first_audio = None
        with self.client.stream(
            "POST", "/v1/chat/completions", json=payload
        ) as response:
            response.raise_for_status()
            for line in response.iter_lines():
                if not line.startswith("data: ") or line == "data: [DONE]":
                    continue
                packet = json.loads(line[6:])
                if packet.get("error"):
                    raise RuntimeError(f"Speech model error: {packet['error']}")
                if packet.get("metrics"):
                    stage_metrics[packet.get("modality", "unknown")] = packet["metrics"]
                for choice in packet.get("choices", []):
                    if choice.get("finish_reason"):
                        finish_reasons.append(choice["finish_reason"])
                    content = choice.get("delta", {}).get("content")
                    if not content:
                        continue
                    if packet.get("modality") == "text":
                        text_parts.append(content)
                    elif packet.get("modality") == "audio":
                        if "".join(text_parts) != reply:
                            raise RuntimeError(
                                "Speech text differs from released reply"
                            )
                        samples, sample_rate = sf.read(
                            io.BytesIO(base64.b64decode(content, validate=True)),
                            dtype="float32",
                        )
                        if (
                            sample_rate != 24000
                            or samples.ndim != 1
                            or not len(samples)
                            or not np.isfinite(samples).all()
                        ):
                            raise RuntimeError("Invalid speech audio chunk")
                        audio_parts.append(samples)
                        if first_audio is None:
                            first_audio = time.monotonic() - started
                        if sink:
                            pcm = (
                                np.clip(np.rint(samples * 32768), -32768, 32767)
                                .astype("<i2")
                                .tobytes()
                            )
                            sink(
                                {
                                    "pcm": base64.b64encode(pcm).decode("ascii"),
                                    "sample_rate": 24000,
                                    "channels": 1,
                                    "sequence": len(audio_parts) - 1,
                                }
                            )
        spoken = "".join(text_parts)
        if "length" in finish_reasons:
            raise RuntimeError("Speech generation reached its token limit")
        if spoken != reply or not audio_parts:
            raise RuntimeError(
                "Speech generation ended without matching text and audio"
            )
        entry = {
            "stage": "speech",
            "seconds": time.monotonic() - started,
            "output": spoken,
            "chunks": len(audio_parts),
            "first_audio_seconds": first_audio,
            "audio_seconds": sum(map(len, audio_parts)) / 24000,
            "finish_reasons": finish_reasons,
            "stage_metrics": stage_metrics,
        }
        self.trace.append(entry)
        self.timings.append(entry)
        if self.audit:
            self.audit("model_output", entry)
        return spoken, np.concatenate(audio_parts)
