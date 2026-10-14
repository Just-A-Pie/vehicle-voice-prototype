"""Check the speech stream's text gate and ordered PCM transport."""

import base64
import io
import json
import unittest

import httpx
import numpy as np
import soundfile as sf

from server_omni25_opt.vllm_backend import VllmBackend


def packet(modality, content):
    body = {"modality": modality, "choices": [{"delta": {"content": content}}]}
    return ("data: " + json.dumps(body) + "\n\n").encode()


class VllmBackendTest(unittest.TestCase):
    def make_backend(self, spoken, chunks=2):
        samples = np.full(2400, 0.1, dtype=np.float32)
        wav = io.BytesIO()
        sf.write(wav, samples, 24000, format="WAV", subtype="PCM_16")
        encoded = base64.b64encode(wav.getvalue()).decode()
        seen_requests = []

        def handle(request):
            seen_requests.append(json.loads(request.content))
            stream = packet("text", spoken)
            stream += b"".join(packet("audio", encoded) for _ in range(chunks))
            stream += b"data: [DONE]\n\n"
            return httpx.Response(200, content=stream)

        backend = VllmBackend.__new__(VllmBackend)
        backend.client = httpx.Client(
            transport=httpx.MockTransport(handle), base_url="http://localhost"
        )
        backend.model_name = "Qwen/Qwen2.5-Omni-3B"
        backend.trace = []
        backend.timings = []
        backend.audit = None
        return backend, seen_requests

    def test_matching_reply_emits_ordered_chunks(self):
        reply = "你好。"
        backend, requests = self.make_backend(reply)
        events = []
        spoken, audio = backend.generate_speech(
            [{"role": "user", "content": reply}], reply, events.append
        )
        self.assertEqual(spoken, reply)
        self.assertEqual(audio.shape, (4800,))
        self.assertEqual([event["sequence"] for event in events], [0, 1])
        self.assertTrue(all(event["sample_rate"] == 24000 for event in events))
        self.assertTrue(
            all(len(base64.b64decode(event["pcm"])) == 4800 for event in events)
        )
        self.assertEqual(requests[0]["structured_outputs"], {"choice": [reply]})

    def test_mismatched_reply_cannot_emit_audio(self):
        backend, _ = self.make_backend("错误文本")
        events = []
        with self.assertRaisesRegex(RuntimeError, "differs"):
            backend.generate_speech(
                [{"role": "user", "content": "你好。"}], "你好。", events.append
            )
        self.assertEqual(events, [])


if __name__ == "__main__":
    unittest.main()
