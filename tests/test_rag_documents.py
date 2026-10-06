from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "rag"))

from documents import (  # noqa: E402
    build_chunks, chunk_section, document_metadata,
    load_manifest, split_markdown_sections,
)


class FakeTokenizer:
    def __init__(self):
        self.word_to_id, self.id_to_word = {}, {}

    def encode(self, text, add_special_tokens=False):
        ids = []
        for word in text.split():
            if word not in self.word_to_id:
                token_id = len(self.word_to_id) + 1
                self.word_to_id[word] = token_id
                self.id_to_word[token_id] = word
            ids.append(self.word_to_id[word])
        return ids

    def decode(self, ids, skip_special_tokens=True):
        return " ".join(self.id_to_word[token_id] for token_id in ids)


class RagDocumentTests(unittest.TestCase):
    def test_manifest_contains_only_approved_documents(self):
        manifest = load_manifest()
        ingest = manifest["ingest"]
        self.assertEqual(len(ingest), 11)
        self.assertTrue(all(path.startswith("knowledge_base/") for path in ingest))
        self.assertTrue(set(ingest).isdisjoint(manifest.get("exclude", [])))

    def test_metadata_from_path(self):
        protocol = document_metadata("knowledge_base/protocols/NNR-PSI-01.md")
        operation = document_metadata(
            "knowledge_base/operations/deviation_escalation_rules.md"
        )
        self.assertEqual(protocol["document_type"], "protocol")
        self.assertEqual(protocol["study_id"], "NNR-PSI-01")
        self.assertEqual(operation["document_type"], "operations")
        self.assertNotIn("study_id", operation)

    def test_markdown_sections_keep_headings(self):
        sections = split_markdown_sections(
            "# Titolo\nTesto iniziale.\n\n## Regola\nContenuto regola."
        )
        self.assertEqual([name for name, _ in sections], ["Titolo", "Regola"])
        self.assertTrue(sections[1][1].startswith("## Regola"))

    def test_oversized_section_is_split_with_overlap(self):
        tokenizer = FakeTokenizer()
        chunks = chunk_section(
            " ".join(f"w{i}" for i in range(900)),
            tokenizer, target=400, maximum=500, overlap=50,
        )
        tokenized = [tokenizer.encode(chunk) for chunk in chunks]
        self.assertEqual(len(chunks), 3)
        self.assertTrue(all(len(chunk) <= 400 for chunk in tokenized))
        self.assertEqual(tokenized[0][-50:], tokenized[1][:50])

    def test_build_chunks_is_deterministic_and_traceable(self):
        tokenizer = FakeTokenizer()
        first = build_chunks(tokenizer)
        self.assertTrue(first)
        self.assertEqual(first, build_chunks(tokenizer))
        self.assertEqual(len({chunk["id"] for chunk in first}), len(first))
        sources = set(load_manifest()["ingest"])
        self.assertTrue(all(chunk["metadata"]["source"] in sources for chunk in first))
        self.assertTrue(all(chunk["metadata"]["section"] for chunk in first))


if __name__ == "__main__":
    unittest.main()
