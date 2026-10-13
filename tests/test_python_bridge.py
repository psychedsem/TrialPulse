"""Contratto del trasporto Python locale senza modificare gli endpoint HTTP."""

import io
import json
from pathlib import Path
import subprocess
import sys
import unittest
from contextlib import redirect_stdout
from fastapi.testclient import TestClient
from fastapi import HTTPException
from pydantic import BaseModel, ValidationError

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "data_agent"))
import app as data_api
from scripts import python_bridge as bridge


class PythonBridgeTests(unittest.TestCase):
    def test_error_envelopes_preserve_status_and_correlation(self):
        class Request(BaseModel):
            count: int

        try:
            Request.model_validate({"count": []})
        except ValidationError as error:
            validation_error = error
        cases = [
            (validation_error, "http", 422, "invalid_request"),
            (HTTPException(400, "CANARY_PRIVATO"), "http", 400, "service_error"),
            (HTTPException(422), "http", 422, "service_error"),
            (HTTPException(503), "http", 503, "service_error"),
            (HTTPException(500), "http", 503, "service_error"),
            (ValueError("CANARY_PRIVATO"), "http", 400, "invalid_request"),
            (RuntimeError("CANARY_PRIVATO"), "internal", 503, "service_error"),
        ]
        for error, kind, status, code in cases:
            with self.subTest(status=status, code=code):
                def handler(body):
                    raise error
                result = bridge._response({"v": 1, "id": 37, "op": "retrieve", "body": {}}, "retrieve", handler)
                self.assertEqual(result, {"v": 1, "id": 37, "ok": False,
                                          "error": {"kind": kind, "status": status, "code": code}})
                self.assertNotIn("CANARY_PRIVATO", json.dumps(result))

    def test_invalid_frame_preserves_only_protocol_identifier(self):
        for frame, expected_id in [(None, None), ({"id": 0}, 0),
                                   ({"v": 1, "id": 8, "op": "analyze", "body": {}}, 8)]:
            with self.subTest(frame=frame):
                result = bridge._response(frame, "retrieve", lambda body: self.fail("Handler non autorizzato"))
                self.assertEqual(result, {"v": 1, "id": expected_id, "ok": False,
                                          "error": {"kind": "invalid_request", "status": 422, "code": "invalid_frame"}})

    def run_once(self, body, frame_id=1):
        frame = {"v": 1, "id": frame_id, "op": "analyze", "body": body}
        response = subprocess.run(
            [sys.executable, "-B", str(ROOT / "scripts" / "python_bridge.py"), "--mode", "analyze"],
            input=json.dumps(frame, ensure_ascii=False) + "\n", encoding="utf-8",
            capture_output=True, timeout=30, cwd=ROOT,
        )
        self.assertEqual(response.returncode, 0, "Il processo Python non ha completato il protocollo")
        self.assertEqual(len(response.stdout.strip().splitlines()), 1)
        return json.loads(response.stdout)

    def test_portfolio_and_http_parity(self):
        body = {"analysis": "portfolio_summary"}
        expected = TestClient(data_api.app).post("/analyze", json=body).json()
        packet = self.run_once(body)
        self.assertTrue(packet["ok"])
        self.assertEqual(packet["id"], 1)
        self.assertEqual(packet["result"], expected)
        self.assertEqual(packet["result"]["results"][0]["screened_participants"], 194)

    def test_bad_inputs_are_sanitized(self):
        for body in [{"analysis": "non_riconosciuta"}, {"analysis": "portfolio_summary", "secret": "CANARY_SUPERSEGRETO"}]:
            with self.subTest(body=body):
                packet = self.run_once(body)
                self.assertFalse(packet["ok"])
                self.assertEqual(packet["error"]["status"], 422)
                self.assertNotIn("CANARY_SUPERSEGRETO", json.dumps(packet))

    def test_rag_jsonl_worker_protocol_without_model(self):
        # Testa il framing del worker, non il retrieval: nessun indice viene aperto.
        frames = [{"v": 1, "id": i, "op": "retrieve", "body": {"query": "Week 6"}}
                  for i in (12, 13)]
        stream = io.TextIOWrapper(io.BytesIO("".join(json.dumps(frame) + "\n" for frame in frames).encode()), encoding="utf8")
        previous_stdin = sys.stdin
        original = bridge._load_handler
        bridge._load_handler = lambda mode: lambda body: {"results": [{"text": "fixture locale", "rank": 1}]}
        output = io.StringIO()
        try:
            sys.stdin = stream
            sys.argv, previous_argv = ["python_bridge.py", "--mode", "retrieve", "--worker"], sys.argv
            try:
                with redirect_stdout(output):
                    self.assertEqual(bridge.main(), 0)
            finally:
                sys.argv = previous_argv
        finally:
            sys.stdin = previous_stdin
            bridge._load_handler = original
        packets = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual([item["id"] for item in packets], [12, 13])
        self.assertTrue(all(packet["ok"] for packet in packets))

    def test_rag_bad_packet_has_no_private_content(self):
        packet = bridge._response({"v": 1, "id": 9, "op": "retrieve", "body": {"query": "x"},
                                   "password": "CANARY_SUPERSEGRETO"}, "retrieve", lambda body: {})
        self.assertEqual(packet["error"]["status"], 422)
        self.assertNotIn("CANARY_SUPERSEGRETO", json.dumps(packet))


if __name__ == "__main__":
    unittest.main()