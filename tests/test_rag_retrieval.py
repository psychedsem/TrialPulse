from pathlib import Path
import sys
import tempfile
import unittest

import chromadb
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "rag"))

from build_index import build_index, load_model
from config import COLLECTION_NAME, PASSAGE_PREFIX, QUERY_PREFIX
from documents import build_chunks, load_manifest
from retriever import retrieve


class RagRetrievalTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.model = load_model()
        cls.chunks = build_chunks(cls.model.tokenizer)
        cls.temp = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.temp.cleanup)
        cls.path = Path(cls.temp.name) / "index"
        cls.summary = build_index(cls.path)
        cls.client = chromadb.PersistentClient(path=str(cls.path))
        cls.addClassCleanup(cls.client.close)
        cls.collection = cls.client.get_collection(COLLECTION_NAME, embedding_function=None)

    def test_index_contains_exact_manifest_sources_and_original_chunks(self):
        records = self.collection.get(include=["documents", "metadatas"])
        self.assertEqual(self.collection.count(), len(self.chunks))
        self.assertEqual(self.collection.count(), 54)
        sources = {meta["source"] for meta in records["metadatas"]}
        self.assertEqual(sources, set(load_manifest()["ingest"]))
        self.assertEqual(len(sources), 11)
        originals = {chunk["id"]: chunk["text"] for chunk in self.chunks}
        self.assertEqual(dict(zip(records["ids"], records["documents"])), originals)
        self.assertEqual(len(set(records["ids"])), 54)
        self.assertEqual(self.chunks, build_chunks(self.model.tokenizer))

    def test_embedding_dimension_normalization_prefix_and_cosine(self):
        chunk = self.chunks[0]
        record = self.collection.get(ids=[chunk["id"]], include=["embeddings"])
        vector = record["embeddings"][0]
        self.assertEqual(len(vector), 384)
        self.assertAlmostEqual(float(np.linalg.norm(vector)), 1, places=5)
        expected = self.model.encode(PASSAGE_PREFIX + chunk["text"], normalize_embeddings=True)
        np.testing.assert_allclose(vector, expected, atol=1e-6)
        result = retrieve("Qual è la finestra Week 6?", chroma_path=self.path)[0]
        stored = self.collection.get(ids=[result["id"]], include=["embeddings"])["embeddings"][0]
        query = self.model.encode(QUERY_PREFIX + "Qual è la finestra Week 6?", normalize_embeddings=True)
        self.assertAlmostEqual(result["distance"], float(1 - np.dot(query, stored)), places=5)

    def test_rebuild_removes_stale_records_and_keeps_ids(self):
        self.collection.add(ids=["stale"], documents=["vecchio"],
                            embeddings=[[0.0] * 384], metadatas=[{"source": "escluso.md"}])
        build_index(self.path)
        rebuilt = self.client.get_collection(COLLECTION_NAME, embedding_function=None)
        self.assertEqual(rebuilt.count(), 54)
        self.assertEqual(set(rebuilt.get()["ids"]), {chunk["id"] for chunk in self.chunks})
        self.__class__.collection = rebuilt

    def test_top_k_traceability_and_explicit_filter(self):
        results = retrieve("Week 6", chroma_path=self.path)
        self.assertEqual(len(results), 4)
        self.assertEqual([item["rank"] for item in results], [1, 2, 3, 4])
        for item in results:
            self.assertTrue(item["text"])
            self.assertEqual(item["source"], item["metadata"]["source"])
            self.assertEqual(item["section"], item["metadata"]["section"])
            self.assertIsInstance(item["distance"], float)
        self.assertEqual(len(retrieve("Week 6", top_k=2, chroma_path=self.path)), 2)
        filtered = retrieve("Week 6", where={"study_id": "NNR-ESK-02"}, chroma_path=self.path)
        self.assertEqual(len(filtered), 4)
        self.assertTrue(all(item["metadata"]["study_id"] == "NNR-ESK-02" for item in filtered))
        self.assertEqual(retrieve("Week 6", where={"study_id": "inesistente"}, chroma_path=self.path), [])

    def test_supported_queries_find_rules_in_top_four(self):
        cases = [
            ("Qual è la finestra della Week 6 nello studio NNR-PSI-01?", ["NNR-PSI-01", "Week 6", "±4"]),
            ("Qual è la finestra della Week 6 nello studio NNR-ESK-02?", ["NNR-ESK-02", "Week 6", "±2"]),
            ("Quando una query aperta deve essere escalata a Data Management?", [">10", "giorni"]),
            ("Qual è la soglia Novera per la data completeness?", ["<95%", "<90%"]),
            ("Cosa succede se un partecipante ha due visite missed consecutive?", ["due", "consecutive"]),
            ("Quando tre major deviations richiedono escalation?", ["3", "30 giorni"]),
        ]
        for query, fragments in cases:
            with self.subTest(query=query):
                results = retrieve(query, chroma_path=self.path)
                self.assertTrue(any(all(text.lower() in item["text"].lower() for text in fragments) for item in results))

    def test_ambiguous_query_keeps_multi_study_information(self):
        results = retrieve("Qual è la finestra Week 6?", chroma_path=self.path)
        self.assertTrue(any("±4" in item["text"] and "±2" in item["text"]
                            and "±5" in item["text"] for item in results))

    def test_unsupported_query_returns_retrieval_without_support_decision(self):
        results = retrieve("Qual è la soglia Novera per approvare un aumento di dose?", chroma_path=self.path)
        self.assertEqual(len(results), 4)
        self.assertTrue(all("supported" not in item and "answer" not in item for item in results))

    def test_invalid_input_and_missing_index(self):
        for query, top_k in [("", 4), ("  ", 4), ("Week 6", 0), ("Week 6", True), ("Week 6", 1.5)]:
            with self.subTest(query=query, top_k=top_k), self.assertRaises(ValueError):
                retrieve(query, top_k=top_k, chroma_path=self.path)
        with self.assertRaises(ValueError):
            retrieve("Week 6", chroma_path=Path(self.temp.name) / "missing")


if __name__ == "__main__":
    unittest.main()
