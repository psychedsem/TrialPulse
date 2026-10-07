import importlib.util
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "rag"))
spec = importlib.util.spec_from_file_location("rag_api", ROOT / "rag/app.py")
service = importlib.util.module_from_spec(spec)
spec.loader.exec_module(service)


class RagApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(service.app)

    def test_health(self):
        self.assertEqual(self.client.get("/health").json(), {"status": "ok", "service": "trialpulse-rag"})

    def test_retrieve_preserves_results_and_default(self):
        rows = [{"text": "Regola", "source": "knowledge_base/faq.md", "section": "Visite",
                 "metadata": {"source": "knowledge_base/faq.md"}, "rank": 1, "distance": 0.12}]
        with patch.object(service, "retrieve", return_value=rows) as retrieval:
            response = self.client.post("/retrieve", json={"query": "Visite"})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json(), {"results": rows})
            retrieval.assert_called_once_with("Visite", top_k=4, where=None)

    def test_custom_options_are_forwarded(self):
        with patch.object(service, "retrieve", return_value=[]) as retrieval:
            response = self.client.post("/retrieve", json={"query": "Visite", "top_k": 2, "where": {"study_id": "NNR-ESK-02"}})
            self.assertEqual(response.json(), {"results": []})
            retrieval.assert_called_once_with("Visite", top_k=2, where={"study_id": "NNR-ESK-02"})

    def test_invalid_payload(self):
        for payload in [{}, {"query": " "}, {"query": 2}, {"query": "V", "top_k": 0},
                        {"query": "V", "top_k": True}, {"query": "V", "top_k": 1.5},
                        {"query": "V", "where": []}, {"query": "V", "unknown": True}]:
            with self.subTest(payload=payload):
                self.assertEqual(self.client.post("/retrieve", json=payload).status_code, 422)

    def test_service_error_is_safe(self):
        with patch.object(service, "retrieve", side_effect=RuntimeError("segreto")):
            response = self.client.post("/retrieve", json={"query": "Visite"})
            self.assertEqual(response.status_code, 503)
            self.assertNotIn("segreto", response.text)
        with patch.object(service, "retrieve", side_effect=ValueError("Filtro non valido")):
            self.assertEqual(self.client.post("/retrieve", json={"query": "V"}).status_code, 400)


if __name__ == "__main__":
    unittest.main()
