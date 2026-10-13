import hashlib
import re
from pathlib import Path

import yaml

from config import (
    MANIFEST_PATH, MAX_TOKENS, OVERLAP_TOKENS, PROJECT_ROOT, TARGET_TOKENS,
)

HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*$", re.MULTILINE)


def load_manifest(path=MANIFEST_PATH):
    data = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
    ingest = data.get("ingest", [])
    if not ingest or len(ingest) != len(set(ingest)):
        raise ValueError("Manifest RAG vuoto o con percorsi duplicati.")

    for source in ingest:
        if not source.startswith("knowledge_base/") or not source.endswith(".md"):
            raise ValueError(f"Percorso ingest non valido: {source}")
        if not (PROJECT_ROOT / source).is_file():
            raise FileNotFoundError(source)
    return data


def document_metadata(source):
    path = Path(source)
    parent = path.parent.name
    if parent == "protocols":
        document_type, study_id = "protocol", path.stem
    elif parent in {"operations", "reference"}:
        document_type, study_id = parent, None
    elif path.name == "faq.md":
        document_type, study_id = "faq", None
    else:
        document_type, study_id = "scope", None

    metadata = {"source": source, "document_type": document_type}
    if study_id:
        metadata["study_id"] = study_id
    return metadata


def split_markdown_sections(text):
    matches = list(HEADING_RE.finditer(text))
    if not matches:
        return [("documento", text.strip())] if text.strip() else []

    sections = []
    intro = text[:matches[0].start()].strip()
    if intro:
        sections.append(("introduzione", intro))

    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        content = text[match.start():end].strip()
        if content:
            sections.append((match.group(2).strip(), content))
    return sections


def chunk_section(
    text, tokenizer, target=TARGET_TOKENS, maximum=MAX_TOKENS,
    overlap=OVERLAP_TOKENS,
):
    token_ids = tokenizer.encode(text, add_special_tokens=False)
    if len(token_ids) <= maximum:
        return [text.strip()]
    if not 0 <= overlap < target <= maximum:
        raise ValueError("Configurazione chunk non valida.")

    chunks = []
    step = target - overlap
    for start in range(0, len(token_ids), step):
        piece = token_ids[start:start + target]
        chunks.append(tokenizer.decode(piece, skip_special_tokens=True).strip())
        if start + target >= len(token_ids):
            break
    return chunks


def build_chunks(tokenizer, manifest_path=MANIFEST_PATH):
    chunks = []
    for source in load_manifest(manifest_path)["ingest"]:
        text = (PROJECT_ROOT / source).read_text(encoding="utf-8")
        base_metadata = document_metadata(source)

        for section_index, (section, content) in enumerate(split_markdown_sections(text)):
            for chunk_index, chunk in enumerate(chunk_section(content, tokenizer)):
                key = f"{source}|{section_index}|{chunk_index}|{chunk}"
                chunks.append({
                    "id": hashlib.sha256(key.encode("utf-8")).hexdigest()[:24],
                    "text": chunk,
                    "metadata": {
                        **base_metadata,
                        "section": section,
                        "section_index": section_index,
                        "chunk_index": chunk_index,
                    },
                })
    return chunks